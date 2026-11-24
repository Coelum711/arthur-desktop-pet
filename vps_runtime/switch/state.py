"""Pure runtime-marker state and transition validation.

This module deliberately has no knowledge of systemd, launchd, SSH, or the
filesystem.  It models only the version-1 VPS marker contract documented in
``RUNTIME_MARKER.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping


SCHEMA_VERSION = 1
MARKER_FIELDS = frozenset(
    {
        "schema_version",
        "host",
        "status",
        "active_target",
        "generation",
        "transition_id",
        "updated_at",
        "reason",
    }
)


class MarkerValidationError(ValueError):
    """A marker does not satisfy the version-1 contract."""


class TransitionError(ValueError):
    """A valid marker is not a safe successor to the current marker."""


class RuntimeStatus(str, Enum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"


class ActiveTarget(str, Enum):
    MAC = "mac"
    VPS = "vps"


def _parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value:
        raise MarkerValidationError("updated_at must be a non-empty string")

    iso_value = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(iso_value)
    except ValueError as exc:
        raise MarkerValidationError("updated_at must be an RFC 3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise MarkerValidationError("updated_at must include a timezone")
    return parsed


def utc_timestamp(value: datetime | None = None) -> str:
    """Return a canonical UTC timestamp suitable for a new marker."""

    instant = value or datetime.now(timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise MarkerValidationError("timestamp source must include a timezone")
    return instant.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


@dataclass(frozen=True, slots=True)
class RuntimeMarker:
    """A strictly validated version-1 VPS activation marker."""

    schema_version: int
    host: str
    status: RuntimeStatus
    active_target: ActiveTarget | None
    generation: int
    transition_id: str | None
    updated_at: str
    reason: str

    def __post_init__(self) -> None:
        if type(self.schema_version) is not int or self.schema_version != SCHEMA_VERSION:
            raise MarkerValidationError("schema_version must be 1")
        if self.host != "vps":
            raise MarkerValidationError("host must be 'vps'")
        if not isinstance(self.status, RuntimeStatus):
            raise MarkerValidationError("status must be ACTIVE or INACTIVE")
        if self.active_target is not None and not isinstance(
            self.active_target, ActiveTarget
        ):
            raise MarkerValidationError("active_target must be mac, vps, or null")
        if type(self.generation) is not int or self.generation < 0:
            raise MarkerValidationError("generation must be a non-negative integer")
        if self.transition_id is not None and (
            not isinstance(self.transition_id, str) or not self.transition_id
        ):
            raise MarkerValidationError("transition_id must be null or a non-empty string")
        if self.transition_id is not None and len(self.transition_id) > 128:
            raise MarkerValidationError("transition_id must contain at most 128 characters")
        _parse_timestamp(self.updated_at)
        if not isinstance(self.reason, str) or not 1 <= len(self.reason) <= 240:
            raise MarkerValidationError("reason must contain 1 to 240 characters")

        if self.status is RuntimeStatus.ACTIVE and self.active_target is not ActiveTarget.VPS:
            raise MarkerValidationError("an ACTIVE marker must target the VPS")
        if self.status is RuntimeStatus.INACTIVE and self.active_target is ActiveTarget.VPS:
            raise MarkerValidationError("an INACTIVE marker cannot target the VPS")
        if self.active_target in (ActiveTarget.MAC, None) and self.status is not RuntimeStatus.INACTIVE:
            raise MarkerValidationError("mac or null targets must be INACTIVE")

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "RuntimeMarker":
        """Parse a mapping without accepting aliases, defaults, or extra fields."""

        if not isinstance(value, Mapping):
            raise MarkerValidationError("marker must be a JSON object")
        keys = set(value)
        missing = MARKER_FIELDS - keys
        extra = keys - MARKER_FIELDS
        if missing:
            raise MarkerValidationError(
                f"marker is missing fields: {', '.join(sorted(missing))}"
            )
        if extra:
            raise MarkerValidationError(
                f"marker has unsupported fields: {', '.join(sorted(extra))}"
            )

        try:
            status = RuntimeStatus(value["status"])
        except (TypeError, ValueError) as exc:
            raise MarkerValidationError("status must be ACTIVE or INACTIVE") from exc

        raw_target = value["active_target"]
        try:
            target = None if raw_target is None else ActiveTarget(raw_target)
        except (TypeError, ValueError) as exc:
            raise MarkerValidationError("active_target must be mac, vps, or null") from exc

        return cls(
            schema_version=value["schema_version"],
            host=value["host"],
            status=status,
            active_target=target,
            generation=value["generation"],
            transition_id=value["transition_id"],
            updated_at=value["updated_at"],
            reason=value["reason"],
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "host": self.host,
            "status": self.status.value,
            "active_target": (
                self.active_target.value if self.active_target is not None else None
            ),
            "generation": self.generation,
            "transition_id": self.transition_id,
            "updated_at": self.updated_at,
            "reason": self.reason,
        }

    @property
    def permits_vps_workers(self) -> bool:
        return (
            self.schema_version == SCHEMA_VERSION
            and self.host == "vps"
            and self.status is RuntimeStatus.ACTIVE
            and self.active_target is ActiveTarget.VPS
        )


def validate_successor(current: RuntimeMarker, candidate: RuntimeMarker) -> bool:
    """Validate a committed marker update.

    Returns ``False`` for an exact no-op and ``True`` for a real state change.
    Generic updates always require a strictly greater generation.  Completion
    of the documented two-phase VPS-to-Mac handoff is intentionally excluded;
    it must use the explicit marker-store completion API instead.
    """

    if candidate == current:
        return False
    if candidate.generation < current.generation:
        raise TransitionError("generation must never decrease")

    if candidate.generation == current.generation:
        raise TransitionError("same-generation changes require an explicit completion API")

    if candidate.generation != current.generation + 1:
        raise TransitionError("a new state must increment generation by exactly one")
    if candidate.transition_id is None:
        raise TransitionError("a new generation must have a transition_id")
    if candidate.transition_id == current.transition_id:
        raise TransitionError("a new generation must have a new transition_id")
    if _parse_timestamp(candidate.updated_at) < _parse_timestamp(current.updated_at):
        raise TransitionError("updated_at must not move backwards")

    current_state = (current.status, current.active_target)
    candidate_state = (candidate.status, candidate.active_target)
    permitted_transitions = {
        (RuntimeStatus.ACTIVE, ActiveTarget.VPS): {
            (RuntimeStatus.INACTIVE, None),
        },
        (RuntimeStatus.INACTIVE, ActiveTarget.MAC): {
            (RuntimeStatus.ACTIVE, ActiveTarget.VPS),
            (RuntimeStatus.INACTIVE, None),
        },
        (RuntimeStatus.INACTIVE, None): {
            (RuntimeStatus.ACTIVE, ActiveTarget.VPS),
            (RuntimeStatus.INACTIVE, ActiveTarget.MAC),
        },
    }
    if candidate_state not in permitted_transitions[current_state]:
        raise TransitionError(
            f"transition from {current.status.value}/{_target_name(current.active_target)} "
            f"to {candidate.status.value}/{_target_name(candidate.active_target)} "
            "is not permitted"
        )
    return True


def _target_name(target: ActiveTarget | None) -> str:
    return target.value if target is not None else "null"


def validate_mac_completion(
    current: RuntimeMarker,
    candidate: RuntimeMarker,
) -> bool:
    """Validate the explicit same-generation completion of a fenced handoff."""

    if (
        current.status is not RuntimeStatus.INACTIVE
        or current.active_target is not None
        or current.transition_id is None
    ):
        raise TransitionError("only a fenced transition can be completed to Mac")
    if (
        candidate.status is not RuntimeStatus.INACTIVE
        or candidate.active_target is not ActiveTarget.MAC
        or candidate.generation != current.generation
        or candidate.transition_id != current.transition_id
    ):
        raise TransitionError(
            "Mac completion must preserve the fenced generation and transition_id"
        )
    if _parse_timestamp(candidate.updated_at) < _parse_timestamp(current.updated_at):
        raise TransitionError("updated_at must not move backwards")
    return True


def make_marker(
    *,
    status: RuntimeStatus,
    active_target: ActiveTarget | None,
    generation: int,
    transition_id: str | None,
    reason: str,
    updated_at: datetime | None = None,
) -> RuntimeMarker:
    """Construct a new validated marker with a canonical UTC timestamp."""

    return RuntimeMarker(
        schema_version=SCHEMA_VERSION,
        host="vps",
        status=status,
        active_target=active_target,
        generation=generation,
        transition_id=transition_id,
        updated_at=utc_timestamp(updated_at),
        reason=reason,
    )


def next_marker(
    current: RuntimeMarker,
    *,
    status: RuntimeStatus,
    active_target: ActiveTarget | None,
    transition_id: str,
    reason: str,
    updated_at: datetime | None = None,
) -> RuntimeMarker:
    """Construct a new-generation selection from the current marker."""

    if not isinstance(transition_id, str) or not transition_id:
        raise TransitionError("a transition must have a non-empty transition_id")
    return make_marker(
        status=status,
        active_target=active_target,
        generation=current.generation + 1,
        transition_id=transition_id,
        reason=reason,
        updated_at=updated_at,
    )


def complete_mac_handoff(
    fenced: RuntimeMarker,
    *,
    reason: str,
    updated_at: datetime | None = None,
) -> RuntimeMarker:
    """Complete an already-fenced VPS-to-Mac transition."""

    if (
        fenced.status is not RuntimeStatus.INACTIVE
        or fenced.active_target is not None
        or fenced.transition_id is None
    ):
        raise TransitionError("only a fenced transition can be completed to Mac")
    candidate = make_marker(
        status=RuntimeStatus.INACTIVE,
        active_target=ActiveTarget.MAC,
        generation=fenced.generation,
        transition_id=fenced.transition_id,
        reason=reason,
        updated_at=updated_at,
    )
    validate_mac_completion(fenced, candidate)
    return candidate
