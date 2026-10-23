#!/usr/bin/env python3
"""Exercise the actual Caddy routes with disposable containers and fictional data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
CADDY = 'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
NODE = 'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
TRAEFIK = 'traefik:v3.7@sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2'
SECRET = 'fictional-ingress-fixture-key-not-a-production-secret'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def shared_configuration(temporary, network):
    spec = importlib.util.spec_from_file_location('prepare', ROOT / 'infra/single-host/prepare.py')
    prepare = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prepare)
    private, smtp = Path(temporary) / 'private', Path(temporary) / 'smtp.env'
    smtp.write_text('SMTP_HOST=mail.example.invalid\nMAIL_FROM=Sipper <accounts@example.invalid>\n')
    for options in [dict(proxy_network=network),
                    dict(proxy_network=network, traefik_ip='192.0.2.0/24', traefik_resolver='fixture',
                         traefik_acme_file=Path(temporary) / 'acme.json')]:
        try:
            prepare.prepare(private, '198.51.100.10', smtp, 'fixture', '', **options)
        except ValueError:
            assert not private.exists()
        else:
            raise AssertionError('Incomplete proxy settings or whole-subnet trust were accepted')
    prepare.prepare(private, '198.51.100.10', smtp, 'fixture', '', proxy_network=network,
                    traefik_ip='192.0.2.10', traefik_resolver='fixture', traefik_acme_file=Path(temporary) / 'acme.json')
    env = {**os.environ, 'SIPPER_DEPLOYMENT_ENV': str(private / 'deployment.env')}
    config = json.loads(subprocess.check_output(['sh', str(ROOT / 'infra/single-host/compose.sh'),
                                                '--profile', 'calling', '--profile', 'meetings',
                                                'config', '--format', 'json'], env=env, stderr=subprocess.PIPE))
    for name, service in config['services'].items():
        assert service['mem_limit'] and service['cpus'] and service['pids_limit'], name
        # An unquoted flow-list entry splits at commas into invalid mount paths.
        # Check Docker's resolved input, including the media service that this
        # ingress fixture does not start.
        for mount in service.get('tmpfs', []):
            path, separator, options = mount.partition(':')
            assert path.startswith('/') and separator, f'{name}: invalid tmpfs path'
            assert {'rw', 'noexec', 'nosuid'} <= set(options.split(',')), f'{name}: missing tmpfs protections'
        if name not in ('asterisk', 'meetings-media'):
            assert not service.get('ports'), name
        if name == 'controller':
            assert service['network_mode'].startswith('service:asterisk')
        else:
            assert ('shared-proxy' in service['networks']) == (name == 'proxy'), name
    assert config['networks']['shared-proxy']['external']
    assert config['services']['proxy']['environment']['SIPPER_TRAEFIK_IP'] == '192.0.2.10'
    return config['services']['proxy']['labels']


def main(shared=False):
    owned = f'sipper-ingress-{uuid.uuid4().hex[:10]}'
    containers = []
    docker('network', 'create', owned)
    try:
        with tempfile.TemporaryDirectory(prefix='sipper-ingress-') as temporary:
            config = (ROOT / ('infra/shared-host/Caddyfile' if shared else 'infra/single-host/Caddyfile')).read_text()
            config = config.replace('import routes.caddy', (ROOT / 'infra/single-host/routes.caddy').read_text())
            config = re.sub(r'^(?:http://)?(www\.sipper\.dev|sipper\.dev|meet\.sipper\.dev|sip\.sipper\.dev) \{', r'http://\1:8080 {', config, flags=re.M)
            path = Path(temporary) / 'Caddyfile'
            path.write_text(config)
            fixture = r'''const http=require('node:http');
for(const port of [3100,8080,7881])http.createServer((req,res)=>{
 let body='';req.on('data',data=>body+=data);req.on('end',()=>{
  if(req.url==='/api/redirect'){res.writeHead(302,{location:'sipper://oauth/callback?code=fictional'});res.end();return;}
  res.writeHead(200,{'content-type':'application/json','content-security-policy':"form-action 'self'",
   'set-cookie':['session=fictional; HttpOnly; Secure','other=fictional; HttpOnly; Secure'],
   'x-sipper-edge-secret':req.headers['x-sipper-edge-secret']||'','x-sipper-verified-ip':'fixture'});
  res.end(JSON.stringify({port,path:req.url,method:req.method,body,headers:req.headers}));
 });
}).listen(port,'0.0.0.0');'''
            containers.append(docker('run', '-d', '--network', owned, '--network-alias', 'portal', '--network-alias', 'website', '--network-alias', 'meetings-signalling', NODE, 'node', '-e', fixture))
            shared_arguments, scheme, traefik_address = [], 'http', None
            context = ssl.create_default_context()
            if shared:
                labels = shared_configuration(temporary, owned)
                certificate, key = Path(temporary) / 'fixture.crt', Path(temporary) / 'fixture.key'
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                                '-nodes', '-days', '1', '-subj', '/CN=Sipper ingress fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
                                '-keyout', str(key), '-out', str(certificate)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                context.load_verify_locations(cafile=str(certificate))
                dynamic = {'http': {'routers': {
                    'sipper-http': {'rule': labels['traefik.http.routers.sipper-http.rule'], 'entryPoints': ['http'],
                                    'service': 'sipper-edge', 'middlewares': ['sipper-https']},
                    'sipper-https': {'rule': labels['traefik.http.routers.sipper-https.rule'], 'entryPoints': ['https'],
                                     'service': 'sipper-edge', 'tls': {}},
                    'existing': {'rule': 'Host(`other.example.invalid`)', 'entryPoints': ['https'], 'service': 'existing', 'tls': {}}},
                    'services': {'sipper-edge': {'loadBalancer': {'servers': [{'url': 'http://edge:8080'}]}},
                                 'existing': {'loadBalancer': {'servers': [{'url': 'http://website:8080'}]}}},
                    'middlewares': {'sipper-https': {'redirectScheme': {
                        'scheme': labels['traefik.http.middlewares.sipper-https.redirectscheme.scheme'],
                        'permanent': labels['traefik.http.middlewares.sipper-https.redirectscheme.permanent'] == 'true'}}}},
                    'tls': {'stores': {'default': {'defaultCertificate': {
                        'certFile': '/fixture/fixture.crt', 'keyFile': '/fixture/fixture.key'}}}}}
                # JSON syntax is valid YAML; Traefik's file provider requires a YAML or TOML extension.
                (Path(temporary) / 'traefik.yml').write_text(json.dumps(dynamic))
                containers.append(docker('run', '-d', '--network', owned, '-p', '127.0.0.1::8080', '-p', '127.0.0.1::8443',
                                         '-v', f'{temporary}:/fixture:ro', TRAEFIK, '--entrypoints.http.address=:8080',
                                         '--entrypoints.https.address=:8443', '--providers.file.filename=/fixture/traefik.yml', '--log.level=ERROR'))
                traefik = containers[-1]
                proxy_ip = json.loads(docker('inspect', traefik))[0]['NetworkSettings']['Networks'][owned]['IPAddress']
                shared_arguments = ['--env', 'SIPPER_TRAEFIK_IP=' + proxy_ip]
                traefik_address, scheme = docker('port', traefik, '8443/tcp'), 'https'
            containers.append(docker('run', '-d', '--network', owned, '--network-alias', 'edge', '-p', '127.0.0.1::8080',
                                     '--env', 'SIPPER_EDGE_SHARED_SECRET=' + SECRET, *shared_arguments,
                                     '-v', f'{path}:/etc/caddy/Caddyfile:ro', CADDY))
            origin_address = docker('port', containers[-1], '8080/tcp')
            address = traefik_address or origin_address
            opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))

            def request(path, host='sipper.dev', data=None, headers=None, direct=False):
                base = 'http://' + origin_address if direct else scheme + '://' + address
                value = urllib.request.Request(base + path, data=data, headers={'Host': host, **(headers or {})})
                try:
                    response = opener.open(value, timeout=5)
                except urllib.error.HTTPError as error:
                    response = error
                return response.status, response.headers, response.read()

            last_status = None
            for attempt in range(50):
                try:
                    last_status = request('/')[0]
                    if last_status == 200:
                        break
                except OSError as error:
                    last_status = f'{type(error).__name__}: {getattr(error, "reason", error)}'
                time.sleep(0.1)
            else:
                raise AssertionError(f'Disposable ingress did not become ready: {last_status}')
            for route in ['/portal', '/portal/sign-in', '/api', '/api/auth/session', '/_nuxt/app.js', '/assets/sipper-icon.png', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server']:
                status, headers, body = request(route)
                assert status == 200 and json.loads(body)['port'] == 3100, route
                assert headers['Cache-Control'] == 'no-store'
                assert headers['Content-Security-Policy'] == "form-action 'self'"
                assert len(headers.get_all('Set-Cookie')) == 2
            for route in ['/', '/support', '/download/mac', '/apiary', '/portal-other']:
                assert json.loads(request(route)[2])['port'] == 8080, route
            status, headers, body = request('/api/echo?revision=3', data=b'{"revision":3}', headers={
                'Content-Type': 'application/json', 'Authorization': 'Bearer fictional', 'Cookie': 'session=fictional',
                'X-Sipper-Edge-Secret': 'forged', 'X-Sipper-Client-IP': '198.51.100.1',
                'X-Sipper-Verified-IP': '198.51.100.2', 'X-Forwarded-For': '198.51.100.3',
                'Forwarded': 'for=198.51.100.4', 'CF-Connecting-IP': '198.51.100.5', 'X-Real-IP': '198.51.100.6',
            })
            received = json.loads(body)
            assert received['method'] == 'POST' and received['body'] == '{"revision":3}'
            assert received['path'] == '/api/echo?revision=3'
            assert received['headers']['x-sipper-edge-secret'] == SECRET
            assert received['headers']['authorization'] == 'Bearer fictional'
            assert received['headers']['cookie'] == 'session=fictional'
            assert not received['headers']['x-sipper-client-ip'].startswith('198.51.100.')
            assert received['headers']['x-forwarded-host'] == 'sipper.dev'
            for name in ['forwarded', 'cf-connecting-ip', 'x-real-ip', 'x-sipper-verified-ip']:
                assert name not in received['headers'], name
            assert 'X-Sipper-Edge-Secret' not in headers and 'X-Sipper-Verified-IP' not in headers
            status, headers, body = request('/api/redirect')
            assert status == 302 and headers['Location'] == 'sipper://oauth/callback?code=fictional'
            status, headers, body = request('/api/echo?revision=3', host='www.sipper.dev', data=b'fictional')
            assert status == 308 and headers['Location'] == 'https://sipper.dev/api/echo?revision=3'
            assert json.loads(request('/rtc/validate', host='meet.sipper.dev')[2])['port'] == 7881
            if shared:
                # Other applications still route normally, and neither direct
                # clients nor neighbouring containers can forge the trusted edge.
                existing = json.loads(request('/existing', host='other.example.invalid')[2])
                assert existing['port'] == 8080 and 'x-sipper-edge-secret' not in existing['headers']
                assert received['headers']['x-sipper-client-ip'] == existing['headers']['x-forwarded-for']
                assert received['headers']['x-sipper-client-ip'] != proxy_ip
                for host in ['sipper.dev', 'www.sipper.dev', 'meet.sipper.dev', 'sip.sipper.dev']:
                    assert request('/api/echo', host=host, direct=True, headers={'X-Forwarded-For': proxy_ip})[0] == 403
                status = docker('run', '--rm', '--network', owned, NODE, 'node', '-e',
                                "require('node:http').get({host:'edge',port:8080,path:'/api/echo',headers:{host:'sipper.dev','x-forwarded-for':'198.51.100.1'}},r=>{r.resume();r.on('end',()=>console.log(r.statusCode))}).on('error',()=>process.exit(1))")
                assert status == '403', f'Untrusted neighbouring container returned {status}'
                print('Passed: shared Compose isolation/resource limits, verified HTTPS, correct client IP, neighbouring-container rejection and existing-site routing.')
            print('Passed: exact routes, canonical redirects, native callback, cookies, bodies, CSP, cache controls and forged-header rejection.')
    except Exception:
        # These containers contain only the fictional fixtures above.
        for container in containers:
            result = subprocess.run(['docker', 'logs', '--tail', '12', container], capture_output=True, text=True)
            print((result.stdout + result.stderr).replace(SECRET, '[fictional edge key]'))
        raise
    finally:
        for container in reversed(containers):
            docker('rm', '-f', container)
        docker('network', 'rm', owned)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shared', action='store_true', help='Exercise the shared-host configuration behind real Traefik')
    main(parser.parse_args().shared)
