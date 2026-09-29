# Setup

Setup has three parts: load the extension, register the helper that lets it
start the server, and set up one backend for the server to run on.

## 1. Load the extension

1. Open your browser's extensions page: `vivaldi://extensions`,
   `chrome://extensions`, `edge://extensions`, …
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the repo's `extension/` folder.
4. Note the **extension ID**, a 32-letter string such as
   `opchgdmmkebjdmkcmbfboapbofhjljnm`. It's also shown at the bottom of the
   dashboard's sidebar.

> The ID is fixed by the `key` in `manifest.json`, so it stays the same even
> if the repo is moved or renamed.
>
> **Reinstalling?** Your sites and settings are restored automatically from
> `~/.config/eschatch/settings.json` (see
> [Features → Sites](features.md#sites)).

## 2. Register the server-control helper

The extension can't run programs by itself. A small helper program,
`native-host/netproxy_host.py`, does that for it, and it has to be registered
with the browser once:

```sh
native-host/install.sh <extension-id>
```

The dashboard's **Server** tab shows this command with your ID already filled
in, and has a Copy button.

The script:

- writes a launcher, `native-host/netproxy_host`, that pins the `python3` it
  found. Browsers start helpers with a minimal PATH, so it can't rely on your
  shell's.
- registers the helper for every supported browser it finds: Chrome, Edge,
  Brave, Chromium, Vivaldi and Arc. Registration is a small JSON file in
  `~/Library/Application Support/<browser>/NativeMessagingHosts/`, and only
  your extension ID is allowed to use it.

Then **reload the extension**. On first reload the browser asks for the
`nativeMessaging`, `alarms` and `notifications` permissions.

Re-run `install.sh` if:

- you move or rename the repo (the registration stores the helper's path), or
- the `python3` it pinned is uninstalled or moved.

## 3. Pick a backend

The **Server** tab has a *Backend* selector. It decides which scripts the
Start/Stop/Test buttons run.

### GitHub Codespace (default)

Runs the proxy inside the `Comiclyy/escapehatch-proxy` Codespace and
port-forwards it to `127.0.0.1:1080`.

You need:

- the GitHub CLI: `brew install gh`
- to be logged in with the codespace scope:
  `gh auth login --web -s codespace`

Scripts: `scripts/codespace-start.sh`, `codespace-stop.sh`,
`codespace-test.sh`. Starting from cold takes roughly 30–90 seconds, while
GitHub boots the codespace.

Stopping also shuts down the codespace, to save your free hours.

### SSH tunnel to a VPS

Opens `ssh -D 1080` to your own server.

1. Set up the server once with `vps-setup/setup-vps.sh`. This creates a
   tunnel-only user and makes SSH also listen on port 443.
2. Copy `scripts/tunnel.env.example` to `scripts/tunnel.env` and fill in
   `VPS_IP`, `VPS_PORT`, `VPS_USER` and `SSH_KEY`.

Scripts: `scripts/start-tunnel.sh`, `stop-tunnel.sh`, `test-tunnel.sh`.

### Optional: the `netproxy` command

To control the server from a terminal as well, put the repo's CLI on your PATH:

```sh
ln -s "$PWD/scripts/netproxy" ~/bin/netproxy   # run from the repo root
netproxy start | stop | test | status | log | sitelog | netlog
```

It finds the repo by following the symlink, so nothing in it hardcodes the
path. If you move the repo, re-create the link.

## 4. Point the extension at the proxy

In the dashboard's **Server** tab, under **Endpoint**, set:

- **Type** SOCKS5
- **Host** `127.0.0.1`
- **Port** `1080`

Then press **Save**.

## 5. Check it

Open the **Diagnostics** tab. Every line should be ✓. For anything else, the
line says what to do; see also [Errors & troubleshooting](errors.md).

Then press **Start** on the Overview or Server tab, wait for the dot to turn
green, and press **Test**. The Test result appears in the log, and as a
notification if notifications are on. It should say traffic is exiting
through the codespace or VPS, not your own IP.
