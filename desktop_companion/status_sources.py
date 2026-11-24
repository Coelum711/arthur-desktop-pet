"""Safe, generation-bound status sources for the Mac desktop companion.

The desktop never reads Arthur's state directly.  This module is the narrow
control-plane boundary that reduces a selected host to the reviewed
``arthur.companion-status/1`` document.  It performs no writes and never emits
raw activity text, mood, logs, paths, prompts, or message content.
"""

from __future__ import annotations

import hashlib
import json
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from vps_runtime.switch.adapters import HostActivity
from vps_runtime.switch.companion_status import (
    MaintenanceProjection,
    ProjectionBinding,
    SafeArthurProjection,
    WriterObservation,
    project_companion_status,
)
from vps_runtime.switch.generation_guard import read_binding
from vps_runtime.switch.host_probe import HostProbeResult, probe_mac, probe_vps
from vps_runtime.switch.runtime_generation import (
    RuntimeGenerationError,
    RuntimeGenerationRef,
    load_runtime_generation_document,
)
from vps_runtime.switch.state import ActiveTarget, RuntimeMarker, RuntimeStatus


MAX_JSON_BYTES = 8 * 1024 * 1024
LOCAL_PREVIEW_SCHEMA = "arthur.companion-local-preview/1"

_HOME_TYPES = frozenset(
    {
        "hobby",
        "garden",
        "writing",
        "cooking",
        "music",
        "organising",
        "occult",
        "domestic",
        "watching",
        "reading",
        "library",
        "online",
        "work",
        "rest",
        "stillness",
        "drinking_home",
    }
)
_OUTDOOR_TYPES = frozenset(
    {
        "city",
        "historic city",
        "seaside town",
        "neighbourhood",
        "museum",
        "gallery",
        "pub",
        "park",
        "market",
        "restaurant",
        "fishing",
    }
)
_EXERCISE_TYPES = frozenset({"exercise", "gym", "workout", "swimming"})
_BATHING_TYPES = frozenset({"bathing", "bath", "shower"})
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")


class StatusSourceError(RuntimeError):
    """A private source could not be reduced to a trustworthy safe fact."""


@dataclass(frozen=True, slots=True)
class CollectorPaths:
    host: str
    arthur_home: Path
    marker_path: Path
    binding_path: Path
    runtime_generation_path: Path
    sentinel_path: Path
    state_path: Path | None = None

    def __post_init__(self) -> None:
        if self.host not in {"mac", "vps"}:
            raise StatusSourceError("collector host must be mac or vps")
        for value in (
            self.arthur_home,
            self.marker_path,
            self.binding_path,
            self.runtime_generation_path,
            self.sentinel_path,
        ):
            if not value.is_absolute():
                raise StatusSourceError("collector paths must be absolute")
        if self.state_path is not None and not self.state_path.is_absolute():
            raise StatusSourceError("state_path must be absolute")

    @property
    def effective_state_path(self) -> Path:
        return self.state_path or self.arthur_home / "daemon" / "state.json"


def _read_object(path: Path, label: str) -> dict[str, Any]:
    try:
        mode = path.lstat().st_mode
        if not stat.S_ISREG(mode) or path.is_symlink():
            raise StatusSourceError(f"{label} is not a plain file")
        if stat.S_IMODE(mode) & 0o022:
            raise StatusSourceError(f"{label} is group/world writable")
        if path.stat().st_size > MAX_JSON_BYTES:
            raise StatusSourceError(f"{label} is too large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except StatusSourceError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StatusSourceError(f"{label} is unreadable") from exc
    if not isinstance(value, dict):
        raise StatusSourceError(f"{label} must be an object")
    return value


def _runtime_ref_from_vps_receipt(path: Path) -> RuntimeGenerationRef:
    receipt = _read_object(path, "VPS runtime generation receipt")
    # v4 (gen79+ upgrade lane) only adds content-layer fields; identity fields are unchanged.
    if receipt.get("schema_version") not in (3, 4) or receipt.get("active") is not False:
        raise StatusSourceError("VPS runtime generation receipt is not an inert assembly receipt")
    try:
        reference = RuntimeGenerationRef(
            runtime_generation_id=str(receipt["runtime_generation_id"]),
            transition_id=str(receipt["transition_id"]),
            source=str(receipt["source_host"]),
            target="vps",
            source_generation=int(receipt["source_generation"]),
            target_generation=int(receipt["target_generation"]),
            code_release_id=str(receipt["release_id"]),
            python_environment_id=str(receipt["python_environment_id"]),
            state_snapshot_id=str(receipt["state_files_digest"]),
            content_id=str(receipt["content_id"]),
            writer_inventory_sha256=str(receipt["writer_inventory_sha256"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise StatusSourceError("VPS runtime generation receipt is incomplete") from exc
    if (
        reference.source not in {"mac", "vps"}
        or reference.target != "vps"
        or type(reference.source_generation) is not int
        or type(reference.target_generation) is not int
        or reference.target_generation <= reference.source_generation
        or not _COMMIT.fullmatch(reference.code_release_id)
        or not isinstance(reference.python_environment_id, str)
        or not _SHA256.fullmatch(reference.python_environment_id)
        or any(
            not _SHA256.fullmatch(value)
            for value in (
                reference.runtime_generation_id,
                reference.state_snapshot_id,
                reference.content_id,
                reference.writer_inventory_sha256,
            )
        )
    ):
        raise StatusSourceError("VPS runtime generation receipt identity is invalid")
    return reference


def _load_runtime_ref(paths: CollectorPaths) -> RuntimeGenerationRef:
    if paths.host == "mac":
        try:
            return RuntimeGenerationRef.from_document(
                load_runtime_generation_document(paths.runtime_generation_path)
            )
        except RuntimeGenerationError as exc:
            raise StatusSourceError("Mac runtime generation is invalid") from exc
    return _runtime_ref_from_vps_receipt(paths.runtime_generation_path)


def _safe_activity(state: Mapping[str, Any]) -> tuple[str, str, str, str, bool | None]:
    sleep_state = str(state.get("sleep_state") or "").strip().lower()
    activity_type = str(state.get("current_activity_type") or "").strip().lower()
    activity_text = str(state.get("current_activity") or "").strip().lower()
    transit = str(state.get("transit_state") or "").strip().lower()
    away = bool(str(state.get("overnight_away") or "").strip())

    if sleep_state == "sleeping" or activity_type == "sleep":
        return "sleeping", "sleep", "none", "stationary", True
    if sleep_state == "unconscious":
        return "unknown", "sleep", "none", "stationary", True
    if transit == "in_transit" or activity_type == "transit":
        return "outdoors", "transit", "none", "mobile", False
    if activity_type in {"reading", "library", "studying", "study", "research"}:
        return "reading", "home" if not away else "hotel", "both", "stationary", False
    if activity_type in {"tea", "coffee"} or (
        activity_type in {"cooking", "domestic"} and "tea" in activity_text
    ):
        return "tea", "home" if not away else "hotel", "right", "stationary", False
    if activity_type in {"guitar", "music"} and "guitar" in activity_text:
        return "guitar", "home" if not away else "hotel", "both", "stationary", False
    if activity_type in _EXERCISE_TYPES:
        return "learned_activity", "exercise", "both", "mobile", True
    if activity_type in _BATHING_TYPES:
        return "learned_activity", "bathing", "both", "stationary", True
    if activity_type == "hotel":
        return "learned_activity", "hotel", "unknown", "stationary", None
    if activity_type in _OUTDOOR_TYPES or away:
        return "outdoors", "outdoors", "none", "mobile", False
    if activity_type in _HOME_TYPES:
        return "learned_activity", "home", "unknown", "stationary", None
    return "unknown", "unknown", "unknown", "unknown", None


# One step finer than the activity key, from his activity *type* only (never
# the free-text description).  Only for keys that otherwise say nothing
# specific; reading/tea/guitar/sleeping already name themselves.
_DETAIL_BY_TYPE = {
    "cooking": "cooking",
    "garden": "garden",
    "writing": "writing",
    "music": "music",
    "domestic": "housework",
    "organising": "housework",
    "occult": "occult",
    "watching": "watching",
    "online": "online",
    "work": "work",
    "rest": "resting",
    "stillness": "resting",
    "drinking_home": "drinking",
    "hobby": "hobby",
    "pub": "pub",
    "museum": "museum",
    "gallery": "museum",
    "park": "park",
    "market": "market",
    "restaurant": "eating_out",
    "city": "walking",
    "historic city": "walking",
    "seaside town": "walking",
    "neighbourhood": "walking",
    "fishing": "fishing",
    **{t: "exercise" for t in _EXERCISE_TYPES},
    **{t: "bathing" for t in _BATHING_TYPES},
}


def _activity_detail(state: Mapping[str, Any], key: str) -> str:
    if key not in {"learned_activity", "outdoors"}:
        return "unknown"
    if str(state.get("transit_state") or "").strip().lower() == "in_transit":
        return "unknown"
    activity_type = str(state.get("current_activity_type") or "").strip().lower()
    return _DETAIL_BY_TYPE.get(activity_type, "unknown")


# Seconds a message from him counts as "waiting" if she hasn't written since.
_LETTER_WINDOW_S = 72 * 3600
# Weather data older than this says nothing reliable about now.
_WEATHER_MAX_AGE_S = 3 * 3600


def _weather(state: Mapping[str, Any], now: datetime) -> tuple[str, str]:
    world = state.get("world_state")
    weather = world.get("weather") if isinstance(world, Mapping) else None
    if not isinstance(weather, Mapping):
        return "unknown", "unknown"
    as_of = weather.get("as_of_ts")
    if not isinstance(as_of, (int, float)) or not 0 <= now.timestamp() - as_of <= _WEATHER_MAX_AGE_S:
        return "unknown", "unknown"
    desc = str(weather.get("description") or "").lower()
    if any(w in desc for w in ("rain", "drizzle", "shower", "sleet", "storm", "thunder")):
        sky = "rain"
    elif any(w in desc for w in ("snow", "blizzard", "flurr")):
        sky = "snow"
    elif any(w in desc for w in ("fog", "mist", "haze")):
        sky = "fog"
    elif any(w in desc for w in ("cloud", "overcast")):
        sky = "cloud"
    elif desc:
        sky = "clear"
    else:
        sky = "unknown"
    feels = weather.get("feels_c", weather.get("temp_c"))
    if not isinstance(feels, (int, float)):
        temp = "unknown"
    elif feels <= 0:
        temp = "freezing"
    elif feels < 8:
        temp = "cold"
    elif feels < 20:
        temp = "mild"
    elif feels < 26:
        temp = "warm"
    else:
        temp = "hot"
    return sky, temp


def _letter(state: Mapping[str, Any], now: datetime) -> tuple[str, str | None]:
    """A message from him she hasn't answered yet, plus an opaque id for it.

    Telegram can't tell anyone whether she has read it; the desktop pet lets
    her mark it read by id.  Writing back counts as read too."""
    sent = state.get("last_message_ts")
    heard = state.get("last_emily_message_ts") or 0
    if not isinstance(sent, (int, float)) or not isinstance(heard, (int, float)):
        return "none", None
    age = now.timestamp() - sent
    if not (sent > heard and 0 <= age <= _LETTER_WINDOW_S):
        return "none", None
    return "waiting", hashlib.sha256(f"letter:{sent!r}".encode()).hexdigest()[:12]


# A fairy visit (state["fairy_last_visit_ts"], set by the daemon's visit event)
# counts as "now" for about one life tick.
_FAIRY_VISIT_WINDOW_S = 50 * 60
# The same regions the daemon uses to decide which local creatures turn up.
_FAIRY_REGION_WORDS = (
    ("scotland", ("edinburgh", "glasgow", "inverness", "aberdeen", "dundee", "stirling", "perth")),
    ("wales", ("cardiff", "swansea", "newport", "bangor", "wrexham")),
    ("westcountry", ("bath", "bristol", "exeter", "plymouth", "truro", "penzance", "cornwall")),
)


def _fairies(state: Mapping[str, Any], now: datetime) -> str:
    visited = state.get("fairy_last_visit_ts")
    if not isinstance(visited, (int, float)) or not 0 <= now.timestamp() - visited <= _FAIRY_VISIT_WINDOW_S:
        return "none"
    if str(state.get("sleep_state") or "").strip().lower() == "sleeping":
        return "none"
    away = str(state.get("overnight_away") or "").strip().lower()
    if not away:
        return "home"
    for region, words in _FAIRY_REGION_WORDS:
        if any(word in away for word in words):
            return region
    return "england"


# His own trip-prep words (state["carried_for_outing"]["items"]) mapped to
# the pet's wardrobe.  Only the category leaves this host.  First match wins;
# nothing recognised means "unknown" (the pet then dresses by place).
_OUTFIT_WORDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("pirate", re.compile(r"\b(pirate|captain'?s (coat|hat)|tricorn)", re.I)),
    ("punk", re.compile(r"\b(punk|leather jacket|studded|safety pins?|bondage trousers)", re.I)),
    ("dress", re.compile(r"\b(dress uniform|regimentals?|tunic|red coat|ceremonial|sash)", re.I)),
    ("city", re.compile(r"\b(bowler|pinstripe|three-piece|suit)\b", re.I)),
    ("jumper", re.compile(r"\bchristmas (jumper|sweater)", re.I)),
    ("tweed", re.compile(r"\b(tweed|blazer|sports? jacket|waistcoat)", re.I)),
    ("raincoat", re.compile(r"\b(raincoat|mac|mackintosh|waterproof|trench ?coat|burberry)\b", re.I)),
    ("coat", re.compile(r"\b(coat|overcoat|greatcoat|duffel|peacoat|scarf)\b", re.I)),
)
_PLAIN_JUMPER = re.compile(r"\b(jumper|sweater|pullover|cardigan|knit)\b", re.I)


def _outfit_hint(state: Mapping[str, Any], place: str, now: datetime) -> str:
    if place not in {"outdoors", "transit", "hotel"}:
        return "unknown"
    record = state.get("carried_for_outing")
    items = record.get("items") if isinstance(record, Mapping) else None
    if not isinstance(items, list):
        return "unknown"
    text = " ; ".join(str(item) for item in items[:20] if isinstance(item, str))[:2000]
    for outfit, pattern in _OUTFIT_WORDS:
        if pattern.search(text):
            return outfit
    # A plain jumper only reads as the Christmas one in the festive weeks.
    local = now.astimezone()
    festive = (local.month == 12) or (local.month == 1 and local.day <= 6)
    if festive and _PLAIN_JUMPER.search(text):
        return "jumper"
    return "unknown"


def _safe_arthur(
    state: Mapping[str, Any], binding: ProjectionBinding, observed_at: datetime
) -> SafeArthurProjection:
    key, activity_type, hands, mobility, body_locked = _safe_activity(state)
    sleep_state = str(state.get("sleep_state") or "").strip().lower()
    availability = "sleeping" if sleep_state == "sleeping" else "unknown" if sleep_state == "unconscious" else "awake"
    if activity_type == "transit":
        place = "transit"
    elif activity_type == "hotel" or bool(str(state.get("overnight_away") or "").strip()):
        place = "hotel"
    elif activity_type == "outdoors":
        place = "outdoors"
    elif activity_type == "home":
        place = "home"
    else:
        place = "unknown"
    pose = {
        "sleeping": "sleeping",
        "reading": "reading",
        "tea": "tea",
        "outdoors": "outdoors",
    }.get(key, "awake" if availability == "awake" else "unknown")
    return SafeArthurProjection(
        observed_at,
        binding,
        availability=availability,
        place=place,
        pose=pose,
        activity_key=key,
        activity_type=activity_type,
        hands=hands,
        mobility=mobility,
        body_locked=body_locked,
        outfit=_outfit_hint(state, place, observed_at),
        activity_detail=_activity_detail(state, key),
        weather_sky=_weather(state, observed_at)[0],
        weather_temp=_weather(state, observed_at)[1],
        letter=_letter(state, observed_at)[0],
        letter_id=_letter(state, observed_at)[1],
        fairies=_fairies(state, observed_at),
    )


def _maintenance_health(report: Mapping[str, Any]) -> str:
    if type(report.get("any_problem")) is not bool:
        return "unknown"
    return "degraded" if report["any_problem"] else "healthy"


Probe = Callable[[], HostProbeResult]


class HostStatusCollector:
    """Collect one host without choosing or mutating a runtime."""

    def __init__(self, paths: CollectorPaths, *, probe: Probe | None = None):
        self.paths = paths
        self.probe = probe or (probe_mac if paths.host == "mac" else probe_vps)

    def collect(
        self,
        *,
        observed_at: datetime | None = None,
        marker_override: RuntimeMarker | None = None,
    ) -> dict[str, Any]:
        now = (observed_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
        try:
            marker = marker_override or RuntimeMarker.from_mapping(
                _read_object(self.paths.marker_path, "runtime marker")
            )
        except Exception:
            marker = None
        if marker is None:
            return project_companion_status(
                marker=None,
                writer=None,
                runtime_generation=None,
                arthur=None,
                maintenance=None,
                observed_at=now,
            )
        if marker.active_target is None:
            return project_companion_status(
                marker=marker,
                writer=None,
                runtime_generation=None,
                arthur=None,
                maintenance=None,
                observed_at=now,
            )
        if marker.active_target.value != self.paths.host:
            return project_companion_status(
                marker=marker,
                writer=None,
                runtime_generation=None,
                arthur=None,
                maintenance=None,
                observed_at=now,
            )
        try:
            binding = read_binding(self.paths.binding_path)
            runtime = _load_runtime_ref(self.paths)
            if (
                binding.target != self.paths.host
                or binding.generation != marker.generation
                or binding.transition_id != marker.transition_id
                or binding.writer_inventory_sha256 != runtime.writer_inventory_sha256
                or binding.release_id != runtime.code_release_id
            ):
                raise StatusSourceError("generation sources disagree")
            projection_binding = ProjectionBinding(
                self.paths.host,
                marker.generation,
                binding.transition_id,
                runtime.runtime_generation_id,
            )
            state = _read_object(self.paths.effective_state_path, "Arthur state")
            try:
                sentinel = _read_object(self.paths.sentinel_path, "sentinel report")
                health = _maintenance_health(sentinel)
            except StatusSourceError:
                health = "unknown"
            probe = self.probe()
            writer = WriterObservation(now, probe)
            arthur = _safe_arthur(state, projection_binding, now)
            maintenance = MaintenanceProjection(
                now, projection_binding, health
            )
        except Exception:
            return project_companion_status(
                marker=marker,
                writer=None,
                runtime_generation=None,
                arthur=None,
                maintenance=None,
                observed_at=now,
            )
        return project_companion_status(
            marker=marker,
            marker_observed_at=now,
            writer=writer,
            runtime_generation=runtime,
            arthur=arthur,
            maintenance=maintenance,
            observed_at=now,
        )

    def collect_legacy_mac_preview(
        self,
        marker: RuntimeMarker,
        *,
        observed_at: datetime | None = None,
    ) -> dict[str, Any] | None:
        """Locally display generation-zero Mac life facts without write authority."""

        if self.paths.host != "mac" or not (
            marker.status is RuntimeStatus.INACTIVE
            and marker.active_target is ActiveTarget.MAC
            and marker.generation == 0
            and marker.transition_id is None
        ):
            return None
        now = (observed_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
        try:
            probe = self.probe()
            if probe.activity is not HostActivity.ACTIVE or probe.sealed_violations:
                return None
            state = _read_object(self.paths.effective_state_path, "Arthur state")
            try:
                sentinel = _read_object(self.paths.sentinel_path, "sentinel report")
                health = _maintenance_health(sentinel)
            except StatusSourceError:
                health = "unknown"
            placeholder = ProjectionBinding("mac", 0, "switch-to-mac-legacy00", "0" * 64)
            facts = _safe_arthur(state, placeholder, now)
        except Exception:
            return None
        return {
            "schema_version": LOCAL_PREVIEW_SCHEMA,
            "observed_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "host": "mac",
            "mode": "legacy-generation-zero",
            "writers": {"state": "ACTIVE"},
            "arthur": {
                "availability": facts.availability,
                "place": facts.place,
                "pose": facts.pose,
                "activity": {
                    "key": facts.activity_key,
                    "type": facts.activity_type,
                    "resources": {
                        "hands": facts.hands,
                        "mobility": facts.mobility,
                        "body_locked": facts.body_locked,
                    },
                },
            },
            "maintenance": {"health": health},
            "can_drive_visual": True,
            "can_propose": False,
        }


__all__ = [
    "CollectorPaths",
    "HostStatusCollector",
    "LOCAL_PREVIEW_SCHEMA",
    "StatusSourceError",
]
