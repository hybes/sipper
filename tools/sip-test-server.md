# sip-test-server

A single-file, standard-library-only SIP registrar and proxy for exercising
Sipper against a local "PBX" without any external service. It is a test tool:
stateless-ish, one domain, no media.

```
python3 tools/sip-test-server.py --user 1001:secret --user 1002:secret --answer-special -v
```

## What it does

- Registrar for one domain (`--domain`, default `sipper.test`) with MD5 or SHA-256 digest
  auth (`qop=auth` and no-qop), realm = domain. Unknown user: 403. Wrong
  password: 401 again; an `Authorization` with an expired/unknown nonce gets
  `stale=true`.
- Listens on UDP and TCP on `--port` (5070) and TLS on `--tls-port` (5071,
  `0` disables). The self-signed certificate is created on first run with the
  `openssl` CLI in `tools/.sip-test-certs/` (gitignored). Clients must skip
  server verification.
- Proxies INVITE/ACK/BYE/CANCEL/OPTIONS/INFO/REFER/NOTIFY/MESSAGE/UPDATE/PRACK/
  SUBSCRIBE addressed to `user@domain` to the user's most recent registered
  contact (480 if not registered, 404 if unknown). Adds Via, Record-Route
  (two of them when the legs use different transports), decrements
  Max-Forwards, honours `received`/`rport`, strips Route headers that point at
  itself. Mixed transports on 127.0.0.1 work (UDP caller -> TCP callee and
  back); TCP/TLS registrations are reached over the connection they registered
  on.
- `OPTIONS` to the server itself (no user, or user = domain): 200 with `Allow`.
- Special numbers `*97` and `*echo`: 486 Busy Here, or with `--answer-special`
  180 Ringing, 200 OK with a minimal PCMU SDP, then BYE after 3 s (configurable
  with `--special-call-seconds`). No RTP is sent.
- `*nohold` also answers with `--answer-special`, then rejects each in-dialog
  re-INVITE with 488. This exercises rejected hold/resume negotiation without
  ending the original call.
- `*slowhold` answers re-INVITEs after one second, `*latehold` after five seconds,
  and `*silenthold` ignores them. They exercise awaited negotiation, late replies
  after client timeouts and hang-up while an SDP offer is unresolved. Use full SIP
  addresses for these alphabetic fixture numbers in the mobile diallers. No RTP
  is sent and delayed replies are cancelled when the fixture call ends.
- Answered special calls accept `REFER` and simulate transfer status using
  `NOTIFY` sipfrags. A destination of `*97` or `*echo` succeeds; other destinations
  fail with 404 while preserving the original call. Attended transfers must name
  another confirmed fixture dialog in `Replaces`. Blind success uses an active
  subscription, attended success a terminated one. This checks client signalling
  and local call cleanup; it does not create a third leg or bridge audio.
- `--mwi 1001:2/5`: unsolicited `message-summary` NOTIFY after each REGISTER
  and 200 + NOTIFY for SUBSCRIBE (Event: message-summary).
- `--auth-invite`: challenge all non-REGISTER requests (except ACK/CANCEL)
  with 407.
- Logging: one line per event by default; `-v` prints every SIP message with
  direction and peer. `SIGUSR1` or `SIGINFO` (Ctrl-T in the terminal) prints
  the binding table as JSON. Ctrl-C / SIGTERM stops it cleanly.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--domain D` | `sipper.test` | SIP domain and digest realm |
| `--port N` | `5070` | UDP + TCP listen port |
| `--tls-port N` | `5071` | TLS listen port, `0` to disable |
| `--bind IP` | `0.0.0.0` | bind address |
| `--advertise IP` | `127.0.0.1` | address written into Via / Record-Route / Contact |
| `--user U:P` | | add a user (repeatable) |
| `--users-file F` | | JSON: `{"1001": "secret"}` or `[{"user": "1001", "password": "secret"}]` |
| `--auth-invite` | off | 407-challenge non-REGISTER requests |
| `--auth-algorithm A` | `MD5` | Digest algorithm: `MD5` or `SHA-256` (no fallback) |
| `--answer-special` | off | answer `*97` / `*echo` instead of 486 |
| `--special-call-seconds N` | `3` | delay before ending an answered special call; greater than 0, at most 300 seconds |
| `--mwi U:NEW/OLD` | | send message-summary NOTIFYs for U (repeatable) |
| `-v` | off | dump every SIP message |

## Sipper account settings

For Mac UI checks, a Debug build accepts `SIPPER_NULL_AUDIO=1` only with an
isolated `SIPPER_PROFILE_DIRECTORY` (or the separate Development bundle).
This selects virtual audio without opening physical input/output devices.
The normal microphone-authorisation flow still runs; it does not grant or
bypass an OS permission. Use an empty temporary profile and only the fictional
loopback account below. Release builds ignore both preview controls.

Domain `sipper.test`, server/registrar `127.0.0.1:5070` (transport UDP or TCP)
or `127.0.0.1:5071` for TLS with certificate verification disabled, user
`1001`, password `secret`. Register a second account (`1002`) from another
client to call between them, or dial `*97` for a server-answered test call.

## Verified pjsua commands

These were run against `vendor/pjsip/bin/pjsua` with the server started as in
the first example. `sleep N |` keeps pjsua's stdin open for N seconds; it
quits on EOF.

```sh
# callee: 1002 over UDP, auto-answer
sleep 30 | vendor/pjsip/bin/pjsua --null-audio --auto-answer 200 \
  --id sip:1002@sipper.test --registrar sip:127.0.0.1:5070 --realm sipper.test \
  --username 1002 --password secret --local-port 5082 --no-color --duration 10

# caller: 1001 over TCP, dials 1002, hangs up after 5 s
sleep 10 | vendor/pjsip/bin/pjsua --null-audio --id sip:1001@sipper.test \
  --registrar "sip:127.0.0.1:5070;transport=tcp" --proxy "sip:127.0.0.1:5070;transport=tcp;lr" \
  --realm sipper.test --username 1001 --password secret --local-port 5084 --no-color \
  --duration 5 sip:1002@sipper.test

# TLS registration (server verification is off by default in pjsua)
sleep 5 | vendor/pjsip/bin/pjsua --null-audio --use-tls --id sip:1001@sipper.test \
  --registrar "sip:127.0.0.1:5071;transport=tls" --proxy "sip:127.0.0.1:5071;transport=tls;lr" \
  --realm sipper.test --username 1001 --password secret --local-port 5090 --no-color

# server-answered test call (needs --answer-special)
sleep 10 | vendor/pjsip/bin/pjsua --null-audio --id sip:1001@sipper.test \
  --registrar sip:127.0.0.1:5070 --proxy "sip:127.0.0.1:5070;lr" --realm sipper.test \
  --username 1001 --password secret --local-port 5084 --no-color --duration 20 "sip:*97@sipper.test"

# MWI (server started with --mwi 1002:2/5); --proxy is required or pjsua tries to resolve sipper.test
sleep 8 | vendor/pjsip/bin/pjsua --null-audio --mwi --id sip:1002@sipper.test \
  --registrar sip:127.0.0.1:5070 --proxy "sip:127.0.0.1:5070;lr" --realm sipper.test \
  --username 1002 --password secret --local-port 5092 --no-color --log-level 4
```

Add `--log-level 3 --app-log-level 3` to quieten pjsua. Use `--no-tcp` on a
pjsua instance to force a UDP-only client (pjsua otherwise switches large
INVITEs to TCP on its own).

## Limits

Not a production proxy: no forking, no transaction retransmission timers, no
IPv6, first-registered-contact-wins is really last-registered-wins, and the
server does not authenticate to anything itself. It never crashes on a bad
packet: malformed messages are logged and dropped.

## Managed direct-call and network recovery checks

Use the isolated fixture below for the shared Mac/iOS test
`DirectCallingPreferenceTests`. The DND case uses both accounts in one engine;
the network case calls the fixture's echo responder over UDP and TCP, with null
audio. Set the Xcode build setting
`SIPPER_TEST_DIRECT_DND=127.0.0.1` when running that test; without it the test skips.
Run Mac and iOS sequentially so they do not replace each other’s registrations.

The Mac-only `AppStateTests.testConsultationCallReturnsToControlsAndTransfersBothLegs`
uses the same opt-in fixture. It places two `*97` calls through AppState, checks
that opening Add call preserves the original conversation, verifies hold when the
consultation is placed, and completes attended transfer with both local legs ending.
It injects microphone permission and uses null audio; it does not exercise native
buttons or prove audible media after transfer.

```sh
python3 tools/sip-test-server.py --bind 127.0.0.1 --port 5098 --tls-port 0 \
  --domain sipper.test --user dnd-user:fictional-dnd --user dnd-peer:fictional-dnd \
  --answer-special --special-call-seconds 120
```

For Android, stop that fixture and restart it with `--advertise 10.0.2.2` added.
The emulator uses that host-loopback alias in Route headers; advertising 127.0.0.1
instead makes the fixture treat the alias as a remote route. Run Gradle with
`-Pandroid.testInstrumentationRunnerArguments.class=com.hybes.sipper.EngineTest`
and `-Pandroid.testInstrumentationRunnerArguments.dndRegistrar=10.0.2.2`.
The new check runs without the separate `sipperRegistrar`/5096 expiry fixture.
Stop the registrar afterwards. No real PBX, SIP credentials or audio devices are used.

The tests confirm that new direct incoming calls are rejected, existing ringing
calls remain answerable, established calls and registration survive, outgoing and
personal calls work, and turning DND off restores incoming admission. Windows’
`node --test tests/integration/managed-engine.test.mjs` starts its own disposable
registrar and also checks malformed policy values and absence of re-registration.

The shared Apple network case also checks offline registration invalidation,
transport recovery, re-registration and survival of an established dialog. It
withdraws the managed account, recovers again and makes a separate SIP request to
prove the registrar returns 480 for that account, while the personal account and
existing call remain available. Resuming restores registration without replacing
the call. The fixture log records the re-INVITEs and new TCP connection. These are
local signalling checks; they do not establish physical Wi-Fi/mobile handover or
audible media continuity.
