// Shared helpers used by background.js, popup.js, and options.js.

const DEFAULTS = {
  domains: [],
  proxyHost: "",
  proxyPort: "",
  proxyScheme: "socks5" // "socks5" | "http" | "https"
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
const LOG_MAX_ENTRIES = 300;

// category is a short tag (NAV, NAV-ERROR, PROXY, DOMAIN, ERROR, INFO) so the
// options page can filter/color-code and so entries stay greppable when
// copy-pasted out for debugging.
async function addLogEntry(category, message) {
  const { [LOG_KEY]: existing = [] } = await chrome.storage.local.get(LOG_KEY);
  const time = new Date();
  const ts = time.toLocaleTimeString([], { hour12: false }) + "." + String(time.getMilliseconds()).padStart(3, "0");
  const entry = `[${ts}] [${category}] ${message}`;
  const updated = [...existing, entry].slice(-LOG_MAX_ENTRIES);
  await chrome.storage.local.set({ [LOG_KEY]: updated });
  console.log("[Escape Hatch]", entry);
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
