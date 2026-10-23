#!/usr/bin/env python3
"""Check certificate validation and drain ordering without touching a gateway."""
import importlib.util
import base64
import json
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
        self.make_certificate()
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

    def make_certificate(self, hostname='sip.sipper.dev', days=30, sans=None):
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                        '-nodes', '-days', str(days), '-subj', f'/CN={hostname}', '-addext',
                        'subjectAltName=' + ','.join('DNS:' + name for name in (sans or [hostname])),
                        '-keyout', str(self.key), '-out', str(self.certificate)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

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
        self.make_certificate(hostname='wrong.example.invalid')
        with self.assertRaises(subprocess.CalledProcessError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual((self.target / 'server.crt').read_bytes(), b'previous fictional material')

    def test_near_expiry_certificate_is_rejected_before_draining(self):
        self.make_certificate(days=3)
        with self.assertRaises(subprocess.CalledProcessError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])

    def test_unmatched_key_is_rejected_before_draining(self):
        certificate = self.certificate.read_bytes()
        self.make_certificate()
        self.certificate.write_bytes(certificate)
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])

    def test_partial_gateway_state_requires_operator_recovery(self):
        self.running = b'asterisk\n'
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual((self.target / 'server.key').read_bytes(), b'previous fictional material')

    def shared_store(self, names=None):
        names = names or ['sip.sipper.dev']
        entry = {'domain': {'main': names[0], 'sans': names[1:]},
                 'certificate': base64.b64encode(self.certificate.read_bytes()).decode(),
                 'key': base64.b64encode(self.key.read_bytes()).decode()}
        self.acme = self.private / 'fixture-acme.json'
        self.acme.write_text(json.dumps({'fixture': {'Certificates': [
            {'domain': {'main': 'unrelated.example.invalid'}, 'certificate': 'do not decode', 'key': 'do not decode'}, entry]}}))
        (self.private / 'deployment.env').write_text(
            f'SIPPER_DEPLOYMENT_MODE=shared\nSIPPER_TRAEFIK_CERT_RESOLVER=fixture\nSIPPER_TRAEFIK_ACME_FILE={self.acme}\n')
        return entry

    def test_shared_certificate_is_selected_without_changing_store_or_starting_stopped_services(self):
        self.shared_store(['sipper.dev', 'sip.sipper.dev'])
        original = self.acme.read_bytes()
        self.running = b''
        module.sync(self.private)
        module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual(self.acme.read_bytes(), original)
        self.assertEqual((self.target / 'server.key').read_bytes(), self.key.read_bytes())
        self.assertEqual((self.target / 'server.key').stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.private.glob('.sip-certificate-*')), [])

    def test_shared_certificate_covering_another_site_is_rejected(self):
        self.shared_store(['sip.sipper.dev', 'unrelated.example.invalid'])
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])

    def test_shared_certificate_actual_names_must_match_allowed_names(self):
        self.make_certificate(sans=['sip.sipper.dev', 'unrelated.example.invalid'])
        self.shared_store(['sip.sipper.dev'])
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual(list(self.private.glob('.sip-certificate-*')), [])

    def test_ambiguous_shared_certificates_are_rejected(self):
        entry = self.shared_store()
        self.acme.write_text(json.dumps({'fixture': {'Certificates': [entry, entry]}}))
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])

    def test_incomplete_shared_store_leaves_gateway_untouched(self):
        self.shared_store()
        self.acme.write_text('{')
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual((self.target / 'server.key').read_bytes(), b'previous fictional material')

    def test_shared_mismatched_key_is_rejected_and_temporary_material_removed(self):
        certificate = self.certificate.read_bytes()
        self.make_certificate()
        self.certificate.write_bytes(certificate)
        self.shared_store()
        with self.assertRaises(ValueError):
            module.sync(self.private)
        self.assertEqual(self.operations, [])
        self.assertEqual(list(self.private.glob('.sip-certificate-*')), [])


if __name__ == '__main__':
    unittest.main()
