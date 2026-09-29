// Latest server state from background.js (session storage), kept so the
// site section and the server section can react to each other.
let serverState = null;
let currentSite = null; // { hostname, isActive }

const $ = (id) => document.getElementById(id);

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const toggleBtn = $("toggle-btn");

  const targetUrl = tab ? await getIntendedTabUrl(tab) : null;
  const hostname = normalizeDomain(hostnameFromUrl(targetUrl));
  const { domains, proxyHost, proxyPort } = await getConfig();
  $("no-config").hidden = !!(proxyHost && proxyPort);

  if (!hostname) {
    $("domain").textContent = "—";
    $("route-text").textContent = "This page can't be proxied";
    toggleBtn.disabled = true;
    return;
  }
  $("domain").textContent = hostname;

  const isActive = domains.includes(hostname);
  currentSite = { hostname, isActive };
  $("route-dot").className = isActive ? "dot up" : "dot";
  $("route-text").textContent = isActive ? "Routed through proxy" : "Direct · not proxied";

  toggleBtn.onclick = async () => {
    toggleBtn.disabled = true;
    // Adding a site while the server is down would just make it fail to
    // load, so bring the server up in the same click.
    if (!isActive && describeServerState(serverState).action === "start") {
      await chrome.runtime.sendMessage({ type: "serverAction", action: "start" });
    }
    await chrome.runtime.sendMessage({ type: "toggleCurrentTab" });
    window.close();
  };
  renderSite();
}

function renderSite() {
  if (!currentSite) return;
  const serverDown = describeServerState(serverState).action === "start";
  const btn = $("toggle-btn");
  btn.textContent = currentSite.isActive
    ? "Stop routing this site"
    : serverDown
      ? "Route through proxy & start server"
      : "Route through proxy";
  // Removing is the less common action; don't give it the primary weight.
  btn.className = currentSite.isActive ? "btn block" : "btn primary block";
  $("site-warning").hidden = !(currentSite.isActive && serverDown);
}

function formatUptime(since) {
  const mins = Math.floor((Date.now() - since) / 60000);
  if (mins < 1) return "up <1m";
  if (mins < 60) return `up ${mins}m`;
  return `up ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function renderServer() {
  const state = serverState;
  const { dot, text, action, problem } = describeServerState(state);

  $("server-dot").className = `dot ${dot}`;
  $("server-text").textContent = text;

  const pillText = { up: "On", down: state?.error ? "Error" : "Off", busy: "…" }[dot] || "…";
  $("header-pill").className = `pill ${dot}`;
  $("header-pill").querySelector(".dot").className = `dot ${dot}`;
  $("header-pill-text").textContent = pillText;

  $("server-backend").textContent = state?.backend ? `${state.backend}${state.port ? ` · :${state.port}` : ""}` : "";
  const meta = [];
  if (state?.codespace) meta.push(state.codespace);
  if (state?.listening && state.upSince) meta.push(formatUptime(state.upSince));
  if (state?.job?.simulated) meta.push(`simulated: ${state.job.simulated}`);
  $("server-meta").textContent = meta.join(" · ");
  $("server-meta").hidden = !meta.length;

  $("server-problem").hidden = !problem;
  if (problem) {
    $("problem-title").textContent = problem.title;
    $("problem-fix").textContent = problem.fix;
  }
  $("sim-banner").hidden = !state?.simulated;

  const btn = $("server-btn");
  const labels = { start: "Start server", stop: "Stop server", cancel: "Cancel" };
  btn.disabled = !action;
  btn.textContent = labels[action] || "Start server";
  btn.className = action === "start" ? "btn primary" : action === "stop" ? "btn danger" : "btn";
  btn.onclick = async () => {
    btn.disabled = true;
    // Keep the popup open so the status updates as it comes up.
    const res = await chrome.runtime.sendMessage({ type: "serverAction", action });
    if (res && !res.ok) btn.disabled = false;
  };
  $("test-btn").disabled = action !== "stop";
  $("test-btn").onclick = () => chrome.runtime.sendMessage({ type: "serverAction", action: "test" });

  const entries = await getLogEntries();
  const last = [...entries].reverse().find((e) => /\[SERVER(-ERROR)?\]/.test(e));
  const lastEl = $("server-last");
  // An old failure line next to a healthy server is just confusing.
  const staleError = last && isErrorEntry(last) && dot === "up" && !problem;
  lastEl.hidden = !last || staleError;
  if (last) {
    lastEl.textContent = last.replace(/^\[[^\]]*\] \[[\w-]+\] /, "").replace(/^\[[^\]]*\]\s*/, "");
    lastEl.className = isErrorEntry(last) ? "cat-SERVER-ERROR" : "cat-SERVER";
  }

  renderSite();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.serverState) {
    serverState = changes.serverState.newValue;
    renderServer();
  } else if (area === "local" && changes.eventLog) {
    renderServer();
  }
});

// Ticks the "Starting… (42s)" counter while a job runs.
setInterval(() => {
  if (serverState?.job) renderServer();
}, 1000);

async function openDashboard(view) {
  await chrome.storage.session.set({ dashboardOpenTo: view });
  chrome.runtime.openOptionsPage();
}
for (const btn of document.querySelectorAll("[data-open]")) {
  btn.addEventListener("click", () => openDashboard(btn.dataset.open));
}
$("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  openDashboard("server");
});
$("clear-sim").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: "devSetOverride", state: null });
});

(async () => {
  ({ serverState } = await chrome.storage.session.get("serverState"));
  await render();
  await renderServer();
  requestAnimationFrame(() => document.body.classList.remove("preload"));
  // Refresh in the background; the storage listener re-renders with the result.
  chrome.runtime.sendMessage({ type: "serverStatus" });
})();
