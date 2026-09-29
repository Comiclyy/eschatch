# Escape Hatch documentation

Escape Hatch is a browser extension that sends **only the sites you choose**
through a SOCKS5 proxy. Everything else connects directly, as normal. It can
also start, stop and watch the proxy server itself, so you rarely need a
terminal.

The proxy is a small SOCKS5 server on `127.0.0.1:1080`. It is tunnelled either
to a GitHub Codespace or to your own VPS over SSH. Traffic for listed sites
leaves from there instead of from the network you're on.

| Page | Read it when… |
| --- | --- |
| [Setup](setup.md) | You're installing it for the first time, or on a new browser. |
| [Features](features.md) | You want to know what the popup, dashboard, badge and notifications do. |
| [How it works](how-it-works.md) | You want the moving parts: extension, helper, scripts, and how they talk. |
| [Errors & troubleshooting](errors.md) | Something's red, a site won't load, or the Start button does nothing. |
| [Admin tab](admin.md) | You want to fake failures to test error handling or styling. |
| [Development](development.md) | You're changing the code: previews, tests, file layout, conventions. |

## At a glance

```
 you click "Route through proxy"          you click "Start server"
            │                                        │
            ▼                                        ▼
   ┌──────────────────┐   native messaging   ┌──────────────────┐
   │ Escape Hatch      │ ───────────────────▶ │ netproxy helper  │
   │ (browser)         │ ◀─────────────────── │ (Python, local)  │
   └──────────────────┘   status / log       └────────┬─────────┘
            │ PAC rules: listed sites → SOCKS5          │ runs
            ▼                                          ▼
   127.0.0.1:1080  ◀──── SSH / gh port-forward ──── scripts/*.sh
            │
            ▼
   Codespace or VPS  ──▶  the site
```
