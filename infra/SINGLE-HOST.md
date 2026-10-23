# Dedicated-host deployment and Hetzner preparation

**The owner selected `cd-main` as the pilot target on 23 October 2026.** Follow
the [shared-host guide](SHARED-HOST.md) for that deployment. This page preserves
the dedicated-host procedure and the state of the earlier Hetzner preparation.
Do not cut public DNS over to the old Hetzner target.

The prepared Hetzner target is `116.203.89.206`, with the website and management at `sipper.dev`,
SIP TLS at `sip.sipper.dev`, and meeting signalling at `meet.sipper.dev`.
Cloudflare provides DNS; Caddy on the server provides HTTPS. Plunk provides
outbound account and invitation email. Paid signup remains disabled.
Manage the zone through [DNS Manager](https://dns.brth.uk) and the sending
domain through [Plunk domain settings](https://next-app.useplunk.com/settings?tab=domains).

**Current operating decision, 23 October 2026:** this host has 1 GB RAM and is
for preparation only. Do not start the full application/calling/meeting stack
or cut public website DNS over to it yet. Use at least 4 GB for a small pilot;
8 GB provides more room for meetings. These are starting capacities, not a
tested concurrent-call or participant limit. Measure usage during acceptance.

The reviewed source is staged at `/opt/sipper`. All five application images from
commit `671f7cdb6aeafcf38729a271c4fefe1591a3e0c5` are loaded, alongside the pinned
PostgreSQL, Caddy and LiveKit images. The verified archive and image/source
manifests are under `/opt/sipper-staging/671f7cdb6aeafcf38729a271c4fefe1591a3e0c5/linux`.
Use that commit as `--release` when generating configuration for these images.
The private SMTP template at `/root/sipper-smtp.env` still needs the actual Plunk
key. No `/etc/sipper` configuration, service startup or DNS cutover has occurred.
The selected Plunk dashboard specifies `next-smtp.useplunk.com:2587`, rather
than the public site's generic SMTP example. The host reached that endpoint and
negotiated verified TLS 1.3 on 23 October 2026. This checks connectivity only;
SMTP authentication and delivery still need to be tested with the real project
key. Plunk now shows the sending domain as verified.

The owner selected Plunk's existing **Connect Dorset** project. `sipper.dev` is
added there. The six email records in
[`single-host/plunk-sipper.dev.zone`](single-host/plunk-sipper.dev.zone) are
published and match both Cloudflare authoritative nameservers and `1.1.1.1`.
They include three DKIM CNAMEs, the `plunk` bounce-domain MX/SPF records and a
DMARC policy with no enforcement during the pilot. The existing website AAAA
records remain unchanged. Plunk confirmed the sending domain as verified on
23 October 2026.

Docker on this host uses the containerd image store and reports manifest IDs;
the CI manifest records configuration IDs. The staged `manifest.json` records
both identifiers after verifying that every server manifest references the exact
CI configuration digest and `linux/amd64` platform.

## Layout and prerequisites

- Debian 13, Docker Engine and Compose 2.30 or newer. Debian's bundled Compose
  2.26 cannot read the raw environment-file format. Use the
  [official Docker repository](https://docs.docker.com/engine/install/debian/).
- Reviewed source at `/opt/sipper`; private settings at `/etc/sipper`.
- A verified Plunk sending domain and a project secret key, stored in a private
  SMTP file outside the checkout. `single-host/smtp.env.example` uses Plunk's
  SMTP service with mandatory STARTTLS; `SMTP_SECURE=false` selects STARTTLS,
  not cleartext delivery. See [Plunk SMTP](https://www.useplunk.com/features/smtp).
- Public DNS/certificates, the actual upstream PBX hostname and TLS/SRTP
  compatibility, plus APNs/FCM credentials before background mobile acceptance.

The last Compose overlay is `compose.single-host.yml`. Always invoke the wrapper
so that application, meeting, gateway and host settings use the same project:

```sh
sh infra/single-host/compose.sh --profile meetings --profile calling config --quiet
```

Only `config --quiet` is safe to put in shared logs; full Compose output contains
secrets. The wrapper defaults to `/etc/sipper/deployment.env`; override it with
`SIPPER_DEPLOYMENT_ENV` for an isolated rehearsal.

## Generate private configuration once

After Plunk is configured, put its key in the private SMTP file. Do not paste it
into chat, shell history or source. The sending address is `accounts@sipper.dev`.
Email tracking is currently **Enabled** in the shared Connect Dorset project.
Changing it affects the other sites using that project, so this setup leaves it
unchanged. Review the shared tracking policy and verify authentication links
during pilot email acceptance; do not disable another site's tracking implicitly.
Use Plunk's exact project-specific DNS values from its domain settings; merge
SPF with an existing policy and preserve unrelated inbound mail records. See
[domain verification](https://docs.useplunk.com/guides/verifying-domains).

As root, from the reviewed checkout:

```sh
python3 infra/single-host/prepare.py \
  --public-ip 116.203.89.206 \
  --smtp-env /root/sipper-smtp.env \
  --release pilot-YYYYMMDD-COMMIT \
  --upstreams actual-pbx-host.example
```

Replace the release and PBX placeholders with reviewed values. Omit `--upstreams`
only while preparing a deployment whose calling profile will remain stopped.
The script refuses to overwrite an existing directory. It generates independent
keys, a private database CA/server certificate, database roles and environment
files. Preserve all generated authentication and encryption keys during updates.
The application database role is not a cluster superuser. The SIP role receives
only three entitlement-enforcing views after migrations. PostgreSQL has no
published port and rejects unencrypted network connections.

## DNS and network cutover

**Wait for a suitably sized host, verified SMTP and ready services before cutover.**
Through DNS Manager, create these Cloudflare records with proxying off (DNS only):

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `116.203.89.206` |
| A | `www` | `116.203.89.206` |
| A | `sip` | `116.203.89.206` |
| A | `meet` | `116.203.89.206` |

Remove stale AAAA records for these four names unless IPv6 is deliberately
configured and tested. Remove the old website's Cloudflare Worker custom-domain
bindings/routes at cutover. Do not change unrelated email, verification or other
subdomain records. Cloudflare proxying would change the trusted client-IP path;
this configuration expects direct connections to Caddy.

Required public ports are SSH TCP 22, HTTP/HTTPS TCP 80/443, HTTPS UDP 443,
SIP TLS TCP 5061, gateway RTP/RTCP UDP 20000–20199, meeting TCP 7882 and meeting
UDP 7883. Expose only the ports needed by enabled services. Keep PostgreSQL,
ARI 8088, AMI 5038, raw LiveKit 7880 and application origins private. Apply host
and Hetzner firewall rules deliberately; Docker-published ports bypass ordinary
UFW input rules. Constrain gateway egress to approved PBX destinations as well
as the hostname allowlist.

## Start after preparation and capacity checks

Build or load images for the server's `linux/amd64` architecture. Do not copy
Apple Silicon images to this x86 server. Use the immutable image tags written
to the private deployment file and retain their digests with the source revision.
The `Managed platform` GitHub workflow checks the services and produces a
`sipper-linux-amd64-COMMIT` artifact with a compressed Docker image archive,
checksum and image/source manifest. It does not deploy or start the host. Verify
the checksum and load those images with `docker load` to avoid building on the
production host; use that full commit SHA as `--release` when preparing settings.

```sh
sh infra/single-host/compose.sh --profile meetings --profile calling build
sh infra/single-host/compose.sh up -d --wait postgres
sh infra/single-host/compose.sh run --rm migrate
sh infra/single-host/compose.sh exec -T postgres \
  psql -X -U sipper_admin -d sipper -v ON_ERROR_STOP=1 \
  < infra/single-host/grant-gateway.sql
sh infra/single-host/compose.sh --profile meetings up -d --wait
```

Caddy issues and renews public certificates after DNS reaches the host. Verify
the website, all management routes and `https://sipper.dev/api/health` from
outside the server. The last command deliberately leaves the calling profile
off until a SIP certificate is installed and the actual upstream is approved:

```sh
python3 infra/single-host/sync-sip-certificate.py
sh infra/single-host/compose.sh --profile calling up -d --wait asterisk controller
install -m 0644 infra/single-host/sipper-certificate.service /etc/systemd/system/
install -m 0644 infra/single-host/sipper-certificate.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sipper-certificate.timer
```

Certificate rotation checks hostname, remaining validity and the matching key.
For a running gateway it drains the controller, stops Asterisk, installs the
pair and starts the existing services. A drain can wait for calls indefinitely;
do not shorten it or force-kill the service as a routine renewal. Check failed
timer runs. Investigate inconsistent gateway state before restarting it.

## Owner and pilot setup

Create the real owner account through the portal, verify its email and enable
MFA. Then grant that existing identity platform ownership:

```sh
sh infra/single-host/compose.sh exec -T portal \
  node --import tsx scripts/grant-owner.ts actual-owner@example.com
```

The command rejects unverified identities or accounts without MFA. In a
workspace, the platform owner can grant 1–1000 pilot user licences with an
explicit expiry up to 90 days ahead. Ordinary administrators cannot grant or
extend pilots. Expiry withdraws managed access and preserves identities and
configuration; it does not impersonate a Stripe subscription. Test billing stays
forbidden in production, and no Stripe keys are generated.

Create a customer, invite a verified user, assign a licence and configure the
approved PBX. Use a current managed pilot build; the public 0.1.0 desktop
downloads remain the earlier standalone release. Check device enrolment,
configuration, registration, inbound/outbound calls, transfer and revocation
against the real service before inviting more users.

## Operations and limits

Configure encrypted backups, key escrow, an off-host copy, restore drills and
an actual alert destination using [the recovery guide](README.md). A backup on
this server alone does not survive loss of the server. The generated database
certificate lasts 397 days; arrange its renewal before expiry and keep the CA
key private. Caddy's automatic public renewal does not renew that private
database certificate.

Meetings expose the admission proxy, never the raw SFU control endpoint. The
initial media configuration does not include TURN/TLS for restrictive networks;
that acceptance remains open. APNs/FCM keys are deliberately absent until their
real applications and credentials are available. A healthy process is not proof
of background ringing, audible media, third-party PBX interoperability or recovery.

## Local verification

With the reviewed application and website images built locally:

```sh
python3 infra/single-host/test-ingress.py
SIPPER_REHEARSAL_APP_IMAGE=sipper-platform:local \
SIPPER_REHEARSAL_WEBSITE_IMAGE=sipper-website:local \
  python3 infra/single-host/test-runtime.py
```

The first checks the real Caddy routing and request/response protections. The
second generates fictional settings, runs migrations over verified TLS with a
non-superuser, checks restricted gateway reads and failed plaintext access,
starts the portal/workers and checks disabled billing. Both remove only their
own disposable containers. Neither sends email or calls an external PBX.
