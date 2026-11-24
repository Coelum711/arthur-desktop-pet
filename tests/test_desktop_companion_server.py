from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from desktop_companion.server import (
    CommandResult,
    CompanionApplication,
    CompanionServerError,
    MacStatusSelector,
    RemoteConfig,
    SSHRemoteStatus,
    ServerConfig,
    load_config,
)
from desktop_companion.status_sources import CollectorPaths
from vps_runtime.switch.state import ActiveTarget, RuntimeMarker, RuntimeStatus


FIXTURES = Path(__file__).resolve().parents[1] / "vps_runtime" / "switch" / "fixtures" / "companion_status"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def marker(target="vps") -> RuntimeMarker:
    return RuntimeMarker(
        1,
        "vps",
        RuntimeStatus.ACTIVE if target == "vps" else RuntimeStatus.INACTIVE,
        ActiveTarget(target),
        7 if target == "vps" else 8,
        "switch-to-vps-fixture07" if target == "vps" else "switch-to-mac-fixture08",
        "2026-08-11T12:34:55Z",
        "fixture",
    )


class FakeCollector:
    def __init__(self, value: dict, root: Path, preview: dict | None = None):
        self.value = value
        self.preview_value = preview
        self.paths = type("Paths", (), {"marker_path": root / "runtime.json"})()
        self.markers = []

    def collect(self, **kwargs):
        self.markers.append(kwargs.get("marker_override"))
        return json.loads(json.dumps(self.value))

    def collect_legacy_mac_preview(self, marker_value, **kwargs):
        return self.preview_value


class FakeRemote:
    def __init__(self, value: dict | None, marker_value: RuntimeMarker | None = None):
        self.value = value
        self.marker_value = marker_value

    def status(self):
        return json.loads(json.dumps(self.value)) if self.value is not None else None

    def marker(self):
        return self.marker_value


class DesktopCompanionServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_selector_uses_only_the_marker_selected_stable_host(self):
        local = FakeCollector(fixture("unknown"), self.root)
        selector = MacStatusSelector(
            local,
            FakeRemote(fixture("stable-vps")),
            marker_reader=lambda: marker("vps"),
        )
        status = selector.status()
        self.assertEqual(status["selection"]["host"], "vps")
        self.assertEqual(local.markers[-1].active_target, ActiveTarget.VPS)

    def test_dual_stable_evidence_fails_closed(self):
        local = FakeCollector(fixture("stable-mac"), self.root)
        selector = MacStatusSelector(
            local,
            FakeRemote(fixture("stable-vps")),
            marker_reader=lambda: marker("vps"),
        )
        self.assertEqual(selector.status()["selection"]["phase"], "unknown")

    def test_wrong_host_status_fails_closed_even_if_it_is_only_stable_one(self):
        local = FakeCollector(fixture("stable-mac"), self.root)
        selector = MacStatusSelector(
            local,
            FakeRemote(fixture("unknown")),
            marker_reader=lambda: marker("vps"),
        )
        self.assertEqual(selector.status()["selection"]["phase"], "unknown")

    def test_legacy_preview_never_grants_proposal_authority(self):
        preview = {"can_drive_visual": True, "can_propose": False}
        local = FakeCollector(fixture("unknown"), self.root, preview)
        legacy = RuntimeMarker(
            1,
            "vps",
            RuntimeStatus.INACTIVE,
            ActiveTarget.MAC,
            0,
            None,
            "2026-08-11T12:34:55Z",
            "legacy",
        )
        selector = MacStatusSelector(
            local,
            FakeRemote(fixture("unknown")),
            marker_reader=lambda: legacy,
        )
        selector.status()
        self.assertEqual(selector.preview(), preview)
        self.assertFalse(selector.preview()["can_propose"])

    def test_ssh_commands_are_fixed_argv_and_key_never_enters_payload(self):
        identity = self.root / "id_ed25519"
        identity.write_text("fixture-not-a-key", encoding="utf-8")
        os.chmod(identity, 0o600)
        calls = []

        def run(argv):
            calls.append(tuple(argv))
            return CommandResult(
                0,
                json.dumps(
                    {
                        "schema_version": 1,
                        "status": fixture("stable-vps"),
                        "marker": marker("vps").to_mapping(),
                    }
                ),
            )

        remote = SSHRemoteStatus(
            RemoteConfig(True, "arthur-vps.example", "arthur-maint", identity),
            run=run,
            clock=lambda: datetime.fromisoformat(
                fixture("stable-vps")["observed_at"].replace("Z", "+00:00")
            ) + timedelta(seconds=1),
        )
        self.assertEqual(remote.status()["selection"]["host"], "vps")
        self.assertEqual(remote.marker().active_target, ActiveTarget.VPS)
        self.assertEqual(len(calls), 1)
        self.assertIn("BatchMode=yes", calls[0])
        self.assertIn("StrictHostKeyChecking=yes", calls[0])
        self.assertNotIn("fixture-not-a-key", " ".join(calls[0]))
        self.assertNotIn("sh", calls[0])
        self.assertNotIn("bash", calls[0])
        self.assertNotIn("sudo", calls[0])
        self.assertNotIn("cat", calls[0])

    def test_ssh_pins_public_host_key_when_dialling_tailnet_address(self):
        identity = self.root / "id_ed25519"
        identity.write_text("fixture-not-a-key", encoding="utf-8")
        os.chmod(identity, 0o600)
        calls = []
        remote = SSHRemoteStatus(
            RemoteConfig(
                True, "100.64.0.10", "arthur-maint", identity,
                host_key_alias="arthur-vps.example",
            ),
            run=lambda argv: calls.append(tuple(argv)) or CommandResult(255),
        )
        self.assertIsNone(remote.status())
        argv = calls[0]
        self.assertIn("HostKeyAlias=arthur-vps.example", argv)
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertEqual(argv[argv.index("--") + 1], "arthur-maint@100.64.0.10")
        with self.assertRaisesRegex(CompanionServerError, "host_key_alias"):
            RemoteConfig(True, "100.64.0.10", "arthur-maint", identity, host_key_alias="a b")

    def test_ssh_rejects_replayed_old_fresh_document(self):
        identity = self.root / "id_ed25519"
        identity.write_text("fixture-not-a-key", encoding="utf-8")
        os.chmod(identity, 0o600)
        remote = SSHRemoteStatus(
            RemoteConfig(True, "arthur-vps.example", "arthur-maint", identity),
            run=lambda argv: CommandResult(
                0,
                json.dumps(
                    {
                        "schema_version": 1,
                        "status": fixture("stable-vps"),
                        "marker": marker("vps").to_mapping(),
                    }
                ),
            ),
            clock=lambda: datetime(2026, 8, 13, tzinfo=timezone.utc),
        )
        self.assertIsNone(remote.status())

    def test_config_is_strict_loopback_only(self):
        config = {
            "schema_version": 1,
            "role": "vps-exporter",
            "listen_host": "0.0.0.0",
            "port": 15174,
            "web_root": "/srv/arthur/desktop_companion/web",
            "collector": {
                "host": "vps",
                "arthur_home": "/srv/arthur",
                "marker_path": "/var/lib/arthur-switch/runtime.json",
                "binding_path": "/var/lib/arthur-switch/active-generation.json",
                "runtime_generation_path": "/srv/arthur/.arthur-runtime-generation.json",
                "sentinel_path": "/var/lib/arthur-vps/sentinel_report.json",
                "state_path": "/srv/arthur/daemon/state.json",
            },
            "remote": None,
        }
        path = self.root / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        os.chmod(path, 0o600)
        with self.assertRaisesRegex(CompanionServerError, "loopback"):
            load_config(path)

    def test_config_rejects_boolean_and_string_ports(self):
        base = {
            "schema_version": 1,
            "role": "vps-exporter",
            "listen_host": "127.0.0.1",
            "port": True,
            "web_root": "/srv/arthur/desktop_companion/web",
            "collector": {
                "host": "vps",
                "arthur_home": "/srv/arthur",
                "marker_path": "/var/lib/arthur-switch/runtime.json",
                "binding_path": "/var/lib/arthur-switch/active-generation.json",
                "runtime_generation_path": "/srv/arthur/.arthur-runtime-generation.json",
                "sentinel_path": "/var/lib/arthur-vps/sentinel_report.json",
                "state_path": "/srv/arthur/daemon/state.json",
            },
            "remote": None,
        }
        path = self.root / "config.json"
        path.write_text(json.dumps(base), encoding="utf-8")
        os.chmod(path, 0o600)
        with self.assertRaisesRegex(CompanionServerError, "integer"):
            load_config(path)

        base["role"] = "mac-desktop"
        base["collector"]["host"] = "mac"
        base["port"] = 15174
        base["remote"] = {
            "enabled": True,
            "host": "arthur-vps.example",
            "user": "arthur-maint",
            "identity": "/Users/you/.ssh/id_ed25519",
            "port": "22",
            "exporter_port": 15174,
            "connect_timeout_seconds": 5,
            "marker_path": "/var/lib/arthur-switch/runtime.json",
        }
        path.write_text(json.dumps(base), encoding="utf-8")
        with self.assertRaisesRegex(CompanionServerError, "remote.port"):
            load_config(path)

        base["remote"]["port"] = 22
        base["remote"]["host"] = "100.64.0.10"
        base["remote"]["host_key_alias"] = "arthur-vps.example"
        path.write_text(json.dumps(base), encoding="utf-8")
        self.assertEqual(load_config(path).remote.host_key_alias, "arthur-vps.example")
        base["remote"]["unreviewed"] = True
        path.write_text(json.dumps(base), encoding="utf-8")
        with self.assertRaisesRegex(CompanionServerError, "reviewed schema"):
            load_config(path)

    def test_static_server_rejects_traversal_and_vps_has_no_ui(self):
        web = self.root / "web"
        web.mkdir()
        (web / "index.html").write_text("safe", encoding="utf-8")
        paths = CollectorPaths(
            "vps",
            Path("/srv/arthur"),
            Path("/var/lib/arthur-switch/runtime.json"),
            Path("/var/lib/arthur-switch/active-generation.json"),
            Path("/srv/arthur/.arthur-runtime-generation.json"),
            Path("/var/lib/arthur-vps/sentinel_report.json"),
            Path("/srv/arthur/daemon/state.json"),
        )
        app = CompanionApplication(
            ServerConfig("vps-exporter", "127.0.0.1", 15174, web, paths),
            collector=FakeCollector(fixture("unknown"), self.root),
        )
        self.assertIsNone(app.static("/"))
        self.assertIsNone(app.static("/../state.json"))

    def test_only_vps_exporter_can_emit_one_status_marker_envelope(self):
        web = self.root / "web"
        web.mkdir()
        marker_path = self.root / "runtime.json"
        marker_path.write_text(json.dumps(marker("vps").to_mapping()), encoding="utf-8")
        paths = CollectorPaths(
            "vps",
            Path("/srv/arthur"),
            marker_path,
            Path("/var/lib/arthur-switch/active-generation.json"),
            Path("/srv/arthur/.arthur-runtime-generation.json"),
            Path("/var/lib/arthur-vps/sentinel_report.json"),
            Path("/srv/arthur/daemon/state.json"),
        )
        app = CompanionApplication(
            ServerConfig("vps-exporter", "127.0.0.1", 15174, web, paths),
            collector=FakeCollector(fixture("stable-vps"), self.root),
        )
        envelope = app.envelope()
        self.assertEqual(envelope["schema_version"], 1)
        self.assertEqual(envelope["marker"]["active_target"], "vps")
        self.assertEqual(envelope["status"]["selection"]["host"], "vps")


if __name__ == "__main__":
    unittest.main()
