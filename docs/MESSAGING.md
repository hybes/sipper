# Managed text messaging

The shared service and portal messaging view are implemented locally. Open
**Account → Messages**, choose a customer, then start a conversation with active
licensed colleagues. One-to-one conversations are shared between the two users;
named groups support up to 20 people, with a participant owner who can manage the name and roster. Read state belongs to the
user across devices. Browser polling runs every five seconds while visible.

## Access and data

Every request requires verified identity, active customer membership and a
current user licence. Native requests also require an owned, enrolled, unrevoked
device. Participants alone can access a conversation. Workspace staff and the
platform owner receive no automatic access to other people's message content.
The recipient picker exposes names and user IDs, without email addresses, IPs,
SIP details, caller identities or standalone-app data.

Suspension, licence loss or device revocation blocks that access immediately at
the API. Membership removal also removes conversation participation. Remaining
group participants retain their own history. Sending requires at least one
other currently eligible participant. There is no email or call-push fallback.

Bodies use the existing AES-256-GCM envelope and encryption keys, bound to the
customer, conversation and client message UUID. They are decrypted by the server
for authorised participants: this is not end-to-end encryption. Message bodies
are not written to the audit log. Browser history exists only in memory; drafts
are not saved to browser storage.

## Shared API

Browser prefix: `/api/platform/me/messages/<customer-id>` with a verified session.
Writes require the existing same-origin JSON boundary. Native prefix:
`/api/client/devices/<device-id>/messages` with the existing native bearer token.
The device determines the customer. Successful native requests record the safe
`messages` action in device activity.

| Method and suffix | Behaviour |
|---|---|
| `GET /people?q=<name>&after=<cursor>` | Active licensed colleagues, excluding the caller; up to 100 names per page |
| `GET /conversations?after=<cursor>` | Participant conversations, ordered by latest message sequence and ID; up to 100 per page |
| `POST /conversations` | `{id: UUID, userIds: [...], title?: string}`; choose 1–19 other people; a group needs a name |
| `GET /conversations/<id>` | Latest 100 retained messages, in ascending sequence order |
| `GET /conversations/<id>?before=<sequence>` | Earlier page, still returned in ascending order |
| `GET /conversations/<id>?after=<sequence>` | Incremental later page, in ascending order |
| `POST /conversations/<id>` | `{id: UUID, text: string}`; send plain text |
| `PUT /conversations/<id>/group` | `{revision: string, title: string, userIds: [...], ownerId: string}`; owner changes the full group state |
| `POST /conversations/<id>/leave` | Leave a group; the exact retry is harmless and ownership passes to a remaining participant |
| `POST /conversations/<id>/read` | `{sequence: string}`; monotonically advance the user's read marker |

Responses include `schemaVersion: 1`, exact customer/user/device bindings,
`expiresAt` and `retentionDays`. Browser responses have `deviceId: null`. Clients
must reject a mismatched scope and clear each snapshot at its own expiry, within
30 seconds. Refreshing metadata cannot extend an older message-body snapshot.
Changing customer, signing out or losing access also clears it.

`nextCursor: null` ends a page. Conversation and people cursors are opaque to
clients. Message sequences are decimal strings backed by PostgreSQL bigint;
do not convert them to JavaScript numbers or assume they are contiguous. A
message-history cursor or read marker must identify an actual retained message
in that conversation. An expired history cursor returns 409; load the latest
page again. Do not combine `before` and `after`.

Keep the same UUID and exact text when retrying an unconfirmed send. A successful
retry returns the original sequence without another message or rate-limit
charge. Reusing it for another sender, conversation or text returns a conflict.
Direct-conversation creation reuses the existing pair within that customer;
group creation uses its UUID and exact roster/title for retries.

Limits are 4,096 text characters, 60 sends per minute and 30 new conversations per
hour per user/customer. Whitespace-only bodies and invalid control characters
are rejected; line breaks and tabs are accepted. Markup remains literal text.
Group changes require the current owner and a matching revision. Exact retries
return the saved state without another revision, including a transferred owner's
lost response. Conflicting edits return 409 and need a reload. The owner stays
in the group until using Leave group; new members and a replacement owner must
be active licensed customer members. People joining or rejoining see only
messages with a sequence after their joining watermark. Older bodies, history
cursors, read markers and old-send retries are unavailable to them. Remaining
participants retain their own history. Customer membership removal also removes
participation and advances the group revision; ownership passes to a remaining
participant if needed. Administration does not grant content access. One-to-one
conversations cannot be left; reopening a pair after membership removal respects
the same joining-history boundary. Attachments and message moderation are not
implemented.

## Deployment and retention

Apply migrations `032-messages.sql`, `033-message-groups.sql` and
`034-message-push.sql` before upgrading the portal and workers.
Foreground messaging needs no provider key or new dependency. Set
`SIPPER_MESSAGE_RETENTION_DAYS` to an integer from 1 to 3650; 90 is the development
default. Agree the commercial retention and privacy policy before launch.
Reads immediately exclude expired bodies. The existing email worker, started by
`pnpm worker`, removes at most 1,000 expired rows per minute. Conversation metadata
and membership/read markers remain. Increase cleanup throughput if measured
expired traffic exceeds this ceiling; the expiry rule does not depend on cleanup.

Backups have separate retention. Keep old encryption key IDs while retained
messages or recoverable backups need them, and escrow keys separately. Database
ciphertext without the corresponding key cannot be restored into readable
messages. The existing recovery hold and access/billing reconciliation apply.

## Mobile message notifications

iOS and Android have a separate, default-off message notification setting. They
use normal APNs/FCM alerts and their own encrypted endpoint registry, never a
VoIP/CallKit token or an incoming-call wake. A licensed mobile enrolment is enough;
messages do not require a gateway or SIP account. Microphone permission is not
needed for message alerts.

Native-only `PUT /push` under the messaging prefix registers `{token: string}`;
`DELETE /push` removes the owned device's message token. iOS supplies its normal
APNs token as hex; Android supplies its FCM token. Replies identify the exact
device and acknowledgement. Rotation, invalid-token replies and worker results
are fenced by token revision and job lease. Device revocation deletes both token
registries. Tokens remain outside the clients' saved managed-session data.

A new message queues notices for the other users' eligible mobile devices. Exact
send retries do not queue duplicates. Before delivery, the worker rechecks current
membership, licence, enrolment, group joining watermark and shared read marker.
Read, expired, withdrawn and superseded messages are skipped. Notices expire five
minutes after sending and retry at most four times; both providers collapse to
one generic Sipper message notice. Completed jobs erase their reference payload.

The notification reads **Sipper / New message**. Provider data contains only
`schemaVersion: 1`, `type: "message"`, device/conversation UUIDs and `expiresAt`.
No body, sender/customer name, email, phone number or SIP detail is sent. Tapping
an old notice can navigate, but current authenticated HTTP supplies access and
content. iOS refreshes customer access on a cold tap; both clients require a
currently owned, licensed connection. They clear their delivered generic notices
on known access loss or opt-out. A provider request already in flight cannot be
recalled, so a generic stale notice may still arrive.

Run the existing push worker. Apple needs the normal app bundle ID in
`SIPPER_APNS_MESSAGE_TOPIC`, without `.voip`, alongside the existing key/team and
matching sandbox setting. Android reuses the existing Firebase client settings
and server FCM service account. See the blank, detailed examples in
`portal/.env.example`, `ios/.env.example` and `android/.env.example`. Service status
separates call/message queues and endpoint totals; provider acceptance is not
evidence of display. Restores erase message tokens and cancel queued notices;
the recovery hold cannot be released while any message endpoint remains.

Provider contracts follow [Apple's APNs request documentation](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
and [FCM HTTP v1](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages).
FCM handles background notification display and passes routing data to the
launcher on tap; foreground notices use the Messages channel. See
[Android receipt behaviour](https://firebase.google.com/docs/cloud-messaging/android/receive-messages).
Real delivery, permission/tap UI, locked physical devices and production operation
remain unverified.

## Desktop message notifications

Mac and Windows have a separate, default-off **Notify me about managed messages**
setting under Managed settings. They reuse the authenticated client while Sipper
is running, including a hidden window. No new provider key or service is needed;
quitting the app stops polling. Mac requests normal notification permission when
the user enables the setting. The operating system's notification settings apply.

Native-only `GET /alerts?after=0` under the messaging prefix returns the common
owned-device scope, `alerts` and `nextCursor`. Each alert contains only
`conversationId`, a decimal-string `sequence` and `expiresAt`. The server selects
the latest unread, non-self message per conversation, checks current licence,
membership, device ownership and joining/read watermarks, and never decrypts a
body. An alert expires five minutes after creation and is omitted when it cannot
stay fresh for the whole 30-second response scope. No SIP account is required.

Each customer scan returns at most 100 references per five-second tick. Decimal
cursors retain bigint ordering. After the last page, the scan restarts at zero
to catch messages whose transactions committed late; per-conversation sequence
deduplication stays in memory and expires with the references. Very large active
conversation lists can delay alerts; this bounded polling has not been load-tested.

Both clients collapse to one generic **Sipper / New message** notice. No message
text, names, addresses or SIP detail enter it. Mac carries the same opaque hint
used on iOS; Windows keeps its routing hint in the main process. Clicking refreshes
authenticated customer access before opening the conversation, whose HTTP API
still authorises every body. Opt-out, sign-out, shutdown and observed access loss
clear local notices and fence pending polls. Mac also rechecks foreground display.
A notice already handed to the operating system can still arrive.

Opening an alert keeps the current message view mounted. All four clients
defer its customer/conversation change while a draft, uncertain send or dialogue
is open; sending, clearing/discarding the draft or closing the dialogue releases
the queued navigation. An uncertain send retains its original ID and text.

Apple's customer picker, conversation list, iOS conversation-back button and
new-conversation button use the same draft/dialogue lock. Clear draft explicitly
releases an ordinary draft; access denial and sign-out remove it. Opening and
closing group settings retains the current conversation's draft.
The shared Apple view also hides iOS's native Messages back button while locked
and reports its lock to the main tab selection. Validated setup links and import
reviews defer account navigation until the lock releases and any calls finish;
cancelling an import clears its queued navigation. Native account regressions
cover tab rejection, link validation, import deferral/cancellation and call
priority with synthetic call observations. Interactive iOS acceptance is still
unverified because computer use cannot read Device Hub's running window.

Android's customer picker, Conversations and message-view Directory button use
the same lock. Clear draft releases ordinary unsent text, and cancelling group
settings retains it. The app's bottom navigation also waits for the lock, as do
incoming setup links and account imports. Calls still take priority, and stopping
the activity destroys this in-memory view.

Brief system interruptions also retain the open editor: Android keeps it while
the activity is STARTED, and Apple keeps group settings while the scene is
inactive. Received pages still clear and reads/polling require an active app.
Android destroys this in-memory view when the activity stops; Apple closes group
settings on backgrounding and clears drafts when the message view disappears.

The shared SDK, server and Windows controller checks cover scope validation,
numeric pagination, expiry, deduplication and late withdrawal. Real local portal
acceptance verifies the Apple feed and Windows polling/click boundary without
sending OS notices. Computer use reviews both desktop settings with empty test
profiles and verifies Windows tab scrolling/keyboard access on macOS. The actual
Windows renderer, with a fictional service/notification boundary, also preserves
drafts across same-customer and cross-customer hints, sends before changing
customer and retries an accepted-but-unconfirmed message without duplication.
New-conversation and group dialogues lock customer selection. Computer use also
verifies the shared native Apple message view on Mac with fictional in-memory
HTTP: manual conversation switching keeps a draft, same-customer alerts wait for
Clear draft, group settings retain text, and a cross-customer alert waits for an
accepted-but-unconfirmed send to be retried with the same ID/text. Two attempts
store one message in its original customer/conversation. Denial clears a draft;
recovery does not restore it, and sign-out removes the message view. This isolated
component check does not exercise a real login, Keychain or PBX. Actual
notification permission, delivery and click interaction, signed-in Mac routing,
iOS draft navigation, packaged Windows/DPAPI and production load remain
unverified interactively.

## Apple apps

Mac exposes Messages in its sidebar (⌘4); iOS exposes it from Directory. Sign in
and connect a licensed customer through Managed settings or Accounts first.
Both use the shared Apple SDK and the device-bound bearer API. History and
conversation metadata have independent 30-second expiry, with five-second
foreground polling. Backgrounding, customer changes and lost access clear
visible snapshots. Drafts and unconfirmed-send UUIDs remain in memory only;
there is no Keychain or filesystem message archive.

The SDK supports group rename/roster/owner changes and leaving, plus paged colleagues/conversations, direct/groups, before/after
history cursors, exact send retries and read markers. It rejects malformed or
mismatched responses and rechecks observed membership after network completion.
Client-generated UUIDs are canonicalised to lowercase by the server before
binding ciphertext, so Apple's uppercase encoding and lowercase retries address
the same message. The text ceiling is 4,096 UTF-16 code units.

## Local acceptance and remaining work

`pnpm test` includes validation, customer/participant/access isolation, device
revocation, exact retries, concurrent ordering, cross-device reads, pagination,
ciphertext tampering, quotas and expiry/cleanup checks in the isolated test DB.

For real HTTP acceptance, run the built loopback development portal with local
PostgreSQL/Mailpit and explicitly enabled test billing, then run
`pnpm test:messages-http`. It creates verified fictional users, checks real
session/MFA, origin/JSON/cache boundaries and messaging, then removes its records.
Optional `SIPPER_MESSAGE_UI_QA=1 node --env-file-if-exists=.env --import tsx scripts/messages-http-smoke.ts` holds the fictional
fixture for browser QA. Its credentials stay in ignored private
`.data/messages-ui-fixture.json`; do not print or commit them. Interrupt the
process normally to remove the fixture. Run the held check directly: a package
runner can kill its child before signal-driven cleanup completes. Verify removal
of the private fixture and its exact QA IDs afterwards. It never uses a real PBX
or provider.

The Apple SDK has 37 passing checks, including native request validation,
response scope/expiry/sequence rejection, exact retries, non-persistence and late
withdrawal. `pnpm test:ios-portal` runs the SDK against an isolated built portal
and disposable simulator with fictional colleagues; consent is supplied through
HTTP, so that check does not establish browser or physical device behaviour.
The ten phases include native direct/group sends, exact retries, real peer
replies, shared read state, group lifecycle/history boundaries and access withdrawal. Mac computer use has also
verified normal browser sign-in, creation/sends and a received group reply
against the built portal. Its final relaunch is awaiting a Keychain prompt that
computer use cannot control; final native layout/offline/keyboard review remains.

Windows exposes Messages in its sidebar (Ctrl+4). OAuth and validation stay in
the main process; six explicit IPC services return only validated pages and safe
error codes. Input/scope/expiry/roster validation, ordered Int64 decimal sequences,
exact send results and withdrawal checks pass 107 Node tests. The main process
accepts at most 2 MiB per message response, allowing a valid 100-row Unicode page
while retaining the smaller existing limit for other APIs. Message data never
enters its encrypted session archive or global renderer state.

`pnpm test:windows-portal` passes ten real portal phases with fictional colleagues,
including direct/group sends, retries without duplicates, peer replies, shared
read state and device activity/IP projection. Native storage and consent are
supplied test boundaries on macOS. The actual renderer/main-process client also
passes browser component acceptance with an in-memory service at normal and
820×540 window sizes: paging/search/groups, literal text, an uncertain-send retry,
independent expiry during partial/whole outages and recovery. That bridge does
not establish Electron IPC, Windows DPAPI/Schannel or packaged callbacks.

Android exposes Messages from Directory, using the same enrolled device and
AppAuth session. Bodies, drafts and retry IDs have no vault or saved-state archive;
stopping the activity removes the message view. A brief pause retains its draft
and open editor, clears received pages and suspends polling. Each resource has its own bounded
expiry/polling. Small screens and an open keyboard use scrolling so the composer
can remain reachable. The client caps message responses at 2,000,000 bytes and
validates scope, rosters, cursors, ordered decimal sequences and exact sends.
All 30 managed-client emulator checks pass. The real ten-stage Android portal
acceptance also verifies native direct/group sends/retries, actual peer replies,
shared read state and withdrawal, with consent supplied through HTTP.
Separate Android computer use verifies ordinary-user Chrome sign-in, consent,
the actual native callback, customer connection, direct sending, group creation
and receipt of an authenticated colleague reply against the local portal. Portrait
and scrollable landscape light-mode screens pass; markup stays plain text. These
checks use three disposable users without SIP accounts. A further fresh native
sign-in and connection verifies that an ordinary draft locks customer,
conversation and Directory navigation, survives cancelling group settings and
can be explicitly cleared before conversation navigation resumes. Bottom tabs
also wait for the draft/editor; cancelling settings retains the draft and Clear
draft restores tab navigation. A fully docked Gboard resizes the activity, and
scrolling reaches the composer/actions above it. A native group-name save is
confirmed in the real portal database. Setup-link/import deferral is compiled but
not interactively verified. The three fixture users/workspace/audit records are
confirmed removed, the original demo is
unchanged, both default HTTPS debug APKs are restored and temporary port forwarding
is removed. Dark mode, native notification interruption and physical-device
acceptance remain unverified.
During a real local-preview outage, expired native history disappears while the
retry text/ID remain frozen. Recovery restores history; explicit retry creates one
message and clears the draft. Native disconnect and sign-out, including relaunch
with the normal build restored, also pass. The fixture and its audit records are
removed after the check.

Group settings reuse each platform's conversation picker. Only the owner can edit; participants can leave after confirmation. Uncertain edits retain the same revision and desired state for explicit retry.

Mobile and desktop message notifications are implemented locally; real provider/OS delivery,
remaining native visual/device acceptance and production
operation remain unfinished.
Polling and the bounded metadata queries have not been production load-tested.
No end-to-end encryption, federation or third-party messaging interoperability
is claimed.
