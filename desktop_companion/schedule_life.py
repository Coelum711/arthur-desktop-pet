"""A mechanical day for Arthur, for running the desktop pet without the real one.

No language model and no decisions of his own: every ~45 minutes (one "run",
as the early Arthur daemon counted time) the next thing is drawn from weighted
tables for that part of the day, lasts a few runs, and costs some energy.
Evenings he gets tired and goes to bed with a rising probability; mornings he
wakes the same way.  Weather is drawn per three-hour block from British odds
(it rains a lot).  Now and then his fairy friends drop in.

The output is a dict shaped like the real Arthur's ``state.json`` (only the
fields the desktop status mapping reads), so the pet sees exactly what it
would see from him.  The life is kept in a small JSON file so it carries on
across restarts; time missed while the computer was off is caught up on (up
to two days).
"""

from __future__ import annotations

import json
import math
import os
import random
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

RUN_MINUTES = 45
MAX_CATCH_UP_RUNS = 64          # two days or so

# ── What he might be doing ─────────────────────────────────────────────────
# type: as the status mapping knows it; text: only for guitar/tea wording;
# runs: (min, max) runs it lasts; cost: energy per run (negative restores).
@dataclass(frozen=True)
class Activity:
    type: str
    text: str
    runs: tuple[int, int]
    cost: float
    outing: bool = False


ACTIVITIES: dict[str, Activity] = {
    "reading":   Activity("reading", "reading a book", (1, 3), 0.05),
    "tea":       Activity("tea", "making a pot of tea", (1, 1), -0.04),
    "guitar":    Activity("music", "playing the guitar", (1, 2), 0.03),
    "music":     Activity("music", "listening to records", (1, 2), 0.02),
    "cooking":   Activity("cooking", "cooking", (1, 2), 0.05),
    "garden":    Activity("garden", "seeing to the roses", (1, 3), 0.07),
    "writing":   Activity("writing", "writing", (1, 3), 0.10),
    "housework": Activity("domestic", "tidying the flat", (1, 2), 0.05),
    "occult":    Activity("occult", "an old grimoire", (1, 2), 0.08),
    "watching":  Activity("watching", "watching television", (1, 2), 0.03),
    "online":    Activity("online", "on his laptop", (1, 2), 0.06),
    "hobby":     Activity("hobby", "embroidery", (1, 2), 0.02),
    "rest":      Activity("rest", "resting", (1, 2), -0.08),
    "walk":      Activity("neighbourhood", "a walk", (1, 3), 0.06, outing=True),
    "park":      Activity("park", "the park", (2, 3), 0.05, outing=True),
    "museum":    Activity("museum", "a museum", (2, 4), 0.08, outing=True),
    "market":    Activity("market", "the market", (1, 3), 0.08, outing=True),
    "pub":       Activity("pub", "the pub", (2, 3), 0.06, outing=True),
}

# Weights by part of the day.  Weekends lean towards going out.
WEIGHTS: dict[str, dict[str, float]] = {
    "morning":   {"reading": 3, "tea": 3, "garden": 3, "housework": 2, "writing": 2, "online": 2,
                  "cooking": 1, "walk": 2, "market": 1, "hobby": 1},
    "midday":    {"cooking": 3, "reading": 2, "writing": 3, "online": 2, "garden": 2, "walk": 2,
                  "park": 1.5, "museum": 1, "market": 1, "occult": 1, "hobby": 1, "tea": 1},
    "afternoon": {"tea": 2, "reading": 3, "writing": 2, "garden": 2, "guitar": 1.5, "hobby": 2,
                  "occult": 1.5, "walk": 2, "park": 1.5, "museum": 1.5, "online": 1, "rest": 1},
    "evening":   {"cooking": 3, "reading": 3, "watching": 2, "guitar": 2, "music": 2, "hobby": 2,
                  "pub": 1.5, "online": 1, "rest": 1, "tea": 1},
    "late":      {"reading": 3, "music": 2, "guitar": 1.5, "occult": 2, "watching": 1, "rest": 2,
                  "writing": 1, "hobby": 1},
}
WEEKEND_OUTING_BOOST = 1.8

# British weather, per three-hour block: (description, weight).
SKIES = [("light rain", 30), ("drizzle", 8), ("overcast clouds", 30), ("broken clouds", 10),
         ("clear sky", 15), ("mist", 7)]
# Rough feels-like temperature by month (°C, mean): London-ish.
MONTH_TEMP = [4, 4, 6, 9, 12, 15, 18, 17, 15, 11, 7, 5]


def _part_of_day(hour: float) -> str:
    if 6 <= hour < 11:
        return "morning"
    if 11 <= hour < 14:
        return "midday"
    if 14 <= hour < 18:
        return "afternoon"
    if 18 <= hour < 22:
        return "evening"
    return "late"


def _sleep_chance(hour: float, energy: float) -> float:
    """Chance per run of going to bed (he's awake)."""
    if 6 <= hour < 21.5:
        # Worn out early: he rests and has tea instead; only when truly spent
        # in the evening does he turn in before half nine.
        return 0.1 if (energy < 0.03 and hour >= 20) else 0.0
    if 21.5 <= hour < 22:
        base = 0.1
    elif 22 <= hour < 23:
        base = 0.25
    elif 23 <= hour < 24:
        base = 0.5
    else:                      # small hours
        base = 0.8
    return min(0.95, base + max(0.0, 0.4 - energy))


def _wake_chance(hour: float) -> float:
    """Chance per run of getting up (he's asleep)."""
    if 6 <= hour < 7:
        return 0.2
    if 7 <= hour < 8:
        return 0.55
    if 8 <= hour < 12:
        return 0.9
    return 0.0


def _now_ts(now: datetime) -> float:
    return now.timestamp()


class ScheduleLife:
    """Arthur's mechanical day, kept in ``path``."""

    def __init__(self, path: Path, *, rng: random.Random | None = None):
        self.path = Path(path)
        self.rng = rng or random.Random()
        self.state = self._load()

    # ── persistence ────────────────────────────────────────────────────────
    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("version") == 1:
                return data
        except (OSError, ValueError):
            pass
        return {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".life-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(self.state, handle, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    # ── the day ────────────────────────────────────────────────────────────
    def _fresh(self, now: datetime) -> None:
        hour = now.hour + now.minute / 60
        asleep = hour >= 23.5 or hour < 7
        self.state = {
            "version": 1,
            "last_run_ts": _now_ts(now),
            "energy": 0.9,
            "asleep": asleep,
            "activity": None if asleep else "tea",
            "runs_left": 0 if asleep else 1,
            "last_activity": None,
            "transit_runs": 0,
            "weather": None,
            "fairy_ts": 0.0,
        }

    def _pick(self, at: datetime) -> str:
        hour = at.hour + at.minute / 60
        weights = dict(WEIGHTS[_part_of_day(hour)])
        weekend = at.weekday() >= 5
        energy = float(self.state.get("energy", 0.8))
        # Four o'clock is tea time.
        if 15.5 <= hour < 17:
            weights["tea"] = weights.get("tea", 0) + 6
        for name in list(weights):
            act = ACTIVITIES[name]
            if act.outing and weekend:
                weights[name] *= WEEKEND_OUTING_BOOST
            if act.outing and energy < 0.35:
                weights[name] *= 0.3
            if name == self.state.get("last_activity"):
                weights[name] *= 0.25            # not the same thing twice running
        if energy < 0.3:
            weights["rest"] = weights.get("rest", 0) + 3
            weights["tea"] = weights.get("tea", 0) + 2
        # Rain keeps him in a bit more.
        sky = (self.state.get("weather") or {}).get("description", "")
        if "rain" in sky or "drizzle" in sky:
            for name in weights:
                if ACTIVITIES[name].outing:
                    weights[name] *= 0.6
        names = list(weights)
        return self.rng.choices(names, weights=[weights[n] for n in names], k=1)[0]

    def _weather_for(self, at: datetime) -> dict[str, Any]:
        block = int(at.timestamp() // (3 * 3600))
        current = self.state.get("weather") or {}
        if current.get("block") == block:
            return current
        # Weather tends to persist: 55% it stays what it was.
        if current.get("description") and self.rng.random() < 0.55:
            desc = current["description"]
        else:
            desc = self.rng.choices([s for s, _ in SKIES], weights=[w for _, w in SKIES], k=1)[0]
        mean = MONTH_TEMP[at.month - 1]
        hour = at.hour
        diurnal = 3.5 * math.sin((hour - 9) / 24 * 2 * math.pi)
        feels = round(mean + diurnal + self.rng.gauss(0, 2.5) - (2 if "rain" in desc else 0), 1)
        return {"block": block, "description": desc, "feels_c": feels}

    def _run(self, at: datetime) -> None:
        s = self.state
        hour = at.hour + at.minute / 60
        s["weather"] = self._weather_for(at)
        if s["asleep"]:
            s["energy"] = min(1.0, float(s["energy"]) + 0.12)
            if self.rng.random() < _wake_chance(hour):
                s["asleep"] = False
                s["energy"] = max(float(s["energy"]), 0.85)
                s["activity"], s["runs_left"] = "tea", 1      # first thing: tea
            return
        if self.rng.random() < _sleep_chance(hour, float(s["energy"])):
            s["asleep"] = True
            s["activity"], s["runs_left"], s["transit_runs"] = None, 0, 0
            return
        # Walking back from an outing takes a run.
        if s.get("transit_runs"):
            s["transit_runs"] -= 1
            return
        s["runs_left"] = int(s.get("runs_left") or 0) - 1
        if s["runs_left"] <= 0 or not s.get("activity"):
            was = s.get("activity")
            was_out = bool(was and ACTIVITIES[was].outing)
            name = self._pick(at)
            now_out = ACTIVITIES[name].outing
            s["last_activity"] = was
            s["activity"] = name
            lo, hi = ACTIVITIES[name].runs
            s["runs_left"] = self.rng.randint(lo, hi)
            if was_out != now_out and self.rng.random() < 0.6:
                s["transit_runs"] = 1                       # on the way there or back (a short walk takes no time)
        act = ACTIVITIES[s["activity"]]
        s["energy"] = max(0.0, min(1.0, float(s["energy"]) - act.cost))
        # Fairies drop in now and then while he's at home and up.
        if not act.outing and self.rng.random() < 0.04:
            s["fairy_ts"] = at.timestamp()

    def advance(self, now: datetime | None = None) -> None:
        now = (now or datetime.now().astimezone()).astimezone()
        if not self.state:
            self._fresh(now)
        last = datetime.fromtimestamp(float(self.state["last_run_ts"])).astimezone()
        step = timedelta(minutes=RUN_MINUTES)
        runs = int((now - last) / step)
        if runs > MAX_CATCH_UP_RUNS:                        # long gap: start the day afresh
            self._fresh(now)
            runs = 0
        for i in range(runs):
            self._run(last + step * (i + 1))
        if runs:
            self.state["last_run_ts"] = (last + step * runs).timestamp()
        self._save()

    # ── what the pet reads ─────────────────────────────────────────────────
    def as_state(self, now: datetime | None = None) -> dict[str, Any]:
        """The real Arthur's state.json fields the status mapping uses."""
        now = (now or datetime.now().astimezone()).astimezone()
        s = self.state
        weather = s.get("weather") or {}
        out: dict[str, Any] = {
            "world_state": {"weather": {
                "as_of_ts": now.timestamp(),
                "description": weather.get("description", ""),
                "feels_c": weather.get("feels_c"),
            }} if weather else {},
        }
        if s.get("asleep"):
            out["sleep_state"] = "sleeping"
            out["current_activity_type"] = "sleep"
            out["current_activity"] = "asleep"
            return out
        if s.get("transit_runs"):
            out["current_activity_type"] = "transit"
            out["transit_state"] = "in_transit"
            out["current_activity"] = "on his way"
            return out
        act = ACTIVITIES.get(s.get("activity") or "rest", ACTIVITIES["rest"])
        out["current_activity_type"] = act.type
        out["current_activity"] = act.text
        if s.get("fairy_ts"):
            out["fairy_last_visit_ts"] = float(s["fairy_ts"])
        return out
