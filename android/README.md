# Sipper for Android

Native Kotlin/Compose client using the official PJSUA2 Java/JNI bindings. This is
development work, not a published Android release. Debug builds have the separate
application ID `com.hybes.sipper.android.development`.

## Build

Requires JDK 17, Android SDK 36, NDK r28 or later, SWIG, Make, Perl, curl and tar.
No Sipper server or provider key is needed to build the standalone client.

```sh
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/Android/sdk
export ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/your-installed-ndk"
scripts/build-android-pjsip.sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

The native builder supports `arm64-v8a`, `x86_64`, or both (the default). It verifies
the PJSIP 2.15.1, Opus 1.6.1 and OpenSSL 3.5.8 source checksums, builds into the
ignored `android/vendor/` directory and bundles their licence texts. The Gradle
wrapper also pins the official distribution checksum. The generated APK is
`app/build/outputs/apk/debug/app-debug.apk`.

The tracked `patches/pjsip-clear-stun.patch` permits an empty STUN list, cancels an
obsolete pending lookup and clears the cached STUN address. The builder applies
it after verifying the upstream archive, and records its checksum in build info.
This prevents a removed organisation's STUN server remaining active after its
last account is removed. The patch applies cleanly to the pinned source archive.

Native code uses Android API 26 and 16 KB ELF load alignment. Optional Android
MediaCodec codecs are disabled because PJSIP's asynchronous implementation requires
API 28; Opus, G.722, PCMU and PCMA remain available. iLBC is excluded.

### Release packages

Gradle can build an APK for direct installation and an Android App Bundle for
Google Play. Export all four `SIPPER_ANDROID_SIGNING_*` settings documented in
[`.env.example`](.env.example), using a private keystore outside this repository.
Then run from `android/`:

```sh
./gradlew :app:assembleRelease :app:bundleRelease
```

Signed outputs are `app/build/outputs/apk/release/app-release.apk` and
`app/build/outputs/bundle/release/app-release.aab`. With all signing settings blank,
the APK is `app-release-unsigned.apk` and the bundle is unsigned; those outputs
are compilation checks and must not be distributed. Partial settings, a missing
keystore or incorrect signing credentials fail the build. Debug signing remains
separate. The released app uses `https://sipper.dev` and the production callback.

Keep the signing identity for updates. Google Play App Signing uses an upload
key and a separate app-signing key; a directly signed APK can have a different
certificate from Play's installed app. Decide the two channels' signing identity
before distribution. Match Firebase package/certificate restrictions to the
certificate actually installed. Increase `versionCode` before each Play upload
and update `versionName` for the release. Publish the corresponding source and
licence texts with each release, following the root README.

For web and Play installations to update each other, provide your own app-signing
key when enrolling in Play App Signing and use that key for the direct APK.
If you register a separate upload key, build the Play bundle with it in a separate
invocation. See [Android's signing documentation](https://developer.android.com/studio/publish/app-signing).

This configures packaging only. Store submission, production signing, physical
calling/push acceptance and the mobile release requirements remain outstanding.

A disposable test key verifies signed APK/AAB output, matching signing
certificates, the production package, bundled Sipper licence, APK 16 KiB ZIP
alignment and 16 KiB ELF load alignment for all eight arm64/x86_64 libraries.
Partial settings, a missing keystore, wrong alias and wrong password are rejected.
The test key and signed test outputs are removed afterwards; normal unsigned
APK/AAB and HTTPS debug/test packages are restored. All eight JVM checks and lint
pass, with no lint errors and 16 warnings. This does not establish production
signing, Play acceptance or an installed release's physical-device behaviour.

## Managed setup links

Accounts includes a **Setup link** field and **Connect with setup link** action. A `sipper://setup` intent opens that form after validating the link against the configured management origin; it does not automatically connect or place calls. Sign in with the invited email first. The authenticated redemption response must match that identity and an active licensed customer before normal enrolment. References remain in memory and are not saved to the vault. Another origin, wrong identity, unavailable links and responses arriving after sign-out are rejected. See [the shared setup contract](../portal/README.md#managed-setup-links). Actual camera scanning and browser/Android intent handoff remain release checks.

## Personal account imports

Open a `sipper://add-accounts` link or use **Accounts → Import accounts** to paste
one. The [desktop version-1 protocol](../docs/PROTOCOL.md#mobile-import) is supported
with a review before saving or registering. Existing accounts start unselected;
updates retain their identity, history, custom label, enabled state and media/NAT
preferences. Managed ownership cannot be imported. The selection commits in one
encrypted atomic write, with a 16-account limit and rejection of stale reviews,
ambiguous duplicates and updates to accounts currently in calls. No new keys or
dependencies are needed.

Emulator checks cover parsing, field/size/nesting limits, duplicate and stale
reviews, active-call rejection, identity/security preservation, encrypted reload
and failed-write preservation. Computer use checked empty input, masked entry,
keyboard layout, invalid-link errors and cancellation in portrait light mode.
Populated review, external intent handoff, dark mode and physical devices remain
unverified; computer-use typing/pasting into the embedded emulator did not work
reliably. Android ignores informational source, caller-ID and notes metadata.

## Current behaviour

- Personal SIP accounts and import links, dial pad, local Recents with callback and call controls.
- Same-account three-way audio conferences: **Merge calls**, shared **Mute/Hold**,
  each participant's **Keypad/Separate/Remove**, and **End conference**. The native
  engine binds the exact two dialogs and creates a fresh reference on every merge.
  The app replaces their two Core-Telecom presentations with one conference session;
  separation holds both, creates individual sessions and resumes the selected person.
  Participant departure keeps the other dialog. Pending audio changes disable
  competing controls, and old conference notifications cannot affect later groups.
  Lock-screen controls show only the selected call/conference; choosing other calls
  requires the normal unlocked activity. System handover, visual acceptance and
  physical audio remain unverified while QA microphone consent is pending.
- Direct SIP and gateway blind and attended transfers, with per-call progress/failure. An attended
  transfer joins two connected calls on the same account. Choose **Add call** to
  open the keypad with that account selected; Android waits for confirmed hold
  before placing the next call. **Return to** or Android Back cancels the draft without
  holding the call. Then choose the other connected call under **Transfer**.
  Recents and Directory remain available while preparing the next call. Incoming
  calls and an ended source return to the call controls. Opening Add call from a
  notification uses the normal main activity, which requires unlocking the phone.
  Native admission
  rechecks account access and call identity, prevents overlapping transfers and keeps
  calls connected on failure. Gateway targets must be phone numbers/extensions of
  at most 128 characters after formatting is removed. The isolated gateway rehearsal
  verifies continuing encrypted remote media and local Core-Telecom/notification
  cleanup. Shared gateway endpoints still disable transfers pending the remaining
  client and interoperability checks. Direct loopback checks simulate REFER/NOTIFY;
  neither test establishes physical audio quality or third-party PBX compatibility.
- Account and history data encrypted using a device-bound Android Keystore key,
  authenticated AES-GCM and atomic writes in the no-backup directory. A damaged
  store or missing key causes an error; it is not silently reset.
- TLS uses system trust roots and TLS 1.2/1.3 with server verification enabled.
  There is no skip-verification switch. SRTP and ICE are configurable per account.
- PJSUA2 is confined to its own thread. SIP logging is disabled in normal use.
  Debug tests with null audio retain only fixed registration/SDP milestones,
  never raw SIP messages, addresses or keys. The microphone is opened for calls,
  never just for registration.
- Android Core-Telecom integration supplies call lifecycle callbacks and audio-route
  selection. A bound phone-call foreground service publishes the call notification,
  prioritising a ringing call and removing it when the last call ends. Incoming calls
  use a ringtone channel; ongoing calls use a separate silent channel. Notifications
  open a dedicated, non-exported call activity with answer/decline and ongoing controls.
  It shows only the selected live call over the lock screen and closes when that call
  ends; opening an expired notification does not restart calling. On Android 14 and
  later, Accounts links to full-screen call settings when that permission is disabled.
  The Android 16 gateway check exercises real Telecom sessions, notification channels,
  full-screen pending intents and cleanup. Full
  application-wide light/dark UI, incoming notification-button/lock-screen interaction
  and physical audio verification remain outstanding.
- Managed accounts use AppAuth 0.11.1 for browser authorisation code/PKCE and token
  refresh. The authenticated API identity is checked before committing the session.
  Tokens, pending sign-in and configuration caches use a separate encrypted vault.
  Organisation selection, enrolment, refresh, disconnect and local sign-out are
  available under Accounts. Managed SIP fields are hidden from ordinary editing.
- Managed configurations are bound to the requested organisation/device and have
  bounded validity. Expiry, suspension and revocation withdraw managed accounts
  while preserving personal accounts and established calls. Refreshes and device
  registration reports run every minute; applied revisions require engine confirmation.
  Local expiry is checked every second in the controller and independently by the
  engine. A late network result cannot restore accounts after sign-out.
- Caller display name, voicemail destination and STUN settings are mapped from
  managed provisioning and are also editable for personal accounts. STUN servers
  form PJSIP's shared fallback list (up to eight); accounts without a STUN setting
  disable it individually. The keypad includes a voicemail action.
- Android's default-network callback starts from the current route, waits for link
  properties, coalesces changes and invokes PJSIP's transport/registration recovery.
  The initial route notification does not restart transports or cancel a new call.
  Offline observations become
  unknown and explicit registration refresh is blocked offline. Permanent
  registration failures remain visible when PJSIP skips their recovery. Withdrawn
  accounts have no registrar configured, so a recovery event cannot re-register
  them while their established calls finish. Renewing only a managed lease updates
  its expiry without replacing the SIP account.
- Managed gateway configurations require TLS, SRTP and a device-bound lease.
  Numeric/extension destinations stay on that gateway; arbitrary SIP-address
  dialling remains available for direct accounts. The gateway's upstream secrets
  do not enter the app. Incoming offers require a single canonical gateway call
  reference; missing or duplicate offers are rejected. Caller labels come from the
  authenticated device API, and answering claims that device before accepting SIP.
  Cancellation, another-device answers and failed answer setup dismiss the offer.
  The isolated test below verifies this path and incoming/outgoing media.

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

## Company directory

The **Directory** tab lists shared contacts for connected customers, with search,
labelled numbers and a customer-bound calling-account selector. The model checks
the current contact and exact eligible account again after microphone permission
handling. Personal accounts cannot be used as a fallback.

Complete paginated snapshots are validated and kept in the encrypted managed
vault, bound to the signed-in identity and enrolled device. The screen refreshes
while active. Offline access lasts only until the earliest page expiry; known
withdrawal, disconnect and sign-out clear access and fence late responses. The
limit is 10,000 contacts / 8 MB of contact text per directory, with a 16 MB ceiling
for the full managed session. Personal stores retain their 1 MB ceiling. See
[Company directory](../docs/COMPANY-DIRECTORY.md) for the contract and limits.
No additional provider key is required. Native visual review and a directory
button-to-call check remain unverified. The separate portal acceptance test below
verifies real contact delivery and native SIP calling through the same directory
validation used by that button.

## Managed messages

Open **Directory → Messages** after connecting a licensed managed customer.
The native screen supports direct conversations, named groups, colleague
search, paged conversations/history, plain-text messages and shared read state.
Group owners can change the name, members and owner; participants can leave.
New or rejoining members see messages sent after they joined.
An uncertain send retains its exact text and UUID for an explicit retry or discard.
All message data stays in memory, with no saved-state or encrypted-session archive.
A brief pause clears received pages and stops polling while retaining the draft
and open editor. Stopping the activity, customer changes and known access loss
clear the view; a service outage preserves the draft only while that view stays open.
History, conversation metadata and colleague pages expire independently within
30 seconds and poll every five seconds. The client validates the current enrolled
device/customer/user before and after HTTP, bounded rosters/cursors, Int64 decimal
sequences and exact send replies. No new provider key or dependency is required.
See [Messaging](../docs/MESSAGING.md) for API/retention and remaining chat work.

The 30 managed-client instrumentation checks pass on the dedicated Android 16
emulator, including messaging checks covering exact retries/non-persistence,
poisoned responses, full Unicode pages/byte limits, group ownership/history
boundaries and late access withdrawal.
The separate real portal acceptance passes ten stages, including direct/group
sends, colleague replies, cross-device read state, group changes/leaving/rejoining
and suspension/revocation.
These protocol checks use null audio and HTTP-supplied consent; they do not prove
interactive sign-in, screen layout, physical phones or chat notification delivery.

**Accounts → Enable message notifications** opts into generic FCM alerts when
Firebase is configured. It requests notification permission independently of
the microphone. The Messages channel, normal launcher tap and separate message
token registry keep alerts out of Telecom/call wake jobs. Notifications contain
no body, sender/customer name or SIP detail; current authenticated HTTP supplies
content. Apply migration 034 and run the push worker. The existing Firebase
client fields and server service account are reused; no new dependency is needed.
See [`.env.example`](.env.example). Provider delivery, permission/tap UI and
locked physical-device acceptance remain unverified.

While Messages stays open, a notification waits for an unsent draft, uncertain
send or open conversation/group editor. Clearing or sending the draft, discarding
an uncertain send or closing the editor releases its customer/conversation change.
The exact retry UUID/text stays frozen, including during a brief activity pause.
The customer picker, Conversations and the message view's Directory button also
wait for an ordinary unsent draft. **Clear draft** removes it explicitly; opening
and cancelling group settings retains it. The app's bottom navigation also waits
for this lock; incoming setup links and account imports wait until it releases.
Calls still take priority, and stopping the activity clears this in-memory view.
Debug/unsigned Release builds, lint and all eight JVM checks pass, including a
delayed-response check proving inactive pages neither request nor accept message
bodies. Native notification/draft interruption interaction remains to be verified.

Separate computer use on 30 September verifies the ordinary-user Chrome sign-in,
consent and actual Android callback against the local portal, customer connection,
direct sending, native group creation and receipt of a colleague's group reply.
Portrait and scrollable landscape light-mode screens are checked, with literal
markup remaining plain text. The fixture has three fictional users and no SIP
accounts. A real preview outage clears expired history, retains the frozen retry
draft and delivers it once after recovery. Disconnect revokes the enrolled device,
and native sign-out survives relaunch with the normal build restored. Directory
controls also scroll in landscape and when available height is reduced. A fresh
ordinary-user sign-in and customer connection also verifies the draft navigation
lock, Clear draft, restored conversation navigation and cancelling group settings
with text retained. A fully docked Gboard now resizes the activity rather than
panning its header off-screen; scrolling reaches the composer and its actions
above the keyboard. Native checks also verify the bottom-tab draft lock, unlock
after Clear draft and a group-name save persisted by the real portal. Setup-link
and import deferral is compiled but not interactively verified. Both normal HTTPS
debug APKs are restored, sign-out survives relaunch, temporary port forwarding is
removed and all three fixture users, their workspace/customer and audit records
are confirmed deleted; the original demo is unchanged. Dark mode, native
notification interruption and physical devices remain unverified.

## Managed meetings

Open **Meeting** from a managed conversation. The native screen implements
current/start/join/retry/leave, incoming audio and camera/screen rendering,
SDK participant/publication rows and confirmed host end/removal. Your other
devices have no Remove action. The existing authenticated conversation transport
validates the exact customer/device/user, conversation, room/session and bounded
metadata/grant expiry. Grants remain in memory and never enter the managed vault.
Known conversation access loss invalidates an open screen even if account status
is otherwise unchanged. Join starts with microphone/camera off and audio
prewarming disabled; enabling capture needs explicit Android permission.

Phone and meeting audio are mutually exclusive, including pending Telecom/audio
cleanup. Leave stops local capture/output, cancels and waits for pending SDK work,
then withdraws the exact session before releasing phone audio. Late HTTP or
permission results cannot restore departed media. The current meeting screen is
foreground-only: stopping the activity stops media, and rejoin is explicit.
Meeting Core-Telecom/foreground-service ownership, native screen publishing,
device choices and seamless phone handoff remain pending. See
[Meetings](../docs/MEETINGS.md) for the API, server settings and acceptance limits.
No additional app key is required.

The pinned SDK is `io.livekit:livekit-android:2.29.0`, with WebRTC 144.7559.14 and
UniFFI 0.1.12. JitPack is restricted to the SDK's exact AudioSwitch dependency;
other modules use the existing repositories. SDK/WebRTC/AudioSwitch/JNA licence
texts ship under `assets/Licenses`; the full binary notice inventory remains a
release audit item.

The 1 October meeting build passes Debug/test and unsigned Release APK/AAB
assembly, all ten JVM tests and lint with zero errors (16 warnings). All 34
managed-client cases pass on SipperUIQA, including exact retries/withdrawal,
non-persistence, poisoned grants/metadata, expiry, phone-audio refusal and late
access loss. Both Release packages contain 14 native libraries across arm64 and
x86_64 with 16 KiB-compatible ELF load alignment; APK zip alignment also passes.
These counts supersede the earlier packaging/test snapshots above.

Computer use checked portrait entry, recoverable failure, disabled service/phone
states, host confirmation/cancel and Close with a separate fictional fixture
app, no SIP accounts and no working media service. No capture permission was
granted. The fixture app/source are removed and the normal debug/test packages
restored. Real SDK media, capture, landscape/dark-mode meeting layout, background/
lock-screen operation and physical-device acceptance remain unverified.

## Managed incoming-call notifications

The app includes Firebase Messaging and a bounded WorkManager wake job. Configure
the four public Firebase client identifiers in `.env.example` before building;
leave all four blank for a build that does not initialise Firebase. The portal's
server-only FCM service account must use the same project and exact Android package.
The debug and release packages are different Firebase apps. No service-account
private key belongs in the APK. This integration uses FCM registration tokens;
Firebase's newer installation-ID addressing mode is explicitly disabled to match
the server's HTTP v1 token contract.

Tokens are sent to authenticated, enrolled devices with usable managed gateway
accounts. Rotation updates every eligible organisation; a revoked organisation
cannot prevent another one receiving the new token. Direct SIP accounts do not
upload a token. Notification/microphone permission changes are checked when the
app resumes, and the Accounts screen has enable/permission actions. Signing out
withdraws managed access locally first and attempts remote device revocation.

A received push contains only the schema, device ID, call ID and ringing deadline.
Repeated hints share one work request. The worker rejects malformed/expired hints,
authenticates the call, refreshes that enrolled organisation's configuration and
renews SIP registration. It waits for the matching SIP offer and native Telecom
handoff. Caller details come from the authenticated API, never from the push.
API outages have bounded retries within the ringing deadline; cancellation and
another-device answers are checked again before presenting/answering the call.
High-priority messages request expedited work; Android may still defer it.

The provider keys are optional during development. A registered token or provider
acceptance does not prove the phone rang. Actual FCM delivery, locked/idle physical
devices, notification permissions across supported Android versions, and native
Telecom/audio behaviour remain release checks.

Direct SIP availability while Android suspends or terminates the app is not
guaranteed. Reliable background incoming calls require the managed gateway and
push integration.
This implementation does not claim a working locked-phone/background call path.

## Isolated native tests

Use a disposable Android emulator, not a real account or telephone system. The
engine checks use a null audio device and do not request microphone access.

From the repository root, start the loopback test registrar:

```sh
python3 tools/sip-test-server.py --bind 127.0.0.1 --advertise 10.0.2.2 \
  --port 5096 --tls-port 0 --user android-test:local-android-test \
  --answer-special --special-call-seconds 45
```

In another terminal:

```sh
cd android
ANDROID_SERIAL=your-emulator-serial ./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.sipperRegistrar=10.0.2.2
```

`10.0.2.2` is the emulator's host-loopback alias. The explicit argument enables the
real SIP test; without it that test is skipped. The other checks cover encrypted
storage/tamper rejection and native startup with Opus/system trust. Startup is not
proof of an authenticated TLS connection to a provider. The SIP fixture uses PCMU
SDP and sends no RTP, so it proves signalling and expiry boundaries, not Opus media
interoperability or two-way audio. Test reports are under
`app/build/reports/androidTests/connected/debug/`.

The last full arm64 Android 16 baseline run passed 36 checks without skips: thirteen engine/storage/
network checks, 22 managed-client checks and one worker check. The direct transfer
case covers successful/rejected REFER/NOTIFY status, attended Replaces,
local leg cleanup, cross-account rejection, duplicate requests and withdrawn access;
the existing lease-expiry check also rejects transfers. The separate gateway run
verifies actual encrypted media handoff. The new consultation regression uses the
real PhoneModel and Core-Telecom to check draft cancellation, failed dial,
confirmed hold before consultation, remote hold rejection, attended transfer,
stale source rejection and cleanup. Hold state follows negotiated media rather
than the requested button state. Hold/resume waits for SIP acceptance and actual
media, including inactive media when both participants hold. Four-second timeouts
leave unresolved transactions fenced until their final result or hang-up; hang-up
remains responsive. App dial/answer/resume holds existing calls first and serialises
concurrent audio changes. A network-startup regression ensures the initial route
does not trigger SIP recovery. Third-party PBX compatibility remains unverified.
The latest 45-case run passed 44 checks; the consultation case stopped at its
microphone-permission prerequisite before making a call. On a dedicated test
emulator, allow microphone access through Android's app-permission screen before
running that Core-Telecom case. Its SIP engine uses null audio; the permission is
required by the normal app admission path. Permission approval and the completed
consultation result remain pending.
UDP and TCP recovery retain established calls, keep withdrawn accounts unregistered,
restore authorised access and preserve permanent credential failures. Offline
push registration is rejected. The eight JVM validation/call-state/push-payload/setup/
directory checks also pass. Both APKs include arm64-v8a and x86_64
native libraries. Debug/release builds and debug lint pass, with zero errors,
16 warnings and two hints for dependency, target-version and Kotlin suggestions.
The unsigned release APK passes 16 KB ZIP alignment. Only arm64
runtime behaviour has been tested. `:app:assembleRelease` produces
`app/build/outputs/apk/release/app-release-unsigned.apk`; this is not a distributable
signed release.

Earlier computer use on SipperUIQA verified Add call, Return, Android's Back gesture,
hold when the second call connected, and attended transfer from the sheet.
An ongoing notification opens CallActivity; Add call returns to the main keypad.
Call controls and the draft were reviewed in portrait light/dark mode, and the dark
landscape keypad scrolls through its final controls. This used a temporary null-audio
build, fictional encrypted accounts and a loopback SIP fixture with simulated REFER
success. The fixture source, account/history and temporary audio override were
removed. It does not prove physical audio, locked-phone handoff or real push.


Recents saves the original account, managed device ownership and dialling target
separately from the display name in the encrypted history. Callback rechecks that
account after microphone permission, without selecting a replacement account.
Removed, disabled or expired accounts cannot be called from history. Managed
incoming numbers come from the authenticated call API, never the gateway's SIP
display name. Older records without a saved target remain visible with callback
unavailable. The storage and validation checks cover these cases.

For the complete baseline, also start the separate Do Not Disturb registrar:

```sh
python3 tools/sip-test-server.py --bind 127.0.0.1 --advertise 10.0.2.2 \
  --port 5098 --tls-port 0 --domain sipper.test \
  --user dnd-user:fictional-dnd --user dnd-peer:fictional-dnd \
  --answer-special --special-call-seconds 120
```

Add `-Pandroid.testInstrumentationRunnerArguments.dndRegistrar=10.0.2.2` to the
Gradle invocation, and select the baseline classes with
`-Pandroid.testInstrumentationRunnerArguments.class=com.hybes.sipper.EngineTest,com.hybes.sipper.ManagedClientTest,com.hybes.sipper.PushWorkTest`.
The gateway test has its own harness below.

The 28 managed-client checks exercise the actual AppAuth code exchange and
refresh against an isolated HTTP fixture, device/configuration binding, encrypted
reload, accurate engine acknowledgements, rejection of unsolicited callbacks,
suspension, revocation, offline expiry, sign-out races and device-bound incoming-call
API snapshots/actions, push token rotation across organisations, denied-device
isolation and authenticated wake/sign-out races, setup links and company-directory
paging/restarts, cache binding/expiry, secure-save failure and late withdrawal
responses, quiet browser cancellation and visible provider failures. Shared-status
checks cover exact bindings, paired nullable values, expiry, non-persistence and
late sign-out. Four further messaging checks cover retries, privacy, poisoned replies,
full Unicode pages and access withdrawal. All 28 pass on the disposable Android 16 emulator. Run only those checks with
`-Pandroid.testInstrumentationRunnerArguments.class=com.hybes.sipper.ManagedClientTest`.
These are protocol checks with fictional identities. They do not prove an interactive
browser-to-app callback or authentication against a deployed portal.

Accounts keeps sign-in progress and cancellation visible, and links to the portal
when an invitation needs accepting. Cancelling browser sign-in preserves any
existing managed identity and connections without showing an error. Provider
failures remain visible. The signed-out Accounts and keypad screens, empty
directory and its return to Accounts were reviewed interactively in portrait
light mode on Android 16. Populated Recents also passes portrait and landscape light-mode review, including long names, unavailable targets/accounts and scrolling. Horizontal safe-drawing insets keep content clear of landscape camera cut-outs. The callback button-to-call permission flow remains unverified. The ordinary-user local browser handoff is now checked separately; populated directories,
confirmation dialogs, dark mode and physical-device review remain release checks.

The Android 16 Chrome custom tab was opened against the local portal on
28 September. Closing it returned to Accounts, cleared pending progress and
re-enabled Sign in without an error. Chrome setup completed with optional usage
reporting off. A stale local preview process was serving a removed JavaScript
bundle; restarting the current build restored successful page and bundle
responses. At that stage, successful login, MFA, the native callback and populated directory
calling were unverified: computer use could not reliably target the embedded
emulator, and the standalone emulator was unavailable to that tool. The temporary
customer, pending session, null-audio override and routing were removed; the normal
debug APK was rebuilt and reinstalled, test permissions revoked and emulator stopped.

The separate `GatewayTest` runs only through the optional Android stage of
`portal/scripts/gateway-smoke.ts`; see `../gateway/README.md`. It uses the real
portal provisioning code, a disposable TLS/SHA-256 Asterisk gateway and a G.711
test PBX. It rejects an untrusted CA, registers with the explicitly trusted fixture
CA, negotiates Opus/SRTP/ICE and checks packet flow on outgoing and incoming calls.
Three consecutive network recoveries and a fourth after managed expiry each
require a fresh SDP offer, successful negotiation and ICE, and advancing encrypted
packets in both directions on the same call. The expired account sends no
positive-lifetime registration and new calls are denied. It
also exercises authenticated caller lookup, one-device answer claims, caller
cancellation, per-device decline, another-device answers and cleanup after a failed
answer action. The OAuth provider is a loopback protocol fixture; provisioning and
call requests use the real portal service functions and isolated database. The
test waits for completed ICE negotiation as well as two-way RTP packet counters,
and requires the gateway to clear the prior call before starting another. SIP
uses loopback TCP 25061 with explicit signalling NAT, independently of media's
emulator host alias. A call disappearing from the app alone is insufficient.
The push-wake phase injects the exact opaque payload after withdrawing Android's
SIP account, and checks authenticated wake, renewed registration, incoming media
and rejection of a duplicate hint after hangup. It bypasses Firebase transport and
WorkManager scheduling; those are separate checks. `PushWorkTest` exercises actual
expedited WorkManager jobs for expired/malformed payloads without starting calling.
The final phases use the real `CallBridge` and Android Core-Telecom: outgoing and
incoming calls, app answer/hold/hangup, private notification/public-title redaction,
remote cancellation and refusal to answer an ended call. They assert that call
notifications disappear after hangup and cancellation, ringing notifications have a
full-screen intent and ringtone audio attributes, and answered/outgoing notifications
use the silent ongoing channel without an insistent alert or full-screen intent.
The sixteen-phase run also exercises actual blind and attended gateway transfers
through native PJSIP, after waiting for hold negotiation. Invalid targets, expired
authority, overlapping requests and stale calls are rejected. A rejected destination
leaves the original call and encrypted packets intact. After successful transfers,
both local calls, Core-Telecom sessions and notifications end; the companion requires
exactly two remote legs in the continuing bridge, TLS/SRTP, cleared hold and increasing
packet counters in both directions, followed by complete remote hangup reporting.
The disposable PBX supplies an echo extension and generated tone. Transfer-sheet
interaction, physical audio and third-party PBX interoperability remain unverified.
Three rapid hold/resume cycles
must restore increasing encrypted media packet counters. Hold changes are serialised
per call and retry only PJSIP’s in-progress SDP-offer error, for at most four seconds;
expiry reports an error instead of silently cancelling the action. This catches foreground
service rejection and endpoint/mute collectors that otherwise survive disconnect.
Allow microphone and notification access for Sipper through Android Settings on
the dedicated SipperUIQA emulator before this gateway check. The harness checks
those prerequisites without changing permissions; call audio uses the null device.
These checks do not exercise notification buttons, lock-screen/system UI, concurrent
call notification switching, interactive sign-in or FCM delivery. The CA override requires
a debug build, null audio and an engine that has not started; release builds use
system trust only. The test produces synthetic silence and does not prove audible
quality, microphone/speaker routing, Bluetooth or physical-network behaviour.

### Native conference check

The existing gateway rehearsal also has an explicit SIP/mixer-only mode:

```sh
cd portal
SIPPER_ANDROID_SERIAL=emulator-5556 SIPPER_ANDROID_NATIVE_CONFERENCE=1 pnpm test:gateway
```

Use the existing disposable `SipperUIQA` emulator; build the debug/test APKs first.
This selects only `GatewayTest#nativeConferenceForwardsEncryptedRemoteAudioAndClearsItOnSplit`.
The local PBX generates a remote tone, which Sipper forwards to the other remote
party and receives back through its echo extension. Local audio is silent and
muted. The check requires advancing Opus/SRTP/ICE packets, shared hold/resume,
forwarding removal on split and participant departure, and complete gateway cleanup.
It does not instantiate Core-Telecom or use microphone/notification access, OAuth
or push. The full gateway mode keeps its normal permission prerequisites.

`EngineTest#conferencesUseExactParticipantsConfirmHoldAndKeepUnrelatedCalls` uses
the separate fictional Do Not Disturb registrar to check stale group/participant
actions, unavailable/cross-account merges, rejected and late hold changes,
cancellation, hangup responsiveness and established-call continuity after managed
withdrawal. That registrar supplies signalling only; it does not advertise keypad
tones or generate RTP. Valid participant DTMF is checked by the encrypted gateway.
The existing consultation/Telecom test now also checks one system conference
session, safe separation, shared mute retention and stale notification rejection;
it still requires actual QA microphone consent and is not part of the native-only mode.

## Managed development

Debug builds accept `SIPPER_MANAGED_URL` at build time; see `.env.example`. The portal
and app must use exactly the same origin, because OAuth resource identifiers bind
the token to that API. For a host-local portal, Android's standard `adb reverse`
development routing can expose the host port at the same emulator localhost port.
Production release builds have no HTTP exception and always use `https://sipper.dev`.
The debug callback is `com.hybes.sipper.development:/oauth/callback`; add it only to
the local portal's `SIPPER_NATIVE_REDIRECTS` and reseed native clients. The release
callback is `com.hybes.sipper:/oauth/callback`. No client secret belongs in the app.

Before release: verify interactive managed sign-in against the real local portal,
complete FCM/gateway wake handling, visual review, Telecom race/error-path coverage,
Bluetooth and physical call tests, then signed distribution and store/licensing
review. Simulated same-family network events pass; real Wi-Fi/mobile transitions,
IPv4/IPv6 family changes and audio continuity still require implementation review
and physical-device evidence.

## Real local portal acceptance

With the development PostgreSQL/Mailpit services running and the native libraries
built, start the dedicated **SipperUIQA** emulator and run:

```sh
cd android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
cd ../portal
pnpm build
SIPPER_ANDROID_SERIAL=emulator-5554 pnpm test:android-portal
```

Wait for the emulator to finish booting first. The harness checks `SipperUIQA`
through both the emulator console and ADB, so another emulator sharing its default
port cannot receive the test APK. Use a separate port pair if BlueStacks is running. If the guest stops answering
ADB or system apps report startup ANRs, cold-boot it without a snapshot and allow
at least 4 GB RAM for the test session; the status acceptance passed with
`-no-snapshot -memory 4096 -cores 4`.

Use the emulator serial from `adb devices`. The harness checks its AVD name and
rejects physical devices. It creates and drops its own database using the local
test database connection, starts a separate built portal and fictional SIP server,
and removes its reverse mapping and private app fixtures. It installs the standard
debug/test APKs but does not change personal accounts, microphone permissions or
the normal management origin. Test mail stays in local Mailpit.

The Android 16 run passes real AppAuth PKCE code exchange, verified email/MFA
authorisation, provisioning, SIP registration, encrypted session/contact restoration,
directory search and calling, voluntary shared status/activity followed by independent opt-out, and
server-observed registration/IP/login/request activity. Suspension withdraws managed settings and contacts while preserving a
fictional personal registration and an established call. Resumption, disconnect,
server device revocation and durable sign-out also pass. The companion completes
browser authorisation over HTTP and delivers the resulting callback to AppAuth;
this does not exercise browser gestures or Android intent routing. Calling uses
null audio and the SIP engine directly, so it does not prove Telecom UI, audible
media, push or a physical phone. Output is in `/tmp/sipper-android-portal-test.log`.
