import unittest
from media_config import media_configuration


class MediaConfigurationTest(unittest.TestCase):
    def test_direct_media_has_no_nat_override(self):
        rtp, transport = media_configuration({})
        self.assertIn('rtpstart = 20000\nrtpend = 20199', rtp)
        self.assertIn('strictrtp = yes', rtp)
        self.assertNotIn('ice_host_candidates', rtp)
        self.assertEqual(transport, '')

    def test_nat_replaces_candidate_and_preserves_local_upstream_routes(self):
        rtp, transport = media_configuration({
            'SIPPER_RTP_START': '27000', 'SIPPER_RTP_END': '27031',
            'SIPPER_MEDIA_PUBLIC_IP': '198.51.100.10', 'SIPPER_MEDIA_LOCAL_IP': '192.0.2.20',
            'SIPPER_MEDIA_LOCAL_NETWORKS': '192.0.2.0/24,2001:db8::/32',
        })
        self.assertIn('rtpstart = 27000\nrtpend = 27031', rtp)
        self.assertIn('192.0.2.20 => 198.51.100.10\n', rtp)
        self.assertNotIn('include_local_address', rtp)
        self.assertEqual(transport, 'external_media_address = 198.51.100.10\nlocal_net = 192.0.2.0/24\nlocal_net = 2001:db8::/32\n')

    def test_invalid_ranges_addresses_and_config_injection_fail_closed(self):
        valid = {'SIPPER_MEDIA_PUBLIC_IP': '198.51.100.10', 'SIPPER_MEDIA_LOCAL_IP': '192.0.2.20'}
        for invalid in [{'SIPPER_RTP_START': '27001'}, {'SIPPER_RTP_END': '99999'},
                        {'SIPPER_RTP_START': '80'}, {'SIPPER_RTP_END': '20000'},
                        {'SIPPER_MEDIA_PUBLIC_IP': 'example.invalid'},
                        {'SIPPER_MEDIA_PUBLIC_IP': '198.51.100.10\n[other]'},
                        {'SIPPER_MEDIA_PUBLIC_IP': '2001:db8::1%bad\n[other]', 'SIPPER_MEDIA_LOCAL_IP': '2001:db8::2'},
                        {'SIPPER_MEDIA_LOCAL_IP': '2001:db8::1'},
                        {'SIPPER_MEDIA_LOCAL_NETWORKS': '192.0.2.0/24;other=yes'}]:
            with self.subTest(invalid=invalid), self.assertRaises(SystemExit):
                media_configuration(valid | invalid)
        with self.assertRaises(SystemExit):
            media_configuration({'SIPPER_MEDIA_LOCAL_NETWORKS': '192.0.2.0/24'})

    def test_signalling_nat_uses_reachable_contact_port_and_shared_local_networks(self):
        rtp, transport = media_configuration({
            'SIPPER_SIGNAL_PUBLIC_IP': '198.51.100.10', 'SIPPER_SIGNAL_PUBLIC_PORT': '25061',
            'SIPPER_MEDIA_LOCAL_NETWORKS': '192.0.2.0/24',
        })
        self.assertNotIn('ice_host_candidates', rtp)
        self.assertEqual(transport, 'external_signaling_address = 198.51.100.10\nexternal_signaling_port = 25061\nlocal_net = 192.0.2.0/24\n')
        self.assertIn('external_signaling_port = 5061\n', media_configuration({'SIPPER_SIGNAL_PUBLIC_IP': '2001:db8::1'})[1])
        for invalid in [
            {'SIPPER_SIGNAL_PUBLIC_PORT': '25061'},
            {'SIPPER_SIGNAL_PUBLIC_IP': 'example.invalid'},
            {'SIPPER_SIGNAL_PUBLIC_IP': '198.51.100.10\n[other]'},
            {'SIPPER_SIGNAL_PUBLIC_IP': '2001:db8::1%en0'},
            *({'SIPPER_SIGNAL_PUBLIC_IP': '198.51.100.10', 'SIPPER_SIGNAL_PUBLIC_PORT': port}
              for port in ['0', '65536', 'not-a-port', '5061\nother=yes']),
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(SystemExit):
                media_configuration(invalid)


if __name__ == '__main__':
    unittest.main()
