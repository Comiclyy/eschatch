#!/usr/bin/env bash
# Tears down the local port forward and stops the Codespace to conserve your
# free monthly hours.
set -euo pipefail
cd "$(dirname "$0")"
source lib.sh

STATE_FILE="/tmp/escapehatch-codespace-name"
FWD_PIDFILE="/tmp/escapehatch-codespace-forward.pid"

log "=== netproxy stop ==="

if [[ -f "$FWD_PIDFILE" ]] && kill -0 "$(cat "$FWD_PIDFILE")" 2>/dev/null; then
  kill "$(cat "$FWD_PIDFILE")"
  rm -f "$FWD_PIDFILE"
  log "Port forward stopped."
fi

if [[ -f "$STATE_FILE" ]]; then
  NAME=$(cat "$STATE_FILE")
  gh codespace stop -c "$NAME" 2>&1 | tee -a "$LOG_FILE"
  log "Codespace $NAME stopped."
else
  log "No codespace name on record — nothing to stop."
fi
