#!/usr/bin/env bash
# Trace the installed product with its existing maps. No fixture or second server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/installed-app-process.sh"
APP="/Applications/Roc Mind Spark.app"
TRACE_DIR="${1:-/tmp/rms-selection-$(date +%Y%m%d-%H%M%S)}"
case "$TRACE_DIR" in /*) ;; *) echo 'Trace directory must be absolute' >&2; exit 2 ;; esac
mkdir -p "$TRACE_DIR"
chmod 700 "$TRACE_DIR"
stop_exact_installed_app "$APP/Contents/MacOS/RocMindSpark"
open "$APP" --args --show "--selection-trace=$TRACE_DIR" --selection-trace-keep-visible
printf '%s\n' "$TRACE_DIR"
