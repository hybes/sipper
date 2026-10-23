import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, serialize } from 'parse5';
import { detectPlatform, downloadURLs } from './platform.js';
import { pageElementAction } from './page.js';
import { SECURITY_HEADERS, PLATFORM_VARY } from './headers.js';
import { isPortalPath } from './portal.js';

const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

export function renderPage(html, state) {
	const document = parse(html);
	function visit(parent) {
		parent.childNodes = parent.childNodes?.filter(node => {
			const action = pageElementAction(Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value])), state);
			if (action === 'remove') return false;
			if (action === 'show') node.attrs = node.attrs.filter(({ name }) => name !== 'hidden');
			visit(node);
			return true;
		});
	}
	visit(document);
	return serialize(document);
}

// Caddy terminates HTTPS and routes management directly to the private portal.
// This process has no database credentials, proxy secret or authenticated routes.
export function createWebsiteServer({ env = process.env, directory = publicDirectory } = {}) {
	const root = resolve(directory);
	const downloads = downloadURLs(env);
	return createServer(async (request, response) => {
		const send = (status, body = '', headers = {}) => {
			response.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', ...headers });
			response.end(request.method === 'HEAD' ? undefined : body);
		};
		try {
			const url = new URL(request.url, 'https://sipper.dev');
			if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
			if (url.pathname === '/healthz') return send(200, 'ok');
			if (isPortalPath(url.pathname)) return send(503, 'Sipper management is temporarily unavailable.');
			const visitor = detectPlatform(request.headers['sec-ch-ua-platform'], request.headers['user-agent']);
			const download = url.pathname.match(/^\/download(?:\/(mac|windows))?\/?$/);
			if (download) return send(302, '', { Location: downloads[download[1] || visitor] || '/#get', Vary: PLATFORM_VARY.join(', ') });
			const path = decodeURIComponent(url.pathname);
			if (path.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(part => part.startsWith('.'))) return send(404, 'Not found.');
			if (path === '/index.html') return send(308, '', { Location: '/' + url.search });
			if (path.endsWith('.html') && path !== '/404.html') return send(308, '', { Location: path.slice(0, -5) + url.search });
			if (path !== '/' && path.endsWith('/')) return send(308, '', { Location: path.slice(0, -1) + url.search });
			const relative = path === '/' ? 'index.html' : path.slice(1) + (extname(path) ? '' : '.html');
			let file = resolve(root, relative), status = 200;
			try {
				file = await realpath(file);
				if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error('Not a public file');
			} catch {
				file = resolve(root, '404.html');
				status = 404;
			}
			let body = await readFile(file);
			const html = extname(file) === '.html';
			if (html) body = Buffer.from(renderPage(body.toString('utf8'), { downloads, visitor, management: env.SIPPER_MANAGEMENT_ENABLED === 'true' }));
			send(status, body, {
				'Content-Type': types[extname(file)] ?? 'application/octet-stream',
				'Content-Length': body.length,
				'Cache-Control': html || status !== 200 ? 'no-cache' : 'public, max-age=3600',
				...(html ? { Vary: PLATFORM_VARY.join(', ') } : {}),
			});
		} catch {
			send(400, 'Unable to serve this request.');
		}
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const server = createWebsiteServer();
	server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1');
	for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
