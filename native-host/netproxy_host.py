#!/usr/bin/env python3
"""Native messaging host that lets the Escape Hatch extension drive the
netproxy scripts (start/stop/test/status/cancel/doctor) and read their log.

The browser launches this once per chrome.runtime.sendNativeMessage call,
passing one length-prefixed JSON message on stdin and expecting one
length-prefixed JSON reply on stdout.

Long-running commands (start/stop/test) are launched detached so the reply
comes back immediately; the extension polls "status" and "log" to follow
progress, which is also why everything the scripts do goes to
logs/netproxy.log.
"""
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
from datetime import datetime

VERSION = 2

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.join(REPO_DIR, "scripts")
LOG_DIR = os.path.join(REPO_DIR, "logs")
LOG_FILE = os.path.join(LOG_DIR, "netproxy.log")
# Every invocation is recorded here so "is the browser even launching the
# host?" can be answered without the browser's own debugging.
HOST_LOG = os.path.join(LOG_DIR, "native-host.log")
JOB_FILE = "/tmp/escapehatch-netproxy-job.json"
JOB_EXIT_FILE = "/tmp/escapehatch-netproxy-job.exit"
CODESPACE_NAME_FILE = "/tmp/escapehatch-codespace-name"
# Fault injection from the extension's Admin tab. Expires on its own so a
# forgotten fault can't leave the real controls broken.
FAULT_FILE = "/tmp/escapehatch-netproxy-fault.json"
FAULT_TTL_SECONDS = 10 * 60
JOB_FAULTS = {"gh-logged-out", "exit-1", "codespace-timeout", "slow-start", "hang"}
HOST_FAULTS = {"host-crash", "host-garbage", "host-slow", "status-error"}

# Copy of the extension's settings (sites, endpoint, ...) kept outside the
# browser, so uninstalling/reinstalling the extension doesn't lose them.
# Outside the repo too, so moving or re-cloning the repo doesn't either.
SETTINGS_DIR = os.path.expanduser("~/.config/eschatch")
SETTINGS_FILE = os.path.join(SETTINGS_DIR, "settings.json")

# The codespace's own state (Available, Shutdown, ...) from GitHub, cached so
# the frequent status checks don't each make a network call.
CODESPACE_STATE_CACHE = "/tmp/escapehatch-codespace-state.json"
CODESPACE_STATE_TTL = 60
CODESPACE_STATE_TTL_BUSY = 8  # while a start/stop runs, the state changes quickly

LOG_MAX_BYTES = 1024 * 1024
HOST_LOG_MAX_BYTES = 256 * 1024

BACKENDS = {
    "codespace": {
        "start": "codespace-start.sh",
        "stop": "codespace-stop.sh",
        "test": "codespace-test.sh",
        "pidfile": "/tmp/escapehatch-codespace-forward.pid",
    },
    "tunnel": {
        "start": "start-tunnel.sh",
        "stop": "stop-tunnel.sh",
        "test": "test-tunnel.sh",
        "pidfile": "/tmp/escapehatch-tunnel.pid",
    },
}

# The browser starts native hosts with a bare GUI PATH, so gh/ssh/curl from
# Homebrew wouldn't be found without this.
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/bin")]
SEARCH_PATH = ":".join(EXTRA_PATH + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])


def script_env():
    env = dict(os.environ)
    env["PATH"] = ":".join(EXTRA_PATH + [env.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")])
    env.setdefault("LC_ALL", "C")
    return env


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def rotate(path, max_bytes):
    """Keeps one previous generation (<path>.1) once a log grows too big."""
    try:
        if os.path.getsize(path) > max_bytes:
            os.replace(path, path + ".1")
    except OSError:
        pass


def append_log(line):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {line}\n")


def host_log(line):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        rotate(HOST_LOG, HOST_LOG_MAX_BYTES)
        with open(HOST_LOG, "a") as f:
            f.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] pid={os.getpid()} {line}\n")
    except OSError:
        pass


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def read_pid(pidfile):
    try:
        with open(pidfile) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return None
    return pid if pid_alive(pid) else None


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except (OSError, ValueError):
        return False


def socks5_handshake(port):
    """True if something on the port answers a SOCKS5 no-auth greeting —
    catches the case where the port is open but it isn't a working proxy
    (e.g. the local forward is up but the codespace side died)."""
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=2) as s:
            s.settimeout(3)
            s.sendall(b"\x05\x01\x00")
            return s.recv(2) == b"\x05\x00"
    except (OSError, ValueError):
        return False


def load_job():
    try:
        with open(JOB_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def current_job():
    """The in-flight start/stop/test job, or None."""
    job = load_job()
    if job and not os.path.exists(JOB_EXIT_FILE) and pid_alive(job.get("pid")):
        return job
    return None


def last_job():
    """The most recent finished job with its exit code, or None."""
    job = load_job()
    if not job:
        return None
    try:
        with open(JOB_EXIT_FILE) as f:
            code, finished = f.read().split()
        return {**job, "exitCode": int(code), "finishedAt": int(finished)}
    except (OSError, ValueError):
        # No exit file and the process is gone: it was killed before it
        # could record one.
        if not pid_alive(job.get("pid")):
            return {**job, "exitCode": -1, "finishedAt": None}
        return None


def codespace_state(name, busy):
    """GitHub's state for the codespace, or None if unknown."""
    if not name:
        return None
    try:
        with open(CODESPACE_STATE_CACHE) as f:
            cached = json.load(f)
        settled = cached.get("state") in ("Available", "Shutdown")
        ttl = CODESPACE_STATE_TTL if settled and not busy else CODESPACE_STATE_TTL_BUSY
        if cached.get("name") == name and time.time() - cached.get("at", 0) < ttl:
            return cached.get("state")
    except (OSError, ValueError):
        pass
    gh = shutil.which("gh", path=SEARCH_PATH)
    if not gh:
        return None
    code, out = run_quiet([gh, "api", f"/user/codespaces/{name}", "--jq", ".state"], 8)
    state = out.strip() if code == 0 and out.strip() else None
    try:
        with open(CODESPACE_STATE_CACHE, "w") as f:
            json.dump({"name": name, "state": state, "at": time.time()}, f)
    except OSError:
        pass
    return state


def status(backend, port):
    cfg = BACKENDS[backend]
    codespace = None
    try:
        with open(CODESPACE_NAME_FILE) as f:
            codespace = f.read().strip()
    except OSError:
        pass
    listening = port_open(port)
    return {
        "ok": True,
        "backend": backend,
        "port": port,
        "listening": listening,
        "socksOk": socks5_handshake(port) if listening else False,
        "forwardPid": read_pid(cfg["pidfile"]),
        "job": current_job(),
        "lastJob": last_job(),
        "codespace": codespace if backend == "codespace" else None,
        "codespaceState": codespace_state(codespace, busy=bool(current_job())) if backend == "codespace" else None,
    }


def active_fault():
    try:
        with open(FAULT_FILE) as f:
            fault = json.load(f)
    except (OSError, ValueError):
        return None
    if fault.get("until", 0) < time.time():
        try:
            os.remove(FAULT_FILE)
        except OSError:
            pass
        return None
    return fault


def set_fault(mode):
    if not mode:
        try:
            os.remove(FAULT_FILE)
        except OSError:
            pass
        return {"ok": True, "fault": None}
    if mode not in JOB_FAULTS | HOST_FAULTS:
        return {"ok": False, "error": f"unknown fault '{mode}'"}
    fault = {"mode": mode, "until": int(time.time()) + FAULT_TTL_SECONDS}
    with open(FAULT_FILE, "w") as f:
        json.dump(fault, f)
    host_log(f"fault armed: {mode}")
    return {"ok": True, "fault": fault}


def run_job(backend, action):
    job = current_job()
    if job:
        return {"ok": False, "error": f"'{job['action']}' is still running — wait for it or cancel it."}

    script = os.path.join(SCRIPTS_DIR, BACKENDS[backend][action])
    script_args = []
    fault = active_fault()
    if fault and fault["mode"] in JOB_FAULTS:
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fault-job.sh")
        script_args = [fault["mode"], action]
    if not os.path.isfile(script):
        return {"ok": False, "error": f"script not found: {script}"}

    rotate(LOG_FILE, LOG_MAX_BYTES)
    append_log(f"[extension] {action} requested ({backend} backend)")
    try:
        os.remove(JOB_EXIT_FILE)
    except OSError:
        pass
    try:
        os.remove(CODESPACE_STATE_CACHE)
    except OSError:
        pass

    log_fh = open(LOG_FILE, "a")
    # The codespace scripts already tee into LOG_FILE, so send their stdout
    # to /dev/null to avoid double lines; stderr (gh/ssh errors) still lands
    # in the log. The tunnel scripts only echo, so capture their stdout.
    stdout = subprocess.DEVNULL if backend == "codespace" else log_fh
    # The wrapper records the exit code so a failed start is reported as a
    # failure rather than just "finished".
    wrapper = 'out="$1"; shift; bash "$@"; code=$?; echo "$code $(date +%s)" > "$out"; exit $code'
    proc = subprocess.Popen(
        ["/bin/bash", "-c", wrapper, "netproxy-job", JOB_EXIT_FILE, script, *script_args],
        cwd=SCRIPTS_DIR,
        env=script_env(),
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=log_fh,
        # Survive this host process exiting, and get our own process group
        # so cancel can kill the script and everything it spawned.
        start_new_session=True,
    )
    job = {"action": action, "backend": backend, "pid": proc.pid, "startedAt": int(time.time())}
    if script_args:
        job["simulated"] = script_args[0]
    with open(JOB_FILE, "w") as f:
        json.dump(job, f)
    return {"ok": True, "job": job}


def cancel_job():
    job = current_job()
    if not job:
        return {"ok": False, "error": "nothing is running"}
    try:
        os.killpg(job["pid"], signal.SIGTERM)
    except OSError as e:
        return {"ok": False, "error": f"could not stop pid {job['pid']}: {e}"}
    append_log(f"[extension] {job['action']} cancelled by user")
    with open(JOB_EXIT_FILE, "w") as f:
        f.write(f"130 {int(time.time())}")
    return {"ok": True, "cancelled": job["action"]}


def read_log(lines, offset=None):
    """With offset=None, returns the last `lines` lines. With a byte offset
    (from a previous reply), returns only what was appended since, so the
    extension can stream new lines into its own log."""
    try:
        with open(LOG_FILE, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if offset is None or offset > size:  # offset > size: log was rotated
                offset = max(0, size - 64 * 1024)
            f.seek(offset)
            content = f.read().decode("utf-8", errors="replace")
    except OSError:
        return {"ok": True, "lines": [], "offset": 0, "path": LOG_FILE}
    out = [l for l in content.splitlines() if l.strip() and "setlocale" not in l]
    return {"ok": True, "lines": out[-lines:] if lines > 0 else [], "offset": size, "path": LOG_FILE}


def save_settings(settings):
    if not isinstance(settings, dict) or not isinstance(settings.get("domains"), list):
        return {"ok": False, "error": "settings must be an object with a domains list"}
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    data = {"format": "escape-hatch-settings", "version": 1, "savedAt": int(time.time()), "settings": settings}
    # Write-then-rename so a crash mid-write can't leave a truncated file,
    # and keep the previous version as .bak.
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    if os.path.exists(SETTINGS_FILE):
        os.replace(SETTINGS_FILE, SETTINGS_FILE + ".bak")
    os.replace(tmp, SETTINGS_FILE)
    return {"ok": True, "path": SETTINGS_FILE, "savedAt": data["savedAt"]}


def load_settings():
    for path in (SETTINGS_FILE, SETTINGS_FILE + ".bak"):
        try:
            with open(path) as f:
                data = json.load(f)
            if isinstance(data.get("settings"), dict):
                return {"ok": True, "path": path, "savedAt": data.get("savedAt"), "settings": data["settings"]}
        except (OSError, ValueError):
            continue
    return {"ok": True, "path": SETTINGS_FILE, "settings": None}


def check(name, ok, detail="", fix="", level=None):
    return {"name": name, "level": level or ("ok" if ok else "error"), "detail": detail, "fix": "" if ok else fix}


def run_quiet(args, timeout):
    try:
        p = subprocess.run(args, env=script_env(), capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"
    except OSError as e:
        return None, str(e)


def doctor(backend, port):
    """Host-side health checks, each with a plain-language fix."""
    checks = [check("Helper program", True, f"v{VERSION}, Python {sys.version.split()[0]}")]

    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        writable = os.access(LOG_DIR, os.W_OK)
    except OSError:
        writable = False
    checks.append(check("Log folder writable", writable, LOG_DIR, "Check permissions on the repo's logs/ folder."))

    missing = [BACKENDS[backend][a] for a in ("start", "stop", "test")
               if not os.path.isfile(os.path.join(SCRIPTS_DIR, BACKENDS[backend][a]))]
    checks.append(check(
        "Server scripts present", not missing,
        "missing: " + ", ".join(missing) if missing else SCRIPTS_DIR,
        "The repo may have moved — rerun native-host/install.sh from its new location."))

    if backend == "codespace":
        gh = shutil.which("gh", path=SEARCH_PATH)
        checks.append(check("GitHub CLI (gh) installed", bool(gh), gh or "not found", "Install it: brew install gh"))
        if gh:
            code, out = run_quiet([gh, "auth", "status"], 10)
            first = next((l.strip() for l in out.splitlines() if l.strip()), "")
            checks.append(check("GitHub CLI logged in", code == 0, first,
                                "Run in a terminal: gh auth login --web -s codespace"))
    else:
        env_file = os.path.join(SCRIPTS_DIR, "tunnel.env")
        has_env = os.path.isfile(env_file)
        checks.append(check("tunnel.env configured", has_env, env_file,
                            "Copy scripts/tunnel.env.example to scripts/tunnel.env and fill in your VPS details."))
        if has_env:
            _, key = run_quiet(["/bin/bash", "-c", 'source "$1"; echo "$SSH_KEY"', "_", env_file], 5)
            key = key.strip()
            checks.append(check("SSH key exists", bool(key) and os.path.isfile(key), key or "SSH_KEY not set",
                                "Point SSH_KEY in tunnel.env at your private key."))
        ssh = shutil.which("ssh", path=SEARCH_PATH)
        checks.append(check("ssh installed", bool(ssh), ssh or "not found", "Install OpenSSH."))

    listening = port_open(port)
    checks.append(check(f"Proxy listening on 127.0.0.1:{port}", listening,
                        "yes" if listening else "nothing on that port",
                        "Start the proxy server.", level=None if listening else "warn"))
    if listening:
        checks.append(check("SOCKS5 proxy answering", socks5_handshake(port), "handshake OK",
                            "The port is open but isn't answering as a SOCKS5 proxy — stop, then start the server."))

    last = last_job()
    if last and last.get("exitCode") not in (0, 130, None):  # 130 = cancelled by the user
        checks.append(check(f"Last {last['action']}", False, f"exited with code {last['exitCode']}",
                            "See the Server log for the error.", level="warn"))
    return {"ok": True, "checks": checks}


def handle(msg):
    cmd = msg.get("cmd")
    backend = msg.get("backend", "codespace")
    if backend not in BACKENDS:
        return {"ok": False, "error": f"unknown backend '{backend}'"}
    port = msg.get("port") or 1080

    if cmd == "ping":
        return {"ok": True, "version": VERSION}
    if cmd == "status":
        return status(backend, port)
    if cmd in ("start", "stop", "test"):
        return run_job(backend, cmd)
    if cmd == "cancel":
        return cancel_job()
    if cmd == "doctor":
        return doctor(backend, port)
    if cmd == "settings-save":
        return save_settings(msg.get("settings"))
    if cmd == "settings-load":
        return load_settings()
    if cmd == "fault":
        return {"ok": True, "fault": active_fault()} if msg.get("query") else set_fault(msg.get("mode"))
    if cmd == "log":
        return read_log(int(msg.get("lines", 200)), msg.get("offset"))
    return {"ok": False, "error": f"unknown cmd '{cmd}'"}


def main():
    host_log(f"launched argv={sys.argv[1:]}")
    try:
        msg = read_message()
    except Exception as e:
        host_log(f"bad input: {type(e).__name__}: {e}")
        return
    if msg is None:
        host_log("no message on stdin")
        return
    # Host-level faults hit every command except "fault" itself, so the
    # Admin tab can always clear them.
    fault = active_fault() if msg.get("cmd") not in ("fault", "settings-save", "settings-load") else None
    if fault and fault["mode"] in HOST_FAULTS:
        mode = fault["mode"]
        host_log(f"simulating {mode} for cmd={msg.get('cmd')}")
        if mode == "host-crash":
            sys.exit(3)  # -> "Native host has exited."
        if mode == "host-garbage":
            sys.stdout.buffer.write(struct.pack("<I", 12) + b"not json!!!!")  # -> "Error when communicating..."
            sys.stdout.buffer.flush()
            return
        if mode == "host-slow":
            time.sleep(8)
        if mode == "status-error" and msg.get("cmd") == "status":
            send_message({"ok": False, "error": "Simulated helper error: status check failed (fault injection)"})
            return

    try:
        reply = handle(msg)
    except Exception as e:  # report instead of dying silently on the browser
        reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    # status/log are polled every few seconds; only record them when they fail.
    if msg.get("cmd") not in ("log", "status"):
        host_log(f"cmd={msg.get('cmd')} -> {json.dumps(reply)[:300]}")
    elif not reply.get("ok"):
        host_log(f"cmd={msg.get('cmd')} failed -> {reply.get('error')}")
    send_message(reply)


if __name__ == "__main__":
    main()
