# Sipper standalone and managed platform

Working product and implementation plan, 22 September 2026. This describes the full intended scope. Implemented and verified work is tracked separately in IMPLEMENTATION-STATUS.md. Local portal, API and native integration work is under way; it is not a production launch.

## Product direction

One Sipper application per platform, with two account modes:

| | Standalone | Managed |
|---|---|---|
| Getting started | Add SIP details manually or import them | Sign in with an invited, verified email address |
| Configuration owner | The person using the app | Their organisation or reseller |
| Sipper login | Not required for direct SIP | Required for managed access |
| Connection | Direct to the configured PBX/provider | Provisioned direct SIP, or through the Sipper gateway |
| Central administration | None | Users, devices, configuration, licensing and service status |
| Local settings | User-controlled | Personal preferences remain editable; managed fields follow policy |

Both modes can coexist on a device. Removing, suspending or signing out of a managed organisation must never delete or disable unrelated standalone accounts. Do not turn an existing manual account into a managed account merely because its SIP address matches.

Direct mobile SIP does not promise reliable incoming calls while the operating system suspends the app. Background availability needs Sipper's push service or a compatible provider integration. Optional paid push for standalone users is a packaging decision still to be confirmed. Push delivery is not guaranteed when devices are offline, force-stopped, or denied required permissions.

## Confirmed requirements and proposed defaults

Confirmed: public self-service signup and purchase on sipper.dev; a platform owner with administration across the service; resellers managing multiple customers and groups; users signing in with their own email; secure provisioning; user/device status and suspension; all four client platforms; one paid licence per named user across their devices.

Proposed defaults: administrator access included and seats pooled across a reseller's customers. A business buying for itself uses the same workspace model with one customer organisation. The same user receives the same subscription benefits on each enrolled device. Implementation default: one person assigned to several customer organisations within the same billing workspace consumes one seat in total. A separate billing workspace has its own subscription and seat assignment. No prices, device cap, billing interval, trial length or grace period are approved yet.

The paid product supplies hosted management, provisioning and related services. Existing standalone desktop functionality remains available independently of a managed subscription.

## Accounts and authority

```text
Sipper platform owner
  Billing workspace: reseller or direct business
    Customer organisations
      Groups / departments
        User memberships
          Devices and assigned SIP accounts
```

A user identity is global; permissions and seat assignments belong to memberships. The same verified email can belong to more than one organisation without joining their data. Groups organise users and configuration, but are not the security boundary. An organisation owns its SIP configuration, credentials and operational data.

| Role | Scope |
|---|---|
| Platform owner | All workspaces, organisations, subscriptions, users, service operations and audit records |
| Workspace owner/admin | Their purchased seats, customer organisations, staff and configuration |
| Workspace read-only support | Customer settings without passwords, people, registrations, device activity, call history and audit; no management or billing changes |
| Organisation admin | Delegated users, groups, devices and settings within their own organisation |
| End user | Their assigned managed accounts, permitted settings and own devices |

Use explicit server-side permissions on every API operation and background job. A supplied organisation ID, an email domain or a client-side role flag is never proof of access. Cross-tenant assignments must be rejected by both application rules and database relationships.

The platform owner has service-wide control. Routine pages mask secrets; any permitted credential reveal or customer support access is deliberate and audited. Privileged roles require MFA. Administration does not imply collecting personal recordings, local address books or standalone-account passwords.

## Self-service purchase and onboarding

1. A purchaser signs up, verifies their email, and creates a workspace.
2. They select a subscription quantity and pay through hosted checkout.
3. The server confirms the payment/subscription state and grants the purchased capacity.
4. The purchaser creates customer organisations, SIP templates and groups, then allocates seats and invites users.
5. An invited user authenticates in Sipper, chooses their organisation if necessary, and receives their assigned configuration.
6. The portal reports device enrolment, configuration application and registration results separately.

Stripe Billing subscription quantities fit the per-user seat model. Use Checkout and the customer billing portal for payment methods, invoices and subscription management. Authorise the billing-portal session server-side. A reseller pays Sipper for its pool and invoices its customers independently at first; collecting payments on behalf of resellers is a separate product decision, not an implicit Stripe Connect requirement. [Stripe quantities](https://docs.stripe.com/billing/subscriptions/quantities)

Payment webhooks must be signature-verified and processed idempotently. Reconcile authoritative subscription state so retries or out-of-order events cannot duplicate capacity or reactivate a cancelled subscription. Checkout's return URL alone must not grant access. Seat allocation is transactional to prevent two administrators assigning the last available seat. [Stripe subscription events](https://docs.stripe.com/billing/subscriptions/webhooks)

Keep billing state, purchased capacity, seat assignment, user suspension and device revocation distinct. Pausing a user does not automatically reduce the subscription bill. Reductions cannot silently leave more active assignments than purchased seats; ask the customer to select assignments to release. Handle failed renewal payments using an explicit grace policy and notices, with billing access retained for recovery. A transient billing-provider outage must not drop an established call.

## Provisioning and credentials

Native clients authenticate through the system browser using a maintained OAuth/OIDC implementation with authorization code and PKCE. Verify invitation ownership against the authenticated identity. Do not invent a password exchange between clients and the portal or put shared client secrets in distributed apps. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)

Provisioning is an authenticated, versioned API response scoped to the user, organisation and enrolled device. It carries managed account IDs, allowed settings, configuration revision and service entitlements. Secret-bearing responses must not be cached by shared proxies or logged. Clients acknowledge the applied revision and keep credentials in the platform's protected storage.

The existing `sipper://add-accounts?payload=...` format is a manual import feature. Managed enrolment links and QR codes must carry only short-lived, single-use enrolment references bound to the expected identity/workspace; they must not embed SIP credentials. A QR scan must not override the authenticated account's permissions.

There are two materially different managed connection modes:

| Mode | Credentials on the device | Control available to Sipper |
|---|---|---|
| Provisioned direct SIP | Upstream PBX credentials, masked in the normal interface | Provisioning, app policy and cooperative revocation; upstream enforcement requires a PBX integration |
| Gateway-managed SIP | Device-scoped Sipper SIP credentials; upstream credentials remain on the service | Gateway registration, new-call admission, push and device revocation can be enforced server-side |

Prefer gateway-managed SIP for organisations requiring strong suspension and separation of upstream credentials from users. Hiding a password in the interface cannot make a long-lived secret delivered to a user-controlled device impossible to extract. This matters particularly because the clients are open source.

Protect server-held SIP secrets using envelope encryption with keys managed separately from the database. Limit decryption to the provisioning/gateway paths that require it. Keep credentials out of logs, notifications, URLs, analytics, source control and ordinary support exports. Enforce tenant boundaries on device tokens, gateway registrations, configuration and diagnostic events too.

## Portal controls and status semantics

Initial portal functions: customers, groups, users, invitations, seat allocation, SIP templates and assignments, devices, configuration revisions, billing, user/device suspension and an audit history. CSV import and bulk actions must preserve per-row validation and show partial failures clearly.

Service status includes platform-owner recovery for exhausted customer and workspace invitation emails. Retries preserve the original invitation and expiry, require verified MFA-protected ownership and remain subject to current invitation/creator authority. The worker removes secret-bearing payloads once SMTP accepts the email or the invitation becomes unusable. A queued retry or SMTP acceptance does not prove inbox delivery; an uncertain earlier attempt may produce another copy. No extra provider key is needed.

Calling-account editors capture the existing numeric revision. A stale save is
rejected before settings or passwords change, with an explicit reload to review
the saved account. Failed drafts stay open; reload and closure clear the entered
password. An omitted replacement password preserves the stored credential.

Customer group names, people and calling-account assignments now save atomically.
Content revisions prevent an open editor overwriting changes made by another
administrator, SCIM or member removal. Locally managed groups can be renamed;
identity-provider groups retain their name and membership authority. Creation
retries reuse one group reference. Group-name changes alone do not alter calling
configuration or interrupt calls.

Do not reduce reachability to one unqualified green dot:

- Membership: invited, active, suspended or removed.
- Licence: assigned, unassigned or awaiting billing action.
- Device: last seen, app/OS version, enrolled or revoked.
- Configuration: desired revision, applied revision, last error.
- SIP: registered, registration failed, unregistered or unknown; identify whether the observation came from a device, gateway or PBX.
- Push: registered token, last send/provider response and last observed wake where available. Provider acceptance does not prove that the phone rang.
- Calls: ringing/in a call only where the client, gateway or PBX supplies timely evidence; stale observations become unknown.

Managed direct-call snapshots are implemented in all four apps and shown separately from gateway observations in People and Devices. They contain per-account call counts only. Native state changes are reported with a five-second attempt limit and the existing minute heartbeat; the portal offers five- or thirty-second refresh. Observations become unconfirmed after three minutes or when an app reports an unapplied configuration. Personal calls are excluded. No caller identity or number is uploaded. This supplies observed call and registration activity; automatic availability presence, direct-call history and unique conversation counts across devices are not implemented.

Users can set Available, Away, Busy or Not set per customer in the portal and all four apps. This manual availability is shared across devices, displayed to administrators as set by the user and persists until changed or cleared. It is separate from Do Not Disturb, does not affect call handling and does not prove reachability. Only the verified user's own active membership can change it. It uses the existing preference API and requires no extra service or provider key. Optional colleague status is implemented locally: administrators link directory contacts to customer members, who explicitly opt in to sharing availability and DND through Calling preferences. A separate default-off consent shares recent managed call activity, labelled with its app or gateway source. Observations expire within 30 seconds and cannot extend a report beyond three minutes. Shared accounts do not imply shared call ownership; absence never establishes availability or reachability. All four clients keep observations separate from offline directories. Native visual acceptance and automatic reachability presence remain outstanding. Shared preferences do not imply that a person can answer.

For gateway-managed accounts, suspending a user prevents new managed sessions, gateway registrations and new calls, disables push delivery and invalidates the relevant server-side grants. Resume restores eligibility without changing unrelated local accounts. End an existing call only through a separate explicit termination action; normal licence changes should not silently cut a conversation off.

Users can set Do Not Disturb per customer from their own calling preferences. The gateway excludes all of that user's devices from new incoming calls and wake pushes, while colleagues assigned to the same calling account remain eligible. Already admitted calls retain their recipients and may finish ringing or connect; existing calls, registrations and outgoing calls continue. This is a user preference, visible to administrators, not evidence of reachability or presence. The portal, native API and preference controls in all four apps are implemented locally. Apps show server-confirmed values and an unavailable state after failed reads or uncertain saves. Updated direct clients receive the preference in their protected, expiring configuration and reject new incoming calls with 486 after refresh. Policy-only updates preserve registration and already admitted calls. Offline clients retain the previous policy until configuration expiry; older apps may ignore it. This is cooperative app enforcement, not an immediate PBX update.

For direct accounts, suspension blocks new provisioning and instructs connected clients to unregister and erase the managed configuration. Offline devices cannot acknowledge immediately, and previously copied upstream credentials remain valid until the PBX rotates or revokes them. Display that limitation and pending device acknowledgements; do not label it an immediate PBX suspension.

Use bounded offline configuration validity for cooperative clients, with the allowed period documented in policy. Server-enforced gateway access must consult revocation state; it cannot depend only on an unexpired, long-lived client token. Distinguish loss of the management API from deliberate suspension and keep established call handling independent of portal availability.

## Implementation shape

- **Portal and management API:** one deployable application with PostgreSQL for workspaces, memberships, assignments, configuration revisions and billing state. Nuxt is the proposed UI/server stack. Start with a maintained authentication solution that supports web sessions, MFA and native-client authentication.
- **Website entry:** retain sipper.dev's existing marketing and download routes; provide the portal at `sipper.dev/portal`. Its auth, forms, cookies, caching and CSP need their own application configuration rather than inheriting the static site's current `form-action 'none'` policy.
- **Provisioning:** one shared API contract for Mac, Windows, iOS and Android; platform-specific secure storage and UI. Current client models require explicit managed ownership metadata, not just reuse of the existing free-form `source` label.
- **Telephony:** separately operated Linux SIP gateway using established SIP software, push integration and a media relay where needed. The gateway is separate from the management application's request handling.
- **Event processing:** durable billing/provisioning/revocation jobs and device acknowledgements; use the simplest durable queue available in the selected deployment. Backups, restore checks, alarms and audited administration are release requirements.

Provisional core records: identities, workspaces, organisations, memberships, groups, subscriptions, seat assignments, devices, SIP configurations, secret references, configuration revisions and audit events. Avoid a generic policy engine or a service per table.

Gateway design must cover upstream registration renewal, incoming-call wakeup, caller cancellation, duplicate pushes, multi-device answering and SIP-provider interoperability. Demonstrate both single-registration and multiple-registration provider behaviour before claiming broad compatibility. A controlled pilot can start on one host; production availability and load targets must determine the failover design.

The local gateway acceptance covers two controlled Asterisk provider profiles over verified TLS with SHA-256 authentication and negotiated SDES SRTP. The strict profile rejects a second contact, renews during an established call and defers revision replacement until hangup, then unregisters the previous contact before expiry. The two-contact profile rings Sipper and a separate SIP phone, checks both possible winners, cancels losing branches and preserves exact Sipper device attribution. This supplies repeatable local signalling evidence; third-party provider interoperability, audible media and physical-device acceptance remain required.

## Delivery order and acceptance evidence

| Stage | Deliverable | Required evidence |
|---|---|---|
| 1. Managed desktop path | Signup, test-mode checkout, workspace/customer setup, seat assignment, invitation, Mac and Windows login/provisioning | A purchaser completes the entire flow without owner intervention; cross-tenant access is denied; duplicate billing events cannot add seats |
| 2. Managed operations and gateway | Device status, revision acknowledgement, suspension/revocation, registration gateway and push service | New gateway calls are denied after suspension; direct-mode limitations are visible; renewal and cancellation races behave correctly |
| 3. Mobile clients | iOS and Android using the same identities, licences and provisioning contract, with native call integration | Physical-device tests for locked/idle phones, two-way audio, hangup before answer, another-device answer, Bluetooth, cellular interruptions and network changes |
| 4. Public paid service | Live billing, supported platforms, documented service limits, store distribution and production operations | Live purchase and recovery paths verified, billing/support policies configured, deployment and restore tested, supported clients available |
| 5. Wider enterprise scope | SSO/SCIM, richer RBAC, shared directories, presence, messaging, video, conferencing and reseller integrations | Each feature has an explicit provider/service dependency and interoperability tests |

Stages are implementation milestones, not permission to market unavailable mobile or management features as delivered. Do not start collecting public payments for the planned service before the advertised path works and its scope is clear.

The messaging service and portal view now support participant-only customer
text conversations, owner-managed groups and cross-device read state using the existing
identity, PostgreSQL and encryption keys. Migrations 032/033 and the email worker
provide retained encrypted bodies and bounded cleanup. The shared Apple SDK and
Mac/iOS screens, Windows main-process client/renderer and Android client/screens
now consume this API. Group name, roster, ownership transfer and leaving are implemented, with post-join
history boundaries. iOS/Android also have separate opt-in generic message
notifications, reusing the push worker/providers through migration 034. Mac/Windows
have separate opt-in generic alerts while running through an owned-device unread
feed, with no additional provider key. Real provider/OS delivery and remaining native/production acceptance
remain open.
The API and retention limits are documented in [Messaging](MESSAGING.md).

## Store distribution and unresolved business choices

Web purchasing plus mobile sign-in has documented store-policy routes. Apple's free companion-app rule explicitly includes paid web-based VoIP tools, subject to its conditions; its enterprise-services rule has separate limits. Google Play permits consumption-only apps accessing purchases made elsewhere. Review the actual combined standalone/managed app, consumer push offering and purchase links against current storefront rules before submission; approval is not implied by the architecture. [Apple guidelines 3.1.3](https://developer.apple.com/app-store/review/guidelines/) · [Google Play payments guidance](https://support.google.com/googleplay/android-developer/answer/10281818)

Resolve the current GPL/PJSIP dependency licensing path for App Store distribution before committing to a mobile release. Keep source-distribution obligations and hosted-service subscriptions as separate decisions.

Before activating live sales, confirm: cross-organisation seat counting and device policy; prices/currency and billing periods; standalone push packaging; seller/payment account; refund, trial, tax and failed-payment policies; service region and retention; the supported platform/feature scope sold at launch. These decisions do not prevent building and testing the managed desktop flow with explicit test products and fictional accounts.
