# Sipper for iOS

Native SwiftUI app under development, sharing the Mac PJSIP engine and `SipperManaged` OAuth/provisioning package. It is not a released iOS client. The full platform acceptance requirements remain in [the implementation ledger](../docs/IMPLEMENTATION-STATUS.md).

## Managed messages

Open **Directory → Messages** for direct and named group conversations. Group
owners can change the name, members and owner; participants can leave. New or
rejoining members see messages sent after they joined. The shared Apple client
has 37 passing checks and ten-stage real local portal acceptance, including group
changes, exact retries and history isolation. The new group controls still need
visual review. Apply portal migrations 032–034; foreground messaging needs no additional key.
See [Messaging](../docs/MESSAGING.md) for retention and remaining acceptance.

A brief inactive scene clears received message pages but keeps an open group
editor and its unsaved fields. Returning to the app reloads colleagues. Full
backgrounding closes group settings; no message data is saved to disk or Keychain.

The same draft/dialogue lock now guards the app's main tabs and the native
Messages back button. Send or Clear draft before leaving an ordinary draft;
an uncertain send keeps its original text and reference. Incoming validated setup
links and account-import reviews wait for the lock to release. Calls take priority,
and queued account setup waits until they finish; cancelling an import removes its
queued navigation. Leaving the message view still clears its in-memory draft.
All ten native account checks and 37 shared client checks pass, as do simulator
Debug and unsigned iPhone/iPad Release builds. The routing regression uses real
link/import validation with in-memory storage and synthetic call observations.
Interactive tab/back/keyboard, sign-in and group-control acceptance remains open:
computer use cannot read the running Device Hub window.

**Accounts → Message notifications** opts into generic normal APNs alerts,
independently of microphone permission. The token registry is separate from
PushKit and no message body or sender details enter a notification. Set the
server's `SIPPER_APNS_MESSAGE_TOPIC` to this build's normal bundle ID (without
`.voip`), alongside the existing Apple settings, and run the push worker. A cold
notification tap refreshes customer access before opening Messages. The local
portal check covers that routing guard, token registration, queued read
suppression and revocation. Permission/tap UI and real delivery on a signed,
locked physical device remain unverified; see [`.env.example`](.env.example).

## Personal account imports

Open a `sipper://add-accounts` link or paste it under **Accounts → Import accounts**.
The app reuses the desktop [version-1 protocol](../docs/PROTOCOL.md#mobile-import),
then shows a review before saving or registering anything. Existing accounts start
unselected; updates keep their identity, history, custom label, enabled state and
media/NAT preferences. Managed accounts are separate. Up to 16 personal accounts
are supported, with one atomic Keychain write for the selection. Invalid,
ambiguous or stale reviews cannot overwrite saved settings. No new keys are needed.

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

## Shared colleague status

Opening a company contact shows their manually shared availability and Do Not
Disturb preference when they have opted in through the portal. Administrators
link the contact to a member of that customer. Portal migrations 030/031 enable
manual status and separately opted-in managed call activity. Activity labels name
the app/gateway report source and expire no later than three minutes after the
observation; missing activity never means available.
The app refreshes the open contact every 20 seconds while active and discards
status after at most 30 seconds, on failure, backgrounding or contact/customer
changes. Hidden and unavailable statuses use the same label. Observations never
enter the saved directory and do not confirm reachability or affect calls.
No provider key is required. Native visual acceptance remains outstanding.

## Build

Requires Xcode 16.3+ with an iOS SDK and simulator runtime, XcodeGen, and the standard Apple command-line build tools. The app targets iOS 16 or later. The library script currently builds arm64 iPhone and arm64 simulator slices.

From the repository root:

```sh
scripts/build-ios-pjsip.sh all
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/SipperIOS.xcodeproj -scheme SipperIOS \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

Open `ios/SipperIOS.xcodeproj` to choose a simulator or development device. The Debug bundle is `com.hybes.sipper.ios.development`, with separate Keychain storage. Release uses `com.hybes.sipper.ios`. No accounts or PBX credentials are seeded. Signing a device build requires selecting a development team; simulator builds do not need one. Library outputs, downloaded source and generated projects are ignored by Git.

Keep ad-hoc signing enabled when running simulator builds: an unsigned binary can
compile and launch but lacks the entitlements needed by the real Keychain store.
`CODE_SIGNING_ALLOWED=NO` is appropriate for a compile-only physical-device check,
not for verifying managed sign-in or saved personal accounts in the simulator.

PJSIP 2.15.1 and Opus 1.6.1 are downloaded with pinned SHA-256 checksums and compiled separately for each SDK. The Mac vendor tree is untouched. TLS uses PJSIP's Apple Network framework backend with certificate verification enabled. The tracked `../scripts/patches/pjsip-apple-sha256.patch` adds SHA-256 SIP digest using Apple's CommonCrypto while retaining PJSIP's digest protocol implementation and legacy MD5. Upstream's Apple backend otherwise supports only MD5 in this pinned version. SHA-512/256 remains unsupported. Each SDK's `BUILD-INFO.txt` records the patch checksum. Bundled licence texts are copied into the app and readable under Accounts. App Store licensing/distribution review remains part of the release checklist.

## Current app path

- Keypad, recent calls, company directory, personal account editor and managed account controls.
- The company directory uses the shared Apple view, keeps contacts in the managed Keychain cache and offers only the selected customer's enrolled calling accounts. It refreshes while visible, independently of incoming-call restoration. See [the directory contract](../docs/COMPANY-DIRECTORY.md) for size limits, expiry and current verification boundaries.
- Personal SIP accounts and passwords stored together in a device-only Keychain item. A failed write leaves the prior active settings intact.
- Managed OAuth uses the system browser and PKCE. Managed settings use a separate secure store, installation-specific account IDs and bounded validity; they cannot be edited or converted into personal accounts.
- Accounts shows sign-in progress with an available Cancel action, links to the management portal and explains how to recover when no organisation is listed. Signing out or disconnecting a customer requires confirmation; the existing cleanup preserves personal accounts and connected calls.
- Configuration acknowledgement waits until PJSIP accepted the settings. Deferred changes during an established managed call are not acknowledged as applied.
- CallKit owns incoming/outgoing calls, answer/end, mute, hold, DTMF and audio activation. SIP call IDs map to separate CallKit UUIDs so a late action cannot target a reused numeric SIP ID.
- Hold actions retain their captured account/start-time identity and complete only after SIP acceptance and negotiated media confirm the change. Native/remote failures fail the action and prevent the concurrent start/answer/resume delegate from admitting another audible call. Both peers can hold simultaneously; local resume also handles a remotely held call. Four-second timeouts keep unresolved transactions fenced until their final result or hang-up. Timeout/reset/end cancels an action once; late results cannot complete it again. Established calls remain controllable after withdrawal. Recording-provider checks exercise the production delegates, not system CallKit UI.
- Active calls have a scrollable Calls tab. **Add call** selects the original account and clears the keypad; **Return to call** changes only the screen. Placing a second call requests hold and start together through CallKit. Answering or resuming a call also requests hold for the other connected call. Two calls are supported, matching the CallKit configuration. Invalid input, microphone denial and a rejected transaction leave the existing call unchanged. Stale call controls cannot target a reused SIP ID.
- **Merge calls** requests a CallKit group for two connected calls on the same account. The shared native mixer forwards audio between both remote parties while Sipper remains running. One conference view lists both people, shared Mute/Hold, each person's Keypad/Remove and End conference. **Separate calls** holds both parties before splitting, then requests the selected person's resume and the other's hold after the group action completes. Rejection leaves both held and reports how to resume. Duplicate participant hold/resume actions share one actual negotiation. End/reset/timeout cancels group changes once; a cancelled resume cannot wait on its own shared task. Transfer is disabled until separation. The recording-provider tests do not establish system CallKit acceptance or interactive layout.
- The in-call audio control uses Apple's native [AVRoutePickerView](https://developer.apple.com/documentation/avkit/avroutepickerview). It belongs to the shared audio session, is disabled until CallKit successfully starts call audio, and displays the system's actual output route. Headset/route changes refresh that label on the main thread. The picker does not activate the session or force a saved speaker/headset preference. Speaker, Bluetooth and wired-headset selection still require physical-device verification.
- Network changes invalidate the previous registration observation. After a short
  settling delay, PJSIP restarts listeners and reliable transports, refreshes
  eligible registrations and requests media/contact updates for existing calls.
  The initial connected snapshot does not trigger recovery or cancel a new call;
  an initially offline path still reports loss of connectivity and later recovers.
  Withdrawn managed accounts retain their existing dialogs without a registrar,
  so recovery cannot register them again. Rejected credentials remain a visible
  failure. Actual handover still depends on the provider, network and iOS scheduling;
  physical Wi-Fi/mobile-data continuity remains a release check.
- Managed gateway accounts require verified TLS, SHA-256 authentication and mandatory SRTP. Gateway dialling accepts phone destinations only. Incoming offers require one canonical call ID on an outgoing TLS connection; the authenticated device API supplies caller details and reserves the answer before SIP acceptance. Cancelled or unavailable offers are dismissed, while a delayed ringing response cannot end an established call.
- PushKit starts during app launch, including background launch. Required incoming pushes report a generic CallKit placeholder immediately, then authenticate the opaque call/device reference, refresh an existing enrolment and restore its registration. The SIP offer updates the same CallKit UUID with authenticated caller details. Duplicate pushes, early answer/end, timeout and sign-out are handled by the same call lifecycle. Token rotation/invalidation is serialised across eligible gateway enrolments and retries on later refreshes.
- Recent calls retain their original account identity and cannot fall back to a different personal account. The history file uses iOS file protection and is capped at 500 records.

Direct SIP is useful while the app is active; it does not promise reliable incoming calls after suspension. The native gateway path passes the disposable Asterisk integration check described below. Real APNs delivery, background/locked-device CallKit behaviour, interactive audio-route UI verification, mobile network-change interoperability and physical-device call tests are still required. Push registration is off by default until a signed build and matching server provider configuration are supplied; missing setup never reports successful delivery.

### Enable Apple push for a signed build

Enable Push Notifications for the explicit Apple App ID, regenerate its provisioning profile, select your team and build with `SIPPER_PUSH_ENABLED=YES`. The project supplies `aps-environment=development` in Debug and `production` in Release through `SIPPER_APNS_ENVIRONMENT`; this must match the profile. No Apple account password or notarisation credential is needed by the app.

Configure the server's APNs `.p8` key, key ID, team ID, topic and sandbox flag, then run both the push worker and gateway. Release uses topic `com.hybes.sipper.ios.voip` and production APNs; Debug uses `com.hybes.sipper.ios.development.voip` and sandbox APNs. One topic/environment is supported per server deployment, so keep Debug on a separate staging portal/database/gateway. See [the complete app settings](.env.example) and [server settings](../portal/.env.example). Real delivery must be verified on a locked physical device before release.

The shared engine runs on a dedicated registered PJSIP thread. Production iOS starts with no sound device and enables it only in CallKit's audio-activation callback. Debug XCTest can select the virtual audio clock before startup; it never opens physical audio. Personal account edits/deletion are refused while the account has a call. Normal managed withdrawal preserves established calls but rejects new ones.

## Managed setup links

The Accounts screen accepts an administrator's setup link. `sipper://setup` selects Accounts and fills the link after checking its origin; it does not automatically sign in or connect. The user signs in with the invited email and chooses **Connect with setup link**. The shared SDK validates identity-bound redemption before normal enrolment. Links stay in memory and are cleared on connection or sign-out. See [the shared contract](../portal/README.md#managed-setup-links). Browser handoff and physical QR scanning remain unverified.

## Local checks

Direct SIP calls support blind transfer to a number or SIP address and attended
transfer to another connected call on the same account. Choose Add call, place
the consultation call, then select it under Transfer. Transfer progress and
failure remain on the call; failure does not hang up either leg. The shared engine
rechecks call identity and current account authority, rejects overlapping transfers,
and ends only the captured local legs after successful SIP status. Gateway calls
now use the same controls, restrict blind destinations to phone numbers/extensions,
and require the controller to authorise and complete the transfer. The shared gateway
endpoint configuration remains disabled while other clients and interoperability
checks are unfinished. The direct loopback fixture checks REFER/NOTIFY signalling;
the separate gateway rehearsal below also checks encrypted media after handoff.

The latest simulator run passes all 35 baseline cases with both
loopback fixtures enabled and the gateway class excluded. Consultation checks
cover account selection, draft cancellation, stale controls, the two-call limit,
rejected requests, hold/start and hold/resume transactions, and transfer cleanup.
They run the real CallKit delegate and SIP engine with a recording transaction
boundary and null audio; they do not establish CallKit system acceptance. Conference checks
cover grouping capabilities, merge, shared mute, simultaneous participant hold/resume,
safe separation, rejected requests, exact conference end, surviving calls and cancellation
before a resume task starts. A transmitted-packet assertion now verifies that selecting
null audio before startup actually starts its virtual clock. This assertion failed
before the Debug startup correction and passes afterwards. The direct-transfer
case exercises rejected and successful NOTIFY status, attended Replaces signalling,
local leg cleanup, stale identities, invalid targets, duplicate requests, cross-account
rejection and withdrawn access. The expiry check now rejects transfers too. Existing
network recovery, account import and CallKit lifecycle checks pass. The new shared
startup regression covers initially connected and offline paths, a call placed
before the first connected snapshot, and subsequent offline/online recovery.
Debug simulator
and unsigned iPhone/iPad Release builds pass. Device Hub computer use still times out;
Calls-tab layout, transfer-screen interaction, audio routes, import review and interactive browser sign-in remain
unverified. The separate real gateway suite passes fourteen native
phases after the shared conference changes, including encrypted tone forwarding and transfer handoff,
incoming controls and repeated recovery. It also reuses call/media slots through six
two-call setups, requiring packets and both audio connections, and verifies exactly three
answer API requests for live offers. Cancelled, declined and failed offers make none.
Two earlier gateway runs had an unexplained zero-transmit timeout; the strengthened run
passes, but this does not establish the cause of those failures. The startup correction
fixes a separate test setup issue. It uses a recording CallKit boundary;
system CallKit UI and physical audio remain unverified.

The earlier eighteen-case run included both real loopback SIP cases and six push-lifecycle checks. Those cover native SIP-header parsing, unsafe gateway settings, restricted dialling, immediate incoming-call reporting, duplicate pushes/answers, early cancellation, microphone denial and serial token rotation/retry. The local call test also confirms that a delayed ringing dismissal cannot end an established call. Both SHA-256-only and legacy MD5 registrars have passed earlier checks; this does not establish physical two-way audio, CallKit system UI or APNs delivery. See the implementation ledger for the separate unsigned device build and shared SDK evidence.

The optional integration check uses the repository's loopback SIP registrar. It must not be pointed at a real PBX. Start it in a separate terminal:

```sh
python3 tools/sip-test-server.py --bind 127.0.0.1 --port 5094 --tls-port 0 \
  --domain sipper.test --user ios-test:local-ios-test --auth-algorithm SHA-256 --auth-invite \
  --answer-special --special-call-seconds 45
```

Then select a dedicated test simulator ID from `xcrun simctl list devices available`. Boot it and wait for startup before testing (use a disposable simulator if a prior test runner stalled):

```sh
xcrun simctl boot <simulator-id>
xcrun simctl bootstatus <simulator-id> -b
xcodebuild -project ios/SipperIOS.xcodeproj -scheme SipperIOS \
  -configuration Debug -destination 'platform=iOS Simulator,id=<simulator-id>' \
  -derivedDataPath ios/DerivedData -parallel-testing-enabled NO -collect-test-diagnostics never \
  -skip-testing:SipperIOSTests/GatewayIntegrationTests \
  -skip-testing:SipperIOSTests/PortalIntegrationTests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- SIPPER_TEST_REGISTRAR=127.0.0.1 test
```

This checks authenticated REGISTER and INVITE, rejects a wrong password, denies a new call after managed expiry and verifies that the established call survives until a client BYE. To verify legacy providers, stop the registrar, restart it with `--auth-algorithm MD5`, and run the same suite. It does not open the microphone or prove physical two-way audio, CallKit lock-screen behaviour, Bluetooth or APNs delivery. Without the explicit test setting, the two integration cases skip; inspect the test report rather than assuming they ran. Stop the loopback registrar after testing.

Runtime/build settings are explained in [`.env.example`](.env.example). Provider secrets belong on the server, never inside the app.

### Real local portal acceptance

With the iOS libraries built, the local PostgreSQL/Mailpit services running and a
simulator named `Sipper iOS QA` available, run from `portal/`:

```sh
pnpm build
pnpm test:ios-portal
```

The shared `scripts/native-portal-smoke.ts` harness creates a disposable simulator,
test database, separate built Nuxt server and loopback SIP registrar. It uses a
fictional verified user with MFA, one licensed customer and three directory contacts.
The real AppAuth discovery/PKCE/code exchange runs through the same SDK entry point
as browser sign-in. Its external user agent hands the authorisation URL to the
companion, which performs real HTTP consent and returns the server's callback.
Tokens and API replies are not simulated; browser gestures and URL dispatch are
not covered.

The simulator test host is ad-hoc signed so Keychain entitlements are available;
no Apple account, certificate or provisioning profile is required for this check.
The native test uses the real Keychain, account controller, directory validation
and SIP engine. It checks restored identity/settings/contacts, managed directory
calling, availability, shared colleague status/activity and independent opt-out, registration/call/IP
reports, suspension and resumption,
device revocation and durable sign-out. A separate personal account and an already
connected call must survive managed suspension. CallKit transactions invoke the
real delegate behind a recording system boundary; null audio keeps the microphone
closed. This does not establish CallKit system UI, push delivery or audible media.

The harness removes its simulator, database, private exchange files and processes.
Diagnostics stay in `/tmp/sipper-ios-portal-test.log` with private file permissions.
`SIPPER_TEST_DATABASE_URL` must reference a loopback database ending in `_test`;
the harness creates a separate random database and needs local create/drop rights.
Mailpit SMTP uses port 1029 and its API uses 8030. No provider credentials are needed.

### Real gateway integration

After building the iOS libraries above, follow [the gateway prerequisites](../gateway/README.md#reproduce-the-local-registration-and-calling-checks), including the built local portal. Create a simulator named `Sipper iOS QA` using an installed iPhone simulator runtime. From `portal/`:

```sh
SIPPER_IOS_GATEWAY=1 pnpm test:gateway
```

The harness reads that simulator's device type/runtime and creates a separate temporary simulator. It never launches the reference simulator or changes the Mac's trust store. Fictional accounts use the real provisioning/call service functions and the native `ManagedClient` and `ManagedCallControl`; only the identity/token is injected. It first rejects the unknown gateway CA, verifies the temporary certificate against Apple's native TLS policy, then supplies that CA to PJSIP with verification still enabled. The fixture certificate includes `serverAuth` usage. Test-only CA and null-audio controls are excluded from Release builds.

The native check negotiates Opus through a G.711 upstream, verifies active SRTP, successful ICE and packets in both directions. It repeats network recovery three times on that call, waiting for a fresh SDP negotiation before checking ICE and increasing packet counters. Managed expiry unregisters the account and rejects new calls; a fourth recovery must preserve encrypted media without sending another REGISTER. The gateway image includes the ICE credential-restart patch described in its README. These are simulated path-change notifications on loopback, not physical Wi-Fi/mobile handover. It removes the SIP account, supplies an opaque APNs-shaped hint and exercises the production wake flow: authenticated device lookup, configuration refresh, registration and merging the real SIP offer into the original CallKit placeholder. The real CallKit delegate answer/end methods use a recording provider and actions; no system call UI or microphone is opened. The accepted call exchanges encrypted packets and an ended hint cannot restart it.

The transfer phases reject unsafe gateway destinations and a deliberately declined target without losing the original call or its media. Both blind and attended transfer begin with a held call; the native legs then close, and the harness verifies the two remaining remote legs have TLS, SRTP, no hold and increasing packet counts in both directions. One fixture extension generates a tone and the other echoes it. The remote hangup must clear the bridge and reach gateway history. These checks use the native engine; they do not exercise the transfer sheet or CallKit system UI.

The remaining phases test authenticated caller lookup, answer reservation, caller cancellation, per-device decline, another-device answers and failed local-answer cleanup. The harness requires both transfer phases and all eleven incoming phases. The gateway's controller recovery/drain checks run afterwards. Test audio is generated silence/tone, not microphone/speaker proof. CallKit system UI, real OAuth browser sign-in, APNs delivery and wider PBX interoperability remain unverified.

The test reserves loopback TCP 25061 and UDP 27000–27031 and advertises `127.0.0.1` to the simulator. Run it separately from the Android gateway stage and portal database tests. Build/test output is private at `/tmp/sipper-ios-gateway-test.log`; fixture secrets and the temporary simulator are removed in cleanup.

## Native managed meetings

Messages → Meeting opens the shared native Mac/iOS screen with the official
LiveKit Swift SDK pinned at 2.17.0. Join starts with microphone and camera off.
Explicit controls use Apple permission prompts; Leave stops media and withdraws
that exact session. Incoming cameras/screens and the participant table follow
the SDK. Phone and meeting audio are mutually exclusive, including CallKit’s
activation callback. Backgrounding stops meeting media and requires an explicit
rejoin; a meeting CallKit owner, screen publishing, device choices and physical
media acceptance remain unfinished. See [MEETINGS.md](../docs/MEETINGS.md).

The eight CallKit lifecycle checks pass on a disposable iPhone simulator with
recording providers and no hardware capture. The native screen fixture builds
and launches, but Device Hub computer-use timed out, so mobile visual acceptance
is not claimed. Provider push/system audio and stable SFU media need separate
acceptance. No new provider key was requested; the existing server meeting
settings remain in `portal/.env.example` and the infrastructure examples.
