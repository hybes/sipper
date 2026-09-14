// Works out which Sipper download suits the visitor's computer. Kept free of Worker APIs so
// `npm test` can run it under Node.

export const PLATFORMS = ['mac', 'windows'];

// Returns 'mac', 'windows' or 'unknown' from the Sec-CH-UA-Platform and User-Agent request headers.
// Chromium browsers send Sec-CH-UA-Platform (for example "macOS", with the quotes) by default; other
// browsers only send a User-Agent. Linux, iOS, Android, bots and anything unrecognised are 'unknown'.
export function detectPlatform(platformHint, userAgent) {
	const hint = (platformHint || '').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
	if (hint === 'windows') return 'windows';
	if (hint === 'macos') return 'mac';
	// The hint is authoritative when it names another platform; "Unknown" says nothing either way.
	if (hint && hint !== 'unknown') return 'unknown';

	const ua = userAgent || '';
	if (/Windows NT/.test(ua)) return 'windows';
	if (/Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua)) return 'mac';
	return 'unknown';
}

// Download URLs by platform, empty while that platform has no public download. DOWNLOAD_URL is the
// Mac setting's old name, still read so a deployment that hasn't been updated keeps its download.
export function downloadURLs(env) {
	return {
		mac: (env.MAC_DOWNLOAD_URL || '').trim() || (env.DOWNLOAD_URL || '').trim(),
		windows: (env.WINDOWS_DOWNLOAD_URL || '').trim(),
	};
}
