# Release readiness, 23 October 2026

Sipper is not yet a deployed, accepted replacement for Bria Enterprise.
The earlier [v1 handover](SIPPER-V1-HANDOVER.md) records a frozen local baseline;
it does not certify live deployment or full feature parity.

The owner selected one Hetzner host, `116.203.89.206`, and `sipper.dev`, with
Plunk for email and payments disabled. SSH access is now verified. The host has
1 GB RAM, and the owner explicitly selected **preparation only** until it can be
resized. Public cutover and full-stack calling/meeting startup remain on hold.
Docker Engine 29.9.2 and Compose 5.6.1 are installed on the host; Sipper services
remain stopped. The new Linux CI workflow builds and checks versioned service
images for staging without building on this small server.
See [the single-host deployment guide](../infra/SINGLE-HOST.md).

## Implemented and checked in this review

- Self-hosted website and Caddy routing for the portal, native OAuth discovery
  and meeting admission. Download visibility is shared with the existing Worker.
  The site describes standalone downloads separately from the managed pilot.
- Owner-only expiring pilot licences, verified identity/MFA enforcement,
  allocated-seat limits, audit events, safe retries and stale-edit rejection.
  Existing paid subscriptions cannot be replaced by pilots; local test billing
  cannot alter pilots, and paid conversion requires deliberate operator review.
- Fresh private configuration generation, separate database roles, verified
  database TLS, limited gateway views, private service ports and SIP certificate
  renewal tooling. No real production secrets belong in the repository.
- Real browser checks at desktop and mobile sizes: website pages/navigation,
  login/MFA, pilot grant, expiry error, saved-value reload, audit history and
  ordinary-administrator restrictions. No horizontal document overflow or
  uncaught page errors was observed in those flows.

Current automated results: portal 158 passing; website 14 passing; gateway
21 Node and 4 Python checks; extension 39; Windows models 125 and native engine
28 passing with 2 opt-in checks skipped on this Mac. Mac checks passed 172,
with 11 optional checks skipped. Android debug assembly, unit tests and lint
passed; iOS Release compiled without signing. Portal typecheck/production build
and the website/portal container builds passed. The disposable ingress and
production-settings runtime rehearsals passed. These results are local evidence,
not evidence of Windows hardware, mobile push or public provider operation.

## Bria comparison and remaining scope

The comparison uses CounterPath's current
[Bria Enterprise](https://www.counterpath.com/bria-enterprise/),
[softphone](https://www.counterpath.com/softphone-clients/),
[provisioning](https://www.counterpath.com/voip-provisioning/) and
[management](https://www.counterpath.com/management-tools/) descriptions.
The table describes Sipper's source and recorded acceptance, not a claim of
equivalent quality or availability.

| Area | Sipper state | Remaining work or evidence |
| --- | --- | --- |
| Mac, Windows, iOS and Android | Implementations and build/test coverage exist | Current versioned distribution, actual Windows acceptance, mobile signing and store/test distribution |
| SIP accounts and call control | Multiple accounts, hold, mute, DTMF, blind/attended transfer and local conferences | Real PBX compatibility and physical audio/Bluetooth/network handover on each platform |
| Managed mobile incoming calls | Gateway, device claims and push adapters implemented | Real APNs/FCM projects, credentials, locked/idle-device delivery and OS call-UI acceptance |
| Central administration | Workspaces/resellers/customers, roles, MFA, licences, devices, configuration, enrolment and audit | Real owner bootstrap, email delivery, pilot enrolment and operational acceptance |
| Company identity and contacts | OIDC SSO, SCIM, directory and group assignments | Real identity-provider/SCIM integration; equivalent cross-platform personal-contact/history synchronisation is incomplete |
| Presence and messaging | Shared user status/DND, direct/group messages and server retention | Rich automatic presence, messaging attachments/file transfer and message search remain gaps |
| Meetings and video | Managed LiveKit rooms, admission and client meeting interfaces | Native screen publishing, phone-interruption handoff, TURN/TLS and device/media acceptance; this does not supply SIP video calling |
| Diagnostics and administration | Device/registration/activity views, audit and support diagnostics | Equivalent call-quality MOS/jitter/loss reporting and broader enterprise helpdesk tooling remain gaps |
| Production operations | Container and recovery tooling, private ingress and TLS rehearsal | Capacity, public DNS/HTTPS, backup/key escrow, off-host recovery, monitoring and a real alert destination |

## Gates before public pilot acceptance

1. Resize the host, configure Plunk and its DNS, and finish staging the reviewed
   source/images. Enable and verify the actual HTTPS service before public cutover.
2. Verify the owner's email/MFA, grant the pilot and exercise invitation,
   enrolment, directory, licence expiry and revocation using current apps.
3. Configure the actual PBX and mobile providers. Check inbound/outbound audio,
   transfer, background ringing, device permissions and network changes.
4. Complete signed versioned app distribution and operating-system acceptance;
   retain matching source and licence notices. Do not overwrite old 0.1.0 assets
   with different binaries.
5. Finish backup/restore and alert acceptance, and explicitly close the functional
   gaps above before describing Sipper as having Bria Enterprise parity.

Payments remain disabled throughout these gates. No live deployment, paid launch,
mobile background-call reliability or full parity is claimed by this review.
