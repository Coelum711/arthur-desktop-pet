#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: build_app.sh DESTINATION.app" >&2
  exit 2
fi

DESTINATION="$1"
if [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then
  echo "destination already exists: $DESTINATION" >&2
  exit 1
fi
case "$DESTINATION" in
  *.app) ;;
  *) echo "destination must end in .app" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENTS="$DESTINATION/Contents"
MACOS="$CONTENTS/MacOS"
ARTHUR_COMPANION_CACHE="$(mktemp -d "${TMPDIR:-/tmp}/arthur-companion-build.XXXXXX")"
trap 'rm -rf "$ARTHUR_COMPANION_CACHE"' EXIT
install -d -m 0755 "$MACOS"
install -m 0644 "$SCRIPT_DIR/Info.plist" "$CONTENTS/Info.plist"
env \
  CLANG_MODULE_CACHE_PATH="$ARTHUR_COMPANION_CACHE/clang" \
  SWIFT_MODULECACHE_PATH="$ARTHUR_COMPANION_CACHE/swift" \
  xcrun swiftc \
  -parse-as-library \
  -O \
  -framework AppKit \
  -framework WebKit \
  "$SCRIPT_DIR/ArthurDesktopCompanion.swift" \
  -o "$MACOS/ArthurDesktopCompanion"
chmod 0755 "$MACOS/ArthurDesktopCompanion"
plutil -lint "$CONTENTS/Info.plist" >/dev/null
codesign --force --sign - "$DESTINATION" >/dev/null
echo "$DESTINATION"
