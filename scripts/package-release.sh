#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Roc Mind Spark.app"
PLIST="$ROOT/macos/Info.plist"
if [[ ! -d "$APP" ]]; then
  echo "missing $APP — run: make app" >&2
  exit 1
fi

BIN="$APP/Contents/MacOS/RocMindSpark"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ARCHS="$(lipo -archs "$BIN")"
ASSET_NAME="Roc-Mind-Spark-v${VERSION}-macos-arm64.zip"
ARCHIVE="$ROOT/dist/$ASSET_NAME"
CHECKSUM="$ARCHIVE.sha256"

if [[ "$ARCHS" != "arm64" ]]; then
  echo "expected an arm64-only release binary, got: $ARCHS" >&2
  exit 1
fi

if [[ "$APP_VERSION" != "$VERSION" ]]; then
  echo "source plist version $VERSION does not match packaged app version $APP_VERSION" >&2
  exit 1
fi

codesign --verify --deep --strict "$APP"

rm -f "$ARCHIVE" "$CHECKSUM"
(
  cd "$ROOT/dist"
  ditto -c -k --keepParent --sequesterRsrc "Roc Mind Spark.app" "$ASSET_NAME"
  shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256"
)

echo "$ARCHIVE"
echo "$CHECKSUM"
