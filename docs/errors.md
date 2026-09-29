# Errors & troubleshooting

**Start with the Diagnostics tab.** It checks every link between the browser
and the proxy, and says how to fix each problem it finds.

If that doesn't explain it, open **Logs**, pick **Errors**, and read from the
bottom. **Download** gives one file with everything, for bug reports.

## Messages you might see

The popup and dashboard turn raw errors into these messages. The raw text is
kept in the log.

### Server control unavailable

The extension can't talk to the helper. The badge shows **!**. The callout
below the status line says which case it is:

| Message | Cause | Fix |
| --- | --- | --- |
| **Server control isn't installed for this browser.** | The helper isn't registered for this browser. Raw: *Specified native messaging host not found.* | Run `native-host/install.sh <id>`; the Server tab has the exact command. Then reload the extension. If it still fails, quit and reopen the browser. |
| **The helper is installed for a different extension ID.** | The helper was registered for another ID (e.g. an old copy of the extension without the fixed `key`). Raw: *Access to the specified native messaging host is forbidden.* | Re-run `install.sh` with the ID shown on the Server tab. |
| **The helper program crashed or couldn't start.** | Python moved or errored, or the reply was garbled. Raw: *Native host has exited* / *Error when communicating with the native messaging host.* | Check `logs/native-host.log`. Re-run `install.sh` if `python3` moved. |
| **The extension is missing a permission.** | The extension wasn't reloaded after an update added `nativeMessaging`. | Reload it on the extensions page. |

**Is the browser launching the helper at all?** Look at
`logs/native-host.log`. Each launch writes a line ending in
`argv=['chrome-extension://<id>/']`. No lines while you click around means the
browser isn't finding the registration.

### Start / stop / test failed

The popup and dashboard show **Last start failed: …** for 10 minutes. You also
get a notification if notifications are on.

| Message | Cause | Fix |
| --- | --- | --- |
| **GitHub CLI isn't logged in.** | `gh auth status` fails. | `gh auth login --web -s codespace` in a terminal. |
| **GitHub CLI isn't installed.** | No `gh` on the helper's PATH. | `brew install gh`. |
| **The codespace didn't start in time.** | GitHub didn't bring the codespace to *Available* within ~2.5 min. | Press Start again. Check github.com/codespaces for quota or outage problems. |
| **The SSH tunnel isn't configured.** | `scripts/tunnel.env` is missing. | Copy `tunnel.env.example` to `tunnel.env` and fill it in. |
| **Another server action is still in progress.** | You pressed Start/Stop while a job was running. | Wait, or press **Cancel**. |
| **The server didn't respond in time.** | A timeout somewhere in the chain. | Try again; run Diagnostics if it repeats. |
| *anything else* | An error the extension doesn't recognise; the raw text is shown. | Read the Server log on the Server tab; the red lines are the cause. |

### Port is open but the proxy isn't answering

Shown with an amber dot. Something is listening on `127.0.0.1:1080`, but it
doesn't answer a SOCKS5 handshake. Usually the local port-forward is still
running while the codespace or VPS side has died.

**Fix:** press **Stop**, then **Start**.

### Proxy server went down unexpectedly

Logged, and sent as a notification, when a health check finds the proxy gone
without anyone pressing Stop. Common causes:

- the codespace hit its idle timeout
- the laptop slept
- the Wi-Fi changed
- the SSH connection dropped

**Fix:** press **Start**.

### Backup unavailable / couldn't back up settings

The Sites tab shows a red *Backup unavailable*, or the log has
`WARN Couldn't back up settings`. Your sites are still in the browser, but
they won't survive an uninstall until the helper can save them.

**Fix:** get server control working; see
[Server control unavailable](#server-control-unavailable). The next change
saves a backup. Until then, **Export** on the Sites tab gives you a manual
copy.

**Sites missing after reinstalling?**

- If the helper wasn't registered yet when you reinstalled, the restore is
  pending. It runs within a minute of the helper becoming reachable.
- You can also press **Restore from backup** on the Sites tab.
- The backup file is `~/.config/eschatch/settings.json`. The previous version
  is in `settings.json.bak`.

### This site won't load (popup warning)

The site you're on is routed through the proxy, but the proxy is stopped.

**Fix:** press **Start server**. Or press **Stop routing this site** to go
direct.

## Symptoms

**A routed site won't load, but the badge says ON.**

- Press **Test**. If the test passes, the proxy works, and the site may be
  blocked at the codespace or VPS end.
- Check **Logs → Navigation** for `NAV-ERROR` on that tab.
- Check **Logs → Proxy** for `PROXY-ERROR` such as
  `ERR_PROXY_CONNECTION_FAILED`.

**A routed site loads, but not through the proxy.** Either the proxy was down
(see [the `; DIRECT` note](how-it-works.md#routing-sites-through-the-proxy)),
or another extension controls the browser's proxy (Diagnostics →
*Browser proxy settings*).

**The popup shows "Checking…" forever.** The background worker isn't
replying. Reload the extension. If it persists, check the worker's console:
extensions page → Escape Hatch → *service worker*.

**Start does nothing and there's no error.** Check `logs/native-host.log` for
a `cmd=start` line. If it's there, read `logs/netproxy.log`. If it's not, the
click never reached the helper; see
[Server control unavailable](#server-control-unavailable).

**"… still running after 5 min — stopped following it."** The job is still
alive, but the extension has stopped watching it. Press **Cancel**, then try
again.

**Everything broke right after using the Admin tab.** A simulation is probably
still active. A purple **Simulated** bar shows at the top of the dashboard,
and the popup shows *Simulated state*. Press **Clear all**. Faults also expire
on their own after 10 minutes.

## Reporting a bug

Go to **Logs → Download** and attach the file. It holds:

- extension version and browser
- settings (site count only, no site names)
- current server state
- the extension log
- the last 2000 lines of the server log

An `ERROR`-category entry (as opposed to `SERVER-ERROR`, `NAV-ERROR`, and so
on) is always a bug in the extension.
