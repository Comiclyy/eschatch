// Scenarios for background-sim.js. See that file for how to run.
(async () => {
  const install = (reason) => Promise.all(chrome.runtime.onInstalled.listeners.map((f) => f({ reason })));
  const alarm = () => Promise.all(chrome.alarms.onAlarm.listeners.map((f) => f({ name: "server-health" })));

  // --- Settings survive an uninstall: fresh install restores the backup.
  host.backup = { domains: ["reddit.com", "x.com"], proxyHost: "127.0.0.1", proxyPort: "1080", proxyScheme: "socks5", serverBackend: "codespace", notifications: false };
  await install("install");
  await wait(50);
  let cfg = await getConfig();
  check("fresh install restores sites", cfg.domains.join() === "reddit.com,x.com", cfg.domains.join());
  check("fresh install restores settings", cfg.proxyHost === "127.0.0.1" && cfg.proxyPort === "1080" && cfg.notifications === false);
  check("restore is logged", logHas(/\[INFO\] Restored 2 site\(s\)/));

  // --- Every change is backed up.
  const savesBefore = host.saves;
  await send({ type: "addDomain", domain: "example.com" });
  await wait(50);
  check("adding a site updates the backup", host.saves > savesBefore && host.backup.domains.includes("example.com"), JSON.stringify(host.backup?.domains));
  await send({ type: "removeDomain", domain: "x.com" });
  await wait(50);
  check("removing a site updates the backup", !host.backup.domains.includes("x.com"));

  // --- Manual restore adds back missing sites, never removes.
  host.backup = { ...host.backup, domains: ["x.com", "reddit.com"] };
  let r = await send({ type: "restoreSettings" });
  await wait(50);
  cfg = await getConfig();
  check("manual restore adds missing site", r.ok && r.restored === 1 && cfg.domains.includes("x.com"), JSON.stringify(r));
  check("manual restore keeps sites not in backup", cfg.domains.includes("example.com"));
  let status = await send({ type: "backupStatus" });
  check("backup status reports in sync after restore", status.ok && status.inSync, JSON.stringify(status));

  // --- Fresh install while the helper is unreachable: the (empty) new
  // install must NOT overwrite the good backup; restore happens later.
  const goodBackup = JSON.stringify({ ...host.backup, domains: ["keep.me", "and.me"] });
  host.backup = JSON.parse(goodBackup);
  stores.sync = {};
  host.missing = true;
  await install("install");
  await wait(50);
  check("unreachable helper leaves restore pending", stores.local.restorePending === true);
  await send({ type: "addDomain", domain: "new.site" });
  await wait(50);
  check("no backup while restore is pending (good backup untouched)", JSON.stringify(host.backup) === goodBackup);
  host.missing = false;
  await alarm();
  await wait(50);
  cfg = await getConfig();
  check("pending restore completes when helper is back", !stores.local.restorePending && cfg.domains.includes("keep.me") && cfg.domains.includes("new.site"), cfg.domains.join());
  check("backup then includes both old and new sites", host.backup.domains.includes("keep.me") && host.backup.domains.includes("new.site"), JSON.stringify(host.backup.domains));

  // --- Badge with no sites: still shows the proxy is off (grey), not blank.
  stores.sync = {};
  host.listening = false;
  await send({ type: "serverStatus" });
  check("badge shows OFF even with no sites", badges[badges.length - 1] === "OFF", badges.slice(-3).join(","));

  // Reset for the server scenarios below.
  stores.sync = { domains: ["example.com"] };
  stores.local.eventLog = [];

  // --- A start that fails: the real cause must reach the user, not "exit 1".
  host.jobExit = 1;
  host.jobErrorLine = "[2026-09-28 14:00:00] ERROR: not logged into gh. Run: gh auth login --web -s codespace";
  let res = await send({ type: "serverAction", action: "start" });
  check("start is accepted", res.ok);
  await wait(200);
  check("failure is stored for the UI", stores.session.serverState.lastFailure?.error.includes("not logged into gh"),
    JSON.stringify(stores.session.serverState.lastFailure));
  check("failure notification names the cause", notifications.some((n) => n.includes("GitHub CLI isn't logged in")), notifications.join(" / "));
  check("log has the FAILED line", logHas(/\[SERVER-ERROR\] start FAILED \(exit 1\): ERROR: not logged into gh/));
  check("badge shows OFF (sites listed, server down)", badges[badges.length - 1] === "OFF", badges.join(","));

  // --- A successful start clears the failure.
  host.jobExit = 0;
  host.jobErrorLine = null;
  await send({ type: "serverAction", action: "start" });
  host.listening = true;
  await wait(200);
  check("success clears the stored failure", !stores.session.serverState.lastFailure);
  check("badge shows ON", badges[badges.length - 1] === "ON", badges.join(","));
  check("uptime is tracked", typeof stores.session.serverState.upSince === "number");

  // --- The proxy vanishing on its own is reported once.
  const before = notifications.length;
  host.listening = false;
  await send({ type: "serverStatus" });
  check("unexpected drop is logged", logHas(/went down unexpectedly/));
  check("unexpected drop notifies", notifications.length === before + 1);

  // --- Stopping on purpose is not an "unexpected drop".
  host.listening = true;
  await send({ type: "serverStatus" });
  const dropsBefore = (stores.local.eventLog || []).filter((e) => /went down unexpectedly/.test(e)).length;
  await send({ type: "serverAction", action: "stop" });
  host.listening = false;
  await wait(200);
  const dropsAfter = (stores.local.eventLog || []).filter((e) => /went down unexpectedly/.test(e)).length;
  check("deliberate stop isn't reported as a drop", dropsAfter === dropsBefore);

  // --- Cancel.
  host.jobTicks = 1000;
  await send({ type: "serverAction", action: "start" });
  host.jobTicks = 1000;
  res = await send({ type: "serverAction", action: "cancel" });
  check("cancel works", res.ok && res.cancelled === "start", JSON.stringify(res));
  await wait(200);
  check("cancel isn't reported as a failure", !stores.session.serverState.lastFailure);

  // --- Admin: UI state override replaces the real state and pauses drop detection.
  res = await send({ type: "devSetOverride", state: { error: "Native host has exited.", preset: "host-crashed" }, label: "Helper crashed" });
  check("override is applied", res.state.simulated && res.state.error === "Native host has exited.");
  check("override drives the badge", badges[badges.length - 1] === "!");
  const statusCallsBefore = host.calls.filter((c) => c === "status").length;
  await send({ type: "serverStatus" });
  check("override skips real status calls", host.calls.filter((c) => c === "status").length === statusCallsBefore);
  await send({ type: "devSetOverride", state: null });
  check("clearing override returns real state", !stores.session.serverState.simulated);

  // --- Admin: other dev actions.
  const n = notifications.length;
  await send({ type: "devNotify", kind: "drop" });
  check("dev notification fires", notifications.length === n + 1);
  await send({ type: "devBadge", kind: "busy" });
  check("dev badge is set", badges[badges.length - 1] === "…");
  const logLen = stores.local.eventLog.length;
  await send({ type: "devLogs", kind: "burst", count: 100 });
  check("log burst writes every entry (no lost writes)", stores.local.eventLog.length === Math.min(1000, logLen + 100),
    `${logLen} -> ${stores.local.eventLog.length}`);
  await send({ type: "devSimulateProxyError" });
  check("simulated proxy error is logged", logHas(/\[PROXY-ERROR\] net::ERR_PROXY_CONNECTION_FAILED \| fatal=true \| details=\(simulated\)/));
  res = await send({ type: "devFault", mode: "hang" });
  check("fault is armed via the helper", res.ok && host.fault?.mode === "hang");
  res = await send({ type: "devFaultStatus" });
  check("fault status is readable", res.fault?.mode === "hang");
  await send({ type: "devFault", mode: null });
  check("fault is cleared", host.fault === null);

  // --- Diagnostics include extension-side and helper checks.
  const diag = await send({ type: "diagnose" });
  check("diagnostics merge helper checks", diag.checks.some((c) => c.name === "GitHub CLI logged in"));

  // --- Helper missing: readable error, logged once, badge "!".
  host.missing = true;
  await send({ type: "serverStatus" });
  await send({ type: "serverStatus" });
  const missingLogs = stores.local.eventLog.filter((e) => /Can't reach server control/.test(e)).length;
  check("missing helper is logged once, not per poll", missingLogs === 1, `${missingLogs} entries`);
  check("missing helper shows ! badge", badges[badges.length - 1] === "!");
  check("missing helper maps to a readable problem",
    describeServerState(stores.session.serverState).problem?.title === "Server control isn't installed for this browser.");

  // --- Unknown messages still get a reply (no "message channel closed").
  res = await send({ type: "nonsense" });
  check("unknown message type gets an error reply", res && res.ok === false);

  print(failures ? `\n${failures} FAILED` : "\nall passed");
})().catch((e) => print("CRASHED", e, e.stack));
