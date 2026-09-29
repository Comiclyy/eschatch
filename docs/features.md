# Features

## Toolbar popup

Click the Escape Hatch icon in the toolbar.

**Current site**

- Shows the site you're on and whether it's *Routed through proxy* or
  *Direct · not proxied*.
- **Route through proxy** adds the site to the list and reloads the tab.
  - If the server is stopped, the button says **Route through proxy & start
    server** and does both in one click.
- **Stop routing this site** removes it again.
- The site is worked out from the address the tab is *trying* to load. That
  matters when a blocked page never finishes loading and the address bar still
  shows the previous page.

**Server**

- **Status line:** running, stopped, starting (with elapsed time), and so on.
- **Details line:** codespace name and uptime.
- **Start / Stop / Cancel:** Cancel appears while a start or stop is running.
- **Test:** checks that traffic really exits through the proxy.
- **Problem callout:** appears when something is wrong, with the fix in plain
  words.
- **Warning:** if the current site is routed but the server is stopped, a
  yellow *This site won't load* warning appears.
- **Last log line:** the last line of server output is shown underneath. It's
  hidden when it's an old error and the server is now healthy.

**Footer:** shortcuts to the Dashboard, Diagnostics and Logs.

The popup stays open while the server starts, so you can watch its progress.

## Toolbar badge

The badge shows proxy state without opening anything:

| Badge | Meaning |
| --- | --- |
| **ON** (green) | Proxy is up and answering as SOCKS5. |
| **OFF** (red) | You have sites in the list but the proxy is down. Those sites won't go through the proxy; see [the PAC note](how-it-works.md#routing-sites-through-the-proxy). |
| **OFF** (grey) | Proxy is down, but no sites are routed, so nothing is affected. |
| **…** (amber) | A start / stop / test is in progress. |
| **!** (red) | The extension can't reach the helper; see [Errors](errors.md#server-control-unavailable). |
| *(none)* | Status not checked yet (e.g. right after the browser starts). |

### Icon dot

A small dot in the icon's top-right corner shows the **codespace's** own state
as GitHub reports it. It's separate from the badge, which is about the proxy:
the codespace can be running, and using your free hours, while the proxy is
off.

| Dot | Codespace |
| --- | --- |
| Green | Running (`Available`). |
| Red | Shut down. |
| Amber | Starting, shutting down, or another in-between state. |
| *(none)* | SSH-tunnel backend (there's no codespace), or the state is unknown. |

The state is checked with GitHub at most once a minute, or every few seconds
while it's changing. The Overview's *Codespace state* row and the popup's
details line show the same thing in words.

## Dashboard

Open it by right-clicking the icon and choosing **Options**, or with the
popup's **Dashboard** button. Each sidebar tab takes over the whole page.
Keys **1–5** switch between the main tabs.

### Overview

- **Stats strip:**
  - server state
  - number of routed sites
  - endpoint
  - when status was last checked
- **Proxy server panel:**
  - backend, codespace, port
  - SOCKS5 handshake result
  - up since
  - the actions that apply right now (only valid actions are shown)
- **Recent activity:** the last nine log entries, colour-coded by category.
- **Problem callout:** shown whenever something needs attention.

### Sites

- Add a domain or paste a full URL; `https://github.com/foo` becomes
  `github.com`.
- `www.` is stripped, and subdomains are included automatically: listing
  `example.com` covers `api.example.com`.
- Input is checked. Invalid entries and duplicates are rejected with a
  message, and a duplicate is highlighted in the list.
- Hover a row to **Remove** it.
- **Backup line** (under the list): your sites and settings are copied to
  `~/.config/eschatch/settings.json` about a second after every change. That
  file lives outside the browser, so it **survives uninstalling and
  reinstalling the extension**. It lives outside the repo too, so it also
  survives moving or re-cloning the repo.
  - A fresh install restores from it automatically.
  - **Restore from backup** adds back any sites that are in the backup but
    missing from the list.
  - A restore never removes sites, and only fills in settings that are still
    at their defaults.
- **Export** saves your sites and settings to `escape-hatch-settings.json`, and
  **Import…** loads one back. Imported sites are *added* to your list; nothing
  is removed. Use it for backups, or to move settings to another browser.

### Server

- **Status** and **Backend** selector (Codespace or SSH tunnel), with
  Start / Stop / Test / Cancel.
- **Endpoint:** type, host and port the browser sends routed sites to. The
  port is validated on Save.
- **Notifications** toggle.
- **Server control helper:**
  - whether the helper is reachable
  - the exact `install.sh` command for this browser, with a Copy button
- **Server log:** a live tail of `logs/netproxy.log`, refreshed every 3 s
  while the tab is open.
  - Errors are red, success lines green, simulated lines purple.

### Diagnostics

Runs every check between the browser and the proxy. It runs automatically the
first time you open the tab; after that use **Run again**. Problems are listed
first, each with a **Fix** line. The sidebar shows the result: ✓, or a count
of warnings (!) or errors (✗).

Checks made by the extension:

- **Server control helper** — can the browser reach the helper?
- **Proxy endpoint set** — host/port saved, and is it the local SOCKS5 server?
- **Sites in proxy list** — nothing is proxied until at least one site is added.
- **Browser proxy settings** — is another extension (VPN, proxy switcher)
  overriding ours, or is it locked by policy?
- **Recent proxy errors** — did the browser fail to use the proxy in the last
  10 minutes?

Checks made by the helper:

- helper version and Python version
- log folder writable
- server scripts present
- `gh` installed and logged in (Codespace backend)
- `tunnel.env`, SSH key and `ssh` present (SSH tunnel backend)
- something listening on the port
- **a real SOCKS5 handshake** — catches "the tunnel is up but the proxy behind
  it is dead"
- whether the last start/stop/test failed

Each run is also summarised in the log.

### Logs

- **Filters:** All, Errors, Server, Proxy, Navigation, Sites, Other. There is
  also a text filter.
- **Columns:** time, category, message. Error rows are tinted red.
- **Copy** copies what's currently shown, after filtering.
- **Download** saves one text file with:
  - extension version and browser
  - settings (the site count, not the site names)
  - current server state
  - the full extension log
  - the last 2000 lines of the server log

  This is the file to attach when reporting a problem.
- **Clear** empties the extension log. The server log file isn't touched.

The extension keeps its newest 1000 entries. Log categories:

| Category | What |
| --- | --- |
| `SERVER` / `SERVER-ERROR` | Start/stop/test progress (streamed from `logs/netproxy.log`), results, health changes, diagnostics summaries. |
| `PROXY` / `PROXY-ERROR` | Proxy rules applied or cleared; the browser failing to use the proxy. |
| `NAV` / `NAV-ERROR` | Page loads for each tab, including failed ones. |
| `DOMAIN`, `TOGGLE` | Sites added/removed; what the toolbar button resolved the site to. |
| `WARN` | E.g. a site added while the server was stopped. |
| `ERROR` | An internal error while handling a request. Always a bug; please report it. |
| `INFO`, `DEV` | Startup/install; actions from the Admin tab. |

### Admin

A developer tab for faking failures. See [Admin tab](admin.md).

## Notifications

Desktop notifications are **on by default**; switch them off on the Server
tab. You get one when:

- a start / stop / test **succeeds**, including what Test found
- a start / stop / test **fails**, with the cause and the fix
- the proxy **goes down unexpectedly**, meaning nobody pressed Stop (the
  codespace timed out, the laptop slept, the network changed, …)

Clicking a notification opens the dashboard.

## Background health checks

While the browser is open, the extension checks the server:

- **every minute**, and
- **right away** (at most once per 10 s) whenever the browser reports it
  couldn't use the proxy.

That's what keeps the badge accurate and catches unexpected drops. If the
browser's background worker restarts while a start or stop is running, the
next check picks the job back up and keeps streaming its log.

## Keyboard shortcut

The extension defines a **Toggle site** command, the same action as the
popup's route button, but ships without a default key. Assign one at
`vivaldi://extensions/shortcuts` (or `chrome://extensions/shortcuts`).
