#!/usr/bin/env python3
"""Exercise the built application and recovery images with disposable data only.

Requires Docker/Compose and Python 3. No existing database, environment file,
SMTP account, PBX or push provider is used. All resources are uniquely named.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from urllib.parse import urlencode, urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[2]
APP = os.environ.get("SIPPER_REHEARSAL_APP_IMAGE", "sipper-platform:local")
RECOVERY = os.environ.get("SIPPER_REHEARSAL_RECOVERY_IMAGE", "sipper-recovery:local")
POSTGRES = "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
NAME = "sipper-recovery-" + secrets.token_hex(6)
old_umask = os.umask(0o077)


def run(args, *, data=None, ok=True, env=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, env=env, timeout=180)
    if ok and result.returncode:
        # Never echo arguments/environments or provider errors. Limit diagnostics
        # to the first SQL error from this fictional fixture, without literals.
        diagnostic = re.search(r'^ERROR: .*$', result.stderr, re.MULTILINE)
        detail = re.sub(r"'[^']*'", '[redacted]', diagnostic[0]) if diagnostic else ''
        raise RuntimeError(f"{args[0]} step failed (exit {result.returncode}) {detail}")
    return result


def wait_for(check):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Timed out waiting for the isolated fixture")


with tempfile.TemporaryDirectory(prefix=NAME + "-") as temporary:
    private = Path(temporary)
    password = secrets.token_hex(24)
    pg_file = private / "postgres.env"
    pg_file.write_text(f"POSTGRES_USER=rehearsal_admin\nPOSTGRES_PASSWORD={secrets.token_hex(24)}\nPOSTGRES_DB=source_test\n")
    app_values = {
        "NODE_ENV": "production", "SIPPER_BASE_URL": "https://sipper.example.invalid",
        "BETTER_AUTH_SECRET": secrets.token_urlsafe(48),
        "SIPPER_EDGE_SHARED_SECRET": secrets.token_urlsafe(48),
        "SIPPER_ENCRYPTION_KEYS": json.dumps({"v1": base64.b64encode(secrets.token_bytes(32)).decode()}),
        "SIPPER_ENCRYPTION_KEY_ID": "v1", "SMTP_HOST": "unconfigured.example.invalid",
        "SMTP_PORT": "587", "MAIL_FROM": "Sipper <accounts@example.invalid>",
        "SIPPER_REQUIRE_ADMIN_MFA": "true", "SIPPER_ALLOW_TEST_BILLING": "false",
    }

    def environment_file(name, values):
        path = private / name
        path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        return str(path)

    def application_env(database):
        return environment_file(database + ".env", {
            **app_values, "DATABASE_URL": f"postgresql://sipper:{password}@db:5432/{database}",
        })

    source_env, target_env = application_env("source_test"), application_env("restored_test")
    compose_env = {**os.environ, "SIPPER_APP_ENV_FILE": target_env, "SIPPER_APP_IMAGE": APP, "SIPPER_ORIGIN_PORT": "0"}
    override = private / "compose.yml"
    # Database and workers have no external route. Only the portal also joins an
    # ordinary bridge, allowing Docker to publish its loopback-only HTTP port.
    override.write_text(f"services:\n  portal:\n    networks: [default, origin]\nnetworks:\n  origin: {{}}\n  default:\n    external: true\n    name: {NAME}\n")
    compose = ["docker", "compose", "-p", NAME, "-f", str(ROOT / "infra/compose.app.yml"), "-f", str(override)]
    uid = f"{os.getuid()}:{os.getgid()}"

    def sql(database, query):
        return run(["docker", "exec", "-i", NAME, "psql", "-U", "rehearsal_admin", "-d", database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"], data=query).stdout.strip()

    def app(database_env, code):
        return run(["docker", "run", "--rm", "-i", "--network", NAME, "--env-file", database_env,
                    "--entrypoint", "node", APP, "--import", "tsx", "--input-type=module"], data=code)

    def recovery(database, command, values=None, ok=True, reset_file=None):
        env_file = environment_file("recovery.env", {
            "PGHOST": "db", "PGUSER": "sipper", "PGPASSWORD": password,
            "PGDATABASE": database, "PGSSLMODE": "disable",  # Only the isolated Docker network.
            **(values or {}),
        })
        return run(["docker", "run", "--rm", "--network", NAME, "--user", uid, "--read-only",
                    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--env-file", env_file,
                    "--tmpfs", "/restore:rw,noexec,nosuid,size=256m,mode=1777",
                    "-v", f"{private}:/backup",
                    *(["-v", f"{reset_file}:/usr/local/share/sipper/recovery-reset.sql:ro"] if reset_file else []),
                    RECOVERY, *command], ok=ok)

    restore_settings = {"SIPPER_RESTORE_DATABASE": "restored_test", "SIPPER_RESTORE_IDENTITY": "/backup/identity.txt", "SIPPER_RESTORE_INPUT": "/backup/fixture.dump.age"}
    backup_settings = {"SIPPER_BACKUP_RECIPIENTS": "/backup/recipients.txt", "SIPPER_BACKUP_OUTPUT": "/backup/fixture.dump.age"}
    preview = None
    try:
        run(["docker", "network", "create", "--internal", NAME])
        run(["docker", "run", "-d", "--name", NAME, "--network", NAME, "--network-alias", "db", "--env-file", str(pg_file), POSTGRES])
        # The entrypoint's temporary init server accepts Unix sockets before it
        # creates POSTGRES_DB. Wait for the final TCP listener instead.
        wait_for(lambda: run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "rehearsal_admin", "-d", "source_test"], ok=False).returncode == 0)
        # Exercise migrations, dump, restore and app access as a database owner,
        # not the PostgreSQL cluster administrator. The generated password is hex.
        sql("source_test", f"CREATE ROLE sipper LOGIN PASSWORD '{password}'")
        sql("source_test", "ALTER DATABASE source_test OWNER TO sipper")
        sql("source_test", "CREATE DATABASE restored_test OWNER sipper")
        sql("source_test", "CREATE DATABASE rejected_test OWNER sipper")
        assert sql("source_test", "SELECT rolsuper FROM pg_roles WHERE rolname='sipper'") == "f"
        run(["docker", "run", "--rm", "--network", NAME, "--env-file", source_env, APP, "migrate"])
        app(source_env, "await import('./scripts/preflight.ts')")
        app(source_env, """
import { randomUUID, createHash } from 'node:crypto';
import { getPool } from './server/lib/db.ts';
import { sealSecret } from './server/lib/crypto.ts';
const db = getPool(), workspace = randomUUID(), organisation = randomUUID(), account = randomUUID();
await db.query("INSERT INTO workspaces(id,name,kind) VALUES ($1,'Recovery rehearsal','business')", [workspace]);
await db.query("INSERT INTO organisations(id,workspace_id,name) VALUES ($1,$2,'Fictional customer')", [organisation,workspace]);
await db.query("INSERT INTO sip_configurations(id,organisation_id,label,mode,settings,secret_envelope) VALUES ($1,$2,'Fictional extension','direct',$3,$4)", [account,organisation,{username:'100',domain:'pbx.example.invalid'},sealSecret('fictional-recovery-password',`sip:${organisation}:${account}`)]);
await db.query("INSERT INTO jobs(kind,payload,completed_at) VALUES ('recovery_fixture',$1,now())", [sealSecret('fictional queued content','recovery:fixture')]);
// A snapshot deliberately contains apparently live authority and observations.
const user='recovery-user', device=randomUUID(), gatewayAccount=randomUUID(), credential=randomUUID();
await db.query(`INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Recovery person','recovery@example.invalid',true,now(),now())`,[user]);
await db.query(`INSERT INTO auth_session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ('recovery-session',$1,'fictional-session',now()+interval '1 day',now(),now())`,[user]);
await db.query(`INSERT INTO "oauthRefreshToken"(id,token,"clientId","sessionId","userId","expiresAt","createdAt",scopes) VALUES ('recovery-refresh','fictional-refresh','sipper-android','recovery-session',$1,now()+interval '1 day',now(),$2)`,[user,JSON.stringify(['sipper:client'])]);
await db.query(`INSERT INTO "oauthAccessToken"(id,token,"clientId","sessionId","userId","refreshId","expiresAt","createdAt",scopes) VALUES ('recovery-access','fictional-access','sipper-android','recovery-session',$1,'recovery-refresh',now()+interval '1 hour',now(),$2)`,[user,JSON.stringify(['sipper:client'])]);
await db.query(`INSERT INTO auth_verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES ('recovery-verification','fictional-login','fictional-reference',now()+interval '1 day',now(),now())`);
await db.query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')",[workspace,organisation,user]);
await db.query("INSERT INTO subscriptions(workspace_id,provider,status,purchased_seats) VALUES ($1,'stripe','active',1)",[workspace]);
await db.query('INSERT INTO seat_assignments(workspace_id,user_id) VALUES ($1,$2)',[workspace,user]);
await db.query("INSERT INTO devices(id,organisation_id,user_id,installation_id,name,platform,app_version,os_version,applied_revision,status) VALUES ($1,$2,$3,$4,'Recovery phone','android','test','test','old-revision',$5)",[device,organisation,user,randomUUID(),{registrations:[{accountId:account,state:'registered',code:200}]}]);
await db.query("INSERT INTO sip_configurations(id,organisation_id,label,mode,settings,secret_envelope) VALUES ($1,$2,'Recovery gateway','gateway',$3,$4)",[gatewayAccount,organisation,{username:'101',domain:'pbx.example.invalid',server:'pbx.example.invalid',transport:'tls'},sealSecret('fictional-upstream-password',`sip:${organisation}:${gatewayAccount}`)]);
await db.query('INSERT INTO sip_assignments(organisation_id,configuration_id,user_id) VALUES ($1,$2,$3)',[organisation,gatewayAccount,user]);
await db.query("INSERT INTO gateway_nodes(id,host,port,ready_until,controller_instance,controller_expires_at,last_heartbeat_at) VALUES ('recovery-gateway','sip.example.invalid',5061,now()+interval '1 day',$1,now()+interval '1 day',now())",[randomUUID()]);
await db.query("INSERT INTO gateway_credentials(id,gateway_id,organisation_id,device_id,configuration_id,username,realm,secret_envelope,password_digest,registration_state,registration_observed_at) VALUES ($1,'recovery-gateway',$2,$3,$4,$5,'sip.example.invalid',$6,$7,'registered',now())",[credential,organisation,device,gatewayAccount,`d${credential.replaceAll('-','')}`,sealSecret('fictional-device-password',`gateway:${organisation}:${device}:${gatewayAccount}:${credential}`),`SHA-256:${createHash('sha256').update('fictional-digest').digest('hex')}`]);
await db.query("INSERT INTO gateway_calls(id,gateway_id,organisation_id,configuration_id,state,expires_at) VALUES ($1,'recovery-gateway',$2,$3,'answered',now()+interval '1 day')",[randomUUID(),organisation,gatewayAccount]);
await db.query("INSERT INTO push_endpoints(device_id,provider,token_envelope,token_revision) VALUES ($1,'fcm',$2,$3)",[device,sealSecret('fictional-push-token','recovery:push'),randomUUID()]);
await db.query("INSERT INTO message_push_endpoints(device_id,provider,token_envelope,token_revision) VALUES ($1,'fcm',$2,$3)",[device,sealSecret('fictional-message-push-token','recovery:message-push'),randomUUID()]);
await db.query("INSERT INTO worker_progress(id,kind,progressed_at) VALUES ($1,'push',now())",[randomUUID()]);
await db.query("INSERT INTO jobs(kind,payload) VALUES ('email',$1),('call_push',$2),('message_push',$3)",[sealSecret('fictional pending mail','recovery:mail'),sealSecret('fictional pending push','recovery:push'),sealSecret('fictional pending message notice','recovery:message-push')]);
await db.query("INSERT INTO setup_links(organisation_id,user_id,token_hash,expires_at) VALUES ($1,$2,'fictional-setup',now()+interval '1 day')",[organisation,user]);
await db.query("INSERT INTO invitations(workspace_id,organisation_id,email,role,token_hash,expires_at,created_by) VALUES ($1,$2,'invited@example.invalid','user','fictional-invite',now()+interval '1 day',$3)",[workspace,organisation,user]);
await db.query("INSERT INTO workspace_invitations(workspace_id,email,role,token_hash,expires_at,created_by) VALUES ($1,'staff@example.invalid','admin','fictional-staff',now()+interval '1 day',$2)",[workspace,user]);
await db.query("INSERT INTO scim_connections(organisation_id,token_hash,token_expires_at) VALUES ($1,'fictional-scim',now()+interval '1 day')",[organisation]);
await db.end();
""")
        assert sql("source_test", "SELECT count(*) FROM active_gateway_credentials") == "1"
        recovery("source_test", ["age-keygen", "-o", "/backup/identity.txt"])
        recipient = recovery("source_test", ["age-keygen", "-y", "/backup/identity.txt"]).stdout
        (private / "recipients.txt").write_text(recipient)
        recovery("source_test", ["database-backup.sh"], backup_settings)
        archive = private / "fixture.dump.age"
        assert archive.read_bytes().startswith(b"age-encryption.org/v1\n")
        assert b"fictional-recovery-password" not in archive.read_bytes()
        assert archive.stat().st_mode & 0o777 == 0o600
        assert recovery("source_test", ["database-backup.sh"], backup_settings, ok=False).returncode != 0
        failed_backup = {**backup_settings, "SIPPER_BACKUP_OUTPUT": "/backup/failed.dump.age"}
        assert recovery("missing_test", ["database-backup.sh"], failed_backup, ok=False).returncode != 0
        assert not (private / "failed.dump.age").exists() and not list(private.glob(".sipper-backup.*"))
        print("PASS: encrypted dump, private permissions, no overwrite and failed-dump cleanup", flush=True)

        recovery("source_test", ["age-keygen", "-o", "/backup/wrong-identity.txt"])
        negative = {**restore_settings, "SIPPER_RESTORE_DATABASE": "rejected_test"}
        assert recovery("rejected_test", ["database-restore.sh"], {**negative, "SIPPER_RESTORE_IDENTITY": "/backup/wrong-identity.txt"}, ok=False).returncode != 0
        (private / "truncated.dump.age").write_bytes(archive.read_bytes()[:-16])
        assert recovery("rejected_test", ["database-restore.sh"], {**negative, "SIPPER_RESTORE_INPUT": "/backup/truncated.dump.age"}, ok=False).returncode != 0
        assert recovery("rejected_test", ["database-restore.sh"], restore_settings, ok=False).returncode != 0
        assert sql("rejected_test", "SELECT count(*) FROM pg_tables WHERE schemaname='public'") == "0"
        # A cleanup failure must roll back the restore itself; no usable schema
        # may become visible before the recovery hold is committed with the data.
        failed_reset = private / 'failed-reset.sql'
        failed_reset.write_text('SELECT 1/0;\n')
        failed_restore = recovery("rejected_test", ["database-restore.sh"], negative, ok=False, reset_file=failed_reset)
        assert failed_restore.returncode != 0
        assert sql("rejected_test", "SELECT count(*) FROM pg_tables WHERE schemaname='public'") == "0"
        assert 'division by zero' in failed_restore.stderr, 'Exercise the injected reset failure, not an earlier restore failure'
        recovery("restored_test", ["database-restore.sh"], restore_settings)
        assert recovery("restored_test", ["database-restore.sh"], restore_settings, ok=False).returncode != 0
        app(target_env, """
import assert from 'node:assert/strict';
import { getPool } from './server/lib/db.ts';
import { openSecret } from './server/lib/crypto.ts';
const db = getPool();
const account = (await db.query("SELECT * FROM sip_configurations WHERE mode='direct'")).rows[0];
assert.equal(openSecret(account.secret_envelope,`sip:${account.organisation_id}:${account.id}`),'fictional-recovery-password');
const job = (await db.query("SELECT payload FROM jobs WHERE kind='recovery_fixture'")).rows[0];
assert.equal(openSecret(job.payload,'recovery:fixture'),'fictional queued content');
assert.equal((await db.query("SELECT name FROM organisations")).rows[0].name,'Fictional customer');
for (const table of ['auth_session','auth_verification','"oauthAccessToken"','"oauthRefreshToken"','push_endpoints','message_push_endpoints','gateway_credentials','gateway_upstream_registrations','worker_progress'])
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,0);
assert.equal((await db.query('SELECT count(*)::int AS count FROM active_gateway_credentials')).rows[0].count,0);
assert.equal((await db.query("SELECT count(*)::int AS count FROM jobs WHERE completed_at IS NULL")).rows[0].count,0);
assert.equal((await db.query("SELECT count(*)::int AS count FROM jobs WHERE last_error='recovery_cancelled' AND payload='{}' AND attempts=0")).rows[0].count,3);
assert.equal((await db.query("SELECT count(*)::int AS count FROM devices WHERE applied_revision IS NULL AND status='{}'")).rows[0].count,1);
for(const table of ['invitations','workspace_invitations','setup_links'])
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE revoked_at IS NULL`)).rows[0].count,0);
assert.equal((await db.query('SELECT token_hash FROM scim_connections')).rows[0].token_hash,null);
assert.equal((await db.query("SELECT state FROM gateway_calls")).rows[0].state,'answered'); // Not a hangup claim during restore.
await db.end();
""")
        assert sql("source_test", "SELECT string_agg(name || checksum,',' ORDER BY name) FROM sipper_migrations") == sql("restored_test", "SELECT string_agg(name || checksum,',' ORDER BY name) FROM sipper_migrations")
        print("PASS: wrong key, truncated archive, target mismatch and populated target refused; restored data and encrypted secrets verified", flush=True)

        for service in ['portal', 'email', 'push']:
            held = run(['docker','run','--rm','--network',NAME,'--env-file',target_env,APP,service],ok=False)
            assert held.returncode != 0 and 'Database recovery hold is active' in held.stderr
        assert recovery('restored_test',['database-release.sh'],restore_settings,ok=False).returncode != 0
        assert recovery('restored_test',['database-release.sh','--reconciled'],{**restore_settings,'SIPPER_RESTORE_DATABASE':'another_test'},ok=False).returncode != 0
        # A copied revocation is reconciled before release; it must not be undone.
        sql('restored_test', "UPDATE organisation_members SET status='suspended'")
        sql('restored_test', "INSERT INTO jobs(kind,payload) VALUES ('unreviewed','{}')")
        assert recovery('restored_test',['database-release.sh','--reconciled'],restore_settings,ok=False).returncode != 0
        assert sql('restored_test', 'SELECT released_at IS NULL FROM service_recovery') == 't'
        sql('restored_test', "DELETE FROM jobs WHERE kind='unreviewed'")
        sql('restored_test', "INSERT INTO message_push_endpoints(device_id,provider,token_envelope,token_revision) SELECT id,'fcm','{}',gen_random_uuid() FROM devices LIMIT 1")
        assert recovery('restored_test',['database-release.sh','--reconciled'],restore_settings,ok=False).returncode != 0
        assert sql('restored_test', 'SELECT released_at IS NULL FROM service_recovery') == 't'
        sql('restored_test', 'DELETE FROM message_push_endpoints')
        # No process should still be using the target when an operator releases it.
        holder = subprocess.Popen(['docker','exec','-i',NAME,'psql','-U','rehearsal_admin','-d','restored_test','-X','-q'],
                                  stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True)
        try:
            holder.stdin.write("SET application_name='recovery-fixture-hold'; SELECT pg_sleep(60);\n")
            holder.stdin.close()
            wait_for(lambda: sql('restored_test', "SELECT count(*) FROM pg_stat_activity WHERE application_name='recovery-fixture-hold'") == '1')
            assert recovery('restored_test',['database-release.sh','--reconciled'],restore_settings,ok=False).returncode != 0
        finally:
            sql('restored_test', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='recovery-fixture-hold'")
            holder.wait(timeout=10)
        recovery('restored_test',['database-release.sh','--reconciled'],restore_settings)
        assert recovery('restored_test',['database-release.sh','--reconciled'],restore_settings,ok=False).returncode != 0
        assert sql('restored_test', "SELECT count(*) FROM gateway_calls WHERE state='ended' AND end_reason='failed'") == '1'
        assert sql('restored_test', "SELECT status FROM organisation_members") == 'suspended'
        assert sql('restored_test', "SELECT count(*) FROM audit_events WHERE action IN ('service.restore_quarantined','service.restore_released')") == '2'
        print('PASS: restore/reset is atomic; stale grants, observations and pending jobs are quarantined; all three services refuse startup until explicit reconciled release',flush=True)

        incomplete_env = application_env("rejected_test")
        assert run(["docker", "run", "--rm", "--network", NAME, "--env-file", incomplete_env, APP, "portal"], ok=False).returncode != 0
        invalid_env = environment_file("invalid.env", {**app_values, "DATABASE_URL": f"postgresql://sipper:{password}@db:5432/restored_test", "SIPPER_ENCRYPTION_KEYS": "{}"})
        assert run(["docker", "run", "--rm", "--network", NAME, "--env-file", invalid_env, APP, "portal"], ok=False).returncode != 0
        print("PASS: containers refuse missing migrations and an unavailable encryption key", flush=True)
        run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "node", APP, "--input-type=module", "-e", "import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; for (const path of ['.env','.data','tests','scripts/local-fixture.ts','scripts/http-smoke.ts']) assert.equal(existsSync(path),false)"])

        # Exercise exactly the deployment services, including their startup checks,
        # non-root user, read-only filesystem and separate email/push loops.
        run([*compose, "config", "--quiet"], env=compose_env)
        token_file = private / 'unused-tunnel-token'
        token_file.write_text('fictional-token-never-used')
        run([*compose, '-f', str(ROOT / 'infra/compose.tunnel.yml'), 'config', '--quiet'],
            env={**compose_env, 'SIPPER_TUNNEL_TOKEN_FILE': str(token_file)})
        print('PASS: application and optional tunnel configuration parse without starting a tunnel', flush=True)
        run([*compose, "up", "-d", "--no-build"], env=compose_env)
        port = run([*compose, "port", "portal", "3100"], env=compose_env).stdout.strip().split(":")[-1]

        def healthy():
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as response:
                return response.status == 200 and json.load(response) == {"status": "ok"}

        wait_for(healthy)
        portal_request = urllib.request.Request(f"http://127.0.0.1:{port}/portal", headers={"X-Sipper-Edge-Secret": app_values["SIPPER_EDGE_SHARED_SECRET"], "X-Sipper-Client-IP": "192.0.2.10"})
        with urllib.request.urlopen(portal_request, timeout=5) as response:
            assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
            html = response.read().decode()
            assert "Sipper" in html
            csp = response.headers["Content-Security-Policy"]
            assert "form-action 'self'" in csp and "frame-ancestors 'none'" in csp and "'unsafe-eval'" not in csp
            assert response.headers["Referrer-Policy"] == "no-referrer"
            for attributes, script in re.findall(r'<script\b([^>]*)>(.*?)</script>', html, re.S):
                if 'src=' not in attributes and script:
                    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
                    assert f"'sha256-{digest}'" in csp, "A rendered inline script is blocked by the CSP"
            script_path = re.search(r'<script[^>]*src="([^"]+)"', html).group(1)
        for path in ['/portal', '/api/platform/overview', script_path]:
            try:
                urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"X-Sipper-Verified-IP": "198.51.100.99", "X-Sipper-Client-IP": "198.51.100.99"}), timeout=5)
                raise AssertionError(f'Direct origin access was accepted: {path}')
            except urllib.error.HTTPError as error:
                assert error.code == 403

        # Start the real Worker proxy logic with a loopback-only transport adapter.
        # The production origin still runs with production configuration and CSP.
        preview = subprocess.Popen([os.environ.get("SIPPER_REHEARSAL_NODE", "node"), str(ROOT / 'infra/recovery/edge-preview.mjs')],
            env={**os.environ, "SIPPER_REHEARSAL_ORIGIN": f"http://127.0.0.1:{port}", "SIPPER_EDGE_SHARED_SECRET": app_values["SIPPER_EDGE_SHARED_SECRET"]},
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        preview_url = preview.stdout.readline().strip()
        assert re.fullmatch(r'http://localhost:[0-9]+', preview_url)
        app(target_env, """
import { hashPassword } from 'better-auth/crypto';
import { getPool } from './server/lib/db.ts';
const db = getPool();
await db.query(`INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('edge-fixture','Edge fixture','edge-fixture@example.invalid',true,now(),now())`);
await db.query(`INSERT INTO auth_account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ('edge-fixture','edge-fixture','credential','edge-fixture',$1,now(),now())`, [await hashPassword('Fictional-rehearsal-only-29!')]);
await db.end();
""")
        login = urllib.request.Request(f'{preview_url}/api/auth/sign-in/email', method='POST',
            headers={"Origin": app_values["SIPPER_BASE_URL"], "Content-Type": "application/json", "X-Sipper-Verified-IP": "198.51.100.99", "X-Forwarded-For": "198.51.100.99"},
            data=json.dumps({"email": "edge-fixture@example.invalid", "password": "Fictional-rehearsal-only-29!"}).encode())
        with urllib.request.urlopen(login, timeout=10) as response:
            assert response.status == 200
            cookies = response.headers.get_all('Set-Cookie')
            assert cookies and all('httponly' in cookie.lower() and 'secure' in cookie.lower() for cookie in cookies)
            cookie = '; '.join(value.split(';')[0] for value in cookies)
        with urllib.request.urlopen(urllib.request.Request(f'{preview_url}/api/auth/get-session', headers={"Cookie": cookie}), timeout=5) as response:
            assert json.load(response)['user']['id'] == 'edge-fixture'
            assert response.headers['Cache-Control'] == 'no-store'
        assert sql('restored_test', 'SELECT "ipAddress" FROM auth_session WHERE "userId"=\'edge-fixture\' ORDER BY "createdAt" DESC LIMIT 1') == '127.0.0.1'
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        opener = urllib.request.build_opener(NoRedirect)
        cookie_jar = dict(value.split(';')[0].split('=', 1) for value in cookies)

        def api(path, body=None, content_type='application/json', bearer=None, browser_session=True):
            headers = {'Origin': app_values['SIPPER_BASE_URL']}
            if bearer:
                headers['Authorization'] = f'Bearer {bearer}'
            elif browser_session:
                headers['Cookie'] = '; '.join(f'{key}={value}' for key, value in cookie_jar.items())
            if body is not None:
                headers['Content-Type'] = content_type
            payload = None if body is None else (json.dumps(body) if content_type == 'application/json' else body).encode()
            request = urllib.request.Request(preview_url + path, data=payload, headers=headers)
            try:
                response = opener.open(request, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                for value in response.headers.get_all('Set-Cookie') or []:
                    key, value = value.split(';')[0].split('=', 1)
                    cookie_jar[key] = value
                text = response.read().decode()
                try:
                    data = json.loads(text)
                except ValueError:
                    data = None
                return response.status, data, response.headers

        status, discovery, _ = api('/.well-known/openid-configuration')
        assert status == 200 and discovery['issuer'] == app_values['SIPPER_BASE_URL']
        status, metadata, _ = api('/.well-known/oauth-authorization-server')
        assert status == 200 and metadata['issuer'] == app_values['SIPPER_BASE_URL']
        status, rejected_method, _ = api('/.well-known/openid-configuration', {})
        # Nuxt's exact GET routes hide unsupported methods with 404.
        assert status == 404, f'Metadata method rejection returned {status}'
        status, missing, _ = api('/api/route-that-does-not-exist?token=fictional-do-not-reflect')
        assert status == 404 and missing == {'statusCode': 404, 'message': 'Not found'}
        verifier, state = secrets.token_urlsafe(32), secrets.token_urlsafe(16)
        resource = app_values['SIPPER_BASE_URL'] + '/api/client'
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        query = urlencode({'client_id': 'sipper-macos', 'response_type': 'code', 'redirect_uri': 'com.hybes.sipper:/oauth/callback', 'scope': 'openid email offline_access sipper:client', 'resource': resource, 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
        status, data, headers = api('/api/auth/oauth2/authorize?' + query)
        assert status in [200, 302]
        redirect = urlparse(headers.get('Location') or data['url'])
        if redirect.path == '/portal/consent':
            status, data, _ = api('/api/auth/oauth2/consent', {'accept': True, 'oauth_query': redirect.query})
            assert status == 200
            redirect = urlparse(data['url'])
        callback = parse_qs(redirect.query)
        assert redirect.scheme == 'com.hybes.sipper' and callback['state'] == [state]
        status, tokens, _ = api('/api/auth/oauth2/token', urlencode({'client_id': 'sipper-macos', 'grant_type': 'authorization_code', 'code': callback['code'][0], 'code_verifier': verifier, 'redirect_uri': 'com.hybes.sipper:/oauth/callback', 'resource': resource}), 'application/x-www-form-urlencoded', browser_session=False)
        assert status == 200 and tokens['access_token']
        # The production verifier fetches its issuer's public JWKS. Our .invalid
        # issuer intentionally cannot resolve; validate the actual issued token
        # with the same library and the proxy's loopback JWKS endpoint instead.
        # This does not establish production-origin native API authentication.
        verification = {
            'token': tokens['access_token'], 'jwksUrl': preview_url + '/api/auth/jwks',
            'issuer': app_values['SIPPER_BASE_URL'], 'audience': resource,
        }
        auth_module = (ROOT / 'portal/node_modules/better-auth/dist/oauth2/index.mjs').as_uri()
        run([os.environ.get('SIPPER_REHEARSAL_NODE', 'node'), '--input-type=module'], data=f"""
import assert from 'node:assert/strict';
import {{ verifyBearerToken }} from {json.dumps(auth_module)};
const fixture = {json.dumps(verification)};
const claims = await verifyBearerToken(fixture.token, {{ jwksUrl: fixture.jwksUrl,
  verifyOptions: {{ issuer: fixture.issuer, audience: fixture.audience }}, requiredScopes: ['sipper:client'] }});
assert.equal(claims.sub, 'edge-fixture');
assert.equal(claims.client_id, 'sipper-macos');
assert.equal(typeof claims.sid, 'string');
""")
        assert api('/api/platform/overview', bearer=tokens['access_token'])[0] == 401
        assert api('/api/client/organisations')[0] == 401
        print('PASS: production CSP covers every rendered inline script; direct origin access is refused; proxied sign-in/session and unforgeable observed IP verified', flush=True)
        print('PASS: proxied discovery, native PKCE consent/token exchange, callback integrity, public-key token validation and wrong-credential rejection', flush=True)
        print('LIMIT: native API issuer-JWKS lookup and browser sign-in require the real HTTPS origin; this fixture substitutes loopback only for token verification', flush=True)
        sql("restored_test", "INSERT INTO jobs(kind,payload) VALUES ('email','{}'),('call_push','{}')")
        wait_for(lambda: sql("restored_test", "SELECT count(*) FROM jobs WHERE (kind='email' AND attempts>0 AND last_error='delivery_failed') OR (kind='call_push' AND completed_at IS NOT NULL AND last_error='push_failed')") == "2")
        for service in ["portal", "email", "push"]:
            container = run([*compose, "ps", "-q", service], env=compose_env).stdout.strip()
            state = json.loads(run(["docker", "inspect", container]).stdout)[0]
            assert state["State"]["Running"] and state["Config"]["User"] == "node"
            assert state["HostConfig"]["ReadonlyRootfs"]
            wait_for(lambda: run(["docker", "inspect", "--format", "{{.State.Health.Status}}", container]).stdout.strip() == "healthy")
        assert sql("restored_test", "SELECT count(DISTINCT kind) FROM worker_progress WHERE progressed_at>now()-interval '30 seconds' AND stopped_at IS NULL") == "2"
        print("PASS: restored schema starts the actual Compose portal and both workers; HTTP and queue processing verified", flush=True)
        # Freeze only the disposable push process, leaving Docker's health probe
        # running. A timer-based heartbeat would incorrectly remain healthy here.
        push_container = run([*compose, "ps", "-q", "push"], env=compose_env).stdout.strip()
        push_pid = run(["docker", "exec", push_container, "node", "--input-type=module", "-e", r"""
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const children=readFileSync('/proc/1/task/1/children','utf8').trim().split(/\s+/);
const workers=children.filter(pid=>readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').includes('scripts/push-worker.ts'));
assert.equal(workers.length,1);
process.kill(Number(workers[0]),'SIGSTOP');
console.log(workers[0]);
"""]).stdout.strip()
        assert push_pid.isdigit()
        try:
            wait_for(lambda: sql("restored_test", "SELECT count(*) FROM worker_progress WHERE kind='push' AND progressed_at<=now()-interval '45 seconds' AND stopped_at IS NULL") == "1")
            assert run(["docker", "exec", push_container, "node", "--import", "tsx", "scripts/worker-health.ts", "push"], ok=False).returncode == 1
            wait_for(lambda: run(["docker", "inspect", "--format", "{{.State.Health.Status}}", push_container]).stdout.strip() == "unhealthy")
            assert sql("restored_test", "SELECT count(*) FROM worker_progress WHERE kind='email' AND progressed_at>now()-interval '30 seconds' AND stopped_at IS NULL") == "1"
        finally:
            run(["docker", "exec", push_container, "node", "-e", f"process.kill({push_pid},'SIGCONT')"])
        wait_for(lambda: run(["docker", "inspect", "--format", "{{.State.Health.Status}}", push_container]).stdout.strip() == "healthy")
        print("PASS: a frozen push process becomes stale and Docker-unhealthy while email keeps polling; resuming restores health", flush=True)
        if '--preview' in sys.argv:
            print(f'Local production-policy preview: {preview_url}/portal/sign-in', flush=True)
            input('Press Enter after browser checks to clean up the disposable environment.\n')
    except Exception:
        if '--preview' in sys.argv and preview and preview.poll() is None:
            print(f'Failed-check inspection: {preview_url}/portal/sign-in', flush=True)
            input('Press Enter after inspecting the failure to clean up.\n')
        raise
    finally:
        if preview:
            preview.terminate()
            try:
                preview.wait(timeout=10)
            except subprocess.TimeoutExpired:
                preview.kill(); preview.wait()
        run([*compose, "down", "--volumes", "--remove-orphans", "--timeout", "15"], env=compose_env, ok=False)
        run(["docker", "rm", "-f", "-v", NAME], ok=False)
        run(["docker", "network", "rm", NAME], ok=False)
        assert not run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={NAME}"]).stdout.strip(), "Rehearsal service cleanup failed"
        assert not run(["docker", "ps", "-aq", "--filter", f"name=^/{NAME}$"]).stdout.strip(), "Rehearsal database cleanup failed"
        assert not run(["docker", "network", "ls", "--filter", f"name={NAME}", "--format", "{{.Name}}"]).stdout.strip(), "Rehearsal network cleanup failed"
        os.umask(old_umask)
print("Recovery rehearsal complete; temporary data, keys, containers and network removed.")
