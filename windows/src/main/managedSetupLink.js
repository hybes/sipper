// A setup link selects a customer; it never changes the app's trusted server or grants access.
export function setupReference(value, origin) {
  const invalid = () => { throw new Error('This setup link is invalid or belongs to another Sipper server.'); };
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) return invalid();
  let url;
  try { url = new URL(value.trim()); } catch { return invalid(); }
  if (url.username || url.password) return invalid();
  let reference;
  if (['http:', 'https:'].includes(url.protocol)) {
    if (url.origin !== origin || url.pathname !== '/portal/setup' || url.search || !url.hash.startsWith('#ref=')) return invalid();
    reference = url.hash.slice(5);
  } else {
    if (url.protocol !== 'sipper:' || url.hostname !== 'setup' || url.pathname || url.port || url.hash) return invalid();
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || !keys.includes('server') || !keys.includes('reference')) return invalid();
    let server;
    try { server = new URL(url.searchParams.get('server')); } catch { return invalid(); }
    if (server.origin !== origin || server.username || server.password || server.pathname !== '/' || server.search || server.hash) return invalid();
    reference = url.searchParams.get('reference');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(reference ?? '')) return invalid();
  return reference;
}
