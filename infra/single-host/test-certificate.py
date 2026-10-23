#!/usr/bin/env python3
"""Check certificate validation and drain ordering without touching a gateway."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('certificate_sync', Path(__file__).with_name('sync-sip-certificate.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CertificateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sipper-certificate-test-')
        self.addCleanup(self.temporary.cleanup)
        self.private = Path(self.temporary.name)
        self.source = self.private / 'caddy-data/caddy/certificates/fictional/sip.sipper.dev'
        self.source.mkdir(parents=True)
        self.target = self.private / 'gateway-tls'
        self.target.mkdir()
        self.certificate = self.source / 'sip.sipper.dev.crt'
        self.key = self.source / 'sip.sipper.dev.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                        '-nodes', '-days', '30', '-subj', '/CN=sip.sipper.dev', '-addext', 'subjectAltName=DNS:sip.sipper.dev',
                        '-keyout', str(self.key), '-out', str(self.certificate)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name in ['server.crt', 'server.key']:
            (self.target / name).write_bytes(b'previous fictional material')
        self.operations = []
        self.running = b'asterisk\ncontroller\n'
        original_output, original_run = subprocess.check_output, subprocess.run

        def output(command, **kwargs):
            if command[0] == 'sh':
                return self.running.decode() if kwargs.get('text') else self.running
            return original_output(command, **kwargs)

        def run(command, **kwargs):
            if command[0] != 'sh':
                return original_run(command, **kwargs)
            operation = command[4:]
            self.operations.append(operation)
            if operation == ['stop', 'controller']:
                # Both replacement files exist before taking a service down.
                self.assertEqual(len(list(self.target.glob('.server.*'))), 2)
                self.assertEqual((self.target / 'server.key').read_bytes(), b'previous fictional material')
            return subprocess.CompletedProcess(command, 0)

        for mocked in [patch.object(module.subprocess, 'check_output', side_effect=output),
                       patch.object(module.subprocess, 'run', side_effect=run),
                       patch.object(module.os, 'chown')]:
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_valid_pair_stages_drains_then_restarts_and_unchanged_pair_is_noop(self):
        module.sync(self.private)
        self.assertEqual(self.operations, [['stop', 'controller'], ['stop', 'asterisk'],
                                          ['up', '-d', '--no-build', 'asterisk', 'controller']])
        self.assertEqual((self.target / 'server.crt').read_bytes(), self.certificate.read_bytes())
        self.assertEqual((self.target / 'server.key').read_bytes(), self.key.read_bytes())
        self.assertEqual((self.target / 'server.key').stat().st_mode & 0o777, 0o600)
        self.operations.clear()
        module.sync(self.private)
        self.assertEqual(self.operations, [])

    def test_write_failure_leaves_old_pair_and_running_gateway_untouched(self):
        original = module.tempfile.mkstemp
        attempts = 0

        def full_disk(**kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                raise OSError('Fictional full disk')
            return original(**kwargs)

        with patch.object(module.tempfile, 'mkstemp', side_effect=full_disk):
            with self.assertRaises(OSError):
                module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual(list(self.target.glob('.server.*')), [])
        self.assertEqual((self.target / 'server.key').read_bytes(), b'previous fictional material')

    def test_wrong_certificate_hostname_is_rejected_before_draining(self):
        original = module.output

        def wrong_host(*command):
            if '-checkhost' in command:
                command = (*command[:-2], 'wrong.example.invalid', '-noout')
            return original(*command)

        with patch.object(module, 'output', side_effect=wrong_host):
            with self.assertRaises(subprocess.CalledProcessError):
                module.sync(self.private)
        self.assertEqual(self.operations, [])

    def test_partial_gateway_state_requires_operator_recovery(self):
        self.running = b'asterisk\n'
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual((self.target / 'server.key').read_bytes(), b'previous fictional material')


if __name__ == '__main__':
    unittest.main()
