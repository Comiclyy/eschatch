#!/usr/bin/env bash
# Stand-in for the real start/stop/test scripts while a fault is armed from
# the extension's Admin tab. Writes realistic log lines and fails the way the
# real scripts do, without touching the actual codespace/tunnel.
# Usage: fault-job.sh <mode> <action>
set -uo pipefail
source "$(dirname "$0")/../scripts/lib.sh"
MODE="$1"
ACTION="$2"
say() { log "$@" >/dev/null; }

say "=== netproxy $ACTION === [SIMULATED: $MODE]"
case "$MODE" in
  gh-logged-out)
    say "ERROR: not logged into gh. Run: gh auth login --web -s codespace"
    exit 1
    ;;
  exit-1)
    say "Using codespace: fictional-pancake-xq6rrx4w5qv2pjg7"
    echo "fatal: unexpected response from GitHub API (HTTP 502)" >&2
    exit 1
    ;;
  codespace-timeout)
    say "Using codespace: fictional-pancake-xq6rrx4w5qv2pjg7"
    say "Current state: Shutdown"
    say "Sending start request..."
    for i in 1 2 3 4 5; do say "Waiting for it to be available... ($i/5)"; sleep 2; done
    say "ERROR: codespace didn't reach Available state (last state: Starting)."
    exit 1
    ;;
  slow-start)
    say "Using codespace: fictional-pancake-xq6rrx4w5qv2pjg7"
    for i in $(seq 1 10); do say "Waiting for it to be available... ($i/10)"; sleep 3; done
    say "Codespace is Available. (simulated — real server state unchanged)"
    exit 0
    ;;
  hang)
    say "Waiting for it to be available... (this simulated job never finishes — use Cancel)"
    sleep 600
    exit 0
    ;;
  *)
    say "ERROR: unknown simulated fault '$MODE'"
    exit 2
    ;;
esac
