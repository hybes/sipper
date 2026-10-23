import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebsiteServer, renderPage } from '../src/server.js';

const env = { MAC_DOWNLOAD_URL: 'https://example.invalid/mac.dmg', WINDOWS_DOWNLOAD_URL: 'https://example.invalid/windows.exe', SIPPER_MANAGEMENT_ENABLED: 'true' };
let server, origin;
before(async () => {
	server = createWebsiteServer({ env });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
});

test('self-hosted pages retain platform downloads and expose enabled management', async () => {
	for (const [hint, own, other] of [['macOS', 'Mac', 'Windows'], ['Windows', 'Windows', 'Mac']]) {
		const response = await fetch(origin, { headers: { 'Sec-CH-UA-Platform': `"${hint}"` } });
		const body = await response.text();
		assert.equal(response.status, 200);
		const hero = body.slice(body.indexOf('<section class="hero">'), body.indexOf('</section>'));
		assert.ok(hero.includes(`Download for ${own}`));
		assert.ok(!hero.includes(`Download for ${other}`));
		assert.ok(!hero.includes('coming soon'));
		assert.match(body, /href="\/portal"[^>]*>Management/);
		assert.match(response.headers.get('Vary'), /User-Agent/);
		assert.ok(response.headers.get('Content-Security-Policy').includes("form-action 'none'"));
	}
});

test('downloads use the shared platform detector and never redirect mobile visitors to a desktop binary', async () => {
	for (const [path, hint, target] of [['/download', 'Windows', env.WINDOWS_DOWNLOAD_URL], ['/download/mac', 'Android', env.MAC_DOWNLOAD_URL], ['/download', 'Android', '/#get']]) {
		const response = await fetch(origin + path, { redirect: 'manual', headers: { 'Sec-CH-UA-Platform': `"${hint}"` } });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('Location'), target);
	}
});

test('published assets, canonical page redirects, HEAD and missing paths work without leaking private files', async () => {
	for (const path of ['/support', '/privacy', '/assets/site.css', '/robots.txt', '/sitemap.xml']) {
		const response = await fetch(origin + path);
		assert.equal(response.status, 200, path);
		await response.arrayBuffer();
	}
	const head = await fetch(origin + '/', { method: 'HEAD' });
	assert.equal(head.status, 200); assert.equal(await head.text(), '');
	const canonical = await fetch(origin + '/support.html?topic=calls', { redirect: 'manual' });
	assert.equal(canonical.status, 308); assert.equal(canonical.headers.get('Location'), '/support?topic=calls');
	for (const path of ['/.env', '/%2eenv', '/%2fexternal.invalid.html', '/src/server.js', '/missing']) {
		const response = await fetch(origin + path, { redirect: 'manual' });
		assert.equal(response.status, 404, path);
		assert.equal(response.headers.get('Location'), null);
		await response.text();
	}
});

test('static server refuses writes and cannot impersonate a management endpoint', async () => {
	assert.equal((await fetch(origin + '/', { method: 'POST', body: 'example' })).status, 405);
	for (const path of ['/portal', '/api/auth/session', '/_nuxt/app.js', '/.well-known/openid-configuration']) {
		const response = await fetch(origin + path);
		assert.equal(response.status, 503, path);
		assert.equal(response.headers.get('Cache-Control'), 'no-store');
		await response.text();
	}
});

test('visibility rules preserve unavailable releases and remove disabled management', () => {
	const html = '<div data-prelaunch>Preview</div><a data-launched="mac" hidden>Mac</a><p data-prelaunch="windows">Windows soon</p><nav data-management hidden>Manage</nav>';
	const preview = renderPage(html, { downloads: {}, visitor: 'mac', management: false });
	assert.ok(preview.includes('Preview')); assert.ok(!preview.includes('>Mac<')); assert.ok(!preview.includes('Manage'));
	const published = renderPage(html, { downloads: { mac: env.MAC_DOWNLOAD_URL }, visitor: 'mac', management: true });
	assert.ok(!published.includes('Preview')); assert.ok(published.includes('Windows soon'));
	assert.ok(published.includes('>Mac</a>')); assert.ok(!published.includes('hidden'));
});
