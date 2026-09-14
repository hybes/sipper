// sipper.dev: a static site served from ../public by Workers static assets.
//
// The Worker runs before the asset handler (run_worker_first) so it can send www to the apex
// domain, add security headers to every response and answer /download.
//
// DOWNLOAD_URL in wrangler.jsonc is the DMG attached to the latest GitHub release. While it is
// empty, /download goes to the "Get Sipper" section and pages keep their pre-release wording.
// Once it is set:
//   /download           302 to DOWNLOAD_URL
//   [data-prelaunch]    removed from pages
//   [data-launched]     un-hidden

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

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.hostname === `www.${CANONICAL_HOST}`) {
			url.hostname = CANONICAL_HOST;
			return withHeaders(Response.redirect(url.href, 301), url);
		}

		const downloadURL = (env.DOWNLOAD_URL || '').trim();

		if (url.pathname === '/download' || url.pathname === '/download/') {
			return withHeaders(Response.redirect(downloadURL || new URL('/#get', url).href, 302), url);
		}

		let assetRequest = request;
		if (downloadURL && looksLikePage(url.pathname)) {
			// A rewritten page no longer matches the stored file, so its ETag must not answer revalidation.
			assetRequest = new Request(request);
			assetRequest.headers.delete('If-None-Match');
			assetRequest.headers.delete('If-Modified-Since');
		}

		let response = await env.ASSETS.fetch(assetRequest);
		const isHTML = (response.headers.get('Content-Type') || '').startsWith('text/html');

		if (downloadURL && isHTML) {
			response = new HTMLRewriter()
				.on('[data-prelaunch]', { element: (el) => el.remove() })
				.on('[data-launched]', { element: (el) => el.removeAttribute('hidden') })
				.transform(response);
		}

		response = withHeaders(response, url);
		if (downloadURL && isHTML) response.headers.delete('ETag');
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

function looksLikePage(pathname) {
	return pathname.endsWith('/') || pathname.endsWith('.html') || !/\.[a-z0-9]+$/i.test(pathname);
}
