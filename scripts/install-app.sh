#!/usr/bin/env bash
# Put the overlay app where Spotlight / Raycast look: /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist/Roc Mind Spark.app"
PREFIX="${1:-/Applications}"
DEST="$PREFIX/Roc Mind Spark.app"
DEST_BIN="$DEST/Contents/MacOS/RocMindSpark"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

# shellcheck source=installed-app-process.sh
source "$ROOT/scripts/installed-app-process.sh"

if [[ ! -d "$SRC" ]]; then
  echo "missing $SRC — run: make app" >&2
  exit 1
fi

# Stop only the already-installed overlay whose text executable is DEST_BIN.
# SIGTERM is converted inside the app to NSApp.terminate(nil), which runs
# applicationWillTerminate and waits for the held Node child. Do not kill Node.
# APP_STOP_WAIT_SECONDS (10) is strictly greater than HeldProcessStop's
# worst-case 5s graceful + 1s SIGKILL of the held Node.
stop_exact_installed_app "$DEST_BIN" "$APP_STOP_WAIT_SECONDS"

# Give that child a bounded window to release 3034. Wait/report only.
if ! wait_port_idle 3034 5; then
  occupied="$(report_port_listeners 3034 || true)"
  echo "port 3034 still occupied (pid ${occupied}); leaving it running. The new app will not take it over." >&2
fi

can_write_dest() {
  [[ -w "$PREFIX" ]] && { [[ ! -e "$DEST" ]] || [[ -w "$DEST" ]]; }
}

if can_write_dest; then
  rm -rf "$DEST"
  mv "$SRC" "$DEST"
else
  echo "Need your password to install into $PREFIX"
  sudo rm -rf "$DEST"
  sudo mv "$SRC" "$DEST"
fi
touch "$DEST"

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$DEST" >/dev/null
fi
mdimport "$DEST" >/dev/null 2>&1 || true

echo "$DEST"

# LaunchServices, so the process survives the install script exiting.
sleep 0.3
open "$DEST" --args --show
echo "relaunched"
