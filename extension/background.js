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
  }
  // Force a fresh navigation to the intended URL rather than a plain reload —
  // if the last attempt never committed (e.g. it was blocked), tab.url may
  // still be the previous page, and reload() would just reload that instead.
  await chrome.tabs.update(tab.id, { url: targetUrl });
}

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
chrome.proxy.onProxyError.addListener((details) => {
  addLogEntry("PROXY-ERROR", `${details.error} | fatal=${details.fatal} | details=${details.details}`);
});

chrome.runtime.onInstalled.addListener(() => {
  addLogEntry("INFO", "Extension installed/updated.");
  applyProxySettings();
});

chrome.runtime.onStartup.addListener(() => {
  addLogEntry("INFO", "Browser startup.");
  applyProxySettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    applyProxySettings();
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
  (async () => {
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
    } else if (message.type === "clearLog") {
      await clearLogEntries();
      sendResponse({ ok: true });
    }
  })();
  return true; // keep the message channel open for the async response
});
