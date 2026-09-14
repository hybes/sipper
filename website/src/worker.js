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

import { PLATFORMS, detectPlatform, downloadURLs } from './platform.js';

const CANONICAL_HOST = 'sipper.dev';

const SECURITY_HEADERS = {
	'Content-Security-Policy':
		"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
		"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
	'X-Content-Type-Options': 'nosniff',
};

// Request headers that decide which platform a response is for.
const PLATFORM_VARY = ['Sec-CH-UA-Platform', 'User-Agent'];

const DOWNLOAD_ROUTE = /^\/download(?:\/(mac|windows))?\/?$/;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.hostname === `www.${CANONICAL_HOST}`) {
			url.hostname = CANONICAL_HOST;
			return withHeaders(Response.redirect(url.href, 301), url);
		}

		const downloads = downloadURLs(env);
		const launched = PLATFORMS.some((platform) => downloads[platform]);
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
		if (launched && looksLikePage(url.pathname)) {
			// A rewritten page no longer matches the stored file, so its ETag must not answer revalidation.
			assetRequest = new Request(request);
			assetRequest.headers.delete('If-None-Match');
			assetRequest.headers.delete('If-Modified-Since');
		}

		let response = await env.ASSETS.fetch(assetRequest);
		const isHTML = (response.headers.get('Content-Type') || '').startsWith('text/html');
		const rewrite = launched && isHTML;

		if (rewrite) {
			const isAvailable = (platform) => (platform ? Boolean(downloads[platform]) : launched);
			response = new HTMLRewriter()
				.on('[data-prelaunch]', {
					element: (el) => {
						if (isAvailable(el.getAttribute('data-prelaunch'))) el.remove();
					},
				})
				.on('[data-launched]', {
					element: (el) => {
						if (isAvailable(el.getAttribute('data-launched'))) el.removeAttribute('hidden');
						else el.remove();
					},
				})
				.on('[data-visitor]', {
					element: (el) => {
						if (!el.getAttribute('data-visitor').split(/\s+/).includes(visitor)) el.remove();
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
