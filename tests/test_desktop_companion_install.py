from __future__ import annotations

import plistlib
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from desktop_companion.install_mac_candidate import _render


ROOT = Path(__file__).resolve().parents[1]


class DesktopCompanionInstallTests(unittest.TestCase):
    def test_desktop_rig_has_accessible_name_without_native_tooltips(self):
        rig = ROOT / "desktop_companion/web/arthur-desktop-rig-v3.svg"
        root = ET.parse(rig).getroot()
        svg_namespace = "{http://www.w3.org/2000/svg}"

        self.assertEqual(root.attrib["role"], "img")
        self.assertTrue(root.attrib["aria-label"].strip())
        self.assertEqual(root.findall(f".//{svg_namespace}title"), [])

    def test_bridge_template_uses_selected_modern_python_exactly_once(self):
        template = (
            ROOT
            / "desktop_companion/launchd/uk.arthur.desktop-companion-bridge.plist.template"
        )
        rendered = _render(
            template,
            {
                "__SUPPORT_ROOT__": "/Users/you/Library/Application Support/ArthurDesktopCompanion",
                "__RUNTIME_ROOT__": "/Users/you/Library/Application Support/ArthurDesktopCompanion/runtime",
                "__APP_ROOT__": "/Users/you/Applications/Arthur Desktop Companion.app",
                "__LOG_ROOT__": "/Users/you/Library/Logs/ArthurDesktopCompanion",
                "__PYTHON__": "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3",
            },
        )
        value = plistlib.loads(rendered)
        arguments = value["ProgramArguments"]
        self.assertEqual(
            arguments[0],
            "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3",
        )
        self.assertEqual(sum(part.endswith("/python3") for part in arguments), 1)
        self.assertNotIn("/usr/bin/python3", arguments)

    def test_vps_candidate_is_loopback_only_and_disabled_by_installer(self):
        unit = (
            ROOT
            / "desktop_companion/systemd/arthur-vps-companion-status.service"
        ).read_text(encoding="utf-8")
        installer = (
            ROOT / "desktop_companion/install_vps_disabled_candidate.sh"
        ).read_text(encoding="utf-8")
        config = (
            ROOT / "desktop_companion/config.vps.example.json"
        ).read_text(encoding="utf-8")
        self.assertIn('"listen_host": "127.0.0.1"', config)
        self.assertIn("IPAddressDeny=any", unit)
        self.assertIn("IPAddressAllow=localhost", unit)
        self.assertNotIn("systemctl enable", installer)
        self.assertNotIn("systemctl start", installer)
        self.assertIn("systemctl is-enabled", installer)
        self.assertIn("systemctl is-active", installer)


if __name__ == "__main__":
    unittest.main()
