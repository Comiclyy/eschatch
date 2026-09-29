// Admin view: fault injection for testing error handling and UI states.
// Loaded after options.js and reuses its helpers ($, $$, toast, serverState,
// activeFault, refreshFault, clearAllSimulations, renderSimBar).

const FAKE_CODESPACE = "fictional-pancake-xq6rrx4w5qv2pjg7";
const base = { backend: "codespace", port: 1080, codespace: FAKE_CODESPACE };

// Canned server states. Built on click so timestamps (elapsed, uptime,
// "failed 0m ago") are fresh.
const PRESETS = [
  { id: "running", name: "Running", dot: "up", desc: "Healthy, up 47 minutes",
    state: () => ({ ...base, listening: true, socksOk: true, upSince: Date.now() - 47 * 60000 }) },
  { id: "stopped", name: "Stopped", dot: "down", desc: "Nothing listening",
    state: () => ({ ...base, listening: false }) },
  { id: "starting", name: "Starting", dot: "busy", desc: "Start job running for 42s",
    state: () => ({ ...base, listening: false, job: { action: "start", pid: 1, startedAt: Math.floor(Date.now() / 1000) - 42 } }) },
  { id: "stopping", name: "Stopping", dot: "busy", desc: "Stop job just started",
    state: () => ({ ...base, listening: true, socksOk: true, job: { action: "stop", pid: 1, startedAt: Math.floor(Date.now() / 1000) } }) },
  { id: "dead-socks", name: "Port open, proxy dead", dot: "busy", desc: "Forward up, SOCKS5 not answering",
    state: () => ({ ...base, listening: true, socksOk: false }) },
  { id: "start-failed", name: "Start failed: gh", dot: "down", desc: "gh not logged in",
    state: () => ({ ...base, listening: false, lastFailure: { action: "start", error: "ERROR: not logged into gh. Run: gh auth login --web -s codespace", at: Date.now() } }) },
  { id: "start-timeout", name: "Start failed: timeout", dot: "down", desc: "Codespace never became Available",
    state: () => ({ ...base, listening: false, lastFailure: { action: "start", error: "ERROR: codespace didn't reach Available state (last state: Starting).", at: Date.now() } }) },
  { id: "host-missing", name: "Helper not installed", dot: "down", desc: "Native host not found",
    state: () => ({ error: "Specified native messaging host not found." }) },
  { id: "wrong-id", name: "Wrong extension ID", dot: "down", desc: "Host forbids this origin",
    state: () => ({ error: "Access to the specified native messaging host is forbidden." }) },
  { id: "host-crashed", name: "Helper crashed", dot: "down", desc: "Native host has exited",
    state: () => ({ error: "Native host has exited." }) },
  { id: "unknown", name: "Unknown error", dot: "down", desc: "Unmapped error text",
    state: () => ({ error: "EPIPE: broken pipe while writing to socket 7 (errno 32)" }) }
];

const FAULTS = [
  { mode: "gh-logged-out", kind: "job", desc: "Start/stop/test fails: gh not logged in (exit 1)" },
  { mode: "exit-1", kind: "job", desc: "Script dies with an unmapped error (HTTP 502)" },
  { mode: "codespace-timeout", kind: "job", desc: "Waits ~10s, then codespace never becomes Available" },
  { mode: "slow-start", kind: "job", desc: "Takes ~30s, then succeeds — watch the progress UI" },
  { mode: "hang", kind: "job", desc: "Never finishes — test Cancel" },
  { mode: "host-crash", kind: "helper", desc: "Helper exits without replying (\"Native host has exited\")" },
  { mode: "host-garbage", kind: "helper", desc: "Helper replies with invalid data" },
  { mode: "host-slow", kind: "helper", desc: "Every helper call takes 8s" },
  { mode: "status-error", kind: "helper", desc: "Status checks return an error" }
];

function renderPresets() {
  const activeId = serverState?.simulated ? serverState.preset : null;
  $("preset-grid").innerHTML = "";
  for (const p of PRESETS) {
    const btn = document.createElement("button");
    btn.className = `preset${p.id === activeId ? " active" : ""}`;
    btn.innerHTML = `<span class="preset-name"><span class="dot ${p.dot}"></span></span><span class="preset-desc"></span>`;
    btn.querySelector(".preset-name").append(p.name);
    btn.querySelector(".preset-desc").textContent = p.desc;
    btn.onclick = async () => {
      if (p.id === activeId) {
        await chrome.runtime.sendMessage({ type: "devSetOverride", state: null });
        toast("Server state back to real");
      } else {
        await chrome.runtime.sendMessage({ type: "devSetOverride", state: { ...p.state(), preset: p.id }, label: p.name });
        toast(`Simulating: ${p.name}`);
      }
    };
    $("preset-grid").appendChild(btn);
  }
  $("override-active").textContent = activeId ? `active: ${activeId}` : "off";
}

function renderFaults() {
  const active = activeFault?.mode;
  $("fault-list").innerHTML = "";
  for (const f of FAULTS) {
    const row = document.createElement("div");
    row.className = `fault${f.mode === active ? " active" : ""}`;
    const kind = document.createElement("span");
    kind.className = f.kind === "job" ? "tag" : "tag warn";
    kind.textContent = f.kind;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.mode;
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = f.desc;
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = f.mode === active ? "Disarm" : "Arm";
    btn.onclick = async () => {
      const mode = f.mode === active ? null : f.mode;
      const res = await chrome.runtime.sendMessage({ type: "devFault", mode });
      if (!res?.ok) {
        toast(`Couldn't reach the helper: ${explainServerError(res?.error).title}`, { error: true });
        return;
      }
      await refreshFault();
      toast(mode ? `Armed ${mode}${f.kind === "job" ? " — now press Start/Stop/Test" : ""}` : "Fault disarmed");
    };
    row.append(kind, name, desc, btn);
    $("fault-list").appendChild(row);
  }
  $("fault-active").textContent = active
    ? `active: ${active} · ${Math.max(0, Math.ceil((activeFault.until * 1000 - Date.now()) / 60000))}m left`
    : "off";
}

for (const btn of $$("[data-notify]")) {
  btn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "devNotify", kind: btn.dataset.notify });
    toast("Notification sent — check the top-right of your screen");
  });
}
for (const btn of $$("[data-badge]")) {
  btn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "devBadge", kind: btn.dataset.badge });
    toast(`Badge set to ${btn.textContent}`);
  });
}
for (const btn of $$("[data-logs]")) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const count = Number(btn.dataset.count) || 0;
    await chrome.runtime.sendMessage({ type: "devLogs", kind: btn.dataset.logs, count });
    btn.disabled = false;
    toast(count ? `Wrote ${count} log entries` : "Wrote log entries");
  });
}
$("sim-drop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "devSimulateDrop" });
  toast("Reported an unexpected drop");
});
$("sim-proxy-error").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "devSimulateProxyError" });
  toast("Fired a proxy error");
});
$("admin-clear-all").addEventListener("click", clearAllSimulations);

// Re-render when the server state (override) or fault changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.serverState) renderPresets();
});
document.addEventListener("fault-changed", renderFaults);

renderPresets();
renderFaults();
