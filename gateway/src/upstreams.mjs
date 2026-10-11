const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const host = /^[a-zA-Z0-9.:[\]-]{1,253}$/;

export function upstreamObjects(account, allowedHosts) {
  const s = account?.settings;
  if (!uuid.test(account?.id) || !Number.isSafeInteger(account.revision) || account.revision < 1 || !s
    || !host.test(s.server) || !host.test(s.domain) || !allowedHosts.has(s.server.toLowerCase())
    || s.transport !== 'tls' || s.srtp !== 'required' || (s.port != null && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535))
    || typeof s.username !== 'string' || !s.username || /[\x00-\x1f\x7f]/.test(s.username)
    || typeof account.password !== 'string' || !account.password || /[\x00-\x1f\x7f]/.test(account.password)) throw new Error('Unsupported or unapproved upstream settings');
  const id = `u${account.id.replaceAll('-', '').toLowerCase()}r${account.revision}`;
  const address = `${s.server}:${s.port ?? 5061}`;
  const server = `sip:${address};transport=tls`;
  return { id, configurationId: account.id, revision: account.revision, objects: {
    auth: { auth_type: 'digest', username: s.authUsername || s.username, password: account.password, realm: '*', supported_algorithms_uac: 'sha-256,md5', supported_algorithms_uas: 'sha-256' },
    aor: { contact: server },
    endpoint: { transport: 'sipper-tls', context: 'sipper-upstream', aors: id, outbound_auth: id,
      from_user: s.username, from_domain: s.domain, outbound_proxy: `${server};lr`,
      disallow: 'all', allow: 'opus,g722,ulaw,alaw', direct_media: 'no', media_encryption: 'sdes',
      rtp_symmetric: 'yes', force_rport: 'yes', rewrite_contact: 'yes', allow_transfer: 'no', allow_subscribe: 'no',
      identify_by: 'ip',
    },
    registration: { transport: 'sipper-tls', outbound_auth: id, server_uri: server,
      client_uri: `sip:${encodeURIComponent(s.username)}@${s.domain}`, contact_user: id, line: 'yes', endpoint: id,
      expiration: 300, retry_interval: 30, forbidden_retry_interval: 300, max_retries: 100,
    },
  } };
}

export class Upstreams {
  constructor(ari, allowedHosts) { this.ari = ari; this.allowedHosts = allowedHosts; this.accounts = new Map(); this.errors = new Map(); }
  get(configurationId, revision) { return [...this.accounts.values()].find(a => a.configurationId === configurationId && a.revision === revision); }
  persist(action) {
    try { action(); } catch { this.ari.emit('storageFault'); throw new Error('Gateway recovery storage unavailable'); }
  }
  async restore(routes) {
    for (const route of routes) {
      try {
        for (const type of ['auth', 'aor', 'endpoint', 'registration']) {
          await this.ari.request('GET', `asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(route.id)}`);
        }
        this.accounts.set(route.id, route);
      } catch (error) {
        if (error.status !== 404) throw error;
        await this.remove(route.id);
      }
    }
  }
  async reconcile(accounts, inUse = new Set()) {
    const wanted = new Map(); this.errors.clear();
    for (const account of accounts) {
      try { const value = upstreamObjects(account, this.allowedHosts); wanted.set(value.id, value); }
      catch { this.errors.set(account.id, 'unsupported_settings'); }
    }
    for (const [id, account] of wanted) {
      if (this.accounts.has(id)) continue;
      // A provider may allow only one Contact. Defer credential/configuration
      // changes until existing calls finish rather than replacing their route.
      if ([...this.accounts.values()].some(old => old.configurationId === account.configurationId && inUse.has(old.id))) continue;
      for (const [oldId, old] of this.accounts) if (old.configurationId === account.configurationId) await this.remove(oldId);
      this.persist(() => this.state?.route(account));
      try {
        for (const [type, fields] of Object.entries(account.objects)) await this.ari.put(type, id, fields);
        // Keep only routing metadata outside Asterisk; discard plaintext snapshots.
        this.accounts.set(id, { id, configurationId: account.configurationId, revision: account.revision });
      } catch (error) {
        await this.remove(id);
        if (error.status === 400) this.errors.set(account.configurationId, 'invalid_settings');
        else throw error;
      }
    }
    for (const id of this.accounts.keys()) if (!wanted.has(id) && !inUse.has(id)) await this.remove(id);
  }
  async remove(id) {
    for (const type of ['registration', 'endpoint', 'aor', 'auth']) await this.ari.remove(type, id);
    this.persist(() => this.state?.removeRoute(id));
    this.accounts.delete(id);
  }
}
