"""Run the desktop pet on its own: no VPS, no Arthur runtime.

His day comes from ``schedule_life`` (a mechanical, probability-driven
routine) and is served in exactly the status format the pet reads from the
real Arthur, alongside the page itself::

    python3 -m desktop_companion.standalone            # http://127.0.0.1:15174
    python3 -m desktop_companion.standalone --port 15174 --life ~/.arthur-pet/life.json

Point the macOS app (or a browser) at that address.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from desktop_companion.schedule_life import ScheduleLife
from desktop_companion.status_sources import _safe_arthur
from vps_runtime.switch.companion_status import (
    DEFAULT_STALE_AFTER_MS,
    SCHEMA_VERSION,
    ProjectionBinding,
    _timestamp,
    validate_companion_status,
)

WEB_ROOT = Path(__file__).with_name("web")
_SAFE_STATIC = re.compile(r"^[A-Za-z0-9_./-]{1,200}$")
# A fixed identity for "the schedule", in the shape the status contract wants.
_BINDING = ProjectionBinding(
    "mac", 1, "switch-to-mac-standalone-schedule",
    hashlib.sha256(b"arthur-desktop-pet standalone schedule").hexdigest(),
)


def status_document(life: ScheduleLife, now: datetime | None = None) -> dict:
    """One strict companion-status document for his day right now."""
    observed = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    life.advance(observed.astimezone())
    arthur = _safe_arthur(life.as_state(observed.astimezone()), _BINDING, observed)
    stamp = _timestamp(observed)
    document = {
        "schema_version": SCHEMA_VERSION,
        "observed_at": stamp,
        "selection": {
            "phase": "stable",
            "host": _BINDING.target,
            "generation": _BINDING.generation,
            "runtime_generation_id": _BINDING.runtime_generation_id,
            "transition_id": _BINDING.transition_id,
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
        "maintenance": {"health": "healthy"},
        "freshness": {"source_age_ms": 0, "stale_after_ms": DEFAULT_STALE_AFTER_MS, "stale": False},
    }
    if arthur.activity_detail != "unknown":
        document["arthur"]["activity"]["detail"] = arthur.activity_detail
    if arthur.weather_sky != "unknown" or arthur.weather_temp != "unknown":
        document["arthur"]["weather"] = {"sky": arthur.weather_sky, "temp": arthur.weather_temp}
    if arthur.fairies != "none":
        document["arthur"]["fairies"] = arthur.fairies
    return validate_companion_status(document)


def _static(request_path: str, web_root: Path) -> tuple[bytes, str] | None:
    path = urlsplit(request_path).path
    relative = "index.html" if path == "/" else path.lstrip("/")
    if not relative or not _SAFE_STATIC.fullmatch(relative):
        return None
    pure = PurePosixPath(relative)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    root = web_root.resolve(strict=True)
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
    return payload, mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"


def make_handler(life: ScheduleLife, web_root: Path = WEB_ROOT):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ArthurCompanionStandalone/1"

        def log_message(self, format: str, *args: object) -> None:   # quiet
            return

        def _send(self, status: int, content_type: str, payload: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
            )
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            path = urlsplit(self.path).path
            if path == "/api/companion-status":
                payload = (json.dumps(status_document(life), sort_keys=True) + "\n").encode()
                self._send(200, "application/json; charset=utf-8", payload)
                return
            if path in {"/api/companion-preview", "/api/companion-envelope"}:
                self._send(200, "application/json; charset=utf-8", b'{"available":false}\n')
                return
            static = _static(self.path, web_root)
            if static is None:
                self._send(404, "text/plain; charset=utf-8", b"not found\n")
                return
            self._send(200, static[1], static[0])

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=15174)
    parser.add_argument("--life", type=Path, default=Path.home() / ".arthur-desktop-pet" / "life.json",
                        help="where his day is kept between runs")
    args = parser.parse_args(argv)
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("standalone mode only listens on this computer")
    life = ScheduleLife(args.life.expanduser())
    server = ThreadingHTTPServer((args.host, args.port), make_handler(life))
    print(f"Arthur (standalone) at http://{args.host}:{args.port}/  — his day is kept in {args.life}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
