#!/usr/bin/env bash
# Starts a local SOCKS5 proxy (127.0.0.1:$LOCAL_SOCKS_PORT) tunneled over SSH
# to the VPS. Point the Escape Hatch extension's options page at
# 127.0.0.1:$LOCAL_SOCKS_PORT (SOCKS5) while this is running.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f tunnel.env ]]; then
  echo "Missing scripts/tunnel.env — copy tunnel.env.example to tunnel.env and fill it in." >&2
  exit 1
fi
source tunnel.env

PIDFILE="/tmp/escapehatch-tunnel.pid"
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Tunnel already running (pid $(cat "$PIDFILE"))."
  exit 0
fi

ssh -D "$LOCAL_SOCKS_PORT" -N -f \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -p "$VPS_PORT" -i "$SSH_KEY" \
  "$VPS_USER@$VPS_IP"

# `-f` backgrounds ssh itself; recover its pid via pgrep for the pidfile.
sleep 1
pgrep -f "ssh -D $LOCAL_SOCKS_PORT -N -f.*$VPS_USER@$VPS_IP" | head -n1 > "$PIDFILE"

echo "SOCKS5 proxy up at 127.0.0.1:$LOCAL_SOCKS_PORT (tunneled via $VPS_USER@$VPS_IP:$VPS_PORT)."
