// Only these routes belong to the management application. Marketing and release
// downloads continue through the existing static site handler.
export function isPortalPath(pathname) {
	return pathname === '/portal' || pathname.startsWith('/portal/') ||
		pathname === '/api' || pathname.startsWith('/api/') ||
		pathname.startsWith('/_nuxt/') || pathname === '/assets/sipper-icon.png' ||
		['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server'].includes(pathname);
}

export async function proxyPortal(request, env, originFetch = fetch) {
	const publicURL = new URL(request.url);
	let origin;
	try {
		origin = new URL(env.PORTAL_ORIGIN);
		if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
			origin.pathname !== '/' || [publicURL.hostname, 'sipper.dev', 'www.sipper.dev'].includes(origin.hostname) ||
			typeof env.SIPPER_EDGE_SHARED_SECRET !== 'string' || !/^[A-Za-z0-9+/_=-]{32,512}$/.test(env.SIPPER_EDGE_SHARED_SECRET)) throw new Error();
	} catch {
		return unavailable(503);
	}
	const target = new URL(origin);
	target.pathname = publicURL.pathname;
	target.search = publicURL.search;
	const forwarded = new Request(target, request);
	forwarded.headers.set('Host', origin.host);
	// Never forward a visitor's assertion of identity, proxy hops or origin secret.
	for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-sipper-verified-ip', 'x-sipper-client-ip', 'x-sipper-edge-secret']) forwarded.headers.delete(header);
	forwarded.headers.set('x-sipper-edge-secret', env.SIPPER_EDGE_SHARED_SECRET);
	const clientIP = request.headers.get('cf-connecting-ip'); // Set by Cloudflare, not a request parameter.
	if (clientIP) forwarded.headers.set('x-sipper-client-ip', clientIP);
	forwarded.headers.set('x-forwarded-host', publicURL.host);
	forwarded.headers.set('x-forwarded-proto', 'https');
	try {
		// Following an origin redirect could disclose credentials/our edge secret to
		// another host. Pass redirects to the browser/native client unchanged.
		const upstream = await originFetch(forwarded, { redirect: 'manual', cache: 'no-store', cf: { cacheTtlByStatus: { '100-599': -1 } }, signal: AbortSignal.timeout(30_000) });
		const response = new Response(upstream.body, upstream);
		response.headers.delete('x-sipper-edge-secret');
		response.headers.delete('x-sipper-client-ip');
		response.headers.delete('x-sipper-verified-ip');
		response.headers.set('Cache-Control', 'no-store');
		response.headers.set('CDN-Cache-Control', 'no-store');
		response.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
		response.headers.set('X-Robots-Tag', 'noindex');
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
		// The portal owns its CSP. Do not apply the static site's form-action 'none'.
		const location = response.headers.get('Location');
		if (location) {
			const redirect = new URL(location, target);
			if (redirect.origin === origin.origin) {
				redirect.protocol = publicURL.protocol;
				redirect.host = publicURL.host;
				response.headers.set('Location', redirect.href);
			}
		}
		return response;
	} catch {
		// Exception text can contain URLs, headers or credentials.
		return unavailable(502);
	}
}

function unavailable(status) {
	return new Response('Sipper management is temporarily unavailable.', {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex',
			'Referrer-Policy': 'no-referrer', "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
			'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
		},
	});
}
