"""Fail-closed, non-expiring writer binding for a manual switch generation.

This is deliberately not a lease.  Time passing never changes authority and
the guard never selects a host.  It only proves that one already-authorized
writer still matches the exact target, generation, and transition recorded by
the manual switch marker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from vps_runtime.switch.marker import MarkerIOError, read_marker
    from vps_runtime.switch.state import (
        ActiveTarget,
        MarkerValidationError,
        RuntimeMarker,
        RuntimeStatus,
    )
    from vps_runtime.switch.writer_inventory import (
        DEFAULT_INVENTORY_PATH,
        WriterInventory,
        WriterInventoryError,
        WriterSpec,
        load_inventory,
    )
else:
    from .marker import MarkerIOError, read_marker
    from .state import ActiveTarget, MarkerValidationError, RuntimeMarker, RuntimeStatus
    from .writer_inventory import (
        DEFAULT_INVENTORY_PATH,
        WriterInventory,
        WriterInventoryError,
        WriterSpec,
        load_inventory,
    )


SCHEMA_VERSION = 1
_RELEASE_ID = re.compile(r"^[0-9a-f]{7,64}$")
_BINDING_FIELDS = frozenset(
    {
        "schema_version",
        "target",
        "generation",
        "transition_id",
        "marker_path",
        "writer_inventory_sha256",
        "release_id",
        "issued_at",
    }
)


class GenerationGuardError(RuntimeError):
    """A writer does not hold authority for the current manual generation."""


def _parse_issued_at(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise GenerationGuardError("binding issued_at must be a timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GenerationGuardError("binding issued_at is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GenerationGuardError("binding issued_at must include a timezone")
    return value


def _absolute_path(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise GenerationGuardError(f"binding {name} must be an absolute path")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise GenerationGuardError(f"binding {name} must be an absolute safe path")
    return value


@dataclass(frozen=True, slots=True)
class GenerationBinding:
    schema_version: int
    target: str
    generation: int
    transition_id: str
    marker_path: str
    writer_inventory_sha256: str
    release_id: str
    issued_at: str

    def __post_init__(self) -> None:
        if type(self.schema_version) is not int or self.schema_version != SCHEMA_VERSION:
            raise GenerationGuardError("binding schema_version must be 1")
        if not isinstance(self.target, str) or self.target not in {"mac", "vps"}:
            raise GenerationGuardError("binding target must be mac or vps")
        if type(self.generation) is not int or self.generation < 0:
            raise GenerationGuardError("binding generation must be a non-negative integer")
        if (
            not isinstance(self.transition_id, str)
            or not self.transition_id
            or len(self.transition_id) > 128
        ):
            raise GenerationGuardError("binding transition_id is invalid")
        _absolute_path(self.marker_path, "marker_path")
        if not isinstance(self.writer_inventory_sha256, str) or not re.fullmatch(
            r"[0-9a-f]{64}", self.writer_inventory_sha256
        ):
            raise GenerationGuardError("binding inventory digest is invalid")
        if not isinstance(self.release_id, str) or not _RELEASE_ID.fullmatch(
            self.release_id
        ):
            raise GenerationGuardError("binding release_id must be an exact Git commit")
        _parse_issued_at(self.issued_at)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "GenerationBinding":
        if not isinstance(value, Mapping) or set(value) != _BINDING_FIELDS:
            raise GenerationGuardError("binding fields do not match schema version 1")
        return cls(
            value["schema_version"],
            value["target"],
            value["generation"],
            value["transition_id"],
            value["marker_path"],
            value["writer_inventory_sha256"],
            value["release_id"],
            value["issued_at"],
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "target": self.target,
            "generation": self.generation,
            "transition_id": self.transition_id,
            "marker_path": self.marker_path,
            "writer_inventory_sha256": self.writer_inventory_sha256,
            "release_id": self.release_id,
            "issued_at": self.issued_at,
        }


@dataclass(frozen=True, slots=True)
class WriterGenerationEvidence:
    writer_id: str
    target: str
    generation: int
    transition_id: str
    release_id: str
    writer_inventory_sha256: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "writer_id": self.writer_id,
            "target": self.target,
            "generation": self.generation,
            "transition_id": self.transition_id,
            "release_id": self.release_id,
            "writer_inventory_sha256": self.writer_inventory_sha256,
        }


def _validate_selection(marker: RuntimeMarker, binding: GenerationBinding) -> None:
    if marker.generation != binding.generation:
        raise GenerationGuardError("marker generation no longer matches the writer binding")
    if marker.transition_id != binding.transition_id:
        raise GenerationGuardError("marker transition no longer matches the writer binding")
    if binding.target == "vps":
        permitted = marker.permits_vps_workers
    else:
        permitted = (
            marker.status is RuntimeStatus.INACTIVE
            and marker.active_target is ActiveTarget.MAC
        )
    if not permitted:
        raise GenerationGuardError("manual marker does not select the bound writer host")


def read_binding(path: Path) -> GenerationBinding:
    try:
        if path.is_symlink() or not path.is_file():
            raise GenerationGuardError(f"generation binding is missing or unsafe: {path}")
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o022:
            raise GenerationGuardError("generation binding is group/world writable")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except GenerationGuardError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GenerationGuardError(f"generation binding is unreadable: {exc}") from exc
    return GenerationBinding.from_mapping(raw)


def binding_sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise GenerationGuardError(f"cannot hash generation binding: {exc}") from exc


def _atomic_write_binding(path: Path, binding: GenerationBinding, mode: int) -> None:
    if mode not in {0o600, 0o640}:
        raise GenerationGuardError("binding mode must be 0600 or 0640")
    parent = path.parent
    if parent.is_symlink() or not parent.is_dir():
        raise GenerationGuardError(f"binding parent is missing or unsafe: {parent}")
    descriptor = -1
    temporary_name: str | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            dir=parent, prefix=f".{path.name}.", suffix=".tmp"
        )
        os.fchmod(descriptor, mode)
        payload = (
            json.dumps(binding.to_mapping(), ensure_ascii=False, sort_keys=True, indent=2)
            + "\n"
        ).encode("utf-8")
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
        directory_fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as exc:
        raise GenerationGuardError(f"cannot issue generation binding: {exc}") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def issue_binding(
    *,
    path: Path,
    marker_path: Path,
    target: str,
    generation: int,
    transition_id: str,
    release_id: str,
    inventory_path: Path = DEFAULT_INVENTORY_PATH,
    mode: int = 0o600,
) -> GenerationBinding:
    inventory = load_inventory(inventory_path)
    binding = GenerationBinding(
        SCHEMA_VERSION,
        target,
        generation,
        transition_id,
        str(marker_path),
        inventory.sha256,
        release_id,
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    )
    try:
        marker = read_marker(marker_path)
    except (MarkerIOError, MarkerValidationError) as exc:
        raise GenerationGuardError(f"cannot issue binding from marker: {exc}") from exc
    _validate_selection(marker, binding)
    _atomic_write_binding(path, binding, mode)
    return binding


class GenerationGuard:
    """One process's immutable binding to one human-selected generation."""

    def __init__(
        self,
        *,
        writer: WriterSpec,
        binding: GenerationBinding,
        binding_path: Path,
        inventory_path: Path,
    ) -> None:
        self.writer = writer
        self.binding = binding
        self.binding_path = binding_path
        self.inventory_path = inventory_path

    @classmethod
    def bind(
        cls,
        writer_id: str,
        *,
        binding_path: Path,
        inventory_path: Path = DEFAULT_INVENTORY_PATH,
    ) -> "GenerationGuard":
        try:
            inventory = load_inventory(inventory_path)
            binding = read_binding(binding_path)
            writer = inventory.writer(writer_id)
        except WriterInventoryError as exc:
            raise GenerationGuardError(f"writer inventory rejected binding: {exc}") from exc
        if binding.writer_inventory_sha256 != inventory.sha256:
            raise GenerationGuardError("binding uses a different writer inventory")
        if writer.lifecycle != "active" or writer.generation_guard != "required":
            raise GenerationGuardError("writer is sealed or lacks released generation authority")
        if writer.host != binding.target:
            raise GenerationGuardError("writer host does not match the generation binding")
        guard = cls(
            writer=writer,
            binding=binding,
            binding_path=binding_path,
            inventory_path=inventory_path,
        )
        guard.require_current()
        return guard

    def require_current(self) -> WriterGenerationEvidence:
        try:
            inventory: WriterInventory = load_inventory(self.inventory_path)
            current_binding = read_binding(self.binding_path)
            marker = read_marker(Path(self.binding.marker_path))
        except (WriterInventoryError, MarkerIOError, MarkerValidationError) as exc:
            raise GenerationGuardError(f"generation evidence is unavailable: {exc}") from exc
        if inventory.sha256 != self.binding.writer_inventory_sha256:
            raise GenerationGuardError("writer inventory changed after process binding")
        if current_binding != self.binding:
            raise GenerationGuardError("generation binding changed after process startup")
        try:
            current_writer = inventory.writer(self.writer.id)
        except WriterInventoryError as exc:
            raise GenerationGuardError(f"writer inventory changed: {exc}") from exc
        if current_writer != self.writer:
            raise GenerationGuardError("writer declaration changed after process startup")
        _validate_selection(marker, self.binding)
        return WriterGenerationEvidence(
            self.writer.id,
            self.binding.target,
            self.binding.generation,
            self.binding.transition_id,
            self.binding.release_id,
            self.binding.writer_inventory_sha256,
        )


def guard_from_environment(
    writer_id: str | None = None,
    *,
    inventory_path: Path = DEFAULT_INVENTORY_PATH,
) -> GenerationGuard:
    resolved_writer = writer_id or os.environ.get("ARTHUR_SWITCH_WRITER_ID", "")
    binding_value = os.environ.get("ARTHUR_SWITCH_BINDING_PATH", "")
    if not resolved_writer or not binding_value:
        raise GenerationGuardError("switch-managed writer environment is incomplete")
    return GenerationGuard.bind(
        resolved_writer,
        binding_path=Path(binding_value),
        inventory_path=inventory_path,
    )


def _mode(value: str) -> int:
    if value not in {"0600", "0640"}:
        raise argparse.ArgumentTypeError("mode must be 0600 or 0640")
    return int(value, 8)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    issue = subparsers.add_parser("issue")
    issue.add_argument("--binding", type=Path, required=True)
    issue.add_argument("--marker", type=Path, required=True)
    issue.add_argument("--target", choices=("mac", "vps"), required=True)
    issue.add_argument("--generation", type=int, required=True)
    issue.add_argument("--transition", required=True)
    issue.add_argument("--release-id", required=True)
    issue.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY_PATH)
    issue.add_argument("--mode", type=_mode, default=0o600)
    check = subparsers.add_parser("check")
    check.add_argument("--binding", type=Path, required=True)
    check.add_argument("--writer-id", required=True)
    check.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY_PATH)
    args = parser.parse_args(argv)
    if args.command == "issue":
        binding = issue_binding(
            path=args.binding,
            marker_path=args.marker,
            target=args.target,
            generation=args.generation,
            transition_id=args.transition,
            release_id=args.release_id,
            inventory_path=args.inventory,
            mode=args.mode,
        )
        evidence = {
            **binding.to_mapping(),
            "binding_sha256": binding_sha256(args.binding),
        }
    else:
        evidence = GenerationGuard.bind(
            args.writer_id,
            binding_path=args.binding,
            inventory_path=args.inventory,
        ).require_current().as_dict()
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
