#!/usr/bin/env bash
# Put the overlay app where Spotlight / Raycast look: /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist/Roc Mind Spark.app"
PREFIX="${1:-/Applications}"
DEST="$PREFIX/Roc Mind Spark.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ ! -d "$SRC" ]]; then
  echo "missing $SRC — run: make app" >&2
  exit 1
fi

# Stop a running copy so we can replace the bundle.
if pids="$(pgrep -x RocMindSpark)"; then
  echo "$pids" | while read -r pid; do kill "$pid" 2>/dev/null || true; done
  sleep 0.2
fi
if pids="$(pgrep -x RocMindSpark)"; then
  echo "$pids" | while read -r pid; do kill -9 "$pid" 2>/dev/null || true; done
  sleep 0.2
fi

# Drop the leftover node on 3034 so the next launch serves the new public/ files.
if npids="$(lsof -tiTCP:3034 -sTCP:LISTEN 2>/dev/null)"; then
  echo "$npids" | while read -r pid; do kill "$pid" 2>/dev/null || true; done
  sleep 0.2
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
