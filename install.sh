#!/usr/bin/env bash
# One-line installer for eSMS Workspace on macOS.
#   curl -fsSL https://raw.githubusercontent.com/eSMS-Africa/esms-workspace/main/install.sh | bash
# Downloads the latest .dmg, installs to /Applications, de-quarantines (the app
# isn't notarized yet), and launches it.
set -euo pipefail

URL="https://github.com/eSMS-Africa/esms-workspace/releases/latest/download/eSMS-Workspace-mac-universal.dmg"
APP="/Applications/eSMS Workspace.app"
TMP="$(mktemp -d)"
DMG="$TMP/esms-workspace.dmg"

echo "→ Downloading eSMS Workspace…"
curl -fsSL "$URL" -o "$DMG"

echo "→ Mounting…"
MP="$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/[^[:cntrl:]]*' | tail -1)"

echo "→ Installing to /Applications…"
rm -rf "$APP"
cp -R "$MP/eSMS Workspace.app" /Applications/
hdiutil detach "$MP" -quiet || true

echo "→ De-quarantining…"
xattr -cr "$APP" || true

rm -rf "$TMP"
echo "✓ Installed. Launching…"
open "$APP"
