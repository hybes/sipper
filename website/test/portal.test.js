import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPortalPath, proxyPortal } from '../src/portal.js';
import worker from '../src/worker.js';

const env = { PORTAL_ORIGIN: 'https://origin.example.invalid', SIPPER_EDGE_SHARED_SECRET: 'fictional-edge-secret-'.repeat(3) };

test('production management redirects preserve methods and use the canonical HTTPS origin', async () => {
	for (const url of ['http://sipper.dev/api/auth/sign-in/email', 'http://www.sipper.dev/api/auth/sign-in/email']) {
		const response = await worker.fetch(new Request(url, { method: 'POST', body: '{}' }), {});
		assert.equal(response.status, 308); assert.equal(response.headers.get('Location'), 'https://sipper.dev/api/auth/sign-in/email');
	}
});

test('management routes are exact and public pages/downloads retain the static handler', async () => {
	for (const path of ['/portal', '/portal/sign-in', '/api/client/devices/a/report', '/_nuxt/app.js', '/assets/sipper-icon.png', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server']) assert.equal(isPortalPath(path), true, path);
	for (const path of ['/', '/privacy', '/support', '/download/mac', '/portal-other', '/apiary', '/assets/preview.png']) assert.equal(isPortalPath(path), false, path);
	const response = await worker.fetch(new Request('https://sipper.dev/support'), { ASSETS: { fetch: () => new Response('Support', { headers: { 'Content-Type': 'text/plain' } }) } });
	assert.equal(await response.text(), 'Support'); assert.ok(response.headers.get('Content-Security-Policy').includes("form-action 'none'"));
	const download = await worker.fetch(new Request('https://sipper.dev/download/mac'), { MAC_DOWNLOAD_URL: 'https://github.com/hybes/sipper/releases/download/v0.1.0/Sipper-0.1.0.dmg' });
	assert.equal(download.status, 302); assert.ok(download.headers.get('Location').endsWith('Sipper-0.1.0.dmg'));
	assert.equal((await worker.fetch(new Request('https://sipper.dev/portal'), {})).status, 503);
});

test('proxy preserves request bodies, cookies and bearer tokens while replacing untrusted proxy headers', async () => {
	const headers = { Cookie: 'session=fictional', Authorization: 'Bearer fictional', 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.8', 'x-forwarded-for': '198.51.100.1', forwarded: 'for=198.51.100.1', 'x-sipper-client-ip': '198.51.100.2', 'x-sipper-edge-secret': 'attacker', 'x-sipper-verified-ip': '198.51.100.3' };
	const request = new Request('https://sipper.dev/api/client/report?revision=2', { method: 'POST', headers, body: '{"revision":2}' });
	const response = await proxyPortal(request, env, async (forwarded, options) => {
		assert.equal(forwarded.url, 'https://origin.example.invalid/api/client/report?revision=2');
		assert.equal(forwarded.headers.get('host'), 'origin.example.invalid');
		assert.equal(forwarded.method, 'POST'); assert.equal(await forwarded.text(), '{"revision":2}');
		assert.equal(forwarded.headers.get('cookie'), headers.Cookie); assert.equal(forwarded.headers.get('authorization'), headers.Authorization);
		assert.equal(forwarded.headers.get('x-sipper-client-ip'), '192.0.2.8'); assert.equal(forwarded.headers.get('x-sipper-edge-secret'), env.SIPPER_EDGE_SHARED_SECRET);
		for (const header of ['forwarded', 'x-forwarded-for', 'x-sipper-verified-ip']) assert.equal(forwarded.headers.get(header), null);
		assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
		assert.equal(options.cf.cacheTtlByStatus['100-599'], -1);
		const responseHeaders = new Headers({ 'Content-Security-Policy': "form-action 'self'", 'x-sipper-edge-secret': env.SIPPER_EDGE_SHARED_SECRET });
		responseHeaders.append('Set-Cookie', 'a=one; HttpOnly; Secure'); responseHeaders.append('Set-Cookie', 'b=two; HttpOnly; Secure');
		return new Response('accepted', { status: 201, headers: responseHeaders });
	});
	assert.equal(response.status, 201); assert.equal(response.headers.get('Content-Security-Policy'), "form-action 'self'");
	assert.equal(response.headers.get('x-sipper-edge-secret'), null); assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.equal(response.headers.getSetCookie().length, 2);
});

test('redirects are returned without following them and internal origin URLs are rewritten', async () => {
	for (const location of ['sipper://oauth/callback?code=fictional', 'https://checkout.stripe.com/fictional', 'https://origin.example.invalid/portal/security?next=1']) {
		let calls = 0;
		const response = await proxyPortal(new Request('https://sipper.dev/api/auth/test'), env, async (_, options) => {
			calls++; assert.equal(options.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: location } });
		});
		assert.equal(calls, 1); assert.equal(response.headers.get('Location'), location.replace('https://origin.example.invalid', 'https://sipper.dev'));
	}
});

test('invalid origins, missing settings and upstream errors fail without leaking secrets or URLs', async () => {
	for (const secret of ['', 'short', 'x'.repeat(513), 'x'.repeat(32) + '\nprivate-header']) {
		const response = await proxyPortal(new Request('https://sipper.dev/portal'), { ...env, SIPPER_EDGE_SHARED_SECRET: secret });
		assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-header'));
	}
	for (const origin of ['', 'http://origin.example.invalid', 'https://user:password@origin.example.invalid', 'https://origin.example.invalid/path', 'https://sipper.dev', 'https://origin.example.invalid?key=private']) {
		const response = await proxyPortal(new Request('https://sipper.dev/portal'), { ...env, PORTAL_ORIGIN: origin }, () => { throw new Error('Should not fetch'); });
		assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(origin || env.SIPPER_EDGE_SHARED_SECRET));
	}
	const response = await proxyPortal(new Request('https://sipper.dev/portal'), env, () => { throw new Error(`private ${env.SIPPER_EDGE_SHARED_SECRET}`); });
	assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('private'));
});
