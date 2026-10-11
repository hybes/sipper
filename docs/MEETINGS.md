# Managed meetings

The local service uses self-hosted LiveKit for customer-scoped meeting access.
It reuses conversation participants and named-user licences. Several devices
belonging to one user consume one seat. Staff roles do not grant participant access.

**Current boundary:** the service/API, signalling proxy, server controls, browser
interface, Windows Electron meeting window and native Mac/iOS/Android meeting
screens are implemented locally. Apple and Android phone/meeting audio is mutually
exclusive; Windows holds phone calls for a meeting and returns to the exact
previous call when leaving. Native screen publishing/device choices/background
meeting ownership, seamless meeting pause/resume across phone interruptions,
browser SIP audio coordination, hardware
permission acceptance, TURN/TLS network acceptance and physical-device checks
remain outstanding. This is not a published
video feature or proof of SIP video interoperability.

## Portal

Start or join from a conversation in **Messages**. Joining starts with microphone
and camera off. Explicit controls enable microphone, camera or screen sharing
only through the browser's normal permission flow. Turning capture off stops the
local track before network work; cancellation or a permission result arriving
after leaving cannot attach capture to a replacement room. Capture can be stopped
while the room reconnects. Leaving or navigating away stops all local tracks and
withdraws that exact join session, including a pending request.

Incoming audio, camera and screen tracks use the official browser SDK. The people
table comes from the actual room and subscribed track state. The host can remove
a person across all their devices or end the room; a later room has a fresh
identity. Browser checks use fictional users and generated media, not hardware
capture.

Customer **More → Meeting activity** provides a paged, scrolling management table.
Open means new authorised joins can be accepted; active admissions do not prove
connected audio/video. Closed/expired meetings have no active admissions. End and
removal requests remain pending until the server confirms them. Support staff
can inspect history; management rights and MFA are required to end a room, and
management access does not grant permission to join private conversations.
Service status includes meeting configuration, control queues and worker progress.

## Windows app

Open a conversation in **Messages**, then **Start meeting** or **Join meeting**.
One separate meeting window can remain open while navigating the phone app.
It uses the pinned official LiveKit client and starts with microphone/camera off.
The people table and incoming audio, camera and screen elements follow actual SDK
participants and subscribed tracks. Host removal and end use the same durable
server controls as the portal. Other devices belonging to the signed-in user are
labelled **You (another device)** and have no Remove action. The service rejects
self-removal across all clients; Leave withdraws only that session, while End
disconnects everyone.

Only this window can receive its short-lived grant. It cannot read phone settings,
control SIP accounts or call general app services. Grants stay in memory; the
window's content security policy allows only its validated signalling origin.
The initial loading document receives no grant, including delayed IPC requests
after preparation finishes. Closing, known access withdrawal and quitting stop
local media and withdraw the exact pending/confirmed session. Uncertain preparation
retries its UUID; a retired session gets a new UUID.

Microphone/camera require an explicit Sipper permission dialogue. Screen sharing
requires a current user gesture and selection from the owned source picker;
Windows computer audio is a separate choice, off by default. A late permission
result cannot start capture in a replacement/disconnected room. Microphone,
speaker and camera choices use the existing SDK; enumeration explicitly avoids
requesting capture permission. Device selection does not enable a disabled input.
Switching an active input uses the normal permission flow, and a late result is
stopped in its former room. Names may remain hidden until permission is granted.
Unsupported speaker selection is disabled. Physical capture, actual device/source
selection and audio hardware ownership on Windows still need acceptance.

Joining holds connected phone calls through confirmed SIP negotiation before the
native engine gives the meeting audio ownership. Failed preparation or joining
returns to the previous call when it still exists. Leaving/closing resumes only
the captured call or conference; reused call IDs, changed groups, transfers and
another active phone call cannot be restored accidentally. Ownership stays out of
the saved app data and survives a SIP engine restart through its startup contract.

Placing, answering or resuming a phone call closes the meeting first. Media-frame
destruction is confirmed before native phone audio is released; switching to a
different call keeps the former call held. Auto-answer does not interrupt an open
meeting. Permission, close and pending-join races retain their scoped fences.
This is hold/join/leave/return, rather than keeping a meeting's video session open
while its audio is paused for a phone call. That richer interruption flow and
actual Windows hardware/system-device acceptance remain pending.

Apply portal migration 036 and the current meeting API before this client. There
are no additional desktop keys or environment settings. Removal responses retain
the authenticated `userId` binding and identify the removed person separately as
`targetUserId`.

## Native Mac/iOS screens

Open **Meeting** from a managed conversation. The shared SwiftUI screen uses the
pinned official LiveKit Swift SDK 2.17.0, WebRTC 150.7871.02 and UniFFI 0.1.9.
Xcode 16.3 or newer is required. Metadata is checked before joining; unavailable
service, phone activity, loading and teardown disable the appropriate controls.
Join starts with microphone input disabled and camera off. Remote audio uses the
SDK, with incoming camera/screen tracks rendered through its native SwiftUI view.
The scrolling people table follows SDK participants/publications, rather than
assuming server admission means connected media. Host removal/end require a
fresh scoped snapshot and confirmation. Your other devices have no Remove action.

Turning an input off stops/unpublishes its track. Explicit microphone/camera
buttons use Apple's permission flow; its result must still belong to the same
current, connected and authorised session. Leave first disables the SDK audio
engine, cancels pending work, disconnects and waits for pending joins/capture
before withdrawing the exact session and releasing phone audio. Late HTTP joins
are included in cleanup. Grants are never archived. Metadata expires independently
of a stalled poll; existing media does not require successful portal polls.
Known identity/device/licence withdrawal and an ended/revoked session stop media.
A failed remote Leave is shown separately from stopped local media.

Mac and iOS prevent starting/answering/resuming a phone call while meeting audio
is claimed, and refuse a meeting while phone audio/calls are pending. iOS CallKit
activation cannot open PJSIP audio during that claim. Incoming calls remain visible;
the meeting screen stops when it observes phone activity. This is an exclusive
audio guard, not seamless hold/restore or a meeting CallKit implementation. iOS
meeting media stops on background; joining again is explicit. Native screen
publishing, device selectors and physical capture remain pending.

The standalone native screen review uses a separate app, an in-memory store and
intercepted fictional API replies, with no SIP accounts or working media service.
Computer use checked Mac entry, disabled service/phone states, recoverable errors,
host confirmation and Close. It does not prove connected participants or video.
The iPhone fixture builds and launches on a disposable simulator, but Device Hub
could not be controlled through computer use, so visual mobile acceptance is still
pending. The eight real CallKit lifecycle test methods pass using recording
providers; they do not grant capture permission or prove lock-screen/system audio.

## Native Android screen

Open **Meeting** from a managed conversation. The native Compose screen uses the
pinned official LiveKit Android SDK 2.29.0, WebRTC 144.7559.14 and UniFFI 0.1.12.
The existing managed conversation transport supplies scoped metadata and
short-lived grants. Start/join retries retain their exact UUID; grants stay in
memory and are never saved in the managed vault. The client checks the current
identity, licensed customer and enrolled device before and after HTTP, exact
meeting/session binding, safe signalling origin and restricted media privileges.
The proxy/SFU verifies signatures. Local WS requires an explicitly configured
loopback development client; ordinary builds require WSS.

Joining starts with microphone and camera off, including disabled audio
prewarming. Incoming audio and native camera/screen rendering use the SDK. The
scrolling people table follows its actual participants/publications; server
admission alone is not connected-media evidence. Hosts confirm removal/end;
their other devices have no Remove action. Metadata expires independently of a
pending poll, and foreign-conversation details cannot authorise a join. Known
access withdrawal invalidates an open screen even when the outer account status
has not changed.

Microphone/camera buttons request normal Android permission explicitly. A late
permission or publication result must still belong to the same authorised,
connected room. Turning capture off stops/unpublishes its local track. Leave
immediately mutes input/output and stops tracks, then cancels and waits for joins
and capture, releases the SDK room and withdraws the exact pending session before
releasing phone audio. Remote Leave failure is shown separately from stopped
local media. Meetings refuse pending phone audio/calls, and phone start/answer/
resume cannot acquire audio while a meeting owns it.

The current Android meeting owner is foreground-only: stopping the activity
stops meeting media; rejoining is explicit. A meeting Core-Telecom/foreground
service owner, native screen publishing, device selectors and seamless phone
handoff remain pending. Permission declarations do not grant capture consent.

Ten JVM tests and all 34 managed-client instrumentation cases pass, including
exact pending-join withdrawal, non-persistence, foreign/expired grants and
metadata, phone-audio refusal and late access loss. Debug/test and unsigned
Release APK/AAB builds pass. Release packages contain 14 native libraries across
arm64/x86_64; their load segments and APK packaging meet the 16 KiB alignment
checks. SDK/WebRTC/AudioSwitch/JNA licence texts are bundled; the complete binary
notice inventory remains a release audit item.

Computer use checked portrait entry, recoverable service failure, disabled
service/phone states, host confirmation/cancel and Close using a separate
fictional fixture app with no SIP accounts or functioning media server. No
microphone/camera permission was granted. The fixture app/source are removed
and normal debug packages restored. Connected native participants, actual media,
landscape/dark-mode meeting layout, lock-screen behaviour and physical devices
remain unverified. No new app key is required; server settings are below.

## Shared Mac/iOS API

`SipperManaged` implements `currentMeeting`, `startMeeting`, `meetingDetails`,
`joinMeeting`, `leaveMeeting`, `endMeeting` and `removeMeetingPerson` using the
existing bearer authentication and owned enrolment. The common conversation
request path rechecks current identity, customer membership and licence after
each reply. Start/join accept caller-owned UUIDs so uncertain retries retain the
exact request/session identity; an already-open room can have another start UUID.

Responses bind the customer, device, user and bounded metadata expiry. The client
rejects mismatched room/session grants, unsafe signalling origins, expired tokens
and extra media administration privileges. These are binding/privilege checks;
the proxy and SFU verify the token signature. Grants and history are Decodable
only, remain in memory and never enter the Keychain archive. Local WS is restricted
to loopback and an explicitly configured local development client. Opaque person
IDs are encoded once as a path segment; the server decodes that segment once.

The shared package’s 42 intercepted-HTTP/lifecycle checks and unsigned Mac/iOS
compile checks are separate from real bearer/SFU media acceptance and physical
devices. No new client/provider key is required. Native media still needs a stable
connection rehearsal, actual input/device acceptance and system meeting audio work.

## Access and controls

- One open room per conversation. Start/join use client-generated UUIDs for exact
  retries. Joining again after leaving requires a fresh session UUID.
- Join authority binds current sign-in, customer, conversation membership, licence
  and native enrolled device. Two-minute tokens contain one room/session identity
  with no administration, recording or arbitrary data-publishing permission.
- The Sipper proxy checks current access before every connection/reconnect and
  again during the SFU handshake. SFU HTTP/WS port 7880 stays private. Self-hosted
  LiveKit cannot revoke old tokens after removing a participant; exposing that
  port bypasses Sipper's checks.
- Logout, suspension, seat release, device revocation and group removal permanently
  withdraw existing sessions. Restoring access does not restore an old session.
  A five-second worker sweep also checks timed/subscription access. A host can end
  the room or remove another person across all devices for that room. MFA-protected
  administrators can request an end without joining.
- Removal/end is queued durably and remains pending until LiveKit confirms it.
  Provider failure retries with a bounded delay. Admission is not reported as
  connected media. Established signalling/media does not depend on portal polls.
- Rooms last at most 24 hours, with at most 100 device sessions. Confirmed ended
  rooms follow `SIPPER_MESSAGE_RETENTION_DAYS`. Increase capacity alongside the
  SFU. Guests, recording, SIP/PSTN ingress and high availability are not implemented.

## API

Web user prefix: `/api/platform/me/conferencing/:organisationId`.
Native PKCE prefix: `/api/client/devices/:deviceId/conferencing`.

| Suffix | Method | Body / result |
| --- | --- | --- |
| `/conversations/:id/meeting` | GET | Current metadata and configuration presence |
| `/conversations/:id/meeting` | POST | `{ "id": "request-uuid" }`; start/return open room |
| `/meetings/:id` | GET | Scoped metadata and admission/removal history, without tokens |
| `/meetings/:id/join` | POST | `{ "id": "session-uuid" }`; proxy URL, token and expiry |
| `/meetings/:id/sessions/:sessionId/leave` | POST | `{}`; withdraw owned session |
| `/meetings/:id/people/:userId` | DELETE | Host removes person for the room |
| `/meetings/:id/end` | POST | `{}`; host requests end |

Management: `GET /api/platform/organisations/:id/meetings` with an optional scoped
`before` UUID; `POST /api/platform/organisations/:id/meetings/:meetingId/end` with
`{}`. Verified MFA-protected roles apply. Listing issues no join authority and
exposes no conversation text, SIP details or upstream credentials.

The proxy calls `POST /api/meetings/admission` with its separate service credential
and `{ "token": "signed-media-token" }`. Ordinary cookies/native tokens cannot
authorise it. Direct private-origin calls also need the existing portal edge secret.

## Operator settings

No external keys were requested/configured. Leave all five portal meeting settings
empty to keep joining unavailable; metadata still works. When enabling the service:

| Portal setting | Value |
| --- | --- |
| `SIPPER_MEETING_PUBLIC_URL` | Public WSS **Sipper proxy** origin, e.g. `wss://meet.sipper.dev` |
| `SIPPER_MEETING_INTERNAL_URL` | Private SFU origin; Compose: `http://meetings-media:7880` |
| `SIPPER_MEETING_API_KEY` | 8–128 character key matching the private LiveKit YAML |
| `SIPPER_MEETING_API_SECRET` | Matching random secret, at least 32 characters; server only |
| `SIPPER_MEETING_ADMISSION_KEY` | Different random secret, at least 32 characters; proxy/portal only |

Set all five together. Production requires WSS. Origins contain no credentials,
paths, query or fragment. Public proxy and private SFU are separate origins. The
proxy receives no SFU API secret or database credential. It also uses the existing
portal origin secret when calling the origin directly.

Copy examples outside the checkout and populate them privately: `portal/.env.example`,
`gateway/meeting.env.example`, `infra/livekit.yaml.example`, `infra/.env.example`.
Combine `infra/compose.app.yml` and `infra/compose.meetings.yml` with the `meetings`
profile. Set absolute private paths in `SIPPER_MEETING_CONFIG_FILE` and
`SIPPER_MEETING_PROXY_ENV_FILE`. YAML must be mode 0600 and readable by
`SIPPER_MEETING_UID/GID` (default 1000:1000). Public media ports are TCP 7882/UDP
7883. The proxy binds loopback host port `SIPPER_MEETING_SIGNAL_PORT` (17881);
terminate WSS at the existing HTTPS reverse proxy. Never expose SFU port 7880.
Set its real public IP and configure TURN/TLS/certificates for restrictive networks
before public acceptance. The supplied topology is single-node.

Run `worker:meeting` separately from email/push. Health uses completed polls and
a 45-second stale threshold. Cold recovery must fence the former SFU/signalling
processes too. Restore quarantine closes snapshot room authority and cancels old
requests. Recovery hold prevents new joins/control replay until reconciliation.

## Local verification

`pnpm test` includes access, exact retries, withdrawal, moderation, expiry, outage
and recovery checks using the SDK's signed HTTP contract. This fixture is not
media proof. `npm test` in `gateway/` checks all four signalling paths, reconnect
denial, handshake withdrawal, private-header filtering and control-route exclusion.

`pnpm test:meetings` uses the normal migration preflight, a separate `_test`
database, fictional users and a disposable pinned LiveKit container. Its media
port forwards bind loopback only (TCP 29382/UDP 29383); ICE advertises the
container's own private interface. The host must route that private interface,
as OrbStack supports through [direct container access](https://docs.orbstack.dev/docker/network#direct-container-access).
Forcing `node_ip: 127.0.0.1` through VM port forwarding caused native ICE timeouts
on this host. This is a local fixture requirement; production still needs the
actual public media address and TURN/TLS. The rehearsal verifies real room/session
creation, removal, confirmed end and stale-token refusal at the Sipper proxy. It
also requires a real SDK media connection with the same unexpired token at the
raw private SFU to demonstrate the private-port boundary.
The official RTC Node SDK publishes generated audio, camera and screen tracks;
the receiver must decode non-silent audio and advancing video frames. Removal
must disconnect the real publisher while preserving the same user's separately
enrolled device. The two device grants consume one named-user seat; a Leave
request cannot withdraw the other device's session.
Cleanup removes fixtures and containers.
No hardware microphone, camera or screen is captured; this is local generated
media evidence, not physical-device, native app UI or production network proof.

The meeting runner now uses the same isolated `node --test` execution as the
normal portal suite. The earlier direct-import workaround was removed after the
fixture address correction: clean direct, isolated and packaged-portal rehearsals
pass. A controlled reversal to the former loopback advertisement reproduces the
timeout, and restoring the private interface passes again. This resolves the
current RTC Node rehearsal failure on this host; process/terminal differences
were not its demonstrated cause.

An earlier actual Electron-on-Mac window passed receive-only join, retry and
Leave with generated audio/camera/screen media, followed by later connection
timeouts. That app/browser acceptance has not been rerun with the corrected
fixture in this slice. Device-control review covers permission-free enumeration,
disabled/error states and closing, rather than actual device switching. Native
Mac/iOS/Android SDK media and physical devices still need their own acceptance.
See `IMPLEMENTATION-STATUS.md` for the current evidence and remaining boundary.

Set `SIPPER_MEETING_TEST_IMAGE` to a separately built local portal image to run
the same rehearsal through its actual production admission route, origin guard
and migration/encryption preflight. This creates a second disposable container
with generated fixture keys. The image must contain the current schema; the
rehearsal accepts only a local `_test` database. Existing previews stay running.

Primary references: [self-hosting and token revocation](https://docs.livekit.io/transport/self-hosting/),
[participant removal](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/),
[pinned signalling routes](https://github.com/livekit/livekit/blob/v1.9.12/pkg/service/rtcservice.go),
[pinned configuration](https://github.com/livekit/livekit/blob/v1.9.12/config-sample.yaml).
