#!/usr/bin/env bash
set -euo pipefail
PIDFILE="/tmp/escapehatch-tunnel.pid"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")"
  rm -f "$PIDFILE"
  echo "Tunnel stopped."
else
  echo "No running tunnel found."
fi
