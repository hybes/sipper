export const SECURITY_HEADERS = {
	'Content-Security-Policy':
		"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
		"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
	'X-Content-Type-Options': 'nosniff',
};

export const PLATFORM_VARY = ['Sec-CH-UA-Platform', 'User-Agent'];
