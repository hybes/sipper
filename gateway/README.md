# Sipper SIP gateway

The local gateway now registers an upstream SIP account and routes incoming and
outgoing calls through a Node/ARI controller. It is not production-ready. The
isolated test verifies TLS/SRTP negotiation and call control. Its optional Android,
iOS, Mac and Windows-engine-on-macOS stages also verify encrypted Opus media packets through a G.711 upstream and
continued media after managed expiry or withdrawal. It uses synthetic silence, not a microphone.
Provider push delivery and system call-UI verification, physical audio, broader interoperability,
whole-host recovery and production operations remain required work. Local
controller process recovery is verified with forced termination and restart.

The portal issues gateway configuration only while an authenticated controller
holds a current readiness lease. One controller owns a gateway at a time. The
controller renews readiness after checking private ARI connectivity and refreshing
eligible upstream accounts; it rejects new calls when this refresh fails.
Gateway API requests carry the service bearer key and the controller's random
`X-Sipper-Controller` instance ID. Except for acquiring/renewing the heartbeat,
the API rejects requests without a current matching lease. A second process
cannot replace the owner's event connection. Clean shutdown releases the lease
only after active calls finish; an old instance cannot release its replacement.

## Call activity

Gateway transfers remain disabled in the shared endpoint configuration. The
controller now implements blind and attended transfers with durable recovery,
using the authenticated transfer API from portal migration 028. Its disposable
SIP fixture enables ARI-only REFER on a private view of fictional devices; it does
not change the shared device view. Mac, iOS, Android and the Windows engine built on
macOS pass native blind/attended transfer and encrypted media handoff checks.
Actual Windows execution, remaining native UI and wider interoperability still need
verification before enabling device transfers. Upstream `allow_transfer=no` must remain in place.

`POST /api/gateway/transfers` admits `{ transferId, callId, deviceId, destination }`
for a blind transfer, or replaces `destination` with `consultationCallId` for an
attended transfer. Both connected calls must belong to the same device, customer
and calling account, at the current configuration revision. Current licence,
membership, assignment, device revocation, readiness and administrator end requests
are checked on admission and every pending retry. Locking both calls prevents
competing attempts from reserving either leg. The 45-second admission deadline
does not silently release a pending attempt; the controller must reconcile it first.

`GET /api/gateway/transfers/:id` returns references and state only. After observing
the bridge result, `POST` to that path reports `{ state: "completed" }` or
`{ state: "failed" }`. Replays are idempotent; opposite final results are rejected.
A replacement controller with a valid lease can report recovery while readiness is
paused. Failed transfers preserve the existing calls. Completion removes the old
device from live call summaries while retaining the continuing gateway call; an
attended consultation record points to that continuing call. Late completion cannot
revive an ended call. The controller must honour `endRequested` after completion.

`GET /api/gateway/transfers` lists pending attempt IDs and their call references for
the owning controller. It cancels attempts absent from its recovery journal, including
admissions whose HTTP response was lost. Completed snapshots racing reconciliation
cannot be rewritten as failures. This endpoint returns no destinations or SIP details.

The private SQLite journal reserves both call records before admission. Blind
transfers dial only a phone number through the source account's approved upstream;
attended transfers require an actual owned device channel on the same account and
device. An unresolved Replaces reference is rejected rather than dialled. Authority
is checked again before bridging. Remote legs move into a separate bridge, and the
new topology and completed outcome commit atomically before a success NOTIFY or
device hangup. Before that commit, interruption restores the original bridges;
after it, restart finishes cleanup and retries the outcome report. A transfer's
destination stays in memory only. Recovery cancels interrupted dialling rather than
reconstructing it from private SIP data. Storage failure pauses control. Transfers
also stop changing channels when the conservative local ownership deadline expires.

The optional native stages now transfer held calls through the actual SIP
engine. A rejected target preserves the original call and advancing media. Successful
blind and attended transfers close the device legs; the fixture then observes TLS,
SRTP, cleared hold and increasing received/sent packet counts on both remaining
remote legs, followed by complete hangup reporting. The disposable PBX uses an echo
extension and a generated tone. This establishes local protocol/media behaviour,
not audible physical-device quality or third-party PBX compatibility. No new provider
credential, client secret or environment setting is required.
Android also verifies that transferred calls leave no Core-Telecom session or call
notification, and that subsequent ordinary incoming calls still work.
Windows exercises AppState and its C engine on macOS, including rejection of stale
identities, wrong targets and withdrawn access. Windows Schannel/DPAPI execution
and packaged native controls are separate release checks.

Blind-transfer destinations are envelope-encrypted in the attempt record and follow
the source call's retention through a cascading foreign key. They are omitted from
API snapshots, management responses and the gateway journal. No new environment
setting or provider key is needed. The implementation uses Asterisk's
[ARI transfer handling](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-Transfer-Handling/).

The controller reports both incoming and outgoing call lifecycles. Outgoing
admission carries a stable call ID and is rechecked before bridging. Its
originating device is retained in the recovery journal; the portal stores only
account/device references, direction and lifecycle times. Dialled destinations
are not stored. Connected and ended reports share the existing authenticated
call endpoint, durable retry and retention handling. No push or incoming answer
claim is created for an outgoing call.

Apply portal migration 020 before updating the portal and controller together.
Older outgoing calls have no portal record and are not backfilled. The local
real-SIP rehearsal verifies device ownership, suspension continuity, hangup
reporting and an outgoing bridge surviving controller SIGKILL/restart. The portal
shows Dialling, Connected/In a call or Unconfirmed according to the gateway
lease. Direct SIP calls remain outside this view. No new provider keys or
environment settings are needed.

Customer administrators can explicitly **End call** from Call activity. Migration
022 stores a separate audited request; it does not claim that SIP or media has
ended. The controller checks connected calls during its existing reconciliation
cycle (normally every ten seconds), and ringing/answering paths also check before
connecting. It hangs up every known leg and removes the bridge before reporting
`admin_ended`. Failed teardown and unacknowledged reports use the existing durable
journal. An unavailable gateway leaves **End requested** visible until recovery
confirms the result; a natural hangup keeps its actual reason. Normal licence or
device withdrawal still preserves established conversations, and portal failure
does not itself disconnect them. Apply migrations through 022 and update the
portal and controller together. There are no new keys or environment settings.

## Registration activity

The controller reads current device AOR contacts over the existing private ARI
connection, in batches of 20 outside call reconciliation. The portal stores only
the latest state, received SIP peer IP, observation time, controller identity and
readiness generation.
Raw Contact/Via headers and credentials are excluded. Device observations need no
additional listener. Apply migrations through 021 and update the portal/controller
together; older controllers cannot submit the new observation format.

The management table distinguishes **Gateway observed** from **App reported**.
Gateway observations become stale after 45 seconds, immediately when the observed
controller loses readiness, or when a replacement owns its lease. Every recovery
starts a new observation generation, including when the same controller resumes
after expired readiness or an Asterisk restart. Reports capture that generation
before reading Asterisk; the portal rejects late reports from an earlier generation.
Historical timestamps/IPs remain visible but cannot become current merely because
readiness returns. Legacy observations stay stale until refreshed. A missing or
failed observation never becomes an unregistered result. Direct SIP reports retain
their three-minute freshness window and use the separate Sipper HTTP request IP.
These observations confirm device-to-Sipper contacts; they do not establish push
reachability or successful audio.

The Calling accounts table separately reports **PBX registration** for gateway
accounts. The optional private AMI connection reads Asterisk's outbound registration
snapshot through [PJSIPShowRegistrationsOutbound](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/PJSIPShowRegistrationsOutbound/): registered, unregistered or rejected (shown as Failed). Each observation
is bound to the current account revision, controller lease and readiness generation and has the same
45-second freshness limit. A failed/incomplete read preserves the prior timestamp;
it never manufactures an unregistered or successful result. Direct accounts use
device reports and are labelled accordingly.

Configure `SIPPER_AMI_PASSWORD` independently from ARI on Asterisk and the controller,
using the private loopback defaults in `.env.example`. This enables a privileged
AMI listener on 5038; never publish it publicly. The reporting permission also
allows some PJSIP actions, so this credential is not suitable for customer access.
HTTP manager access is disabled. Snapshot requests have a five-second timeout and
4 MiB limit and run outside call/lease reconciliation. Only opaque route IDs and
state leave the reader; AMI authentication-detail frames are discarded without
logging. Missing configuration leaves status unreported and does not block calls.

The pinned Asterisk 22 AOR serialiser returns dynamic contacts after pruning
expired records; device AORs have one contact and no static contacts. Its
`rewrite_contact=yes` setting supplies the received SIP peer address. The local
SIP smoke check verifies registration, unregistering and this peer-IP distinction;
the process check verifies delivery through the real controller and portal.

## Implemented boundary

- Asterisk 22.11.0 is built from its pinned official source archive and SHA-256,
  with bundled PJSIP. The base image is pinned by digest. Build dependencies are
  obtained from Ubuntu's signed repositories. Rebuild for dependency security updates.
- Opus transcoding uses Wazo's GPL module at commit
  `591b6cd9b75e2b9b6d815ef364a385fccee595a7`, with a verified archive SHA-256.
  Only the codec is added; Asterisk's current SDP format module is retained.
  The build checks libopus linkage and the SIP test requires the module to be
  running. Without this module, advertising Opus alone cannot transcode to G.711.
- TLS is the only SIP transport; device endpoints require SRTP and SHA-256 digest.
  A random 256-bit password is created separately for each device/account pair.
  The portal encrypts it with device/organisation/account context; Asterisk reads
  its digest. Upstream passwords and connection addresses never enter the device
  response in gateway mode.
- Realtime database views consult the existing membership, paid capacity, seat,
  assignment, verified identity, device revocation and gateway readiness checks on
  every lookup. Do not configure a sorcery endpoint/auth/AOR memory cache: doing
  so would postpone suspension until cache expiry. Existing call dialogs are not
  explicitly hung up by these changes. The real SIP test verifies that suspension
  denies a new call while preserving the existing two-channel bridge.
- The Asterisk database role has SELECT on only three views and no portal-table
  access. Its contacts are stored locally by Asterisk. Debug, SIP traces, CDR and
  CEL logging are disabled; the upstream PostgreSQL password-debug statement is
  removed from the pinned source too. This image also removes Sorcery realtime's
  three write callbacks: ARI writes only to its memory backend. This prevents
  rejected SQL writes from logging upstream secrets. Contacts use AstDB, not this
  read-only adapter.
- With no call controller connected, dialplan calls end rather than reaching an
  unapproved trunk. The controller pushes approved upstream settings through private
  ARI into memory; it keeps only account IDs and revision metadata in its own map.
- Outgoing calls recheck current device access before dialling and connecting.
  Incoming calls use the portal's recipient/claim records and attach the opaque
  call ID to each SIP leg. Two answering devices cannot both join the caller.
  Caller cancellation and SIP busy/reject responses update portal call state.
- Configuration changes wait while a route has active calls, to accommodate
  providers that allow one registered contact. The controlled Asterisk provider
  check verifies automatic renewal during an established call, deferred revision
  replacement, authenticated unregister before contact expiry and fresh calling.
  A two-contact profile forks incoming calls to Sipper and a separate SIP phone;
  either answer cancels the other branch without attributing an external answer
  to a Sipper device. These checks require TLS and SDES SRTP and do not establish
  compatibility with other providers or transport modes.
- Event connections use WebSocket ping/pong and reconnect after loss. Readiness
  is withdrawn during recovery. Since events are not replayed, the controller
  compares its known legs against Asterisk's channels, preserving live bridges
  and removing a surviving leg after a missed hangup. SIGTERM/SIGINT pause new
  calls and drain existing ones. A private SQLite journal records call stages
  before their side effects and retains call-end reports until HTTP acknowledgement.
  A replacement verifies actual live channels/bridges before adopting a call.

The native Apple PJSIP build retains Apple's verified TLS backend and applies a
tracked CommonCrypto SHA-256 digest patch. Its independent digest vectors and
loopback authenticated registration/calls pass. The iOS simulator now also passes
real gateway registration, bidirectional SRTP/ICE packets and incoming call claims,
cancellation, decline and competing-answer checks. An opaque push hint now restores
iOS registration and merges the SIP offer into the original CallKit placeholder;
the actual delegate answer/end path uses a recording provider in the test. Real
APNs delivery and CallKit system UI remain unverified, alongside physical-device
audio and broad interoperability.
Mac now shares the authenticated caller/answer coordinator with iOS. Its real gateway
check exercises AppState configuration acknowledgement, outgoing/answered calls,
cancellation during a pending microphone request, decline, another device answering,
microphone denial and established media surviving managed withdrawal. Unverified
gateway caller fields remain hidden, and disconnected managed history cannot call
back through a personal account. Browser sign-in, native presentation and physical
audio still need verification.
Windows now accepts gateway provisioning and verifies caller details/answer claims in
the main process. Its AppState/C-engine path passes the same nine incoming phases on
macOS, plus encrypted media and withdrawal continuity. Its Schannel/CNG backend,
DPAPI storage, packaged Windows UI and browser sign-in still need Windows verification.
Android accepts gateway provisioning with TLS and required SRTP;
the real outgoing and incoming registration/media paths and device answer claims
are emulator-tested. Real Android push delivery and native call-UI verification remain
unfinished. A protocol fixture passing
does not imply any of these native paths is finished.

## Reproduce the local registration and calling checks

From the repository root, with the existing local development Postgres running:

```sh
docker build -t sipper-asterisk:22.11.0 gateway/asterisk
cd gateway
npm ci --ignore-scripts
npm test
cd ../portal
pnpm test
pnpm build
pnpm test:gateway
```

The smoke test accepts only the loopback `sipper_test` database and the existing
`sipper-platform-dev_default` Docker network. It creates fictional customers,
two device credentials, a restricted temporary database role and a disposable
TLS certificate. It starts an unprivileged gateway with its SIP port bound only to
loopback, verifies TLS and SIP digest registration, then exercises bad passwords,
suspension/resumption, per-device revocation and readiness expiry. A second,
disposable Asterisk acts as the upstream PBX. The test also verifies upstream
registration, outgoing bridging, suspension during a call, multi-device incoming
answer races, caller hangup/cancellation, per-device decline, and absence of
upstream credentials or failed SQL writes in gateway logs. Two fixed provider
profiles reject a second contact or allow two contacts respectively. Their
30-second maximum registration lifetime exercises automatic renewal while a
call stays connected. Revision replacement must explicitly unregister the old
contact before it expires. Incoming two-contact forks check both a Sipper winner
and an external-phone winner, loser cancellation, device attribution and hangup.
The strict single-contact profile is restored before controller recovery checks.
This is real local Asterisk/SIP signalling with negotiated SRTP, without media
packets or third-party provider proof. No runtime setting or key is added.
The test then starts the
built portal and the real controller as separate processes on temporary loopback
ports. This stage checks API authentication, ownership, competing-controller
rejection, incoming/outgoing calls, event reconnect, a missed hangup, and draining
an active call on SIGTERM. A loopback TCP proxy drops only the fixture's event
connection. It also SIGKILLs the controller, waits for its real ownership lease
to expire, and verifies that the replacement preserves the existing bridge while
refusing new calls for a suspended user. A second call ends while only the test
portal process is suspended; its durable end report survives another SIGKILL and
is replayed after restart. No live portal or user application is suspended.
Service output is retained privately at
`/tmp/sipper-gateway-process-test.log`; it must omit service authentication secrets.
Finally it removes both containers, child processes, proxy connections, database
fixtures, role and temporary certificate files.
It does not open the desktop app or register against a real PBX.

To include the packaged controller in the same disposable rehearsal, build it
from the repository root, then run the existing test with its image selected:

```sh
docker build -t sipper-controller:local gateway
cd portal
SIPPER_GATEWAY_TEST_IMAGE=sipper-controller:local pnpm test:gateway
```

This adds a private named volume and a non-root, read-only controller container.
It checks journal permissions, kills and replaces the controller while its call
continues in Asterisk, then kills both processes and requires failed-call reporting,
fresh registration/calling and clean shutdown. Only this local rehearsal uses host
networking to reach its loopback fixtures; it does not change production networking.
The temporary controller, volume and environment file are removed on exit.
This is not a physical host restart, power-loss or audible-media test.

For the native Android stage, first build `:app:assembleDebug` and
`:app:assembleDebugAndroidTest` from `android/`. Run a disposable emulator named
`SipperUIQA`, then run from `portal/`:

```sh
SIPPER_ANDROID_SERIAL=emulator-5554 pnpm test:gateway
```

Use its actual emulator serial. The harness rejects real devices and other AVDs.
It installs only the development/test packages, enrols a fictional managed device,
and supplies its configuration and disposable CA through private app storage.
An unknown CA must fail; the trusted certificate must permit SHA-256 registration.
The call must negotiate Opus, active SRTP and successful ICE, exchange packets in
both directions, and keep exchanging them after expiry while refusing a new call.
It repeats native recovery three times, then once after expiry. Every recovery
requires a fresh SDP offer and successful negotiation, completed ICE and advancing
bidirectional packet counters on the same call. The expired account must send no
positive-lifetime registration. These are injected network events; physical
Wi-Fi/mobile handover remains unverified.
The API reports no upstream password or address to the native app.
Incoming calls additionally verify authenticated caller lookup and answer claims,
caller cancellation, per-device decline, another-device answers and failed-answer
cleanup. Device-facing offers prefer Opus, then G.722/G.711, independently of the
upstream codec order. The synthetic OAuth provider is only a loopback protocol
fixture; provisioning and call operations run the real portal service functions.
The Android stage also creates real Core-Telecom sessions through `CallBridge`,
answers/holds/ends calls, checks private notification redaction and requires
notifications to disappear after hangup, remote cancellation and successful blind/
attended transfers. Its sixteen phases include the encrypted transfer handoff
checks described above. Allow microphone and notification access for Sipper through
Android Settings on the dedicated SipperUIQA emulator before running this stage.
The harness checks those prerequisites without changing permissions; audio remains
synthetic silence. This does not verify
browser sign-in, notification-button/lock-screen UI, concurrent call notification
switching, FCM or audible content.

For iOS, build the libraries in `ios/README.md` and create a simulator named
`Sipper iOS QA`. Run `SIPPER_IOS_GATEWAY=1 pnpm test:gateway` from `portal/`.
The harness creates/deletes a separate simulator of that type and runtime, supplies
a one-use CA only to the Debug test engine, and checks the native SDK, SIP and call
coordinator against the real local service functions. The iOS media address is
loopback `127.0.0.1`; its ports match the Android fixture below. Enable only one
native test platform and do not run the database suite concurrently. See the iOS README for
the exact verified scope and the remaining CallKit/PushKit/physical-device checks.

The pinned Asterisk 22.11.0 image applies `asterisk/patches/ice-credential-restart.patch`.
When a client restarts ICE during an unfinished checklist, Asterisk can advertise
fresh credentials while retaining the old session. Its unchanged-candidate shortcut
can also bypass a credential change. The patch only permits session reuse when the
session's local credentials match the negotiated credentials; authentication and
SRTP remain required. The iOS regression repeats recovery three times, then again
after managed expiry, requiring a fresh SDP exchange, successful ICE and increasing
bidirectional encrypted packet counts. Rebuild the gateway image when updating
this patch; a client-only update cannot fix that server-side failure. Reassess the
patch against upstream when upgrading Asterisk.

For Mac, run `make pjsip` from the repository root, then
`SIPPER_MACOS_GATEWAY=1 pnpm test:gateway` from `portal/`. The same harness uses
the Mac XCTest host with a temporary store, in-memory secrets and null audio selected
before the engine starts. It never loads the installed app's accounts or changes
the system trust store. The test rejects the unknown CA, then trusts a temporary DER
certificate only in the Debug engine. The server uses SHA-256-only SIP authentication.
The Mac test cancels a pending recovery with a later offline event, then recovers
the same encrypted call three times and again after account withdrawal. Each
recovery requires a fresh SDP exchange, successful ICE and advancing bidirectional
Opus/SRTP packets. Withdrawal permits a challenged zero-expiry unregister retry,
but rejects any new positive-lifetime registration. Nine incoming phases exercise
the actual Mac call controls, including a queued placeholder update arriving after
authenticated caller lookup; identity is injected. These checks invoke the app's
network handler directly, so physical sleep/wake and network handover remain unverified.
Logs are private at `/tmp/sipper-macos-gateway-test.log`, and fixture records, files,
containers and database roles are removed at the end.

For the Windows app's main-process and C-engine path on macOS, run `make pjsip`,
then `SIPPER_WINDOWS_GATEWAY=1 pnpm test:gateway` from `portal/`. The shared native
harness builds the Mac test engine, uses a temporary store/CA and null audio, and
exercises authenticated provisioning, reports and call actions against the real local
services. Its nine incoming phases include caller cancellation during a pending answer,
another-device answering and microphone denial. The test also rejects unclaimed
native answers, stale call identities and arbitrary outgoing SIP destinations. Injected
sleep/path changes cancel pending recovery and keep wake offline until a path returns.
Three recoveries and a fourth after withdrawal require fresh SDP negotiation, successful
ICE and advancing bidirectional Opus/SRTP packets without reviving the withdrawn binding.
These injected events do not verify Windows notification APIs or physical handover. Logs are
private at `/tmp/sipper-windows-gateway-test.log`; failure diagnostics stay in
`/tmp/sipper-windows-gateway-engine.log`. No system trust changes or installed app data
are involved. This does not verify the Windows TLS/crypto/storage backends or installer.

This stage reserves host-loopback UDP 27000–27031, forwarding it without changing
port numbers, and advertises Android's `10.0.2.2` host alias as the test ICE candidate.
The private Docker network is not directly reachable from the emulator. Its bridge
address forwards external client connections and is excluded from local upstream
networks, keeping the SDP default address consistent with the public ICE candidate.
Signalling uses host-loopback TCP 25061 and advertises that same reachable Contact
address/port, with the loopback IP included in the disposable TLS certificate.
The test checks the advertised Contact and requires server-side call teardown
before each subsequent native call. A locally dismissed call alone cannot pass.
Existing port binds fail rather than being replaced. SIP uses a temporary `adb reverse`
mapping; the protocol fixture uses another temporary mapping. Both mappings and
the private CA/configuration are removed afterwards.
`SIPPER_TEST_ADB` can override the host's Android platform-tools executable; the
default is `$HOME/Library/Android/sdk/platform-tools/adb`.

`npm test` in `gateway/` also runs Python 3 checks for transport settings. For a gateway
behind one-to-one NAT, `.env.example` documents its public/internal media IPs,
public signalling IP/port, local upstream networks and RTP range. The renderer
validates addresses and complete RTP/RTCP port pairs, replaces the private ICE
candidate, and preserves local upstream routing. Signalling NAT must advertise a
reachable Contact for BYE and re-INVITE, separately from media NAT. The shared
local-network list applies to both; forwarding proxies for external clients must
remain outside it. Restart Asterisk after changing transport settings. Host
firewall/NAT setup remains an operator task.
The verified path is IPv4; dual-stack and physical-network interoperability remain
unverified. Do not infer working IPv6 from the address parser accepting it.

See `.env.example` for the transport's consumed settings and certificate mounts.
Production must use a verified database TLS connection, a dedicated database role,
trusted SIP TLS certificates, private management ingress and controlled RTP access.
The controller runs with `cd gateway && npm start` once its `.env` is configured.
Use the same ARI password on it and Asterisk; the portal's gateway API key must
match too. Set the public SIP hostname/port in `portal/.env.example`. The local
smoke test covers the controller classes and the standalone process through the
authenticated HTTP API. Configure `SIPPER_STATE_FILE` before starting the service;
its private persistent directory must survive controller replacement.
Do not configure a short forced shutdown timeout that cuts off a draining call.
A lost ownership lease makes the process exit without deleting the replacement's
routes. A supervisor should restart failed processes with backoff; it must not run
competing controllers against the same Asterisk application.

## Controller container

For the complete Asterisk/controller pair, use
[`infra/compose.gateway.yml` and its runbook](../infra/README.md#gateway-pair).
The separate controller instructions below also support an existing private
Asterisk deployment.

`gateway/Dockerfile` packages the same controller with the pinned Node 24 image
and locked production dependency. Its build context excludes environment files,
certificates, tests and local journals. Build with the command above, then give
the tested image an immutable release tag and record its digest alongside the
matching portal/Asterisk versions. Keep the previous image for investigation;
do not start an older controller against a newer journal without checking compatibility.

Populate [`controller.env.example`](controller.env.example) in a private file
such as `/etc/sipper/controller.env`. This contains only controller settings;
the controller does not need Asterisk's database credentials. Restrict the file
to mode 0600 and Docker access to trusted operators. Do not print container
environment or full inspection output into shared logs.

With an already configured Asterisk container named `sipper-asterisk`, keep ARI
and AMI bound to loopback and share its network namespace. Publish no controller
ports. The placeholder image below must be replaced with the tested release:

```sh
docker volume create sipper-controller-state
docker run -d --name sipper-controller --network container:sipper-asterisk \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --init \
  --restart unless-stopped --log-driver local \
  --log-opt max-size=10m --log-opt max-file=3 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --env-file /etc/sipper/controller.env \
  --mount type=volume,src=sipper-controller-state,dst=/var/lib/sipper-gateway \
  sipper-controller:REPLACE_WITH_TESTED_RELEASE
```

The image uses UID/GID 1000 and initialises the mounted directory as 0700. An
existing bind mount or volume must have that ownership and permission already.
The read-only root and dropped capabilities are also exercised by the rehearsal.
For a private CA, add its read-only mount and `NODE_EXTRA_CA_CERTS` from the example.

For a normal update, stop with `docker stop --timeout=-1 sipper-controller`.
This sends SIGTERM and waits without a forced-kill deadline: readiness is withdrawn
while existing calls finish and pending outcomes reach the portal. Wait for exit
before removing only the container and recreating it with the same state volume.
Never remove the volume or run competing controllers. If draining stalls, inspect
private logs, portal connectivity and remaining calls before deciding on an incident
response; do not force-kill as an ordinary deployment step. Drain before replacing
Asterisk too, then recreate the controller against its new network namespace.

Monitor container exits/restart loops and the portal's gateway readiness and
registration observations. A running container alone is not proof of readiness.
Retain encrypted host storage and a tested journal recovery procedure. This image
does not provision the Asterisk host, firewall, public TLS, NAT/media routing,
external alerts or whole-host failover; those production checks remain outstanding.

## Recovery and storage

`SIPPER_STATE_FILE` is a required absolute SQLite path on a local persistent
filesystem. Its immediate directory must be private (0700); the database is 0600.
SQLite WAL and full synchronous commits protect lifecycle transitions, and a
transaction moves a cleaned-up call into the pending-end queue. The store binds
to the server-issued gateway ID, portal origin and ARI URL. A new owner also fences
the old process's database writes. It uses Node's built-in SQLite, with no extra
database service or package. Keep the whole directory, including WAL/SHM files,
on the persistent volume; do not take an inconsistent live copy of just the main file.

Stored data is limited to call/device/route identifiers and lifecycle metadata.
Passwords, SIP settings, caller names, dialled numbers and media are excluded.
After cleanup and server acknowledgement, the call and retry records are removed.
This is private operational state, not an export or a complete call-history store.

On restart the controller first acquires ownership, opens its journal, verifies
that it knows the Asterisk application's existing channels, and adopts complete
upstream objects without registering them again. Established calls survive only
when their parent and winning leg are still up in the recorded bridge. This also
covers a crash immediately after answering but before the final local commit.
Unestablished or missing calls are cleaned up; interrupted setup is not redialled.
Partial teardown is retried before the end is reported. A management outage while
recovering an established call pauses readiness without hanging up that call.

The running controller also rechecks dynamic upstream objects whenever its ARI
event connection reconnects. Complete objects are adopted without another
registration; missing or partial objects are removed and rebuilt from the latest
authorised portal configuration before new calls are admitted. A failed object
read keeps readiness withdrawn and retries the check; it is not treated as proof
that the route disappeared.

Each new call records Asterisk's
[`status.startup_time`](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Asterisk_REST_Data_Models/#statusinfo)
in the private journal. If Asterisk restarted, the old SIP/media dialogs are gone:
those calls are ended as Failed, not reported as continuing conversations. The
controller can then rebuild eligible routes and clients can register and place
fresh calls. A legacy journal without this timestamp still uses the existing
channel/bridge reconciliation; it cannot retrospectively identify a restart.
No new environment settings, listener or provider credentials are required.

Missing/mismatched state, corruption or write failure must be investigated before
resuming service. Do not delete the journal to clear an error: restore the correct
volume and identity configuration. Unknown live channels keep new calls paused.
The tests cover journal privacy/ownership, unfinished cleanup, real process kills,
preserved bridges and durable end reporting. The Asterisk restart rehearsal kills
only the disposable test container during simultaneous incoming/outgoing calls,
checks withdrawal and failed-call reporting, then requires fresh TLS registration,
upstream registration observations and calls in both directions after recovery.
Disk exhaustion, power loss, whole-host restart and multi-host failover still need operational testing.
Asterisk/host failure cannot preserve media just by restarting the controller.

A cold portal-database restore follows the [recovery hold and reconciliation
procedure](../infra/README.md#restore-procedure). Fence old gateway/media hosts
before restoring. Restored device credentials, readiness and observations are
invalidated; users need new sign-in/provisioning. After explicit release, start
fresh Asterisk state and a new private controller state volume. Retain the old
journal for diagnosis, but do not replay it against the restored timeline. This
is separate from restarting a controller against its current database and live
Asterisk channels, where the correct existing journal is required.

Network placement, NAT/media settings and production controller deployment remain part of the
unfinished service; do not expose this development transport as a finished gateway.

## Upstream references

- [Asterisk realtime configuration](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Setting-up-PJSIP-Realtime/)
- [SIP digest authentication](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/PJSIP-Authentication/)
- [Sorcery configuration and source](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_sorcery_realtime.c)
- [ARI channels](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Channels/)
- [ARI media bridges](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Bridges/)
- [Open-source Opus module](https://github.com/wazo-platform/wazo-codec-opus-open-source/tree/591b6cd9b75e2b9b6d815ef364a385fccee595a7)
- [Asterisk RTP and ICE configuration](https://github.com/asterisk/asterisk/blob/22.11.0/configs/samples/rtp.conf.sample)

Asterisk's GPL licence texts are included in the image at
`/usr/share/doc/sipper-asterisk`; the Opus module's licence and provenance are in
its `opus-codec/` subdirectory. No proprietary codec binary is bundled.
