# Company directory

The portal now stores and manages shared contacts for each customer organisation.
Mac, iOS, Windows and Android have directory views and protected local caches.
Personal address books remain separate. Full portal-to-app acceptance remains.

## Administration

Open **Directory** from a customer. Administrators with verified identity and MFA
can add, edit, search and remove contacts in that customer only. Each contact has
a name, optional company, and one to five labelled telephone numbers/extensions.
Formatting spaces, brackets, dots and hyphens are removed from numbers; SIP URIs,
URLs, control characters and duplicate numbers are rejected. Names and companies
are limited to 160 characters, labels to 32 and normalised numbers to 64 dialling
characters, optionally prefixed by `+`.

The admin API is `/api/platform/organisations/{organisationId}/directory`:

- `GET` lists a page; optional `q` searches names, companies and numbers literally.
- `POST` creates a contact using `{ name, company, numbers: [{ label, number }] }`.
- `PATCH /{contactId}` replaces those fields and requires the contact's integer
  `revision`. A competing edit returns `409 directory_changed`.
- `DELETE /{contactId}?revision={revision}` removes the matching revision only.
- `POST /import` accepts `{ entries: [contact, ...] }`, up to 100 rows, and returns
  one indexed result per row: `imported`, `skipped` or `invalid`.

Writes share the organisation's administration lock, recheck authority after the
lock, and audit actor/action/contact ID without copying names or phone numbers
into audit details. Every successful write rotates the directory's UUID revision.
Contact changes do not update SIP settings or their configuration revision.

## CSV import

Select **Import CSV** in the company directory. Download the template, select a
UTF-8 CSV file or paste its contents, then review the table before importing.
Use `name` and `number` headings, with optional `company` and `label`. Add
`number2,label2` through `number5,label5` for further numbers on the same contact.
A blank label defaults to Work. Quoted commas, escaped quotes, Windows line
endings and a UTF-8 BOM are supported. Unknown or repeated headings, malformed
quoting and inconsistent column counts stop the preview. Files are limited to
100 contact rows and 64 KB; if the resulting JSON exceeds the API's 64 KB limit,
split the import into smaller batches.

Each row uses the same validation and number normalisation as manual contact
entry. Invalid rows are excluded and can be corrected using **Edit invalid rows**;
successful rows are left out of that correction list. Results distinguish newly
imported contacts from contacts already present. Duplicate detection matches the
exact trimmed name, company and labelled normalised numbers, ignoring number
order and formatting. Changed names or labels are distinct contacts; use Edit to
update an existing contact.

Imports serialise with other directory writes under the customer's existing
administration lock. Repeating a committed import, including after a lost HTTP
response, skips matching contacts. No existing contact is overwritten. The batch
commits its valid rows together; a database failure rolls them back. Successful
batches rotate the directory revision once and audit only imported/skipped/invalid
counts. A batch that changes nothing preserves the revision. Imported contacts
use the existing customer-scoped native feed and cache rules below. No provider
credentials or new environment variables are required.

## Native feed

`GET /api/client/devices/{deviceId}/directory` uses the existing native bearer
token and `sipper:client` scope. The token must belong to the enrolled, unrevoked
device's user, with an active licensed membership and current subscription.
Browser cookies do not authorise this endpoint; native tokens cannot administer
contacts. The organisation comes from the device record, never from a supplied
customer ID. Successful reads appear as **Directory request** in device activity.

The response contains `organisation: { id, name }`, `deviceId`, a directory UUID
`revision`, `expiresAt`, `contacts` and `nextCursor`. Contact records contain only
`id`, `name`, `company`, `numbers`, integer `revision` and `updatedAt`.

Pages contain at most 100 contacts, ordered by case-insensitive name and UUID.
Continue with both `after={nextCursor}` and `revision={firstPage.revision}`;
retain the same search query. Revision and contact data share one database
snapshot. A changed directory returns 409, and an unavailable/foreign cursor
returns 404. The client must discard partial results and restart from the first
page rather than combining revisions. Responses use `Cache-Control: no-store`.

Directory cache validity uses `SIPPER_CONFIG_TTL_SECONDS`. A complete local
snapshot must use the **earliest** expiry from its pages, remain bound to the
authenticated identity, organisation and enrolment, and use protected local
storage. Clear it on expiry, sign-out, revocation or managed-access withdrawal.
An offline device cannot acknowledge removal immediately; it may retain the
previous authorised snapshot until expiry. Do not write shared contacts into a
personal/iCloud address book, and do not let a selected company contact silently
dial through another organisation's or a personal account.

## Apple apps

Mac users choose **Contacts → Company directory**; iOS has a **Directory** tab.
Select a connected customer, search by name/company/number and expand a contact
to call one of its labelled numbers. Only enabled, unexpired accounts belonging
to that customer and enrolment are offered. The app rechecks the contact and
account when calling; a removed account cannot fall back to a personal account.

Opening the view fetches a complete snapshot and refreshes it every minute while
visible. This runs independently of SIP restoration and incoming push handling.
Pages must agree on customer, device and revision, contain unique contacts and
advance a valid cursor. A changed revision triggers one restart, then a visible
error. Partial results are never published or persisted. Network errors retain
only the previous unexpired snapshot, without extending its lifetime.

Snapshots use the existing device-only, non-synchronising Keychain store, bound
to server, signed-in identity and enrolment. They are separate from personal
contacts and iCloud. Sign-out, disconnect, known access withdrawal and expiry
remove them; failed secure removal is reported. A cold restore revalidates the
whole cache. Current Apple clients accept up to 10,000 contacts / 8 MB of contact
text in one snapshot and explicitly reject larger directories rather than
silently truncating them. Larger installations need indexed encrypted storage.

The separate iOS real-portal acceptance check now covers actual AppAuth PKCE,
Keychain restoration and `MobileState` directory calling through the native SIP
engine. Its real portal confirms registration/call/IP activity, then suspends and
restores the user; managed cache withdrawal, personal-account isolation and durable
sign-out pass. HTTP drives browser consent and a recording boundary invokes the
real CallKit delegate, with null audio. Interactive browser/directory UI, system
CallKit acceptance and physical audio remain unverified. See
[the repeatable iOS check](../ios/README.md#real-local-portal-acceptance).

## Shared colleague status

Migration 030 adds an optional member link to a directory contact and a
`share_status` preference, off by default. Administrators can link an active
member of the same customer in the contact editor. The database also enforces
that relationship. CSV import cannot set links; an older contact edit that omits
`memberUserId` preserves the link, while an explicit `null` removes it.

People opt in through **Calling preferences → Share status** for each customer.
Only their own verified, active membership can change this setting. It shares
their manually chosen availability and Do Not Disturb setting with licensed
colleagues. Migration 031 adds a separate **Share call activity** consent, also
off by default; existing status consent does not enable it. Both options are
independent and share no SIP details, device addresses, email, caller or destination.
Suspension, licence loss, unverified identity or removal hides the target's status.
Removing a membership resets both consents, including SCIM removal. Sharing does
not affect call admission.

Call activity shows only positive recent observations: **In a call**, **On hold**,
**Ringing** or **Dialling**, together with **App report** or **Gateway report**.
App observations must be confirmed, at most three minutes old, and refer to a
currently assigned managed direct account on an unrevoked device. Receipt and
freshness use the database clock, so application-host clock skew cannot make a
new report appear to come from the future. Future or expired observations remain
unavailable. Gateway calls
require a ready, leased controller and are attributed to the outgoing device,
eligible incoming recipients, or the answering winner. A shared SIP account alone
does not attribute another person's call to you. Transferred, ending and ended
gateway calls are excluded. The strongest positive observation wins across devices;
no positive observation means unavailable, never idle, available or reachable.
Personal accounts are excluded. Gateway reports currently do not distinguish hold.

`POST /api/client/devices/:id/directory/status` requires an owned, unrevoked
device and current licensed membership. The JSON body contains `revision` and
1–100 unique `contactIds` from that customer's directory. A changed revision
rejects the request so an old contact cannot show another linked member's
status. The response binds `deviceId`, `organisationId`, `revision`, `expiresAt`
and contact IDs; each contact has `availability` and `doNotDisturb`, or both
`null` when manual status is unavailable. Its independent `activity` is `null`
or `{ state, source, observedAt }`. Clients accept a missing activity field from
older servers. It never includes the linked user ID. Status expires after at most
30 seconds, additionally bounded by the observation's original three-minute age,
and must not enter an offline directory cache. Repeated reads cannot extend an
old report. Opt-out is immediate on the server; an existing client snapshot can
remain visible only until its expiry.

All four clients validate status against the current directory and recheck
access after the request. The Windows contact detail and expanded Mac/iOS/Android
contact poll every 20 seconds while visible and active. A separate expiry task
clears the observation even if the next request stalls. Failed requests, inactive
apps and view/customer/contact/revision changes clear it; status never enters
saved contact data. Real local iOS, Android and Windows acceptance verifies
independent manual/activity sharing followed by immediate server-side opt-out. The label describes a shared preference or recent call observation and does not confirm
that the person can answer. Windows component browser QA covers shared, hidden,
failed and expired observations. Native visual review remains outstanding; builds
and protocol acceptance are separate evidence. No provider or new environment key
is required.

## Windows app

Choose **Contacts → Company directory**, then a connected customer. Search by
name, company or formatted telephone number, and select a contact to see its
labelled numbers. Only enabled, unexpired calling accounts belonging to that
customer and device are offered; the main process rechecks the contact and exact
account before dialling. Personal and foreign-customer accounts cannot be used
as a fallback.

The main process validates complete paginated snapshots with the same limits,
one-restart policy and earliest-page expiry as the Apple client. The cache uses
the existing origin-bound OS-encrypted managed session store and includes its
user identity. Global renderer state contains directory metadata only; contacts
are loaded on demand. Fetches run independently of provisioning and call work,
refresh while the view is open, and cannot republish after access withdrawal.
Expiry, disconnect, sign-out and verified access denial remove runtime access;
failed persistence of removal is reported to the user.

Node tests cover paging, malformed replies, identity/customer/device binding,
offline expiry, storage failure, concurrent denial and exact-account dialling.
The real renderer was reviewed with fictional in-memory IPC responses, including
search, unavailable service, access removal/recovery and the 1024px layout.
`pnpm test:windows-portal` now exercises real PKCE login/refresh, directory fetch,
restoration and a customer-bound call through the Windows controller/AppState
and C engine against a disposable local portal and SIP registrar. Suspension
removes managed contacts/settings while preserving a personal registration and
established call; resumption, disconnect and sign-out pass. It runs on macOS with
in-memory token storage and null audio. Packaged Electron IPC, Windows DPAPI,
browser gestures and physical audio still need separate acceptance. See
[the repeatable Windows check](../windows/README.md#real-local-portal-acceptance).

## Android app

The **Directory** tab offers connected-customer selection, name/company/number
search and expandable labelled numbers. Only usable accounts belonging to that
customer's device are offered. After microphone permission handling, the model
rechecks the current contact number and exact account before calling.

AppAuth refresh is serialised; directory paging runs independently of the call
and provisioning queue. Complete snapshots use the same identity, page, cursor,
revision, expiry and 10,000-contact / 8 MB text limits as the other clients.
Refresh runs every minute while the view is active. A changed revision restarts
once; an offline failure retains only the previous unexpired snapshot. Expiry,
known withdrawal, disconnect and sign-out clear access, and late responses cannot
restore it. A failed secure write preserves the previous authorised snapshot and
reports an error.

Caches use the existing Android Keystore AES-GCM managed-session vault, bound to
origin, user, customer and device. The aggregate encrypted session has a 16 MB
plaintext ceiling across all customers; personal settings retain their 1 MB
limit. Larger sessions fail explicitly and need split or indexed encrypted
storage. Shared contacts are not written to Android's personal address book.

The initial directory run passed six JVM checks and all sixteen managed-client emulator checks, including
paging/restarts, malformed responses, customer/device/user binding, encrypted
reload, missing-key failure, offline expiry and late withdrawal responses.
Five additional engine/storage checks pass; two opt-in SIP fixture checks were
skipped in this run. Debug/test and unsigned release builds, lint (zero errors)
and release 16 KB ZIP alignment pass. Visual review remains unverified because
computer use could not reliably control the Android Studio guest screen. This
did not prove portal browser sign-in, directory SIP calls or physical behaviour.
The later [real-portal acceptance check](../android/README.md#real-local-portal-acceptance)
passes real AppAuth PKCE, encrypted restoration, directory validation/SIP calling,
admin activity/IP reporting and withdrawal. HTTP supplies browser consent and the
test calls the SDK/engine directly; interactive directory UI and physical audio
remain separate checks.

This is an organisation-wide directory. Group visibility and external directory
providers are not yet implemented. No external API key
is needed for the implemented service.

## Verification

`pnpm test` covers number validation, tenant and licence boundaries, revoked
devices, audit projections, concurrent edits, tied-name pagination, literal
search, revision conflicts, CSV parsing, partial import results and concurrent
duplicate/retry handling. `scripts/staff-http-smoke.ts` checks authenticated import,
no-store replies, normalisation, retries, row limits, origin/identity rejection
and audit counts using temporary fictional customers. The existing `scripts/http-smoke.ts` exercises
real portal authentication, native OAuth/PKCE, directory CRUD, scope separation,
conflicts and non-cached device responses against its fictional local fixture.
Use its local-development safeguards; never point it at a production database.

On 26 September the Mac Development app also passed an interactive local flow:
browser sign-in and MFA, the native PKCE callback, customer enrolment, and actual
SIP registration. A contact created in the portal appeared in the native company
directory; its call action used that customer's assigned account and completed
INVITE/200/ACK with the loopback test server. Empty search and customer suspension
were reviewed. Suspension removed directory access and the calling account while
the established call continued until native Hang Up sent BYE. Resumption restored
registration; restart restored the signed-in Keychain state, and sign-out removed
it durably while retaining the personal fixture account. The browser recovery
link was needed because the automatic Apple authentication window did not appear.
This verifies local signalling, not physical audio: the registrar sends no RTP.
The temporary customer, profiles and registrar were removed afterwards. Mobile
screen review and other clients' complete interactive sign-in/calling flows remain
unverified.
