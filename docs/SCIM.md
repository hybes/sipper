# SCIM user provisioning

SCIM connects an identity provider to one Sipper customer. Company sign-in is a
separate OpenID Connect connection. A provisioning token grants no authentication
authority and does not need an OIDC client secret. This implementation has local
service and HTTP checks; real identity-provider interoperability remains required.

## Setup

1. Apply portal migrations through `024-scim.sql` and deploy the matching portal.
   Set the existing `SIPPER_BASE_URL` to the public HTTPS origin and retain the
   edge/origin authentication configuration described in the portal environment
   example. There are no additional global SCIM keys.
2. Open the customer, choose **More → User provisioning**, and create a token.
   Administrator MFA is required. Copy the displayed base URL and bearer token
   into the provider's SCIM 2.0 provisioning connector. The token is shown once;
   closing the page does not preserve it. Sipper stores only its SHA-256 hash.
3. Map `userName` to the exact sign-in email, `active` to the user's enabled state,
   and optionally `externalId`, `displayName`, `name` and `emails`. Do not map
   passwords, roles or entitlements. Groups use `displayName`, optional
   `externalId` and `members[].value` containing Sipper's returned SCIM User IDs.
   Nested groups and contacts are not group members.

Use a disposable customer for the first provider run. Verify creation, lookup,
profile update, group changes, suspension, deletion, retries and token rotation
before enabling a customer with real users. The endpoint does not claim support
for every provider's default attribute mapping or filter dialect. Adjust mappings
to the contract below and retain failed provisioning events in the provider's
own diagnostics without logging bearer tokens or full request bodies in Sipper.

Tokens expire after 365 days. Rotation keeps the connection and resources but
immediately invalidates its old token, including requests waiting for the
customer lock. Update the provider with the replacement token. The portal's last
request timestamp includes authenticated requests that subsequently fail; it
does not prove a successful sync or working sign-in.

## Access lifecycle

- A matching, verified Sipper identity receives a customer **User** membership.
  Other emails stay pending. After verified web or native sign-in, the existing
  authenticated API path links the identity and its provisioned groups. SCIM
  never creates a password or overrides the person's global account profile.
  Sipper does not send an invitation email for SCIM creation.
- A licence must be assigned separately in the billing workspace. One named user
  uses one seat across their devices and customers in that workspace. SCIM does
  not increase, allocate or release paid seats.
- `active: false` blocks new customer access using the existing suspension rules.
  An inactive pending record cannot join. Resumption restores eligibility only
  when the normal membership/licence checks pass. A normal suspension in Sipper
  is visible through SCIM and can be changed by a later provider update.
- User deletion removes this customer membership, assignments and group links,
  revokes its devices and push endpoints, and invalidates setup/invitation links.
  Other customers, global authentication, workspace staff roles, personal SIP
  accounts, paid seats and established calls are preserved. Offline clients may
  retain settings until expiry. Direct SIP credentials need revocation at the
  phone system for immediate enforcement.
- Deleting and subsequently recreating a SCIM-removed user returns a new SCIM ID.
  A previous SCIM removal can restore customer membership, but old devices stay
  revoked and calling assignments must be recreated. A manual removal cannot be
  reversed by a connector. Acceptance of a new manual invitation removes the
  old SCIM record's authority.
- Existing manual memberships cannot be silently adopted. Administrator roles
  and manually removed/rejoined members are protected from SCIM user mutations.
  A pending identity that acquires a manual membership is also protected. These
  conflicts appear as **Needs attention** in the portal. Resolve ownership with
  the customer's administrator; automatic migration/adoption is not implemented.
- SCIM owns its group names and membership, including people awaiting sign-in.
  Administrators assign calling accounts to the groups in Sipper. Deleting a
  group removes its assignments, not the underlying calling accounts or users.
- Revoking or expiring the token stops new provider requests. Previously
  provisioned active people can still sign in and join; it does not withdraw
  their existing authorisation. Suspend/remove users before disconnecting a
  provider when access should stop. Token revocation does not end calls.

`userName` is immutable because it is the verified identity binding. Changes of
email or identity provider need an operator-assisted migration; changing an
optional `emails` value does not change the sign-in identity.

## HTTP contract

Base URL: `{SIPPER_BASE_URL}/api/scim/v2/{customer-id}`. Use
`Authorization: Bearer <token>`. Browser sessions and native OAuth tokens cannot
authorise SCIM. Tokens only address their own customer. JSON responses use
`application/scim+json` with `Cache-Control: no-store`.

| Resource | Supported operations |
|---|---|
| `ServiceProviderConfig` | GET capabilities and authentication scheme |
| `Schemas`, `Schemas/{schema-URN}` | GET supported core User and Group metadata |
| `ResourceTypes`, `ResourceTypes/User`, `ResourceTypes/Group` | GET resource metadata |
| `Users`, `Groups` | GET list; POST create |
| `Users/{id}`, `Groups/{id}` | GET, PUT, PATCH, DELETE |
| `Users/.search`, `Groups/.search` | POST search with the SCIM SearchRequest schema |

Create returns 201 with `Location`, `ETag` and resource metadata. Updates return
200; deletion returns 204, and later reads/deletes return 404. Resource updates
accept `If-Match` with the returned weak ETag; a stale version fails with 412.
PATCH operations are atomic. Repeated additions of an existing group member or
email do not change the resource version. Empty removals of group membership are
idempotent. Manual membership changes also update the corresponding User version.

PATCH supports add/replace/remove for the mapped attributes. It accepts `name`
or individual supported name subattributes, whole `emails` arrays, whole
`members` arrays and `members[value eq "<SCIM-user-id>"]` for member removal.
Complex name replacements preserve unspecified subattributes. Adding emails
preserves existing values and a new primary email clears earlier primary flags.
Filtered email subattributes and other complex filter paths are not supported.
Add/replace require a value; removing `userName`, `active` or a group's required
`displayName` is rejected. Attribute and operation names are case-insensitive.

Lists accept `startIndex` (one-based) and `count` (0–100), with `totalResults`,
`itemsPerPage` and `Resources`. Filters support one literal `eq` comparison on
`id`, `externalId`, `displayName`, or User `userName`. External IDs are case
sensitive; other supported equality filters ignore case. Unsupported operators
and compound filters are rejected. Attribute selection supports top-level
`attributes` or `excludedAttributes`, retaining `id` and `schemas`. POST search
uses arrays for those selectors. There is no bulk endpoint, sorting, password
change, SCIM administrator-role mapping or automatic seat allocation.

Each token allows 600 authenticated requests per minute, including invalid
resource requests. Excess requests return 429 and `Retry-After: 60`; invalid,
expired or revoked tokens return 401. Request bodies are limited to 1 MiB,
PATCH to 100 operations, groups to 1,000 users, and user emails to 10 entries.
SCIM writes are serialised per customer using its existing management lock;
large imports may need pacing. The portal user list uses customer-bound cursor
pagination with 50 entries per page, email A–Z order and literal name/email search.

The implementation follows the supported portions of
[RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) and
[RFC 7644](https://www.rfc-editor.org/rfc/rfc7644). Unsupported extensions are not
a promise of provider compatibility. No real provider tenant or certification
was used to validate this implementation.

## Verification

From `portal/`, `pnpm test` runs the dedicated test database and SCIM regressions.
`pnpm typecheck` and `pnpm build` validate the application. With the local built
preview and the existing fictional MFA browser fixture available, run:

```sh
NODE_ENV=development node --env-file-if-exists=.env --import tsx scripts/scim-http-smoke.ts
```

The script requires a loopback development origin, authenticates the fictional
fixture, exercises the real management/SCIM routes, then deletes its temporary
workspace and audit records. It never logs the token or accesses a real PBX.
It checks cookie/origin denial, body limits, SCIM headers/errors, versions,
user-only membership, managed groups, rotation, rate limits and revocation.
Service tests additionally cover pending verified-identity claims, concurrent
creation, cross-customer access, manual protection, retained seats and calls.
