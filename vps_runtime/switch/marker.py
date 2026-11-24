"""Fail-closed reading and atomic writing for the VPS runtime marker."""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import tempfile
from typing import Any

from .state import (
    ActiveTarget,
    MarkerValidationError,
    RuntimeMarker,
    RuntimeStatus,
    TransitionError,
    validate_mac_completion,
    validate_successor,
)


CANONICAL_MARKER_PATH = Path("/var/lib/arthur-switch/runtime.json")
MAX_MARKER_BYTES = 64 * 1024


class MarkerIOError(RuntimeError):
    """The marker could not be read or durably written."""


class MarkerMissingError(MarkerIOError):
    """The marker does not exist."""


class MarkerConflictError(MarkerIOError):
    """The marker changed since the caller's preflight read."""


def _decode_marker(raw: bytes) -> RuntimeMarker:
    if len(raw) > MAX_MARKER_BYTES:
        raise MarkerValidationError("marker exceeds the maximum supported size")
    try:
        value: Any = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MarkerValidationError("marker is not valid UTF-8 JSON") from exc
    return RuntimeMarker.from_mapping(value)


def read_marker(path: str | os.PathLike[str] = CANONICAL_MARKER_PATH) -> RuntimeMarker:
    """Read one marker, raising on every missing, malformed, or I/O state."""

    marker_path = Path(path)
    try:
        raw = marker_path.read_bytes()
    except FileNotFoundError as exc:
        raise MarkerMissingError(f"runtime marker is missing: {marker_path}") from exc
    except OSError as exc:
        raise MarkerIOError(f"runtime marker is unreadable: {marker_path}") from exc
    return _decode_marker(raw)


def vps_workers_permitted(
    path: str | os.PathLike[str] = CANONICAL_MARKER_PATH,
    *,
    expected_generation: int | None = None,
) -> bool:
    """Return True only for a valid active VPS marker.

    This is the intentionally fail-closed worker API: all parse and I/O errors
    return ``False``.  A long-running worker can bind to its startup generation
    by supplying ``expected_generation`` before processing or sending work.
    """

    try:
        marker = read_marker(path)
    except (MarkerIOError, MarkerValidationError):
        return False
    if expected_generation is not None and marker.generation != expected_generation:
        return False
    return marker.permits_vps_workers


class MarkerStore:
    """Serialized, atomic commits to an injectable marker path."""

    def __init__(
        self,
        path: str | os.PathLike[str] = CANONICAL_MARKER_PATH,
        *,
        file_mode: int = 0o644,
    ) -> None:
        self.path = Path(path)
        self.lock_path = self.path.with_name(f".{self.path.name}.lock")
        self.file_mode = file_mode

    def read(self) -> RuntimeMarker:
        return read_marker(self.path)

    def initialize(self, marker: RuntimeMarker) -> RuntimeMarker:
        """Create the first generation-zero marker without replacing one."""

        if marker.generation != 0:
            raise TransitionError("the initial marker must use generation 0")
        if (
            marker.status is not RuntimeStatus.INACTIVE
            or marker.active_target not in (ActiveTarget.MAC, None)
        ):
            raise TransitionError("the initial marker must be INACTIVE and target mac or null")
        if marker.transition_id is not None:
            raise TransitionError("the initial marker must have a null transition_id")
        return self._commit(
            marker,
            initialize=True,
            expected_active_target=None,
            expected_generation=None,
            expected_transition_id=None,
            mac_completion=False,
        )

    def commit(
        self,
        marker: RuntimeMarker,
        *,
        expected_active_target: ActiveTarget | None,
        expected_generation: int,
        expected_transition_id: str | None,
    ) -> RuntimeMarker:
        """Commit a safe successor using a full marker compare-and-swap."""

        if type(expected_generation) is not int or expected_generation < 0:
            raise ValueError("expected_generation must be a non-negative integer")
        if expected_active_target is not None and not isinstance(
            expected_active_target, ActiveTarget
        ):
            raise ValueError("expected_active_target must be mac, vps, or null")
        if expected_transition_id is not None and (
            not isinstance(expected_transition_id, str)
            or not expected_transition_id
            or len(expected_transition_id) > 128
        ):
            raise ValueError(
                "expected_transition_id must be null or contain 1 to 128 characters"
            )
        return self._commit(
            marker,
            initialize=False,
            expected_active_target=expected_active_target,
            expected_generation=expected_generation,
            expected_transition_id=expected_transition_id,
            mac_completion=False,
        )

    def commit_mac_completion(
        self,
        marker: RuntimeMarker,
        *,
        expected_generation: int,
        expected_transition_id: str,
    ) -> RuntimeMarker:
        """Commit the explicit same-generation completion of a fenced handoff."""

        if type(expected_generation) is not int or expected_generation < 0:
            raise ValueError("expected_generation must be a non-negative integer")
        if (
            not isinstance(expected_transition_id, str)
            or not expected_transition_id
            or len(expected_transition_id) > 128
        ):
            raise ValueError(
                "expected_transition_id must contain 1 to 128 characters"
            )
        return self._commit(
            marker,
            initialize=False,
            expected_active_target=None,
            expected_generation=expected_generation,
            expected_transition_id=expected_transition_id,
            mac_completion=True,
        )

    def _commit(
        self,
        marker: RuntimeMarker,
        *,
        initialize: bool,
        expected_active_target: ActiveTarget | None,
        expected_generation: int | None,
        expected_transition_id: str | None,
        mac_completion: bool,
    ) -> RuntimeMarker:
        parent = self.path.parent
        if not parent.is_dir():
            raise MarkerIOError(f"marker directory does not exist: {parent}")

        try:
            lock_fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as exc:
            raise MarkerIOError(f"cannot open marker lock: {self.lock_path}") from exc

        try:
            with os.fdopen(lock_fd, "a+b", closefd=True) as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    current = read_marker(self.path)
                except MarkerMissingError:
                    current = None

                if initialize:
                    if current is not None:
                        raise MarkerConflictError("runtime marker is already initialized")
                else:
                    if current is None:
                        raise MarkerConflictError("runtime marker is not initialized")
                    if current.generation != expected_generation:
                        raise MarkerConflictError(
                            "runtime marker generation changed since preflight"
                        )
                    if current.active_target is not expected_active_target:
                        raise MarkerConflictError(
                            "runtime marker target changed since preflight"
                        )
                    if current.transition_id != expected_transition_id:
                        raise MarkerConflictError(
                            "runtime marker transition changed since preflight"
                        )
                    if mac_completion:
                        changed = validate_mac_completion(current, marker)
                    else:
                        changed = validate_successor(current, marker)
                    if not changed:
                        return current

                self._atomic_write(marker)
                return marker
        except (MarkerIOError, MarkerValidationError, MarkerConflictError, TransitionError):
            raise
        except OSError as exc:
            raise MarkerIOError(f"cannot commit runtime marker: {self.path}") from exc

    def _atomic_write(self, marker: RuntimeMarker) -> None:
        payload = (
            json.dumps(
                marker.to_mapping(),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")
        temp_fd = -1
        temp_path: str | None = None
        try:
            temp_fd, temp_path = tempfile.mkstemp(
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
            )
            os.fchmod(temp_fd, self.file_mode)
            with os.fdopen(temp_fd, "wb", closefd=True) as temp_file:
                temp_fd = -1
                temp_file.write(payload)
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_path, self.path)
            temp_path = None
            directory_fd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError as exc:
            raise MarkerIOError(f"cannot atomically write marker: {self.path}") from exc
        finally:
            if temp_fd >= 0:
                os.close(temp_fd)
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass
