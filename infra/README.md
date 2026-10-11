# Deploying and recovering Sipper management

These assets package the portal, migrations and background workers. They have a
disposable local rehearsal; they are not evidence of a production deployment or
permission to start public sales. Website-to-portal routing, origin authentication
and browser security headers are described in [INGRESS.md](INGRESS.md). Live
HTTPS/tunnel verification, production gateway deployment, external alert delivery, off-site retention,
production recovery and provider verification remain in the implementation ledger.
The [gateway controller image and deployment instructions](../gateway/README.md#controller-container)
package its separate process and persistent journal; production Asterisk/network
deployment still needs its own acceptance checks.

The optional [managed meeting service](../docs/MEETINGS.md) uses
`compose.meetings.yml` with the `meetings` profile. Its SFU control/signalling
port remains private; public WSS must go through Sipper's admission proxy.
Native media interfaces and audio/video acceptance are still outstanding.

## Gateway pair

Build the gateway images separately from the web application:

```sh
docker build -t sipper-asterisk:22.11.0 gateway/asterisk
docker build -t sipper-controller:local gateway
```

Give each tested image an immutable release tag and record its digest. Populate
[`gateway.env.example`](gateway.env.example) as a private deployment settings
file, plus separate Asterisk and controller settings using
[`../gateway/.env.example`](../gateway/.env.example) and
[`../gateway/controller.env.example`](../gateway/controller.env.example).
Use a dedicated database role with only the documented SIP-view read grants,
verified database TLS, the matching portal service key and separate ARI/AMI
passwords. Do not give the controller the Asterisk database environment.

Place the SIP TLS chain/key in the existing private certificate directory named
by the deployment settings. UID/GID 10001 must be able to read them; keep access
restricted to that service and trusted host operators. For private database or
upstream/portal CAs, add read-only public-certificate mounts in an operator-owned
Compose override and set the matching environment paths. Mount the SIP private
key only into Asterisk. Keep the populated environment files outside the checkout
with mode 0600; do not print rendered Compose configuration or inspection environments.

```sh
docker compose --env-file /etc/sipper/gateway-deployment.env -f infra/compose.gateway.yml config --quiet
docker compose --env-file /etc/sipper/gateway-deployment.env -f infra/compose.gateway.yml up -d --no-build
```

The pair shares Asterisk's network namespace. ARI and AMI are forced to loopback,
with no published management ports. Only SIP TLS and the chosen RTP/RTCP range
are published, bound to host loopback by default. Deliberately select the intended
ingress interface, firewall rules and matching portal-advertised gateway address
before a pilot. Compose supplies the same UDP range to Asterisk and its published
ports. The [gateway transport settings](../gateway/README.md) still require the
correct public/private addresses and local networks for NAT; port publication
alone does not make SIP dialog or media routing work.

Both processes use unprivileged users, read-only roots, dropped capabilities,
bounded logs and private temporary filesystems. Asterisk copies missing defaults
into its 0700 temporary configuration mount, renders credentials as 0600 and
uses ephemeral registration/runtime storage. Asterisk/media loss requires fresh
registrations; its SIP dialogs are never restored from disk. Only the controller
journal is durable, in the project's `controller-state` volume. Preserve the entire
volume across replacements and investigate a mismatched/corrupt journal before
starting. `down --volumes` destroys that recovery state and is for disposable
tests or a deliberately fenced, documented cold recovery only.

The configured stop duration is `-1s`, which Docker represents as an infinite
graceful stop. For an update, first use the same settings/project to stop only
`controller` and wait for exit. It withdraws readiness while calls/outcomes drain.
Then stop `asterisk` if it needs replacement, and run `up -d --no-build` for the
new tested pair. Starting the controller after Asterisk is healthy reconnects it
to the current network namespace. Do not force-recreate Asterisk during a call
or run competing pairs for one gateway. A drain can wait indefinitely during an
outage; treat that as an incident to investigate, not a reason to shorten the timeout.

The Asterisk health check proves core startup only. Inspect portal readiness,
device/upstream registration observations, failed-call outcomes and restart loops
separately, with external alerting configured before launch. This configuration
does not install a database role, public DNS/certificates, firewall, NAT, an alert
destination or multi-host failover.

From `portal/`, `SIPPER_GATEWAY_COMPOSE=1 pnpm test:gateway` adds an actual pair to
the existing isolated SIP rehearsal. It uses the local test database and fictional
PBX, a test-only private relay to the built loopback portal, and a uniquely named
Compose project/volume. It checks private ARI/AMI access, generated-config
permissions, read-only roots, shared networking, registration reporting,
incoming/outgoing SIP and graceful drain. It does not establish production network,
provider push or physical audio acceptance. Run this separately from native stages.
The test removes its project, volume and relay, including on failure.

## Application image

From the repository root, with Docker and Compose 2.30 or newer:

```sh
docker build -t sipper-platform:local portal
docker build -t sipper-recovery:local infra/recovery
```

The application image uses the pinned official Node 24 image and frozen pnpm lock.
The Docker context allows application sources only: local environment files,
browser fixtures, tests, node_modules and existing build output are excluded.
Runtime processes use the unprivileged `node` user, a read-only root filesystem,
a small temporary filesystem and no Linux capabilities. The same image runs the
web service, the two workers and migrations. Tag a tested image with an immutable
release identifier, record its digest and keep it with the matching source and
backup records. Do not rebuild a mutable tag independently on each host.

Create a private application environment file outside this checkout using
[`../portal/.env.example`](../portal/.env.example). Set production HTTPS origin,
database credentials, independent authentication/encryption/edge keys and SMTP. Keep
all encryption key IDs used by stored records. Missing billing or push provider
keys leave their functions unavailable; do not claim those services are ready.
Use a dedicated PostgreSQL 17 application database and owner, not a cluster
superuser. For remote databases require verified TLS and the provider's CA; never
disable certificate verification to get a deployment running.

Compose reads application values literally (`env_file.format: raw`). Do not put
surrounding shell quotes around JSON values, use shell expansion, or put a PEM on
multiple lines. The supported literal `\n` form is suitable for PEM keys. Protect
the populated file with mode 0600 and restrict host/Docker access: container
environment settings are visible to Docker administrators. Do not print rendered
Compose configuration or `docker inspect` output into shared logs.

Copy [`infra/.env.example`](.env.example) to a private deployment settings file
and set its absolute `SIPPER_APP_ENV_FILE`, tested image tag and local origin port.
Then, using that same settings file on every command:

```sh
docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml config --quiet
docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml run --rm migrate
docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml up -d --no-build
```

Take and verify a fresh backup before a schema upgrade. Initial migrations and
repeat runs use the existing migration lock/checksums. Services wait for successful
migration; each also verifies configuration, a round-trip with the active
encryption key, and the exact migration names/checksums bundled in its image.
Mismatched, newer or incomplete schemas refuse startup. Migrations do not run on
each web request. Database rollback is a planned restore; starting an older image
against a newer schema is deliberately rejected. The active-key probe does not
prove that every historical encryption key is present; the recovery rehearsal
also decrypts saved data.

The only published application port binds to `127.0.0.1` on the host (3101 by
default). Keep it private. Follow [INGRESS.md](INGRESS.md) for the existing website
Worker, matching edge secrets and optional tunnel overlay. The portal owns its
browser policy and validates the Worker's observed client address. No DNS,
Cloudflare routes or certificates are changed by the application Compose file.

`/api/health` checks database reachability; its Docker check does not prove SMTP,
push, billing, gateway health or background-worker progress. Workers run separately
so an SMTP delay cannot block push jobs. Each worker advances its own database
record and private, atomically replaced `/tmp/sipper-worker-<kind>.json` file only
after a completed queue poll, including an empty poll. Writes are throttled to
once per 15 seconds. There is no independent timer that could keep a stuck poll
looking healthy. SMTP/provider rejection can still count as a completed poll;
inspect the separate queue outcomes to assess delivery.

The owner Service status page shows each process as Starting, Polling, Stale or
Stopped, with its start and last-progress times. A worker kind with no record is
Not reported. Records are visible for 24 hours; starting another worker prunes
older records, and a recovered process recreates its record if necessary. These
are process observations, not a promise that an expected replica count is met.
Email becomes stale after 180 seconds without progress, push after 45 seconds.
A graceful exit records Stopped and removes the health file; crashes expire by
age. Host and database clocks must be synchronised.

After migration 035, Service status also lists exhausted invitation emails in
pages of 50, with their queue/attempt times, customer/workspace and expiry.
Only a verified platform owner with MFA can queue a retry. The server rechecks
the invitation and its creator's current authority; customer suspension also
blocks delivery. Retrying resets the existing job, preserves the original
invitation/expiry and records one audit event. It does not confirm inbox delivery.
Correct the email delivery fault first. An uncertain SMTP response can cause
duplicate copies, so email delivery is at least once.

The email worker rechecks the invitation before sending and erases the payload
after SMTP acceptance or an unusable-invitation skip. Its minute cleanup also
erases expired, revoked, accepted or deleted invitation payloads in exhausted
jobs, while preserving active leases. Legacy queue times are recovered only
from the matching invitation's creation time; unrecorded attempt times remain
unknown. The dashboard never projects mail bodies, invitation tokens, encryption
envelopes or provider error text. No additional environment key is required.

Both worker containers have local health checks; the probe needs no database
credentials or public endpoint. Check manually inside a running container with
`node --import tsx scripts/worker-health.ts email` (or `push`). It exits 1 for a
missing, malformed, future-dated or stale progress file. Run one worker per
container and retain the provided writable `/tmp` mount. Configure your external
monitor to alert on missing/unhealthy expected containers and sustained queue
backlogs before production; no external monitoring account or alert destination
is configured by these files. Docker
rotates local logs; access/request-body logging and forwarding require a separate
privacy review. An unhealthy Docker health check alone does not restart a process.

## Encrypted database backups

The recovery image uses PostgreSQL 17 tools and the distribution's `age` package.
`pg_dump` writes a consistent custom-format snapshot directly into age; plaintext
archives are never written to the backup volume. Failures remove the partial
ciphertext. Publication is atomic on the destination filesystem, uses mode 0600,
and refuses to replace an existing archive. It covers one application database,
not cluster roles or gateway journals.

Create and escrow an age recovery identity on a trusted recovery machine:

```sh
age-keygen -o sipper-recovery-identity.txt
age-keygen -y sipper-recovery-identity.txt > backup-recipients.txt
```

Copy only the public recipients file to the backup host. Escrow the private
identity separately from that host and its archives. Also escrow the application
authentication secret, every retained encryption key ID, provider configuration,
database role/grant definitions and the exact application image/source version.
An encrypted database backup cannot replace this key/configuration escrow.

Populate [`recovery/.env.example`](recovery/.env.example) outside the checkout.
Use a protected PostgreSQL password file, verified TLS and an operator-owned backup
directory. For example, with the appropriate read-only secret mounts:

```sh
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
  --user "$(id -u):$(id -g)" --env-file /etc/sipper/backup.env \
  -v /etc/sipper/postgres.pgpass:/run/secrets/postgres.pgpass:ro \
  -v /etc/sipper/postgres-ca.crt:/run/secrets/postgres-ca.crt:ro \
  -v /etc/sipper/backup-recipients.txt:/run/secrets/backup-recipients.txt:ro \
  -v /srv/sipper/backups:/backups \
  -e "SIPPER_BACKUP_OUTPUT=/backups/sipper-$(date -u +%Y%m%dT%H%M%SZ).dump.age" \
  sipper-recovery:local database-backup.sh
```

Upload only completed ciphertext to protected off-site storage with versioning
and retention. Choose a schedule from the approved recovery-point objective;
none is installed by these files. Alert on backup age, failure, storage capacity
and restore-drill failure. Successful encryption does not authenticate who created
an archive: restore only a trusted backup from protected storage. PostgreSQL
archives can contain executable SQL.

## Restore procedure

1. Create a **new, empty, isolated database** owned by the intended application
   role. Fence the former application, worker, controller and Asterisk hosts;
   keep their replacements disconnected. This is a cold database recovery,
   not the controller restart procedure that preserves existing media. Do not use
   the current database as a restore target. Restore settings must explicitly name
   the same target in `PGDATABASE` and `SIPPER_RESTORE_DATABASE`.
2. Obtain the trusted completed archive and its matching application/configuration
   escrow. Mount the age identity read-only only for this recovery operation.
3. Run the restore command below. Size `/restore` for the decrypted custom archive;
   it is a private tmpfs and consumes memory (host swap must also be encrypted or
   disabled). The whole ciphertext must authenticate before any restore SQL runs.
4. The script refuses an existing populated target and restores/quarantines data
   together with a persistent recovery hold in one PostgreSQL transaction.
   Failure rolls back everything, leaving no usable application schema. The packaged portal,
   email and push services refuse startup while held. It does not overwrite the
   current database or import source-cluster owners/ACLs. Use the recovery image
   matching the archive's schema; an incompatible reset fails closed. Reapply the intended least-privilege role/grant
   configuration, including the gateway's read-only SIP views, separately.
5. Against the isolated target, verify schema checksums, row counts, scoped access
   and decryption of representative saved credentials/queued data with their
   original context. Keep outbound SMTP, push, billing and SIP isolated during
   the rehearsal. Do not emit decrypted values to logs.
6. Reconcile changes since the snapshot using independent authoritative records:
   user/device revocations, staff and owner grants, passwords/MFA changes, SSO/SCIM
   identities, subscriptions, payments and seat assignments. Rotate escrowed
   service keys if necessary. Record which invitations and account-recovery
   messages must be reissued after release. The hold does not
   reconstruct lost changes or validate payment/provider state; an old membership
   or password can otherwise restore previously revoked access. Keep uncertain
   access suspended. Production reconciliation remains an operator drill.
7. With former services fenced and all other target-database connections closed,
   run `database-release.sh --reconciled` as shown below. This explicit attestation
   releases the hold only on the named restored database with quarantined session,
   queue and gateway state. It closes snapshot calls as Failed because their real
   outcome was lost during cold recovery; it does not send SIP BYE or claim to have
   preserved media. Keep public ingress closed while starting the checked image
   and fresh Asterisk/controller processes. Verify new sign-in, provisioning,
   registrations and calls. Rotate SCIM tokens before reconnecting providers, and
   reissue the required invitations/recovery messages through the checked portal.
   Record the measured data-loss window and recovery time,
   then enable ingress/workers only after those checks pass. Retain the former database until
   the recovery is accepted. Remove the temporary decrypted data and identity
   mount; the script removes its temporary archive on exit.

```sh
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
  --user "$(id -u):$(id -g)" --env-file /etc/sipper/restore.env \
  --tmpfs /restore:rw,noexec,nosuid,size=1g,mode=1777 \
  -v /etc/sipper/restore.pgpass:/run/secrets/postgres.pgpass:ro \
  -v /etc/sipper/postgres-ca.crt:/run/secrets/postgres-ca.crt:ro \
  -v /secure-recovery/sipper-recovery-identity.txt:/run/secrets/backup-identity.txt:ro \
  -v /srv/sipper/backups:/backups:ro \
  sipper-recovery:local database-restore.sh
```

Quarantine invalidates browser/native sessions and OAuth grants, temporary
authentication challenges, pending invitations/setup links, SCIM bearer tokens,
push endpoints and device gateway credentials. It cancels pending jobs with a
`recovery_cancelled` outcome and erases their payloads. Device applied revisions
and current status, gateway readiness/ownership/observations and worker progress
are cleared. Historical activity timestamps and completed jobs remain historical;
durable users, memberships, billing, SIP settings, directories and audit records
remain for reconciliation. Users must sign in again; renewed provisioning creates
fresh gateway credentials and clients must register their push tokens again.
Direct PBX credentials already held by offline clients cannot be recalled by
this restore; rotate/revoke those at the PBX where required.

After the checks above, the release command needs only the protected database
connection settings, not the age private identity or archive mounts:

```sh
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
  --user "$(id -u):$(id -g)" --env-file /etc/sipper/restore.env \
  -v /etc/sipper/restore.pgpass:/run/secrets/postgres.pgpass:ro \
  -v /etc/sipper/postgres-ca.crt:/run/secrets/postgres-ca.crt:ro \
  sipper-recovery:local database-release.sh --reconciled
```

Migration 027 supplies the recovery state table; no additional database privilege
is required. The database owner controls the hold. It prevents accidental packaged startup;
it is not isolation from a database administrator or a substitute for fencing
old hosts. Do not bypass the container entrypoint or reset the marker manually.
Both quarantine and release append service audit records. A second release or a
target-name mismatch is refused. No additional provider key is required.

This does **not** back up Asterisk state or the controller SQLite journal. The
gateway requires its own durable local volume and a consistent recovery plan;
copying an active SQLite file without its transaction state is not that plan.
Retain former journals for diagnosis; after cold database recovery use a new
private state volume, not a journal from the abandoned database timeline.

## Disposable rehearsal

After building the two images above:

```sh
python3 infra/recovery/rehearse.py
```

The script creates a uniquely named PostgreSQL container/network and fictional
customer, configuration and queue records. It uses no existing `.env`, database,
PBX, SMTP or push account. It checks encrypted backup permissions/failure cleanup,
wrong identity, truncated ciphertext, explicit target matching and populated
target refusal; then restores the full migrated database and decrypts its saved
fixture data. An injected reset failure must roll back the entire restore without
publishing a usable schema. Restored sessions, call/message tokens, pending jobs, gateway credentials and fresh
observations must be invalidated, and all three services must refuse startup until
reconciliation and explicit release. Missing migrations and invalid keys must also refuse container startup.
Finally it launches the actual Compose portal/email/push services on the restored
database, checks protected-origin/proxy HTTP flows and queue processing,
verifies worker health, freezes only the push process until it becomes stale and
unhealthy while email continues, then verifies recovery after resuming it. It removes its temporary keys,
archives, database and containers. Its database and worker network has no external
route; the portal also has a loopback-published HTTP bridge for the smoke check.
The host needs the portal's installed dependencies for public-key token validation.
Add `--preview` to keep the disposable production-policy sign-in page available
for browser checks, then press Enter to clean up. The optional tunnel overlay is
parsed with an unused fictional token file; no tunnel is started.

This proves a small local restore and packaged service startup, not production
scale, real provider delivery, point-in-time recovery, host failover or a live
customer recovery-time guarantee.

References: [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html),
[age encryption and key usage](https://github.com/FiloSottile/age),
[Compose environment file format](https://docs.docker.com/reference/compose-file/services/#env_file).
