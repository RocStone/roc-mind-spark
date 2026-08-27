#!/usr/bin/env bash
# Identify the *installed overlay app* by exact text executable path.
#
# Ownership is never "a Node whose args contain server.js". This helper
# only stops PIDs whose txt executable equals DEST's RocMindSpark.
# After SIGTERM it waits so applicationWillTerminate can stop the app's
# own Node child. SIGKILL is only for an App PID that is still that
# exact executable after the wait. Never kill Node.
# Bash 3.2 compatible. No mapfile.

txt_output_has_exact_path() {
  local want="$1"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" = "n${want}" ] && return 0
  done
  return 1
}

pid_is_running() {
  local pid="$1"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

pid_has_exact_executable() {
  local pid="$1"
  local want="$2"
  local out
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ -n "$want" ] || return 1
  out="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null || true)"
  printf '%s\n' "$out" | txt_output_has_exact_path "$want"
}

# Keep PIDs that still exist and are still the DEST overlay binary.
# A reused PID whose executable changed is dropped (no SIGKILL).
filter_still_exact_app_pids() {
  local dest_bin="$1"
  shift
  local pid
  for pid in "$@"; do
    if pid_is_running "$pid" && pid_has_exact_executable "$pid" "$dest_bin"; then
      printf '%s\n' "$pid"
    fi
  done
}

list_exact_app_pids() {
  local dest_bin="$1"
  local pids
  [ -n "$dest_bin" ] || return 0
  pids="$(pgrep -x RocMindSpark 2>/dev/null || true)"
  # shellcheck disable=SC2086
  filter_still_exact_app_pids "$dest_bin" $pids
}

# App-stop wait must exceed HeldProcessStop.gracefulSeconds (5) +
# killSeconds (1) = 6s. 10s leaves scheduling slack so this script does
# not SIGKILL the App while it is still force-stopping its held Node.
APP_STOP_WAIT_SECONDS=10

# Re-check the exact executable immediately before SIGTERM. This avoids
# signaling a PID that exited or was reused after the initial candidate list.
terminate_if_still_exact_app() {
  local pid="$1"
  local dest_bin="$2"
  if pid_is_running "$pid" && pid_has_exact_executable "$pid" "$dest_bin"; then
    kill "$pid" 2>/dev/null || true
  fi
}

# Wait until no exact DEST app PIDs remain. Return 1 if any remain at timeout.
# Does not send signals. Default wait is APP_STOP_WAIT_SECONDS.
wait_exact_app_exit() {
  local dest_bin="$1"
  local timeout_sec="${2:-$APP_STOP_WAIT_SECONDS}"
  local remaining now deadline
  deadline=$(( $(date +%s) + timeout_sec ))
  while :; do
    remaining="$(list_exact_app_pids "$dest_bin")"
    [ -z "$remaining" ] && return 0
    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.1
  done
}

# SIGTERM exact DEST app PIDs, wait for a graceful exit so
# applicationWillTerminate can stop the app's Node child, then SIGKILL
# only leftovers that still match DEST_BIN.
# $1 = absolute path of $DEST/Contents/MacOS/RocMindSpark
# $2 = optional wait seconds (default APP_STOP_WAIT_SECONDS)
stop_exact_installed_app() {
  local dest_bin="$1"
  local timeout_sec="${2:-$APP_STOP_WAIT_SECONDS}"
  local pid remaining
  [ -n "$dest_bin" ] || return 0
  remaining="$(list_exact_app_pids "$dest_bin")"
  for pid in $remaining; do
    terminate_if_still_exact_app "$pid" "$dest_bin"
  done
  if wait_exact_app_exit "$dest_bin" "$timeout_sec"; then
    return 0
  fi
  remaining="$(list_exact_app_pids "$dest_bin")"
  for pid in $remaining; do
    if pid_is_running "$pid" && pid_has_exact_executable "$pid" "$dest_bin"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

report_port_listeners() {
  local port="${1:-3034}"
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

# Wait until nothing listens on the port. Report-only; never kills.
# Return 1 if still occupied at timeout.
wait_port_idle() {
  local port="${1:-3034}"
  local timeout_sec="${2:-5}"
  local occupied now deadline
  deadline=$(( $(date +%s) + timeout_sec ))
  while :; do
    occupied="$(report_port_listeners "$port" || true)"
    [ -z "$occupied" ] && return 0
    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.1
  done
}
