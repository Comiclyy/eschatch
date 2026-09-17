async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const domainEl = document.getElementById("domain");
  const statusEl = document.getElementById("status");
  const toggleBtn = document.getElementById("toggle-btn");
  const noConfigEl = document.getElementById("no-config");

  const targetUrl = tab ? await getIntendedTabUrl(tab) : null;
  const hostname = normalizeDomain(hostnameFromUrl(targetUrl));
  if (!hostname) {
    domainEl.textContent = "Not a proxyable page";
    toggleBtn.disabled = true;
    return;
  }
  domainEl.textContent = hostname;

  const { domains, proxyHost, proxyPort } = await getConfig();
  const isActive = domains.includes(hostname);
  statusEl.textContent = isActive
    ? "Routed through proxy"
    : "Direct (not proxied)";
  toggleBtn.textContent = isActive
    ? "Remove from proxy list"
    : "Add to proxy list";

  noConfigEl.hidden = !!(proxyHost && proxyPort);

  toggleBtn.onclick = async () => {
    toggleBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: "toggleCurrentTab" });
    window.close();
  };
}

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
