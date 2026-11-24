"""Immutable identity for one complete Arthur switch generation.

A runtime generation is the checked tuple described as Arthur's
"luggage": exact code, frozen mutable state, complete reading content, the
writer contract, and the one manual transition that may install it.  None of
the component references may be promoted independently after this document is
created.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


SCHEMA_VERSION = 2
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TRANSITION = re.compile(
    r"^switch-(?:to-vps|to-mac|upgrade-vps|pause|rollback)-[A-Za-z0-9_-]{6,64}$"
)
_TARGETS = {"mac", "vps"}
_SOURCES = {"mac", "vps"}
_CODE_RELEASE_MANIFEST_SCHEMAS = {1, 2}
_IDENTITY_FIELDS = (
    "schema_version",
    "transition_id",
    "source",
    "target",
    "source_generation",
    "target_generation",
    "code_release_id",
    "python_environment_id",
    "state_snapshot_id",
    "content_id",
    "writer_inventory_sha256",
)
_DOCUMENT_FIELDS = {*_IDENTITY_FIELDS, "runtime_generation_id", "created_at"}


class RuntimeGenerationError(RuntimeError):
    """A complete code/state/content generation could not be trusted."""


def _canonical(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def _identity(document: Mapping[str, Any]) -> dict[str, Any]:
    return {field: document[field] for field in _IDENTITY_FIELDS}


def _generation_id(document: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical(_identity(document))).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _validate_timestamp(value: object) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise RuntimeGenerationError("created_at must be a UTC timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise RuntimeGenerationError("created_at is not a valid timestamp") from exc
    if parsed.tzinfo != timezone.utc:
        raise RuntimeGenerationError("created_at must use UTC")


@dataclass(frozen=True)
class RuntimeGenerationRef:
    """Typed, content-free reference used by stage/install/activation."""

    runtime_generation_id: str
    transition_id: str
    source: str
    target: str
    source_generation: int
    target_generation: int
    code_release_id: str
    python_environment_id: str | None
    state_snapshot_id: str
    content_id: str
    writer_inventory_sha256: str

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "RuntimeGenerationRef":
        verified = verify_runtime_generation_document(document)
        return cls(
            runtime_generation_id=verified["runtime_generation_id"],
            transition_id=verified["transition_id"],
            source=verified["source"],
            target=verified["target"],
            source_generation=verified["source_generation"],
            target_generation=verified["target_generation"],
            code_release_id=verified["code_release_id"],
            python_environment_id=verified["python_environment_id"],
            state_snapshot_id=verified["state_snapshot_id"],
            content_id=verified["content_id"],
            writer_inventory_sha256=verified["writer_inventory_sha256"],
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "runtime_generation_id": self.runtime_generation_id,
            "transition_id": self.transition_id,
            "source": self.source,
            "target": self.target,
            "source_generation": self.source_generation,
            "target_generation": self.target_generation,
            "code_release_id": self.code_release_id,
            "python_environment_id": self.python_environment_id,
            "state_snapshot_id": self.state_snapshot_id,
            "content_id": self.content_id,
            "writer_inventory_sha256": self.writer_inventory_sha256,
        }


def build_runtime_generation_document(
    *,
    code_release_manifest: Mapping[str, Any],
    state_snapshot_manifest: Mapping[str, Any],
    content_manifest: Mapping[str, Any],
    transition_id: str,
    target: str,
    target_generation: int,
    writer_inventory_sha256: str,
    python_environment_id: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Bind already-verified component manifests into one install identity."""

    release_id = code_release_manifest.get("release_id")
    if (
        code_release_manifest.get("schema_version")
        not in _CODE_RELEASE_MANIFEST_SCHEMAS
        or not isinstance(release_id, str)
        or not _COMMIT.fullmatch(release_id)
    ):
        raise RuntimeGenerationError("code release manifest has no full Git commit")

    source = state_snapshot_manifest.get("source")
    source_generation = state_snapshot_manifest.get("generation")
    state_snapshot_id = state_snapshot_manifest.get("files_sha256")
    state_code_commit = state_snapshot_manifest.get("code_commit")
    if state_snapshot_manifest.get("schema_version") != 1:
        raise RuntimeGenerationError("state snapshot manifest schema must be 1")
    if source not in _SOURCES:
        raise RuntimeGenerationError("state snapshot source must be mac or vps")
    if (
        type(source_generation) is not int
        or source_generation < 0
        or not isinstance(state_snapshot_id, str)
        or not _SHA256.fullmatch(state_snapshot_id)
    ):
        raise RuntimeGenerationError("state snapshot identity is invalid")
    if state_code_commit != release_id:
        raise RuntimeGenerationError(
            "state was frozen from a different code commit; reconcile and commit "
            "active-host bug fixes before packing luggage"
        )

    content_id = content_manifest.get("content_id")
    if content_manifest.get("schema_version") != 2 or not isinstance(
        content_id, str
    ) or not _SHA256.fullmatch(content_id):
        raise RuntimeGenerationError("content manifest has no valid content id")

    if not isinstance(transition_id, str) or not _TRANSITION.fullmatch(transition_id):
        raise RuntimeGenerationError("transition_id is not an exact manual switch token")
    if target not in _TARGETS:
        raise RuntimeGenerationError("target must be mac or vps")
    if type(target_generation) is not int or target_generation <= source_generation:
        raise RuntimeGenerationError("target generation must be newer than frozen state")
    if target == "vps":
        if not isinstance(python_environment_id, str) or not _SHA256.fullmatch(
            python_environment_id
        ):
            raise RuntimeGenerationError(
                "VPS runtime generation requires an exact Python environment id"
            )
    elif python_environment_id is not None:
        raise RuntimeGenerationError(
            "Mac runtime generation must not claim a VPS Python environment"
        )
    if not isinstance(writer_inventory_sha256, str) or not _SHA256.fullmatch(
        writer_inventory_sha256
    ):
        raise RuntimeGenerationError("writer inventory digest is invalid")

    document: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "transition_id": transition_id,
        "source": source,
        "target": target,
        "source_generation": source_generation,
        "target_generation": target_generation,
        "code_release_id": release_id,
        "python_environment_id": python_environment_id,
        "state_snapshot_id": state_snapshot_id,
        "content_id": content_id,
        "writer_inventory_sha256": writer_inventory_sha256,
        "created_at": created_at or _utc_now(),
    }
    document["runtime_generation_id"] = _generation_id(document)
    return verify_runtime_generation_document(document)


def verify_runtime_generation_document(
    document: Mapping[str, Any],
    *,
    expected_transition_id: str | None = None,
    expected_target: str | None = None,
    expected_generation: int | None = None,
) -> dict[str, Any]:
    if not isinstance(document, Mapping) or set(document) != _DOCUMENT_FIELDS:
        raise RuntimeGenerationError(
            "runtime generation document has missing or unexpected fields"
        )
    value = dict(document)
    if value["schema_version"] != SCHEMA_VERSION:
        raise RuntimeGenerationError("unsupported runtime generation schema")
    if not _TRANSITION.fullmatch(str(value["transition_id"])):
        raise RuntimeGenerationError("invalid runtime generation transition")
    if value["source"] not in _SOURCES or value["target"] not in _TARGETS:
        raise RuntimeGenerationError("invalid runtime generation host")
    source_generation = value["source_generation"]
    target_generation = value["target_generation"]
    if (
        type(source_generation) is not int
        or source_generation < 0
        or type(target_generation) is not int
        or target_generation <= source_generation
    ):
        raise RuntimeGenerationError("invalid runtime generation ordering")
    if not _COMMIT.fullmatch(str(value["code_release_id"])):
        raise RuntimeGenerationError("invalid code release id")
    python_environment_id = value["python_environment_id"]
    if value["target"] == "vps":
        if not isinstance(python_environment_id, str) or not _SHA256.fullmatch(
            python_environment_id
        ):
            raise RuntimeGenerationError("invalid VPS Python environment id")
    elif python_environment_id is not None:
        raise RuntimeGenerationError("Mac runtime generation has a VPS environment id")
    for field in (
        "runtime_generation_id",
        "state_snapshot_id",
        "content_id",
        "writer_inventory_sha256",
    ):
        if not _SHA256.fullmatch(str(value[field])):
            raise RuntimeGenerationError(f"invalid {field}")
    _validate_timestamp(value["created_at"])
    if value["runtime_generation_id"] != _generation_id(value):
        raise RuntimeGenerationError("runtime generation identity mismatch")
    if expected_transition_id is not None and value["transition_id"] != expected_transition_id:
        raise RuntimeGenerationError("runtime generation transition mismatch")
    if expected_target is not None and value["target"] != expected_target:
        raise RuntimeGenerationError("runtime generation target mismatch")
    if expected_generation is not None and value["target_generation"] != expected_generation:
        raise RuntimeGenerationError("runtime generation number mismatch")
    return value


def write_runtime_generation_document(path: Path, document: Mapping[str, Any]) -> None:
    """Atomically persist a verified manifest without embedding private state."""

    verified = verify_runtime_generation_document(document)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(raw_temporary)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(_canonical(verified))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def load_runtime_generation_document(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeGenerationError(f"invalid runtime generation document: {exc}") from exc
    return verify_runtime_generation_document(value)
