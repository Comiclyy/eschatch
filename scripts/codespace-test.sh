#!/usr/bin/env bash
# Verifies the codespace SOCKS5 tunnel is actually working.
set -euo pipefail
cd "$(dirname "$0")"
source lib.sh

LOCAL_SOCKS_PORT="1080"

log "=== netproxy test ==="
PROXIED_IP=$(curl -s --max-time 8 --socks5-hostname "127.0.0.1:$LOCAL_SOCKS_PORT" https://ifconfig.me || echo "FAILED")
DIRECT_IP=$(curl -s --max-time 8 https://ifconfig.me || echo "FAILED")
log "Proxied IP: $PROXIED_IP"
log "Direct IP:  $DIRECT_IP"

if [[ "$PROXIED_IP" == "FAILED" ]]; then
  log "ERROR: could not reach ifconfig.me through the tunnel — is it started? (netproxy start)"
  exit 1
elif [[ "$PROXIED_IP" == "$DIRECT_IP" ]]; then
  log "WARNING: proxied IP matches direct IP — traffic may not be going through the tunnel."
else
  log "OK: proxied traffic is exiting through the codespace."
fi
