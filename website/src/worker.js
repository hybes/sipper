// sipper.dev: a static site served from ../public by Workers static assets.
//
// The Worker runs before the asset handler (run_worker_first) so it can send www to the apex
// domain, add security headers to every response and answer the download links.
//
// MAC_DOWNLOAD_URL and WINDOWS_DOWNLOAD_URL in wrangler.jsonc are the files attached to the latest
// GitHub release (DOWNLOAD_URL, the old name for the Mac one, still works). Each is empty while that
// platform has no public download.
//
//   /download            302 to the download for the visitor's platform (see platform.js), or to
//                        the "Get Sipper" section when there isn't one for their platform
//   /download/mac        302 to MAC_DOWNLOAD_URL, or to "Get Sipper" while it's empty
//   /download/windows    302 to WINDOWS_DOWNLOAD_URL, or to "Get Sipper" while it's empty
//
// While both are empty, pages are served exactly as written: the pre-release wording. Once either is
// set, pages are rewritten using these markers, which can be combined on one element:
//   [data-prelaunch]            removed once any download exists
//   [data-prelaunch="windows"]  removed once that platform's download exists
//   [data-launched]             un-hidden once any download exists, otherwise removed
//   [data-launched="mac"]       un-hidden once that platform's download exists, otherwise removed
//   [data-visitor="mac"]        removed unless the visitor is on that platform ("mac", "windows" or
//                               "unknown"; several can be listed, separated by spaces)
// Anything that should only appear after a release must also carry `hidden`, so the page still
// reads correctly if the Worker is bypassed.

import { detectPlatform, downloadURLs } from './platform.js';
import { isPortalPath, proxyPortal } from './portal.js';
import { SECURITY_HEADERS, PLATFORM_VARY } from './headers.js';
import { pageElementAction, PAGE_ATTRIBUTES } from './page.js';

const CANONICAL_HOST = 'sipper.dev';

const DOWNLOAD_ROUTE = /^\/download(?:\/(mac|windows))?\/?$/;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.hostname === `www.${CANONICAL_HOST}`) {
			url.hostname = CANONICAL_HOST;
			url.protocol = 'https:';
			return withHeaders(Response.redirect(url.href, isPortalPath(url.pathname) ? 308 : 301), url);
		}
		if (url.hostname === CANONICAL_HOST && url.protocol !== 'https:') {
			url.protocol = 'https:';
			return withHeaders(Response.redirect(url.href, 308), url);
		}

		if (isPortalPath(url.pathname)) return proxyPortal(request, env);

		const downloads = downloadURLs(env);
		const visitor = detectPlatform(request.headers.get('Sec-CH-UA-Platform'), request.headers.get('User-Agent'));

		const downloadRoute = url.pathname.match(DOWNLOAD_ROUTE);
		if (downloadRoute) {
			const platform = downloadRoute[1] || visitor;
			const target = downloads[platform] || new URL('/#get', url).href;
			const response = withHeaders(Response.redirect(target, 302), url);
			if (!downloadRoute[1]) addVary(response.headers, PLATFORM_VARY);
			return response;
		}

		let assetRequest = request;
		if (looksLikePage(url.pathname)) {
			// A rewritten page no longer matches the stored file, so its ETag must not answer revalidation.
			assetRequest = new Request(request);
			assetRequest.headers.delete('If-None-Match');
			assetRequest.headers.delete('If-Modified-Since');
		}

		let response = await env.ASSETS.fetch(assetRequest);
		const isHTML = (response.headers.get('Content-Type') || '').startsWith('text/html');
		const rewrite = isHTML;

		if (rewrite) {
			response = new HTMLRewriter()
				.on(PAGE_ATTRIBUTES.map(name => `[${name}]`).join(', '), {
					element: (el) => {
						const attributes = Object.fromEntries(PAGE_ATTRIBUTES.filter(name => el.hasAttribute(name)).map(name => [name, el.getAttribute(name)]));
						const action = pageElementAction(attributes, { downloads, visitor, management: Boolean(env.PORTAL_ORIGIN && env.SIPPER_EDGE_SHARED_SECRET) });
						if (action === 'remove') el.remove();
						if (action === 'show') el.removeAttribute('hidden');
					},
				})
				.transform(response);
		}

		response = withHeaders(response, url);
		if (rewrite) {
			response.headers.delete('ETag');
			addVary(response.headers, PLATFORM_VARY);
		}
		return response;
	},
};

function withHeaders(original, url) {
	const response = new Response(original.body, original);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}
	// Keep workers.dev and preview hosts out of search results.
	if (url.hostname !== CANONICAL_HOST) response.headers.set('X-Robots-Tag', 'noindex');
	return response;
}

function addVary(headers, names) {
	const existing = (headers.get('Vary') || '').split(',').map((name) => name.trim()).filter(Boolean);
	const missing = names.filter((name) => !existing.some((other) => other.toLowerCase() === name.toLowerCase()));
	headers.set('Vary', [...existing, ...missing].join(', '));
}

function looksLikePage(pathname) {
	return pathname.endsWith('/') || pathname.endsWith('.html') || !/\.[a-z0-9]+$/i.test(pathname);
}
