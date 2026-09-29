#!/usr/bin/env bash
# Renders the popup and every dashboard view to PNGs with headless Chrome,
# using stub.js as a fake chrome.* API, so the UI can be reviewed without
# loading the extension. Output: tools/preview/out/*.png
#
# Usage: tools/preview/shoot.sh [name-filter]
#        tools/preview/shoot.sh --readme   # curated 2x shots into docs/images/
# (Headless Vivaldi hangs on --screenshot, so this uses Google Chrome.)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FILTER="${1:-}"
SCALE=1
README=0
if [[ "$FILTER" == "--readme" ]]; then
  README=1
  FILTER=""
  SCALE=2
  OUT="$REPO/docs/images"
fi

WORK="$(mktemp -d)"
trap 'command rm -rf "$WORK"' EXIT

# Work on a copy: the stub must never end up in the real extension files.
command cp -R "$REPO/extension" "$WORK/ext"
command cp "$HERE/stub.js" "$WORK/ext/stub.js"
for f in "$WORK/ext/options.html" "$WORK/ext/popup.html"; do
  sed -i '' 's#<script src="common.js">#<script src="stub.js"></script><script src="common.js">#' "$f"
done
mkdir -p "$OUT"

shot() { # name page size
  [[ -n "$FILTER" && "$1" != *"$FILTER"* ]] && return
  command rm -f "$OUT/$1.png"
  # No `timeout` on macOS; headless Chrome sometimes lingers after writing
  # the file, so cap it with perl's alarm.
  # (backgrounded + wait 2>/dev/null so bash stays quiet when the cap fires)
  perl -e 'alarm 25; exec @ARGV' "$CHROME" --headless=new --disable-gpu --no-first-run \
    --user-data-dir="$WORK/profile" --hide-scrollbars --virtual-time-budget=2000 \
    --window-size="$3" --force-device-scale-factor="$SCALE" --screenshot="$OUT/$1.png" "file://$WORK/ext/$2" >/dev/null 2>&1 &
  wait $! 2>/dev/null || true
  [[ -f "$OUT/$1.png" ]] && echo "  $1.png" || echo "  $1 FAILED"
}

echo "Writing to $OUT"
if [[ $README -eq 1 ]]; then
  shot dashboard   "options.html?s=running#overview"               1180,560
  shot popup       "popup.html?s=running&url=https://github.com/x"  300,322
  shot diagnostics "options.html?s=running#diagnostics"            1180,540
  shot logs        "options.html?s=running#logs"                   1180,640
  shot admin       "options.html?s=starting#admin"                 1180,1250
  exit 0
fi
shot overview        "options.html?s=running#overview"              1280,820
shot overview-failed "options.html?s=failed#overview"               1280,820
shot sites           "options.html?s=running#sites"                 1280,700
shot sites-missing   "options.html?s=missing#sites"                 1280,700
shot server          "options.html?s=failed#server"                 1280,1150
shot server-missing  "options.html?s=missing#server"                1280,900
shot diagnostics     "options.html?s=running#diagnostics"           1280,640
shot logs            "options.html?s=running#logs"                  1280,700
shot admin           "options.html?s=starting#admin"                1280,1250
shot popup-running   "popup.html?s=running&url=https://github.com/x" 300,430
shot popup-failed    "popup.html?s=failed"                          300,520
shot popup-starting  "popup.html?s=starting&url=https://example.org" 300,500
shot popup-missing   "popup.html?s=missing"                         300,480
