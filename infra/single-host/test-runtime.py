#!/usr/bin/env python3
"""Rehearse generated production settings with disposable, isolated containers."""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
APP = os.environ.get('SIPPER_REHEARSAL_APP_IMAGE', 'sipper-platform:local')
WEBSITE = os.environ.get('SIPPER_REHEARSAL_WEBSITE_IMAGE', 'sipper-website:local')
POSTGRES = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'


def docker(*args, data=None, required=True):
    result = subprocess.run(['docker', *args], input=data, text=True, capture_output=True, timeout=180)
    if required and result.returncode:
        # Never expose generated environment values or database driver errors.
        diagnostic = re.search(r'^CHECK [a-zA-Z0-9 :_-]+$', result.stderr, re.M)
        raise RuntimeError(f'Docker {args[0]} failed with exit {result.returncode}' + (f': {diagnostic[0]}' if diagnostic else ''))
    return result


def wait_for(check):
    for attempt in range(60):
        if check():
            return
        time.sleep(0.5)
    raise RuntimeError('Disposable service did not become ready')


def main():
    name = 'sipper-runtime-' + uuid.uuid4().hex[:10]
    containers = []
    docker('network', 'create', '--internal', name)
    try:
        with tempfile.TemporaryDirectory(prefix=name) as temporary:
            private = Path(temporary) / 'private'
            smtp = Path(temporary) / 'smtp.env'
            smtp.write_text('SMTP_HOST=unconfigured.example.invalid\nMAIL_FROM=Sipper <accounts@example.invalid>\n')
            spec = importlib.util.spec_from_file_location('prepare', ROOT / 'infra/single-host/prepare.py')
            prepare = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(prepare)
            prepare.prepare(private, '198.51.100.10', smtp, 'fixture', 'pbx.example.invalid')
            before = (private / 'portal.env').read_bytes()
            try:
                prepare.prepare(private, '198.51.100.10', smtp, 'fixture', '')
                raise AssertionError('Preparation overwrote existing deployment settings')
            except ValueError:
                assert (private / 'portal.env').read_bytes() == before
            assert (private / 'portal.env').stat().st_mode & 0o777 == 0o600
            # Copy the generated files into this disposable container so its Linux
            # UID ownership can be tested even when the harness runs on macOS.
            db = docker('create', '--name', name, '--network', name, '--network-alias', 'postgres',
                        '--env-file', str(private / 'postgres.env'), '--entrypoint', 'sh', POSTGRES,
                        '-c', 'chown -R 70:70 /run/database-tls /docker-entrypoint-initdb.d && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/database-tls/server.crt -c ssl_key_file=/run/database-tls/server.key -c hba_file=/run/database-tls/pg_hba.conf').stdout.strip()
            containers.append(db)
            docker('cp', str(private / 'database'), f'{db}:/run/database-tls')
            docker('cp', str(private / 'database-init') + '/.', f'{db}:/docker-entrypoint-initdb.d')
            docker('start', db)
            wait_for(lambda: docker('exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'sipper_admin', '-d', 'sipper', required=False).returncode == 0)
            common = ['--network', name, '--env-file', str(private / 'portal.env'), '--read-only',
                      '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,size=64m,mode=1777',
                      '-v', f'{private}/database/ca.crt:/run/database-ca/ca.crt:ro']
            docker('run', '--rm', *common, APP, 'migrate')
            docker('exec', '-i', db, 'psql', '-X', '-U', 'sipper_admin', '-d', 'sipper', '-v', 'ON_ERROR_STOP=1',
                   data=(ROOT / 'infra/single-host/grant-gateway.sql').read_text())
            docker('run', '--rm', '-i', *common, '--entrypoint', 'node', APP, '--import', 'tsx', '--input-type=module', data="""
import assert from 'node:assert/strict';
import { getPool } from './server/lib/db.ts';
const db=getPool();
assert.equal((await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);
assert.equal((await db.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,false);
await db.end();
""")
            # Gateway view reads succeed; raw identities and writes do not.
            values = dict(line.split('=', 1) for line in (private / 'asterisk.env').read_text().splitlines())
            gateway_env = private / 'gateway-probe.env'
            prepare.envfile(gateway_env, {'DATABASE_URL': f"postgresql://sipper_gateway:{values['SIPPER_DB_PASSWORD']}@postgres:5432/sipper?sslmode=verify-full&sslrootcert=/run/database-ca/ca.crt"})
            docker('run', '--rm', '-i', '--network', name, '--env-file', str(gateway_env),
                   '-v', f'{private}/database/ca.crt:/run/database-ca/ca.crt:ro', '--entrypoint', 'node', APP, '--input-type=module', data="""
import assert from 'node:assert/strict';
import pg from 'pg';
const connectionString=process.env.DATABASE_URL, db=new pg.Pool({connectionString});
let stage='gateway view read';
try {
for(const view of ['gateway_ps_endpoints','gateway_ps_auths','gateway_ps_aors']) await db.query(`SELECT * FROM ${view} LIMIT 0`);
stage='gateway private table rejection';
await assert.rejects(db.query('SELECT * FROM auth_user LIMIT 0'),e=>e.code==='42501');
stage='gateway write rejection';
assert.equal((await db.query("SELECT has_table_privilege(current_user,'gateway_ps_auths','INSERT,UPDATE,DELETE') AS allowed")).rows[0].allowed,false);
await assert.rejects(db.query('DELETE FROM gateway_ps_auths WHERE false'));
await db.end();
for(const mode of ['disable','untrusted']) {
 stage='TLS '+mode+' rejection';
 const url=new URL(connectionString);url.search='';
 if(mode==='disable')url.searchParams.set('sslmode','disable');else url.searchParams.set('sslmode','verify-full');
 const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:3000});
 await assert.rejects(client.connect()); await client.end();
}
} catch(error) { console.error('CHECK '+stage+': '+(error.code??error.name)); process.exit(1); }
""")
            print('PASS: immutable private configuration, verified database TLS, all migrations, least-privilege gateway views and plaintext rejection.', flush=True)
            app_ids = {}
            for service in ['portal', 'email', 'push']:
                container = docker('run', '-d', '--network-alias', service, *common, APP, service).stdout.strip()
                containers.append(container)
                app_ids[service] = container
            wait_for(lambda: docker('exec', app_ids['portal'], 'node', '-e', "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", required=False).returncode == 0)
            for service in ['email', 'push']:
                wait_for(lambda: docker('exec', app_ids[service], 'node', '--import', 'tsx', 'scripts/worker-health.ts', service, required=False).returncode == 0)
            docker('exec', '-i', app_ids['portal'], 'node', '--input-type=module', data="""
import assert from 'node:assert/strict';
const url='http://127.0.0.1:3100';
assert.equal((await fetch(url+'/portal/sign-in')).status,403);
const headers={'x-sipper-edge-secret':process.env.SIPPER_EDGE_SHARED_SECRET,'x-sipper-client-ip':'192.0.2.10'};
const signIn=await fetch(url+'/portal/sign-in',{headers});assert.equal(signIn.status,200);
assert.match(signIn.headers.get('content-security-policy'),/default-src/);
assert.equal((await fetch(url+'/api/platform/overview',{headers})).status,401);
assert.equal(process.env.SIPPER_ALLOW_TEST_BILLING,'false');
assert.equal(process.env.STRIPE_SECRET_KEY,undefined);
""")
            website = docker('run', '-d', '--network', name, '--read-only', '--cap-drop=ALL',
                             '--env-file', str(private / 'website.env'), WEBSITE).stdout.strip()
            containers.append(website)
            wait_for(lambda: docker('exec', website, 'node', '-e', "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", required=False).returncode == 0)
            docker('exec', website, 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>r.text()).then(t=>{if(!t.includes('Management')||!t.includes('pilot'))process.exit(1)})")
            print('PASS: production portal and workers start, origin is protected, anonymous access is rejected, payments remain disabled and the website serves management links.', flush=True)
    finally:
        for container in reversed(containers):
            docker('rm', '-fv', container, required=False)
        docker('network', 'rm', name)


if __name__ == '__main__':
    main()
