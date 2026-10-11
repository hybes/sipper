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

## Managed meetings

In a licensed customer's **Messages** conversation, choose **Start meeting** or
**Join meeting**. A separate Sipper window starts receiving media with microphone
and camera off. It has explicit capture, playback, leave and host controls, plus a
scrolling people table. Closing it leaves the captured session. Only one meeting
window can be open at a time; known licence/device/sign-in withdrawal closes it.
Other devices signed in as you are labelled **You (another device)**. Hosts cannot
remove themselves across devices; Leave affects only that session.

The main process validates the scoped grant and keeps it out of session storage
and phone snapshots. The sandboxed media window uses `livekit-client` 2.22.3,
connects only to its validated proxy origin and cannot control phone accounts.
Microphone/camera require explicit permission; screen sharing requires an owned
source choice, with computer audio off by default. Local tracks stop before
network acknowledgement, including when permissions return after leaving.
Microphone, speaker and camera choices are implemented. Listing devices requests
no capture permission; selecting an input does not enable capture. Active input
switches use the normal permission flow and stop late results after departure.
Device names may remain hidden until permission is granted. Speaker selection
is disabled where the runtime does not support it.

Joining holds connected phone calls through confirmed SIP negotiation before the
native engine gives the meeting its microphone/speaker ownership. Leave, Close
or failed joining returns to the captured phone call/conference when it still
exists and no other phone call is active. A reused call ID or changed conference
cannot be resumed accidentally. Placing, answering or resuming a phone call
closes the meeting and waits for destroyed media contents before returning phone
audio; choosing another call keeps the former call held. Auto-answer does not
interrupt an open meeting. Ownership remains in memory and reaches a restarted
engine through its startup contract.

The 1 October model suite passes 125 cases; a real model/controller/SIP-engine
case passes hold/join/close/return and explicit resume with a disposable registrar
and null audio. Computer use reviews the actual renderers/IPC/controller with
fictional calls and stalled signalling: return guidance, failure, pending join
cancellation, empty connecting roster and switching to another held call.
These checks do not prove physical Windows audio, connected SDK media or keeping
a paused meeting's video session open across phone interruptions.

Portal migration 036 and the current meeting API are required. No desktop key is
needed; server settings and proof boundaries are in [Managed meetings](../docs/MEETINGS.md).
The local Electron-on-Mac rehearsal receives generated camera and screen tracks
and exercises declined capture permissions, host removal and confirmed end.
One subsequent fresh native join, retry and Leave rehearsal also passed. Later
normal-process joins again timed out establishing media in Electron and RTC Node.
The current RTC Node rehearsal now passes after correcting its private media
address, including a controlled reverse comparison. Fresh Electron media
acceptance with that correction remains pending. The latest
device UI review covers enumeration and the disabled/error state without capture.
Actual Windows device/capture acceptance and packaged operation remain outstanding.
Hold/join/return is implemented and checked locally; keeping a meeting paused
across phone calls remains work. This managed feature has not been released.

## Managed messages

Open **Messages** in the sidebar or press **Ctrl+4** after connecting a licensed
customer in Managed accounts. Colleague search supports direct conversations and
named groups of up to 20 people. Conversation and history pages hold at most 100
rows, with older/latest controls, unread counts and shared user read state.
Group owners can change the name, members and owner; participants can leave.
New or rejoining members see messages sent after they joined.

OAuth, access checks and response validation remain in the main process. Only
validated message pages reach the renderer through eight explicit IPC services;
tokens and SIP settings do not. History and conversation metadata expire
independently within 30 seconds. Five-second polling runs while visible; customer,
identity, access or background changes clear pages. Bodies, drafts and pending
send IDs remain in memory, with no message archive in the session store. An
unconfirmed send offers an exact-ID retry or discard.

Apply portal migrations through 034 before upgrading clients. No new dependency, provider
key or environment setting is required. Bodies use server-readable encryption;
desktop message alerts need no extra provider key. Enable **Notify me about managed
messages** under Managed accounts to receive generic **New message** notices while
Sipper is running. Clicks recheck access before opening the conversation; Windows
notification settings apply. See [the messaging protocol](../docs/MESSAGING.md).

All 120 Node checks pass. `pnpm test:windows-portal` from `portal/` runs ten phases
against an isolated real portal, including messaging/retries/replies/read state,
group ownership, leaving and rejoining with restricted history, the opaque alert
feed and main-process polling/click access checks without OS delivery,
existing SIP calling and withdrawal. The renderer passes fictional component QA
at normal and 820×540 sizes, including paging and outage recovery. These checks
run on macOS with in-memory token storage and a temporary browser bridge; actual
Windows, Electron IPC/DPAPI, packaged callbacks and provider delivery remain
separate acceptance requirements.
The new group settings controls still need visual review.

## Shared calling preferences

Managed customer settings also include **Available**, **Away**, **Busy** and
**Not set**. This is a manual status shared across devices for each customer and
visible to its administrators. It persists until changed or cleared and does not
change call handling or prove reachability. Portal migration 029 enables it;
no new key is required. Missing or uncertain values show **Unavailable**.

Managed customer settings include a per-customer Do Not Disturb control. Gateway
admission changes immediately across devices. Updated direct PBX accounts apply the
preference with their next configuration refresh, normally each minute and after
a native preference change. The SIP engine rejects new incoming direct calls with
486 before presenting them. Registration, outgoing calls, personal accounts and
calls already ringing or connected continue unchanged. Offline direct clients keep
the cached policy until configuration expiry; this does not configure the PBX.
Only a confirmed server reply changes the displayed preference. Failed reads,
uncertain saves and missing values show **Unavailable** until refresh succeeds.
No additional keys are needed.

## Transfers

During a connected call, choose **Add call** or press **Ctrl+N** to open the
dialler using that call's account. Opening it leaves the conversation alone;
placing the second call waits for confirmed hold on the first. **Return to…** or Escape cancels the
draft. Once both calls connect, open **Transfer** and choose **Connect with…**.
Account-menu shortcuts and SIP/tel links use the same draft path; links never
dial automatically. Answering or swapping calls returns to the call controls.

Hold commands carry the captured account/start-time identity and complete only
after SIP acceptance and negotiated media confirm the change. Rejection stops a
consultation, answer or swap and shows an alert. Held state is never optimistic;
a connected call remains usable after managed access is withdrawn. Both parties
can hold simultaneously, and local resume can succeed while the other party
remains held. Commands time out after four seconds, but an unresolved transaction
continues to block new calls/answers/resumes until its final result or hang-up.
Hang-up remains responsive. Concurrent app audio changes cannot bypass that wait.

Two connected calls on the same account can be merged into a local conference. The native
mixer forwards audio between the remote participants; shared mute affects your microphone.
Hold and resume wait for both SIP negotiations, restoring completed changes if the second
participant rejects the action. The audio gate also covers starting/answering/switching calls.
Each participant has a keypad, Remove and Separate controls. Separate holds both calls,
removes the mixer links, then resumes only the selected participant. If resume fails, both
separate calls stay held. End conference closes only its captured members. A fresh group
reference on every merge prevents old controls from ending a later regrouping. Transfers
require separation first. The existing recording includes both remote streams while joined;
recording interoperability and physical audio still require device verification.

Blind and attended transfers use captured account/start-time identities through
the renderer, main process and native engine. Both calls must be connected and
belong to the same available account; pending transfers reserve both legs. Gateway
targets accept formatted phone numbers/extensions of at most 128 characters after
formatting is removed. Direct accounts retain SIP-address dialling. Failure leaves
the calls connected. The native loop closes the original local legs after success,
including an early successful NOTIFY, without letting a late result end a reused ID.

The real gateway rehearsal passes blind/attended encrypted-media handoff and remote
hangup reporting with the Windows engine built on macOS. The renderer component's
gateway/direct labels, captured action payloads, same-account choices, disabled
pending state, failure recovery and Escape cancellation pass a fictional browser
review in dark mode. That review does not exercise Electron IPC or native Windows.
Shared gateway endpoints still disable transfers pending release/interoperability
checks; upstream endpoints always reject REFER. No new keys or dependencies are needed.

The consultation flow also passes through the real AppState and local SIP engine,
including automatic hold and cleanup of both transferred legs. A browser rehearsal
of the renderer backed by that same app state verified Add call, Ctrl+N, Escape,
return, second-call selection and attended transfer at normal/minimum window sizes.
It uses a loopback server and null audio on macOS; Electron IPC, actual Windows and
remote-party media after this fixture's simulated transfer still require verification.

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
| `SIPPER_MANAGED_SERVER` | Management origin; override is accepted only in unpackaged builds with an explicit `SIPPER_DATA_DIR`. HTTP is limited to loopback development. |
| `SIPPER_LOG_STDERR=1` | Mirror `Sipper:` log lines to stderr |

Development copies never register a login item or links, and on a Mac the browser helper is not
offered, so a test run cannot take over the Mac app's links or its helper.

## Managed setup links

Settings → Managed accounts accepts the web setup link generated by a customer administrator. `sipper://setup` also opens that form, including when the app is already running or on another settings tab. Opening a link does not enrol or place a call. Sign in with the invited email, then select **Connect with setup link**. Redemption checks the returned identity and active licence before normal device enrolment and configuration. The reference is held only in window memory and is excluded from saved sessions and routine status snapshots. Another origin, malformed links and late responses after sign-out are rejected. See [the portal contract](../portal/README.md#managed-setup-links).

The source Electron UI's initial and second-instance routing have been checked on macOS in an empty, isolated profile. Installed Windows protocol registration, DPAPI and browser sign-in still need actual Windows verification.

## Company directory

**Contacts → Company directory** shows shared contacts for a connected customer,
separately from personal contacts. Search by name, company or number, then call a
labelled number using a current account belonging to that customer and device.
The main process rechecks both the contact and exact account before dialling.
Complete snapshots use the existing encrypted managed session store, expire at
the earliest page expiry and clear on sign-out, disconnect or access withdrawal.
No new environment setting or provider key is required. See
[Company directory](../docs/COMPANY-DIRECTORY.md#windows-app) for limits and proof boundaries.

Contact detail also shows voluntarily shared availability and Do Not Disturb.
The administrator links the directory contact to a customer member; that person
opts in at the portal's **Calling preferences → Share status**. Status refreshes
every 20 seconds while visible, expires after 30 seconds and is never saved with
offline contacts. Hidden, expired and failed observations show **Status unavailable**.
These preferences do not establish reachability or affect the Call button.
Separate **Share call activity** consent shows recent managed call observations
with their app/gateway source. Missing activity does not mean available. Reports
older than three minutes are hidden, and rereading cannot extend that deadline.
Deploy portal migrations 030/031 and the new API before this client; older portals
remain usable with their existing status fields.

## Tests

Managed-account integration is implemented locally and has not been released. `src/main/managedClient.js` handles public-client OAuth code+PKCE, token refresh, enrolment, provisioning and reports. `managedStorage.js` uses a separate OS-encrypted file per server and refuses plaintext keyring fallbacks. Settings are validated before mapping to runtime-only accounts; they do not enter personal account/profile JSON or the manual password store. Renderer snapshots omit managed SIP connection fields and all tokens/passwords. Settings → Managed accounts provides browser sign-in, customer enrolment, refresh, disconnect and sign-out. Managed profiles/accounts are read-only. Every minute the controller refreshes settings and reports observed registration state, SIP response codes and direct-call counts. Its existing one-second loop also reports changed observations, limiting background attempts to one every five seconds, skipping unchanged engine work, retrying failed changes and refreshing settings on a revision conflict; it only acknowledges a revision once the engine confirms application. A one-second controller check removes expired cached settings, and the native engine independently enforces expiry. Established calls can finish after withdrawal; new calls, answers and transfers are rejected. Credential changes wait until existing calls finish. Managed history cannot silently redial through a personal account after disconnect or restart.

Gateway accounts now use authenticated caller lookup and answer reservations through the management API. Caller details remain hidden until verified. Cancellation, per-device decline, another device answering, microphone denial, native answer failure and stale asynchronous replies are handled without answering a reused call ID. The engine requires verified TLS, SHA-256 and mandatory SRTP for gateway accounts; it rejects missing/duplicate call references and arbitrary outgoing SIP destinations. Windows' Schannel build applies the tracked CNG SHA-256 patch in `scripts/pjsip-schannel-sha256.patch`; TLS remains on Schannel. Its checksum is recorded in the library's build information and CI cache key.

Network recovery uses Windows IP Helper notifications for [interfaces](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-notifyipinterfacechange), [addresses](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-notifyunicastipaddresschange) and [routes](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-notifyroutechange2), plus Electron sleep/wake events. Native callbacks only mark changes; the existing engine loop checks usable non-loopback interfaces and settles changes for 500ms before asking PJSIP to restore transports, registrations and media. Connected calls retain their dialogs. Withdrawn accounts have their registrar removed and cannot be registered by recovery; failed removal blocks recovery and is retried. Accounts added offline register when a path returns. Managed settings refresh after a recovery request, and the portal report cannot attach an old successful SIP code to an offline failure. No new dependency or environment key is required.

The regression checks offline startup, UDP/TCP recovery, retained calls, withdrawn bindings and permanent credential errors. The separate gateway test checks a cancelled recovery on sleep, wake while still offline, three successive recoveries and another after withdrawal, requiring fresh SDP/ICE and advancing encrypted Opus packets in both directions. These checks run with injected network events and null audio on macOS. The Windows notification APIs, actual sleep/wake, Schannel and physical network handover still need Windows testing.

All 121 Node checks pass using fictional domains and injected transport/storage fixtures. The C engine is built on macOS: 24 regression cases pass with real local SIP and silent audio, including expiry, revocation, deferred settings, asynchronous ICE setup, negotiated hold, rejected REFER and captured transfer cleanup. The opt-in gateway case is excluded from that run and passes separately through twelve phases: conference tone forwarding, shared hold/separation and native blind/attended encrypted-media handoff and nine incoming phases, alongside actual AppState actions, provisioning/report APIs, unknown-CA rejection, verified registration, bidirectional Opus/SRTP/ICE packets and withdrawal continuity. The signed-out settings screen was visually checked in an isolated Electron profile. Windows CNG/Schannel execution, DPAPI, packaged browser callbacks, signed-in UI against the portal and physical audio remain unverified and are required before publishing the managed client. See `.env.example` for desktop development settings; the app does not automatically load that file.

```bash
npm test             # unit tests: models, SIP parsing, import links, AppState (ported from SipperTests)
npm run test:engine  # two engines call each other through tools/sip-test-server.py; the browser helper's framing
npm run test:e2e     # drives the app: add an account, call, answer in the alert window, a missed call, a link import
```

`test:engine` and `test:e2e` need Python 3 and the built engine. `test:e2e` writes screenshots to
`tests/e2e/output`; set `SIPPER_APP` to a packaged `Sipper.exe` to test a build.
Use `windows/engine/build-windows.ps1 -Testing` before the engine tests on Windows; the
digest check compares both plaintext and precomputed MD5/SHA-256 responses with Node's
independent implementation. Rebuild without `-Testing` before packaging; CI does this.
The Mac development build includes test hooks automatically. To reproduce the isolated
gateway stage on a Mac, follow `gateway/README.md`, then run from `portal/`:

```bash
SIPPER_WINDOWS_GATEWAY=1 node --import tsx --env-file-if-exists=.env scripts/gateway-smoke.ts
```

This uses the Windows app's JavaScript and C engine on macOS. It does not substitute for
Windows runtime verification. No Microsoft, SIP provider or OAuth secrets are required.

## Real local portal acceptance

From `portal/`, run `pnpm test:windows-portal` after `pnpm build`. Start the local
PostgreSQL and Mailpit services described in the portal README, and build the
engine with `windows/engine/build-macos.sh`. The local test database role must be
able to create and drop databases. No provider keys are needed.

The shared harness creates its own database, server, SIP registrar and temporary
personal store. It exercises the real `openid-client` PKCE exchange and token
refresh, identity binding, provisioning, directory calls through AppState,
registration/call/IP/activity reports, suspension/resumption, remote device
revocation and sign-out. A personal registration and established call survive
managed withdrawal. Its temporary `SIPPER_TEST_PORTAL_FILE` is generated and
removed by the harness; do not create or set it manually.

Verified MFA and consent run over HTTP. Token/settings storage is an in-memory
fixture, and audio is silent. This check currently passes on macOS using the
Windows app's JavaScript and C engine. Windows DPAPI, Schannel, packaged browser
callbacks, signed-in UI and physical audio still require Windows acceptance.

## Building the installer on Windows

Visual Studio 2022 with the C++ tools, CMake, Git, Node 24 and Python 3:

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

Release checklist: bump `version` in `package.json`, let the workflow build the installer on
main, and publish `Sipper-<version>-Setup.exe` with its SHA-256 and a source archive (the
repository at the tag plus the pjproject and Opus sources) as a GitHub release tagged
`windows-v<version>`. Then set `WINDOWS_DOWNLOAD_URL` in `website/wrangler.jsonc` and deploy the
site. Licence texts are collected by `scripts/copy-licences.mjs` into `resources\Licenses`.
