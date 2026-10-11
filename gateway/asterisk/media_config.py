"""Validated RTP, signalling and one-to-one NAT settings for the gateway transport."""
from ipaddress import ip_address, ip_network
import socket


def media_configuration(env):
    try:
        start = int(env.get('SIPPER_RTP_START', '20000'))
        end = int(env.get('SIPPER_RTP_END', '20199'))
        if not (1024 <= start < end <= 65535) or start % 2 or not end % 2:
            raise ValueError('RTP range must contain complete RTP/RTCP pairs')
        rtp = f'[general]\nrtpstart = {start}\nrtpend = {end}\nicesupport = yes\nstrictrtp = yes\n'
        transport = ''
        public = env.get('SIPPER_MEDIA_PUBLIC_IP', '')
        local = env.get('SIPPER_MEDIA_LOCAL_IP', '')
        networks = env.get('SIPPER_MEDIA_LOCAL_NETWORKS', '')
        signal = env.get('SIPPER_SIGNAL_PUBLIC_IP', '')
        signal_port = env.get('SIPPER_SIGNAL_PUBLIC_PORT', '')
        if public:
            public = ip_address(public)
            local = ip_address(local or socket.gethostbyname(socket.gethostname()))
            if local.version != public.version or '%' in str(local) or '%' in str(public):
                raise ValueError('NAT addresses must use the same address family')
            transport = f'external_media_address = {public}\n'
            # Replace the private ICE candidate. Do not disclose it to mobile clients.
            rtp += f'\n[ice_host_candidates]\n{local} => {public}\n'
        elif local:
            raise ValueError('NAT settings require a public media address')
        if signal:
            signal = ip_address(signal)
            port = int(signal_port or '5061')
            if '%' in str(signal) or not 1 <= port <= 65535:
                raise ValueError('Invalid public signalling address or port')
            transport += f'external_signaling_address = {signal}\nexternal_signaling_port = {port}\n'
        elif signal_port:
            raise ValueError('A public signalling port requires a public signalling address')
        if networks and not (public or signal):
            raise ValueError('Local networks require a public NAT address')
        for network in filter(None, networks.split(',')):
            if '%' in network:
                raise ValueError('Scoped addresses cannot be used for NAT')
            transport += f'local_net = {ip_network(network.strip(), strict=True)}\n'
        return rtp, transport
    except (ValueError, OSError):
        raise SystemExit('Invalid gateway transport settings; check RTP range, NAT IP addresses and signalling port') from None
