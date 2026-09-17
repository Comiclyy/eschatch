const domainListEl = document.getElementById("domain-list");
const emptyMsgEl = document.getElementById("empty-msg");

async function renderDomains() {
  const { domains } = await getConfig();
  domainListEl.innerHTML = "";
  emptyMsgEl.hidden = domains.length !== 0;

  for (const domain of domains) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = domain;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "removeDomain", domain });
      renderDomains();
    };
    li.append(span, btn);
    domainListEl.appendChild(li);
  }
}

async function renderProxyFields() {
  const { proxyHost, proxyPort, proxyScheme } = await getConfig();
  document.getElementById("proxyHost").value = proxyHost || "";
  document.getElementById("proxyPort").value = proxyPort || "";
  document.getElementById("proxyScheme").value = proxyScheme || "socks5";
}

document.getElementById("save-proxy-btn").addEventListener("click", async () => {
  const proxyHost = document.getElementById("proxyHost").value.trim();
  const proxyPort = document.getElementById("proxyPort").value.trim();
  const proxyScheme = document.getElementById("proxyScheme").value;

  await setConfig({ proxyHost, proxyPort, proxyScheme });
  await chrome.runtime.sendMessage({ type: "applyProxySettings" });

  const savedMsg = document.getElementById("saved-msg");
  savedMsg.classList.add("show");
  setTimeout(() => savedMsg.classList.remove("show"), 1500);
});

document.getElementById("add-domain-btn").addEventListener("click", async () => {
  const input = document.getElementById("new-domain");
  const raw = input.value.trim();
  if (!raw) return;

  const domain = normalizeDomain(hostnameFromUrl(raw) || raw);
  await chrome.runtime.sendMessage({ type: "addDomain", domain });
  input.value = "";
  renderDomains();
});

document.getElementById("new-domain").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    document.getElementById("add-domain-btn").click();
  }
});

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderLog() {
  const entries = await getLogEntries();
  const logBox = document.getElementById("log-box");
  logBox.innerHTML = entries
    .map((e) => {
      const match = e.match(/^\[[\d:.]+\] \[([\w-]+)\]/);
      const category = match ? match[1] : "";
      return `<div class="cat-${category}">${escapeHtml(e)}</div>`;
    })
    .join("");
  logBox.scrollTop = logBox.scrollHeight;
}

document.getElementById("clear-log-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearLog" });
  renderLog();
});

document.getElementById("copy-log-btn").addEventListener("click", async () => {
  const entries = await getLogEntries();
  await navigator.clipboard.writeText(entries.join("\n"));
  const btn = document.getElementById("copy-log-btn");
  const original = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = original), 1200);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.eventLog) {
    renderLog();
  }
});

renderProxyFields();
renderDomains();
renderLog();
