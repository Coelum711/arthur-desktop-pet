from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from desktop_companion.status_sources import CollectorPaths, HostStatusCollector
from vps_runtime.switch.adapters import HostActivity
from vps_runtime.switch.host_probe import HostProbeResult
from vps_runtime.switch.runtime_generation import build_runtime_generation_document
from vps_runtime.switch.state import ActiveTarget, RuntimeMarker, RuntimeStatus


UTC = timezone.utc
RELEASE = "d" * 40
INVENTORY = "2" * 64
STATE_ID = "f" * 64
CONTENT_ID = "1" * 64
ENVIRONMENT = "e" * 64


def _write(path: Path, value: dict, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(path, mode)


def _marker(target: str, generation: int, transition: str, updated_at: str) -> dict:
    return RuntimeMarker(
        1,
        "vps",
        RuntimeStatus.INACTIVE if target == "mac" else RuntimeStatus.ACTIVE,
        ActiveTarget(target),
        generation,
        transition,
        updated_at,
        "desktop status fixture",
    ).to_mapping()


def _binding(target: str, generation: int, transition: str) -> dict:
    return {
        "schema_version": 1,
        "target": target,
        "generation": generation,
        "transition_id": transition,
        "marker_path": "/private/tmp/runtime.json" if target == "mac" else "/var/lib/arthur-switch/runtime.json",
        "writer_inventory_sha256": INVENTORY,
        "release_id": RELEASE,
        "issued_at": "2026-08-11T12:00:00Z",
    }


def _runtime(target: str, generation: int, transition: str) -> dict:
    return build_runtime_generation_document(
        code_release_manifest={"schema_version": 1, "release_id": RELEASE},
        state_snapshot_manifest={
            "schema_version": 1,
            "source": "vps" if target == "mac" else "mac",
            "generation": generation - 1,
            "files_sha256": STATE_ID,
            "code_commit": RELEASE,
        },
        content_manifest={"schema_version": 2, "content_id": CONTENT_ID},
        transition_id=transition,
        target=target,
        target_generation=generation,
        writer_inventory_sha256=INVENTORY,
        python_environment_id=ENVIRONMENT if target == "vps" else None,
        created_at="2026-08-11T12:00:00Z",
    )


class DesktopCompanionStatusSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "Arthur"
        self.state = self.home / "daemon" / "state.json"
        self.marker = self.root / "switch" / "runtime.json"
        self.binding = self.root / "switch" / "active-generation.json"
        self.runtime = self.root / "switch" / "runtime-generation.json"
        self.sentinel = self.root / "sentinel.json"

    def tearDown(self):
        self.temporary.cleanup()

    def _collector(self, target="mac", generation=8, transition="switch-to-mac-live008", receipt_schema=3):
        _write(self.marker, _marker(target, generation, transition, "2026-08-01T12:00:00Z"))
        _write(self.binding, _binding(target, generation, transition))
        runtime = _runtime(target, generation, transition)
        if target == "mac":
            _write(self.runtime, runtime)
        else:
            _write(
                self.runtime,
                {
                    "schema_version": receipt_schema,
                    "active": False,
                    "runtime_generation_id": runtime["runtime_generation_id"],
                    "transition_id": transition,
                    "source_host": "mac",
                    "source_generation": generation - 1,
                    "target_generation": generation,
                    "release_id": RELEASE,
                    "python_environment_id": ENVIRONMENT,
                    "state_files_digest": STATE_ID,
                    "content_id": CONTENT_ID,
                    "writer_inventory_sha256": INVENTORY,
                },
            )
        _write(
            self.state,
            {
                "sleep_state": "",
                "transit_state": "",
                "overnight_away": "",
                "current_activity_type": "reading",
                "current_activity": "PRIVATE paper title must never leave this source",
            },
        )
        _write(self.sentinel, {"any_problem": False, "results": []})
        probe = HostProbeResult(
            host=target,
            activity=HostActivity.ACTIVE,
            detail="synthetic active writers",
            inventory_sha256=INVENTORY,
            binding_valid=True,
            bound_target=target,
            bound_generation=generation,
            bound_transition_id=transition,
            binding_detail="synthetic current binding",
        )
        return HostStatusCollector(
            CollectorPaths(
                target,
                self.home,
                self.marker,
                self.binding,
                self.runtime,
                self.sentinel,
                self.state,
            ),
            probe=lambda: probe,
        )

    def test_long_lived_mac_marker_produces_fresh_safe_status(self):
        collector = self._collector()
        status = collector.collect(observed_at=datetime(2026, 8, 13, 12, tzinfo=UTC))
        self.assertEqual(status["selection"]["phase"], "stable")
        self.assertEqual(status["selection"]["host"], "mac")
        self.assertFalse(status["freshness"]["stale"])
        self.assertEqual(status["arthur"]["pose"], "reading")
        self.assertEqual(status["arthur"]["activity"]["resources"]["hands"], "both")
        self.assertNotIn("PRIVATE", json.dumps(status))

    def test_vps_assembly_receipt_produces_same_contract(self):
        collector = self._collector("vps", 9, "switch-to-vps-live009")
        status = collector.collect(observed_at=datetime(2026, 8, 13, 12, tzinfo=UTC))
        self.assertEqual(status["selection"]["phase"], "stable")
        self.assertEqual(status["selection"]["host"], "vps")
        self.assertEqual(status["maintenance"]["health"], "healthy")

    def test_upgrade_lane_v4_receipt_produces_stable_vps_status(self):
        # gen79+ VPS-local upgrades write schema-4 receipts and
        # switch-upgrade-vps-* transition ids; both must still project.
        transition = "switch-upgrade-vps-20261121t2132z-1eedadf"
        collector = self._collector("vps", 9, transition, receipt_schema=4)
        status = collector.collect(observed_at=datetime(2026, 8, 3, 12, tzinfo=timezone.utc))
        self.assertEqual(status["selection"]["phase"], "stable")
        self.assertEqual(status["selection"]["host"], "vps")
        self.assertEqual(status["selection"]["transition_id"], transition)
        self.assertEqual(status["arthur"]["activity"]["key"], "reading")

    def _with_state(self, extra):
        state = json.loads(self.state.read_text(encoding="utf-8"))
        state.update(extra)
        _write(self.state, state)

    def test_outing_outfit_is_a_category_from_his_own_prep_words(self):
        collector = self._collector("vps", 9, "switch-upgrade-vps-20261121t2132z-1eedadf", receipt_schema=4)
        when = datetime(2026, 8, 3, 12, tzinfo=timezone.utc)
        cases = [
            (["my good coat", "phone"], "coat"),
            (["the old mac, it'll rain"], "raincoat"),
            (["tweed jacket"], "tweed"),
            (["pinstripe suit", "bowler"], "city"),
            (["my captain's coat, don't ask"], "pirate"),
            (["phone", "wallet"], "unknown"),
            (["a jumper"], "unknown"),  # plain jumper is festive-only
        ]
        for items, expected in cases:
            with self.subTest(items=items):
                self._with_state({"current_activity_type": "city", "current_activity": "walking about",
                                  "carried_for_outing": {"items": items}})
                status = collector.collect(observed_at=when)
                self.assertEqual(status["arthur"].get("outfit", "unknown"), expected)
                self.assertNotIn(items[0], json.dumps(status))
        december = datetime(2026, 12, 10, 12, tzinfo=timezone.utc)
        self._with_state({"carried_for_outing": {"items": ["a warm jumper"]}})
        self.assertEqual(collector.collect(observed_at=december)["arthur"]["outfit"], "jumper")

    def test_outing_outfit_is_not_shown_at_home(self):
        collector = self._collector("vps", 9, "switch-upgrade-vps-20261121t2132z-1eedadf", receipt_schema=4)
        self._with_state({"current_activity_type": "reading", "carried_for_outing": {"items": ["coat"]}})
        status = collector.collect(observed_at=datetime(2026, 8, 3, 12, tzinfo=timezone.utc))
        self.assertEqual(status["arthur"]["place"], "home")
        self.assertNotIn("outfit", status["arthur"])

    def test_activity_detail_is_a_category_from_the_type_never_his_words(self):
        collector = self._collector("vps", 9, "switch-upgrade-vps-20261121t2132z-1eedadf", receipt_schema=4)
        when = datetime(2026, 8, 3, 12, tzinfo=timezone.utc)
        cases = [
            ("writing", "writing in his journal about Pedro", "learned_activity", "writing"),
            ("cooking", "a secret shepherd's pie", "learned_activity", "cooking"),
            ("stillness", "staring at the rain", "learned_activity", "resting"),
            ("domestic", "scrubbing the kitchen", "learned_activity", "housework"),
            ("pub", "a pint at the Lamb", "outdoors", "pub"),
            ("gallery", "the Turner rooms", "outdoors", "museum"),
            ("reading", "a novel", "reading", None),
            ("something_new", "who knows", "unknown", None),
        ]
        for activity_type, text, key, detail in cases:
            with self.subTest(activity_type=activity_type):
                self._with_state({"current_activity_type": activity_type, "current_activity": text})
                status = collector.collect(observed_at=when)
                self.assertEqual(status["arthur"]["activity"]["key"], key)
                self.assertEqual(status["arthur"]["activity"].get("detail"), detail)
                self.assertNotIn(text, json.dumps(status))
        self._with_state({"current_activity_type": "pub", "transit_state": "in_transit"})
        self.assertNotIn("detail", collector.collect(observed_at=when)["arthur"]["activity"])

    def test_weather_where_he_is_as_coarse_categories(self):
        collector = self._collector("vps", 9, "switch-upgrade-vps-20261121t2132z-1eedadf", receipt_schema=4)
        when = datetime(2026, 11, 23, 16, tzinfo=timezone.utc)
        fresh = when.timestamp() - 600
        cases = [
            ({"description": "light rain", "feels_c": 6.0}, {"sky": "rain", "temp": "cold"}),
            ({"description": "clear sky", "feels_c": -2.0}, {"sky": "clear", "temp": "freezing"}),
            ({"description": "overcast clouds", "temp_c": 22.0}, {"sky": "cloud", "temp": "warm"}),
        ]
        for weather, expected in cases:
            with self.subTest(weather=weather):
                self._with_state({"world_state": {"weather": {**weather, "as_of_ts": fresh, "city": "Bath"}}})
                status = collector.collect(observed_at=when)
                self.assertEqual(status["arthur"]["weather"], expected)
                self.assertNotIn("Bath", json.dumps(status))
        self._with_state({"world_state": {"weather": {"description": "rain", "feels_c": 5, "as_of_ts": fresh - 5 * 3600}}})
        self.assertNotIn("weather", collector.collect(observed_at=when)["arthur"])

    def test_letter_waits_until_she_writes_back_or_three_days_pass(self):
        collector = self._collector("vps", 9, "switch-upgrade-vps-20261121t2132z-1eedadf", receipt_schema=4)
        when = datetime(2026, 11, 23, 16, tzinfo=timezone.utc)
        now = when.timestamp()
        self._with_state({"last_message_ts": now - 3600, "last_emily_message_ts": now - 7200})
        first = collector.collect(observed_at=when)["arthur"]
        self.assertEqual(first["letter"], "waiting")
        self.assertRegex(first["letter_id"], r"^[0-9a-f]{12}$")
        self._with_state({"last_message_ts": now - 1800})
        self.assertNotEqual(collector.collect(observed_at=when)["arthur"]["letter_id"], first["letter_id"])
        self._with_state({"last_message_ts": now - 50 * 3600, "last_emily_message_ts": now - 60 * 3600})
        self.assertEqual(collector.collect(observed_at=when)["arthur"]["letter"], "waiting")
        self._with_state({"last_message_ts": now - 3600, "last_emily_message_ts": now - 60})
        self.assertNotIn("letter", collector.collect(observed_at=when)["arthur"])
        self._with_state({"last_message_ts": now - 80 * 3600, "last_emily_message_ts": now - 90 * 3600})
        self.assertNotIn("letter", collector.collect(observed_at=when)["arthur"])

    def test_fairy_visit_is_a_region_for_about_one_tick(self):
        collector = self._collector("vps", 9, "switch-upgrade-vps-20261121t2132z-1eedadf", receipt_schema=4)
        when = datetime(2026, 11, 23, 16, tzinfo=timezone.utc)
        now = when.timestamp()
        self._with_state({"fairy_last_visit_ts": now - 600})
        self.assertEqual(collector.collect(observed_at=when)["arthur"]["fairies"], "home")
        for city, region in (("Edinburgh", "scotland"), ("Cardiff", "wales"), ("Bath", "westcountry"), ("York", "england")):
            with self.subTest(city=city):
                self._with_state({"overnight_away": city})
                status = collector.collect(observed_at=when)
                self.assertEqual(status["arthur"]["fairies"], region)
                self.assertNotIn(city, json.dumps(status))
        self._with_state({"overnight_away": "", "fairy_last_visit_ts": now - 3 * 3600})
        self.assertNotIn("fairies", collector.collect(observed_at=when)["arthur"])

    def test_generation_mismatch_fails_closed_without_life_facts(self):
        collector = self._collector()
        value = _binding("mac", 9, "switch-to-mac-live009")
        _write(self.binding, value)
        status = collector.collect(observed_at=datetime(2026, 8, 13, 12, tzinfo=UTC))
        self.assertEqual(status["selection"]["phase"], "unknown")
        self.assertEqual(status["arthur"]["activity"]["key"], "unknown")

    def test_legacy_generation_zero_is_local_visual_only(self):
        transition = "switch-to-mac-live008"
        collector = self._collector("mac", 8, transition)
        marker = RuntimeMarker(
            1,
            "vps",
            RuntimeStatus.INACTIVE,
            ActiveTarget.MAC,
            0,
            None,
            "2026-08-11T12:00:00Z",
            "legacy Mac adoption",
        )
        preview = collector.collect_legacy_mac_preview(
            marker, observed_at=datetime(2026, 8, 13, 12, tzinfo=UTC)
        )
        self.assertIsNotNone(preview)
        assert preview is not None
        self.assertTrue(preview["can_drive_visual"])
        self.assertFalse(preview["can_propose"])
        self.assertEqual(preview["arthur"]["pose"], "reading")
        self.assertNotIn("PRIVATE", json.dumps(preview))

    def test_untrusted_state_file_is_never_projected(self):
        collector = self._collector()
        os.chmod(self.state, 0o666)
        status = collector.collect(observed_at=datetime(2026, 8, 13, 12, tzinfo=UTC))
        self.assertEqual(status["selection"]["phase"], "unknown")

    def test_missing_sentinel_degrades_health_without_hiding_safe_life_facts(self):
        collector = self._collector()
        self.sentinel.unlink()
        status = collector.collect(observed_at=datetime(2026, 8, 13, 12, tzinfo=UTC))
        self.assertEqual(status["selection"]["phase"], "stable")
        self.assertEqual(status["maintenance"]["health"], "unknown")
        self.assertEqual(status["arthur"]["pose"], "reading")


if __name__ == "__main__":
    unittest.main()
