"""Validated single source of truth for switch-controlled writer processes."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping


DEFAULT_INVENTORY_PATH = Path(__file__).with_name("writer_inventory.json")
_HOSTS = frozenset({"mac", "vps"})
_MANAGERS = frozenset({"launchd", "systemd", "code-seal"})
_LIFECYCLES = frozenset({"active", "sealed"})
_ROLES = frozenset({"primary", "canonical", "backup", "external", "control-evidence"})
_DRAIN = frozenset({"natural", "stop", "not-applicable"})
_GUARDS = frozenset({"required", "required-before-release"})
_CHECKPOINTS = frozenset({"before_work", "commit_scope", "verify"})
_EXCLUSION_STAGING_POLICIES = frozenset(
    {"inert-release-bound", "isolated-inactive-release-bound"}
)


class WriterInventoryError(ValueError):
    """The inventory is incomplete, ambiguous, or unsafe."""


def _required_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WriterInventoryError(f"{name} must be a non-empty string")
    if any(char in value for char in ("\x00", "\r", "\n")):
        raise WriterInventoryError(f"{name} contains control characters")
    return value


@dataclass(frozen=True, slots=True)
class WriterSpec:
    id: str
    host: str
    manager: str
    unit: str
    activator: str | None
    lifecycle: str
    role: str
    drain: str
    generation_guard: str
    write_surfaces: tuple[str, ...]
    guard_checkpoints: tuple[str, ...]
    process_group: str | None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "WriterSpec":
        required = {
            "id",
            "host",
            "manager",
            "unit",
            "activator",
            "lifecycle",
            "role",
            "drain",
            "generation_guard",
            "write_surfaces",
            "guard_checkpoints",
        }
        if not isinstance(value, Mapping):
            raise WriterInventoryError("writer fields do not match schema version 5")
        fields = set(value)
        if not required.issubset(fields) or not fields.issubset(
            required | {"process_group"}
        ):
            raise WriterInventoryError("writer fields do not match schema version 5")
        host = _required_text(value["host"], "writer.host")
        manager = _required_text(value["manager"], "writer.manager")
        lifecycle = _required_text(value["lifecycle"], "writer.lifecycle")
        role = _required_text(value["role"], "writer.role")
        drain = _required_text(value["drain"], "writer.drain")
        guard = _required_text(value["generation_guard"], "writer.generation_guard")
        if host not in _HOSTS:
            raise WriterInventoryError("writer.host must be mac or vps")
        if manager not in _MANAGERS:
            raise WriterInventoryError("writer.manager is unsupported")
        if lifecycle not in _LIFECYCLES:
            raise WriterInventoryError("writer.lifecycle must be active or sealed")
        if role not in _ROLES:
            raise WriterInventoryError("writer.role is unsupported")
        if drain not in _DRAIN:
            raise WriterInventoryError("writer.drain is unsupported")
        if guard not in _GUARDS:
            raise WriterInventoryError("writer.generation_guard is unsupported")
        if lifecycle == "active" and guard != "required":
            raise WriterInventoryError("active writers must require a generation guard")
        if manager == "code-seal" and lifecycle != "sealed":
            raise WriterInventoryError("code-seal writers must remain sealed")
        if manager == "code-seal" and value["activator"] is not None:
            raise WriterInventoryError("code-seal writers cannot have an activator")
        activator = value["activator"]
        if activator is not None:
            activator = _required_text(activator, "writer.activator")
        process_group = value.get("process_group")
        if process_group is not None:
            process_group = _required_text(process_group, "writer.process_group")
            if manager != "systemd":
                raise WriterInventoryError("only systemd writers may share a process group")
        surfaces = value["write_surfaces"]
        if not isinstance(surfaces, list):
            raise WriterInventoryError("writer.write_surfaces must be a list")
        parsed_surfaces = tuple(_required_text(item, "write surface") for item in surfaces)
        if len(set(parsed_surfaces)) != len(parsed_surfaces):
            raise WriterInventoryError("writer.write_surfaces contains duplicates")
        checkpoints = value["guard_checkpoints"]
        if not isinstance(checkpoints, list):
            raise WriterInventoryError("writer.guard_checkpoints must be a list")
        parsed_checkpoints = tuple(
            _required_text(item, "guard checkpoint") for item in checkpoints
        )
        if (
            len(set(parsed_checkpoints)) != len(parsed_checkpoints)
            or any(item not in _CHECKPOINTS for item in parsed_checkpoints)
        ):
            raise WriterInventoryError("writer.guard_checkpoints are invalid")
        expected_checkpoints = (
            ("before_work", "commit_scope", "verify")
            if parsed_surfaces
            else ("before_work", "verify")
        )
        if parsed_checkpoints != expected_checkpoints:
            raise WriterInventoryError(
                "writer.guard_checkpoints do not match its write surfaces"
            )
        return cls(
            _required_text(value["id"], "writer.id"),
            host,
            manager,
            _required_text(value["unit"], "writer.unit"),
            activator,
            lifecycle,
            role,
            drain,
            guard,
            parsed_surfaces,
            parsed_checkpoints,
            process_group,
        )


@dataclass(frozen=True, slots=True)
class ExclusionSpec:
    id: str
    host: str
    manager: str
    unit: str
    activator: str | None
    staging_policy: str
    reason: str

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ExclusionSpec":
        if not isinstance(value, Mapping) or set(value) != {
            "id",
            "host",
            "manager",
            "unit",
            "activator",
            "staging_policy",
            "reason",
        }:
            raise WriterInventoryError("exclusion fields do not match schema version 5")
        host = _required_text(value["host"], "exclusion.host")
        manager = _required_text(value["manager"], "exclusion.manager")
        if host not in _HOSTS or manager not in _MANAGERS:
            raise WriterInventoryError("exclusion host or manager is unsupported")
        activator = value["activator"]
        if activator is not None:
            activator = _required_text(activator, "exclusion.activator")
        if manager == "code-seal" and activator is not None:
            raise WriterInventoryError("code-seal exclusions cannot have an activator")
        staging_policy = _required_text(
            value["staging_policy"], "exclusion.staging_policy"
        )
        if staging_policy not in _EXCLUSION_STAGING_POLICIES:
            raise WriterInventoryError("exclusion.staging_policy is unsupported")
        if staging_policy == "isolated-inactive-release-bound" and (
            host != "vps" or manager != "systemd" or activator is not None
        ):
            raise WriterInventoryError(
                "isolated enabled exclusions must be one VPS systemd service"
            )
        return cls(
            _required_text(value["id"], "exclusion.id"),
            host,
            manager,
            _required_text(value["unit"], "exclusion.unit"),
            activator,
            staging_policy,
            _required_text(value["reason"], "exclusion.reason"),
        )


@dataclass(frozen=True, slots=True)
class WriterInventory:
    writers: tuple[WriterSpec, ...]
    exclusions: tuple[ExclusionSpec, ...]
    sha256: str

    def select(
        self,
        *,
        host: str | None = None,
        manager: str | None = None,
        lifecycle: str | None = None,
        drain: str | None = None,
    ) -> tuple[WriterSpec, ...]:
        return tuple(
            writer
            for writer in self.writers
            if (host is None or writer.host == host)
            and (manager is None or writer.manager == manager)
            and (lifecycle is None or writer.lifecycle == lifecycle)
            and (drain is None or writer.drain == drain)
        )

    def writer(self, writer_id: str) -> WriterSpec:
        matches = [writer for writer in self.writers if writer.id == writer_id]
        if len(matches) != 1:
            raise WriterInventoryError(f"writer is not uniquely declared: {writer_id}")
        return matches[0]

    def exclusion(self, exclusion_id: str) -> ExclusionSpec:
        matches = [item for item in self.exclusions if item.id == exclusion_id]
        if len(matches) != 1:
            raise WriterInventoryError(
                f"exclusion is not uniquely declared: {exclusion_id}"
            )
        return matches[0]


def _canonical_digest(value: Mapping[str, Any]) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_inventory(path: Path = DEFAULT_INVENTORY_PATH) -> WriterInventory:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise WriterInventoryError(f"cannot read writer inventory: {exc}") from exc
    if not isinstance(raw, dict) or set(raw) != {"schema_version", "writers", "exclusions"}:
        raise WriterInventoryError("inventory fields do not match schema version 5")
    if type(raw["schema_version"]) is not int or raw["schema_version"] != 5:
        raise WriterInventoryError("inventory schema_version must be 5")
    if not isinstance(raw["writers"], list) or not raw["writers"]:
        raise WriterInventoryError("inventory writers must not be empty")
    if not isinstance(raw["exclusions"], list):
        raise WriterInventoryError("inventory exclusions must be a list")
    writers = tuple(WriterSpec.from_mapping(item) for item in raw["writers"])
    exclusions = tuple(ExclusionSpec.from_mapping(item) for item in raw["exclusions"])
    ids = [item.id for item in (*writers, *exclusions)]
    if len(ids) != len(set(ids)):
        raise WriterInventoryError("writer and exclusion IDs must be unique")
    managed_target_owners: dict[tuple[str, str, str], list[WriterSpec]] = {}
    for item in writers:
        for target in (item.unit, item.activator):
            if target is not None:
                managed_target_owners.setdefault(
                    (item.host, item.manager, target), []
                ).append(item)
    for owners in managed_target_owners.values():
        if len(owners) == 1:
            continue
        groups = {item.process_group for item in owners}
        if None in groups or len(groups) != 1:
            raise WriterInventoryError(
                "shared managed targets require one explicit process group"
            )
        group = next(iter(groups))
        members = [item for item in writers if item.process_group == group]
        if not any(item.id == group for item in members):
            raise WriterInventoryError("process group must name its supervisor writer")
        signatures = {
            (item.host, item.manager, item.unit, item.activator, item.lifecycle, item.drain)
            for item in members
        }
        if len(signatures) != 1:
            raise WriterInventoryError(
                "process-group writers must share lifecycle and process targets"
            )
    managed_targets = set(managed_target_owners)
    excluded_targets = [
        (item.host, item.manager, target)
        for item in exclusions
        for target in (item.unit, item.activator)
        if target is not None
    ]
    if len(excluded_targets) != len(set(excluded_targets)):
        raise WriterInventoryError("excluded host units and activators must be unique")
    if set(excluded_targets) & managed_targets:
        raise WriterInventoryError(
            "a host unit or activator cannot be managed and excluded"
        )
    for host in _HOSTS:
        primaries = [
            item
            for item in writers
            if item.host == host and item.lifecycle == "active" and item.role == "primary"
        ]
        if len(primaries) != 1:
            raise WriterInventoryError(f"{host} must declare exactly one active primary writer")
    return WriterInventory(writers, exclusions, _canonical_digest(raw))


def _values(writers: Iterable[WriterSpec], field: str) -> list[str]:
    values: list[str] = []
    for writer in writers:
        value = getattr(writer, field)
        if value is not None and value not in values:
            values.append(value)
    return values


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("field", choices=("units", "activators", "ids", "digest"))
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY_PATH)
    parser.add_argument("--host", choices=tuple(sorted(_HOSTS)))
    parser.add_argument("--manager", choices=tuple(sorted(_MANAGERS)))
    parser.add_argument("--lifecycle", choices=tuple(sorted(_LIFECYCLES)))
    parser.add_argument("--drain", choices=tuple(sorted(_DRAIN)))
    args = parser.parse_args(argv)
    inventory = load_inventory(args.inventory)
    if args.field == "digest":
        print(inventory.sha256)
        return 0
    selected = inventory.select(
        host=args.host,
        manager=args.manager,
        lifecycle=args.lifecycle,
        drain=args.drain,
    )
    field = {"units": "unit", "activators": "activator", "ids": "id"}[args.field]
    for value in _values(selected, field):
        print(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
