#!/usr/bin/env bash
# Live combined view of every log source on the proxy path:
#   - the local SSH port-forward's own log (tunnel drops/resets)
#   - the remote microsocks connection log (which domains actually got a
#     SOCKS5 connection accepted)
# Note: microsocks only logs SUCCESSFUL connects, not failures. If a domain
# never shows up here at all while you're testing it, the request never
# reached the proxy in the first place — look at the browser extension's own
# Log (Options page) instead, since the problem is upstream (PAC/extension)
# or the tunnel, not the Codespace's outbound connectivity.
set -euo pipefail

if [[ ! -f /tmp/escapehatch-codespace-name ]]; then
  echo "No codespace on record — run 'netproxy start' first." >&2
  exit 1
fi
NAME=$(cat /tmp/escapehatch-codespace-name)

echo "=== Combined netlog: local tunnel + remote microsocks (Ctrl+C to stop) ==="
echo "Codespace: $NAME"
echo

# Prefix each source's lines so they're distinguishable when interleaved.
( tail -n 20 -f /tmp/escapehatch-codespace-forward.log 2>/dev/null | sed -u 's/^/[tunnel] /' ) &
TUNNEL_TAIL_PID=$!

trap 'kill $TUNNEL_TAIL_PID 2>/dev/null' EXIT

gh codespace ssh -c "$NAME" -- "tail -n 20 -f /tmp/microsocks.log" 2>/dev/null | sed -u 's/^/[microsocks] /'
