// Dashboard (options page): sidebar views, server status everywhere, sites,
// endpoint, diagnostics and logs. The Admin view's controls live in admin.js.

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

let serverState = null;
let activeFault = null; // helper fault from the Admin tab, shown in the sim bar
let lastDiagnostics = null;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toast(message, { error = false } = {}) {
  const el = $("toast");
  el.textContent = message;
  el.className = error ? "toast err" : "toast";
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ---------- Views ----------

const VIEWS = ["overview", "sites", "server", "diagnostics", "logs", "admin"];

function showView(name) {
  if (!VIEWS.includes(name)) name = "overview";
  for (const v of $$(".view")) v.classList.toggle("active", v.dataset.view === name);
  for (const a of $$(".nav a")) a.classList.toggle("active", a.dataset.view === name);
  document.querySelector("main").scrollTop = 0;
  document.title = `${name[0].toUpperCase()}${name.slice(1)} · Escape Hatch`;
  if (name === "server") renderServerLog();
  if (name === "logs") renderLog({ scrollToEnd: true });
  if (name === "diagnostics" && !lastDiagnostics) runDiagnostics();
}

window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

// 1–5 jump between the main views, like a terminal UI.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, select, textarea")) return;
  const view = VIEWS[Number(e.key) - 1];
  if (view && view !== "admin") location.hash = view;
});

// ---------- Server status (rendered in several places) ----------

function renderServer() {
  const state = serverState;
  const { dot, text, action, problem } = describeServerState(state);

  for (const el of $$(".server-dot")) el.className = `dot server-dot ${dot}`;
  for (const el of $$(".server-text")) el.textContent = text;
  $("nav-server-dot").className = `dot ${dot}`;
  // The stat cell is narrow: a one-word state, details live in the panel below.
  $("stat-server").textContent = { up: "Running", busy: state?.job ? "Working…" : "Degraded", down: state?.error ? "Error" : "Stopped" }[dot] || "Checking…";

  for (const box of $$(".problem")) {
    box.hidden = !problem;
    if (problem) {
      box.querySelector(".problem-title").textContent = problem.title;
      box.querySelector(".problem-fix").textContent = problem.fix;
    }
  }

  // Buttons for actions that don't apply right now are hidden rather than
  // greyed out, so each state shows only what you can actually do.
  for (const btn of $$("[data-action]")) {
    const a = btn.dataset.action;
    const show = a === "test" ? action === "stop" : a === action;
    btn.hidden = !show;
    btn.disabled = false;
  }

  const kv = [
    ["Backend", state?.backend || "—"],
    ["Codespace", state?.codespace || "—"],
    ["Port", state?.port ? `127.0.0.1:${state.port}` : "—"],
    ["SOCKS5 handshake", state?.listening ? (state.socksOk ? "ok" : "no answer") : "—"],
    ["Up since", state?.listening && state.upSince ? `${new Date(state.upSince).toLocaleTimeString([], { hour12: false })} (${timeAgo(state.upSince).replace(" ago", "")})` : "—"]
  ];
  if (state?.job) kv.push(["Running", `${state.job.action}${state.job.simulated ? ` (simulated: ${state.job.simulated})` : ""}`]);
  $("overview-kv").innerHTML = kv.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd title="${escapeHtml(v)}">${escapeHtml(v)}</dd>`).join("");

  const helperOk = state && !(state.error && /native|helper|permission/i.test(state.error));
  $("helper-tag").textContent = !state ? "…" : helperOk ? "connected" : "not reachable";
  $("helper-tag").className = helperOk ? "tag" : "tag warn";

  renderTicking();
  renderSimBar();
}

// Parts that change every second (elapsed time, "checked 12s ago").
function renderTicking() {
  $("stat-checked").textContent = serverState?.checkedAt ? timeAgo(serverState.checkedAt) : "—";
  if (serverState?.job) {
    const { text } = describeServerState(serverState);
    for (const el of $$(".server-text")) el.textContent = text;
  }
}
setInterval(renderTicking, 1000);

function renderSimBar() {
  const parts = [];
  if (serverState?.simulated) parts.push(`server state: ${serverState.preset || "custom"}`);
  if (activeFault) parts.push(`helper fault: ${activeFault.mode} (expires in ${Math.max(0, Math.ceil((activeFault.until * 1000 - Date.now()) / 60000))}m)`);
  $("sim-bar").hidden = !parts.length;
  $("sim-bar-text").textContent = parts.join(" · ");
  $("nav-sim").hidden = !parts.length;
}

async function refreshServer() {
  serverState = await chrome.runtime.sendMessage({ type: "serverStatus" });
  renderServer();
  if (document.querySelector('.view.active[data-view="server"]')) renderServerLog();
}

async function refreshFault() {
  const res = await chrome.runtime.sendMessage({ type: "devFaultStatus" });
  activeFault = res?.ok ? res.fault : null;
  renderSimBar();
  document.dispatchEvent(new CustomEvent("fault-changed"));
}

for (const btn of $$("[data-action]")) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: "serverAction", action: btn.dataset.action });
    if (res && !res.ok) {
      btn.disabled = false;
      toast(explainServerError(res.error).title, { error: true });
    }
  });
}
$("refresh-btn").addEventListener("click", async () => {
  await refreshServer();
  toast("Status refreshed");
});

async function clearAllSimulations() {
  await chrome.runtime.sendMessage({ type: "devSetOverride", state: null });
  await chrome.runtime.sendMessage({ type: "devFault", mode: null });
  await refreshFault();
  toast("Simulations cleared");
}
$("sim-bar-clear").addEventListener("click", clearAllSimulations);

// ---------- Overview ----------

async function renderOverview() {
  const { domains, proxyHost, proxyPort, proxyScheme } = await getConfig();
  $("stat-sites").textContent = domains.length === 1 ? "1 site" : `${domains.length} sites`;
  $("stat-endpoint").textContent = proxyHost && proxyPort ? `${proxyScheme}://${proxyHost}:${proxyPort}` : "not set";
  $("nav-sites-count").textContent = domains.length || "";

  const entries = (await getLogEntries()).slice(-9).reverse();
  $("activity").innerHTML = entries.length
    ? entries
        .map((e) => {
          const { time, category, message } = parseLogEntry(e);
          return `<div class="activity-row cat-${category}"><span class="time">${escapeHtml(time.slice(0, 8))}</span><span class="msg" title="${escapeHtml(message)}">${escapeHtml(message)}</span></div>`;
        })
        .join("")
    : '<div class="empty">Nothing yet.</div>';
}

// ---------- Sites ----------

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function renderDomains(flash) {
  const { domains } = await getConfig();
  const list = $("domain-list");
  list.innerHTML = "";
  $("empty-msg").hidden = domains.length !== 0;
  $("sites-count").textContent = `${domains.length} total`;

  for (const domain of [...domains].sort()) {
    const li = document.createElement("li");
    if (domain === flash) li.className = "flash";
    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = domain;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `+ *.${domain}`;
    const btn = document.createElement("button");
    btn.className = "btn ghost small danger";
    btn.textContent = "Remove";
    btn.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "removeDomain", domain });
      toast(`Removed ${domain}`);
    };
    li.append(name, sub, btn);
    list.appendChild(li);
  }
}

$("add-domain-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("new-domain");
  const errorEl = $("add-domain-error");
  const raw = input.value.trim();
  if (!raw) return;

  const domain = normalizeDomain(hostnameFromUrl(raw) || hostnameFromUrl(`https://${raw}`) || raw);
  const { domains } = await getConfig();
  let error = null;
  if (!domain || !DOMAIN_RE.test(domain)) error = `"${raw}" doesn't look like a domain.`;
  else if (domains.includes(domain)) error = `${domain} is already in the list.`;

  errorEl.hidden = !error;
  errorEl.textContent = error || "";
  if (error) {
    if (domains.includes(domain)) renderDomains(domain);
    return;
  }
  await chrome.runtime.sendMessage({ type: "addDomain", domain });
  input.value = "";
  renderDomains(domain);
  toast(`Added ${domain}`);
});
$("new-domain").addEventListener("input", () => ($("add-domain-error").hidden = true));

// The helper keeps a copy of the settings outside the browser so they
// survive uninstalling the extension (see background.js).
async function renderBackup() {
  const res = await chrome.runtime.sendMessage({ type: "backupStatus" });
  const dot = $("backup-dot");
  const text = $("backup-text");
  const path = $("backup-path");
  const restore = $("restore-btn");
  if (!res || !res.ok) {
    dot.className = "dot down";
    text.textContent = "Backup unavailable — sites won't survive an uninstall until server control works.";
    path.textContent = "";
    restore.disabled = true;
    return;
  }
  path.textContent = res.path.replace(/^\/Users\/[^/]+/, "~");
  restore.disabled = !res.exists;
  if (!res.exists) {
    dot.className = "dot busy";
    text.textContent = "No backup yet — one is made on your next change.";
  } else if (res.inSync) {
    dot.className = "dot up";
    text.textContent = `Backed up ${timeAgo(res.savedAt * 1000)} · kept if the extension is uninstalled`;
  } else {
    dot.className = "dot busy";
    text.textContent = `Backup has ${res.backupSites} site(s) — updating…`;
  }
}

$("restore-btn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "restoreSettings" });
  if (!res?.ok) {
    toast(`Restore failed: ${explainServerError(res?.error).title}`, { error: true });
    return;
  }
  toast(res.restored || res.settingsRestored ? `Restored ${res.restored} site(s) from backup` : "Nothing to restore — everything in the backup is already here");
  renderDomains();
  renderProxyFields();
});

// Settings travel as a small JSON file: for backups, moving to another
// browser, or carrying settings over when the extension's ID changes.
const SETTINGS_FORMAT = "escape-hatch-settings";

$("export-btn").addEventListener("click", async () => {
  const config = await getConfig();
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) settings[key] = config[key];
  const file = { format: SETTINGS_FORMAT, version: 1, exportedAt: new Date().toISOString(), settings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "escape-hatch-settings.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${config.domains.length} site(s) and settings`);
});

$("import-btn").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast(`${file.name} isn't valid JSON.`, { error: true });
    return;
  }
  if (parsed?.format !== SETTINGS_FORMAT || typeof parsed.settings !== "object") {
    toast(`${file.name} isn't an Escape Hatch settings export.`, { error: true });
    return;
  }

  // Only known keys, with the right types; sites are merged, not replaced,
  // so importing can't silently drop sites you already have.
  const incoming = parsed.settings;
  const update = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === "domains" || !(key in incoming)) continue;
    if (typeof incoming[key] === typeof DEFAULTS[key]) update[key] = incoming[key];
  }
  const { domains } = await getConfig();
  const importedDomains = (Array.isArray(incoming.domains) ? incoming.domains : [])
    .map((d) => normalizeDomain(String(d)))
    .filter((d) => d && DOMAIN_RE.test(d));
  const added = importedDomains.filter((d) => !domains.includes(d));
  update.domains = [...domains, ...added];

  await setConfig(update);
  await chrome.runtime.sendMessage({ type: "applyProxySettings" });
  await addLogEntry("INFO", `Imported settings from ${file.name}: ${added.length} new site(s), ${Object.keys(update).length - 1} setting(s).`);
  renderProxyFields();
  renderDomains();
  renderOverview();
  toast(`Imported ${added.length} new site(s) and settings`);
});

// ---------- Server view ----------

async function renderProxyFields() {
  const { proxyHost, proxyPort, proxyScheme, serverBackend, notifications } = await getConfig();
  $("proxyHost").value = proxyHost || "";
  $("proxyPort").value = proxyPort || "";
  $("proxyScheme").value = proxyScheme || "socks5";
  $("serverBackend").value = serverBackend;
  $("notifications").checked = notifications;
  renderBackendHint(serverBackend);
}

function renderBackendHint(backend) {
  $("backend-hint").textContent = backend === "tunnel" ? "scripts/start-tunnel.sh" : "scripts/codespace-start.sh";
}

$("endpoint-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const proxyHost = $("proxyHost").value.trim();
  const proxyPort = $("proxyPort").value.trim();
  const proxyScheme = $("proxyScheme").value;
  const port = Number(proxyPort);
  if (proxyPort && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    toast("Port must be a number from 1 to 65535.", { error: true });
    return;
  }
  await setConfig({ proxyHost, proxyPort, proxyScheme });
  await chrome.runtime.sendMessage({ type: "applyProxySettings" });
  $("saved-msg").classList.add("show");
  setTimeout(() => $("saved-msg").classList.remove("show"), 1500);
  renderOverview();
});

$("serverBackend").addEventListener("change", async (e) => {
  await setConfig({ serverBackend: e.target.value });
  renderBackendHint(e.target.value);
  refreshServer();
});

$("notifications").addEventListener("change", (e) => setConfig({ notifications: e.target.checked }));

$("install-cmd").textContent = `native-host/install.sh ${chrome.runtime.id}`;
$("copy-install").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("install-cmd").textContent);
  toast("Command copied");
});

async function renderServerLog() {
  const box = $("server-log-box");
  const res = await chrome.runtime.sendMessage({ type: "serverLog", lines: 300 });
  if (!res || !res.ok) {
    box.innerHTML = `<span class="err">Can't read the server log — ${escapeHtml(explainServerError(res && res.error).title)}</span>`;
    $("server-log-status").textContent = "unavailable";
    return;
  }
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.innerHTML = res.lines.length
    ? res.lines
        .map((line) => {
          const m = line.match(/^(\[[^\]]*\])\s?(.*)$/);
          const [ts, rest] = m ? [m[1], m[2]] : ["", line];
          const cls = /SIMULATED/.test(rest) ? "sim" : /\b(ERROR|WARNING|failed|fatal)\b/i.test(rest) ? "err" : /\b(OK|ready|Available)\b/.test(rest) ? "ok" : "";
          return `<span class="ts">${escapeHtml(ts)}</span> <span class="${cls}">${escapeHtml(rest)}</span>`;
        })
        .join("\n")
    : '<span class="ts">(empty)</span>';
  $("server-log-status").textContent = `${res.lines.length} lines`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}
// Live tail while the Server view is open.
setInterval(() => {
  if (document.querySelector('.view.active[data-view="server"]')) renderServerLog();
}, 3000);

// ---------- Diagnostics ----------

async function runDiagnostics() {
  const btn = $("diagnose-btn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  $("diag-empty").hidden = false;
  $("diag-empty").textContent = "Running checks…";
  $("diag-results").innerHTML = "";
  try {
    const res = await chrome.runtime.sendMessage({ type: "diagnose" });
    if (!res || !res.ok) {
      $("diag-empty").textContent = `Diagnostics failed: ${res && res.error}`;
      return;
    }
    lastDiagnostics = { ...res, at: Date.now() };
    renderDiagnostics();
  } finally {
    btn.disabled = false;
    btn.textContent = "Run again";
  }
}

function renderDiagnostics() {
  const { checks, at } = lastDiagnostics;
  const order = { error: 0, warn: 1, ok: 2 };
  const sorted = [...checks].sort((a, b) => order[a.level] - order[b.level]);
  $("diag-results").innerHTML = sorted
    .map(
      (c) => `<li class="${c.level}">
        <span class="icon">${{ ok: "✓", warn: "!", error: "✗" }[c.level]}</span>
        <span class="name">${escapeHtml(c.name)}</span>
        <span class="detail">${escapeHtml(c.detail || "")}</span>
        ${c.fix ? `<span class="fix">${escapeHtml(c.fix)}</span>` : ""}
      </li>`
    )
    .join("");
  $("diag-empty").hidden = true;

  const count = (l) => checks.filter((c) => c.level === l).length;
  const [errors, warns] = [count("error"), count("warn")];
  $("diag-summary").textContent = `${count("ok")} ok · ${warns} warning${warns === 1 ? "" : "s"} · ${errors} error${errors === 1 ? "" : "s"} · ${new Date(at).toLocaleTimeString([], { hour12: false })}`;
  const navDiag = $("nav-diag");
  navDiag.textContent = errors ? `${errors}✗` : warns ? `${warns}!` : "✓";
  navDiag.style.color = errors ? "var(--err)" : warns ? "var(--warn)" : "var(--ok)";
}
$("diagnose-btn").addEventListener("click", runDiagnostics);

// ---------- Logs ----------

let logFilter = "all";

function parseLogEntry(entry) {
  const m = entry.match(/^\[([^\]]*)\] \[([\w-]+)\] ([\s\S]*)$/);
  return m ? { time: m[1], category: m[2], message: m[3] } : { time: "", category: "", message: entry };
}

function filteredLogEntries(entries) {
  const query = $("log-search").value.trim().toLowerCase();
  return entries.filter((e) => {
    if (logFilter === "errors" && !isErrorEntry(e)) return false;
    if (logFilter !== "all" && logFilter !== "errors") {
      const cat = parseLogEntry(e).category.replace(/-ERROR$/, "");
      if (!logFilter.split("|").includes(cat)) return false;
    }
    return !query || e.toLowerCase().includes(query);
  });
}

async function renderLog({ scrollToEnd = false } = {}) {
  const all = await getLogEntries();
  const errorCount = all.filter(isErrorEntry).length;
  $("nav-log-errors").textContent = errorCount ? errorCount : "";

  const box = $("log-box");
  if (!document.querySelector('.view.active[data-view="logs"]')) return;
  const entries = filteredLogEntries(all);
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.innerHTML = entries.length
    ? entries
        .map((e) => {
          const { time, category, message } = parseLogEntry(e);
          const errorCls = isErrorEntry(e) ? " is-error" : "";
          return `<div class="log-row cat-${category}${errorCls}"><span class="time">${escapeHtml(time)}</span><span class="cat">${escapeHtml(category)}</span><span class="msg">${escapeHtml(message)}</span></div>`;
        })
        .join("")
    : `<div class="empty">${all.length ? "No entries match this filter." : "The log is empty."}</div>`;
  $("log-count").textContent = entries.length === all.length ? `${all.length} entries` : `${entries.length} of ${all.length}`;
  if (atBottom || scrollToEnd) box.scrollTop = box.scrollHeight;
}

for (const btn of $$("#log-filter button")) {
  btn.addEventListener("click", () => {
    logFilter = btn.dataset.filter;
    for (const b of $$("#log-filter button")) b.classList.toggle("active", b === btn);
    renderLog({ scrollToEnd: true });
  });
}
$("log-search").addEventListener("input", () => renderLog({ scrollToEnd: true }));

$("clear-log-btn").addEventListener("click", async () => {
  if (!confirm("Clear the extension log? The server log file isn't affected.")) return;
  await chrome.runtime.sendMessage({ type: "clearLog" });
  toast("Log cleared");
});

$("copy-log-btn").addEventListener("click", async () => {
  const entries = filteredLogEntries(await getLogEntries());
  await navigator.clipboard.writeText(entries.join("\n"));
  toast(`Copied ${entries.length} entries`);
});

// One file with everything useful for a bug report: config (host/port
// only, no secrets), the extension log, and the server log.
$("download-log-btn").addEventListener("click", async () => {
  const [config, entries, serverLog] = await Promise.all([
    getConfig(),
    getLogEntries(),
    chrome.runtime.sendMessage({ type: "serverLog", lines: 2000 })
  ]);
  const text = [
    `Escape Hatch logs — ${new Date().toString()}`,
    `Extension ${chrome.runtime.getManifest().version} (${chrome.runtime.id}) on ${navigator.userAgent}`,
    `Config: ${JSON.stringify({ ...config, domains: `${config.domains.length} site(s)` })}`,
    `Server state: ${JSON.stringify(serverState)}`,
    "",
    "=== Extension log ===",
    ...entries,
    "",
    "=== Server log (logs/netproxy.log) ===",
    ...(serverLog && serverLog.ok ? serverLog.lines : [`(unavailable: ${serverLog && serverLog.error})`])
  ].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `escape-hatch-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- Live updates ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.eventLog) {
    renderLog();
    renderOverview();
  } else if (area === "sync") {
    renderDomains();
    renderOverview();
    // The backup is saved ~1s after a change; show the result once it lands.
    clearTimeout(renderBackup.timer);
    renderBackup.timer = setTimeout(renderBackup, 1800);
  } else if (area === "session" && changes.serverState) {
    serverState = changes.serverState.newValue;
    renderServer();
  } else if (area === "session" && changes.dashboardOpenTo?.newValue) {
    // The popup asked an already-open dashboard to switch view.
    openRequestedView(changes.dashboardOpenTo.newValue);
  }
});

function openRequestedView(view) {
  chrome.storage.session.remove("dashboardOpenTo");
  if (location.hash.slice(1) === view) showView(view);
  else location.hash = view;
  // First visit auto-runs from showView; re-run explicitly if results are stale.
  if (view === "diagnostics" && lastDiagnostics) runDiagnostics();
}

// ---------- Init ----------

(async () => {
  const manifest = chrome.runtime.getManifest();
  $("brand-version").textContent = `v${manifest.version}`;
  $("ext-id").textContent = chrome.runtime.id;

  ({ serverState } = await chrome.storage.session.get("serverState"));
  renderServer();
  renderProxyFields();
  renderDomains();
  renderOverview();
  renderLog();
  renderBackup();

  const { dashboardOpenTo } = await chrome.storage.session.get("dashboardOpenTo");
  if (dashboardOpenTo) openRequestedView(dashboardOpenTo);
  else showView(location.hash.slice(1) || "overview");

  requestAnimationFrame(() => document.body.classList.remove("preload"));
  refreshServer();
  refreshFault();
  setInterval(refreshFault, 15000);
})();
