// Shared helpers used by background.js, popup.js, and options.js.

const DEFAULTS = {
  domains: [],
  proxyHost: "",
  proxyPort: "",
  proxyScheme: "socks5", // "socks5" | "http" | "https"
  serverBackend: "codespace", // "codespace" | "tunnel" — which netproxy scripts the Start button runs
  notifications: true // desktop notifications for server start/stop results and unexpected drops
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return stored;
}

async function setConfig(partial) {
  await chrome.storage.sync.set(partial);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Strips a leading "www." so "www.example.com" and "example.com" are treated
// as the same site when adding/removing/matching.
function normalizeDomain(hostname) {
  if (!hostname) return null;
  return hostname.replace(/^www\./i, "").toLowerCase();
}

const LOG_KEY = "eventLog";
const LOG_MAX_ENTRIES = 1000;

// category is a short tag (NAV, NAV-ERROR, PROXY, PROXY-ERROR, DOMAIN,
// SERVER, SERVER-ERROR, TOGGLE, ERROR, INFO) so the options page can
// filter/color-code and so entries stay greppable when copy-pasted out.
//
// Writes are chained so concurrent calls (nav events, server log streaming)
// don't read the same old array and overwrite each other's entries.
let logWriteChain = Promise.resolve();

function addLogEntry(category, message) {
  const time = new Date();
  const ts = time.toLocaleTimeString([], { hour12: false }) + "." + String(time.getMilliseconds()).padStart(3, "0");
  const entry = `[${ts}] [${category}] ${message}`;
  console.log("[Escape Hatch]", entry);
  logWriteChain = logWriteChain
    .then(async () => {
      const { [LOG_KEY]: existing = [] } = await chrome.storage.local.get(LOG_KEY);
      await chrome.storage.local.set({ [LOG_KEY]: [...existing, entry].slice(-LOG_MAX_ENTRIES) });
    })
    .catch((e) => console.error("[Escape Hatch] log write failed:", e));
  return logWriteChain;
}

function isErrorEntry(entry) {
  return /\] \[[\w-]*ERROR\]/.test(entry);
}

async function getLogEntries() {
  const { [LOG_KEY]: entries = [] } = await chrome.storage.local.get(LOG_KEY);
  return entries;
}

async function clearLogEntries() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}

// Recovers the address a tab is actually trying to load, even when that
// navigation never committed (e.g. blocked by the network) and tab.url still
// shows the previous page. Preference order:
//   1. tab.pendingUrl — set by the browser itself the instant a navigation
//      starts, before it succeeds or fails. Most reliable, no race.
//   2. navTargets[tab.id] — recorded by webNavigation.onBeforeNavigate in
//      background.js. Covers cases where pendingUrl has already been cleared
//      (e.g. the browser gave up and reverted) but we saw the attempt.
//   3. tab.url — normal committed-page fallback.
async function getIntendedTabUrl(tab) {
  if (tab.pendingUrl) return tab.pendingUrl;
  const { navTargets = {} } = await chrome.storage.session.get("navTargets");
  return navTargets[tab.id] || tab.url;
}

function buildPacScript(domains, proxyHost, proxyPort, proxyScheme) {
  const pacProxyType =
    proxyScheme === "socks5" ? "SOCKS5" : proxyScheme === "https" ? "HTTPS" : "PROXY";
  const proxyString = `${pacProxyType} ${proxyHost}:${proxyPort}`;
  const domainList = JSON.stringify(domains);

  return `
    function FindProxyForURL(url, host) {
      var domains = ${domainList};
      var h = host.toLowerCase();
      if (h.indexOf("www.") === 0) {
        h = h.substring(4);
      }
      for (var i = 0; i < domains.length; i++) {
        var d = domains[i];
        if (h === d || h.slice(-(d.length + 1)) === "." + d) {
          return "${proxyString}; DIRECT";
        }
      }
      return "DIRECT";
    }
  `;
}

// Maps raw errors (from the browser's native messaging layer, the helper,
// or the scripts) to something a person can act on.
function explainServerError(raw) {
  const error = String(raw || "");
  const install = "Run native-host/install.sh with this extension's ID — the exact command is on the dashboard's Server tab — then reload the extension.";
  const rules = [
    [/native messaging host not found/i, "Server control isn't installed for this browser.", install],
    [/access to the specified native messaging host is forbidden/i,
      "The helper is installed for a different extension ID.",
      "The extension ID changed (e.g. it was loaded from a new folder). " + install],
    [/native host has exited|error when communicating with the native messaging host/i,
      "The helper program crashed or couldn't start.",
      "Check logs/native-host.log, and rerun native-host/install.sh if python3 moved."],
    [/nativeMessaging permission/i, "The extension is missing a permission.", "Reload the extension from the extensions page."],
    [/not logged into gh|gh auth login/i, "GitHub CLI isn't logged in.", "Run in a terminal: gh auth login --web -s codespace"],
    [/gh CLI not found/i, "GitHub CLI isn't installed.", "Run in a terminal: brew install gh"],
    [/didn't reach Available/i, "The codespace didn't start in time.", "GitHub may be slow — try Start again, or check github.com/codespaces."],
    [/tunnel\.env/i, "The SSH tunnel isn't configured.", "Copy scripts/tunnel.env.example to scripts/tunnel.env and fill it in."],
    [/still running/i, "Another server action is still in progress.", "Wait for it to finish, or press Cancel."],
    [/timed out|timeout/i, "The server didn't respond in time.", "Try again; run the Diagnostics tab if it keeps happening."]
  ];
  for (const [pattern, title, fix] of rules) {
    if (pattern.test(error)) return { title, fix, raw: error };
  }
  return { title: error || "Unknown error", fix: "Run the Diagnostics tab in the dashboard for details.", raw: error };
}

// GitHub's codespace states in plain words.
function describeCodespaceState(state) {
  if (!state) return null;
  return { Available: "running", Shutdown: "shut down", ShuttingDown: "shutting down", Starting: "starting" }[state] || state.toLowerCase();
}

function formatElapsed(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Turns the serverState cached by background.js into what the popup/options
// page show: a status dot class, a label, which action the main button
// should perform, and an optional user-facing problem ({title, fix}).
function describeServerState(state) {
  if (!state) {
    return { dot: "", text: "Checking proxy server...", action: null };
  }
  if (state.error) {
    const problem = explainServerError(state.error);
    return { dot: "down", text: "Server control unavailable", action: null, problem };
  }
  if (state.job) {
    const verb = { start: "Starting", stop: "Stopping", test: "Testing" }[state.job.action] || "Working";
    const elapsed = state.job.startedAt ? ` (${formatElapsed(Date.now() / 1000 - state.job.startedAt)})` : "";
    return { dot: "busy", text: `${verb} proxy server...${elapsed}`, action: "cancel" };
  }

  let problem = null;
  const failure = state.lastFailure;
  if (failure && Date.now() - failure.at < 10 * 60 * 1000) {
    problem = { ...explainServerError(failure.error), title: `Last ${failure.action} failed: ${explainServerError(failure.error).title}` };
  }

  if (state.listening && state.socksOk === false) {
    return {
      dot: "busy",
      text: `Port ${state.port} is open but the proxy isn't answering`,
      action: "stop",
      problem: problem || { title: "The tunnel is up but the proxy behind it isn't responding.", fix: "Stop, then start the server again." }
    };
  }
  return state.listening
    ? { dot: "up", text: "Proxy server running", action: "stop", problem }
    : { dot: "down", text: "Proxy server stopped", action: "start", problem };
}
