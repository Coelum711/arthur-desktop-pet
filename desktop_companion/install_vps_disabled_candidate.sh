#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "--execute" ]; then
  echo "dry boundary: pass --execute and an exact source root" >&2
  exit 2
fi
SOURCE_ROOT="${2:-}"
if [ ! -d "$SOURCE_ROOT/desktop_companion" ] || [ ! -d "$SOURCE_ROOT/vps_runtime" ]; then
  echo "exact source root is incomplete" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "VPS candidate installation requires root" >&2
  exit 1
fi

INSTALL_ROOT="/opt/arthur-desktop-companion"
CONFIG_ROOT="/etc/arthur-desktop-companion"
UNIT="/etc/systemd/system/arthur-vps-companion-status.service"
for target in "$INSTALL_ROOT" "$CONFIG_ROOT" "$UNIT"; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "create-only VPS target already exists: $target" >&2
    exit 1
  fi
done

install -d -o root -g root -m 0755 "$INSTALL_ROOT/runtime"
cp -a "$SOURCE_ROOT/desktop_companion" "$INSTALL_ROOT/runtime/desktop_companion"
cp -a "$SOURCE_ROOT/vps_runtime" "$INSTALL_ROOT/runtime/vps_runtime"
if find "$INSTALL_ROOT/runtime" -type d -name __pycache__ -print -quit | grep -q .; then
  echo "source candidate unexpectedly contains Python bytecode caches" >&2
  exit 1
fi
install -d -o root -g arthur-vps -m 0750 "$CONFIG_ROOT"
install -o root -g arthur-vps -m 0640 \
  "$SOURCE_ROOT/desktop_companion/config.vps.example.json" \
  "$CONFIG_ROOT/config.vps.json"
install -o root -g root -m 0644 \
  "$SOURCE_ROOT/desktop_companion/systemd/arthur-vps-companion-status.service" \
  "$UNIT"
systemctl daemon-reload
if systemctl is-enabled arthur-vps-companion-status.service >/dev/null 2>&1; then
  echo "disabled-candidate invariant failed: unit became enabled" >&2
  exit 1
fi
if systemctl is-active arthur-vps-companion-status.service >/dev/null 2>&1; then
  echo "disabled-candidate invariant failed: unit became active" >&2
  exit 1
fi
echo "VPS companion exporter installed as inactive and disabled candidate"
