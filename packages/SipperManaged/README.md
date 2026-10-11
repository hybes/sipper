# Sipper managed Apple client

Shared Swift package for Mac and iOS. Uses AppAuth 3.0.0 for external-browser OAuth code/PKCE, refresh and state handling. Secrets and cached configuration use a separate, non-synchronising, device-only Keychain service. OAuth tokens are bound to the verified identity before the session is stored; switching identities requires signing out.

The configuration contract validates schema, organisation, device, revision, expiry and SIP settings. Gateway configurations additionally require TLS and mandatory SRTP. Only unexpired configuration belonging to the current identity and a current local enrolment can be restored. Network errors do not extend its lifetime. A server-side denial must remove the local account and cache; the native coordinators implement that behaviour. Direct SIP credentials reach the device, and immediate upstream revocation still requires PBX enforcement.

```sh
cd packages/SipperManaged
swift test
```

Tests use in-memory storage and intercepted network fixtures, with no real accounts or Keychain access. They cover identity binding, failed sign-in rollback, secure server addresses, configuration validation, gateway encryption requirements, call status/wake/answer/decline, push-token rotation/removal, unknown-device rejection, competing answers, directory pagination/cache/withdrawal and late responses after disconnect. They do not prove provider login, Apple delivery or physical mobile calling.

`setAvailability(_:organisationID:)` accepts Available, Away, Busy or Not set for the signed-in user's active customer membership. It shares the existing calling-preference endpoint with Do Not Disturb; sparse writes do not alter the other preference or calling configuration. The status persists on the server until changed or cleared. Missing values, failed refreshes and uncertain writes are displayed as unavailable, never inferred from cached registration. Deploy portal migration 029 before updated clients; no new credentials are required.

## Company directory

`directory(for:)` loads and verifies a complete customer/device-bound revision before saving or publishing it. `directories` exposes snapshots for the shared SwiftUI `ManagedDirectoryView`; hosts call `expireDirectories()` from their existing expiry loop. `forgetConfiguration`, disconnect, sign-out and observed membership withdrawal also remove directory authority. `directoryNumber` rechecks a selected contact at call time, while the host must require a matching, enabled, unexpired calling account. Directory fetches are independent of incoming-call restoration. See [the directory contract](../../docs/COMPANY-DIRECTORY.md) for paging, the local size ceiling and remaining app verification.

`directoryStatus(contactIDs:for:)` requests only current contacts from an enrolled
directory revision. It verifies exact device/customer/contact binding, paired
nullable preferences, optional strictly typed call activity and a bounded expiry, then returns an in-memory observation
capped at 30 seconds. It never archives status. The shared view refreshes an
expanded contact every 20 seconds while the scene is active, clears on failure
or scene changes and expires independently of a stalled request. Sharing consent
is managed in the portal; migrations 030/031 are required. Activity has separate
default-off consent, carries its app/gateway source, and expires no later than
three minutes after observation. Missing activity from older servers remains valid.
The SDK suite now has 40
passing checks, including malformed replies, denied access, non-persistence and
late withdrawal. Native screen acceptance remains separate.

## Managed meetings

`currentMeeting`, `startMeeting`, `meetingDetails`, `joinMeeting`, `leaveMeeting`,
`endMeeting` and `removeMeetingPerson` share the existing authenticated conversation
request path. Start/join take caller-owned UUIDs for exact retries. Scope, expiry,
room/session identities, signalling origin and media privileges are checked; the
proxy/SFU performs signature verification. Metadata and grants remain in memory,
never in the Keychain archive. Known identity, device, customer or licence
withdrawal rejects delayed responses. Hosts cannot remove their own named user
across devices; Leave uses the exact session.

Deploy portal migration 036 and its current API. No additional Apple key is required. `ManagedMessagesView` opens the shared
`ManagedMeetingView` using pinned LiveKit Swift 2.17.0 (Xcode 16.3+). Hosts supply
`phoneBusy`, `claimMeetingAudio` and `releaseMeetingAudio`; claims are synchronous
and released only after pending capture/join cleanup. The native apps enforce
exclusive phone/meeting audio. Joining receives with capture off; explicit inputs
stop/unpublish when disabled, and late permission results cannot own another join.
Metadata expires independently of polling. The package’s 42 cases include pending
join cancellation, exact withdrawal, audio refusal and metadata expiry. Mac screen
states were reviewed with fictional API replies; iPhone visual review, real SDK
media, screen publishing, background meeting CallKit and physical checks remain
pending. See [Managed meetings](../../docs/MEETINGS.md).

## Managed messaging

`messagePeople`, `conversations`, `createConversation`, `conversationMessages`,
`sendMessage`, `markConversationRead`, `updateMessageGroup` and
`leaveMessageGroup` use the existing native bearer token and
owned enrolment. Each response verifies schema, customer/device/user, bounded
expiry, roster, plain text and decimal bigint sequences. Known withdrawn
membership is checked again after the request; late replies cannot restore
access. Message bodies are Decodable only and never saved to the Keychain.

`ManagedMessagesView` is shared by Mac (Messages sidebar, ⌘4) and iOS
(Directory → Messages). It supports direct/group conversations, colleague
search, conversation/history paging, unread counts and shared read state. It
polls every five seconds while active and clears each independently expired
snapshot, background history and withdrawn customer state. Unconfirmed sends
keep the exact UUID/text for explicit retry or discard; conversation creation
also keeps its original UUID/roster/title. Drafts stay in memory only.
Group owners can change the name, members and owner; participants can leave.
New or rejoining members see messages sent after they joined. Unconfirmed edits
retain the same revision and desired state for explicit retry. The ten-stage
real iOS portal check covers this lifecycle; the new controls need visual review.

Deploy portal migrations 032 and 033 and the updated API before these clients. The
existing email worker enforces ciphertext cleanup; no new provider or key is
required. There are no chat notifications or offline message archives. See
[Messaging](../../docs/MESSAGING.md) for access, retention and remaining platform
work. `pnpm test:ios-portal` in `portal/` exercises these SDK methods through real
local bearer HTTP with fictional colleagues and a disposable simulator/database;
it supplies the browser consent and is separate from interactive screen proof.

## Calling preferences

`ManagedOrganisation.doNotDisturb` is optional: `nil` means unavailable, never Off.
`setDoNotDisturb(_:organisationID:)` updates only the signed-in person’s active
customer membership and requires a matching server acknowledgement. It needs no
seat or enrolled device and grants neither. An older membership read cannot
overwrite a confirmed change; sign-out invalidates late replies. Failed reads and
uncertain writes clear the displayed preference until the next successful refresh.
Preferences are not restored from cached sessions. Mac and iOS expose this control
in their managed settings. It affects new gateway calls across devices, including
sleeping devices. Direct account configurations also carry `doNotDisturb`, which is
strictly decoded when present and retained in the protected configuration cache.
The shared Mac/iOS engine applies it on refresh before presenting a new incoming
call, without changing registration or already admitted calls. An absent field
preserves older-server behaviour. Offline direct accounts keep the cached policy
until configuration expiry; standalone calls keep their existing behaviour.

## Managed calls and iOS push

`call(_:for:action:)` addresses only an existing enrolment and verifies that the response has the requested call ID. The native caller must also match `configurationId` to the SIP account's managed binding before displaying caller details or answering. The iOS integration does this in `MobileManagedCalls`. An answer response is a reservation: require `claimedByThisDevice` and an available `answering`/`answered` state before accepting SIP. A competing claim produces `ManagedError.callUnavailable` without treating it as a configuration change.

`setVoIPPushToken(_:for:)` accepts the APNs token bytes for an iOS enrolment; pass `nil` to remove the token. It validates the server's provider acknowledgement. `IncomingManagedCall.parse(apns:)` accepts only the server's opaque `sipper` payload with a supported schema, device/call IDs and a ringing deadline no more than two minutes away. A hint cannot enrol a device, supply caller details or authorise an answer. These SDK methods do not register with PushKit or report a call to CallKit by themselves.

Disconnect removes local enrolment authority before awaiting the server, and late call/configuration replies cannot recreate it. Sign-out clears the in-memory session and attempts to remove stored authentication and configurations before best-effort remote device/token revocation. Remote cleanup has short timeouts and can fail offline; gateway enforcement and credential expiry still matter. A secure-storage removal failure is reported and must be retried; it is not a successful durable sign-out.

## Setup links

`ManagedSetupLink` validates the administrator's web link or `sipper://setup` URL against the client's existing server. `redeemSetupLink(_:)` posts only the reference through authenticated native access, verifies the returned identity and licensed customer, and returns that customer for ordinary enrolment. It cannot change servers, import SIP credentials or enrol on its own. Expired/revoked/used/wrong-account links produce an unavailable message; signing out invalidates an in-flight response. The Mac and iOS forms require an explicit Connect action. Local HTTP development also accepts `sipper-development://setup`; public HTTPS configuration rejects that scheme. The setup reference is never persisted by the SDK. See [the portal contract](../../portal/README.md#managed-setup-links).

## Direct-call activity

`ManagedDeviceReport.directCalls` carries per-account ringing, dialling, connected and held counts. Native integrations include it only when the engine confirms the current configuration was applied. It must cover each assigned direct account exactly once; exclude gateway/personal accounts and caller details. Current apps inspect observed state every one to five seconds and call `report(..., onlyIfChanged: true)`. The SDK serialises reports, deduplicates only successful positive acknowledgements, and spaces background attempts by at least five seconds. The ordinary report call still sends minute/manual heartbeats. Revision conflicts return `configurationChanged` so hosts refresh settings without treating it as access revocation. The portal expires observations after three minutes or marks them unconfirmed after an unapplied-configuration report. Deploy the updated report endpoint before updated clients.

## Native integration

- Client IDs: `sipper-macos` and `sipper-ios`.
- Callback: `com.hybes.sipper:/oauth/callback`; include its scheme in the app's URL types.
- Production origin: `https://sipper.dev`. Configure its matching native redirect URLs in the portal environment before deployment.
- Register each installation with its own stable ID; reconnecting after explicit disconnect creates a fresh installation.
- Store the SDK's `localProfileID` and derive local calling IDs within that profile. Do not identify managed accounts by SIP username/domain.
- Remove managed account configuration on disconnect/sign-out. Let established calls finish; reject new calls immediately and remove the engine account after its last call ends.
- Report each account's observed registration state separately. Configuration acknowledgement is not proof of successful SIP registration.

## Isolated Mac development

Debug builds accept `SIPPER_PROFILE_DIRECTORY=/absolute/temporary/path`. It selects a separate file store and Keychain namespaces. With that variable set, `SIPPER_MANAGED_SERVER=http://localhost:3100` selects the local portal. Release builds ignore both variables and require HTTPS. Never launch UI tests against a real account profile.

For UI automation, use the `SipperDevelopment` Xcode scheme and `Development` configuration. It produces `Sipper Development.app` with bundle ID `com.hybes.sipper.development`, a fixed temporary profile and separate Keychain namespaces even if a tool restarts it without environment variables. Its default portal is localhost:3100. Add the exact `com.hybes.sipper.development:/oauth/callback` redirect to the local portal's redirect list and rerun migrations. Never register this redirect in production. Querying an app's UI after quitting can relaunch it, so do not use a normally identified debug app for UI automation.

The normal Mac sign-in uses Apple's web authentication session. A user can cancel and choose the external-browser option if their browser does not open the system session. AppAuth retains the same PKCE and state checks in both paths. A pending sign-in also exposes its public authorisation link; it never includes the verifier, SIP password or access/refresh token.

The app test host uses a temporary store, in-memory personal password storage and an unstarted SIP engine. Managed Keychain access and its refresh loop only start during normal application launch.

AppAuth and the pinned LiveKit/UniFFI/WebRTC/nanopb upstream licence and notice texts ship as package resources and in both app licence directories. The release review must still complete the binary dependencies’ full third-party notice inventory; the framework archive supplies its top-level WebRTC notice only.
