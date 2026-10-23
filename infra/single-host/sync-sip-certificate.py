#!/usr/bin/env python3
"""Copy a renewed public SIP certificate after gracefully draining the gateway."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile


def output(*command):
    return subprocess.check_output(command, stderr=subprocess.DEVNULL)


def sync(directory):
    root = Path(__file__).resolve().parents[2]
    compose = ['sh', str(root / 'infra/single-host/compose.sh'), '--profile', 'calling']
    env = {**os.environ, 'SIPPER_DEPLOYMENT_ENV': str(directory / 'deployment.env')}
    certificates = list((directory / 'caddy-data/caddy/certificates').glob('*/sip.sipper.dev/sip.sipper.dev.crt'))
    if not certificates:
        raise ValueError('SIP certificate is not available yet')
    certificate = max(certificates, key=lambda path: path.stat().st_mtime)
    key = certificate.with_suffix('.key')
    output('openssl', 'x509', '-in', str(certificate), '-checkend', '604800', '-noout')
    # x509 -checkhost reports a mismatch with exit status 0 on OpenSSL 3.
    # Caddy supplies the trusted certificate; verify makes hostname, validity
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
