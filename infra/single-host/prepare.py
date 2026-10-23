#!/usr/bin/env python3
"""Generate a fresh single-host deployment's private settings; never overwrite them."""
import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess


def write(path, text, mode=0o600):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode), 'w') as output:
        output.write(text)


def envfile(path, values):
    if any('\n' in str(v) or '\r' in str(v) for v in values.values()):
        raise ValueError('Environment values must occupy a single line')
    write(path, ''.join(f'{key}={value}\n' for key, value in values.items()))


def run(*command):
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def prepare(directory, public_ip, smtp_file, release, upstreams, *, proxy_network=None,
            traefik_ip=None, traefik_resolver=None, traefik_acme_file=None):
    directory = directory.resolve()
    ipaddress.IPv4Address(public_ip)
    shared_values = (proxy_network, traefik_ip, traefik_resolver, traefik_acme_file)
    shared = any(shared_values)
    if shared:
        if not all(shared_values):
            raise ValueError('Shared hosting needs the proxy network, exact proxy IP, certificate resolver and ACME file')
        ipaddress.ip_address(traefik_ip)
        for name in (proxy_network, traefik_resolver):
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', name):
                raise ValueError('Invalid proxy network or certificate resolver name')
        if not Path(traefik_acme_file).is_absolute() or any(char.isspace() for char in str(traefik_acme_file)):
            raise ValueError('The existing Traefik ACME file must have an absolute path without whitespace')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', release):
        raise ValueError('Use a simple immutable release tag')
    for host in filter(None, upstreams.split(',')):
        if not re.fullmatch(r'[a-zA-Z0-9.-]{1,253}', host):
            raise ValueError('Upstream hosts must be exact hostnames')
    smtp = {}
    for line in smtp_file.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            if key in {'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'}:
                smtp[key] = value
    if not smtp.get('SMTP_HOST') or not smtp.get('MAIL_FROM'):
        raise ValueError('The private SMTP file must set SMTP_HOST and MAIL_FROM')
    smtp.setdefault('SMTP_PORT', '587')
    smtp.setdefault('SMTP_SECURE', 'false')
    if smtp['SMTP_SECURE'] not in ('true', 'false') or not 1 <= int(smtp['SMTP_PORT']) <= 65535:
        raise ValueError('Invalid SMTP port or TLS mode')
    if bool(smtp.get('SMTP_USER')) != bool(smtp.get('SMTP_PASSWORD')):
        raise ValueError('Set both SMTP_USER and SMTP_PASSWORD')
    if directory.exists():
        raise ValueError('Deployment directory already exists; preserve its keys and edit settings deliberately')
    directory.mkdir(mode=0o700, parents=True)
    os.umask(0o077)
    for name in ('database', 'database-init', 'gateway-tls', 'caddy-data', 'keys'):
        (directory / name).mkdir(mode=0o700)
    token = lambda: secrets.token_urlsafe(48)
    app_password, db_password = token(), token()
    gateway_password = secrets.token_urlsafe(32)  # Asterisk's DB fields are limited to 63 characters.
    edge, gateway_api, ari, ami = token(), token(), token(), token()
    meeting_key, meeting_secret, admission = secrets.token_hex(12), token(), token()
    ca = directory / 'database' / 'ca.crt'
    ca_key = directory / 'keys' / 'database-ca.key'
    tls = directory / 'database'
    run('openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650', '-subj', '/CN=Sipper private database CA', '-keyout', str(ca_key), '-out', str(ca))
    run('openssl', 'req', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=postgres', '-keyout', str(tls / 'server.key'), '-out', str(directory / 'keys' / 'database.csr'))
    write(directory / 'keys' / 'database.ext', 'subjectAltName=DNS:postgres\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
    run('openssl', 'x509', '-req', '-days', '397', '-in', str(directory / 'keys' / 'database.csr'), '-CA', str(ca), '-CAkey', str(ca_key), '-CAcreateserial', '-extfile', str(directory / 'keys' / 'database.ext'), '-out', str(tls / 'server.crt'))
    os.chmod(tls, 0o755)
    os.chmod(ca, 0o644)
    os.chmod(tls / 'server.crt', 0o644)
    os.chmod(tls / 'server.key', 0o600)
    write(tls / 'pg_hba.conf', 'local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::0/0 scram-sha-256\n', 0o644)
    os.chmod(tls / 'pg_hba.conf', 0o644)
    # postgres:17-alpine uses UID/GID 70; only its server key is readable by it.
    if os.geteuid() == 0:
        os.chown(tls / 'server.key', 70, 70)
        os.chown(directory / 'database-init', 70, 70)
        os.chown(directory / 'gateway-tls', 10001, 10001)
    write(directory / 'database-init' / '010-sipper.sql',
          f"CREATE ROLE sipper_app LOGIN PASSWORD '{app_password}';\n"
          "CREATE DATABASE sipper OWNER sipper_app;\n"
          f"CREATE ROLE sipper_gateway LOGIN PASSWORD '{gateway_password}';\n")
    if os.geteuid() == 0:
        os.chown(directory / 'database-init' / '010-sipper.sql', 70, 70)
    envfile(directory / 'postgres.env', {'POSTGRES_USER': 'sipper_admin', 'POSTGRES_PASSWORD': db_password, 'POSTGRES_DB': 'postgres', 'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256'})
    envfile(directory / 'portal.env', {
        'NODE_ENV': 'production', 'SIPPER_BASE_URL': 'https://sipper.dev',
        'DATABASE_URL': f'postgresql://sipper_app:{app_password}@postgres:5432/sipper?sslmode=verify-full&sslrootcert=/run/database-ca/ca.crt',
        'BETTER_AUTH_SECRET': token(), 'SIPPER_ENCRYPTION_KEY_ID': 'v1',
        'SIPPER_ENCRYPTION_KEYS': json.dumps({'v1': base64.b64encode(secrets.token_bytes(32)).decode()}, separators=(',', ':')),
        'SIPPER_EDGE_SHARED_SECRET': edge, 'SIPPER_REQUIRE_ADMIN_MFA': 'true', 'SIPPER_ALLOW_TEST_BILLING': 'false',
        'SIPPER_GATEWAY_API_KEY': gateway_api, 'SIPPER_GATEWAY_ID': 'primary',
        'SIPPER_GATEWAY_PUBLIC_HOST': 'sip.sipper.dev', 'SIPPER_GATEWAY_PUBLIC_PORT': '5061',
        'SIPPER_MEETING_PUBLIC_URL': 'wss://meet.sipper.dev', 'SIPPER_MEETING_INTERNAL_URL': 'http://meetings-media:7880',
        'SIPPER_MEETING_API_KEY': meeting_key, 'SIPPER_MEETING_API_SECRET': meeting_secret, 'SIPPER_MEETING_ADMISSION_KEY': admission,
        'SIPPER_MESSAGE_RETENTION_DAYS': '90', 'SIPPER_CALL_RETENTION_HOURS': '24', **smtp,
    })
    envfile(directory / 'edge.env', {'SIPPER_EDGE_SHARED_SECRET': edge})
    envfile(directory / 'website.env', {
        'SIPPER_MANAGEMENT_ENABLED': 'true',
        'MAC_DOWNLOAD_URL': 'https://github.com/hybes/sipper/releases/download/v0.1.0/Sipper-0.1.0.dmg',
        'WINDOWS_DOWNLOAD_URL': 'https://github.com/hybes/sipper/releases/download/windows-v0.1.0/Sipper-0.1.0-Setup.exe',
    })
    envfile(directory / 'asterisk.env', {
        'SIPPER_DB_HOST': 'postgres', 'SIPPER_DB_PORT': '5432', 'SIPPER_DB_NAME': 'sipper',
        'SIPPER_DB_USER': 'sipper_gateway', 'SIPPER_DB_PASSWORD': gateway_password,
        'PGSSLMODE': 'verify-full', 'PGSSLROOTCERT': '/run/database-ca/ca.crt',
        'SIPPER_ARI_PASSWORD': ari, 'SIPPER_AMI_PASSWORD': ami,
        'SIPPER_MEDIA_PUBLIC_IP': public_ip, 'SIPPER_SIGNAL_PUBLIC_IP': public_ip, 'SIPPER_SIGNAL_PUBLIC_PORT': '5061',
    })
    envfile(directory / 'controller.env', {
        'SIPPER_PORTAL_URL': 'https://sipper.dev', 'SIPPER_GATEWAY_API_KEY': gateway_api,
        'SIPPER_ARI_PASSWORD': ari, 'SIPPER_AMI_PASSWORD': ami, 'SIPPER_UPSTREAM_HOSTS': upstreams,
    })
    envfile(directory / 'meeting-proxy.env', {
        'SIPPER_MEETING_INTERNAL_URL': 'http://meetings-media:7880',
        'SIPPER_MEETING_ADMISSION_URL': 'http://portal:3100/api/meetings/admission',
        'SIPPER_MEETING_ADMISSION_KEY': admission, 'SIPPER_EDGE_SHARED_SECRET': edge,
    })
    write(directory / 'livekit.yaml', f'''port: 7880
bind_addresses: [0.0.0.0]
rtc:
  tcp_port: 7882
  udp_port: 7883
  use_external_ip: false
  node_ip: {public_ip}
keys:
  {meeting_key}: {meeting_secret}
room:
  auto_create: false
  max_participants: 100
  enable_remote_unmute: false
logging:
  level: warn
''')
    if os.geteuid() == 0:
        os.chown(directory / 'livekit.yaml', 1000, 1000)
    envfile(directory / 'deployment.env', {
        'SIPPER_DEPLOYMENT_MODE': 'shared' if shared else 'standalone',
        **({'SIPPER_PROXY_NETWORK': proxy_network, 'SIPPER_TRAEFIK_IP': traefik_ip,
            'SIPPER_TRAEFIK_CERT_RESOLVER': traefik_resolver, 'SIPPER_TRAEFIK_ACME_FILE': traefik_acme_file} if shared else {}),
        'SIPPER_PRIVATE_DIRECTORY': directory, 'SIPPER_APP_ENV_FILE': directory / 'portal.env',
        'SIPPER_APP_IMAGE': f'sipper-platform:{release}', 'SIPPER_WEBSITE_IMAGE': f'sipper-website:{release}',
        'SIPPER_CONTROLLER_IMAGE': f'sipper-controller:{release}', 'SIPPER_ASTERISK_IMAGE': f'sipper-asterisk:{release}',
        'SIPPER_ASTERISK_ENV_FILE': directory / 'asterisk.env', 'SIPPER_CONTROLLER_ENV_FILE': directory / 'controller.env',
        'SIPPER_GATEWAY_TLS_DIRECTORY': directory / 'gateway-tls', 'SIPPER_GATEWAY_BIND_IP': '0.0.0.0',
        'SIPPER_MEETING_CONFIG_FILE': directory / 'livekit.yaml', 'SIPPER_MEETING_PROXY_ENV_FILE': directory / 'meeting-proxy.env',
    })
    print('Private deployment settings created. Payments and mobile push remain unconfigured.')
    if os.geteuid() != 0:
        print('Local preparation only: production must run this script as root for container file ownership.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/etc/sipper'))
    parser.add_argument('--public-ip', required=True)
    parser.add_argument('--smtp-env', type=Path, required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--upstreams', default='')
    parser.add_argument('--proxy-network', help='Existing Traefik Docker network; enables shared hosting')
    parser.add_argument('--traefik-ip', help='Exact address of Traefik on that network, never the whole subnet')
    parser.add_argument('--traefik-resolver', help='Existing Traefik certificate resolver')
    parser.add_argument('--traefik-acme-file', type=Path, help='Existing private ACME JSON, read only for the Sipper SIP certificate')
    args = parser.parse_args()
    try:
        prepare(args.directory, args.public_ip, args.smtp_env, args.release, args.upstreams,
                proxy_network=args.proxy_network, traefik_ip=args.traefik_ip,
                traefik_resolver=args.traefik_resolver, traefik_acme_file=args.traefik_acme_file)
    except Exception as error:
        # Provider values, generated keys and subprocess arguments are never logged.
        print(f'Preparation failed ({type(error).__name__}). Check inputs; preserve any generated keys before retrying.')
        raise SystemExit(1)
