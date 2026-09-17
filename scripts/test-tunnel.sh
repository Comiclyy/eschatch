#!/usr/bin/env bash
# Verifies the SOCKS5 tunnel is actually working by fetching a URL through it.
set -euo pipefail
cd "$(dirname "$0")"
source tunnel.env

echo "Fetching ifconfig.me through the tunnel (should show the VPS's IP, not yours)..."
curl -s --socks5-hostname "127.0.0.1:$LOCAL_SOCKS_PORT" https://ifconfig.me
echo
echo "For comparison, your direct IP is:"
curl -s https://ifconfig.me
echo
