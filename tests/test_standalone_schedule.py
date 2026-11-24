import random
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from desktop_companion.schedule_life import ACTIVITIES, ScheduleLife
from desktop_companion.standalone import _static, status_document, WEB_ROOT


class ScheduleLifeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "life.json"

    def tearDown(self):
        self.dir.cleanup()

    def test_every_document_in_a_fortnight_is_valid(self):
        life = ScheduleLife(self.path, rng=random.Random(3))
        t = datetime(2026, 11, 23, 8, 0).astimezone()
        seen = set()
        for _ in range(14 * 24 * 2):
            t += timedelta(minutes=30)
            doc = status_document(life, t)          # validates or raises
            arthur = doc["arthur"]
            seen.add((arthur["availability"], arthur["place"]))
        self.assertIn(("sleeping", "unknown"), seen)
        self.assertIn(("awake", "home"), seen)
        self.assertIn(("awake", "outdoors"), seen)

    def test_he_sleeps_at_night_and_is_up_by_mid_morning(self):
        life = ScheduleLife(self.path, rng=random.Random(5))
        t = datetime(2026, 11, 23, 8, 0).astimezone()
        night = day = 0
        for _ in range(10 * 24 * 4):
            t += timedelta(minutes=15)
            asleep = status_document(life, t)["arthur"]["availability"] == "sleeping"
            if t.hour == 3:
                night += asleep
            if t.hour == 11:
                day += asleep
        self.assertGreater(night, 30)      # asleep at 3 am nearly every night
        self.assertEqual(day, 0)           # never still in bed at 11

    def test_life_carries_on_across_restarts(self):
        t = datetime(2026, 11, 23, 10, 0).astimezone()
        first = ScheduleLife(self.path, rng=random.Random(1))
        first.advance(t)
        first.advance(t + timedelta(hours=3))
        saved = dict(first.state)
        again = ScheduleLife(self.path, rng=random.Random(1))
        self.assertEqual(again.state["last_run_ts"], saved["last_run_ts"])
        self.assertEqual(again.state["activity"], saved["activity"])

    def test_a_long_absence_starts_the_day_afresh(self):
        life = ScheduleLife(self.path, rng=random.Random(2))
        t = datetime(2026, 11, 23, 10, 0).astimezone()
        life.advance(t)
        later = t + timedelta(days=10)
        life.advance(later)
        self.assertAlmostEqual(life.state["last_run_ts"], later.timestamp(), delta=1)

    def test_activity_types_are_ones_the_pet_understands(self):
        from desktop_companion.status_sources import _HOME_TYPES, _OUTDOOR_TYPES
        for name, act in ACTIVITIES.items():
            if name == "tea":
                continue                       # tea names itself
            pool = _OUTDOOR_TYPES if act.outing else _HOME_TYPES
            self.assertIn(act.type, pool, name)

    def test_static_files_stay_inside_the_web_root(self):
        self.assertIsNotNone(_static("/", WEB_ROOT))
        self.assertIsNone(_static("/../server.py", WEB_ROOT))
        self.assertIsNone(_static("/%2e%2e/server.py", WEB_ROOT))


if __name__ == "__main__":
    unittest.main()
