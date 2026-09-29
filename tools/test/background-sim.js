// Runs background.js against a fake chrome.* API and a scripted fake native
// host, and asserts on what the user would see (server state, log, badge,
// notifications). No browser needed:
//
//   JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
//   $JSC tools/test/background-sim.js extension/common.js extension/background.js tools/test/background-sim-run.js
//
// This file only sets up the fakes; background-sim-run.js holds the scenarios.

const realSetTimeout = setTimeout;
// Collapse delays (job polling, backup debounce) so scenarios finish
// instantly. The jsc shell has no clearTimeout, so timers are cancellable
// via our own id table.
let nextTimerId = 1;
const cancelledTimers = new Set();
setTimeout = (fn) => {
  const id = nextTimerId++;
  realSetTimeout(() => cancelledTimers.has(id) || fn(), 1);
  return id;
};
var clearTimeout = (id) => cancelledTimers.add(id);

const event = () => ({ listeners: [], addListener(f) { this.listeners.push(f); } });
const stores = { sync: {}, local: {}, session: {} };
const area = (name) => ({
  async get(keys) {
    const s = stores[name];
    if (keys == null) return { ...s };
    if (typeof keys === "string") return keys in s ? { [keys]: s[keys] } : {};
    const out = Array.isArray(keys) ? {} : { ...keys };
    for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) if (k in s) out[k] = s[k];
    return out;
  },
  async set(obj) {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: stores[name][k], newValue: v };
    Object.assign(stores[name], obj);
    // Like the real API: tell listeners (background.js backs up on sync changes).
    for (const f of chrome.storage.onChanged.listeners) f(changes, name);
  },
  async remove(key) { delete stores[name][key]; }
});

// Scripted helper. Tests flip these fields to change what it reports.
const host = {
  listening: false,
  job: null,
  lastJob: null,
  jobTicks: 0,
  jobExit: 0,
  jobErrorLine: null,
  logLines: [],
  missing: false,
  fault: null,
  codespaceState: "Shutdown",
  backup: null, // what's in ~/.config/eschatch/settings.json
  saves: 0,
  calls: []
};

const notifications = [];
const badges = [];
const icons = [];

var chrome = {
  storage: { sync: area("sync"), local: area("local"), session: area("session"), onChanged: event() },
  proxy: {
    settings: { clear: async () => {}, set: async () => {}, get: async () => ({ levelOfControl: "controlled_by_this_extension" }) },
    onProxyError: event()
  },
  webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onCompleted: event() },
  tabs: { onRemoved: event(), query: async () => [], update: async () => {} },
  runtime: {
    onInstalled: event(),
    onStartup: event(),
    onMessage: event(),
    lastError: null,
    openOptionsPage() {},
    async sendNativeMessage(name, msg) {
      host.calls.push(msg.cmd);
      if (msg.cmd === "fault") {
        if (!msg.query) host.fault = msg.mode ? { mode: msg.mode, until: Math.floor(Date.now() / 1000) + 600 } : null;
        return { ok: true, fault: host.fault };
      }
      if (host.missing) throw new Error("Specified native messaging host not found.");
      if (msg.cmd === "settings-save") {
        host.backup = JSON.parse(JSON.stringify(msg.settings));
        host.saves++;
        return { ok: true, path: "/Users/test/.config/eschatch/settings.json", savedAt: Math.floor(Date.now() / 1000) };
      }
      if (msg.cmd === "settings-load") {
        return { ok: true, path: "/Users/test/.config/eschatch/settings.json", savedAt: 1790000000, settings: host.backup };
      }
      switch (msg.cmd) {
        case "ping":
          return { ok: true, version: 2 };
        case "status":
          // A running job finishes after a few status polls; its last
          // (error) line lands in the log right as it exits — the race
          // background.js has to handle.
          if (host.job && --host.jobTicks <= 0) {
            host.lastJob = { ...host.job, exitCode: host.jobExit };
            host.job = null;
            if (host.jobErrorLine) host.logLines.push(host.jobErrorLine);
          }
          return {
            ok: true, listening: host.listening, socksOk: host.listening, port: 1080,
            job: host.job, lastJob: host.lastJob, codespace: "cs-test", codespaceState: host.codespaceState, backend: "codespace"
          };
        case "start":
        case "stop":
        case "test":
          host.job = { action: msg.cmd, pid: 42, startedAt: Math.floor(Date.now() / 1000) };
          host.jobTicks = 3;
          return { ok: true, job: host.job };
        case "cancel":
          if (!host.job) return { ok: false, error: "nothing is running" };
          host.lastJob = { ...host.job, exitCode: 130 };
          const cancelled = host.job.action;
          host.job = null;
          return { ok: true, cancelled };
        case "log": {
          const lines = msg.lines === 0 ? [] : host.logLines.splice(0);
          return { ok: true, lines, offset: 100 };
        }
        case "doctor":
          return { ok: true, checks: [{ name: "GitHub CLI logged in", level: "error", detail: "not logged in", fix: "gh auth login" }] };
      }
      return { ok: false, error: `unknown cmd ${msg.cmd}` };
    }
  },
  commands: { onCommand: event() },
  action: {
    setBadgeText: async ({ text }) => badges.push(text),
    setBadgeBackgroundColor: async () => {},
    setIcon: async (details) => icons.push(details)
  },
  notifications: { create: (o) => notifications.push(`${o.title} | ${o.message}`), onClicked: event(), clear() {} },
  alarms: { get: async () => null, create: async () => {}, onAlarm: event() }
};
var importScripts = () => {};
var console = { log() {}, error: print };

let failures = 0;
function check(name, condition, detail = "") {
  print(`${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : `  -- ${detail}`}`);
  if (!condition) failures++;
}
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
const send = (message) => new Promise((resolve) => chrome.runtime.onMessage.listeners[0](message, {}, resolve));
const lastLog = () => (stores.local.eventLog || []).slice(-1)[0] || "";
const logHas = (re) => (stores.local.eventLog || []).some((e) => re.test(e));
