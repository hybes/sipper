#!/usr/bin/env python3
"""Copy a renewed public SIP certificate after gracefully draining the gateway."""
import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def output(*command):
    return subprocess.check_output(command, stderr=subprocess.DEVNULL)


@contextmanager
def certificate_source(directory):
    settings_file = directory / 'deployment.env'
    settings = dict(line.split('=', 1) for line in settings_file.read_text().splitlines()
                    if line.strip() and not line.lstrip().startswith('#')) if settings_file.exists() else {}
    if settings.get('SIPPER_DEPLOYMENT_MODE') == 'shared':
        # Never copy the shared ACME store or another application's private key.
        # Only the Sipper certificate is decoded, entirely on this host.
        allowed = {'sipper.dev', 'www.sipper.dev', 'sip.sipper.dev', 'meet.sipper.dev'}
        data = json.loads(Path(settings['SIPPER_TRAEFIK_ACME_FILE']).read_text())
        resolver = data.get(settings['SIPPER_TRAEFIK_CERT_RESOLVER'], {})
        matches = []
        for entry in resolver.get('Certificates', []):
            domain = entry.get('domain', {})
            names = {domain.get('main'), *domain.get('sans', [])}
            if 'sip.sipper.dev' in names and names <= allowed:
                matches.append(entry)
        if len(matches) != 1:
            raise ValueError('Expected exactly one certificate covering only Sipper hostnames')
        with tempfile.TemporaryDirectory(prefix='.sip-certificate-', dir=directory) as temporary:
            certificate, key = Path(temporary) / 'server.crt', Path(temporary) / 'server.key'
            for path, field in ((certificate, 'certificate'), (key, 'key')):
                with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as target:
                    target.write(base64.b64decode(matches[0][field], validate=True))
            names = set(re.findall(r'DNS:([^,\s]+)', output('openssl', 'x509', '-in', str(certificate),
                                                         '-noout', '-ext', 'subjectAltName').decode()))
            if 'sip.sipper.dev' not in names or not names <= allowed:
                raise ValueError('Certificate includes unexpected hostnames')
            yield certificate, key
        return
    if settings.get('SIPPER_DEPLOYMENT_MODE', 'standalone') != 'standalone':
        raise ValueError('Unknown deployment mode')
    certificates = list((directory / 'caddy-data/caddy/certificates').glob('*/sip.sipper.dev/sip.sipper.dev.crt'))
    if not certificates:
        raise ValueError('SIP certificate is not available yet')
    certificate = max(certificates, key=lambda path: path.stat().st_mtime)
    yield certificate, certificate.with_suffix('.key')


def sync(directory):
    with certificate_source(directory) as (certificate, key):
        install(directory, certificate, key)


def install(directory, certificate, key):
    root = Path(__file__).resolve().parents[2]
    compose = ['sh', str(root / 'infra/single-host/compose.sh'), '--profile', 'calling']
    env = {**os.environ, 'SIPPER_DEPLOYMENT_ENV': str(directory / 'deployment.env')}
    output('openssl', 'x509', '-in', str(certificate), '-checkend', '604800', '-noout')
    # x509 -checkhost reports a mismatch with exit status 0 on OpenSSL 3.
    # The configured proxy supplies the trusted certificate; verify makes hostname, validity
    # and TLS-server usage failures fatal without parsing human-readable output.
    output('openssl', 'verify', '-trusted', str(certificate), '-partial_chain',
           '-purpose', 'sslserver', '-verify_hostname', 'sip.sipper.dev', str(certificate))
    cert_public = output('openssl', 'x509', '-in', str(certificate), '-pubkey', '-noout')
    key_public = output('openssl', 'pkey', '-in', str(key), '-pubout')
    if cert_public != key_public:
        raise ValueError('Certificate and key do not match')
    target = directory / 'gateway-tls'
    if all((target / name).exists() and hashlib.sha256((target / name).read_bytes()).digest() == hashlib.sha256(source.read_bytes()).digest()
           for name, source in [('server.crt', certificate), ('server.key', key)]):
        print('SIP certificate is current.')
        return
    running = set(subprocess.check_output([*compose, 'ps', '--status', 'running', '--services'], env=env, text=True).split())
    if ('controller' in running) != ('asterisk' in running):
        raise ValueError('Recover both gateway services before certificate rotation')
    restart = 'controller' in running
    # Prepare both files before taking a healthy gateway out of service. A full
    # disk or unreadable source must not interrupt calls during renewal.
    staged = []
    try:
        for name, source in [('server.crt', certificate), ('server.key', key)]:
            descriptor, temporary = tempfile.mkstemp(prefix=f'.{name}.', dir=target)
            staged.append((Path(temporary), target / name))
            with os.fdopen(descriptor, 'wb') as file:
                file.write(source.read_bytes())
                file.flush()
                os.fsync(file.fileno())
            os.chown(temporary, 10001, 10001)
        if restart:
            # Existing calls finish before Asterisk is stopped. Never force this drain.
            subprocess.run([*compose, 'stop', 'controller'], env=env, check=True)
            subprocess.run([*compose, 'stop', 'asterisk'], env=env, check=True)
        for temporary, destination in staged:
            temporary.replace(destination)
        if restart:
            subprocess.run([*compose, 'up', '-d', '--no-build', 'asterisk', 'controller'], env=env, check=True)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    print('SIP certificate installed; gateway restarted only if it was already running.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/etc/sipper'))
    args = parser.parse_args()
    try:
        with os.fdopen(os.open(args.directory / 'certificate-sync.lock', os.O_WRONLY | os.O_CREAT, 0o600), 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            sync(args.directory.resolve())
    except Exception as error:
        print(f'SIP certificate update failed ({type(error).__name__}); inspect gateway and certificate state before retrying.')
        raise SystemExit(1)
