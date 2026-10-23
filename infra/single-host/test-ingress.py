#!/usr/bin/env python3
"""Exercise the actual Caddy routes with disposable containers and fictional data."""
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
CADDY = 'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
NODE = 'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
SECRET = 'fictional-ingress-fixture-key-not-a-production-secret'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def main():
    owned = f'sipper-ingress-{uuid.uuid4().hex[:10]}'
    containers = []
    docker('network', 'create', owned)
    try:
        with tempfile.TemporaryDirectory(prefix='sipper-ingress-') as temporary:
            config = (ROOT / 'infra/single-host/Caddyfile').read_text()
            config = re.sub(r'^(www\.sipper\.dev|sipper\.dev|meet\.sipper\.dev|sip\.sipper\.dev) \{', r'http://\1:8080 {', config, flags=re.M)
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
            containers.append(docker('run', '-d', '--network', owned, '-p', '127.0.0.1::8080', '--env', 'SIPPER_EDGE_SHARED_SECRET=' + SECRET, '-v', f'{path}:/etc/caddy/Caddyfile:ro', CADDY))
            address = docker('port', containers[-1], '8080/tcp')
            opener = urllib.request.build_opener(NoRedirect())

            def request(path, host='sipper.dev', data=None, headers=None):
                value = urllib.request.Request('http://' + address + path, data=data, headers={'Host': host, **(headers or {})})
                try:
                    response = opener.open(value, timeout=5)
                except urllib.error.HTTPError as error:
                    response = error
                return response.status, response.headers, response.read()

            for attempt in range(50):
                try:
                    if request('/')[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise AssertionError('Disposable ingress did not become ready')
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
            print('Passed: exact routes, canonical redirects, native callback, cookies, bodies, CSP, cache controls and forged-header rejection.')
    finally:
        for container in reversed(containers):
            docker('rm', '-f', container)
        docker('network', 'rm', owned)


if __name__ == '__main__':
    main()
