#!/usr/bin/env python3
"""Read-only launchd/systemd writer-set probes for the manual switch adapter."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from vps_runtime.switch.adapters import HostActivity
    from vps_runtime.switch.generation_guard import (
        GenerationBinding,
        GenerationGuardError,
    )
    from vps_runtime.switch.writer_inventory import load_inventory
else:
    from .adapters import HostActivity
    from .generation_guard import GenerationBinding, GenerationGuardError
    from .writer_inventory import load_inventory


@dataclass(frozen=True)
class ProbeCommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class HostProbeResult:
    host: str
    activity: HostActivity
    detail: str
    loaded: tuple[str, ...] = ()
    running: tuple[str, ...] = ()
    enabled: tuple[str, ...] = ()
    disabled: tuple[str, ...] = ()
    sealed_violations: tuple[str, ...] = ()
    inventory_sha256: str = ""
    exclusions: tuple[str, ...] = ()
    binding_valid: bool = False
    bound_target: str | None = None
    bound_generation: int | None = None
    bound_transition_id: str | None = None
    binding_detail: str = "generation binding not observed"

    def as_dict(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "host": self.host,
            "activity": self.activity.value,
            "detail": self.detail,
            "loaded": list(self.loaded),
            "running": list(self.running),
            "enabled": list(self.enabled),
            "disabled": list(self.disabled),
            "sealed_violations": list(self.sealed_violations),
            "writer_inventory_sha256": self.inventory_sha256,
            "explicit_exclusions": list(self.exclusions),
            "generation_binding": {
                "valid": self.binding_valid,
                "target": self.bound_target,
                "generation": self.bound_generation,
                "transition_id": self.bound_transition_id,
                "detail": self.binding_detail,
            },
            "mutations_performed": False,
        }


Runner = Callable[[Sequence[str]], ProbeCommandResult]


def _runner(argv: Sequence[str]) -> ProbeCommandResult:
    result = subprocess.run(
        tuple(argv),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=15,
    )
    return ProbeCommandResult(result.returncode, result.stdout, result.stderr)


WRITER_INVENTORY = load_inventory()
MAC_BINDING_PATH = "/Users/you/.arthur-switch/active-generation.json"
VPS_BINDING_PATH = "/var/lib/arthur-switch/active-generation.json"
MAC_LABELS = tuple(
    item.unit
    for item in WRITER_INVENTORY.select(
        host="mac", manager="launchd", lifecycle="active"
    )
)
MAC_SEALED_LABELS = tuple(
    item.unit
    for item in WRITER_INVENTORY.select(
        host="mac", manager="launchd", lifecycle="sealed"
    )
)
VPS_WRITERS = tuple(dict.fromkeys(
    item.unit
    for item in WRITER_INVENTORY.select(
        host="vps", manager="systemd", lifecycle="active"
    )
))
VPS_ACTIVATORS = tuple(dict.fromkeys(
    item.activator
    for item in WRITER_INVENTORY.select(
        host="vps", manager="systemd", lifecycle="active"
    )
    if item.activator is not None
))
VPS_SEALED_WRITERS = tuple(dict.fromkeys(
    item.unit
    for item in WRITER_INVENTORY.select(
        host="vps", manager="systemd", lifecycle="sealed"
    )
))
VPS_SEALED_ACTIVATORS = tuple(dict.fromkeys(
    item.activator
    for item in WRITER_INVENTORY.select(
        host="vps", manager="systemd", lifecycle="sealed"
    )
    if item.activator is not None
))


def _exclusions(host: str) -> tuple[str, ...]:
    return tuple(
        f"{item.id}:{item.unit}"
        for item in WRITER_INVENTORY.exclusions
        if item.host == host
    )


def _probe_binding(
    run: Runner,
    *,
    path: str,
    host: str,
) -> tuple[bool, str | None, int | None, str | None, str]:
    result = run(("cat", path))
    if result.returncode != 0:
        return False, None, None, None, "generation binding is missing or unreadable"
    try:
        raw = json.loads(result.stdout)
        binding = GenerationBinding.from_mapping(raw)
    except (json.JSONDecodeError, GenerationGuardError):
        return False, None, None, None, "generation binding is malformed"
    if binding.target != host:
        return False, binding.target, binding.generation, binding.transition_id, "binding target disagrees with host"
    if binding.writer_inventory_sha256 != WRITER_INVENTORY.sha256:
        return False, binding.target, binding.generation, binding.transition_id, "binding inventory digest is stale"
    return (
        True,
        binding.target,
        binding.generation,
        binding.transition_id,
        "generation binding schema and inventory digest verified",
    )


def probe_mac(run: Runner = _runner, *, uid: int | None = None) -> HostProbeResult:
    resolved_uid = os.getuid() if uid is None else uid
    domain = f"gui/{resolved_uid}"
    binding = _probe_binding(run, path=MAC_BINDING_PATH, host="mac")
    disabled_result = run(("launchctl", "print-disabled", domain))
    if disabled_result.returncode != 0:
        return HostProbeResult(
            "mac",
            HostActivity.UNKNOWN,
            "launchd disabled-state query failed",
            inventory_sha256=WRITER_INVENTORY.sha256,
            exclusions=_exclusions("mac"),
            binding_valid=binding[0],
            bound_target=binding[1],
            bound_generation=binding[2],
            bound_transition_id=binding[3],
            binding_detail=binding[4],
        )
    observed_labels = (*MAC_LABELS, *MAC_SEALED_LABELS)
    explicit_disabled = {
        label: bool(
            re.search(
                rf'["\']?{re.escape(label)}["\']?\s*=>\s*(?:true|disabled)',
                disabled_result.stdout,
            )
        )
        for label in observed_labels
    }
    loaded: list[str] = []
    running: list[str] = []
    for label in observed_labels:
        result = run(("launchctl", "print", f"{domain}/{label}"))
        if result.returncode == 0:
            loaded.append(label)
            if re.search(r"^\s*state = (?:running|spawned)\s*$", result.stdout, re.MULTILINE):
                running.append(label)
    enabled = [label for label in observed_labels if not explicit_disabled[label]]
    disabled = [label for label in observed_labels if explicit_disabled[label]]
    sealed_violations = sorted(
        label for label in MAC_SEALED_LABELS if label in loaded or label in running
    )
    active_enabled = {label for label in MAC_LABELS if not explicit_disabled[label]}
    active_disabled = {label for label in MAC_LABELS if explicit_disabled[label]}
    if (
        set(MAC_LABELS).issubset(loaded)
        and "com.arthur.bot" in running
        and active_enabled == set(MAC_LABELS)
        and not sealed_violations
    ):
        activity = HostActivity.ACTIVE
        detail = "Mac inventoried launchers are enabled, sealed writers absent, and the bot is running"
    elif not loaded and active_disabled == set(MAC_LABELS) and not sealed_violations:
        activity = HostActivity.INACTIVE
        detail = "Mac inventoried launchers are disabled and no writer is loaded"
    else:
        activity = HostActivity.UNKNOWN
        detail = "Mac launchd writer set is partial or contradictory"
    return HostProbeResult(
        "mac",
        activity,
        detail,
        tuple(sorted(loaded)),
        tuple(sorted(running)),
        tuple(sorted(enabled)),
        tuple(sorted(disabled)),
        tuple(sealed_violations),
        WRITER_INVENTORY.sha256,
        _exclusions("mac"),
        binding[0],
        binding[1],
        binding[2],
        binding[3],
        binding[4],
    )


def _systemctl_value(run: Runner, unit: str, prop: str) -> str | None:
    result = run(("systemctl", "show", unit, f"--property={prop}", "--value"))
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def probe_vps(run: Runner = _runner) -> HostProbeResult:
    binding = _probe_binding(run, path=VPS_BINDING_PATH, host="vps")
    active_states = {
        unit: _systemctl_value(run, unit, "ActiveState") for unit in VPS_WRITERS
    }
    enabled_states = {
        unit: _systemctl_value(run, unit, "UnitFileState")
        for unit in ("arthur-vps-bot.service", *VPS_ACTIVATORS)
    }
    sealed_active_states = {
        unit: _systemctl_value(run, unit, "ActiveState")
        for unit in VPS_SEALED_WRITERS
    }
    sealed_enabled_states = {
        unit: _systemctl_value(run, unit, "UnitFileState")
        for unit in (*VPS_SEALED_WRITERS, *VPS_SEALED_ACTIVATORS)
    }
    if any(value is None for value in (*active_states.values(), *enabled_states.values())):
        return HostProbeResult(
            "vps",
            HostActivity.UNKNOWN,
            "one or more active systemd units are unavailable",
            inventory_sha256=WRITER_INVENTORY.sha256,
            exclusions=_exclusions("vps"),
            binding_valid=binding[0],
            bound_target=binding[1],
            bound_generation=binding[2],
            bound_transition_id=binding[3],
            binding_detail=binding[4],
        )
    running = sorted(unit for unit, value in active_states.items() if value == "active")
    enabled = sorted(unit for unit, value in enabled_states.items() if value == "enabled")
    disabled = sorted(unit for unit, value in enabled_states.items() if value == "disabled")
    sealed_violations = sorted(
        {
            unit
            for unit, value in sealed_active_states.items()
            if value not in (None, "inactive")
        }
        | {
            unit
            for unit, value in sealed_enabled_states.items()
            if value not in (None, "disabled", "masked")
        }
    )
    if (
        active_states["arthur-vps-bot.service"] == "active"
        and set(enabled) == {"arthur-vps-bot.service", *VPS_ACTIVATORS}
        and not sealed_violations
    ):
        activity = HostActivity.ACTIVE
        detail = "VPS bot is active and all writer activators are enabled"
    elif (
        set(active_states.values()) == {"inactive"}
        and set(disabled) == {"arthur-vps-bot.service", *VPS_ACTIVATORS}
        and not sealed_violations
    ):
        activity = HostActivity.INACTIVE
        detail = "VPS writers are inactive and all activators are disabled"
    else:
        activity = HostActivity.UNKNOWN
        detail = "VPS systemd writer set is partial, failed, or contradictory"
    return HostProbeResult(
        "vps",
        activity,
        detail,
        tuple(
            sorted(
                unit
                for unit, value in {**active_states, **sealed_active_states}.items()
                if value is not None
            )
        ),
        tuple(running),
        tuple(enabled),
        tuple(disabled),
        tuple(sealed_violations),
        WRITER_INVENTORY.sha256,
        _exclusions("vps"),
        binding[0],
        binding[1],
        binding[2],
        binding[3],
        binding[4],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=("mac", "vps"))
    args = parser.parse_args()
    result = probe_mac() if args.host == "mac" else probe_vps()
    print(json.dumps(result.as_dict(), ensure_ascii=False, sort_keys=True))
    return 0 if result.activity is not HostActivity.UNKNOWN else 1


if __name__ == "__main__":
    raise SystemExit(main())
