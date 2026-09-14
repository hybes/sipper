# Sipper for Windows

The Windows version of Sipper: the same accounts, profiles, calls, history, contacts, recording and
browser-extension import as the Mac app, built as an Electron app around a small PJSIP engine.

- **Interface** (`src/renderer`): Preact with htm, no build step, in the Windows 11 visual language
  with Sipper's teal accent. Pages are served from `app://sipper/` with a strict content security
  policy; windows run sandboxed and reach the main process only through `src/preload/preload.cjs`.
- **Main process** (`src/main`): `AppState` (a port of the Mac app's model), JSON storage, encrypted
  passwords, the notification-area icon, notifications, the incoming-call window, link handling and
  the browser helper installer.
- **Engine** (`engine/`): `sipper-engine.exe`, a C port of `Sipper/SIP/SIPEngine.swift` that runs
  as a child process and speaks JSON lines ([engine/PROTOCOL.md](engine/PROTOCOL.md)). A crash in
  the engine cannot take the window down; Sipper restarts it.
- **Browser helper** (`engine/src/native_host.c`): `sipper-browser-host.exe`, the native messaging
  host for the Chrome extension ([docs/PROTOCOL.md](../docs/PROTOCOL.md)).
- **Shared rules** (`src/core`): account URIs, SIP address parsing, the import parser and display
  formatting, used by the main process and the interface.

Requirements: Windows 10 version 1903 or later, or Windows 11, 64-bit (x64).

## How it differs from the Mac app

| | Mac | Windows |
|---|---|---|
| Passwords | Keychain | `passwords.json`, encrypted with the Windows Data Protection API for the signed-in user |
| Data | `~/Library/Application Support/Sipper` | `%APPDATA%\Sipper` (the same JSON files) |
| Echo cancellation | Apple voice processing | WebRTC, on the selected devices |
| Audio devices | Core Audio | WMME; Windows shortens device names to 31 characters |
| Recordings | WAV, converted to M4A | WAV (16 kHz mono, about 2 MB per minute) |
| Incoming calls | Floating panel and notification | Alert window above the taskbar and a call notification with Answer and Decline |
| Status | Menu bar item | Notification-area icon; closing the window keeps Sipper running while the icon is shown |
| iCloud sync | Optional | Not available |

Keyboard shortcuts: Ctrl+N new call, Ctrl+Enter answer or hang up, Ctrl+Shift+D decline,
Ctrl+Shift+M mute, Ctrl+Shift+H hold, Ctrl+Shift+A add account, Ctrl+Alt+D Do Not Disturb,
Ctrl+1/2/3 Dialer, History and Contacts, Ctrl+, Settings. During a call, typing digits sends DTMF.

Links: the installer registers `sipper:` links and offers Sipper for `sip:`, `sips:` and `tel:` in
Settings › Apps › Default apps (Settings › General › Phone links opens the page). A phone link only
fills in the dialer; Sipper never dials on a link's say-so. Notification buttons open
`sipper://toast/…` links carrying a random per-run token, so web pages cannot answer calls.

## Developing on a Mac

The engine builds for macOS against the PJSIP that the Mac app uses, so the whole app runs and is
tested here against the local test server.

```bash
make pjsip                          # at the repository root, once
windows/engine/build-macos.sh       # sipper-engine and sipper-browser-host into windows/engine/build
cd windows
npm ci
node node_modules/electron/install.js   # npm 12 skips Electron's download script
npm start
```

For a throwaway profile that leaves your data, passwords and speakers alone:

```bash
SIPPER_DATA_DIR=/tmp/sipper-dev SIPPER_TEST_PASSWORDS=memory SIPPER_NULL_AUDIO=1 npm start
```

| Variable | Effect |
|---|---|
| `SIPPER_DATA_DIR` | Data folder instead of the default (also separates single-instance locks) |
| `SIPPER_TEST_PASSWORDS=memory` | Passwords in memory only (development copies only) |
| `SIPPER_NULL_AUDIO=1` | PJSIP's null audio device: no microphone or speaker is opened |
| `SIPPER_ENGINE` | Engine binary to run (development copies only) |
| `SIPPER_LOG_STDERR=1` | Mirror `Sipper:` log lines to stderr |

Development copies never register a login item or links, and on a Mac the browser helper is not
offered, so a test run cannot take over the Mac app's links or its helper.

## Tests

```bash
npm test             # unit tests: models, SIP parsing, import links, AppState (ported from SipperTests)
npm run test:engine  # two engines call each other through tools/sip-test-server.py; the browser helper's framing
npm run test:e2e     # drives the app: add an account, call, answer in the alert window, a missed call, a link import
```

`test:engine` and `test:e2e` need Python 3 and the built engine. `test:e2e` writes screenshots to
`tests/e2e/output`; set `SIPPER_APP` to a packaged `Sipper.exe` to test a build.

## Building the installer on Windows

Visual Studio 2022 with the C++ tools, CMake, Node 24 and Python 3:

```powershell
windows\scripts\build-pjsip.ps1     # PJSIP 2.15.1 and Opus 1.6.1 into windows\vendor\pjsip-win (about 15 minutes)
windows\engine\build-windows.ps1    # sipper-engine.exe and sipper-browser-host.exe
cd windows
npm ci
npm run dist                        # dist\Sipper-<version>-Setup.exe
```

GitHub Actions does the same on every push that touches `windows/`
(`.github/workflows/windows.yml`), runs all three test suites against the packaged app and uploads
the installer as the `Sipper-windows-x64` artifact.

The installer is per-user (no administrator rights) and not code-signed yet, so Windows SmartScreen
warns about an unknown publisher on first run. Signing needs a certificate (for example Azure
Trusted Signing, or SignPath's free programme for open-source projects).

Release checklist: bump `version` in `package.json`, let the workflow build the installer, attach
`Sipper-<version>-Setup.exe` to the GitHub release next to the DMG, and set `WINDOWS_DOWNLOAD_URL`
for the website. Licence texts are collected by `scripts/copy-licences.mjs` into
`resources\Licenses`; publish the source archive with each release as for the Mac app.
