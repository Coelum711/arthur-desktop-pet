#!/usr/bin/env python3
"""Create-only installer for Arthur's Mac desktop companion.

The installer never replaces or removes an existing path.  Its temporary
staging directory is created by this invocation and is the only directory its
standard-library cleanup is allowed to remove.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


LABELS = (
    "uk.arthur.desktop-companion-bridge",
    "uk.arthur.desktop-companion",
)


class InstallError(RuntimeError):
    pass


def _write_create_only(path: Path, data: bytes, mode: int) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        raise


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_source(source: Path, destination: Path) -> None:
    for candidate in source.rglob("*"):
        if candidate.is_symlink():
            raise InstallError(f"source tree contains a symlink: {candidate}")
    shutil.copytree(
        source,
        destination,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
    )


def _render(template: Path, replacements: dict[str, str]) -> bytes:
    value = template.read_text(encoding="utf-8")
    for before, after in replacements.items():
        value = value.replace(before, after)
    if "__" in value:
        raise InstallError(f"unresolved launchd template token in {template.name}")
    return value.encode("utf-8")


def _git_head(root: Path) -> str:
    result = subprocess.run(
        ("git", "-C", str(root), "rev-parse", "HEAD"),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    value = result.stdout.strip()
    if result.returncode != 0 or len(value) != 40:
        raise InstallError("cannot identify the desktop companion source commit")
    return value


def install(*, execute: bool, start: bool, identity: Path) -> dict[str, object]:
    if platform.system() != "Darwin":
        raise InstallError("Mac desktop companion installation requires Darwin")
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    try:
        key_mode = identity.lstat().st_mode
        if not stat.S_ISREG(key_mode) or identity.is_symlink():
            raise InstallError("SSH identity is not a plain file")
        if stat.S_IMODE(key_mode) & 0o077 or identity.stat().st_uid != os.getuid():
            raise InstallError("SSH identity owner or permissions are unsafe")
    except OSError as exc:
        raise InstallError("SSH identity is unavailable") from exc

    repo = Path(__file__).resolve().parents[1]
    support = home / "Library/Application Support/ArthurDesktopCompanion"
    runtime = support / "runtime"
    app = home / "Applications/Arthur Desktop Companion.app"
    launch_agents = home / "Library/LaunchAgents"
    logs = home / "Library/Logs/ArthurDesktopCompanion"
    plists = tuple(launch_agents / f"{label}.plist" for label in LABELS)
    targets = (support, app, *plists)
    occupied = [str(path) for path in targets if path.exists() or path.is_symlink()]
    if occupied:
        raise InstallError("create-only targets already exist: " + ", ".join(occupied))

    plan: dict[str, object] = {
        "schema_version": 1,
        "mode": "create-only",
        "source_commit": _git_head(repo),
        "support_root": str(support),
        "app_root": str(app),
        "launch_agents": [str(path) for path in plists],
        "ssh_identity_path": str(identity),
        "start_requested": start,
    }
    if not execute:
        return plan

    with tempfile.TemporaryDirectory(prefix="arthur-desktop-companion-install-") as raw:
        stage = Path(raw)
        stage_support = stage / "support"
        stage_runtime = stage_support / "runtime"
        stage_app = stage / app.name
        stage_plists = stage / "plists"
        stage_plists.mkdir()
        stage_runtime.mkdir(parents=True)
        _copy_source(repo / "desktop_companion", stage_runtime / "desktop_companion")
        _copy_source(repo / "vps_runtime", stage_runtime / "vps_runtime")

        config = json.loads(
            (repo / "desktop_companion/config.mac.example.json").read_text(
                encoding="utf-8"
            )
        )
        config["web_root"] = str(runtime / "desktop_companion/web")
        config["remote"]["identity"] = str(identity)
        config_path = stage_support / "config.mac.json"
        _write_create_only(
            config_path,
            (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode(),
            0o600,
        )

        subprocess.run(
            (
                str(repo / "desktop_companion/macos/build_app.sh"),
                str(stage_app),
            ),
            check=True,
        )
        replacements = {
            "__SUPPORT_ROOT__": str(support),
            "__RUNTIME_ROOT__": str(runtime),
            "__APP_ROOT__": str(app),
            "__LOG_ROOT__": str(logs),
            "__PYTHON__": sys.executable,
        }
        for label in LABELS:
            source = repo / "desktop_companion/launchd" / f"{label}.plist.template"
            _write_create_only(
                stage_plists / f"{label}.plist",
                _render(source, replacements),
                0o644,
            )

        receipt = {
            **plan,
            "installed_at": datetime.now(timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            "config_sha256": _sha256(config_path),
            "app_executable_sha256": _sha256(
                stage_app / "Contents/MacOS/ArthurDesktopCompanion"
            ),
        }
        _write_create_only(
            stage_support / "install-receipt.json",
            (json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(),
            0o600,
        )

        support.parent.mkdir(parents=True, exist_ok=True)
        app.parent.mkdir(parents=True, exist_ok=True)
        launch_agents.mkdir(parents=True, exist_ok=True)
        logs.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage_support, support)
        shutil.copytree(stage_app, app)
        for label, target in zip(LABELS, plists, strict=True):
            _write_create_only(
                target,
                (stage_plists / f"{label}.plist").read_bytes(),
                0o644,
            )

    if start:
        domain = f"gui/{os.getuid()}"
        for plist in plists:
            subprocess.run(
                ("launchctl", "bootstrap", domain, str(plist)), check=True
            )
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--start", action="store_true")
    parser.add_argument(
        "--ssh-identity", type=Path, default=Path("/Users/you/.ssh/id_ed25519")
    )
    args = parser.parse_args()
    if args.start and not args.execute:
        raise SystemExit("--start requires --execute")
    try:
        result = install(
            execute=args.execute, start=args.start, identity=args.ssh_identity
        )
    except (InstallError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"desktop companion installation refused: {exc}") from exc
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
