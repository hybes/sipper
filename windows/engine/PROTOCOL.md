# sipper-engine protocol

`sipper-engine` is the calling engine of Sipper for Windows: a small C program around PJSIP's
pjsua API. The Electron main process starts it as a child process
(`src/main/engineClient.js`) and talks to it in JSON lines over stdin and stdout, one UTF-8 JSON
object per line. The engine never reads from anywhere else and exits when stdin closes, so a
crashed or force-quit app cannot leave a phone registered.

Business rules (URIs, passwords, history, contacts) live in JavaScript. The engine only turns
requests into pjsua calls and pjsua callbacks into events.

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
| `start` | `userAgent`, `stunServers[]`, `logLevel` (0–6), `echoMode` (`webrtc`, `speex`, `default`, `off`), `echoTail` (ms), `ports` `{udp, tcp, tls}` (0 = any), `verifyTls`, `nullAudio`, `inputDevice`, `outputDevice` (names or null), `codecs[]` `{id, enabled}` in priority order | `{pjsip}` |
| `stop` | | |
| `shutdown` | | the engine stops and exits |
| `syncAccounts` | `accounts[]` (below), `stunServers[]` | accounts missing from the list are removed, changed ones modified, new ones added |
| `setRegistration` | `accountId`, `enabled` | |
| `reRegisterAll` | | |
| `makeCall` | `accountId`, `uri` | call |
| `answer` | `callId`, `code` (default 200) | |
| `hangup` | `callId`, `code` (0 lets PJSIP choose BYE, CANCEL or 603) | |
| `hangupAll` | | |
| `setHold` | `callId`, `hold` | |
| `setMuted` | `callId`, `muted` | |
| `sendDtmf` | `callId`, `digits` | RFC 2833, falling back to SIP INFO |
| `transfer` | `callId`, `uri` | blind transfer (REFER) |
| `attendedTransfer` | `callId`, `otherCallId` | REFER with Replaces |
| `startRecording` | `callId`, `path` (a `.wav` file) | both sides mixed, 16 kHz mono |
| `stopRecording` | `callId` | |
| `activeCalls` | | calls[] |
| `audioDevices` | | `[{index, name, inputs, outputs, driver}]` |
| `setAudioDevices` | `input`, `output` | |
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

| Event | Fields |
|---|---|
| `registration` | `accountId`, `state` (`unregistered`, `registering`, `registered`, `failed`), `code`, `reason`, `expires` |
| `incomingCall` | `call` (already answered with 180 Ringing) |
| `callChanged` | `call` |
| `callEnded` | `call` (the id may be reused by a later call) |
| `voicemail` | `accountId`, `body` (the RFC 3842 message-summary text) |
| `transferStatus` | `callId`, `code`, `text`, `final` |
| `log` | `line` (PJSIP log lines and `Sipper: …` engine notes) |

A call:

```json
{
  "id": 0, "accountId": "B7E1…", "direction": "outgoing", "state": "confirmed",
  "remote": "\"Alex\" <sip:2001@pbx.example.com>",
  "muted": false, "onHold": false, "remoteHold": false, "activeMedia": true, "recording": false,
  "startedAt": 1757858400000, "connectedAt": 1757858403000, "endedAt": null,
  "lastCode": 200, "lastText": "OK"
}
```

`state` is `calling`, `incoming`, `early` (ringing at the far end), `connecting`, `confirmed` or
`disconnected`. Times are milliseconds since the Unix epoch. `id` and `startedAt` together identify
one call.
