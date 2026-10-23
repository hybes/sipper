// The Worker and self-hosted server apply the same release visibility rules.
export function pageElementAction(attributes, { downloads, visitor, management }) {
	const launched = Boolean(downloads.mac || downloads.windows);
	const available = (platform) => platform ? Boolean(downloads[platform]) : launched;
	if ('data-management' in attributes && !management) return 'remove';
	if ('data-prelaunch' in attributes && available(attributes['data-prelaunch'])) return 'remove';
	if ('data-launched' in attributes && !available(attributes['data-launched'])) return 'remove';
	if (launched && 'data-visitor' in attributes && !attributes['data-visitor'].split(/\s+/).includes(visitor)) return 'remove';
	if ('data-launched' in attributes || 'data-management' in attributes) return 'show';
}

export const PAGE_ATTRIBUTES = ['data-prelaunch', 'data-launched', 'data-visitor', 'data-management'];
