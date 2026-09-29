#!/usr/bin/env bash
# Registers the netproxy native messaging host with Chrome/Edge/Brave/Chromium/Vivaldi/Arc
# so the Escape Hatch extension can start/stop the proxy server.
#
# Usage: native-host/install.sh <extension-id>
# The extension ID is shown on chrome://extensions (or vivaldi://extensions, edge://extensions)
# and on the extension's Options page under "Proxy server".
set -euo pipefail
cd "$(dirname "$0")"

EXT_ID="${1:-}"
if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: $0 <extension-id>   (32 chars a-p, from the extensions page)" >&2
  exit 1
fi

HOST_NAME="com.escapehatch.netproxy"
HOST_SCRIPT="$(pwd)/netproxy_host.py"
PYTHON="$(command -v python3)"
chmod +x "$HOST_SCRIPT"

# Browsers launch hosts with a minimal PATH, so pin the python3 we found now.
WRAPPER="$(pwd)/netproxy_host"
cat > "$WRAPPER" <<WRAP
#!/bin/sh
exec "$PYTHON" "$HOST_SCRIPT" "\$@"
WRAP
chmod +x "$WRAPPER"

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Escape Hatch netproxy server control",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)

APP_SUPPORT="$HOME/Library/Application Support"
installed=0
for browser_dir in "Google/Chrome" "Microsoft Edge" "BraveSoftware/Brave-Browser" "Chromium" "Vivaldi" "Arc/User Data"; do
  if [[ -d "$APP_SUPPORT/$browser_dir" ]]; then
    dest="$APP_SUPPORT/$browser_dir/NativeMessagingHosts"
    mkdir -p "$dest"
    echo "$MANIFEST" > "$dest/$HOST_NAME.json"
    echo "Installed for $browser_dir -> $dest/$HOST_NAME.json"
    installed=1
  fi
done

if [[ $installed -eq 0 ]]; then
  echo "No supported browser profile directory found." >&2
  exit 1
fi
echo "Done. Reload the extension, then use the Start button in its popup."
