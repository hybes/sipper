// Fallback provider for pages that no PBX provider recognises. It never scrapes
// anything; it only proposes the current host as the SIP server and domain so the
// manual entry form starts with something sensible.

export function suggest(location) {
  const loc = location instanceof URL ? location : new URL(typeof location === 'string' ? location : location.href);
  const host = loc.hostname || '';
  return { server: host, domain: host };
}

export const generic = {
  id: 'generic',
  name: 'Website',
  detect() {
    return { matched: true, page: 'other', confidence: 0, markers: [], reason: null };
  },
  scrapeEditPage() {
    return null;
  },
  scrapeListPage() {
    return [];
  },
  suggest,
  navigationHint: null,
};

export default generic;
