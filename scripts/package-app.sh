#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/macos/.build/release/RocMindSpark"
APP="$ROOT/dist/Roc Mind Spark.app"
CONTENTS="$APP/Contents"

if [[ ! -x "$BIN" ]]; then
  echo "missing $BIN — run: make build" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/web"

cp "$BIN" "$CONTENTS/MacOS/RocMindSpark"
cp "$ROOT/macos/Info.plist" "$CONTENTS/Info.plist"

# Runtime only needs the HTTP server and the existing frontend.
rsync -a \
  --exclude 'data' \
  --exclude 'test' \
  --exclude 'docs' \
  --exclude 'worker' \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'node_modules' \
  --exclude 'server.log' \
  --exclude 'package-lock.json' \
  "$ROOT/web/server.js" "$CONTENTS/Resources/web/server.js"
cp "$ROOT/web/ops-log.js" "$CONTENTS/Resources/web/ops-log.js"
cp "$ROOT/web/map-images.js" "$CONTENTS/Resources/web/map-images.js"
cp "$ROOT/web/listen-bind.js" "$CONTENTS/Resources/web/listen-bind.js"
rsync -a "$ROOT/web/public/" "$CONTENTS/Resources/web/public/"

if [[ -f "$ROOT/web/public/icon-512.png" ]]; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  SRC="$ROOT/web/public/icon-512.png"
  for spec in 16 32 64 128 256 512; do
    sips -z "$spec" "$spec" "$SRC" --out "$ICONSET/icon_${spec}x${spec}.png" >/dev/null
    dub=$((spec * 2))
    if [[ $dub -le 1024 ]]; then
      sips -z "$dub" "$dub" "$SRC" --out "$ICONSET/icon_${spec}x${spec}@2x.png" >/dev/null
    fi
  done
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
  cp "$SRC" "$CONTENTS/Resources/AppIcon.png"
fi

cp "$ROOT/LICENSE" "$CONTENTS/Resources/LICENSE"
cp "$ROOT/NOTICE" "$CONTENTS/Resources/NOTICE"

chmod +x "$CONTENTS/MacOS/RocMindSpark"
codesign --force --deep --sign - "$APP" >/dev/null
echo "$APP"
