# networkingproxy

Escape Hatch: a browser extension that routes specific sites through a SOCKS5
proxy, plus the scripts/infra used to stand up that proxy.

## Layout

- `extension/` — the "Escape Hatch" Manifest V3 browser extension. Lets you
  toggle a per-site proxy on/off (`popup.html`/`popup.js`), configure the
  SOCKS5 endpoint (`options.html`/`options.js`), and applies the proxy rules
  via `background.js`.
- `scripts/` — helpers for running the SOCKS5 endpoint the extension talks to:
  - `start-tunnel.sh` / `stop-tunnel.sh` / `test-tunnel.sh` — open, close, and
    check a local SOCKS5 proxy (`127.0.0.1:1080`) tunneled over SSH to a VPS.
    Configure via `tunnel.env` (copy from `tunnel.env.example`).
  - `codespace-start.sh` / `codespace-stop.sh` / `codespace-test.sh` /
    `codespace-netlog.sh` — same idea, but backed by the `Comiclyy/escapehatch-proxy`
    GitHub Codespace (see `codespace-repo/` below) instead of a VPS.
  - `lib.sh` — shared logging helper (writes to `logs/netproxy.log`).
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

## Usage

1. Load `extension/` as an unpacked extension (`chrome://extensions` →
   Developer mode → Load unpacked).
2. Bring up a SOCKS5 proxy at `127.0.0.1:1080` with either:
   - `scripts/start-tunnel.sh` (direct SSH tunnel to your own VPS — set up the
     VPS first with `vps-setup/setup-vps.sh`), or
   - `scripts/codespace-start.sh` (spins up/reuses the GitHub Codespace in
     `codespace-repo/` instead).
3. Point the extension's options page at `127.0.0.1:1080` (SOCKS5) and use the
   popup to toggle proxying per-site.
