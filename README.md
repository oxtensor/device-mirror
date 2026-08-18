# Device Mirror

Windows remote-control desktop app (AnyDesk / Splashtop style) with tray persistence, multi-monitor screen share, speaker audio, clipboard, optional mic/camera feed into the target, and an admin privilege dashboard.

## Features

- **Tray + stay running** — closing the window hides to tray; Quit only from tray menu
- **Auto-start** — “Launch at Windows login” in Settings
- **Auto-restart** — `npm run watchdog` relaunches the app if it exits
- **Remote control** — connect by Device ID or IP; mouse, keyboard, clipboard
- **Multi-monitor** — host picks monitors; controller can switch sources
- **Speaker audio** — desktop loopback audio over WebRTC
- **Accept / Deny** dialog on the target machine
- **Remote password** — default `qweqwe` (change in Settings)
- **Admin privileges** — assign users passwordless (and optional auto-accept) access to targets
- **Feed mic/camera** — controller sends mic + camera into embedded **Device Mirror Camera** / virtual mic (no OBS)

## Quick start

```bash
npm install
# If Electron binary failed to download (network), retry:
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   node node_modules/electron/install.js
npm start
```

This starts an embedded signaling server (`:3920`) and admin dashboard (`:3921`), then opens the desktop app.

- Admin login: `admin` / `admin123`
- Dashboard: http://127.0.0.1:3921

For auto-restart:

```bash
npm run watchdog
```

Standalone server only:

```bash
npm run server
```

## How to connect

1. Run Device Mirror on both PCs (point Settings → Signal server URL to the same host if not using LAN-local embedded servers).
2. Note the **Your ID** on the target.
3. On the controller, enter that ID (or IP), password (`qweqwe` by default), Connect.
4. Target accepts (unless admin auto-accept privilege applies).
5. Use the viewer for screen, input, clipboard, and **Feed my mic/camera**.

## Admin privileges

In the admin dashboard → **Control privileges**:

- Pick a user and a target device
- Enable **No password** so that user can connect without the remote password
- Optionally **Auto-accept** to skip the Accept/Deny dialog

Create users in the Users tab, then set the same username in the desktop app Settings so privilege checks match.

## Virtual mic/camera (embedded — no OBS)

Device Mirror ships its own virtual devices:

| Device | Name in Windows |
|--------|-----------------|
| Camera | **Device Mirror Camera** (Media Foundation, Win11) |
| Microphone | **Virtual Mic Driver by MTT** (bundled signed driver) |

On first feed, the app registers the camera COM DLL under `%ProgramData%\DeviceMirror` and installs the mic driver (UAC once). Controller A/V is pumped into those devices automatically.

Build helpers (developers):

```bash
npm run build:vcam
npm run build:vdevices
```

## Architecture

| Piece | Role |
|--------|------|
| Electron main | Tray, IPC, input injection, clipboard, virtual feed |
| `dm-vdevices` | Shared-memory camera frames + WASAPI to virtual speaker/mic |
| `VCamSource.dll` | Embedded MF virtual camera (Device Mirror Camera) |
| Signaling (`socket.io`) | Device IDs, connect requests, SDP/ICE relay |
| Admin API + JSON DB | Users, devices, privileges |

## Notes

- Mouse/keyboard injection uses Win32 APIs via PowerShell (Windows only).
- **Device Mirror Camera** needs **Windows 11** (Media Foundation virtual camera API).
- First camera start needs **one admin prompt** to register `VCamSource.dll` in HKLM (`80040154` means that step was skipped). Close any old “Device Mirror Camera” error window, then approve UAC — or run `npm run install:vcam` as Administrator.
- For production across NATs, deploy one shared signaling server and consider TURN.
- Run both clients against the same `signalUrl` for ID-based discovery.
