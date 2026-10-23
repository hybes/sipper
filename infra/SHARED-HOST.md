# Sipper on cd-main

The owner selected `cd-main` for the pilot on 23 October 2026. Everything will
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
`/etc/sipper`, and all five AMD64 images from
`288a338d63b27aeb11d5938adcee3ecb8e078da4` are loaded. The downloaded archive
checksum and all image configuration digests match the passing
[CI release](https://github.com/hybes/sipper/actions/runs/39949197712).
The executable Compose configuration includes the mount-parsing fix in
`bbfcec47df4500c40633b2031cc3106e518a3532`. All 37 migrations and restricted
gateway grants completed. PostgreSQL, website, portal, email/push/meeting workers,
meeting media/signalling and the edge are running. Calling remains stopped.

The approved Connect Dorset Plunk key is stored in `/root/sipper-smtp.env` with
mode 0600 and copied into the private portal configuration. SMTP AUTH returned
235 over verified TLS 1.3; no email was sent. Plunk marks `sipper.dev` as verified.
Account email delivery, the owner account and MFA are still pending.

**Public cutover is blocked:** DNS-only A records for `sip` and `meet` now point
to `176.227.215.65` and match authoritative/public resolvers. The old Worker owns
the `sipper.dev` and `www.sipper.dev` placeholder AAAA records. DNS Manager
rejected editing them as read-only; both remain unchanged. Sign in to Cloudflare,
remove only those two old Worker custom-domain bindings, then create the intended
DNS-only A records. A Cloudflare sign-in tab is open in the owner's Chromium.
The complete public HTTPS certificate, SIP certificate synchronisation and public
browser acceptance must follow that cutover. No live public launch is claimed.

Checks against the running services pass for the website, support/privacy pages,
portal sign-in/sign-up, health and OAuth discovery through the actual trusted
proxy. Direct edge access is rejected, PostgreSQL uses TLS with a non-superuser
application role, and payment settings are disabled. Coolify's existing public
HTTPS endpoint still responds. These checks do not establish account workflows,
public Sipper HTTPS, working calls or meeting audio/video.

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
an HTTPS proxy does not carry the media. Keep calling stopped until the actual
PBX and certificate are configured.

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

The installed images on `cd-main` use release
`288a338d63b27aeb11d5938adcee3ecb8e078da4`. The archive, checksum, CI manifest and
verified deployed-image manifest are retained under
`/opt/sipper-staging/288a338d63b27aeb11d5938adcee3ecb8e078da4/linux`.
The later Compose mount fix changes no application image. Record source and image
revisions separately. The older Hetzner preparation still has its earlier images.

## Start and cut over

After the host checks and private settings are complete, use the migration,
database grant and startup steps in the [dedicated-host guide](SINGLE-HOST.md#start-after-preparation-and-capacity-checks).
The same wrapper selects the shared overlay from the private deployment file.
Leave the calling profile stopped until the SIP certificate and actual PBX
acceptance are ready. Payments remain disabled.

The intended DNS-only A records for `@`, `www`, `sip` and `meet` point to
`176.227.215.65`, subject to confirming that public address. Preserve the six
Plunk email records. Remove the old placeholder AAAA records and retire the
old website Worker routes at cutover. Test the website, management login, native
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

Finish owner email/MFA setup, pilot licensing, real PBX/media tests, signed app
distribution, encrypted off-host backups, key escrow, restore drills and alerts
before accepting the pilot. Shared hosting also means host restarts and resource
problems can affect Sipper alongside the other applications. The broader gaps
remain in [release readiness](../docs/RELEASE-READINESS.md).

Local checks for this deployment are:

```sh
python3 infra/single-host/test-certificate.py
python3 infra/single-host/test-ingress.py
python3 infra/single-host/test-ingress.py --shared
python3 infra/single-host/test-runtime.py
```

The shared ingress check uses the pinned Traefik v3.7 and Caddy images in
disposable containers. It verifies TLS, routes, client addresses, forged-header
rejection, denial of direct/nearby-container access, another site's routing,
private origins, resource limits and resolved temporary filesystem mounts. It does not contact a public PBX, request
real certificates or send email.
