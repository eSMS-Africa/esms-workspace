#!/usr/bin/env bash
# One-line installer for eSMS Workspace on macOS.
#   curl -fsSL https://raw.githubusercontent.com/eSMS-Africa/esms-workspace/main/install.sh | bash
# Downloads the latest .dmg (with a visible progress bar), installs to
# /Applications, de-quarantines it (the app isn't notarized yet), and launches.
set -euo pipefail

REPO="eSMS-Africa/esms-workspace"
ASSET="eSMS-Workspace-mac-universal.dmg"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
APP_NAME="eSMS Workspace.app"
DEST="/Applications"
TMP="$(mktemp -d)"
DMG="$TMP/esms-workspace.dmg"
MP=""

cleanup() {
  [ -n "$MP" ] && hdiutil detach "$MP" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }
step() { printf '\033[38;5;208m→\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }

[ "$(uname)" = "Darwin" ] || fail "This installer is for macOS. For Windows/Linux, download from https://esmsafrica.io/workspace"
command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."

printf '\n\033[1m  eSMS Workspace\033[0m  ·  macOS installer\n\n'

# Close a running copy so we can replace it cleanly.
if pgrep -f "$APP_NAME/Contents/MacOS/" >/dev/null 2>&1; then
  step "Closing the running app…"
  osascript -e 'quit app "eSMS Workspace"' >/dev/null 2>&1 || true
  sleep 1
fi

step "Downloading eSMS Workspace (~180 MB)…"
# Visible progress bar (-#) with retries for flaky networks, so the download
# never looks "stuck" even when this script is piped straight into bash.
if ! curl -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 -# "$URL" -o "$DMG"; then
  fail "Download failed. Check your connection, or download manually from https://esmsafrica.io/workspace"
fi

SIZE=$(stat -f%z "$DMG" 2>/dev/null || echo 0)
[ "$SIZE" -gt 10000000 ] || fail "The download looks incomplete (${SIZE} bytes). Please run the command again."
ok "Downloaded $(( SIZE / 1024 / 1024 )) MB"

step "Opening the disk image…"
MP="$(hdiutil attach "$DMG" -nobrowse -readonly 2>/dev/null | grep -o '/Volumes/[^[:cntrl:]]*' | tail -1)"
[ -n "$MP" ] && [ -d "$MP/$APP_NAME" ] || fail "Could not open the downloaded disk image."

# Prefer /Applications; fall back to ~/Applications if it isn't writable.
if [ ! -w "$DEST" ]; then
  mkdir -p "$HOME/Applications" 2>/dev/null && DEST="$HOME/Applications"
fi
step "Installing to $DEST…"
rm -rf "$DEST/$APP_NAME"
cp -R "$MP/$APP_NAME" "$DEST/" || fail "Couldn't copy the app into $DEST."

step "De-quarantining (the app isn't notarized yet)…"
xattr -cr "$DEST/$APP_NAME" >/dev/null 2>&1 || true

ok "Installed to $DEST/$APP_NAME"
step "Launching…"
open "$DEST/$APP_NAME" || true
printf '\n\033[32m  All set — eSMS Workspace is ready.\033[0m\n\n'
