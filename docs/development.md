# Development

## Layout

```
extension/
  manifest.json      MV3 manifest (permissions: proxy, nativeMessaging, alarms, notifications, …)
  background.js      proxy rules, helper calls, job following, health, badge, notifications, Admin actions
  common.js          shared: config, logging, error → message mapping, state → UI description
  popup.html/.js     toolbar popup
  options.html/.js   dashboard (Overview, Sites, Server, Diagnostics, Logs)
  admin.js           dashboard Admin tab
  ui.css             design tokens + components (buttons, pills, callouts, kv rows, log colours)
  dashboard.css      dashboard layout
native-host/
  netproxy_host.py   the helper (native messaging)
  install.sh         registers the helper with each browser
  fault-job.sh       fake start/stop/test used by Admin job faults
scripts/             server start/stop/test scripts (+ lib.sh logging, netproxy CLI)
tools/preview/       headless screenshots of every view
tools/test/          background.js simulation tests
docs/                you are here
```

## Reloading changes

| Changed | Do |
| --- | --- |
| `extension/*` | Click reload on the extensions page. Reopen the popup/dashboard. |
| `manifest.json` permissions | Reload. The browser may ask you to approve them. |
| `native-host/netproxy_host.py` | Nothing. It's launched fresh for every call. |
| Repo moved / renamed | Re-run `native-host/install.sh <id>` (the registration stores the absolute path). |

## Previewing the UI

```sh
tools/preview/shoot.sh            # everything
tools/preview/shoot.sh popup      # names containing "popup"
```

This renders the popup (running / failed / starting / missing) and every
dashboard tab to `tools/preview/out/*.png` (gitignored), using headless
Chrome.

- `tools/preview/stub.js` fakes the `chrome.*` APIs with sample data. Choose
  the scenario with `?s=`.
- The script works on a **temporary copy**, so the stub never lands in
  `extension/`.
- Each shot takes ~25 s: headless Chrome lingers after writing the file and is
  capped with a timer.
- Headless Vivaldi hangs on `--screenshot`, which is why this uses Chrome.

## Testing background logic

```sh
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
$JSC tools/test/background-sim.js extension/common.js extension/background.js tools/test/background-sim-run.js
```

This runs the real `background.js` against a fake browser and a scripted
helper, and prints PASS/FAIL per check. It covers:

- settings backup: a fresh install restores it, every change is saved, a
  restore never removes sites, and an empty install can't overwrite a good
  backup while the helper is unreachable
- a failure's cause reaching the user
- success clearing a failure
- badge states
- unexpected drop vs deliberate stop
- cancel
- the Admin override pausing real checks
- no lost log writes under bursts
- the missing-helper error being logged only once
- unknown messages getting a reply

To test the **helper** by hand, send it a message the way the browser does:

```sh
send() { printf '%s' "$1" | python3 -c 'import sys,struct;d=sys.stdin.buffer.read();sys.stdout.buffer.write(struct.pack("<I",len(d))+d)' \
  | env -i PATH=/usr/bin:/bin HOME=$HOME native-host/netproxy_host | tail -c +5; echo; }
send '{"cmd":"status"}'
send '{"cmd":"doctor"}'
```

`env -i` reproduces the bare environment the browser launches it with.

## Conventions

- **Every user-visible error goes through `explainServerError()`** in
  `common.js`. To support a new error, add a `[pattern, title, fix]` row:
  - the *title* says what's wrong
  - the *fix* says what to do
  - both use plain words
- **Every UI state goes through `describeServerState()`**, which returns the
  status dot, text, available action and problem. The popup and dashboard only
  render what it returns.
- **Log with a category** (`addLogEntry("SERVER", …)`). Writes are chained,
  so concurrent calls don't lose entries. Use a `*-ERROR` category, or
  `ERROR` for internal bugs, so the Errors filter and the counts pick it up.
- **Design:**
  - dark only
  - system fonts (the extension is often used on networks that block font
    CDNs)
  - hairline borders
  - one blue accent for selection and focus; green/amber/red only for status
  - monospace for anything technical
  - new colours go in `ui.css` as tokens, not inline

## Paths

Nothing hardcodes the repo location:

- the scripts find it from their own location
- the helper finds it from `__file__`
- `install.sh` writes the current absolute path into the browser registration,
  which is why it must be re-run after moving the repo
- `scripts/netproxy` (the CLI) resolves symlinks, so `~/bin/netproxy` can be a
  symlink to it (re-create the link after moving the repo)
- the extension ID is pinned by the `key` in `manifest.json`, so moving the
  repo doesn't change it
