// Provider registry. Providers are tried in order and the highest-confidence match wins;
// the generic provider always matches with zero confidence so there is always a result.
//
// A provider is { id, name, detect(doc, location), scrapeEditPage(doc, location),
// scrapeListPage(doc, location), navigationHint }. detect() returns
// { matched, page: 'extension-edit' | 'extension-list' | 'other', confidence, markers, reason }.

import { fusionpbx, toURL } from './fusionpbx.js';
import { generic } from './generic.js';

export const providers = [fusionpbx, generic];

export function detectProvider(doc, location) {
  const loc = toURL(location);
  let best = null;
  for (const provider of providers) {
    let detection;
    try {
      detection = provider.detect(doc, loc);
    } catch {
      continue;
    }
    if (!detection || !detection.matched) continue;
    if (!best || detection.confidence > best.detection.confidence) best = { provider, detection };
  }
  return best || { provider: generic, detection: generic.detect(doc, loc) };
}

// Scrape a whole document into plain JSON the popup can render.
export function scrapeDocument(doc, location) {
  const loc = toURL(location);
  const { provider, detection } = detectProvider(doc, loc);
  const result = {
    url: loc.href,
    hostname: loc.hostname,
    title: String(doc.title || '').trim(),
    provider: { id: provider.id, name: provider.name },
    page: detection.page,
    confidence: detection.confidence,
    reason: detection.reason || null,
    markers: detection.markers || [],
    hint: provider.navigationHint || null,
    suggestion: generic.suggest(loc),
    edit: null,
    list: null,
  };
  if (detection.page === 'extension-edit') {
    result.edit = provider.scrapeEditPage(doc, loc);
    if (!result.edit) {
      result.page = 'other';
      result.reason = 'edit-scrape-failed';
    }
  } else if (detection.page === 'extension-list') {
    result.list = provider.scrapeListPage(doc, loc);
  }
  return result;
}
