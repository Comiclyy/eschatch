# eschatch

Escape Hatch: a browser extension that routes specific sites through a SOCKS5
proxy, plus the scripts/infra used to stand up that proxy.

## Layout

- `extension/` — the "Escape Hatch" Manifest V3 browser extension:
  - `popup.html`/`popup.js` — the toolbar popup: route the current site
    through the proxy, start/stop the proxy server.
  - `options.html`/`options.js`/`admin.js` — the full-page dashboard
    (Overview, Sites, Server, Diagnostics, Logs, and a developer Admin tab).
  - `background.js` — applies the proxy rules, talks to the native host,
    watches server health, badge and notifications.
  - `ui.css` (shared components) / `dashboard.css` (dashboard layout).
- `scripts/` — helpers for running the SOCKS5 endpoint the extension talks to:
  - `start-tunnel.sh` / `stop-tunnel.sh` / `test-tunnel.sh` — open, close, and
    check a local SOCKS5 proxy (`127.0.0.1:1080`) tunneled over SSH to a VPS.
    Configure via `tunnel.env` (copy from `tunnel.env.example`).
  - `codespace-start.sh` / `codespace-stop.sh` / `codespace-test.sh` /
    `codespace-netlog.sh` — same idea, but backed by the `Comiclyy/escapehatch-proxy`
    GitHub Codespace (see `codespace-repo/` below) instead of a VPS.
  - `lib.sh` — shared logging helper (writes to `logs/netproxy.log`).
  - `netproxy` — CLI wrapper (`netproxy start|stop|test|status|log|sitelog|netlog`).
    Symlink it onto your PATH: `ln -s "$PWD/scripts/netproxy" ~/bin/netproxy`.
- `native-host/` — native messaging host (`netproxy_host.py`) that lets the
  extension start/stop/test the proxy server and read `logs/netproxy.log`.
  Register it once with `native-host/install.sh <extension-id>`.
  `fault-job.sh` is the stand-in script used by the Admin tab's fault injection.
- `tools/preview/shoot.sh` — renders the popup and every dashboard view to PNGs
  with headless Chrome (fake `chrome.*` API in `stub.js`), for reviewing UI
  changes without loading the extension.
- `tools/test/background-sim*.js` — runs `background.js` against a fake
  browser and helper and checks what the user would see. Run with macOS's
  JavaScriptCore (command at the top of `background-sim.js`).
- `vps-setup/setup-vps.sh` — one-time setup script to run on a fresh VPS
  (e.g. Oracle Cloud free tier) to create a restricted tunnel-only SSH user
  and make sshd also listen on 443, so the tunnel can blend in on networks
  that block port 22.
- `codespace-repo/` — a separate git repository/checkout (remote:
  `github.com/Comiclyy/escapehatch-proxy`) holding the devcontainer that runs
  the SOCKS5 proxy used by `codespace-*.sh`. It's excluded from this repo via
  `.gitignore` since it's already tracked and pushed on its own.
- `dns_block_test.sh` — standalone script to check whether a network blocks
  DNS-over-HTTPS/Cloudflare endpoints (useful for diagnosing why a network
  needs the escape hatch in the first place).

Full documentation: [`docs/`](docs/README.md) — setup, features, how it
works, errors & troubleshooting, the Admin tab, and development.

## Usage

1. Load `extension/` as an unpacked extension (`chrome://extensions`,
   `vivaldi://extensions`, … → Developer mode → Load unpacked).
2. Bring up a SOCKS5 proxy at `127.0.0.1:1080` with either:
   - `scripts/start-tunnel.sh` (direct SSH tunnel to your own VPS — set up the
     VPS first with `vps-setup/setup-vps.sh`), or
   - `scripts/codespace-start.sh` (spins up/reuses the GitHub Codespace in
     `codespace-repo/` instead).
3. In the dashboard's **Server** tab, set the endpoint to SOCKS5
   `127.0.0.1:1080`, then use the toolbar popup to route sites through it.

### Starting the server from the browser

Instead of running the scripts by hand, register the native host once:

```sh
native-host/install.sh <extension-id>   # exact command is on the dashboard's Server tab
```

then reload the extension. Supports Chrome, Edge, Brave, Chromium, Vivaldi and
Arc. The popup gets **Start/Stop server** (and "Route through proxy & start
server" when you add a site while it's down); the dashboard's **Server** tab has
backend choice, Start/Stop/Test/Cancel and a live tail of `logs/netproxy.log`.
Server output is also streamed into the extension's log as `SERVER` /
`SERVER-ERROR` entries.

### When something goes wrong

- **Toolbar badge:** `ON` = proxy up, `OFF` = sites are in the list but the
  proxy is down (they won't load), `…` = starting/stopping, `!` = server
  control can't be reached.
- **Popup / dashboard** show the problem in plain language with the fix (e.g.
  "GitHub CLI isn't logged in — run gh auth login ...").
- **Diagnostics** tab (or "Diagnose" in the popup) checks the
  helper, proxy endpoint, other extensions overriding the proxy, gh login,
  tunnel config, the port, and a real SOCKS5 handshake.
- **Desktop notifications** when a start/stop/test finishes or fails, and
  when the proxy drops unexpectedly (checked every minute and on proxy errors).
  Toggle on the Server tab.
- **Logs** tab: filter/search the extension log, or
  **Download logs** for one file with config, extension log and server log.
  On disk: `logs/netproxy.log` (scripts) and `logs/native-host.log` (every
  time the browser calls the helper — empty means the browser can't find it).

### Admin tab (testing error handling)

The dashboard's **Admin** tab (bottom of the sidebar) fakes failures so error
handling and styling can be checked without breaking anything. A purple
"Simulated" bar shows on every page while a simulation is active.

- **UI state override** — show a canned server state everywhere (running,
  starting, port open but proxy dead, start failed, helper missing, wrong
  extension ID, ...). Real health checks pause while it's on.
- **Helper faults** — make the real helper fail (gh logged out, script exit 1,
  codespace timeout, slow start, hang, crash, garbage reply, slow replies,
  status errors). Job faults run `native-host/fault-job.sh` instead of the real
  scripts, so the actual server isn't touched. Faults expire after 10 minutes.
- Fire any **notification** or **badge** state, **generate log entries**
  (bursts, long lines), and trigger the **unexpected drop** / **proxy error**
  handlers.
