"""Pure, read-only projection for the desktop companion status contract.

This module performs no file, network, marker, service, or runtime writes.  Its
inputs must already be control-plane observations stripped of companion text.
It emits only a small UI-safe document and fails closed to ``unknown`` when the
selection, writer, runtime-generation, or source bindings disagree.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from .adapters import HostActivity
from .host_probe import HostProbeResult
from .runtime_generation import RuntimeGenerationRef
from .state import RuntimeMarker, RuntimeStatus


SCHEMA_VERSION = "arthur.companion-status/1"
DEFAULT_STALE_AFTER_MS = 15_000
_CLOCK_SKEW_MS = 5_000
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TRANSITION = re.compile(
    r"^switch-(?:to-vps|to-mac|upgrade-vps|pause|rollback)-[A-Za-z0-9_-]{6,64}$"
)

PHASES = frozenset({"stable", "switching", "unknown"})
HOSTS = frozenset({"mac", "vps", "unknown"})
WRITER_STATES = frozenset({"ACTIVE", "INACTIVE", "UNKNOWN"})
AVAILABILITIES = frozenset({"awake", "sleeping", "unknown"})
PLACES = frozenset({"home", "hotel", "outdoors", "transit", "unknown"})
POSES = frozenset(
    {"awake", "sleeping", "waking", "reading", "tea", "outdoors", "unknown"}
)
ACTIVITY_KEYS = frozenset(
    {"reading", "tea", "guitar", "sleeping", "outdoors", "learned_activity", "unknown"}
)
ACTIVITY_TYPES = frozenset(
    {"home", "hotel", "outdoors", "transit", "exercise", "bathing", "sleep", "unknown"}
)
HANDS = frozenset({"none", "left", "right", "both", "unknown"})
MOBILITY = frozenset({"stationary", "mobile", "unknown"})
# What kind of thing he is doing, one step finer than the key: a category
# only, never his words.  Optional in the document, like outfit.
ACTIVITY_DETAILS = frozenset({
    "cooking", "garden", "writing", "music", "housework", "occult", "watching",
    "online", "work", "resting", "drinking", "hobby", "exercise", "bathing",
    "pub", "museum", "park", "market", "eating_out", "walking", "fishing",
    "unknown",
})
# Coarse weather where he is, and whether a message from him is waiting for
# her reply.  Both optional, both categories only.
WEATHER_SKIES = frozenset({"clear", "cloud", "rain", "fog", "snow", "unknown"})
WEATHER_TEMPS = frozenset({"freezing", "cold", "mild", "warm", "hot", "unknown"})
LETTERS = frozenset({"waiting", "none"})
# His fairy friends are visiting right now, and from which part of Britain
# (where he's staying). A region only, never the visit's description.
FAIRY_REGIONS = frozenset({"home", "england", "scotland", "wales", "westcountry", "none"})
# Opaque id of the waiting message, so the desktop can remember it was read.
_LETTER_ID = re.compile(r"^[0-9a-f]{12}$")
# What he went out in, as a category only (never his words).  Optional in the
# document so older exporters/consumers keep validating.
OUTFITS = frozenset({
    "coat", "raincoat", "tweed", "jumper", "city", "dress", "trench",
    "pirate", "punk", "unknown",
})
HEALTH = frozenset({"healthy", "degraded", "unknown"})


class CompanionStatusError(ValueError):
    """A source or projected document violates the reviewed safe contract."""


def _aware(value: datetime, label: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise CompanionStatusError(f"{label} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _parse_utc(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise CompanionStatusError(f"{label} must be a UTC RFC 3339 timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise CompanionStatusError(f"{label} must be a valid RFC 3339 timestamp") from exc
    if parsed.tzinfo != timezone.utc:
        raise CompanionStatusError(f"{label} must use UTC")
    return parsed


def _timestamp(value: datetime) -> str:
    return _aware(value, "timestamp").isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _enum(value: object, allowed: frozenset[str], label: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise CompanionStatusError(f"{label} is not an accepted enum value")
    return value


@dataclass(frozen=True, slots=True)
class ProjectionBinding:
    """The complete generation identity carried by every UI-safe source."""

    target: str
    generation: int
    transition_id: str
    runtime_generation_id: str

    def __post_init__(self) -> None:
        if self.target not in {"mac", "vps"}:
            raise CompanionStatusError("binding target must be mac or vps")
        if type(self.generation) is not int or self.generation < 0:
            raise CompanionStatusError("binding generation must be a non-negative integer")
        if not isinstance(self.transition_id, str) or not _TRANSITION.fullmatch(
            self.transition_id
        ):
            raise CompanionStatusError("binding transition_id is invalid")
        if not isinstance(self.runtime_generation_id, str) or not _SHA256.fullmatch(
            self.runtime_generation_id
        ):
            raise CompanionStatusError("binding runtime_generation_id is invalid")


@dataclass(frozen=True, slots=True)
class WriterObservation:
    observed_at: datetime
    probe: HostProbeResult

    def __post_init__(self) -> None:
        _aware(self.observed_at, "writer observed_at")
        if not isinstance(self.probe, HostProbeResult):
            raise CompanionStatusError("writer probe must be a HostProbeResult")


@dataclass(frozen=True, slots=True)
class SafeArthurProjection:
    """Content-free Arthur facts deliberately approved for desktop display."""

    observed_at: datetime
    binding: ProjectionBinding
    availability: str = "unknown"
    place: str = "unknown"
    pose: str = "unknown"
    activity_key: str = "unknown"
    activity_type: str = "unknown"
    hands: str = "unknown"
    mobility: str = "unknown"
    body_locked: bool | None = None
    outfit: str = "unknown"
    activity_detail: str = "unknown"
    weather_sky: str = "unknown"
    weather_temp: str = "unknown"
    letter: str = "none"
    letter_id: str | None = None
    fairies: str = "none"

    def __post_init__(self) -> None:
        _enum(self.fairies, FAIRY_REGIONS, "fairies")
        if self.letter_id is not None and (self.letter != "waiting" or not _LETTER_ID.fullmatch(self.letter_id)):
            raise CompanionStatusError("letter_id needs a waiting letter and 12 hex digits")
        _enum(self.weather_sky, WEATHER_SKIES, "weather sky")
        _enum(self.weather_temp, WEATHER_TEMPS, "weather temperature")
        _enum(self.letter, LETTERS, "letter")
        _aware(self.observed_at, "Arthur projection observed_at")
        _enum(self.outfit, OUTFITS, "outfit")
        _enum(self.activity_detail, ACTIVITY_DETAILS, "activity detail")
        _enum(self.availability, AVAILABILITIES, "availability")
        _enum(self.place, PLACES, "place")
        _enum(self.pose, POSES, "pose")
        _enum(self.activity_key, ACTIVITY_KEYS, "activity key")
        _enum(self.activity_type, ACTIVITY_TYPES, "activity type")
        _enum(self.hands, HANDS, "hands")
        _enum(self.mobility, MOBILITY, "mobility")
        if self.body_locked is not None and type(self.body_locked) is not bool:
            raise CompanionStatusError("body_locked must be boolean or null")


@dataclass(frozen=True, slots=True)
class MaintenanceProjection:
    """A generation-bound coarse health result with no raw marker details."""

    observed_at: datetime
    binding: ProjectionBinding
    health: str

    def __post_init__(self) -> None:
        _aware(self.observed_at, "maintenance observed_at")
        _enum(self.health, HEALTH, "maintenance health")


def _unknown_arthur() -> dict[str, Any]:
    return {
        "availability": "unknown",
        "place": "unknown",
        "pose": "unknown",
        "activity": {
            "key": "unknown",
            "type": "unknown",
            "resources": {
                "hands": "unknown",
                "mobility": "unknown",
                "body_locked": None,
            },
        },
    }


def _unknown_document(observed_at: datetime, stale_after_ms: int) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "observed_at": _timestamp(observed_at),
        "selection": {
            "phase": "unknown",
            "host": "unknown",
            "generation": None,
            "runtime_generation_id": None,
            "transition_id": None,
        },
        "writers": {"state": "UNKNOWN"},
        "arthur": _unknown_arthur(),
        "maintenance": {"health": "unknown"},
        "freshness": {
            "source_age_ms": None,
            "stale_after_ms": stale_after_ms,
            "stale": True,
        },
    }


def _switching_document(
    marker: RuntimeMarker, observed_at: datetime, stale_after_ms: int
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "observed_at": _timestamp(observed_at),
        "selection": {
            "phase": "switching",
            "host": "unknown",
            "generation": marker.generation,
            "runtime_generation_id": None,
            "transition_id": marker.transition_id,
        },
        "writers": {"state": "UNKNOWN"},
        "arthur": _unknown_arthur(),
        "maintenance": {"health": "unknown"},
        "freshness": {
            "source_age_ms": None,
            "stale_after_ms": stale_after_ms,
            "stale": True,
        },
    }


def _binding_for(
    marker: RuntimeMarker, runtime_generation: RuntimeGenerationRef
) -> ProjectionBinding:
    if marker.active_target is None or marker.transition_id is None:
        raise CompanionStatusError("a stable selection requires a complete marker binding")
    return ProjectionBinding(
        marker.active_target.value,
        marker.generation,
        marker.transition_id,
        runtime_generation.runtime_generation_id,
    )


def _stable_sources_match(
    marker: RuntimeMarker,
    writer: WriterObservation,
    runtime_generation: RuntimeGenerationRef,
    arthur: SafeArthurProjection,
    maintenance: MaintenanceProjection,
) -> ProjectionBinding | None:
    if marker.active_target is None or marker.transition_id is None:
        return None
    target = marker.active_target.value
    expected_status = RuntimeStatus.ACTIVE if target == "vps" else RuntimeStatus.INACTIVE
    if marker.status is not expected_status:
        return None
    try:
        binding = _binding_for(marker, runtime_generation)
    except CompanionStatusError:
        return None
    probe = writer.probe
    if (
        probe.host != target
        or probe.activity is not HostActivity.ACTIVE
        or not probe.binding_valid
        or probe.inventory_sha256 != runtime_generation.writer_inventory_sha256
        or probe.bound_target != target
        or probe.bound_generation != marker.generation
        or probe.bound_transition_id != marker.transition_id
        or probe.sealed_violations
    ):
        return None
    if (
        runtime_generation.target != target
        or runtime_generation.target_generation != marker.generation
        or runtime_generation.transition_id != marker.transition_id
    ):
        return None
    if arthur.binding != binding or maintenance.binding != binding:
        return None
    return binding


def _source_age_ms(observed_at: datetime, sources: tuple[datetime, ...]) -> int | None:
    ages: list[int] = []
    observed = _aware(observed_at, "projection observed_at")
    for source in sources:
        instant = _aware(source, "source observed_at")
        delta_ms = int((observed - instant).total_seconds() * 1000)
        if delta_ms < -_CLOCK_SKEW_MS:
            return None
        ages.append(max(0, delta_ms))
    return max(ages) if ages else None


def project_companion_status(
    *,
    marker: RuntimeMarker | None,
    writer: WriterObservation | None,
    runtime_generation: RuntimeGenerationRef | None,
    arthur: SafeArthurProjection | None,
    maintenance: MaintenanceProjection | None,
    observed_at: datetime,
    marker_observed_at: datetime | None = None,
    stale_after_ms: int = DEFAULT_STALE_AFTER_MS,
) -> dict[str, Any]:
    """Build one strict status projection from already-safe observations.

    Contradictory, incomplete, or generation-mismatched inputs produce an
    explicit unknown/stale document.  A fenced marker produces ``switching``.
    No input is read from disk by this function.
    """

    observed = _aware(observed_at, "projection observed_at")
    if type(stale_after_ms) is not int or stale_after_ms <= 0:
        raise CompanionStatusError("stale_after_ms must be a positive integer")
    if marker is None:
        return validate_companion_status(_unknown_document(observed, stale_after_ms))
    if (
        marker.status is RuntimeStatus.INACTIVE
        and marker.active_target is None
        and marker.transition_id is not None
    ):
        return validate_companion_status(
            _switching_document(marker, observed, stale_after_ms)
        )
    if any(item is None for item in (writer, runtime_generation, arthur, maintenance)):
        return validate_companion_status(_unknown_document(observed, stale_after_ms))

    assert writer is not None
    assert runtime_generation is not None
    assert arthur is not None
    assert maintenance is not None
    binding = _stable_sources_match(
        marker, writer, runtime_generation, arthur, maintenance
    )
    if binding is None:
        return validate_companion_status(_unknown_document(observed, stale_after_ms))
    # A stable marker can legitimately remain unchanged for days.  Freshness is
    # therefore the age of the *observation*, not the age of the last switch.
    # The fallback preserves the original pure-fixture API; live collectors
    # must always supply the time at which they re-read the marker.
    marker_time = (
        _aware(marker_observed_at, "marker observed_at")
        if marker_observed_at is not None
        else _parse_utc(marker.updated_at, "marker updated_at")
    )
    age_ms = _source_age_ms(
        observed,
        (marker_time, writer.observed_at, arthur.observed_at, maintenance.observed_at),
    )
    if age_ms is None:
        return validate_companion_status(_unknown_document(observed, stale_after_ms))
    document = {
        "schema_version": SCHEMA_VERSION,
        "observed_at": _timestamp(observed),
        "selection": {
            "phase": "stable",
            "host": binding.target,
            "generation": binding.generation,
            "runtime_generation_id": binding.runtime_generation_id,
            "transition_id": binding.transition_id,
        },
        "writers": {"state": "ACTIVE"},
        "arthur": {
            "availability": arthur.availability,
            "place": arthur.place,
            "pose": arthur.pose,
            "activity": {
                "key": arthur.activity_key,
                "type": arthur.activity_type,
                "resources": {
                    "hands": arthur.hands,
                    "mobility": arthur.mobility,
                    "body_locked": arthur.body_locked,
                },
            },
        },
        "maintenance": {"health": maintenance.health},
        "freshness": {
            "source_age_ms": age_ms,
            "stale_after_ms": stale_after_ms,
            "stale": age_ms >= stale_after_ms,
        },
    }
    if arthur.outfit != "unknown":
        # Only when known, so documents without one stay byte-identical.
        document["arthur"]["outfit"] = arthur.outfit
    if arthur.activity_detail != "unknown":
        document["arthur"]["activity"]["detail"] = arthur.activity_detail
    if arthur.weather_sky != "unknown" or arthur.weather_temp != "unknown":
        document["arthur"]["weather"] = {"sky": arthur.weather_sky, "temp": arthur.weather_temp}
    if arthur.letter != "none":
        document["arthur"]["letter"] = arthur.letter
    if arthur.letter_id is not None:
        document["arthur"]["letter_id"] = arthur.letter_id
    if arthur.fairies != "none":
        document["arthur"]["fairies"] = arthur.fairies
    return validate_companion_status(document)


def _exact_keys(value: object, expected: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CompanionStatusError(f"{label} must be an object")
    missing = expected - set(value)
    extra = set(value) - expected
    if missing or extra:
        raise CompanionStatusError(
            f"{label} fields mismatch; missing={sorted(missing)}, extra={sorted(extra)}"
        )
    return value


def validate_companion_status(document: Mapping[str, Any]) -> dict[str, Any]:
    """Strictly validate a projected document without aliases or defaults."""

    root = _exact_keys(
        document,
        {
            "schema_version",
            "observed_at",
            "selection",
            "writers",
            "arthur",
            "maintenance",
            "freshness",
        },
        "companion status",
    )
    if root["schema_version"] != SCHEMA_VERSION:
        raise CompanionStatusError("unsupported companion status schema")
    _parse_utc(root["observed_at"], "observed_at")

    selection = _exact_keys(
        root["selection"],
        {"phase", "host", "generation", "runtime_generation_id", "transition_id"},
        "selection",
    )
    phase = _enum(selection["phase"], PHASES, "selection phase")
    host = _enum(selection["host"], HOSTS, "selection host")
    generation = selection["generation"]
    if generation is not None and (type(generation) is not int or generation < 0):
        raise CompanionStatusError("selection generation must be a non-negative integer or null")
    runtime_generation_id = selection["runtime_generation_id"]
    if runtime_generation_id is not None and (
        not isinstance(runtime_generation_id, str)
        or not _SHA256.fullmatch(runtime_generation_id)
    ):
        raise CompanionStatusError("runtime_generation_id must be a SHA-256 or null")
    transition_id = selection["transition_id"]
    if transition_id is not None and (
        not isinstance(transition_id, str) or not _TRANSITION.fullmatch(transition_id)
    ):
        raise CompanionStatusError("transition_id is invalid")

    writers = _exact_keys(root["writers"], {"state"}, "writers")
    writer_state = _enum(writers["state"], WRITER_STATES, "writer state")

    arthur_raw = root["arthur"]
    optional = {"outfit", "weather", "letter", "letter_id", "fairies"}
    present = set(arthur_raw) & optional if isinstance(arthur_raw, Mapping) else set()
    arthur = _exact_keys(
        arthur_raw, {"availability", "place", "pose", "activity"} | present, "Arthur"
    )
    outfit = _enum(arthur["outfit"], OUTFITS, "outfit") if "outfit" in present else "unknown"
    if "weather" in present:
        weather = _exact_keys(arthur["weather"], {"sky", "temp"}, "weather")
        weather_sky = _enum(weather["sky"], WEATHER_SKIES, "weather sky")
        weather_temp = _enum(weather["temp"], WEATHER_TEMPS, "weather temperature")
    else:
        weather_sky = weather_temp = "unknown"
    letter = _enum(arthur["letter"], LETTERS, "letter") if "letter" in present else "none"
    fairies = _enum(arthur["fairies"], FAIRY_REGIONS, "fairies") if "fairies" in present else "none"
    if "letter_id" in present and (
        letter != "waiting" or not isinstance(arthur["letter_id"], str)
        or not _LETTER_ID.fullmatch(arthur["letter_id"])
    ):
        raise CompanionStatusError("letter_id needs a waiting letter and 12 hex digits")

    availability = _enum(arthur["availability"], AVAILABILITIES, "availability")
    place = _enum(arthur["place"], PLACES, "place")
    pose = _enum(arthur["pose"], POSES, "pose")
    activity_raw = arthur["activity"]
    if isinstance(activity_raw, Mapping) and "detail" in activity_raw:
        activity = _exact_keys(activity_raw, {"key", "type", "resources", "detail"}, "activity")
        activity_detail = _enum(activity["detail"], ACTIVITY_DETAILS, "activity detail")
    else:
        activity = _exact_keys(activity_raw, {"key", "type", "resources"}, "activity")
        activity_detail = "unknown"
    activity_key = _enum(activity["key"], ACTIVITY_KEYS, "activity key")
    activity_type = _enum(activity["type"], ACTIVITY_TYPES, "activity type")
    resources = _exact_keys(
        activity["resources"], {"hands", "mobility", "body_locked"}, "resources"
    )
    hands = _enum(resources["hands"], HANDS, "hands")
    mobility = _enum(resources["mobility"], MOBILITY, "mobility")
    body_locked = resources["body_locked"]
    if body_locked is not None and type(body_locked) is not bool:
        raise CompanionStatusError("body_locked must be boolean or null")

    maintenance = _exact_keys(root["maintenance"], {"health"}, "maintenance")
    maintenance_health = _enum(maintenance["health"], HEALTH, "maintenance health")
    freshness = _exact_keys(
        root["freshness"], {"source_age_ms", "stale_after_ms", "stale"}, "freshness"
    )
    source_age_ms = freshness["source_age_ms"]
    if source_age_ms is not None and (
        type(source_age_ms) is not int or source_age_ms < 0
    ):
        raise CompanionStatusError("source_age_ms must be a non-negative integer or null")
    stale_after_ms = freshness["stale_after_ms"]
    if type(stale_after_ms) is not int or stale_after_ms <= 0:
        raise CompanionStatusError("stale_after_ms must be a positive integer")
    if type(freshness["stale"]) is not bool:
        raise CompanionStatusError("stale must be boolean")
    expected_stale = source_age_ms is None or source_age_ms >= stale_after_ms
    if freshness["stale"] is not expected_stale:
        raise CompanionStatusError("stale must be derived from source_age_ms and stale_after_ms")

    unknown_facts = (
        availability == "unknown"
        and place == "unknown"
        and pose == "unknown"
        and activity_key == "unknown"
        and activity_type == "unknown"
        and hands == "unknown"
        and mobility == "unknown"
        and body_locked is None
        and outfit == "unknown"
        and activity_detail == "unknown"
        and weather_sky == "unknown"
        and weather_temp == "unknown"
        and letter == "none"
        and fairies == "none"
    )
    if phase == "stable":
        if (
            host not in {"mac", "vps"}
            or generation is None
            or runtime_generation_id is None
            or transition_id is None
            or writer_state != "ACTIVE"
        ):
            raise CompanionStatusError("stable selection requires a complete active binding")
    elif phase == "switching":
        if (
            host != "unknown"
            or generation is None
            or runtime_generation_id is not None
            or transition_id is None
            or writer_state == "ACTIVE"
            or not unknown_facts
            or maintenance_health != "unknown"
            or source_age_ms is not None
        ):
            raise CompanionStatusError("switching selection must expose no unbound life facts")
    else:
        if (
            host != "unknown"
            or any(item is not None for item in (generation, runtime_generation_id, transition_id))
            or writer_state == "ACTIVE"
            or not unknown_facts
            or maintenance_health != "unknown"
            or source_age_ms is not None
        ):
            raise CompanionStatusError("unknown selection must expose no unbound facts")
    if phase != "stable" and freshness["stale"] is not True:
        raise CompanionStatusError("non-stable selections must be stale")
    return dict(document)


__all__ = [
    "ACTIVITY_KEYS",
    "CompanionStatusError",
    "DEFAULT_STALE_AFTER_MS",
    "MaintenanceProjection",
    "OUTFITS",
    "ProjectionBinding",
    "SCHEMA_VERSION",
    "SafeArthurProjection",
    "WriterObservation",
    "project_companion_status",
    "validate_companion_status",
]
