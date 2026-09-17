#!/usr/bin/env bash
# Starts (or creates) the escapehatch-proxy GitHub Codespace, makes sure the
# SOCKS5 proxy inside it is running, and opens a local port-forward so
# 127.0.0.1:1080 on this machine reaches it. Point the extension's options
# page at 127.0.0.1:1080 (SOCKS5) and leave this running while you need it.
set -euo pipefail
cd "$(dirname "$0")"
source lib.sh

REPO="Comiclyy/escapehatch-proxy"
LOCAL_SOCKS_PORT="1080"
STATE_FILE="/tmp/escapehatch-codespace-name"
FWD_PIDFILE="/tmp/escapehatch-codespace-forward.pid"

log "=== netproxy start ==="

if ! command -v gh &>/dev/null; then
  log "ERROR: gh CLI not found. Install it with: brew install gh"
  exit 1
fi
if ! gh auth status &>/dev/null; then
  log "ERROR: not logged into gh. Run: gh auth login --web -s codespace"
  exit 1
fi

NAME=$(gh codespace list -R "$REPO" --json name -q '.[0].name' 2>/dev/null || true)
if [[ -z "$NAME" ]]; then
  log "No existing codespace found — creating one..."
  NAME=$(gh codespace create -R "$REPO" --machine basicLinux32gb)
  log "Created codespace: $NAME"
fi
echo "$NAME" > "$STATE_FILE"
log "Using codespace: $NAME"

CURRENT_STATE=$(gh codespace list --json name,state -q ".[] | select(.name==\"$NAME\") | .state")
log "Current state: $CURRENT_STATE"
if [[ "$CURRENT_STATE" != "Available" ]]; then
  log "Sending start request..."
  gh api --method POST "/user/codespaces/$NAME/start" >/dev/null
fi

log "Waiting for it to be available..."
for _ in $(seq 1 30); do
  STATE=$(gh codespace list --json name,state -q ".[] | select(.name==\"$NAME\") | .state")
  if [[ "$STATE" == "Available" ]]; then
    break
  fi
  sleep 5
done
if [[ "$STATE" != "Available" ]]; then
  log "ERROR: codespace didn't reach Available state (last state: $STATE)."
  exit 1
fi
log "Codespace is Available."

log "Ensuring the SOCKS5 proxy is running inside the codespace..."
REPO_NAME="${REPO#*/}"
gh codespace ssh -c "$NAME" -- "bash /workspaces/$REPO_NAME/.devcontainer/start-proxy.sh" 2>&1 | tee -a "$LOG_FILE"

if [[ -f "$FWD_PIDFILE" ]] && kill -0 "$(cat "$FWD_PIDFILE")" 2>/dev/null; then
  log "Port forward already running (pid $(cat "$FWD_PIDFILE"))."
else
  nohup gh codespace ports forward "$LOCAL_SOCKS_PORT:$LOCAL_SOCKS_PORT" -c "$NAME" \
    > /tmp/escapehatch-codespace-forward.log 2>&1 &
  echo $! > "$FWD_PIDFILE"
  log "Started port forward (pid $(cat "$FWD_PIDFILE")); log at /tmp/escapehatch-codespace-forward.log"
  sleep 3
fi

log "SOCKS5 proxy ready at 127.0.0.1:$LOCAL_SOCKS_PORT (via codespace $NAME)."
