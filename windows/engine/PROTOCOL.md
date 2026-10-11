# sipper-engine protocol

`sipper-engine` is the calling engine of Sipper for Windows: a small C program around PJSIP's
pjsua API. The Electron main process starts it as a child process
(`src/main/engineClient.js`) and talks to it in JSON lines over stdin and stdout, one UTF-8 JSON
object per line. The engine never reads from anywhere else and exits when stdin closes, so a
crashed or force-quit app cannot leave a phone registered.

Business rules (URIs, passwords, history, contacts) live in JavaScript. The engine turns
requests into pjsua calls and pjsua callbacks into events, and independently enforces managed
account leases at registration and call admission.

## Messages

The engine sends `{"event":"hello","pjsip":"2.15.1"}` once it is ready.

Requests carry a numeric `id` and get exactly one response:

```json
{"id": 7, "method": "makeCall", "params": {"accountId": "…", "uri": "sip:2001@pbx.example.com;transport=udp"}}
{"id": 7, "ok": true, "result": { …call… }}
{"id": 8, "ok": false, "error": "The account is not active."}
```

Events have an `event` name and no `id`. They can arrive between a request and its response.

## Methods

| Method | Params | Result |
|---|---|---|
| `start` | `userAgent`, `stunServers[]`, `logLevel` (0–6), `echoMode` (`webrtc`, `speex`, `default`, `off`), `echoTail` (ms), `ports` `{udp, tcp, tls}` (0 = any), `verifyTls`, `nullAudio`, `suspended` (current power state), `inputDevice`, `outputDevice` (names or null), `codecs[]` `{id, enabled}` in priority order, optional `meetingAudioReference` (UUID or explicit null; omission retains the current owner across stop/start) | `{pjsip}` |
| `stop` | | |
| `shutdown` | | the engine stops and exits |
| `syncAccounts` | `accounts[]` (below), `stunServers[]` | `{appliedAccountIds: string[]}`; missing accounts are removed, changed ones modified, new ones added, subject to managed call continuity below |
| `setRegistration` | `accountId`, `enabled` | |
| `reRegisterAll` | | |
| `setSuspended` | `suspended` (required boolean) | Sleep invalidates registration immediately; wake rechecks the Windows path before scheduling recovery |
| `makeCall` | `accountId`, `uri` | call |
| `answer` | `callId`, `code` (default 200), `expectedStartedAt`, `accountId`; gateway calls also require `claimedGatewayCallId` | |
| `setManagedCaller` | `callId`, `expectedStartedAt`, `accountId`, `gatewayCallId`, authenticated `name` and `number` | updated call; only a matching ringing gateway offer accepts the identity |
| `hangup` | `callId`, `code` (0 lets PJSIP choose BYE, CANCEL or 603), optional `expectedStartedAt`, `accountId`, `onlyIfRinging` | |
| `hangupAll` | | |
| `setHold` | `callId`, `hold`, `expectedStartedAt`, `accountId`; grouped calls require their current `conferenceId` | Deferred reply after SIP acceptance and negotiated media confirm hold/resume. Native/remote failures are returned; four-second timeout keeps unresolved admission fenced until final result or hang-up. `onHold` includes confirmed inactive media when both peers hold, never a requested-state flag. Established calls remain controllable after withdrawal. |
| `beginConference` | `callId`, `accountId`, `expectedStartedAt`, `otherCallId`, `otherAccountId`, `otherStartedAt` | Updated call with a fresh opaque `conferenceId`. Two distinct confirmed, resumed calls on one available account; unrelated calls must be held. Both remote streams are linked in the native mixer. |
| `splitConference` | `callId`, `accountId`, `expectedStartedAt`, `conferenceId` | Both participants must be held with no outstanding negotiation. Removes peer audio/recording links and group identity; preserves each call. |
| `hangupConference` | `callId`, `accountId`, `expectedStartedAt`, `conferenceId` | Ends only the two captured members, including during hold changes or after access withdrawal. Stale group references are rejected. |
| `setMuted` | `callId`, `muted`, optional `accountId`, `expectedStartedAt` (always supplied by AppState) | Grouped calls share microphone mute; remote participants can still hear each other. |
| `sendDtmf` | `callId`, `digits` | RFC 2833, falling back to SIP INFO |
| `transfer` | `callId`, `accountId`, `expectedStartedAt`, `uri` | blind transfer (REFER); captured call identity is required |
| `attendedTransfer` | `callId`, `accountId`, `expectedStartedAt`, `otherCallId`, `otherAccountId`, `otherStartedAt` | REFER with Replaces; both captured identities are required |
| `startRecording` | `callId`, `path` (a `.wav` file) | both sides mixed, 16 kHz mono |
| `stopRecording` | `callId` | |
| `activeCalls` | | calls[] |
| `audioDevices` | | `[{index, name, inputs, outputs, driver}]` |
| `setAudioDevices` | `input`, `output` | Suppressed while meeting audio owns the hardware; supply current choices when releasing it |
| `setMeetingAudio` | `reference` (canonical UUID), `enabled` (required boolean), optional `input`, `output` on release | `{claimed}`. Claim requires every connected phone call held and no pending hold/transfer. New phone audio is refused until exact-owner release. Ringing/decline/hangup and registrations remain usable. |
| `codecs` | | `[{id, priority}]` |
| `setCodecs` | `codecs[]` `{id, enabled}` | |
| `setEcho` | `mode`, `tail` | |
| `version` | | `{pjsip}` |

An account in `syncAccounts`:

```json
{
  "id": "B7E1…",
  "aor": "\"Alex\" <sip:1001@pbx.example.com>",
  "registrar": "sip:pbx.example.com;transport=udp",
  "proxy": "sip:edge.example.com:5060;transport=udp;lr",
  "regTimeout": 300,
  "authUsername": "1001",
  "password": "…",
  "srtp": "disabled",
  "useIce": false,
  "useStun": false
}
```

## Events

Managed accounts also include `managedUntil` (expiry in Unix milliseconds, at most 24 hours
plus one minute ahead). An invalid/expired lease cannot register or start a call. Omitting
the lease from an existing managed account cannot convert it into a personal account.
Lease-only renewal does not modify SIP settings. On removal or expiry, the engine unregisters
and rejects new calls, answers and transfers, including incoming REFER/Replaces requests.
Ringing calls end; established calls keep their SIP dialog and can be muted, held or hung up.
The account is deleted after its final call ends. Changed managed settings are deferred until
all calls finish and block new calls meanwhile. Deferred, failed and expired accounts are
absent from `appliedAccountIds`; callers must not acknowledge their configuration as applied.
The engine checks expiry on every main-loop iteration, including while commands are queued.

Windows interface, address and route notifications schedule recovery on the existing engine
loop after 500ms of settling. Observer callbacks never call PJSIP. Offline/suspended accounts
cannot be manually registered; accounts added offline register when a path returns. Permanent
credential failures remain visible. The engine removes a withdrawn account's registrar while
keeping its established dialogs, so IP-change recovery cannot revive its binding. Failed
registrar removal is retried and blocks recovery until it succeeds. Resumption restores the
registrar from the current authorised configuration. No new environment setting is needed.

Managed accounts may also include a boolean `managedDoNotDisturb` (absent means false).
It requires a valid managed lease and rejects only new **direct** incoming calls with
486, before publishing a call event. This metadata is excluded from the SIP settings
fingerprint, so changing it preserves registration, outgoing calls and calls already
ringing or connected. Gateway admission remains server-controlled. Invalid values
withdraw the affected account rather than silently treating the policy as false.

Gateway accounts additionally set `gateway: true`. They require a valid managed lease,
verified TLS, TLS registrar/proxy URIs, mandatory SRTP and SHA-256 digest support. The account
is bound to the verified TLS transport and offers only SHA-256 credentials. New calls and blind
transfer targets must be phone numbers at that account's configured domain. Incoming REFER
and Replaces requests cannot create gateway call legs outside service admission.

Transfers require confirmed calls with current account authority. Attended transfers
reserve two distinct calls on the same account; either reserved leg rejects another
transfer. Progress is attached to each call. Failure releases the reservation and
preserves the calls. Success includes a 2xx NOTIFY before subscription termination:
the native loop closes only the captured source and consultation outside callbacks.
Reused slots cannot inherit cleanup, and ending a pending source releases its peer.
The main process must not hang up a numeric ID in response to a transfer event.

Incoming gateway calls require exactly one UUID `X-Sipper-Call-ID` header on an outgoing
verified TLS connection. Duplicate active references on the same account are rejected.
Their `remote` is empty; `gatewayCallId`, `callerName` and `callerNumber` are separate fields.
The caller fields stay empty until the main process verifies them through the managed API and
calls `setManagedCaller`. Accepting the call requires its matching server-approved reference
and captured account/start time. Any supplied `expectedStartedAt` or `accountId` is checked
before a call command executes. `onlyIfRinging` requires the captured start time and leaves
connected calls untouched. Successful outgoing ICE setup may precede the active SIP dialog.

Only builds compiled with `SIPPER_TESTING` accept `testNetworkChanged` with a required boolean
`available` to inject a path change. The real Windows observer remains active. Only these
test builds also accept `testCaFile` in `start`, `testMedia` and
`testDigest`. The Mac development build includes these. Windows uses `build-windows.ps1
-Testing` for integration tests and rebuilds without that switch before packaging. These
hooks neither alter the host trust store nor disable certificate verification.


| Event | Fields |
|---|---|
| `registration` | `accountId`, `state` (`unregistered`, `registering`, `registered`, `failed`), `code`, `reason`, `expires` |
| `network` | `available` (boolean); invalidates the previous registration observations. Local path availability does not establish PBX reachability |
| `networkRecovered` | PJSIP accepted a coalesced recovery request; prompts managed configuration refresh. Registration and media success require their subsequent observations |
| `incomingCall` | `call` (already answered with 180 Ringing) |
| `callChanged` | `call` |
| `callEnded` | `call` (the id may be reused by a later call) |
| `voicemail` | `accountId`, `body` (the RFC 3842 message-summary text) |
| `transferStatus` | `callId`, `accountId`, `startedAt`, `code`, fixed safe `text`, `final` (a terminal result, including 2xx before subscription termination) |
| `log` | `line` (PJSIP log lines and `Sipper: …` engine notes) |

A call:

```json
{
  "id": 0, "accountId": "B7E1…", "direction": "outgoing", "state": "confirmed",
  "remote": "\"Alex\" <sip:2001@pbx.example.com>",
  "muted": false, "onHold": false, "remoteHold": false, "activeMedia": true, "recording": false,
  "transferring": false, "transferStatus": "",
  "startedAt": 1757858400000, "connectedAt": 1757858403000, "endedAt": null,
  "lastCode": 200, "lastText": "OK"
}
```

`state` is `calling`, `incoming`, `early` (ringing at the far end), `connecting`, `confirmed` or
`disconnected`. Times are milliseconds since the Unix epoch. `id` and `startedAt` together identify
one call.

Grouped calls also carry an optional `conferenceId`. It changes on every merge, even when
the same two calls are regrouped. Reciprocal peer bindings include both native slot and
start time. A participant ending dissolves its group and preserves the surviving call.
Transfers require separation first. AppState serialises audio actions, confirms each group
hold/resume through `setHold`, and restores completed changes if a later participant rejects
the action. Pending hold changes disconnect cross-party forwarding until negotiation settles.
Separation holds both participants, splits them, then resumes only the selected participant;
a rejected final resume leaves the separate calls held. Recordings include both remote streams
while joined and remove peer audio on separation. `SIPPER_TESTING` builds expose `testMedia`
`receivedLevel` (0–255) to measure remote echo forwarding without reading SDP or keys.
