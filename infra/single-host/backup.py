#!/usr/bin/env python3
"""Back up this deployment without storing plaintext dumps or recovery keys."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit


def settings(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if line.strip() and not line.lstrip().startswith('#'))


def backup(directory):
    directory = directory.resolve()
    deployment = settings(directory / 'deployment.env')
    config = settings(directory / 'backup.env')
    image = config['SIPPER_BACKUP_IMAGE']
    if not re.fullmatch(r'sipper-recovery:[a-f0-9]{40}', image):
        raise ValueError('Use an immutable reviewed recovery image tag')
    destination = Path(config['SIPPER_BACKUP_DIRECTORY'])
    if not destination.is_absolute() or not destination.is_dir():
        raise ValueError('Create the private backup directory first')
    destination = destination.resolve()
    if destination == directory or directory in destination.parents:
        raise ValueError('Keep backup output outside the configuration being archived')
    recipients = directory / 'backup-recipients.txt'
    if not recipients.is_file() or not recipients.stat().st_size:
        raise ValueError('Install the public recovery recipients first')
    # The application role owns the database; no cluster administrator is used.
    database = urlsplit(settings(directory / 'portal.env')['DATABASE_URL'])
    if database.scheme != 'postgresql' or not database.hostname or not database.username or not database.password:
        raise ValueError('Invalid application database connection')
    ca = directory / 'database/ca.crt'
    if not ca.is_file():
        raise ValueError('The private database CA is missing')
    root = Path(__file__).resolve().parents[2]
    revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    final = destination / stamp
    if final.exists():
        raise ValueError('Refusing to replace an existing backup')
    partial = Path(tempfile.mkdtemp(prefix=f'.{stamp}-', dir=destination))
    # postgres:17-alpine's recovery image runs as UID 70. Only ciphertext is
    # writable in its output mount; private settings remain outside the image.
    os.chown(partial, 70, 70)
    base = ['docker', 'run', '--rm', '--pull=never', '--read-only', '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true', '--user', '70:70',
            '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
            '--mount', f'type=bind,src={recipients},dst=/run/secrets/recipients,readonly']
    try:
        with tempfile.TemporaryDirectory(prefix='sipper-backup-') as temporary:
            pgpass = Path(temporary) / 'pgpass'
            escape = lambda value: str(value).replace('\\', '\\\\').replace(':', '\\:')
            pgpass.write_text(':'.join(escape(value) for value in [database.hostname, database.port or 5432,
                              unquote(database.path[1:]), unquote(database.username), unquote(database.password)]) + '\n')
            pgpass.chmod(0o600)
            os.chown(pgpass, 70, 70)
            command = [*base, '--network', config['SIPPER_BACKUP_NETWORK'],
                       '--mount', f'type=bind,src={pgpass},dst=/run/secrets/pgpass,readonly',
                       '--mount', f'type=bind,src={ca},dst=/run/secrets/ca.crt,readonly',
                       '--mount', f'type=bind,src={partial},dst=/backups']
            for key, value in {'PGHOST': database.hostname, 'PGPORT': database.port or 5432,
                               'PGDATABASE': unquote(database.path[1:]), 'PGUSER': unquote(database.username),
                               'PGPASSFILE': '/run/secrets/pgpass', 'PGSSLMODE': 'verify-full',
                               'PGSSLROOTCERT': '/run/secrets/ca.crt',
                               'SIPPER_BACKUP_RECIPIENTS': '/run/secrets/recipients',
                               'SIPPER_BACKUP_OUTPUT': '/backups/database.dump.age'}.items():
                command += ['--env', f'{key}={value}']
            subprocess.run([*command, image, 'database-backup.sh'], check=True)
        # Escrow the Sipper configuration and encryption keys as ciphertext.
        # Never mount the shared proxy's ACME store or another application's data.
        with (partial / 'configuration.tar.age').open('xb') as encrypted:
            archive = subprocess.Popen(['tar', '-C', str(directory), '--exclude=./backup.lock',
                                        '--exclude=./certificate-sync.lock', '-cf', '-', '.'], stdout=subprocess.PIPE)
            try:
                result = subprocess.run([*base, '--network', 'none', '-i', image, 'age', '--encrypt',
                                         '--recipients-file', '/run/secrets/recipients'], stdin=archive.stdout, stdout=encrypted)
                archive.stdout.close()
                if archive.wait() != 0 or result.returncode != 0:
                    raise RuntimeError('Configuration encryption failed')
            finally:
                if archive.poll() is None:
                    archive.terminate()
                    archive.wait()
        manifest = {'createdAt': stamp, 'sourceRevision': revision,
                    'images': {key: value for key, value in deployment.items() if key.endswith('_IMAGE')},
                    'recoveryImage': image, 'files': {}}
        for name in ['database.dump.age', 'configuration.tar.age']:
            path = partial / name
            if not path.stat().st_size:
                raise ValueError('An encrypted archive is empty')
            with path.open('rb') as stream:
                manifest['files'][name] = {'sha256': hashlib.file_digest(stream, 'sha256').hexdigest(), 'bytes': path.stat().st_size}
        (partial / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        partial.rename(final)
        print(f'Encrypted database and configuration backup completed: {final}')
    finally:
        if partial.exists():
            shutil.rmtree(partial)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/etc/sipper'))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        directory = args.directory.resolve()
        with os.fdopen(os.open(directory / 'backup.lock', os.O_WRONLY | os.O_CREAT, 0o600), 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            backup(directory)
    except Exception as error:
        print(f'Sipper backup failed ({type(error).__name__}); inspect private configuration and service status.')
        raise SystemExit(1)
