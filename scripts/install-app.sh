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

rm -rf "$DEST"
ditto "$SRC" "$DEST"
touch "$DEST"

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$DEST" >/dev/null
fi
mdimport "$DEST" >/dev/null 2>&1 || true

echo "$DEST"

# Bring the overlay back so the user does not have to hit the hotkey.
sleep 0.3
nohup "$DEST/Contents/MacOS/RocMindSpark" --show >/dev/null 2>&1 &
echo "relaunched"
