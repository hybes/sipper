#!/usr/bin/env python3
"""Publication/failure checks; actual encryption and restore live in recovery/rehearse.py."""
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sipper_backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
STAMP = '20261023T033000Z'
IMAGE = 'sipper-recovery:' + 'a' * 40


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve() / 'private'
        self.directory.mkdir()
        self.output = Path(self.temporary.name) / 'backups'
        self.output.mkdir()
        (self.output / 'previous').mkdir()
        (self.output / 'previous/keep').write_text('previous backup')
        (self.directory / 'deployment.env').write_text('SIPPER_APP_IMAGE=sipper-platform:' + 'b' * 40 + '\n')
        (self.directory / 'backup.env').write_text(f'SIPPER_BACKUP_IMAGE={IMAGE}\nSIPPER_BACKUP_DIRECTORY={self.output}\nSIPPER_BACKUP_NETWORK=sipper_default\n')
        (self.directory / 'portal.env').write_text('DATABASE_URL=postgresql://sipper_app:fictional-password@postgres:5432/sipper\n')
        (self.directory / 'backup-recipients.txt').write_text('fictional public recipient\n')
        (self.directory / 'database').mkdir()
        (self.directory / 'database/ca.crt').write_text('fictional CA')
        self.commands = []
        self.failure = None
        self.tar_failure = False
        for target, replacement in [
            ('os.chown', lambda *args: None),
            ('datetime', SimpleNamespace(now=lambda _: datetime(2026, 10, 23, 3, 30, tzinfo=timezone.utc))),
            ('subprocess.check_output', lambda *args, **kwargs: 'c' * 40 + '\n'),
            ('subprocess.run', self.run_command),
            ('subprocess.Popen', self.archive),
        ]:
            if '.' in target:
                owner, attribute = target.split('.')
                active = patch.object(getattr(backup, owner), attribute, replacement)
            else:
                active = patch.object(backup, target, replacement)
            active.start()
            self.addCleanup(active.stop)

    def run_command(self, command, **kwargs):
        self.commands.append(command)
        self.assertNotIn('fictional-password', ' '.join(command))
        if command[-1] == 'database-backup.sh':
            self.assertIn('PGSSLMODE=verify-full', command)
            mounted = next(value for value in command if value.startswith('type=bind,') and value.endswith('dst=/backups'))
            path = Path(mounted.split('src=', 1)[1].split(',dst=', 1)[0])
            (path / 'database.dump.age').write_bytes(b'fixture ciphertext')
            if self.failure == 'database':
                raise subprocess.CalledProcessError(1, ['redacted'])
        else:
            kwargs['stdout'].write(b'fixture configuration ciphertext')
        return SimpleNamespace(returncode=1 if self.failure == 'configuration' else 0)

    def archive(self, command, **kwargs):
        self.assertEqual(command[2], str(self.directory))
        return SimpleNamespace(stdout=io.BytesIO(b'fixture tar'), wait=lambda: int(self.tar_failure), poll=lambda: 0)

    def assert_only_previous(self):
        self.assertEqual([path.name for path in self.output.iterdir()], ['previous'])
        self.assertEqual((self.output / 'previous/keep').read_text(), 'previous backup')

    def test_complete_pair_has_checked_manifest_and_no_password_in_commands(self):
        backup.backup(self.directory)
        result = self.output / STAMP
        manifest = json.loads((result / 'manifest.json').read_text())
        self.assertEqual(set(manifest['files']), {'database.dump.age', 'configuration.tar.age'})
        self.assertEqual(manifest['sourceRevision'], 'c' * 40)
        for name, entry in manifest['files'].items():
            self.assertEqual(entry['sha256'], backup.hashlib.sha256((result / name).read_bytes()).hexdigest())
        self.assertFalse(any(path.name.startswith('.') for path in self.output.iterdir()))

    def test_database_failure_removes_partial_pair(self):
        self.failure = 'database'
        with self.assertRaises(subprocess.CalledProcessError): backup.backup(self.directory)
        self.assert_only_previous()

    def test_configuration_failure_does_not_publish_database_alone(self):
        self.failure = 'configuration'
        with self.assertRaises(RuntimeError): backup.backup(self.directory)
        self.assert_only_previous()

    def test_tar_failure_is_not_treated_as_successful_encryption(self):
        self.tar_failure = True
        with self.assertRaises(RuntimeError): backup.backup(self.directory)
        self.assert_only_previous()

    def test_existing_snapshot_is_never_replaced(self):
        (self.output / STAMP).mkdir()
        (self.output / STAMP / 'keep').write_text('keep existing snapshot')
        with self.assertRaises(ValueError): backup.backup(self.directory)
        self.assertEqual((self.output / STAMP / 'keep').read_text(), 'keep existing snapshot')
        self.assertEqual(self.commands, [])

    def test_missing_recipient_stops_before_database_access(self):
        (self.directory / 'backup-recipients.txt').unlink()
        with self.assertRaises(ValueError): backup.backup(self.directory)
        self.assertEqual(self.commands, [])
        self.assert_only_previous()

    def test_output_inside_configuration_is_rejected(self):
        (self.directory / 'backup.env').write_text(f'SIPPER_BACKUP_IMAGE={IMAGE}\nSIPPER_BACKUP_DIRECTORY={self.directory}\nSIPPER_BACKUP_NETWORK=sipper_default\n')
        with self.assertRaises(ValueError): backup.backup(self.directory)
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main()
