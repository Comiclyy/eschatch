# Admin tab

**Admin**, at the bottom of the dashboard's sidebar, fakes failures. Use it to
check error handling and styling without actually breaking anything.

While any simulation is on:

- a purple **Simulated** bar shows at the top of every dashboard tab, with
  **Clear all**
- the popup shows *Simulated state* with a **Clear** link
- the sidebar's Admin item shows **SIM**

Every Admin action is logged under the `DEV` category.

## UI state override

Replaces the real server status **everywhere** (popup, badge, dashboard) with
a canned one. Nothing real is started or stopped. Real health checks are
paused while it's on, so the fake state isn't overwritten and doesn't trigger
drop alerts.

| Preset | Shows |
| --- | --- |
| Running | Healthy, up 47 minutes. |
| Stopped | Nothing listening. |
| Starting | Start job running (elapsed timer ticks; Cancel shown). |
| Stopping | Stop job just started. |
| Port open, proxy dead | Amber state: listening but no SOCKS5 answer. |
| Start failed: gh | "Last start failed: GitHub CLI isn't logged in." |
| Start failed: timeout | "Last start failed: The codespace didn't start in time." |
| Helper not installed | *Specified native messaging host not found.* |
| Wrong extension ID | *Access to the specified native messaging host is forbidden.* |
| Helper crashed | *Native host has exited.* |
| Unknown error | An error with no friendly mapping (tests the fallback). |

Click the active preset again, or **Clear all**, to go back to the real state.

> The Start/Stop buttons still act on the **real** server while an override is
> showing. Use a helper fault if you want the buttons themselves to fail.

## Helper faults

Make the real helper misbehave, so the **whole** pipeline runs:

- native messaging
- job tracking
- log streaming
- error mapping
- notifications
- the badge

The helper stores the fault in `/tmp/escapehatch-netproxy-fault.json`. It
**expires after 10 minutes** by itself, so a forgotten fault can't leave the
real controls broken.

**Job faults** apply to the next Start / Stop / Test. The helper runs
`native-host/fault-job.sh` instead of the real script. It writes realistic
log lines (tagged `[SIMULATED: …]`) and fails the way the real scripts do.
**Your actual server isn't touched.**

| Fault | What happens |
| --- | --- |
| `gh-logged-out` | Exits 1 with the "not logged into gh" error. |
| `exit-1` | Dies with an error the extension doesn't recognise (HTTP 502). |
| `codespace-timeout` | ~10 s of "Waiting…", then "didn't reach Available". |
| `slow-start` | ~30 s of progress, then succeeds. Good for checking the progress UI. |
| `hang` | Never finishes. Use it to test **Cancel**. |

**Helper faults** apply to every call except the fault controls themselves, so
you can always clear them.

| Fault | What happens |
| --- | --- |
| `host-crash` | Helper exits without replying → "Native host has exited". |
| `host-garbage` | Helper replies with invalid data → "Error when communicating…". |
| `host-slow` | Every call takes 8 s. |
| `status-error` | Status checks return an error. |

## Notifications, badge, logs, events

- **Notifications:** fire each one (start ok/failed, stopped, test passed,
  unexpected drop). They fire even when notifications are switched off.
- **Toolbar badge:** set ON / OFF / … / ! / none. The next status check (within
  a minute) puts the real badge back.
- **Log generator:**
  - one entry of every category
  - bursts of 100 or 1000 entries, to check the log view and that no entries
    get lost when many are written at once
  - one very long line, to check wrapping
- **Events:** run the real *unexpected drop* and *browser proxy error* handlers
  with fake input.

## A quick test pass

1. **Starting** preset: check the popup timer, the amber badge, Cancel.
   **Clear all**.
2. Arm `gh-logged-out`, press **Start**. Check that the red callout, the
   notification and the log all name *gh* as the cause.
3. Arm `hang`, press **Start**, then **Cancel**. It should say "cancelled", not
   "failed".
4. Arm `host-crash`, open the popup. Check the **!** badge and the "helper
   crashed" message. **Clear all**.
5. Log generator **Burst ×1000**, then use Logs filters and search.
