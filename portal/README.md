# Sipper management portal

Meeting service/API and verification: [Managed meetings](../docs/MEETINGS.md).
Client media interfaces and audio/video acceptance remain in progress.

Local implementation of the shared managed-account platform. This is not a production launch. Progress and the remaining client, gateway, mobile and enterprise requirements are tracked in [`../docs/IMPLEMENTATION-STATUS.md`](../docs/IMPLEMENTATION-STATUS.md).

## Managed setup links

Open a customer, select a person, then use **Device setup → Create setup link**. The QR image is generated locally. Creation requires administrator MFA and an active, verified, licensed member. A new link revokes that person's earlier unused link for the same customer; the panel also allows revocation.

Links last 15 minutes and work once for the intended signed-in identity. The URL is `/portal/setup#ref=…`: its random reference stays in the fragment rather than query strings or server access logs. Only its hash is stored. The public page hands off `sipper://setup?server=…&reference=…`, or explains how to paste the web link into the app. No SIP credentials, email address or customer identifiers are embedded. Each app accepts only its configured management origin; a link cannot switch servers.

All four clients have a setup-link field and explicit Connect action. Opening a URL only stages the form; sign-in, redemption, enrolment and configuration use the existing authenticated APIs. If redemption succeeds but connection fails, the reference has been consumed: choose the customer directly or request another link. References are not saved in native credential stores. Expired, used, revoked and wrong-identity references produce the same unavailable result. The endpoint rejects browser cookies in place of native bearer authentication, and concurrent attempts cannot both consume a reference.

No additional environment variables or provider keys are needed: the existing `SIPPER_BASE_URL` and each app's configured management origin apply. Cross-device development links must use a reachable origin matching the app's development configuration; a phone's `localhost` does not point to the developer's Mac. Physical QR scanning and packaged browser-to-native handoff remain release checks.

## Company sign-in

Customer administrators can open **More → Company sign-in** to configure one
OpenID Connect connection for that customer. Administration requires Sipper MFA.
Register a web application at the identity provider with `openid email profile`
scopes, authorisation code flow, PKCE and either `client_secret_basic` or
`client_secret_post`. Enter its HTTPS issuer, client ID and secret, then copy the
generated redirect URI into the provider. Add the displayed DNS TXT record for
the exact email domain, check it, and explicitly enable the connection. Each
verified domain belongs to only one connection. Subdomains need their own exact
domain; wildcard domains are not accepted.

Provider discovery rejects private network destinations and unsafe redirects;
tenant issuers are never added to the application's trusted browser origins.
The complete provider configuration is encrypted with `SIPPER_ENCRYPTION_KEYS`
and bound to its connection. Secrets cannot be retrieved through the management
API, and upstream access, refresh and ID tokens are not retained after sign-in.
The client secret can be rotated. Issuer, client ID and domain remain fixed to
protect existing subject links; provider migration needs an operator procedure
and is not yet available as a self-service action.

Users select **Sign in with your company** and enter their company email. The
verified issuer, subject and exact email domain establish identity; sign-in claims
alone never allocate roles, customer membership or licences. Customer access
requires an accepted invitation or a separately provisioned SCIM membership,
with licences assigned in Sipper. Existing Sipper MFA also applies, and accounts without a
local password can enrol it under Security. Native authorisation retains its
consent and PKCE flow through company sign-in and MFA. Invitation references
remain in browser storage/fragments, outside provider and server query strings.

Existing passwords continue to work: this is not an SSO-enforcement policy.
Disabling a connection blocks new company sign-ins but does not revoke existing
sessions, native grants or calls. Use the existing access/device controls for
those operations. SAML and IdP-driven administrator roles are not implemented.
SCIM user and group provisioning is configured separately below.
There are no global SSO environment credentials: each customer
supplies its own provider settings in the portal.

`tests/company-sign-in.test.ts` exercises a disposable local OIDC server with
signed tokens, code consumption, JWKS and PKCE. It covers domain verification
(with controlled DNS responses), subject/email binding, MFA, native consent,
secret rotation, tenant boundaries and configuration encryption. The adapter
uses Better Auth's pinned 1.7.5 OAuth continuation context; rerun these checks on
auth-library upgrades. Real provider interoperability and public DNS verification
remain required before production use.

## User provisioning (SCIM)

Customer administrators can open **More → User provisioning** to create or rotate
a customer-scoped bearer token, inspect its expiry and last request, and review
provisioned users in a searchable table. Tokens are shown once, stored only as a
hash and expire after one year. The provider can create, suspend and remove its
own customer users and groups; it cannot authenticate a person, grant an admin
role or allocate a licence. Unknown emails wait for verified sign-in. SCIM group
membership is read-only in Sipper, while calling-account assignments remain
editable. Manual membership conflicts appear as **Needs attention**.

Apply migration 024 before updating the portal. No additional environment secrets
are needed. See [SCIM setup and API contract](../docs/SCIM.md) for mappings, access
lifecycle, limits and checks. Real identity-provider interoperability remains a
release check; the local implementation is not an assertion of Okta, Entra or
another provider's certification.

## Company directory

Open **Directory** from a customer to manage shared contacts in a searchable table. Contacts support one to five labelled telephone numbers, with revision checks preventing conflicting edits or deletes. The native feed is bound to the enrolled device's customer and current licence, uses revision-bound pagination and records successful directory requests in device activity. Shared contacts stay separate from personal address books. All four clients have directory views and protected caching; mobile visual review and full portal-to-app verification remain. See [Company directory](../docs/COMPANY-DIRECTORY.md) for the API contract and verification. No new provider keys are needed.

## Messages

Open **Account → Messages** to choose a customer and send plain text to licensed
colleagues, individually or in a named group. Owners can change a group's name,
roster and owner; participants can leave. Access is participant only and read state
follows the user across devices. Apply migrations 032–034 before updating the
portal and workers. The existing encryption keys protect
server-readable bodies, and `SIPPER_MESSAGE_RETENTION_DAYS` controls retention.
Foreground messaging needs no provider key. All four native clients have messaging
screens. Mac/Windows have opt-in generic alerts while running through an owned-device
unread-reference feed, with no extra provider service. iOS/Android have opt-in generic message alerts using the existing
push providers and a separate token registry. Apple needs the normal app topic in
`SIPPER_APNS_MESSAGE_TOPIC`. Real delivery and remaining native UI acceptance are
unverified. See [Messaging](../docs/MESSAGING.md) for the API, expiry/retry
rules, deployment limits and repeatable local checks.

## My devices

Verified users can open **My devices** without administrator access or MFA to
review their own managed connections across customers. The table shows platform,
versions, enrolment/revocation, last login, last request and request IP; details
also show the last app report. Search is literal, results are paginated in groups
of 50, and device access is distinct from current SIP registration or licensing.
No SIP settings, credentials, installation IDs or other people's devices are
included. Browser sessions remain under Security.

`GET /api/platform/me/devices` accepts optional `q`, `state` (`all`, `enrolled`,
`revoked`) and `after` (the returned `nextCursor`). Browser session ownership is
enforced on both the list and cursor. `DELETE /api/platform/me/devices/:id` uses
the existing device sign-out operation, requires a same-origin request and is
idempotent with one audit event. It remains available when calling membership or
licensing has stopped. The owner route never gains administrator access to
another user's device.

Revocation removes push tokens and gateway eligibility, blocks new provisioning,
and preserves seats, other connections, personal SIP accounts and established
calls. Offline clients may retain configuration until expiry; direct PBX
credentials require revocation at the PBX for enforcement there. To reconnect,
explicitly remove the customer in the app and enrol it again. No provider keys
or additional settings are required. Migration 019 adds the user/pagination index.

## Calling preferences

Users can also set **Available**, **Away**, **Busy** or **Not set** for each customer
in the portal and all four apps. Migration 029 adds `availability` to the membership.
It is a manual status, shared across devices and visible to administrators in People;
it persists until changed or cleared. It does not affect calls, push, registration,
licensing or configuration revisions and is not a reachability signal. Only that
customer's active member can change it, including before they receive a licence.

Verified users open **Account menu → Calling preferences** to set Do Not Disturb
separately for each customer. Migration 026 stores this preference on the person's
membership, so it applies to all their enrolled devices, including sleeping phones.
It excludes that person from newly admitted **gateway** calls and their wake pushes;
other members assigned to the same calling account can still ring. If no recipient
remains, the gateway rejects the new call. Calls admitted before the change keep
their recipients, including queued wakes, ringing and established conversations.
Disabling the preference only affects future admission; rejected calls stay ended.
SIP registration, provisioned credentials, outgoing calls and licensing are unchanged.

All four apps expose this shared preference under managed customer settings.
Gateway admission changes immediately. For direct PBX accounts, provisioning adds
an account-level `doNotDisturb` boolean to the protected configuration and its hash.
Updated apps apply it at settings refresh (normally every minute, and after a native
preference change). The native SIP engine rejects new direct incoming calls with
486 before ringtone/CallKit/Telecom presentation. Policy-only changes leave SIP
registration, outgoing calls and already admitted calls intact. Personal accounts
and the desktop apps’ separate local Do Not Disturb controls keep their behaviour.

This is cooperative direct-client enforcement, not a PBX setting. Offline apps keep
their last policy until the configuration expires under `SIPPER_CONFIG_TTL_SECONDS`;
older apps may ignore the added field. Neither the preference nor an old applied
revision confirms that every device has received it. Current clients treat an absent
field as legacy behaviour, but reject a present non-boolean field, including null.
Gateway account payloads and their revisions are unchanged by this preference.
This preference is not proof of SIP registration, reachability or presence.
Administrators and read-only support can inspect it in the people table/details,
but only the user can change it. Removed memberships are omitted; suspended
memberships are readable but cannot be changed. Active users can save a preference
without a seat or enrolled device; doing so grants neither.

The native organisation list includes `doNotDisturb` and `availability`. Apps update them through
`PATCH /api/client/organisations/:organisationId/calling-preference` and display a
change only after a matching server acknowledgement. Missing values, failed reads
and uncertain saves show **Unavailable**, with refresh for recovery. Preferences
are read afresh after restart, using the existing membership refresh interval.
They are never inferred from local registration or a cached session.

Browser sessions use `GET /api/platform/me/calling-preferences` and
`PATCH /api/platform/me/calling-preferences/:organisationId`. Scoped native OAuth
uses `GET /api/client/calling-preferences` and
`PATCH /api/client/organisations/:organisationId/calling-preference`. The list returns
`organisations` with `id`, `name`, `status`, `do_not_disturb`, `availability` and nullable
`calling_preference_updated_at`. PATCH accepts either or both of `doNotDisturb`
(boolean) and `availability` (`unset`, `available`, `away`, `busy`), and returns both
values plus nullable `updatedAt`. Empty, unknown and invalid fields are rejected.
Sparse updates preserve the other preference under the membership row lock.
Requests are private,
browser writes require the configured origin and the active membership must belong
to the signed-in identity. No administrator bypass exists. A repeated value keeps
the same timestamp and creates no extra audit event. Gateway Do Not Disturb enforcement
also applies to older native clients without an app update. Older servers omit
availability; updated apps show it as unavailable until a supporting server responds.
No additional provider keys, services or environment variables are needed.

## Local setup

Requires Node 24, pnpm 12 and Docker. From the repository root:

```sh
docker compose -f infra/compose.dev.yml up -d
docker compose -f infra/compose.dev.yml exec -T postgres psql -U sipper -d sipper -c 'CREATE DATABASE sipper_test'
cd portal
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate an independent random authentication secret and a 32-byte base64 encryption key, and replace the placeholders in `.env`. The encryption setting is a JSON object, for example `{"v1":"<your base64 key>"}`. Do not reuse these keys for other environments. Keep `.env` private; it is ignored by Git. Development database credentials in the example are deliberately local-only.

```sh
pnpm db:migrate
pnpm dev
```

Visit `http://localhost:3100/portal`. Local email is captured at `http://localhost:8030`; it never leaves Mailpit. Start `pnpm worker` in another terminal to deliver queued invitations. Signup verification and password-reset emails are sent directly to SMTP. Use the `localhost` hostname consistently: cookies and allowed origins are tied to `SIPPER_BASE_URL`.

1. Sign up with a dummy `example.invalid` email.
2. Open its verification link in Mailpit, then sign in.
3. Set up two-factor authentication under Security; save the recovery codes.
4. Create a workspace and a customer, then configure calling accounts and invite people.
5. For local testing only, set `SIPPER_ALLOW_TEST_BILLING=true` to expose a clearly labelled test-licence action. It cannot replace a real Stripe subscription. Production refuses to start with this flag enabled.

`node --import tsx --env-file=.env scripts/local-fixture.ts` creates a verified dummy browser-testing account using the real email/MFA flow. It only runs against localhost and local Mailpit. Credentials go to the ignored `.data/browser-fixture.json`, never a tracked fixture. This is a development helper, not an authentication bypass or production seed.

## Licences and authority

- One seat is assigned to one global user identity within a billing workspace. Additional devices and memberships in that workspace do not consume more seats.
- Separate billing workspaces have separate seat assignments.
- Workspace and customer administrators do not need a calling seat unless they also use managed calling.
- Suspending a membership preserves its seat assignment and the subscription quantity. Releasing a seat stops new provisioning throughout that workspace.
- Licence assignment and subscription reconciliation lock the same workspace row to prevent oversubscription.
- Gateway-mode accounts fail closed until the gateway can issue separate device credentials. They never fall back to distributing the upstream password.
- Direct SIP credentials necessarily reach an authorised device. Revoking a device stops future provisioning; the PBX must revoke its credentials for immediate upstream enforcement.

Calling-account edits require the numeric `revision` returned in the customer
projection. The service locks the account and rejects an older revision with
`409 configuration_changed`, before changing settings or the encrypted password.
The editor keeps failed drafts open. **Reload saved account** explicitly replaces
the draft and clears the password field; leaving the new password blank preserves
the stored credential. If a save response is lost, reload and review the saved
account before retrying. Closing the editor clears its in-memory password.
Automatic customer refresh pauses while account, group or invitation forms are
open; writes still check current server permissions and account/group revisions.
No migration, provider key or additional environment setting is needed.

Customer group creation and editing save the name, people and calling accounts in one
transaction. Local groups can be renamed; SCIM group names and membership remain
controlled by the identity provider. An open editor captures the group's content
revision, so intervening portal, SCIM or membership-removal changes return a conflict
instead of overwriting them. **Reload group** explicitly replaces unsaved fields.
Creation keeps one UUID through retries and cannot duplicate or overwrite a saved
group. Renaming alone leaves native calling configuration unchanged. Group audit
details contain selection counts, without names, phone numbers or passwords.

`POST /api/platform/organisations/:id/groups` accepts `name`, optional `id`,
`userIds` and `configurationIds`. `PATCH /api/platform/organisations/:id/groups/:id`
requires the `revision` from the customer projection and at least one of those
editable fields. For SCIM groups, only `configurationIds` can be sent. Existing
member/account assignment routes remain available. No migration or new key is needed.

Platform-owner access is never inferred from an email domain or a client flag. Once the intended owner has verified their email and enabled MFA, grant access explicitly:

```sh
pnpm owner:grant owner@example.com
```

The grant is recorded in the audit log. No real owner identity is embedded in the repository.

## Payments

Fill the Stripe settings in `.env.example` only when preparing payment-provider verification. Missing settings leave purchases unavailable while configuration remains usable. No successful payment is inferred from a checkout return URL.

- Create recurring per-seat prices in Stripe for the approved currency and monthly/annual amounts. Those commercial choices are not hard-coded here.
- Configure the webhook endpoint `/api/webhooks/stripe` for `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `checkout.session.completed`. Subscription events cover renewal and payment-status changes.
- Use separate test and live API keys, prices and webhook signing secrets. Never send secret keys to clients.
- Configure the Stripe customer portal for invoices, payment methods and cancellation. Keep quantity/price switching disabled there; Sipper's own quantity endpoint checks assigned seats first.
- New quantity charges use pending updates: capacity only follows the authoritative subscription once payment succeeds.
- Webhooks verify the original raw body, reconcile current provider state under the workspace lock, and record processed event IDs. Replays and out-of-order events cannot reinstate older state.
- If an external reduction creates excess assignments, new managed provisioning stops until capacity or assignments are corrected. No users are silently deleted. The portal calls out the discrepancy.
- Renewal grace is configurable with `SIPPER_BILLING_GRACE_DAYS`; the default is zero pending a commercial decision. Existing calls are not terminated by billing handlers.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Tests run only against a database whose name ends in `_test`, using `SIPPER_TEST_DATABASE_URL`. They exercise actual PostgreSQL constraints and transactions, encryption context binding, local email verification and MFA, tenant boundaries, seat races, invitation ownership, group inheritance, revocation and signed billing events. Stripe state is simulated in those tests; they do not prove real provider payments.

With the local server running and a browser fixture created, `node --import tsx --env-file=.env scripts/http-smoke.ts` checks actual HTTP session/CSRF/body handling and the native PKCE flow through device enrolment, configuration and acknowledgement. Its code exchange matches Apple's AppAuth defaults, and it verifies refresh-token retention, API access after refresh and rejection after revocation. It also verifies the activity returned to admins, including login/request times, request IP and password omission. It reuses one synthetic local installation, with no real SIP server or payment. Add `--dev-proxy` when checking `pnpm dev`: Nuxt's Unix-socket development proxy has no verifiable peer IP, so that check expects no recorded address. Run the default check against the built Node server to verify actual IP capture. If using a different localhost origin for that server, run `db:migrate` with the same `SIPPER_BASE_URL` first to initialise its OAuth resource. The shared Mac/iOS client is in `../packages/SipperManaged`; native UI, Windows, mobile and gateway progress remains in the requirement ledger.

The Better Auth migration emits an `int8`/`number` schema warning for its own rate-limit timestamp column on PostgreSQL. The current schema and integration tests work; this is not a migration failure.

`pnpm test:ios-portal` runs real AppAuth, Keychain, iOS account-controller and
directory-calling checks against a separate built portal and database. It creates
and removes a disposable simulator using the `Sipper iOS QA` runtime/device type.
See [iOS local portal acceptance](../ios/README.md#real-local-portal-acceptance).
The iOS, Android and Windows commands reuse `scripts/native-portal-smoke.ts`.

`SIPPER_ANDROID_SERIAL=<emulator serial> pnpm test:android-portal` checks the actual
Android AppAuth client against a separate built portal, with its own temporary
database and fictional SIP registrar. It verifies provisioning, directory calling,
activity/IP reporting and suspension/disconnect/sign-out. Build the Android debug
and test APKs first; the emulator must be the dedicated SipperUIQA AVD. See
[Android acceptance prerequisites and limits](../android/README.md#real-local-portal-acceptance).
The authorisation browser is driven over HTTP, so native browser/intent UI still
needs separate acceptance. No provider key is required.

`pnpm test:windows-portal` checks the Windows managed client, controller and C
engine against the same isolated portal/SIP fixture, including real PKCE and
token refresh. It runs on macOS with in-memory token storage and null audio;
Windows DPAPI, Schannel and packaged UI remain separate checks. See
[Windows acceptance prerequisites and limits](../windows/README.md#real-local-portal-acceptance).

Directory contacts can now link to an active member of the same customer.
**Calling preferences → Share status** lets that person share their availability
and Do Not Disturb setting with licensed colleagues; sharing starts off. Apply
migrations 030 and 031. **Share call activity** is a separate default-off consent
for recent managed ringing, dialling, connected and held call observations.
The device-bound status endpoint expires observations within 30 seconds and
exposes no email, IP, SIP identity, caller, destination or personal-call details. All four apps
display them in opened contacts, separately from the offline directory. See
[the directory status contract](../docs/COMPANY-DIRECTORY.md#shared-colleague-status).
No new environment setting or provider key is needed.

## Mobile call and push service (in progress)

The server has encrypted APNs/FCM token storage, a durable push queue and a call-state API. The local gateway routes real SIP calls; the isolated Android test exchanges encrypted media packets on outgoing/incoming calls and verifies device-bound answer claims, cancellation, decline and failed-answer cleanup. Native push wake and call-UI verification are still required. Gateway provisioning fails closed without a ready controller. Provider transport tests use injected responses; no live Apple/Google delivery is claimed.

Native OAuth clients can `PUT` or `DELETE /api/client/devices/:id/push`. Token registration requires an owned, licensed iOS/Android device; revocation deletes its token. Provider tokens and caller details never appear in portal responses or ordinary queue payloads.

The gateway first acquires ownership with `POST /api/gateway/heartbeat`, sending `{ instanceId, ready }`. Every other gateway request requires both its separate bearer key and `X-Sipper-Controller` matching the current unexpired lease. It creates calls using `POST /api/gateway/calls` with `callId`, `configurationId`, `caller: { name, number }` and optional `ringSeconds` (5–90). A repeated call ID is idempotent for the same gateway/account. Only gateway-mode accounts are accepted. `POST /api/gateway/release` relinquishes the current instance after draining calls; it cannot release a replacement controller. A gateway should be reachable over private TLS ingress and must not expose its key to clients. `pnpm build` followed by `pnpm test:gateway` verifies the built HTTP boundary and standalone service against a disposable gateway; see `../gateway/README.md` for prerequisites and limitations.

Outgoing admission uses `POST /api/gateway/outgoing` with a fresh `callId`, endpoint and destination. The gateway repeats admission before bridging, then reports `connected` with the originating device and `ended` on hangup through the same call endpoint. Replays are idempotent and cannot switch the recorded device/account/revision. The destination is validated for routing but never stored in the call record or recovery journal. Outgoing calls have no push recipients or answer claims; native incoming-call endpoints cannot access them. Apply migration 020 and update portal/controller together. Existing outgoing calls from older controllers are not backfilled.

Migration 028 adds durable gateway-transfer admission and outcome records. The controller now implements bridge changes and recovery; shared endpoint transfers remain disabled pending native gateway controls and media/interoperability verification. The owning controller can reserve one connected call and a numeric destination, or two connected calls on the same account/device, through `POST /api/gateway/transfers`. Pending retries recheck current authority and configuration revision. `GET /api/gateway/transfers/:id` and `POST { state: "completed" | "failed" }` support outcome replay after recovery without re-executing an operation. `GET /api/gateway/transfers` lists pending references for orphan reconciliation. Blind destinations are encrypted and never included in snapshots or the controller journal; attempts follow source-call retention. Incoming calls record the admitted configuration revision too; older records without that evidence cannot transfer. See `../gateway/README.md` for the contract and remaining verification; no new environment setting is required.

Recipients use `GET /api/client/devices/:id/calls/:callId` and `POST` to the same path with `/wake`, `/answer` or `/decline`. Answering reserves one device for at most eight seconds; it does not mean SIP media connected. The gateway reads `GET /api/gateway/calls/:id`, then confirms a matching active claim with `POST { event: "connected", deviceId }`, or finishes with `{ event: "ended", reason }`. An established call remains readable by its winning device after ordinary access withdrawal. New admission and each queued push re-check current seats, assignments, membership and revocation.

Start `pnpm worker:push` alongside the separate email worker. APNs uses HTTP/2 and short-lived ES256 provider tokens; FCM uses a service-account assertion and Google's fixed OAuth/HTTP v1 endpoints. Configuration is documented in `.env.example`. Missing keys produce an explicit unconfigured outcome. Provider acceptance, device wake and actual call connection are separate states. Invalid-token replies only disable the exact token revision sent, so token rotation cannot be undone by a late reply.

Incoming-call push payloads contain a call ID and expiry, with zero provider retention. The iOS client must immediately report a VoIP push to CallKit, then fetch/reconcile state; do not use a second VoIP push to cancel or update it. A cancellation after a provider request starts cannot recall that notification. Mobile clients must deduplicate call IDs and reconcile terminal state through their call connection/API. Physical background delivery and native call UI remain unverified until the mobile apps, gateway and credentials are integrated.

## Data and operations

Customer administration uses searchable tables for people, accounts, registrations, devices, groups and invitations. Person/device detail panels contain assignments and access controls. The portal shares the original Sipper icon, type stack and light/dark palette.

The company directory supports CSV import with a downloadable template, preview,
per-row results and correction of invalid rows. Up to 100 contacts can be added
at a time; exact normalised duplicates are skipped, including on retries, and
existing contacts are never overwritten. See [company directory](../docs/COMPANY-DIRECTORY.md#csv-import)
for columns, limits and native delivery rules.

Workspace owners can invite staff, change roles and remove administrative access from the **Workspace team** table. Owners manage staff as well as customers and billing; administrators manage customers and billing; billing staff see subscription and capacity controls. Administrators can read the team list but cannot change staff. Verified email and administrator MFA apply to these operations, including platform-owner access. Role changes recheck the acting owner's authority under a workspace lock, and at least one workspace owner must remain. Removing staff does not remove independent customer memberships, calling licences or established calls.

The **Read-only support** workspace role can inspect customer people, calling-account settings (without passwords), groups, invitations, registrations, device/request IPs, login/request times, push summaries, gateway call history and workspace audit history. It cannot change customer data, terminate calls, allocate licences, manage billing or staff, access company sign-in/SCIM settings, or open the shared contact directory. It requires verified email and administrator MFA, consumes no calling seat and does not enrol devices or receive SIP credentials. Independent customer memberships remain additive: a separately delegated customer administrator can still manage that customer. Removing the support role denies subsequent management reads without removing that separate membership. Apply migration 025 before using the role; no new environment setting or provider key is needed.

Staff invitations expire after seven days, are bound to the intended verified email and can be accepted only once with MFA. Replacement revokes earlier unused invitations. Removing or demoting the inviting owner revokes their outstanding invitations. The database stores a hash; the reference travels in a URL fragment and the queued email is encrypted. Browser sign-in and MFA navigation preserve the fragment without including it in server callback URLs. New users verify their email, then reopen the invitation to review their role. Ordinary staff listings and audit responses never include invitation references or hashes. Historical staff join dates that were not recorded remain blank rather than using the migration date.

Workspace activity displays administrative actions, staff role changes, the affected person or reference, the acting account and exact timestamps. History uses a scoped cursor with 100 records per request. Local staff API checks can be repeated with `node --import tsx --env-file-if-exists=.env scripts/staff-http-smoke.ts` while the development server is running and the local browser fixture exists. They use temporary fictional workspaces, queue no external email and clean up their database records afterward.

Customer administrators can change a person's customer role or remove them from the person detail panel. Removal revokes that customer's devices and push tokens, clears direct calling-account and group assignments, and invalidates unused setup links and invitations. It preserves the workspace licence, independent workspace staff roles, other customer memberships and historical device/call records. Established calls are not deliberately ended. For direct SIP accounts, immediate enforcement also requires revoking credentials at the phone system; offline clients withdraw managed configuration on reconnect or expiry.

The People table shows current people by default; use the Removed filter to inspect retained history or send a fresh invitation. Rejoining requires acceptance by the intended verified identity, with MFA for an administrator invitation. Old devices remain revoked and calling assignments must be configured again. Removed people cannot be resumed, assigned new licences/accounts or added to groups. Role changes, removals and rejoining appear in workspace activity. The local HTTP script above also covers these customer operations and retained independent staff access. No additional environment variables are needed.

Customer invitations open a review page showing the organisation, proposed role and expiry only to the intended verified identity. Inspection grants no membership, licence or device access. Administrators are directed through MFA setup and back to their invitation before acceptance; invitations for current members explicitly preserve the existing role. New links carry the reference in a browser fragment. Older query-based links are normalised in the browser before sign-in navigation. Both customer and staff references remain in fragments through sign-in and the security-page reauthentication path, rather than being included in authentication callback URLs. A new user verifies their email and reopens the original invitation. The customer inspection and acceptance endpoints recheck expiry, revocation, suspension and the inviter's current authority.

## Operational visibility

Platform owners can open **Service status** from All workspaces. The API checks verified identity, MFA and the current owner grant on every request. It shows gateway heartbeats/readiness/controller leases, authorised device-account counts, worker progress, email, call-push and message-push queue counts and separate call/message endpoint totals. Configuration badges report only whether required settings are present; they do not test credentials. Workers report a completed queue poll every 15 seconds; Polling does not mean successful delivery. Push becomes stale after 45 seconds without progress and email after 180 seconds. Missing workers are Not reported; graceful exits are Stopped. The page shows up to 100 process records from the last 24 hours. Container health probes use each process's private progress file, so a blocked queue check cannot stay healthy through an independent heartbeat timer. See the [operations guide](../infra/README.md) for probe commands and external alert requirements. Gateway account eligibility is distinct from actual SIP registration.

Customer administrators can open **Call activity** for incoming and outgoing gateway calls, with 50 records per page and customer-bound cursors. Direct SIP calls are not in this history. Expired unanswered calls display Expired; connected/answering states become Unconfirmed without a current ready gateway lease. Reading history never changes or ends a call. It includes direction, account labels, originating or answering device/person names, recipient/wake counts and references, without decrypting caller identity or SIP details. Retention follows `SIPPER_CALL_RETENTION_HOURS` and the existing call cleanup worker.

Completed transfers show their time and identify the original device as having left. An attended consultation links to the continuing call, including calls outside the current history page. Call references open a single-call view; **All calls** returns to the latest page. The existing history API accepts either `call=<UUID>` or `before=<UUID>`, never both, and checks the customer's access on every request. Missing or retained-away references show an unavailable message. A transferred call may still be connected between remote parties; its end confirmation explains that distinction. Ended consultation legs have no end action. These views expose completed transfer metadata only, not destinations or individual failed attempts. Migration 028 supplies the fields; no new settings are required.

People and Devices also show a gateway **Calls** summary, with the same information in their detail panels. Calls ringing on several of a person's devices count once. In a call takes priority over End requested, Answer pending, Ringing, Dialling and Unconfirmed; selecting the badge opens that customer's call activity. Revoking a device does not hide an established call. Expired or ended calls drop out, while an expired gateway lease becomes Unconfirmed. None reported does not mean available. Direct SIP activity is reported separately below. The existing refresh controls apply; no new environment settings are needed.

**End call** is a separate confirmed action in Call activity, restricted to this customer's administrators with MFA. It records one audited request, removes retained caller identity, stops new answer claims and queued pushes, and leaves the actual lifecycle unchanged until the gateway confirms teardown. In-flight provider sends cannot be recalled. Pending requests survive gateway unavailability and remain visible even after ring expiry or access withdrawal. The gateway normally checks connected calls every ten seconds; natural hangups retain their actual reason. Retrying a pending request is idempotent; already ended or expired calls reject new requests. Apply migration 022 and update the gateway controller with the portal. No provider keys or new environment variables are required.

Updated Mac, Windows, iOS and Android apps send **Direct · App reported** snapshots when their observed calls or registrations change, alongside the existing minute heartbeat. Their local loops inspect state every one to five seconds, without fetching provisioning again; background changed-state attempts are limited to one every five seconds. Successful unchanged reports are skipped, failed changes remain eligible for retry, and a revision conflict triggers a settings refresh. Manual and scheduled refreshes can send sooner. These contain only per-account counts of ringing, dialling, connected and held call legs. Personal accounts and gateway calls are excluded, and caller names, numbers and call identifiers are never included. The native `POST /api/client/devices/:id/report` accepts optional `directCalls: [{ accountId, ringing, dialling, connected, held }]` only with the current `appliedRevision`, every assigned direct account exactly once, non-negative integer counts and at most 32 call legs in total. All-zero counts explicitly replace an earlier active snapshot. Omission normally leaves the last observation to age. A registration report without an applied revision makes any earlier direct-call snapshot unconfirmed immediately; only a new accepted direct-call snapshot confirms it again. This avoids fabricating idle reports when an engine or configuration is unavailable.

The server stamps each accepted snapshot and the portal marks it Unconfirmed after three minutes, on device revocation or loss of membership/licence. Removed assignments are excluded. Multiple devices report separate call legs; these cannot be deduplicated into conversations without collecting call identity. A current active observation can coexist with a warning about stale devices. Background/offline apps may not refresh; these are periodic observations, not live presence, PBX-verified activity, call history or proof of availability. No new schema migration, service, environment variable or provider key is required. Deploy the accepting portal before the updated clients.

The Devices table and detail panel distinguish mobile token registration, provider response and the last authenticated wake request. Provider acceptance is not evidence that the phone rang. Revoked devices lose their token record. None of the operations responses expose push tokens, credential envelopes, authentication digests, private job payloads or provider error text. Migration 014 records future heartbeats without inventing dates for existing nodes and indexes call-history and pending-job reads. These views add no environment variables or external provider requests.

The Registrations table also includes the SIP server, request IP, last login, last request time and request action. Search accepts SIP usernames and server/domain names; login and request columns are sortable. Table headers stay visible while scrolling vertically, and the identifying account/person column stays visible while scrolling sideways.

People rows show registration totals across that person's currently enrolled devices and assigned accounts. Select the registration count or device count to open the corresponding table filtered to that person; the person filter can also be changed directly. Revoked devices and removed assignments do not inflate the person's registration total. Customer-level device and registration totals open the unfiltered tables. Detail panels keep full timestamps and account assignments accessible on narrow screens.

Device activity retains only the latest authenticated request time, action and server-observed IP, the newest sign-in session used by that device, the last configuration delivery and the last accepted report. Member activity aggregates only devices enrolled to that customer; another customer cannot see it. Previously enrolled devices have no backfilled IP or login data. A sign-in is observed when its session first accesses the managed device API, not inferred from a heartbeat. Rejected requests for another person's device cannot overwrite its telemetry. No request body, query string, password or token is stored in activity fields.

In production the [website proxy](../infra/INGRESS.md) authenticates with `SIPPER_EDGE_SHARED_SECRET` and supplies a single observed client address. Authentication and device telemetry share that verified address, and visitor-supplied internal headers are overwritten. Without an edge key in local development, forwarding headers are ignored by default; `SIPPER_TRUSTED_PROXY_IPS` can name exact trusted proxy peers, and the server walks their appended `X-Forwarded-For` chain backwards. This IP is the address seen by Sipper's management API; it is not necessarily the SIP contact, LAN address or address seen by a PBX.

Registration rows distinguish app-reported direct SIP state from gateway-observed device contacts. Direct reports include the SIP response code and server receipt time and become stale after three minutes. Gateway observations include the received SIP peer IP and become stale after 45 seconds or loss of gateway readiness. Migration 021 binds snapshots to a readiness generation: recovery under the same controller still requires fresh observations, and late reports from before recovery are rejected. Calling accounts separately show gateway-observed PBX registration when private AMI reporting is configured; see [gateway registration activity](../gateway/README.md#registration-activity). Revoked devices and removed assignments cannot appear currently registered. Registration does not prove inbound delivery, push reachability or successful audio.

People, devices and registrations have status filters alongside search. Their name and activity headers are sortable; missing activity remains last in either direction. The page defaults to refreshing every 30 seconds while visible, offers an optional five-second interval, and has a pause checkbox and an explicit refresh action; age/stale labels advance while it is open. Member rows also identify the latest device request action. Registration history and production monitoring remain separate work.

SIP passwords and pending invitation email bodies are envelope-encrypted using AES-256-GCM, with the organisation/account or job identity authenticated alongside the ciphertext. Ordinary portal responses omit passwords and encryption envelopes. Keep the key map outside database backups; preserve older keys while data still references them. A database without its encryption keys cannot restore calling credentials.

The invitation worker claims jobs with a lease, retries transient failures with backoff, and erases encrypted mail bodies after SMTP accepts them. SMTP can deliver a duplicate if its success response is lost; invitation acceptance remains single-use. Jobs with ten failures remain available for operator investigation rather than retrying forever.

The production bundle is `.output`; `/api/health` checks database reachability. Production requires HTTPS, MFA and real secrets. The [deployment and recovery guide](../infra/README.md) packages the portal, migrations and separate email/push workers in an unprivileged container, with an explicit schema/configuration check before startup. It also provides encrypted database backup/restore tools and a disposable rehearsal. [Ingress and browser security](../infra/INGRESS.md) covers the website proxy, origin access, native metadata, CSP and optional tunnel. Public HTTPS/tunnel verification, provider keys, worker alerts, off-site backup operations, production recovery and the remaining application integrations are still tracked work, not established production capability.
