"""Side-effect boundary for the manual Arthur runtime switch.

This module intentionally contains no subprocess, SSH, launchd, systemd, or
filesystem mutation implementation.  A deployment-specific adapter must be
injected by the caller before :mod:`orchestrator` can execute a transaction.
The command-line entry point uses :class:`UnconfiguredAdapter`, which is
read-only and reports an unknown runtime state.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Mapping, Protocol, runtime_checkable

try:
    from .state import RuntimeMarker as MarkerDocument
except ImportError:  # pragma: no cover - direct module execution support
    from state import RuntimeMarker as MarkerDocument  # type: ignore[no-redef]


class AdapterError(RuntimeError):
    """Raised when an adapter cannot complete or verify an operation."""


@dataclass(frozen=True)
class PreflightReport:
    """Read-only evidence and blockers returned before any transaction.

    ``ok`` is deliberately strict: a successful report cannot carry blockers,
    and a failed report must explain why.  Evidence is informational and must
    never contain credentials or companion/chat content.
    """

    ok: bool
    blockers: tuple[str, ...] = ()
    evidence: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if type(self.ok) is not bool:
            raise ValueError("preflight ok must be a boolean")
        if self.ok and self.blockers:
            raise ValueError("a successful preflight cannot contain blockers")
        if not self.ok and not self.blockers:
            raise ValueError("a failed preflight must contain at least one blocker")
        if any(not isinstance(item, str) or not item for item in self.blockers):
            raise ValueError("preflight blockers must be non-empty strings")

    @classmethod
    def blocked(
        cls, blocker: str, *, evidence: Mapping[str, Any] | None = None
    ) -> "PreflightReport":
        return cls(False, (blocker,), evidence or {})

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "blockers": list(self.blockers),
            "evidence": dict(self.evidence),
        }


class HostActivity(str, Enum):
    """Verified activity state for all writers on one runtime host."""

    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    UNKNOWN = "UNKNOWN"


class SelectedTarget(str, Enum):
    """Selection recorded by the canonical switch marker."""

    MAC = "mac"
    VPS = "vps"
    NONE = "none"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class RuntimeObservation:
    """One consistent, adapter-produced view of both runtime hosts.

    ``marker_valid`` must be exactly ``True`` before the orchestrator trusts
    any selection.  This makes missing, unreadable, unsupported, and
    contradictory marker states fail closed.
    """

    selected_target: SelectedTarget = SelectedTarget.UNKNOWN
    mac_activity: HostActivity = HostActivity.UNKNOWN
    vps_activity: HostActivity = HostActivity.UNKNOWN
    marker_valid: bool = False
    generation: int | None = None
    transition_id: str | None = None
    detail: str = "runtime observation is unavailable"

    @classmethod
    def unknown(cls, detail: str = "runtime observation is unavailable") -> "RuntimeObservation":
        return cls(detail=detail)

    def as_dict(self) -> dict[str, Any]:
        return {
            "selected_target": self.selected_target.value,
            "mac_activity": self.mac_activity.value,
            "vps_activity": self.vps_activity.value,
            "marker_valid": self.marker_valid,
            "generation": self.generation,
            "transition_id": self.transition_id,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class SnapshotRef:
    """Opaque, immutable snapshot reference returned by an adapter."""

    snapshot_id: str
    source: SelectedTarget
    generation: int
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StagedRef:
    """Opaque reference proving that a snapshot was staged and validated."""

    snapshot_id: str
    target: SelectedTarget
    generation: int
    release_id: str
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class InstalledRef:
    """Proof that a staged release was atomically installed for activation."""

    snapshot_id: str
    target: SelectedTarget
    generation: int
    release_id: str
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TransactionLease:
    """Opaque authority returned by ``begin`` for one durable transaction."""

    transition_id: str
    token: str

    def __post_init__(self) -> None:
        if not self.transition_id or not self.token:
            raise ValueError("transaction lease fields must be non-empty")


@dataclass(frozen=True)
class MarkerFingerprint:
    """The marker identity an atomic compare-and-swap must still observe."""

    selected_target: SelectedTarget
    generation: int
    transition_id: str | None


@dataclass(frozen=True)
class ActivationEvidence:
    """Typed, point-in-time evidence required immediately before activation.

    This deliberately has no generic ``ok`` flag.  The orchestrator evaluates
    each safety property relevant to the requested target instead of trusting
    one adapter-controlled boolean.
    """

    chat_lineage: str
    cursor_path: str
    cursor_policy: str
    allowlist_verified: bool
    backlog_safe: bool
    checked_at: datetime
    writers_drained: bool
    install_verified: bool
    writer_inventory_sha256: str
    generation_guard_ready: bool
    detail: str = ""


@dataclass(frozen=True)
class RollbackPoint:
    """A previously verified snapshot that can be restored manually."""

    target: SelectedTarget
    snapshot: SnapshotRef
    detail: str = ""


@runtime_checkable
class SwitchAdapter(Protocol):
    """Required deployment-specific operations.

    Implementations are responsible for safely translating these calls into
    host operations.  They must be independently reviewed; this repository
    deliberately ships no executable host adapter.
    """

    @property
    def execution_enabled(self) -> bool:
        """Whether this adapter is explicitly capable of mutations."""

    def observe(self) -> RuntimeObservation:
        """Return a verified view of both hosts and the canonical marker."""

    def rollback_point(self) -> RollbackPoint | None:
        """Return the last verified recovery point, if one exists."""

    def preflight(
        self,
        command: str,
        source: SelectedTarget | None,
        target: SelectedTarget | None,
    ) -> PreflightReport:
        """Read only: verify command-specific readiness and return evidence."""

    def recovery_snapshot(self) -> SnapshotRef | None:
        """Return the latest verified snapshot usable to resume from PAUSED."""

    def begin(
        self, transition_id: str, plan: Mapping[str, Any]
    ) -> TransactionLease:
        """Durably record a transaction and return its exclusive lease."""

    def stop(self, host: SelectedTarget, lease: TransactionLease) -> None:
        """Disable launchers/schedules and stop all writers on ``host``."""

    def drain(self, host: SelectedTarget, lease: TransactionLease) -> None:
        """Wait for all in-flight and detached writers, then verify absence."""

    def snapshot(
        self, host: SelectedTarget, generation: int, lease: TransactionLease
    ) -> SnapshotRef:
        """Create and validate an immutable complete runtime snapshot."""

    def stage(
        self,
        snapshot: SnapshotRef,
        target: SelectedTarget,
        generation: int,
        lease: TransactionLease,
    ) -> StagedRef:
        """Stage and validate ``snapshot`` without activating it."""

    def install(
        self, staged: StagedRef, lease: TransactionLease
    ) -> InstalledRef:
        """Atomically install a staged release while its target stays inactive."""

    def activation_preflight(
        self,
        command: str,
        target: SelectedTarget,
        installed: InstalledRef,
        lease: TransactionLease,
    ) -> ActivationEvidence:
        """Return fresh typed evidence after install and before marker publish."""

    def publish_marker(
        self,
        marker: MarkerDocument,
        expected_predecessor: MarkerFingerprint,
        lease: TransactionLease,
    ) -> None:
        """Publish only if the marker still has ``expected_predecessor``."""

    def start(self, host: SelectedTarget, lease: TransactionLease) -> None:
        """Explicitly start the selected runtime for the new generation."""

    def verify(
        self, expected: SelectedTarget, generation: int, lease: TransactionLease
    ) -> None:
        """Perform target health checks (or paused-state checks)."""

    def stop_and_fence_failed_target(
        self,
        host: SelectedTarget,
        generation: int,
        lease: TransactionLease,
    ) -> None:
        """Stop and fence a target whose start or verification failed."""

    def complete(
        self, lease: TransactionLease, result: Mapping[str, Any]
    ) -> None:
        """Durably record successful transaction completion."""

    def abort(
        self,
        lease: TransactionLease,
        failed_step: str,
        marker_published: bool,
        error: str,
    ) -> None:
        """Record a failure without attempting automatic failover."""


class UnconfiguredAdapter:
    """Safe CLI default: read-only, unknown, and incapable of execution."""

    @property
    def execution_enabled(self) -> bool:
        return False

    def observe(self) -> RuntimeObservation:
        return RuntimeObservation.unknown(
            "no deployment adapter was injected; status cannot be verified"
        )

    def rollback_point(self) -> RollbackPoint | None:
        return None

    def recovery_snapshot(self) -> SnapshotRef | None:
        return None

    def preflight(
        self,
        command: str,
        source: SelectedTarget | None,
        target: SelectedTarget | None,
    ) -> PreflightReport:
        return PreflightReport.blocked(
            "preflight unavailable: no reviewed deployment adapter was injected",
            evidence={"adapter": "unconfigured", "mutations_performed": False},
        )

    def _disabled(self, operation: str) -> None:
        raise AdapterError(
            f"{operation} is unavailable: no reviewed deployment adapter was injected"
        )

    def begin(
        self, transition_id: str, plan: Mapping[str, Any]
    ) -> TransactionLease:
        self._disabled("begin")
        raise AssertionError("unreachable")

    def stop(self, host: SelectedTarget, lease: TransactionLease) -> None:
        self._disabled("stop")

    def drain(self, host: SelectedTarget, lease: TransactionLease) -> None:
        self._disabled("drain")

    def snapshot(
        self, host: SelectedTarget, generation: int, lease: TransactionLease
    ) -> SnapshotRef:
        self._disabled("snapshot")
        raise AssertionError("unreachable")

    def stage(
        self,
        snapshot: SnapshotRef,
        target: SelectedTarget,
        generation: int,
        lease: TransactionLease,
    ) -> StagedRef:
        self._disabled("stage")
        raise AssertionError("unreachable")

    def install(
        self, staged: StagedRef, lease: TransactionLease
    ) -> InstalledRef:
        self._disabled("install")
        raise AssertionError("unreachable")

    def activation_preflight(
        self,
        command: str,
        target: SelectedTarget,
        installed: InstalledRef,
        lease: TransactionLease,
    ) -> ActivationEvidence:
        self._disabled("activation_preflight")
        raise AssertionError("unreachable")

    def publish_marker(
        self,
        marker: MarkerDocument,
        expected_predecessor: MarkerFingerprint,
        lease: TransactionLease,
    ) -> None:
        self._disabled("publish_marker")

    def start(self, host: SelectedTarget, lease: TransactionLease) -> None:
        self._disabled("start")

    def verify(
        self, expected: SelectedTarget, generation: int, lease: TransactionLease
    ) -> None:
        self._disabled("verify")

    def stop_and_fence_failed_target(
        self,
        host: SelectedTarget,
        generation: int,
        lease: TransactionLease,
    ) -> None:
        self._disabled("stop_and_fence_failed_target")

    def complete(
        self, lease: TransactionLease, result: Mapping[str, Any]
    ) -> None:
        self._disabled("complete")

    def abort(
        self,
        lease: TransactionLease,
        failed_step: str,
        marker_published: bool,
        error: str,
    ) -> None:
        # There is nothing to record and, critically, no recovery action to run.
        return None
