#!/bin/bash
# Tests whether Cloudflare DNS/WARP endpoints are reachable/blocked on the current network.
# Run this while connected to the network you want to test (e.g. school wifi), then share
# the output file back.

OUT="${1:-dns_block_test_results.txt}"

{
  echo "===== DNS Block Test ====="
  echo "Date: $(date)"
  echo "Network: $(networksetup -getairportnetwork en0 2>/dev/null || echo unknown)"
  echo

  echo "--- Current system DNS resolution of 1.1.1.1 (reverse) ---"
  nslookup 1.1.1.1 2>&1
  echo

  echo "--- Can we resolve example.com via system DNS at all? ---"
  nslookup example.com 2>&1
  echo

  echo "--- 1.1.1.1 DoH endpoint (HTTPS, port 443) ---"
  curl -sS -o /dev/null -w "HTTP %{http_code}, time %{time_total}s\n" --max-time 5 https://1.1.1.1/ 2>&1
  echo

  echo "--- 1.0.0.1 (secondary) ---"
  curl -sS -o /dev/null -w "HTTP %{http_code}, time %{time_total}s\n" --max-time 5 https://1.0.0.1/ 2>&1
  echo

  echo "--- DoH query test: resolve example.com via Cloudflare DoH ---"
  curl -sS --max-time 5 -H 'accept: application/dns-json' 'https://1.1.1.1/dns-query?name=example.com&type=A' 2>&1
  echo
  echo

  echo "--- Plain UDP/53 DNS query to 1.1.1.1 (dig) ---"
  dig +time=3 +tries=1 @1.1.1.1 example.com 2>&1 | tail -8
  echo

  echo "--- Plain UDP/53 DNS query to 8.8.8.8 (Google, for comparison) ---"
  dig +time=3 +tries=1 @8.8.8.8 example.com 2>&1 | tail -8
  echo

  echo "--- Cloudflare WARP registration endpoint (engage.cloudflareclient.com) ---"
  curl -sS -o /dev/null -w "HTTP %{http_code}, time %{time_total}s\n" --max-time 5 https://engage.cloudflareclient.com/ 2>&1
  echo

  echo "--- WARP UDP endpoint reachability (port 2408, via nc) ---"
  if command -v nc >/dev/null 2>&1; then
    nc -zvu -w3 162.159.192.1 2408 2>&1
  else
    echo "nc not available, skipping"
  fi
  echo

  echo "--- DoH via Google (8.8.8.8) for comparison ---"
  curl -sS -o /dev/null -w "HTTP %{http_code}, time %{time_total}s\n" --max-time 5 https://8.8.8.8/ 2>&1
  echo

  echo "--- Traceroute to 1.1.1.1 (first 8 hops, may reveal where it's blocked) ---"
  traceroute -m 8 -w 2 1.1.1.1 2>&1
  echo

  echo "===== End of test ====="
} > "$OUT" 2>&1

echo "Results written to: $(realpath "$OUT")"
