// Preview-only fake of the chrome.* APIs so the popup and dashboard can be
// rendered as plain files by headless Chrome. Pick sample data with ?s=
// (running | failed | starting | missing) and the popup's tab with ?url=.
// Injected by shoot.sh into a temp copy — never into extension/ itself.
const P = new URLSearchParams(location.search);
const scenario = P.get("s") || "running";
const now = Date.now();
const CODESPACE = "fictional-pancake-xq6rrx4w5qv2pjg7";

const states = {
  running: { backend: "codespace", port: 1080, codespace: CODESPACE, listening: true, socksOk: true, upSince: now - 47 * 60000, checkedAt: now - 12000 },
  failed: {
    backend: "codespace", port: 1080, codespace: CODESPACE, listening: false, checkedAt: now - 3000,
    lastFailure: { action: "start", error: "ERROR: not logged into gh. Run: gh auth login --web -s codespace", at: now }
  },
  starting: {
    backend: "codespace", port: 1080, listening: false, checkedAt: now, simulated: true, preset: "starting",
    job: { action: "start", startedAt: Math.floor(now / 1000) - 42 }
  },
  missing: { error: "Specified native messaging host not found.", checkedAt: now }
};

const log = [
  "[14:48:10.112] [INFO] Browser startup.",
  "[14:48:10.250] [PROXY] Applied PAC: 3 domain(s) -> socks5://127.0.0.1:1080 (example.com, github.com, reddit.com)",
  "[14:48:13.004] [SERVER] start started (pid 7012).",
  `[14:48:15.310] [SERVER] [2026-09-28 14:48:15] Using codespace: ${CODESPACE}`,
  "[14:48:44.871] [SERVER] [2026-09-28 14:48:44] Codespace is Available.",
  `[14:49:06.201] [SERVER] [2026-09-28 14:49:06] SOCKS5 proxy ready at 127.0.0.1:1080 (via codespace ${CODESPACE}).`,
  "[14:50:01.017] [NAV] onBeforeNavigate tab=812 url=https://reddit.com/",
  "[14:50:01.502] [NAV-ERROR] tab=812 url=https://reddit.com/ error=net::ERR_PROXY_CONNECTION_FAILED",
  "[14:50:01.503] [PROXY-ERROR] net::ERR_PROXY_CONNECTION_FAILED | fatal=true | details=",
  "[14:50:02.100] [DOMAIN] Added: github.com",
  '[14:50:02.101] [TOGGLE] tab=812 resolvedUrl="https://github.com/" (source=pendingUrl) hostname=github.com',
  "[14:51:30.000] [WARN] github.com added while the proxy server is stopped — it won't load until the server is started.",
  "[14:52:00.000] [SERVER-ERROR] start FAILED (exit 1): ERROR: not logged into gh. Run: gh auth login --web -s codespace — Run in a terminal: gh auth login --web -s codespace",
  "[14:52:30.000] [DEV] Simulating server state: Starting",
  "[14:53:00.000] [NAV] onCompleted tab=812 url=https://github.com/"
];

const serverLog = [
  "[2026-09-28 14:48:13] [extension] start requested (codespace backend)",
  "[2026-09-28 14:48:13] === netproxy start ===",
  `[2026-09-28 14:48:15] Using codespace: ${CODESPACE}`,
  "[2026-09-28 14:48:15] Current state: Shutdown",
  "[2026-09-28 14:48:15] Sending start request...",
  "[2026-09-28 14:48:44] Codespace is Available.",
  `[2026-09-28 14:49:06] SOCKS5 proxy ready at 127.0.0.1:1080 (via codespace ${CODESPACE}).`,
  "[2026-09-28 15:03:29] === netproxy start === [SIMULATED: gh-logged-out]",
  "[2026-09-28 15:03:29] ERROR: not logged into gh. Run: gh auth login --web -s codespace"
];

const diagnostics = {
  ok: true,
  checks: [
    { name: "Server control helper", level: "ok", detail: "reachable (v2)" },
    { name: "Proxy endpoint set", level: "ok", detail: "socks5://127.0.0.1:1080" },
    { name: "Sites in proxy list", level: "ok", detail: "4 site(s)" },
    { name: "Browser proxy settings", level: "error", detail: "another extension is overriding it", fix: "Disable other proxy/VPN extensions — only one extension can control the browser's proxy." },
    { name: "GitHub CLI logged in", level: "ok", detail: "github.com" },
    { name: "Proxy listening on 127.0.0.1:1080", level: "ok", detail: "yes" },
    { name: "SOCKS5 proxy answering", level: "ok", detail: "handshake OK" },
    { name: "Last start", level: "warn", detail: "exited with code 1", fix: "See the Server log for the error." }
  ]
};

const data = {
  sync: {
    domains: ["example.com", "github.com", "reddit.com", "news.ycombinator.com"],
    proxyHost: "127.0.0.1", proxyPort: "1080", proxyScheme: "socks5", serverBackend: "codespace", notifications: true
  },
  local: { eventLog: log },
  session: { serverState: states[scenario] }
};

const area = (name) => ({
  async get(keys) {
    const store = data[name];
    if (keys == null) return { ...store };
    if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
    const out = Array.isArray(keys) ? {} : { ...keys };
    for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) if (k in store) out[k] = store[k];
    return out;
  },
  async set(obj) { Object.assign(data[name], obj); },
  async remove(key) { delete data[name][key]; }
});

window.chrome = {
  storage: { sync: area("sync"), local: area("local"), session: area("session"), onChanged: { addListener() {} } },
  runtime: {
    id: "opchgdmmkebjdmkcmbfboapbofhjljnm",
    getManifest: () => ({ version: "1.0.0" }),
    openOptionsPage() {},
    async sendMessage(m) {
      if (m.type === "serverStatus") return data.session.serverState;
      if (m.type === "serverLog") return { ok: true, lines: serverLog };
      if (m.type === "diagnose") return diagnostics;
      if (m.type === "backupStatus") {
        return scenario === "missing"
          ? { ok: false, error: "Specified native messaging host not found." }
          : { ok: true, path: "/Users/you/.config/eschatch/settings.json", savedAt: Math.floor(now / 1000) - 120, backupSites: 4, inSync: true, exists: true };
      }
      if (m.type === "devFaultStatus") {
        return { ok: true, fault: scenario === "starting" ? { mode: "slow-start", until: Math.floor(now / 1000) + 540 } : null };
      }
      return { ok: true };
    }
  },
  tabs: { async query() { return [{ id: 1, url: P.get("url") || "https://reddit.com/r/all" }]; } }
};
