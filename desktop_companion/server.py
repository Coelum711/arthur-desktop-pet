#!/usr/bin/env python3
"""Loopback-only status server for Arthur's Mac desktop companion.

``mac-desktop`` serves the visual bundle and chooses one authoritative status
between the local Mac collector and a VPS loopback exporter reached over SSH.
``vps-exporter`` serves only the VPS collector.  Neither role mutates Arthur,
the switch marker, a service, or a remote account.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import stat
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlsplit

from desktop_companion.status_sources import CollectorPaths, HostStatusCollector
from vps_runtime.switch.companion_status import (
    project_companion_status,
    validate_companion_status,
)
from vps_runtime.switch.state import RuntimeMarker


MAX_CONFIG_BYTES = 256 * 1024
MAX_REMOTE_BYTES = 128 * 1024
_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
_USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_SAFE_STATIC = re.compile(r"^[A-Za-z0-9._/-]+$")
_ROLES = {"mac-desktop", "vps-exporter"}


class CompanionServerError(RuntimeError):
    """The local bridge cannot establish its read-only boundary."""


@dataclass(frozen=True, slots=True)
class RemoteConfig:
    enabled: bool
    host: str
    user: str
    identity: Path
    port: int = 22
    exporter_port: int = 15174
    connect_timeout_seconds: int = 5
    marker_path: str = "/var/lib/arthur-switch/runtime.json"
    # When ``host`` is a tailnet address, the pinned host key is still recorded
    # under the public name; this tells ssh which known_hosts entry to check.
    host_key_alias: str | None = None

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise CompanionServerError("remote.enabled must be boolean")
        if not _HOST.fullmatch(self.host) or ".." in self.host:
            raise CompanionServerError("remote.host is invalid")
        if self.host_key_alias is not None and (
            not isinstance(self.host_key_alias, str)
            or not _HOST.fullmatch(self.host_key_alias)
            or ".." in self.host_key_alias
        ):
            raise CompanionServerError("remote.host_key_alias is invalid")
        if not _USER.fullmatch(self.user):
            raise CompanionServerError("remote.user is invalid")
        if not self.identity.is_absolute():
            raise CompanionServerError("remote.identity must be absolute")
        if type(self.port) is not int or type(self.exporter_port) is not int or not 1 <= self.port <= 65535 or not 1024 <= self.exporter_port <= 65535:
            raise CompanionServerError("remote ports are invalid")
        if type(self.connect_timeout_seconds) is not int or not 3 <= self.connect_timeout_seconds <= 30:
            raise CompanionServerError("remote timeout must be 3 to 30 seconds")
        if self.marker_path != "/var/lib/arthur-switch/runtime.json":
            raise CompanionServerError("remote marker path is fixed by the switch contract")


@dataclass(frozen=True, slots=True)
class ServerConfig:
    role: str
    listen_host: str
    port: int
    web_root: Path
    collector: CollectorPaths
    remote: RemoteConfig | None = None

    def __post_init__(self) -> None:
        if self.role not in _ROLES:
            raise CompanionServerError("role must be mac-desktop or vps-exporter")
        if self.listen_host not in {"127.0.0.1", "::1"}:
            raise CompanionServerError("desktop companion must remain loopback-only")
        if type(self.port) is not int or not 1024 <= self.port <= 65535:
            raise CompanionServerError("port must be between 1024 and 65535")
        if not self.web_root.is_absolute():
            raise CompanionServerError("web_root must be absolute")
        if self.role == "mac-desktop":
            if self.collector.host != "mac" or self.remote is None:
                raise CompanionServerError("Mac role requires Mac collector and remote config")
        elif self.collector.host != "vps" or self.remote is not None:
            raise CompanionServerError("VPS role accepts only a VPS collector")


def _absolute(raw: object, label: str) -> Path:
    value = Path(str(raw))
    if not value.is_absolute() or ".." in value.parts:
        raise CompanionServerError(f"{label} must be an absolute safe path")
    return value


def _exact(
    value: object, expected: set[str], label: str, optional: frozenset[str] = frozenset()
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not expected <= set(value) <= expected | optional:
        raise CompanionServerError(f"{label} fields do not match the reviewed schema")
    return value


def load_config(path: Path) -> ServerConfig:
    try:
        mode = path.lstat().st_mode
        if not stat.S_ISREG(mode) or path.is_symlink():
            raise CompanionServerError("config must be a plain file")
        if stat.S_IMODE(mode) & 0o022:
            raise CompanionServerError("config must not be group/world writable")
        if path.stat().st_uid not in {0, os.getuid()}:
            raise CompanionServerError("config owner is not trusted")
        if path.stat().st_size > MAX_CONFIG_BYTES:
            raise CompanionServerError("config is too large")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except CompanionServerError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CompanionServerError("config is unreadable") from exc
    root = _exact(
        raw,
        {"schema_version", "role", "listen_host", "port", "web_root", "collector", "remote"},
        "config",
    )
    if root["schema_version"] != 1:
        raise CompanionServerError("unsupported config schema")
    if type(root["port"]) is not int:
        raise CompanionServerError("port must be an integer")
    collector_raw = _exact(
        root["collector"],
        {
            "host",
            "arthur_home",
            "marker_path",
            "binding_path",
            "runtime_generation_path",
            "sentinel_path",
            "state_path",
        },
        "collector",
    )
    collector = CollectorPaths(
        str(collector_raw["host"]),
        _absolute(collector_raw["arthur_home"], "collector.arthur_home"),
        _absolute(collector_raw["marker_path"], "collector.marker_path"),
        _absolute(collector_raw["binding_path"], "collector.binding_path"),
        _absolute(collector_raw["runtime_generation_path"], "collector.runtime_generation_path"),
        _absolute(collector_raw["sentinel_path"], "collector.sentinel_path"),
        _absolute(collector_raw["state_path"], "collector.state_path"),
    )
    remote_raw = root["remote"]
    remote: RemoteConfig | None
    if remote_raw is None:
        remote = None
    else:
        remote_map = _exact(
            remote_raw,
            {
                "enabled",
                "host",
                "user",
                "identity",
                "port",
                "exporter_port",
                "connect_timeout_seconds",
                "marker_path",
            },
            "remote",
            frozenset({"host_key_alias"}),
        )
        if type(remote_map["enabled"]) is not bool:
            raise CompanionServerError("remote.enabled must be boolean")
        for field in ("port", "exporter_port", "connect_timeout_seconds"):
            if type(remote_map[field]) is not int:
                raise CompanionServerError(f"remote.{field} must be an integer")
        remote = RemoteConfig(
            remote_map["enabled"],
            str(remote_map["host"]),
            str(remote_map["user"]),
            _absolute(remote_map["identity"], "remote.identity"),
            remote_map["port"],
            remote_map["exporter_port"],
            remote_map["connect_timeout_seconds"],
            str(remote_map["marker_path"]),
            remote_map.get("host_key_alias"),
        )
    return ServerConfig(
        str(root["role"]),
        str(root["listen_host"]),
        root["port"],
        _absolute(root["web_root"], "web_root"),
        collector,
        remote,
    )


@dataclass(frozen=True, slots=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


Runner = Callable[[Sequence[str]], CommandResult]


def _runner(argv: Sequence[str]) -> CommandResult:
    try:
        result = subprocess.run(
            tuple(argv),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return CommandResult(255, "", "remote command unavailable")
    return CommandResult(result.returncode, result.stdout, result.stderr)


class SSHRemoteStatus:
    """Fixed-argument SSH client; no browser code or shell receives the key."""

    def __init__(
        self,
        config: RemoteConfig,
        *,
        run: Runner = _runner,
        clock: Callable[[], datetime] | None = None,
    ):
        self.config = config
        self.run = run
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self._snapshot_lock = threading.Lock()
        self._snapshot_at = 0.0
        self._snapshot_value: tuple[dict[str, Any] | None, RuntimeMarker | None] = (
            None,
            None,
        )

    def _prefix(self) -> tuple[str, ...]:
        identity = self.config.identity
        try:
            mode = identity.lstat().st_mode
            if not stat.S_ISREG(mode) or identity.is_symlink():
                raise CompanionServerError("SSH identity is not a plain file")
            if stat.S_IMODE(mode) & 0o077:
                raise CompanionServerError("SSH identity permissions are too broad")
            if identity.stat().st_uid != os.getuid():
                raise CompanionServerError("SSH identity owner is not the desktop user")
        except OSError as exc:
            raise CompanionServerError("SSH identity is unavailable") from exc
        return (
            "ssh",
            "-i",
            str(identity),
            "-p",
            str(self.config.port),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"ConnectTimeout={self.config.connect_timeout_seconds}",
            *(
                ("-o", f"HostKeyAlias={self.config.host_key_alias}")
                if self.config.host_key_alias
                else ()
            ),
            "--",
            f"{self.config.user}@{self.config.host}",
        )

    def _snapshot(self) -> tuple[dict[str, Any] | None, RuntimeMarker | None]:
        if not self.config.enabled:
            return None, None
        stamp = time.monotonic()
        with self._snapshot_lock:
            if stamp - self._snapshot_at < 2.0:
                status, marker = self._snapshot_value
                return (
                    json.loads(json.dumps(status)) if status is not None else None,
                    marker,
                )
            result = self.run(
                (
                    *self._prefix(),
                    "curl",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    "3",
                    f"http://127.0.0.1:{self.config.exporter_port}/api/companion-envelope",
                )
            )
            status: dict[str, Any] | None = None
            marker: RuntimeMarker | None = None
            if result.returncode == 0 and len(result.stdout.encode("utf-8")) <= MAX_REMOTE_BYTES:
                try:
                    envelope = json.loads(result.stdout)
                    if not isinstance(envelope, dict) or set(envelope) != {
                        "schema_version",
                        "status",
                        "marker",
                    } or envelope["schema_version"] != 1:
                        raise CompanionServerError("remote envelope schema mismatch")
                    validated = validate_companion_status(envelope["status"])
                    observed = datetime.fromisoformat(
                        validated["observed_at"].replace("Z", "+00:00")
                    ).astimezone(timezone.utc)
                    transport_age_ms = int(
                        (self.clock() - observed).total_seconds() * 1000
                    )
                    stale_after_ms = int(validated["freshness"]["stale_after_ms"])
                    if transport_age_ms < -5_000 or transport_age_ms >= stale_after_ms:
                        raise CompanionServerError("remote envelope is a replay")
                    status = validated
                    marker = RuntimeMarker.from_mapping(envelope["marker"])
                except Exception:
                    status = None
                    marker = None
            self._snapshot_at = stamp
            self._snapshot_value = (status, marker)
            return (
                json.loads(json.dumps(status)) if status is not None else None,
                marker,
            )

    def status(self) -> dict[str, Any] | None:
        return self._snapshot()[0]

    def marker(self) -> RuntimeMarker | None:
        return self._snapshot()[1]


def _unknown(now: datetime | None = None) -> dict[str, Any]:
    return project_companion_status(
        marker=None,
        writer=None,
        runtime_generation=None,
        arthur=None,
        maintenance=None,
        observed_at=now or datetime.now(timezone.utc),
    )


class MacStatusSelector:
    """Choose exactly one host; ambiguity never becomes a plausible status."""

    def __init__(
        self,
        local: HostStatusCollector,
        remote: SSHRemoteStatus,
        *,
        marker_reader: Callable[[], RuntimeMarker | None] | None = None,
    ):
        self.local = local
        self.remote = remote
        self.marker_reader = marker_reader or self._marker
        self._lock = threading.Lock()
        self._cached_at = 0.0
        self._cached_status: dict[str, Any] | None = None
        self._cached_marker: RuntimeMarker | None = None

    def _marker(self) -> RuntimeMarker | None:
        try:
            value = json.loads(self.local.paths.marker_path.read_text(encoding="utf-8"))
            return RuntimeMarker.from_mapping(value)
        except Exception:
            return self.remote.marker()

    def status(self, *, now: datetime | None = None) -> dict[str, Any]:
        stamp = time.monotonic()
        with self._lock:
            if self._cached_status is not None and stamp - self._cached_at < 2.0:
                return json.loads(json.dumps(self._cached_status))
            observed = now or datetime.now(timezone.utc)
            marker = self.marker_reader()
            local_status = self.local.collect(observed_at=observed, marker_override=marker)
            remote_status = self.remote.status()
            stable = [
                item
                for item in (local_status, remote_status)
                if item is not None and item.get("selection", {}).get("phase") == "stable"
            ]
            if len(stable) == 1:
                chosen = stable[0]
                target = marker.active_target.value if marker and marker.active_target else None
                if chosen["selection"]["host"] != target:
                    chosen = _unknown(observed)
            elif len(stable) > 1:
                chosen = _unknown(observed)
            elif marker is not None and marker.active_target is None:
                chosen = self.local.collect(observed_at=observed, marker_override=marker)
            else:
                chosen = _unknown(observed)
            self._cached_at = stamp
            self._cached_status = chosen
            self._cached_marker = marker
            return json.loads(json.dumps(chosen))

    def preview(self, *, now: datetime | None = None) -> dict[str, Any] | None:
        self.status(now=now)
        marker = self._cached_marker
        return self.local.collect_legacy_mac_preview(marker, observed_at=now) if marker else None


class CompanionApplication:
    def __init__(
        self,
        config: ServerConfig,
        *,
        collector: HostStatusCollector | None = None,
        remote: SSHRemoteStatus | None = None,
    ):
        self.config = config
        self.collector = collector or HostStatusCollector(config.collector)
        self.selector: MacStatusSelector | None = None
        if config.role == "mac-desktop":
            assert config.remote is not None
            self.selector = MacStatusSelector(
                self.collector, remote or SSHRemoteStatus(config.remote)
            )

    def status(self) -> dict[str, Any]:
        if self.selector is not None:
            return self.selector.status()
        return self.collector.collect()

    def preview(self) -> dict[str, Any] | None:
        return self.selector.preview() if self.selector is not None else None

    def envelope(self) -> dict[str, Any] | None:
        if self.config.role != "vps-exporter":
            return None
        try:
            path = self.config.collector.marker_path
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode) or path.is_symlink() or stat.S_IMODE(mode) & 0o022:
                return None
            marker = RuntimeMarker.from_mapping(
                json.loads(path.read_text(encoding="utf-8"))
            )
        except Exception:
            return None
        return {
            "schema_version": 1,
            "status": self.status(),
            "marker": marker.to_mapping(),
        }

    def static(self, request_path: str) -> tuple[bytes, str] | None:
        if self.config.role != "mac-desktop":
            return None
        path = urlsplit(request_path).path
        relative = "index.html" if path == "/" else path.lstrip("/")
        if not relative or not _SAFE_STATIC.fullmatch(relative):
            return None
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts:
            return None
        root = self.config.web_root.resolve(strict=True)
        candidate = root.joinpath(*pure.parts)
        try:
            if candidate.is_symlink() or not candidate.is_file():
                return None
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
            if resolved.stat().st_size > 10 * 1024 * 1024:
                return None
            payload = resolved.read_bytes()
        except (OSError, ValueError):
            return None
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        return payload, content_type


def _handler(application: CompanionApplication):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ArthurCompanion/1"

        def log_message(self, format: str, *args: object) -> None:
            return

        def _headers(self, status: int, content_type: str, length: int) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
            )
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            path = urlsplit(self.path).path
            if path == "/api/companion-status":
                payload = (json.dumps(application.status(), sort_keys=True) + "\n").encode()
                self._headers(200, "application/json; charset=utf-8", len(payload))
                self.wfile.write(payload)
                return
            if path == "/api/companion-preview":
                value = application.preview()
                if value is None:
                    payload = b'{"available":false}\n'
                else:
                    payload = (json.dumps(value, sort_keys=True) + "\n").encode()
                self._headers(200, "application/json; charset=utf-8", len(payload))
                self.wfile.write(payload)
                return
            if path == "/api/companion-envelope":
                value = application.envelope()
                if value is not None:
                    payload = (json.dumps(value, sort_keys=True) + "\n").encode()
                    self._headers(200, "application/json; charset=utf-8", len(payload))
                    self.wfile.write(payload)
                    return
            static = application.static(self.path)
            if static is None:
                payload = b"not found\n"
                self._headers(404, "text/plain; charset=utf-8", len(payload))
                self.wfile.write(payload)
                return
            payload, content_type = static
            self._headers(200, content_type, len(payload))
            self.wfile.write(payload)

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    config = load_config(args.config)
    application = CompanionApplication(config)
    if args.once:
        print(json.dumps(application.status(), ensure_ascii=False, sort_keys=True))
        return 0
    server = ThreadingHTTPServer((config.listen_host, config.port), _handler(application))
    server.serve_forever(poll_interval=0.5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
