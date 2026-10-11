// OAuth and provisioning live in Electron's main process. No OAuth token, verifier, password or
// full configuration may be sent to a renderer. The controller consumes configurations directly.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as oauth from 'openid-client';
import { z } from 'zod';
import { availabilityValue, callResponse, configurationResponse, deviceResponse, directoryPageResponse, directoryResponse, identityResponse, uuid, validateConfiguration, validateDirectory } from './managedContracts.js';
import { setupReference } from './managedSetupLink.js';
import * as messages from './managedMessages.js';
import * as meetings from './managedMeetings.js';

export const MANAGED_ORIGIN = 'https://sipper.dev';
export const MANAGED_CALLBACK = 'sipper://oauth/callback';
const tokenSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number().finite() });
const savedSchema = z.object({
  version: z.literal(1), origin: z.string(), installationId: z.uuid(),
  identity: identityResponse.shape.user.nullable(), tokens: tokenSchema.nullable(),
  organisations: identityResponse.shape.organisations,
  enrollments: z.array(z.object({ organisationId: uuid, deviceId: uuid, name: z.string(), configuration: configurationResponse.nullable(),
    directory: z.object({ userId: z.string(), snapshot: directoryResponse }).nullable().default(null) })).max(100),
});
export class ManagedError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const problem = (code, message) => new ManagedError(code, message);

export function managedOrigin(value = MANAGED_ORIGIN, allowLocalDevelopment = false) {
  const url = new URL(value);
  const local = allowLocalDevelopment && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw problem('invalid_server', 'Use a secure Sipper server address.');
  }
  return url.origin;
}

async function boundedJson(response, limit = 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw problem('invalid_response', 'The management response was too large.');
  const reader = response.body?.getReader();
  if (!reader) throw problem('invalid_response', 'The management response was empty.');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw problem('invalid_response', 'The management response was too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class ManagedClient extends EventEmitter {
  #data; #pending = null; #epoch = 0; #refreshing = null; #work = Promise.resolve();
  #directoryAttempts = new Map();
  #authorityVersion = 0;
  constructor({ origin = MANAGED_ORIGIN, allowLocalDevelopment = false, store, openBrowser, fetch = globalThis.fetch, now = Date.now }) {
    super();
    this.origin = managedOrigin(origin, allowLocalDevelopment);
    this.allowLocalDevelopment = allowLocalDevelopment;
    this.store = store; this.openBrowser = openBrowser; this.fetch = fetch; this.now = now;
    this.status = { busy: false, signingIn: false, error: null };
    this.#data = this.#empty();
    this.oauth = new oauth.Configuration({
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/api/auth/oauth2/authorize`,
      token_endpoint: `${this.origin}/api/auth/oauth2/token`,
      revocation_endpoint: `${this.origin}/api/auth/oauth2/revoke`,
    }, 'sipper-windows', { token_endpoint_auth_method: 'none' }, oauth.None());
    this.oauth.timeout = 15;
    this.oauth[oauth.customFetch] = (url, options) => fetch(url, { ...options, redirect: 'error' });
    if (this.origin.startsWith('http:')) oauth.allowInsecureRequests(this.oauth);
  }
  #empty() { return { version: 1, origin: this.origin, installationId: randomUUID(), identity: null, tokens: null, organisations: [], enrollments: [] }; }
  #changed() { this.emit('change', this.snapshot()); }
  #save() { this.store.save(this.#data); }
  #current(epoch) { if (epoch !== this.#epoch) throw problem('cancelled', 'This managed-account operation was cancelled.'); }
  snapshot() {
    return { ...this.status, signedIn: Boolean(this.#data.identity), identity: this.#data.identity && { ...this.#data.identity },
      organisations: structuredClone(this.#data.organisations),
      enrollments: this.#data.enrollments.map(e => ({ organisationId: e.organisationId, deviceId: e.deviceId, name: e.name,
        expiresAt: e.configuration?.expiresAt ?? null, configured: Boolean(e.configuration && Date.parse(e.configuration.expiresAt) > this.now()),
        directory: e.directory && Date.parse(e.directory.snapshot.expiresAt) > this.now()
          ? { revision: e.directory.snapshot.revision, expiresAt: e.directory.snapshot.expiresAt, count: e.directory.snapshot.contacts.length } : null })) };
  }
  configurations() {
    return structuredClone(this.#data.enrollments.map(e => e.configuration).filter(c => c && Date.parse(c.expiresAt) > this.now()));
  }
  load() {
    try {
      const saved = this.store.read();
      if (saved) {
        const value = savedSchema.parse(saved);
        if (value.origin !== this.origin || Boolean(value.identity) !== Boolean(value.tokens) || (!value.identity && value.enrollments.length)) throw new Error('Invalid session binding');
        let pruned = false;
        for (const entry of value.enrollments) {
          if (entry.configuration && (entry.configuration.deviceId !== entry.deviceId || entry.configuration.organisation.id !== entry.organisationId)) throw new Error('Invalid device binding');
          if (entry.directory) {
            if (entry.directory.userId !== value.identity?.id) throw new Error('Invalid directory identity');
            if (Date.parse(entry.directory.snapshot.expiresAt) <= this.now()) { entry.directory = null; pruned = true; }
            else validateDirectory(entry.directory.snapshot, entry.organisationId, entry.deviceId, this.now());
          }
        }
        this.#data = value;
        // A persisted preference is not a fresh observation from this session.
        for (const org of this.#data.organisations) { delete org.doNotDisturb; delete org.availability; }
        if (pruned) this.#save();
      }
      this.status.error = null;
    } catch { this.status.error = 'The saved managed session could not be unlocked. Sign out locally to reset it.'; }
    this.#changed();
  }
  async #token() {
    if (!this.#data.tokens) throw problem('sign_in_required', 'Sign in to Sipper management.');
    if (this.#data.tokens.expiresAt > this.now() + 30_000) return this.#data.tokens.accessToken;
    if (!this.#refreshing) {
      const epoch = this.#epoch, old = this.#data.tokens;
      this.#refreshing = (async () => {
        try {
          const token = await oauth.refreshTokenGrant(this.oauth, old.refreshToken, { resource: `${this.origin}/api/client` });
          this.#current(epoch);
          const next = { ...this.#data, tokens: this.#tokens(token, old.refreshToken) };
          this.store.save(next);
          this.#data = next;
          return this.#data.tokens.accessToken;
        } catch (error) {
          if (epoch === this.#epoch && (error.error === 'invalid_grant' || error.code === 'OAUTH_INVALID_RESPONSE')) this.#invalidate();
          throw problem('refresh_failed', 'Managed sign-in could not be refreshed. Reconnect when the service is available.');
        } finally { this.#refreshing = null; }
      })();
    }
    return this.#refreshing;
  }
  #tokens(response, previousRefresh) {
    if (response.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(response.expires_in) || response.expires_in <= 0) throw problem('invalid_tokens', 'The sign-in response was invalid.');
    return tokenSchema.parse({ accessToken: response.access_token, refreshToken: response.refresh_token ?? previousRefresh, expiresAt: this.now() + response.expires_in * 1000 });
  }
  async #request(path, { method = 'GET', body, token, epoch = this.#epoch, signal, conflict = 'configuration_changed', rateLimit, responseLimit, badRequest } = {}) {
    signal?.throwIfAborted();
    const accessToken = token ?? await this.#token();
    this.#current(epoch);
    let response;
    try {
      response = await this.fetch(`${this.origin}/api/client${path}`, { method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { if (signal?.aborted) throw problem('cancelled', 'This call operation was cancelled.'); throw problem('unavailable', 'Could not reach Sipper management. Saved settings remain available until they expire.'); }
    signal?.throwIfAborted();
    this.#current(epoch);
    if (!response.ok) {
      if (response.status === 401) {
        if (!token) this.#invalidate();
        throw problem('sign_in_required', 'Sign in again to restore managed access.');
      }
      if ([403, 404].includes(response.status)) throw problem('access_denied', 'Managed access is unavailable. Contact your administrator.');
      if (response.status === 400 && badRequest) throw problem(badRequest, badRequest === 'invalid_meeting_input' ? 'Refresh the meeting and try again.' : 'Check the message and choose active licensed people from this customer.');
      if (response.status === 409) throw problem(conflict, conflict === 'call_unavailable' ? 'This call is no longer available.' : conflict === 'directory_changed' ? 'The company directory changed. Refresh and try again.' : conflict === 'messages_changed' ? 'This conversation changed. Refresh and try again.' : conflict === 'meeting_changed' ? 'This meeting changed or is full. Refresh and try again.' : 'Settings changed. Refresh and try again.');
      if (response.status === 429 && rateLimit) throw problem(rateLimit, rateLimit === 'meeting_rate_limit' ? 'Wait a moment before trying the meeting again.' : 'Messaging is temporarily limited. Wait a moment and try again.');
      throw problem('unavailable', 'The management service is temporarily unavailable.');
    }
    let value;
    try { value = await boundedJson(response, responseLimit); }
    catch { throw problem('invalid_response', 'The management service returned an invalid response.'); }
    this.#current(epoch);
    signal?.throwIfAborted();
    return value;
  }
  #invalidate(persist = true) {
    this.#epoch++;
    this.#directoryAttempts.clear();
    this.cancelSignIn();
    const installationId = this.#data.installationId;
    this.#data = { ...this.#empty(), installationId };
    try { if (persist) this.#save(); } finally { this.#changed(); }
  }
  async signIn() {
    if (this.status.busy) throw problem('busy', 'Wait for the current managed-account update to finish.');
    this.cancelSignIn();
    const epoch = this.#epoch, verifier = oauth.randomPKCECodeVerifier(), state = oauth.randomState();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    this.#current(epoch);
    // An OAuth-only token is sufficient: identity comes from the authenticated client API.
    const url = oauth.buildAuthorizationUrl(this.oauth, { response_type: 'code', redirect_uri: MANAGED_CALLBACK,
      scope: 'email offline_access sipper:client', resource: `${this.origin}/api/client`, state,
      code_challenge: challenge, code_challenge_method: 'S256' });
    const timer = setTimeout(() => { this.cancelSignIn(); this.status.error = 'Sign-in expired. Try again.'; this.#changed(); }, 600_000);
    timer.unref?.();
    this.#pending = { verifier, state, epoch, timer };
    this.status = { ...this.status, signingIn: true, error: null }; this.#changed();
    try { await this.openBrowser(url.href); }
    catch { this.cancelSignIn(); throw problem('browser_failed', 'Could not open your browser.'); }
  }
  cancelSignIn() {
    if (this.#pending) clearTimeout(this.#pending.timer);
    this.#pending = null; this.status.signingIn = false; this.#changed();
  }
  isCallback(value) {
    try { const url = new URL(value); return url.protocol === 'sipper:' && url.hostname === 'oauth' && url.pathname === '/callback'; }
    catch { return false; }
  }
  async handleCallback(value) {
    if (!this.isCallback(value)) return false;
    const pending = this.#pending;
    if (!pending) return true; // Never display callback contents, including unsolicited codes.
    if (pending.exchanging) return true;
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash || url.searchParams.get('state') !== pending.state) return true;
    pending.exchanging = true;
    // Keep the pending object until completion so cancellation invalidates an in-flight exchange.
    clearTimeout(pending.timer);
    this.status.busy = true; this.#changed();
    try {
      const tokens = this.#tokens(await oauth.authorizationCodeGrant(this.oauth, url,
        { expectedState: pending.state, pkceCodeVerifier: pending.verifier }, { resource: `${this.origin}/api/client` }));
      this.#current(pending.epoch);
      if (this.#pending !== pending) throw problem('cancelled', 'Sign-in cancelled.');
      const identity = identityResponse.parse(await this.#request('/organisations', { token: tokens.accessToken, epoch: pending.epoch }));
      if (this.#pending !== pending) throw problem('cancelled', 'Sign-in cancelled.');
      if (this.#data.identity && this.#data.identity.id !== identity.user.id) throw problem('identity_changed', 'Sign out before connecting a different Sipper identity.');
      const next = { ...this.#data, identity: identity.user, organisations: identity.organisations, tokens };
      this.store.save(next); // Nothing is bound or retained until the verified identity is safely saved.
      this.#data = next;
      this.status.error = null;
    } catch (error) {
      this.status.error = error instanceof ManagedError ? error.message : 'Sign-in could not be completed. Please try again.';
    } finally {
      if (this.#pending === pending) this.cancelSignIn();
      this.status.busy = false; this.#changed();
    }
    return true;
  }
  async #operation(fn) {
    if (this.#pending) throw problem('sign_in_pending', 'Finish or cancel browser sign-in first.');
    const epoch = this.#epoch;
    const task = this.#work.catch(() => {}).then(async () => {
      this.#current(epoch); this.status.busy = true; this.status.error = null; this.#changed();
      try { return await fn(epoch); }
      catch (error) {
        this.status.error = error instanceof ManagedError ? error.message : 'Could not update managed accounts. Please try again.';
        throw problem(error.code ?? 'request_failed', this.status.error);
      } finally { this.status.busy = false; this.#changed(); }
    });
    this.#work = task;
    return task;
  }
  async #configuration(entry, epoch) {
    let configuration;
    try {
      const raw = await this.#request(`/devices/${entry.deviceId}/configuration`, { epoch });
      configuration = validateConfiguration(raw, entry.organisationId, entry.deviceId, this.now());
    } catch (error) {
      if (error.code === 'access_denied' || error.code === 'invalid_response' || !(error instanceof ManagedError)) {
        const current = epoch === this.#epoch && this.#data.enrollments.find(e => e.deviceId === entry.deviceId);
        if (current) { current.configuration = null; this.#clearDirectory(current); }
      }
      if (epoch === this.#epoch) this.#save();
      throw error;
    }
    this.#current(epoch);
    const next = { ...this.#data, enrollments: this.#data.enrollments.map(e => e.deviceId === entry.deviceId ? { ...e, configuration } : e) };
    this.store.save(next);
    this.#data = next;
    this.#changed();
  }
  refresh() {
    return this.#operation(async epoch => {
      let response;
      try { response = identityResponse.parse(await this.#request('/organisations', { epoch })); }
      catch (error) {
        if (epoch === this.#epoch) for (const org of this.#data.organisations) { delete org.doNotDisturb; delete org.availability; }
        throw error;
      }
      if (response.user.id !== this.#data.identity?.id) { this.#invalidate(); throw problem('identity_changed', 'Sign in again to restore managed access.'); }
      this.#data.organisations = response.organisations;
      for (const entry of this.#data.enrollments) {
        if (!response.organisations.some(org => org.id === entry.organisationId && org.status === 'active' && org.licensed)) this.#clearDirectory(entry);
      }
      this.#save();
      let failure;
      for (const entry of this.#data.enrollments) {
        try { await this.#configuration(entry, epoch); }
        catch (error) { failure = error; if (epoch !== this.#epoch) break; }
      }
      if (failure) throw failure;
    });
  }
  setDoNotDisturb(organisationId, enabled) {
    return this.#setCallingPreference(organisationId, 'doNotDisturb', z.boolean().parse(enabled));
  }
  setAvailability(organisationId, value) {
    return this.#setCallingPreference(organisationId, 'availability', availabilityValue.parse(value));
  }
  #setCallingPreference(organisationId, key, value) {
    const id = uuid.parse(organisationId);
    return this.#operation(async epoch => {
      const org = this.#data.organisations.find(org => org.id === id && org.status === 'active' && org[key] !== undefined);
      if (!this.#data.identity || !org) throw problem('access_denied', 'Refresh your organisations to check calling preferences.');
      try {
        const result = z.object({ [key]: z.literal(value) }).parse(await this.#request(`/organisations/${id}/calling-preference`, {
          method: 'PATCH', body: { [key]: value }, epoch,
        }));
        org[key] = result[key];
      } catch (error) {
        if (epoch === this.#epoch) delete org[key];
        throw error;
      }
    });
  }
  connect(organisationId, metadata) {
    return this.#operation(epoch => this.#connect(organisationId, metadata, epoch));
  }
  connectSetupLink(value, metadata) {
    return this.#operation(async epoch => {
      if (!this.#data.identity) throw problem('sign_in_required', 'Sign in with the email address invited by your administrator.');
      let reference;
      try { reference = setupReference(value, this.origin); }
      catch { throw problem('invalid_setup_link', 'This setup link is invalid or belongs to another Sipper server.'); }
      let raw;
      try { raw = await this.#request('/setup-links/redeem', { method: 'POST', epoch, body: { reference } }); }
      catch (error) {
        if (error.code === 'access_denied') throw problem('setup_unavailable', 'This setup link is unavailable for your signed-in account. Check your email and ask your administrator for a new link.');
        throw error;
      }
      const result = z.object({ userId: z.string(), organisation: identityResponse.shape.organisations.element }).safeParse(raw);
      if (!result.success || result.data.userId !== this.#data.identity.id || result.data.organisation.status !== 'active' || !result.data.organisation.licensed) {
        throw problem('invalid_response', 'The setup response could not be verified.');
      }
      const org = result.data.organisation;
      this.#data.organisations = [...this.#data.organisations.filter(o => o.id !== org.id), org];
      this.#save(); // Save the verified customer, never the single-use reference.
      await this.#connect(org.id, metadata, epoch);
    });
  }
  async #connect(organisationId, { name, appVersion, osVersion }, epoch) {
      const org = this.#data.organisations.find(o => o.id === organisationId && o.status === 'active' && o.licensed);
      if (!org) throw problem('licence_required', 'Choose a customer with an active assigned licence.');
      let entry = this.#data.enrollments.find(e => e.organisationId === organisationId);
      if (!entry) {
        const device = deviceResponse.parse(await this.#request(`/organisations/${organisationId}/devices`, { method: 'POST', epoch,
          body: { installationId: this.#data.installationId, name, platform: 'windows', appVersion, osVersion } }));
        // The token binds the enrolment identity; the configuration response then verifies
        // both the requested organisation and the returned device before any SIP data is used.
        entry = { organisationId, deviceId: device.id, name: device.name, configuration: null, directory: null };
        this.#data.enrollments.push(entry); this.#save();
      }
      await this.#configuration(entry, epoch);
  }
  report(deviceId, { revision, registrations, directCalls, applied = false }) {
    return this.#operation(async epoch => {
      const entry = this.#data.enrollments.find(e => e.deviceId === deviceId);
      if (!entry?.configuration || Date.parse(entry.configuration.expiresAt) <= this.now()) return;
      if (entry.configuration.revision !== revision) throw problem('configuration_changed', 'Settings changed. Refresh and try again.');
      try {
        const result = await this.#request(`/devices/${deviceId}/report`, { method: 'POST', epoch, body: { ...(applied ? { appliedRevision: revision, directCalls } : {}), registrations } });
        if (result.accepted !== true) throw problem('invalid_report', 'The activity report was not acknowledged.');
      }
      catch (error) {
        if (epoch === this.#epoch && error.code === 'access_denied') {
          const current = this.#data.enrollments.find(e => e.deviceId === deviceId);
          if (current) { current.configuration = null; this.#clearDirectory(current); this.#save(); }
        }
        throw error;
      }
    });
  }
  // Call polling does not join the provisioning queue or change the settings UI's busy/error state.
  async call(callId, binding, action = 'status', signal) {
    const id = uuid.parse(callId), deviceId = uuid.parse(binding.deviceId), organisationId = uuid.parse(binding.organisationId);
    const accountId = uuid.parse(binding.remoteAccountId);
    if (!['status', 'answer', 'decline'].includes(action)) throw problem('call_unavailable', 'This call is unavailable.');
    const authorised = () => {
      const entry = this.#data.enrollments.find(e => e.deviceId === deviceId && e.organisationId === organisationId);
      return this.#data.identity && entry && (action === 'decline' || (entry.configuration && Date.parse(entry.configuration.expiresAt) > this.now()
        && entry.configuration.accounts.some(a => a.id === accountId && a.mode === 'gateway')));
    };
    if (!authorised()) throw problem('call_unavailable', 'This call is unavailable.');
    const raw = await this.#request(`/devices/${deviceId}/calls/${id}${action === 'status' ? '' : `/${action}`}`, {
      method: action === 'status' ? 'GET' : 'POST', ...(action === 'status' ? {} : { body: {} }), signal, conflict: 'call_unavailable',
    });
    if (!authorised()) throw problem('call_unavailable', 'This call is unavailable.');
    const parsed = callResponse.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id || parsed.data.configurationId !== accountId) throw problem('invalid_response', 'The call response could not be verified.');
    return parsed.data;
  }
  disconnect(deviceId) {
    return this.#operation(async epoch => {
      const entry = this.#data.enrollments.find(e => e.deviceId === deviceId);
      if (!entry) return;
      this.#clearDirectory(entry);
      // Local removal takes effect even when offline. Server revocation is attempted and reported.
      this.#data.enrollments = this.#data.enrollments.filter(e => e !== entry);
      this.#data.installationId = randomUUID(); // Explicit removal permits a new enrolment; refresh never does this.
      this.#save(); this.#changed();
      await this.#request(`/devices/${deviceId}`, { method: 'DELETE', epoch });
    });
  }

  #clearDirectory(entry) { entry.directory = null; this.#directoryAttempts.delete(entry.deviceId); this.#authorityVersion++; }
  expireDirectories() {
    let changed = false;
    for (const entry of this.#data.enrollments) {
      if (entry.directory && Date.parse(entry.directory.snapshot.expiresAt) <= this.now()) { this.#clearDirectory(entry); changed = true; }
    }
    if (changed) { try { this.#save(); } finally { this.#changed(); } }
  }
  directorySnapshot(deviceId) {
    const entry = this.#data.enrollments.find(e => e.deviceId === uuid.parse(deviceId));
    if (!entry?.directory || !this.#data.identity || entry.directory.userId !== this.#data.identity.id
      || Date.parse(entry.directory.snapshot.expiresAt) <= this.now()) return null;
    return structuredClone(entry.directory.snapshot);
  }
  // Independent of the provisioning queue: a large directory must not delay incoming calls.
  async refreshDirectory(deviceId) {
    const id = uuid.parse(deviceId), epoch = this.#epoch, attempt = Symbol('directory');
    if (!this.#data.identity || !this.#data.enrollments.some(e => e.deviceId === id)) throw problem('access_denied', 'This managed device is unavailable.');
    this.#directoryAttempts.set(id, attempt);
    const current = () => {
      this.#current(epoch);
      const entry = this.#data.enrollments.find(e => e.deviceId === id);
      if (!this.#data.identity || !entry) throw problem('access_denied', 'This managed device is unavailable.');
      if (this.#directoryAttempts.get(id) !== attempt) throw problem('cancelled', 'This directory update was cancelled.');
      return entry;
    };
    const entry = current();
    try {
      for (let restart = 0; restart < 2; restart++) {
        let first, cursor, bytes = 0, expiry = Infinity;
        const contacts = [], seen = new Set();
        try {
          do {
            current();
            const query = cursor ? `?${new URLSearchParams({ after: cursor, revision: first.revision })}` : '';
            const raw = await this.#request(`/devices/${id}/directory${query}`, { epoch, conflict: 'directory_changed' });
            current();
            const page = directoryPageResponse.parse(raw);
            validateDirectory(page, entry.organisationId, id, this.now());
            if (first && (page.revision !== first.revision || page.organisation.name !== first.organisation.name)) throw problem('directory_changed', 'The company directory changed. Refresh and try again.');
            first ??= page;
            for (const contact of page.contacts) {
              if (seen.has(contact.id)) throw problem('invalid_directory', 'The company directory could not be verified.');
              seen.add(contact.id);
              bytes += Buffer.byteLength(contact.name + contact.company) + contact.numbers.reduce((size, n) => size + Buffer.byteLength(n.label + n.number), 0);
              contacts.push(contact);
            }
            expiry = Math.min(expiry, Date.parse(page.expiresAt)); cursor = page.nextCursor;
            // ponytail: bounded full snapshots; use encrypted indexed storage beyond 10,000 contacts / 8 MB.
            if (contacts.length > 10000 || bytes > 8_000_000 || (cursor && contacts.length >= 10000)) throw problem('directory_too_large', 'This company directory exceeds this app’s local limit. Contact your administrator.');
          } while (cursor);
          const snapshot = validateDirectory({ ...first, contacts, expiresAt: new Date(expiry).toISOString() }, entry.organisationId, id, this.now());
          current();
          const next = { ...this.#data, enrollments: this.#data.enrollments.map(e => e.deviceId === id ? { ...e, directory: { userId: this.#data.identity.id, snapshot } } : e) };
          this.store.save(next); this.#data = next; this.#changed();
          return structuredClone(snapshot);
        } catch (error) { if (error.code === 'directory_changed' && restart === 0) continue; throw error; }
      }
    } catch (error) {
      if (epoch === this.#epoch && error.code === 'access_denied') {
        const latest = this.#data.enrollments.find(e => e.deviceId === id);
        if (latest) {
          this.#clearDirectory(latest);
          try { this.#save(); }
          catch { throw problem('storage_unavailable', 'Directory access was removed, but the saved copy could not be cleared. Sign out and check your device storage.'); }
          finally { this.#changed(); }
        }
      }
      throw error instanceof ManagedError ? error : problem('invalid_directory', 'The company directory could not be verified or saved securely.');
    }
  }
  directoryNumber(deviceId, contactId, number) {
    const snapshot = this.directorySnapshot(deviceId), contact = snapshot?.contacts.find(c => c.id === uuid.parse(contactId));
    if (typeof number !== 'string' || !contact?.numbers.some(n => n.number === number)) throw problem('invalid_directory', 'This shared contact is unavailable. Refresh the directory.');
    return { number, organisationId: snapshot.organisation.id, deviceId: snapshot.deviceId };
  }
  async directoryStatus(deviceId, contactIds) {
    const id = uuid.parse(deviceId), epoch = this.#epoch;
    const ids = z.array(uuid).min(1).max(100).refine(values => new Set(values).size === values.length).parse(contactIds);
    const directory = this.directorySnapshot(id);
    if (!directory || ids.some(contactId => !directory.contacts.some(c => c.id === contactId))) throw problem('invalid_directory', 'Refresh the company directory.');
    try {
      const raw = await this.#request(`/devices/${id}/directory/status`, { method: 'POST', epoch,
        body: { contactIds: ids, revision: directory.revision }, conflict: 'directory_changed' });
      this.#current(epoch);
      if (this.directorySnapshot(id)?.revision !== directory.revision) throw problem('access_denied', 'The company directory changed.');
      const value = z.object({ deviceId: z.literal(id), organisationId: z.literal(directory.organisation.id), revision: z.literal(directory.revision),
        expiresAt: z.iso.datetime({ offset: true }), contacts: z.array(z.object({ contactId: uuid,
          availability: availabilityValue.nullable(), doNotDisturb: z.boolean().nullable(),
          activity: z.object({ state: z.enum(['in_call', 'on_hold', 'ringing', 'dialling']), source: z.enum(['device', 'gateway']),
            observedAt: z.iso.datetime({ offset: true }) }).nullable().optional(),
        }).refine(c => (c.availability === null) === (c.doNotDisturb === null))).max(100),
      }).parse(raw);
      if (value.contacts.length !== ids.length || new Set(value.contacts.map(c => c.contactId)).size !== ids.length
        || value.contacts.some(c => !ids.includes(c.contactId)) || Date.parse(value.expiresAt) <= this.now()
        || Date.parse(value.expiresAt) > this.now() + 60_000
        || value.contacts.some(c => c.activity && (Date.parse(c.activity.observedAt) > this.now() + 60_000
          || Date.parse(c.activity.observedAt) <= this.now() - 180_000
          || Date.parse(value.expiresAt) > Date.parse(c.activity.observedAt) + 180_000))) throw new Error('Invalid status response');
      value.expiresAt = new Date(Math.min(Date.parse(value.expiresAt), this.now() + 30_000)).toISOString();
      return value; // Never persisted with the offline directory or renderer's global state.
    } catch (error) {
      if (epoch === this.#epoch && error.code === 'access_denied') {
        const entry = this.#data.enrollments.find(e => e.deviceId === id);
        if (entry) { this.#clearDirectory(entry); try { this.#save(); } finally { this.#changed(); } }
      }
      throw error instanceof ManagedError ? error : problem('invalid_response', 'Shared status is unavailable.');
    }
  }
  async #conversationRequest(deviceId, area, path, schema, { grant = false, ...options } = {}) {
    const id = uuid.parse(deviceId), epoch = this.#epoch, authority = this.#authorityVersion;
    const userId = this.#data.identity?.id;
    const current = () => {
      this.#current(epoch);
      const entry = this.#data.enrollments.find(e => e.deviceId === id);
      if (!userId || this.#data.identity?.id !== userId || authority !== this.#authorityVersion || !entry
        || !this.#data.organisations.some(o => o.id === entry.organisationId && o.status === 'active' && o.licensed)) {
        throw problem('access_denied', 'Refresh managed accounts to check customer access.');
      }
      return entry;
    };
    const entry = current();
    try {
      const messaging = area === 'messages';
      const raw = await this.#request(`/devices/${id}/${area}/${path}`, { ...options, epoch,
        conflict: messaging ? 'messages_changed' : 'meeting_changed', rateLimit: messaging ? 'message_rate_limit' : 'meeting_rate_limit',
        badRequest: messaging ? 'invalid_message_input' : 'invalid_meeting_input', responseLimit: 2 * 1024 * 1024 });
      current();
      const value = schema.parse(raw), now = this.now();
      if ((grant ? value.organisationId !== entry.organisationId : value.userId !== userId || value.deviceId !== id || value.organisation.id !== entry.organisationId)
        || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + (grant ? 120_000 : 60_000)) throw new Error('Invalid conversation scope');
      if (!grant) value.expiresAt = new Date(Math.min(Date.parse(value.expiresAt), now + 30_000)).toISOString();
      return value;
    } catch (error) {
      if (error.code === 'access_denied') this.#authorityVersion++; // Fence sibling requests after observed withdrawal.
      if (error.code === 'unavailable') throw problem('unavailable', area === 'messages' ? 'Could not reach Sipper messages. Refresh when the service is available.' : 'Could not reach Sipper meetings. Try again when the service is available.');
      throw error instanceof ManagedError ? error : problem(area === 'messages' ? 'invalid_messages' : 'invalid_meeting', 'The response could not be verified. Refresh and try again.');
    }
  }
  #messageRequest(deviceId, path, schema, options = {}) {
    return this.#conversationRequest(deviceId, 'messages', path, schema, options);
  }
  #meetingRequest(deviceId, path, schema, options = {}) {
    return this.#conversationRequest(deviceId, 'conferencing', path, schema, options);
  }
  async currentMeeting(deviceId, conversationId) {
    const id = uuid.parse(conversationId);
    const value = await this.#meetingRequest(deviceId, `conversations/${id}/meeting`, meetings.currentMeeting);
    if (value.meeting && value.meeting.conversationId !== id) throw problem('invalid_meeting', 'The meeting belongs to another conversation.');
    return value;
  }
  async startMeeting(deviceId, conversationId, requestId) {
    const id = uuid.parse(conversationId), nonce = uuid.parse(requestId);
    const value = await this.#meetingRequest(deviceId, `conversations/${id}/meeting`, meetings.currentMeeting, { method: 'POST', body: { id: nonce } });
    if (!value.meeting || value.meeting.conversationId !== id) throw problem('invalid_meeting', 'The new meeting could not be verified. Retry the same request.');
    return value;
  }
  async meetingDetails(deviceId, meetingId) {
    const id = uuid.parse(meetingId);
    const value = await this.#meetingRequest(deviceId, `meetings/${id}`, meetings.meetingDetails);
    if (value.meeting.id !== id) throw problem('invalid_meeting', 'Meeting details could not be verified.');
    return value;
  }
  async joinMeeting(deviceId, meetingId, sessionId) {
    const id = uuid.parse(meetingId), nonce = uuid.parse(sessionId);
    const value = await this.#meetingRequest(deviceId, `meetings/${id}/join`, meetings.meetingJoin, { method: 'POST', body: { id: nonce }, grant: true });
    try { return meetings.validateMeetingGrant(value, value.organisationId, id, nonce, this.now(), this.allowLocalDevelopment); }
    catch { throw problem('invalid_meeting', 'The meeting connection could not be verified.'); }
  }
  async leaveMeeting(deviceId, meetingId, sessionId) {
    const id = uuid.parse(meetingId), nonce = uuid.parse(sessionId);
    const value = await this.#meetingRequest(deviceId, `meetings/${id}/sessions/${nonce}/leave`, meetings.meetingLeave, { method: 'POST', body: {} });
    if (value.meetingId !== id || value.sessionId !== nonce) throw problem('invalid_meeting', 'Leaving the meeting was not confirmed.');
    return value;
  }
  async endMeeting(deviceId, meetingId) {
    const id = uuid.parse(meetingId);
    const value = await this.#meetingRequest(deviceId, `meetings/${id}/end`, meetings.meetingResult, { method: 'POST', body: {} });
    if (value.meeting.id !== id || !value.meeting.endedAt) throw problem('invalid_meeting', 'Meeting end was not confirmed.');
    return value;
  }
  async removeMeetingPerson(deviceId, meetingId, userId) {
    const id = uuid.parse(meetingId), person = messages.messageUser.parse(userId);
    const value = await this.#meetingRequest(deviceId, `meetings/${id}/people/${encodeURIComponent(person)}`, meetings.meetingRemoval, { method: 'DELETE' });
    if (value.meetingId !== id || value.targetUserId !== person) throw problem('invalid_meeting', 'Removal was not confirmed.');
    return value;
  }
  messagePeople(deviceId, { search = '', after } = {}) {
    const query = new URLSearchParams({ q: messages.messageSearch.parse(search) });
    if (after != null) query.set('after', messages.messageUser.parse(after));
    return this.#messageRequest(deviceId, `people?${query}`, messages.messagePeople);
  }
  async messageAlerts(deviceId, { after = '0' } = {}) {
    messages.messageSequence.parse(after);
    const value = await this.#messageRequest(deviceId, `alerts?${new URLSearchParams({after})}`, messages.messageAlerts);
    const now=this.now();
    if(value.alerts.some(a=>BigInt(a.sequence)<=BigInt(after) || Date.parse(a.expiresAt)<=now || Date.parse(a.expiresAt)>now+300_000)) {
      throw problem('invalid_messages','Message alerts could not be verified.');
    }
    return value;
  }
  conversations(deviceId, { after } = {}) {
    const query = after == null ? '' : `?${new URLSearchParams({ after: messages.conversationCursor.parse(after) })}`;
    return this.#messageRequest(deviceId, `conversations${query}`, messages.conversationPage);
  }
  async createConversation(deviceId, input) {
    const body = messages.newConversation.parse(input);
    if (body.userIds.includes(this.#data.identity?.id)) throw problem('invalid_message_input', 'Choose other people for this conversation.');
    const value = await this.#messageRequest(deviceId, 'conversations', messages.conversationResult, { method: 'POST', body });
    const conversation = value.conversation, ids = [value.userId, ...body.userIds];
    if (conversation.participants.length !== ids.length || conversation.participants.some(p => !ids.includes(p.id))
      || (body.userIds.length === 1 ? conversation.kind !== 'direct' : conversation.kind !== 'group'
        || conversation.id !== body.id || conversation.title !== body.title)) throw problem('invalid_messages', 'The new conversation could not be verified.');
    return value;
  }
  async conversationMessages(deviceId, conversationId, { before, after } = {}) {
    const id = uuid.parse(conversationId), query = new URLSearchParams();
    if (before != null && after != null) throw problem('invalid_message_input', 'Choose one history cursor.');
    if (before != null) query.set('before', messages.positiveSequence.parse(before));
    if (after != null) query.set('after', messages.positiveSequence.parse(after));
    const value = await this.#messageRequest(deviceId, `conversations/${id}${query.size ? `?${query}` : ''}`, messages.messagePage);
    if (value.conversation.id !== id || (value.nextCursor !== null && (value.messages.length !== 100
      || value.nextCursor !== (after != null ? value.messages.at(-1)?.sequence : value.messages[0]?.sequence)))
      || value.messages.some(m => (before != null && BigInt(m.sequence) >= BigInt(before)) || (after != null && BigInt(m.sequence) <= BigInt(after)))) {
      throw problem('invalid_messages', 'Message history could not be verified.');
    }
    return value;
  }
  async updateMessageGroup(deviceId, conversationId, input) {
    const id = uuid.parse(conversationId), body = messages.groupInput.parse(input);
    if (!body.userIds.includes(this.#data.identity?.id)) throw problem('invalid_message_input', 'Use Leave group to remove yourself.');
    const value = await this.#messageRequest(deviceId, `conversations/${id}/group`, messages.conversationResult, { method: 'PUT', body });
    const c = value.conversation;
    if (c.id !== id || c.kind !== 'group' || c.title !== body.title || c.ownerId !== body.ownerId || c.revision == null
      || BigInt(c.revision) < BigInt(body.revision) || c.participants.length !== body.userIds.length || c.participants.some(p => !body.userIds.includes(p.id))) {
      throw problem('invalid_messages', 'The group change could not be verified. Reload the group.');
    }
    return value;
  }
  async leaveMessageGroup(deviceId, conversationId) {
    const id = uuid.parse(conversationId);
    const value = await this.#messageRequest(deviceId, `conversations/${id}/leave`, messages.messageLeaveResult, { method: 'POST', body: {} });
    if (value.conversationId !== id) throw problem('invalid_messages', 'Leaving the group could not be verified. Retry the same request.');
    return value;
  }
  async sendMessage(deviceId, conversationId, input) {
    const id = uuid.parse(conversationId), body = messages.newMessage.parse(input);
    const value = await this.#messageRequest(deviceId, `conversations/${id}`, messages.messageResult, { method: 'POST', body });
    if (value.message.id !== body.id || value.message.text !== body.text || value.message.senderId !== value.userId) {
      throw problem('invalid_messages', 'The sent message could not be verified. Retry the same message.');
    }
    return value;
  }
  async markConversationRead(deviceId, conversationId, sequence) {
    const id = uuid.parse(conversationId), body = { sequence: messages.messageSequence.parse(sequence) };
    const value = await this.#messageRequest(deviceId, `conversations/${id}/read`, messages.messageReadResult, { method: 'POST', body });
    if (BigInt(value.sequence) < BigInt(sequence)) throw problem('invalid_messages', 'The read marker could not be verified.');
    return value;
  }
  async signOut() {
    const old = this.#data;
    this.#invalidate(false); // Removal must still work when secure storage cannot encrypt.
    this.store.clear();
    this.#data.installationId = randomUUID();
    if (old.tokens) {
      const removals = await Promise.allSettled(old.enrollments.map(entry => this.#request(`/devices/${entry.deviceId}`, {
        method: 'DELETE', token: old.tokens.accessToken,
      })));
      if (removals.some(r => r.status === 'rejected')) {
        this.status.error = 'Signed out locally. Device removal could not be confirmed with the server.';
        this.#changed();
      }
      // Revoke both tokens; unrelated browser sessions are not signed out.
      await oauth.tokenRevocation(this.oauth, old.tokens.refreshToken, { token_type_hint: 'refresh_token' }).catch(() => {});
      await oauth.tokenRevocation(this.oauth, old.tokens.accessToken, { token_type_hint: 'access_token' }).catch(() => {});
    }
  }
}
