# Release readiness, 23 October 2026

Sipper's web and server services are deployed on cd-main. It is not yet an
accepted replacement for Bria Enterprise.
The earlier [v1 handover](SIPPER-V1-HANDOVER.md) records a frozen local baseline;
it does not certify live deployment or full feature parity.

The owner switched the pilot target to the existing `cd-main` Docker host on
23 October 2026, retaining `sipper.dev`, Plunk's Connect Dorset project and disabled
payments. Host checks confirmed 24 CPU cores, 125.8 GiB RAM, about 91 GiB available
RAM and 218 GiB free disk before installation. Public IPv4 is `176.227.215.65`.
Sipper's website, portal, database, workers, meeting media/signalling, edge,
Asterisk and controller are running there. All 37 migrations and restricted
gateway grants completed. The
private database uses verified TLS and a non-superuser application role.
The owner explicitly requested setup without a PBX or pilot calls. The gateway
has a current lease/heartbeat, an empty approved-host list and zero endpoints.
It reports not ready for calls and creates no upstream routes. Public SIP TLS
on port 5061 verifies; no external registration or call was attempted.

The five baseline AMD64 images use commit
`288a338d63b27aeb11d5938adcee3ecb8e078da4`, with archive checksum and image
configuration digests verified against the passing
[CI release](https://github.com/hybes/sipper/actions/runs/39949197712).
Deployment startup exposed unquoted comma-separated tmpfs settings in two Compose
files. The correction is committed as `bbfcec4`, checked by the shared ingress
regression test and verified by successful startup of the actual services.
The controller and meeting-signalling services now use
`sipper-controller:6dc471cfe7abd190a7fbacdc07177fdfda28aad1`, built locally for
AMD64 from the committed source. Its transferred checksum and configuration
digest `sha256:a9a678be3e58e143be7c174f1ec907cf9398353800b80fd6e2d20c4bf6fe6075`
match the loaded image. That source also passed the subsequent
[managed-platform CI run](https://github.com/hybes/sipper/actions/runs/39958618767);
the installed controller archive is recorded as a local build, not a CI artifact.
Host source also includes encrypted scheduled backup tooling in `ce7e4d3`.

Public cutover is complete. The old Worker's two custom-domain bindings are
removed, while the Worker and its versions are retained. DNS-only A records for
`@`, `www`, `sip` and `meet` point to cd-main, with no AAAA records for those names.
Both authoritative nameservers and a public resolver agree. The six Plunk email
records are preserved. All four public HTTPS names verify with a Sipper-only
certificate expiring 21 January 2027. SIP certificate synchronisation succeeded
and its six-hour timer is enabled. TCP 80, 443, 5061 and 7882 are reachable.
Website, support/privacy, portal sign-in/sign-up, health and OAuth discovery pass
through the actual proxy. Direct edge access is denied; unauthenticated platform
and gateway APIs return 401, and invalid/missing meeting tokens return 403.
The existing Coolify HTTPS endpoint remains available.

Public Chromium checks at 1440px and 390px pass for the website, support/privacy
and sign-in/sign-up pages, including empty signup validation. No broken images,
horizontal document overflow or browser errors were observed. Download routes
still target the existing standalone 0.1.0 releases. The owner completed signup,
email verification and MFA. After explicit approval for that exact account,
the existing grant script assigned platform-owner access and recorded one audit
event. The live UI exposes the owner controls. Manual and automatic service-status
refresh both return current samples: all three workers are polling, and the
gateway correctly reports not ready with no PBX configured. Automatic refresh
pauses while Chromium reports the tab as hidden and resumes in the foreground.
The live workspace, team and activity views load; owner pilot controls are
available at 1440px and 390px without document overflow or page errors. Checkout
and local test-billing controls are absent. No pilot capacity has been granted.

The daily encrypted backup service succeeds both directly and under systemd.
It creates a database dump over verified TLS using the application role, and a
separate encrypted archive of Sipper's private configuration. Both must complete
before a timestamped snapshot and checksum manifest are published. The first
snapshot is `/var/backups/sipper/20261023T132753Z`; its archive checksums match.
The timer runs at 03:30 UTC with up to ten minutes of jitter. The recovery key
is private on the owner's Mac and only the public recipient is on cd-main.
With explicit approval, snapshot `20261023T135311Z` was copied to the Mac's
Git-ignored `infra/.private/recovery/snapshots` directory. Both archive checksums
match and full decryption authenticates. The actual database backup was restored
into a temporary, network-isolated PostgreSQL container with all database files,
the recovery identity and decrypted data on tmpfs. The verified MFA account,
owner, workspace and all 37 migrations were recovered. Recovery hold remained
active, sessions and pending jobs were cleared, the application role remained
non-superuser, and a second restore into the populated target was refused. The
container was removed; no plaintext backup was saved to disk. This establishes
one verified off-host copy and restore. Regular off-host transfer, retention,
independent key escrow and alerts remain unconfigured. The existing Uptime Kuma
dashboard requires sign-in.

The earlier Hetzner host, `116.203.89.206`, remains **preparation only** with 1 GB
RAM. Docker Engine 29.9.2 and Compose 5.6.1 are installed there; Sipper services
remain stopped. Reviewed source is staged there at `/opt/sipper`. Pinned PostgreSQL,
Caddy and LiveKit images are present. CI candidates are kept privately under
`/opt/sipper-staging/671f7cdb6aeafcf38729a271c4fefe1591a3e0c5`; the Windows installer
and Linux archive are staged there, with checksums and source manifests. All five
reviewed AMD64 service images are loaded and their configuration digests match
CI. The Windows candidate still has version 0.1.0 and must not replace the
existing public release. Nothing is published or started by staging these files.
Plunk SMTP connectivity from the Hetzner host to the dashboard's
`next-smtp.useplunk.com:2587` endpoint passes with verified TLS 1.3. The owner
selected the existing Connect Dorset project; `sipper.dev` has been added and
its six email DNS records match both authoritative nameservers and a public
resolver. Plunk confirmed the sending domain as verified on 23 October 2026;
SMTP authentication on cd-main now passes with response 235 over verified TLS 1.3.
The approved key is stored privately there. The owner's signup email verification
completed through the live service; invitation delivery remains unverified.
No operator test email was sent. Shared project tracking remains enabled.
See the [shared-host deployment guide](../infra/SHARED-HOST.md) and the retained
[Hetzner preparation record](../infra/SINGLE-HOST.md).

## Implemented and checked in this review

- Self-hosted website and Caddy routing for the portal, native OAuth discovery
  and meeting admission. Download visibility is shared with the existing Worker.
  The site describes standalone downloads separately from the managed pilot.
- Owner-only expiring pilot licences, verified identity/MFA enforcement,
  allocated-seat limits, audit events, safe retries and stale-edit rejection.
  Existing paid subscriptions cannot be replaced by pilots; local test billing
  cannot alter pilots, and paid conversion requires deliberate operator review.
  Expired pilots are labelled correctly in the workspace list; an open workspace
  updates its expiry badge and removes available capacity without a reload.
- Fresh private configuration generation, separate database roles, verified
  database TLS, limited gateway views, private service ports and SIP certificate
  renewal tooling. No real production secrets belong in the repository.
- Shared-host overlay with bounded resources, only the edge on the existing
  proxy network, no published web origins, and exact-proxy client-address trust.
  Traefik certificate selection is limited to Sipper hostnames. Local checks
  cover HTTPS, forged headers, neighbouring-container rejection, another site's
  routing and resolved temporary filesystem mounts. Actual host checks confirm
  service isolation and proxy routing; public HTTPS and SIP TLS now verify.
- Real browser checks at desktop and mobile sizes: website pages/navigation,
  login/MFA, pilot grant, expiry error, saved-value reload, audit history and
  ordinary-administrator restrictions. No horizontal document overflow or
  uncaught page errors was observed in those flows.

Current automated results: portal 158 passing; website 14 passing; gateway
23 Node and 4 Python checks; extension 39. Seven backup publication/failure tests
pass locally and on cd-main, including partial cleanup, refusal to overwrite,
missing recipients and configuration-archive failure after a successful dump.
The backup revision passed the full
[managed-platform CI run](https://github.com/hybes/sipper/actions/runs/39961288034),
including production ingress/runtime and the controlled recovery rehearsal. The
[Windows CI run](https://github.com/hybes/sipper/actions/runs/39923783193)
compiled PJSIP and the native engine with MSVC, passed 126 model checks and
28 native checks (2 opt-in checks skipped), packaged the NSIS installer and
passed all 6 packaged-app checks. Registration, outgoing/incoming calls,
missed-call history and second-launch link import use a fictional PBX and null
audio; these checks do not establish physical audio or managed OAuth acceptance.
The same desktop UI checks also pass on this Mac. Mac checks passed 172,
with 11 optional checks skipped. Android debug assembly, unit tests and lint
passed; iOS Release compiled without signing. Portal typecheck/production build
and the website/portal container builds passed. The disposable ingress and
production-settings runtime rehearsals passed. The original six SIP certificate
checks passed on both the Mac and Hetzner's OpenSSL, including hostname, key and
near-expiry rejection before interrupting a running gateway. Current local
coverage passes 12 certificate checks, including shared Traefik store selection
and rejection of certificates containing another site's hostname. Both ingress
modes and the production-settings runtime rehearsal pass locally after the
shared-host changes.

The encrypted backup/restore rehearsal passes: wrong keys, damaged archives,
populated targets and partial restores are rejected; restored grants/jobs are
quarantined until explicit release. Real portal/worker containers restart, a
frozen worker becomes unhealthy, and resuming it restores health. This rehearsal
also passed in the final
[Linux CI run](https://github.com/hybes/sipper/actions/runs/39923783161).
These are controlled acceptance checks, not evidence of
mobile push, physical audio or public calling-provider operation. The separate
live-backup restore described above verifies the current small deployment's
off-host recovery, not a full replacement-host cutover or capacity claim.

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
| Mac, Windows, iOS and Android | Implementations and build/test coverage exist; Windows CI installer and packaged call flows pass | Current versioned distribution, Windows hardware/managed OAuth acceptance, mobile signing and store/test distribution |
| SIP accounts and call control | Multiple accounts, hold, mute, DTMF, blind/attended transfer and local conferences | Real PBX compatibility and physical audio/Bluetooth/network handover on each platform |
| Managed mobile incoming calls | Gateway, device claims and push adapters implemented | Real APNs/FCM projects, credentials, locked/idle-device delivery and OS call-UI acceptance |
| Central administration | Workspaces/resellers/customers, roles, MFA, licences, devices, configuration, enrolment and audit; live owner bootstrap and signup email verification complete | Invitation delivery, pilot enrolment and broader operational acceptance |
| Company identity and contacts | OIDC SSO, SCIM, directory and group assignments | Real identity-provider/SCIM integration; equivalent cross-platform personal-contact/history synchronisation is incomplete |
| Presence and messaging | Shared user status/DND, direct/group messages and server retention | Rich automatic presence, messaging attachments/file transfer and message search remain gaps |
| Meetings and video | Managed LiveKit rooms, admission and client meeting interfaces | Native screen publishing, phone-interruption handoff, TURN/TLS and device/media acceptance; this does not supply SIP video calling |
| Diagnostics and administration | Device/registration/activity views, audit and support diagnostics | Equivalent call-quality MOS/jitter/loss reporting and broader enterprise helpdesk tooling remain gaps |
| Production operations | Live public DNS/HTTPS/SIP TLS, renewal timer, private ingress, daily encrypted backups and one verified off-host copy/restoration | Capacity, recurring off-host transfer/retention, independent key escrow, replacement-host recovery, monitoring and a real alert destination |

## Gates before public pilot acceptance

1. Grant the pilot and exercise invitation delivery,
   enrolment, directory, licence expiry and revocation using current apps.
   Owner signup/email verification, MFA, public DNS/HTTPS, SIP certificate renewal
   setup and SMTP authentication are complete.
2. Configure mobile providers before claiming background ringing. PBX setup and
   pilot calls were explicitly deferred; leave the upstream allowlist empty
   until a provider is chosen. Audio, transfer, permissions and network-change
   acceptance remain unverified rather than being required for this installation.
3. Complete signed versioned app distribution and operating-system acceptance;
   retain matching source and licence notices. Do not overwrite old 0.1.0 assets
   with different binaries.
4. Configure recurring off-host backup transfer, independent key escrow, retention
   and alerts, then rehearse replacement-host recovery. Explicitly close the
   functional
   gaps above before describing Sipper as having Bria Enterprise parity.

Payments remain disabled throughout these gates. No accepted public launch,
mobile background-call reliability or full parity is claimed by this review.
