# Sipper on cd-main

The owner selected `cd-main` for the pilot on 23 October 2026. The services now
run on that Docker host, with Plunk's existing Connect Dorset project for email
and payments disabled. The old 1 GB Hetzner server remains preparation only.

Coolify at `https://host.cnnct.uk` reports 24 CPU cores, 125.8 GB RAM, Debian 13,
Docker 29.8.1 and Compose 5.5.1. Its proxy configuration uses Traefik v3.7 with
`http` and `https` entrypoints. The dashboard sample at 11:20 UTC showed 12.9%
CPU and 27.9% memory use. SSH checks subsequently confirmed about 91 GiB available
RAM and 218 GiB free disk space before installation, with no conflicts on Sipper's
media ports. These observations support a small pilot; they are not a measured
call or meeting capacity. Tailscale identifies `cd-main` at `100.110.61.97`.
The host interface confirms public IPv4 `176.227.215.65`; TCP 80, 443 and 7882
are reachable from outside the server. WebRTC media acceptance remains open.

**Current state:** source is installed at `/opt/sipper`, private settings at
`/etc/sipper`, and the five baseline AMD64 images from
`288a338d63b27aeb11d5938adcee3ecb8e078da4` are loaded. The downloaded archive
checksum and all image configuration digests match the passing
[CI release](https://github.com/hybes/sipper/actions/runs/39949197712).
The executable source includes the mount-parsing fix in `bbfcec4`, the idle
gateway support in `6dc471c` and the encrypted backup tooling in `ce7e4d3`.
Controller and meeting-signalling services use the AMD64 controller image from
`6dc471cfe7abd190a7fbacdc07177fdfda28aad1`. Its local Buildx build, archive checksum
and image configuration digest are recorded under
`/opt/sipper-staging/6dc471cfe7abd190a7fbacdc07177fdfda28aad1/gateway`.
This controller was built locally from the committed source, separately from
the subsequently passing [CI run](https://github.com/hybes/sipper/actions/runs/39958618767).
All 37 migrations and restricted gateway grants completed. PostgreSQL, website,
portal, email/push/meeting workers,
meeting media/signalling, the edge, Asterisk and the controller are running.
The owner explicitly requested installation without a PBX or pilot calls. The
gateway has a current controller lease/heartbeat, no endpoints and an empty
upstream allowlist. It reports **not ready for calls** and denies all upstream
routes. No registration or external call was attempted.

The approved Connect Dorset Plunk key is stored in `/root/sipper-smtp.env` with
mode 0600 and copied into the private portal configuration. SMTP AUTH returned
235 over verified TLS 1.3; no operator test email was sent. Plunk marks `sipper.dev`
as verified. The owner subsequently completed signup email verification and MFA.
After explicit approval for the exact account, the existing owner-grant script
succeeded and recorded its audit event. The live UI shows platform-owner controls.
Invitation delivery and pilot enrolment remain unverified.

**Public cutover is complete:** only the old website Worker's `sipper.dev` and
`www.sipper.dev` custom-domain bindings were removed. The Worker and its old
versions remain available. DNS-only A records for `@`, `www`, `sip` and `meet`
point to `176.227.215.65`; no AAAA records remain for those names. Both Cloudflare
nameservers and `1.1.1.1` agree. All six Plunk DNS records were preserved.
Public HTTPS verifies for all four names using a Sipper-only certificate expiring
21 January 2027. The public SIP TLS handshake on port 5061 also verifies.
The certificate-sync service succeeded and its six-hour timer is enabled.

Checks against the running services pass for the website, support/privacy pages,
portal sign-in/sign-up, health and OAuth discovery through the actual trusted
proxy. Public Chromium checks at 1440px and 390px show no broken images, document
overflow or browser errors; empty signup is rejected before any request.
Download redirects still target the existing standalone 0.1.0 releases. Missing
or invalid meeting tokens receive 403; unauthenticated management/gateway APIs
receive 401. Direct edge access is rejected, PostgreSQL uses TLS with a non-superuser
application role, and payment settings are disabled. Coolify's existing public
HTTPS endpoint still responds. The live owner service dashboard passes manual and
automatic refresh: workers report polling and the idle gateway reports not ready.
Workspace, team, activity and owner pilot controls load at desktop and mobile
sizes without document overflow or page errors. Checkout and local test billing
are unavailable, and no pilot capacity has been granted.
These checks do not establish invitation/enrolment workflows, working calls or
meeting audio/video.

Encrypted database/configuration backups now run daily at 03:30 UTC with up to
ten minutes of jitter. The first snapshot, `20261023T132753Z`, is under
`/var/backups/sipper`; its two archive checksums match the manifest. The recovery
identity is held at `infra/.private/recovery/age-identity.txt` in the original
Mac checkout, outside Git, and only its public
recipient is on cd-main. With explicit approval, the newer snapshot
`20261023T135311Z` was copied to the Mac's Git-ignored
`infra/.private/recovery/snapshots` directory. Both checksums match and both
archives fully decrypt and authenticate. Its database was restored into an
isolated, network-disabled container using tmpfs for the recovery identity,
decrypted archive, PostgreSQL data and WAL. The owner, verified MFA account,
workspace and all 37 migrations were recovered. Recovery hold stayed active;
sessions and pending jobs were cleared, the application role was non-superuser,
and restoring again into that populated target was refused. The container was
removed and no plaintext archive was saved to disk. A private verification record
is retained beside the encrypted snapshots. This is one verified off-host copy
and restore; recurring transfer, retention, independent key escrow, replacement-host
recovery and alert delivery remain open.
The backup changes also passed the full
[managed-platform CI run](https://github.com/hybes/sipper/actions/runs/39961288034),
including ingress, production runtime and controlled recovery rehearsals.

## Proxy and service layout

The wrapper in `single-host/compose.sh` reads `SIPPER_DEPLOYMENT_MODE` from the
private deployment file. With `shared`, it adds `compose.shared-host.yml` after
the existing application, meeting, gateway and single-host overlays. Existing
dedicated-host settings retain their original behaviour.

Traefik terminates HTTPS and discovers routes for only `sipper.dev`,
`www.sipper.dev`, `sip.sipper.dev` and `meet.sipper.dev` through Sipper's container
labels. Sipper publishes no HTTP/HTTPS ports. Its Caddy edge is the only Sipper
container connected to the existing proxy network; the database, portal,
workers, website and signalling services stay on Sipper's separate network.
Portal and meeting origins have no published host ports in this deployment.

Caddy accepts requests only from Traefik's exact container IP. It checks the
forwarded address chain from the nearest hop, then replaces the internal
authentication and client-address headers before forwarding portal requests.
It shares the same routes and response protections as the dedicated-host setup.
See [Caddy's trusted proxy settings](https://caddyserver.com/docs/caddyfile/options#trusted-proxies).
If Traefik is recreated with a different IP, update `SIPPER_TRAEFIK_IP` in the
private deployment file and recreate only Sipper's `proxy`. Until corrected,
the edge rejects the new source rather than trusting the entire shared subnet.

Every Sipper service has CPU, memory and process limits. Steady-state memory
limits total 7.75 GiB with calling and meetings enabled; the migration job has
an additional 1 GiB limit while it runs. These are ceilings, not reservations or
evidence of supported concurrency. Observe call quality and actual usage during
the pilot before changing them.

## Prepare and validate

First inspect the actual proxy network, container IP, certificate resolver and
ACME storage path. Keep the existing proxy and other applications running.
Check free disk space, memory, and whether another service already uses TCP
5061/7882 or UDP 20000–20199/7883. Those media ports must be reachable directly;
an HTTPS proxy does not carry the media. Keep the gateway stopped until its
certificate is configured. It may then run with an empty PBX allowlist, which
keeps calling unavailable.

Stage reviewed source at `/opt/sipper`, load matching AMD64 images, and put the
approved Plunk SMTP settings in `/root/sipper-smtp.env` with mode 0600. The exact
dashboard endpoint is `next-smtp.useplunk.com:2587`, using mandatory STARTTLS,
username `plunk` and sender `Sipper <accounts@sipper.dev>`. Test SMTP AUTH without
sending a message first. Account/invitation delivery needs a separate acceptance
test. Do not alter tracking for the other sites in the shared Plunk project.

Use actual inspected values in place of the uppercase placeholders:

```sh
python3 infra/single-host/prepare.py \
  --public-ip 176.227.215.65 \
  --smtp-env /root/sipper-smtp.env \
  --release REVIEWED_IMAGE_COMMIT \
  --proxy-network EXISTING_PROXY_NETWORK \
  --traefik-ip EXACT_PROXY_IP \
  --traefik-resolver EXISTING_CERTIFICATE_RESOLVER \
  --traefik-acme-file /absolute/path/to/existing/acme.json

sh infra/single-host/compose.sh --profile meetings --profile calling config --quiet
```

Preparation refuses existing private settings. Do not rerun it over a live
deployment or rotate its authentication/encryption keys during updates. Only
`config --quiet` is suitable for shared logs; full Compose output includes
secrets. Use `--upstreams` with approved PBX hostnames when preparing calling.

The baseline images on `cd-main` use release
`288a338d63b27aeb11d5938adcee3ecb8e078da4`. The archive, checksum, CI manifest and
verified deployed-image manifest are retained under
`/opt/sipper-staging/288a338d63b27aeb11d5938adcee3ecb8e078da4/linux`.
The controller and meeting-signalling image uses the later `6dc471c` revision
described above. Compose and backup changes need no application image rebuild.
Record source and image revisions separately. The older Hetzner preparation
still has its earlier images.

## Start and cut over

After the host checks and private settings are complete, use the migration,
database grant and startup steps in the [dedicated-host guide](SINGLE-HOST.md#start-after-preparation-and-capacity-checks).
The same wrapper selects the shared overlay from the private deployment file.
Start the calling profile after installing the SIP certificate. With no PBX
approved, leave `SIPPER_UPSTREAM_HOSTS` empty: the controller stays online but
reports not ready, and no upstream routes are created. When a PBX is selected,
approve its exact hostname and recreate the controller before enabling accounts.
Payments remain disabled.

The DNS-only A records for `@`, `www`, `sip` and `meet` now point to
`176.227.215.65`. The six Plunk email records are preserved; the old placeholder
AAAA records and website Worker custom-domain bindings are removed. Test the
website, management login, native
OAuth discovery and meeting admission from outside the server. Verify existing
applications still serve normally after Sipper is added.

Traefik issues a certificate covering only the four Sipper hostnames. The
existing `sync-sip-certificate.py` recognises shared mode and reads the selected
resolver's ACME store on the host. It decodes only the Sipper certificate/key;
it never copies the shared store or another site's key into Sipper. It checks
the actual certificate names, remaining validity and matching key before
installing the pair in `gateway-tls`. Ambiguous certificates fail before any
gateway is stopped. The existing timer and graceful call drain remain applicable.

## Acceptance and operations

Finish pilot licensing and enrolment, signed app distribution, regular
off-host backups, independent key escrow, replacement-host restore drills and
alerts before accepting the pilot. PBX/media acceptance was explicitly deferred
by the owner; deployment
does not establish interoperability. Shared hosting also means host restarts and
resource
problems can affect Sipper alongside the other applications. The broader gaps
remain in [release readiness](../docs/RELEASE-READINESS.md).

Local checks for this deployment are:

```sh
python3 infra/single-host/test-certificate.py
python3 infra/single-host/test-backup.py
python3 infra/single-host/test-ingress.py
python3 infra/single-host/test-ingress.py --shared
python3 infra/single-host/test-runtime.py
```

The shared ingress check uses the pinned Traefik v3.7 and Caddy images in
disposable containers. It verifies TLS, routes, client addresses, forged-header
rejection, denial of direct/nearby-container access, another site's routing,
private origins, resource limits and resolved temporary filesystem mounts. It does not contact a public PBX, request
real certificates or send email.
