importScripts("common.js");

async function applyProxySettings() {
  const { domains, proxyHost, proxyPort, proxyScheme } = await getConfig();

  if (!proxyHost || !proxyPort || domains.length === 0) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    await addLogEntry("PROXY", "Cleared (no endpoint configured or no domains in list).");
    return;
  }

  const pacScript = buildPacScript(domains, proxyHost, proxyPort, proxyScheme);
  await chrome.proxy.settings.set({
    value: {
      mode: "pac_script",
      pacScript: { data: pacScript }
    },
    scope: "regular"
  });
  await addLogEntry(
    "PROXY",
    `Applied PAC: ${domains.length} domain(s) -> ${proxyScheme}://${proxyHost}:${proxyPort} (${domains.join(", ")})`
  );
}

async function addDomain(domain) {
  const config = await getConfig();
  if (!config.domains.includes(domain)) {
    config.domains.push(domain);
    await setConfig({ domains: config.domains });
    await addLogEntry("DOMAIN", `Added: ${domain}`);
  }
  await applyProxySettings();
}

async function removeDomain(domain) {
  const config = await getConfig();
  const domains = config.domains.filter((d) => d !== domain);
  await setConfig({ domains });
  await addLogEntry("DOMAIN", `Removed: ${domain}`);
  await applyProxySettings();
}

async function toggleDomainForTab(tab) {
  if (!tab) return;
  const source = tab.pendingUrl ? "pendingUrl" : "tab.url/navTargets";
  const targetUrl = await getIntendedTabUrl(tab);
  const hostname = normalizeDomain(hostnameFromUrl(targetUrl));
  await addLogEntry(
    "TOGGLE",
    `tab=${tab.id} resolvedUrl="${targetUrl}" (source=${source}) committedUrl="${tab.url}" pendingUrl="${tab.pendingUrl || ""}" hostname=${hostname}`
  );
  if (!hostname) {
    await addLogEntry("TOGGLE", `Aborted: could not extract a hostname from "${targetUrl}"`);
    return;
  }

  const { domains } = await getConfig();
  if (domains.includes(hostname)) {
    await removeDomain(hostname);
  } else {
    await addDomain(hostname);
    const { serverState } = await chrome.storage.session.get("serverState");
    if (serverState && !serverState.listening && !serverState.job) {
      await addLogEntry("WARN", `${hostname} added while the proxy server is stopped — it won't load until the server is started.`);
    }
  }
  // Force a fresh navigation to the intended URL rather than a plain reload —
  // if the last attempt never committed (e.g. it was blocked), tab.url may
  // still be the previous page, and reload() would just reload that instead.
  await chrome.tabs.update(tab.id, { url: targetUrl });
}

// --- Proxy server control (via the native messaging host in native-host/) ---

const NATIVE_HOST = "com.escapehatch.netproxy";
const SERVER_POLL_MS = 2000;
const SERVER_JOB_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_ALARM = "server-health";
const FAILURE_SHOWN_MS = 10 * 60 * 1000;
let followingJob = false;
// The periodic health check calls the host every minute; only log a failure
// when it changes so a missing host doesn't flood the log.
let lastLoggedHostError = null;

async function callServer(cmd, extra = {}) {
  const { serverBackend, proxyHost, proxyPort } = await getConfig();
  const isLocal = !proxyHost || proxyHost === "127.0.0.1" || proxyHost === "localhost";
  const port = isLocal && proxyPort ? Number(proxyPort) : 1080;

  let res;
  if (typeof chrome.runtime.sendNativeMessage !== "function") {
    res = { ok: false, error: "nativeMessaging permission not granted — reload the extension." };
  } else {
    try {
      res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd, backend: serverBackend, port, ...extra });
    } catch (e) {
      res = { ok: false, hostError: true, error: e.message };
    }
    if (!res) {
      res = { ok: false, hostError: true, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "empty reply from native host" };
    }
  }

  if (res.hostError || res.error?.startsWith("nativeMessaging")) {
    if (res.error !== lastLoggedHostError) {
      lastLoggedHostError = res.error;
      const { title, fix } = explainServerError(res.error);
      await addLogEntry("SERVER-ERROR", `Can't reach server control (${cmd}): ${res.error} — ${title} ${fix}`);
    }
  } else if (lastLoggedHostError) {
    lastLoggedHostError = null;
    await addLogEntry("SERVER", "Server control reachable again.");
  }
  return res;
}

async function notify(title, message, { force = false } = {}) {
  const { notifications } = await getConfig();
  if ((!notifications && !force) || !chrome.notifications) return;
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });
}

chrome.notifications?.onClicked.addListener((id) => {
  chrome.runtime.openOptionsPage();
  chrome.notifications.clear(id);
});

const BADGES = {
  error: ["!", "#d0493e"],
  busy: ["…", "#c98a1b"],
  on: ["ON", "#2f8a5b"],
  off: ["OFF", "#d0493e"],
  idle: ["OFF", "#5f6368"],
  none: ["", "#888888"]
};

function badgeKind(state, domainCount) {
  if (state?.error) return "error";
  if (state?.job) return "busy";
  if (state?.listening && state.socksOk !== false) return "on";
  if (!state) return "none";
  // Red when sites are routed to a proxy that isn't there (they're affected);
  // grey when the proxy is simply off and nothing depends on it.
  return domainCount > 0 ? "off" : "idle";
}

async function setBadge(kind) {
  const [text, color] = BADGES[kind];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// Toolbar badge: at-a-glance proxy state without opening the popup.
async function updateBadge(state) {
  const { domains } = await getConfig();
  await setBadge(badgeKind(state, domains.length));
}

async function reportUnexpectedDrop() {
  await addLogEntry("SERVER-ERROR", "Proxy server went down unexpectedly — proxied sites will fail until it's restarted.");
  await notify("Escape Hatch: proxy server went down", "Proxied sites won't load. Open the popup to restart it.");
}

// Status is cached in session storage so the popup/options page can render
// immediately and update live via storage.onChanged.
async function refreshServerStatus() {
  // Admin tab's "UI state" override: show a canned state instead of the real
  // one, and skip drop detection/job following so nothing real reacts to it.
  const { devOverride } = await chrome.storage.session.get("devOverride");
  if (devOverride) {
    const serverState = { ...devOverride, simulated: true, checkedAt: Date.now() };
    await chrome.storage.session.set({ serverState });
    await updateBadge(serverState);
    return serverState;
  }

  const res = await callServer("status");
  const { serverState: prev, serverLastFailure, serverExpectDown, serverUpSince } = await chrome.storage.session.get([
    "serverState",
    "serverLastFailure",
    "serverExpectDown",
    "serverUpSince"
  ]);
  const serverState = res.ok
    ? {
        listening: res.listening,
        socksOk: res.socksOk,
        port: res.port,
        job: res.job,
        codespace: res.codespace,
        backend: res.backend
      }
    : { error: res.error };
  if (serverLastFailure && Date.now() - serverLastFailure.at < FAILURE_SHOWN_MS) {
    serverState.lastFailure = serverLastFailure;
  }
  // Uptime as seen by the extension (first check that found it listening).
  if (res.ok && res.listening) {
    serverState.upSince = (!prev?.simulated && serverUpSince) || Date.now();
    if (!serverUpSince) await chrome.storage.session.set({ serverUpSince: serverState.upSince });
  } else if (serverUpSince) {
    await chrome.storage.session.remove("serverUpSince");
  }
  serverState.checkedAt = Date.now();
  await chrome.storage.session.set({ serverState });
  await updateBadge(serverState);

  if (res.ok) {
    // Noticed the proxy vanish without anyone pressing Stop (codespace timed
    // out, laptop slept, network changed...).
    if (prev?.listening && !prev.simulated && !res.listening && !res.job && !serverExpectDown) {
      await reportUnexpectedDrop();
    }
    if (res.listening && serverExpectDown) {
      await chrome.storage.session.remove("serverExpectDown");
    }
    // Resume following a job if the service worker restarted mid-job.
    if (res.job && !followingJob) {
      const now = await callServer("log", { lines: 0 });
      followServerJob(res.job.action, now.ok ? now.offset : undefined);
    }
  }
  return serverState;
}

// Polls the running start/stop/test job, streaming new netproxy.log lines
// into the extension log as SERVER entries until the job finishes, then
// reports the outcome.
async function followServerJob(action, offset) {
  if (followingJob) return;
  followingJob = true;
  const deadline = Date.now() + SERVER_JOB_TIMEOUT_MS;
  let lastErrorLine = null;
  let lastLine = null;
  try {
    const streamNewLines = async () => {
      const logRes = await callServer("log", { offset, lines: 500 });
      if (!logRes.ok) return;
      offset = logRes.offset;
      for (const line of logRes.lines) {
        const isError = /\b(ERROR|WARNING|failed|refused|denied|not found)\b/i.test(line);
        if (isError) lastErrorLine = line;
        lastLine = line;
        await addLogEntry(isError ? "SERVER-ERROR" : "SERVER", line);
      }
    };
    let state;
    do {
      await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
      await streamNewLines();
      state = await refreshServerStatus();
    } while (state.job && Date.now() < deadline);
    // The script's last lines (usually the error) can land between the read
    // above and the status check that saw it finish.
    await streamNewLines();

    if (state.job) {
      await addLogEntry("SERVER-ERROR", `${action} still running after ${SERVER_JOB_TIMEOUT_MS / 60000} min — stopped following it. Use Cancel to kill it.`);
      return;
    }
    const status = await callServer("status");
    const exitCode = status.lastJob?.exitCode;
    const stripTs = (l) => (l || "").replace(/^\[[^\]]*\]\s*/, "");

    if (exitCode === 130) {
      await addLogEntry("SERVER", `${action} cancelled.`);
    } else if (exitCode === 0 && !(action === "start" && !state.listening)) {
      await chrome.storage.session.remove("serverLastFailure");
      await refreshServerStatus();
      await addLogEntry("SERVER", `${action} succeeded — proxy is ${state.listening ? "listening" : "not listening"}.`);
      const messages = {
        start: `Proxy server is running${state.codespace ? ` (${state.codespace})` : ""}.`,
        stop: "Proxy server stopped.",
        test: stripTs(lastLine) || "Test passed."
      };
      await notify(`Escape Hatch: ${action} succeeded`, messages[action]);
    } else {
      const error = stripTs(lastErrorLine) || (exitCode != null ? `exited with code ${exitCode}` : "proxy isn't listening after start");
      await chrome.storage.session.set({ serverLastFailure: { action, error, at: Date.now() } });
      await refreshServerStatus();
      const { title, fix } = explainServerError(error);
      await addLogEntry("SERVER-ERROR", `${action} FAILED (exit ${exitCode ?? "?"}): ${error} — ${fix}`);
      await notify(`Escape Hatch: ${action} failed`, `${title} ${fix}`);
    }
  } finally {
    followingJob = false;
  }
}

async function serverAction(action) {
  if (action === "cancel") {
    const res = await callServer("cancel");
    await addLogEntry(res.ok ? "SERVER" : "SERVER-ERROR", res.ok ? `Cancelled ${res.cancelled}.` : `Cancel failed: ${res.error}`);
    await refreshServerStatus();
    return res;
  }

  // Grab the current end-of-log offset first so only this job's output is streamed.
  const before = await callServer("log", { lines: 0 });
  if (action === "stop") await chrome.storage.session.set({ serverExpectDown: true });
  await chrome.storage.session.remove("serverLastFailure");
  const res = await callServer(action);
  if (!res.ok) {
    const { title, fix } = explainServerError(res.error);
    await chrome.storage.session.set({ serverLastFailure: { action, error: res.error, at: Date.now() } });
    await addLogEntry("SERVER-ERROR", `${action} couldn't start: ${res.error} — ${title} ${fix}`);
    await refreshServerStatus();
    return res;
  }
  await addLogEntry("SERVER", `${action} started (pid ${res.job.pid}).`);
  // Start following before refreshing, so the refresh doesn't see an
  // unfollowed job and start a second follower from a later offset.
  followServerJob(action, before.ok ? before.offset : undefined);
  await refreshServerStatus();
  return res;
}

// Health checks with a plain-language fix for each problem. Extension-side
// checks first (they explain most "it doesn't work" reports), then the
// helper's own checks.
async function runDiagnostics() {
  const checks = [];
  const add = (name, level, detail = "", fix = "") => checks.push({ name, level, detail, fix });
  const config = await getConfig();

  const ping = await callServer("ping");
  if (ping.ok) {
    add("Server control helper", "ok", `reachable (v${ping.version})`);
  } else {
    const { title, fix } = explainServerError(ping.error);
    add("Server control helper", "error", `${title} (${ping.error})`, fix);
  }

  const isLocal = ["127.0.0.1", "localhost"].includes(config.proxyHost);
  if (!config.proxyHost || !config.proxyPort) {
    add("Proxy endpoint set", "error", "no host/port saved", "Under Proxy endpoint, set SOCKS5, host 127.0.0.1, port 1080 and Save.");
  } else if (!isLocal) {
    add("Proxy endpoint set", "warn", `${config.proxyScheme}://${config.proxyHost}:${config.proxyPort}`,
      "The endpoint isn't 127.0.0.1, so the local server this page starts won't be used.");
  } else if (config.proxyScheme !== "socks5") {
    add("Proxy endpoint set", "warn", `type is ${config.proxyScheme}`, "The netproxy server is SOCKS5 — set Type to SOCKS5.");
  } else {
    add("Proxy endpoint set", "ok", `socks5://${config.proxyHost}:${config.proxyPort}`);
  }

  add("Sites in proxy list", config.domains.length ? "ok" : "warn", `${config.domains.length} site(s)`,
    "Add a site with the toolbar button or the list below — nothing is proxied until you do.");

  const { levelOfControl } = await chrome.proxy.settings.get({});
  const control = {
    controlled_by_this_extension: ["ok", "Escape Hatch controls the proxy"],
    controllable_by_this_extension: ["ok", "available (nothing applied yet)"],
    controlled_by_other_extensions: ["error", "another extension is overriding it",
      "Disable other proxy/VPN extensions — only one extension can control the browser's proxy."],
    not_controllable: ["error", "locked by browser policy", "Your browser's proxy settings are managed by policy and can't be changed."]
  }[levelOfControl] || ["warn", levelOfControl, ""];
  add("Browser proxy settings", ...control);

  const { lastProxyError } = await chrome.storage.session.get("lastProxyError");
  if (lastProxyError && Date.now() - lastProxyError.at < FAILURE_SHOWN_MS) {
    add("Recent proxy errors", "warn", `${lastProxyError.error} (${formatElapsed((Date.now() - lastProxyError.at) / 1000)} ago)`,
      "The browser couldn't use the proxy — check that the server is running, then Test it.");
  }

  if (ping.ok) {
    const backup = await settingsBackupStatus();
    if (!backup.ok) add("Settings backup", "error", backup.error, "Sites won't survive an uninstall until the helper can save them.");
    else if (!backup.exists) add("Settings backup", "warn", "no backup yet", "Change any setting (or add a site) to create one.");
    else if (!backup.inSync) add("Settings backup", "warn", `backup has ${backup.backupSites} site(s), browser has ${config.domains.length}`, "It updates on the next change. Use Restore on the Sites tab to bring back missing sites.");
    else add("Settings backup", "ok", `${backup.backupSites} site(s) in ${backup.path.replace(/^\/Users\/[^/]+/, "~")}`);

    const doctor = await callServer("doctor");
    if (doctor.ok) checks.push(...doctor.checks);
    else add("Helper checks", "error", doctor.error, "See logs/native-host.log.");
  }

  const count = (level) => checks.filter((c) => c.level === level).length;
  await addLogEntry(
    count("error") ? "SERVER-ERROR" : "SERVER",
    `Diagnostics: ${count("ok")} ok, ${count("warn")} warning(s), ${count("error")} error(s)` +
      checks.filter((c) => c.level !== "ok").map((c) => ` | ${c.level.toUpperCase()} ${c.name}: ${c.detail}`).join("")
  );
  return { ok: true, checks };
}

// --- Settings backup: survives uninstalling the extension ---
//
// chrome.storage is wiped when the extension is removed, so every settings
// change is also saved by the helper to ~/.config/eschatch/settings.json, and
// a fresh install restores from it. A restore only ever adds sites.
//
// Safety: while a restore is pending (fresh install, helper not reachable
// yet) nothing is backed up, so an empty new install can't overwrite a good
// backup. `restorePending` lives in local storage so it survives restarts.

const BACKUP_DEBOUNCE_MS = 1000;
let backupTimer = null;

function settingsSnapshot(config) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = config[key];
  return out;
}

function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(backupSettings, BACKUP_DEBOUNCE_MS);
}

async function setBackupState(state) {
  const { settingsBackup: prev } = await chrome.storage.session.get("settingsBackup");
  if (!state.ok && prev?.ok !== false) {
    await addLogEntry("WARN", `Couldn't back up settings: ${state.error} — sites won't survive an uninstall until this works.`);
  } else if (state.ok && prev?.ok === false) {
    await addLogEntry("INFO", "Settings backup is working again.");
  }
  await chrome.storage.session.set({ settingsBackup: state });
}

async function backupSettings() {
  const { restorePending } = await chrome.storage.local.get("restorePending");
  if (restorePending) {
    const restored = await restoreSettings({ reason: "pending restore" });
    // Restoring changes settings, which schedules another backup.
    if (!restored.ok) return restored;
  }
  const res = await callServer("settings-save", { settings: settingsSnapshot(await getConfig()) });
  await setBackupState(res.ok ? { ok: true, savedAt: res.savedAt * 1000, path: res.path } : { ok: false, error: res.error, at: Date.now() });
  return res;
}

// Merges the backup in: sites are added, never removed; other settings are
// only filled in where they're still at their defaults, so a restore never
// undoes something you've changed since.
async function restoreSettings({ reason }) {
  const res = await callServer("settings-load");
  if (!res.ok) {
    await chrome.storage.local.set({ restorePending: true });
    await setBackupState({ ok: false, error: res.error, at: Date.now() });
    return res;
  }
  await chrome.storage.local.remove("restorePending");
  if (!res.settings) return { ok: true, restored: 0, empty: true, path: res.path };

  const config = await getConfig();
  const incoming = res.settings;
  const update = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === "domains" || !(key in incoming) || typeof incoming[key] !== typeof DEFAULTS[key]) continue;
    if (config[key] === DEFAULTS[key] && incoming[key] !== DEFAULTS[key]) update[key] = incoming[key];
  }
  const incomingDomains = (Array.isArray(incoming.domains) ? incoming.domains : [])
    .map((d) => normalizeDomain(String(d)))
    .filter(Boolean);
  const added = [...new Set(incomingDomains)].filter((d) => !config.domains.includes(d));
  if (added.length) update.domains = [...config.domains, ...added];

  if (Object.keys(update).length) await setConfig(update);
  const saved = res.savedAt ? new Date(res.savedAt * 1000).toLocaleString() : "unknown time";
  await addLogEntry("INFO", `Restored ${added.length} site(s) and ${Object.keys(update).length - (added.length ? 1 : 0)} setting(s) from the settings backup (${reason}; backup saved ${saved}).`);
  return { ok: true, restored: added.length, settingsRestored: Object.keys(update).length - (added.length ? 1 : 0), savedAt: res.savedAt, path: res.path };
}

async function settingsBackupStatus() {
  const [res, config, { settingsBackup }] = await Promise.all([
    callServer("settings-load"),
    getConfig(),
    chrome.storage.session.get("settingsBackup")
  ]);
  if (!res.ok) return { ok: false, error: res.error, lastSave: settingsBackup };
  const backedUp = res.settings?.domains || [];
  const inSync =
    !!res.settings &&
    backedUp.length === config.domains.length &&
    config.domains.every((d) => backedUp.includes(d));
  return { ok: true, path: res.path, savedAt: res.savedAt, backupSites: backedUp.length, inSync, exists: !!res.settings, lastSave: settingsBackup };
}

async function ensureHealthAlarm() {
  if (!(await chrome.alarms.get(HEALTH_ALARM))) {
    await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEALTH_ALARM) return;
  await refreshServerStatus();
  const { restorePending } = await chrome.storage.local.get("restorePending");
  if (restorePending) await restoreSettings({ reason: "retry after install" });
});

// Records the URL of every top-level navigation attempt, successful or not,
// so toggleDomainForTab can recover the intended address even if the load
// never actually committed.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { navTargets = {} } = await chrome.storage.session.get("navTargets");
  navTargets[details.tabId] = details.url;
  await chrome.storage.session.set({ navTargets });
  await addLogEntry("NAV", `onBeforeNavigate tab=${details.tabId} url=${details.url}`);
});

// Full navigation lifecycle logging — lets you see, for one tab, the whole
// story: attempted -> committed/errored -> completed, correlated with the
// PROXY/PROXY-ERROR lines above by timestamp.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  addLogEntry("NAV", `onCommitted tab=${details.tabId} url=${details.url} transition=${details.transitionType}`);
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  addLogEntry("NAV-ERROR", `tab=${details.tabId} url=${details.url} error=${details.error}`);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  addLogEntry("NAV", `onCompleted tab=${details.tabId} url=${details.url}`);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { navTargets = {} } = await chrome.storage.session.get("navTargets");
  delete navTargets[tabId];
  await chrome.storage.session.set({ navTargets });
});

// Fires when Chrome's network stack fails to actually use the proxy (e.g.
// can't reach the SOCKS5 endpoint, or the PAC script itself errored) — the
// key signal for diagnosing "the site just won't load" reports.
let lastProxyErrorRefresh = 0;
async function handleProxyError(details) {
  addLogEntry("PROXY-ERROR", `${details.error} | fatal=${details.fatal} | details=${details.details}`);
  await chrome.storage.session.set({ lastProxyError: { error: details.error, at: Date.now() } });
  // A proxy error usually means the server died — recheck, at most every 10s.
  if (Date.now() - lastProxyErrorRefresh > 10000) {
    lastProxyErrorRefresh = Date.now();
    refreshServerStatus();
  }
}
chrome.proxy.onProxyError.addListener(handleProxyError);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  addLogEntry("INFO", `Extension ${reason === "install" ? "installed" : "updated/reloaded"}.`);
  if (reason === "install") {
    // Fresh install (e.g. after an uninstall): bring back sites and settings.
    await restoreSettings({ reason: "fresh install" });
  } else {
    // Existing install: make sure a backup exists, without touching one that does.
    const res = await callServer("settings-load");
    if (res.ok && !res.settings) await backupSettings();
  }
  applyProxySettings();
  ensureHealthAlarm();
  refreshServerStatus();
});

chrome.runtime.onStartup.addListener(() => {
  addLogEntry("INFO", "Browser startup.");
  applyProxySettings();
  ensureHealthAlarm();
  refreshServerStatus();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync") {
    scheduleBackup();
    await applyProxySettings();
    // The OFF badge depends on whether any sites are in the list.
    const { serverState } = await chrome.storage.session.get("serverState");
    await updateBadge(serverState);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-site") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await toggleDomainForTab(tab);
  }
});

// Note: with default_popup set in the manifest, action.onClicked never fires —
// the popup (popup.js) handles the toolbar-button click instead.

// Messages from popup.js / options.js.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sendResponse).catch(async (e) => {
    // Without this, a throw leaves the sender with only "message channel
    // closed before a response was received" and hides the real error.
    await addLogEntry("ERROR", `Handling "${message.type}" failed: ${e && e.stack ? e.stack : e}`);
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  });
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sendResponse) {
  if (message.type === "toggleCurrentTab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await toggleDomainForTab(tab);
    sendResponse({ ok: true });
  } else if (message.type === "removeDomain") {
    await removeDomain(message.domain);
    sendResponse({ ok: true });
  } else if (message.type === "addDomain") {
    await addDomain(message.domain);
    sendResponse({ ok: true });
  } else if (message.type === "applyProxySettings") {
    await applyProxySettings();
    sendResponse({ ok: true });
  } else if (message.type === "serverAction") {
    sendResponse(await serverAction(message.action));
  } else if (message.type === "serverStatus") {
    sendResponse(await refreshServerStatus());
  } else if (message.type.startsWith("dev")) {
    sendResponse(await handleDevMessage(message));
  } else if (message.type === "restoreSettings") {
    sendResponse(await restoreSettings({ reason: "manual restore" }));
  } else if (message.type === "backupStatus") {
    sendResponse(await settingsBackupStatus());
  } else if (message.type === "diagnose") {
    sendResponse(await runDiagnostics());
  } else if (message.type === "serverLog") {
    sendResponse(await callServer("log", { lines: message.lines || 200 }));
  } else if (message.type === "clearLog") {
    await clearLogEntries();
    sendResponse({ ok: true });
  } else {
    sendResponse({ ok: false, error: `unknown message type "${message.type}"` });
  }
}

// --- Admin tab: fault injection for testing error handling and styling ---

const DEV_NOTIFICATIONS = {
  startOk: ["Escape Hatch: start succeeded", "Proxy server is running (fictional-pancake-xq6rrx4w5qv2pjg7)."],
  startFail: ["Escape Hatch: start failed", "GitHub CLI isn't logged in. Run in a terminal: gh auth login --web -s codespace"],
  stopOk: ["Escape Hatch: stop succeeded", "Proxy server stopped."],
  testOk: ["Escape Hatch: test succeeded", "OK: proxied traffic is exiting through the codespace."],
  drop: ["Escape Hatch: proxy server went down", "Proxied sites won't load. Open the popup to restart it."]
};

const DEV_SAMPLE_LOGS = [
  ["INFO", "Extension installed/updated."],
  ["DOMAIN", "Added: example.com"],
  ["TOGGLE", 'tab=812 resolvedUrl="https://example.com/" (source=pendingUrl) hostname=example.com'],
  ["PROXY", "Applied PAC: 3 domain(s) -> socks5://127.0.0.1:1080 (example.com, github.com, reddit.com)"],
  ["NAV", "onBeforeNavigate tab=812 url=https://example.com/"],
  ["NAV", "onCompleted tab=812 url=https://example.com/"],
  ["NAV-ERROR", "tab=812 url=https://example.com/ error=net::ERR_PROXY_CONNECTION_FAILED"],
  ["PROXY-ERROR", "net::ERR_PROXY_CONNECTION_FAILED | fatal=true | details="],
  ["SERVER", "[2026-09-28 14:49:06] SOCKS5 proxy ready at 127.0.0.1:1080 (via codespace fictional-pancake-xq6rrx4w5qv2pjg7)."],
  ["SERVER-ERROR", "[2026-09-28 14:49:06] ERROR: not logged into gh. Run: gh auth login --web -s codespace"],
  ["WARN", "Site added while the proxy server is stopped."],
  ["ERROR", 'Handling "serverStatus" failed: TypeError: Cannot read properties of undefined (reading \'ok\')']
];

async function handleDevMessage(message) {
  switch (message.type) {
    case "devSetOverride": {
      if (message.state) {
        await chrome.storage.session.set({ devOverride: message.state });
        await addLogEntry("DEV", `Simulating server state: ${message.label}`);
      } else {
        await chrome.storage.session.remove("devOverride");
        await addLogEntry("DEV", "Server state simulation cleared.");
      }
      return { ok: true, state: await refreshServerStatus() };
    }
    case "devNotify": {
      const [title, body] = DEV_NOTIFICATIONS[message.kind];
      await notify(title, body, { force: true });
      return { ok: true };
    }
    case "devBadge": {
      // Shown until the next status refresh (at most a minute).
      await setBadge(message.kind);
      return { ok: true };
    }
    case "devLogs": {
      if (message.kind === "sample") {
        for (const [cat, msg] of DEV_SAMPLE_LOGS) await addLogEntry(cat, msg);
      } else if (message.kind === "burst") {
        const writes = [];
        for (let i = 0; i < message.count; i++) {
          const [cat, msg] = DEV_SAMPLE_LOGS[i % DEV_SAMPLE_LOGS.length];
          writes.push(addLogEntry(cat, `#${i + 1} ${msg}`));
        }
        await Promise.all(writes);
      } else if (message.kind === "long") {
        await addLogEntry("SERVER-ERROR", "Very long line: " + "ssh: connect to host 203.0.113.7 port 443: Operation timed out; ".repeat(12));
      }
      return { ok: true };
    }
    case "devSimulateDrop":
      await reportUnexpectedDrop();
      return { ok: true };
    case "devSimulateProxyError":
      await handleProxyError({ error: "net::ERR_PROXY_CONNECTION_FAILED", fatal: true, details: "(simulated)" });
      return { ok: true };
    case "devFault": {
      const res = await callServer("fault", { mode: message.mode });
      if (res.ok) await addLogEntry("DEV", message.mode ? `Helper fault armed: ${message.mode}` : "Helper faults cleared.");
      return res;
    }
    case "devFaultStatus":
      return callServer("fault", { query: true });
  }
  return { ok: false, error: `unknown dev message ${message.type}` };
}
