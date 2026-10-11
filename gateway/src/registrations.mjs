import { isIP } from 'node:net';

export async function observeRegistration(ari, endpoint) {
  if (!/^d[a-f0-9]{32}$/.test(endpoint)) throw new Error('Invalid device endpoint');
  const observedAt = new Date().toISOString();
  // Asterisk 22's AOR serialiser includes live dynamic contacts and removes
  // expired ones. Device AORs have max_contacts=1 and no permanent contacts.
  const fields = await ari.request('GET', `asterisk/config/dynamic/res_pjsip/aor/${endpoint}`);
  if (!Array.isArray(fields) || !fields.some(field => field.attribute === 'max_contacts' && field.value === '1')) throw new Error('Invalid device AOR');
  const contacts = fields.filter(field => field.attribute === 'contact' && field.value);
  if (contacts.length > 1) throw new Error('Unexpected device contacts');
  // rewrite_contact=yes stores the received SIP peer. Never export the URI,
  // username or client-supplied Via address to the management API.
  const host = contacts[0]?.value.match(/^sips?:[^@]*@(?:\[([^\]]+)\]|([^:;?]+))/i);
  const ip = host?.[1] ?? host?.[2];
  return { endpoint, state: contacts.length ? 'registered' : 'unregistered', ip: ip && isIP(ip) ? ip : null, observedAt };
}

export async function reportRegistrations(ari, portal, endpoints, current) {
  // Keep telemetry outside call/lease reconciliation, with bounded ARI fan-out.
  for (let offset = 0; offset < endpoints.length && current(); offset += 20) {
    const results = await Promise.allSettled(endpoints.slice(offset, offset + 20).map(endpoint => observeRegistration(ari, endpoint)));
    const reports = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (reports.length && current()) await portal('POST', 'registrations', { reports });
    if (results.some(result => result.status === 'rejected')) console.error('Some gateway registration observations failed; previous records will become stale.');
  }
}
