// Connects the encrypted provisioning client to runtime SIP accounts. All work stays in main.
import { directCallReport } from './managedAccounts.js';
export class ManagedController {
  constructor({ client, state, metadata, onMessage = () => {}, clearMessages = () => {} }) {
    this.client = client; this.state = state; this.metadata = metadata;
    this.onMessage = onMessage; this.clearMessages = clearMessages;
    this.messageEpoch = 0; this.messageSeen = new Map(); this.messageCursors = new Map();
    state.configureManagedCalls(client);
    this.fingerprint = null; this.applyError = null; this.stopped = false;
    this.registrationCodes = new Map();
    this.changed = () => this.reconcile();
    this.registration = event => this.registrationCodes.set(event.accountId, event.code);
    this.engineStopped = () => this.registrationCodes.clear();
    this.networkRecovered = () => this.refresh().catch(() => {});
    this.settingsChanged = () => this.reconcileMessageAccess();
    client.on('change', this.changed);
    state.on('messageNotificationsChanged', this.settingsChanged);
    state.engine.on('registration', this.registration);
    state.engine.on('exit', this.engineStopped);
  }

  start() {
    this.client.load();
    this.state.engine.on('networkRecovered', this.networkRecovered);
    this.leaseTimer = setInterval(() => { this.reconcile(); this.reportChanges().catch(() => {}); this.pollMessages().catch(() => {}); }, 1000);
    this.refreshTimer = setInterval(() => this.refresh().catch(() => {}), 60_000);
    this.leaseTimer.unref?.(); this.refreshTimer.unref?.();
    if (this.client.snapshot().signedIn) this.refresh().catch(() => {});
  }

  reconcile() {
    if (this.stopped) return;
    this.reconcileMessageAccess();
    try { this.client.expireDirectories?.(); }
    catch { this.client.status.error = 'Expired directory data could not be removed from secure storage.'; }
    const configurations = this.client.configurations();
    const fingerprint = JSON.stringify(configurations);
    if (fingerprint !== this.fingerprint) {
      try {
        this.applying = this.state.applyManagedConfigurations(this.client.origin, configurations);
        this.fingerprint = fingerprint;
        this.applyError = null;
      } catch {
        // Never retain an older identity's accounts when a new configuration cannot be applied.
        this.applying = this.state.applyManagedConfigurations(this.client.origin, []);
        this.fingerprint = null;
        this.applyError = 'Managed calling settings could not be applied. Contact your administrator.';
      }
      const currentIds = new Set(this.state.accounts.map(a => a.id));
      for (const id of this.registrationCodes.keys()) if (!currentIds.has(id)) this.registrationCodes.delete(id);
    }
    const snapshot = this.client.snapshot();
    const status = { ...snapshot, error: this.applyError ?? snapshot.error };
    if (JSON.stringify(status) !== JSON.stringify(this.state.managed)) this.state.setManagedStatus(status);
  }

  messageConnections() {
    const status = this.client.snapshot();
    if (this.stopped || !this.state.settings.messageNotifications || !status.signedIn || status.signingIn) return [];
    return status.enrollments.filter(e => status.organisations.some(o => o.id === e.organisationId && o.status === 'active' && o.licensed));
  }

  resetMessageNotifications() {
    this.messageEpoch++; this.messageSeen.clear(); this.messageCursors.clear(); this.lastMessageHint = null;
    this.clearMessages();
  }

  reconcileMessageAccess() {
    const entries = this.messageConnections(), identity = this.client.snapshot().identity?.id;
    const signature = JSON.stringify([this.client.origin, identity, entries.map(e => [e.deviceId, e.organisationId]).sort()]);
    if (signature !== this.messageSignature) { this.messageSignature = signature; this.resetMessageNotifications(); }
    return entries;
  }

  async pollMessages() {
    const entries = this.reconcileMessageAccess(), status = this.client.snapshot();
    if (!entries.length || this.messagePolling || status.busy || this.refreshing || performance.now() - (this.messageAttempt ?? -Infinity) < 5000) return;
    this.messageAttempt = performance.now(); this.messagePolling = true;
    const epoch = this.messageEpoch;
    try {
      for (const entry of entries) {
        const page = await this.client.messageAlerts(entry.deviceId, { after: this.messageCursors.get(entry.deviceId) ?? '0' });
        this.reconcileMessageAccess();
        if (epoch !== this.messageEpoch) return;
        // Scan another page next tick, then restart at zero to catch late commits.
        // ponytail: 100 conversations per customer per five seconds; drain pages in one tick if measured traffic needs it.
        this.messageCursors.set(entry.deviceId, page.nextCursor ?? '0');
        for (const [key, seen] of this.messageSeen) if (Date.parse(seen.expiresAt) <= Date.now()) this.messageSeen.delete(key);
        let latest;
        for (const alert of page.alerts) {
          const key = `${entry.deviceId}:${alert.conversationId}`, seen = this.messageSeen.get(key);
          if (seen && BigInt(seen.sequence) >= BigInt(alert.sequence)) continue;
          this.messageSeen.set(key, alert); latest = alert;
        }
        if (latest) {
          const hint = Object.freeze({ deviceId: entry.deviceId, conversationId: latest.conversationId, expiresAt: latest.expiresAt });
          this.lastMessageHint = hint; this.onMessage(hint);
        }
      }
    } catch (error) {
      if (epoch === this.messageEpoch && ['access_denied', 'sign_in_required', 'cancelled'].includes(error.code)) this.resetMessageNotifications();
    } finally { this.messagePolling = false; }
  }

  async openMessage(hint) {
    this.reconcileMessageAccess();
    if (this.lastMessageHint !== hint || !this.messageConnections().some(e => e.deviceId === hint.deviceId)) return false;
    const epoch = this.messageEpoch;
    try {
      await this.client.refresh();
      this.reconcileMessageAccess();
      return epoch === this.messageEpoch && this.lastMessageHint === hint && this.messageConnections().some(e => e.deviceId === hint.deviceId);
    } catch { this.resetMessageNotifications(); return false; }
  }

  async refresh() {
    const status = this.client.snapshot();
    if (this.stopped || this.refreshing || status.busy || status.signingIn || !status.signedIn) return;
    this.refreshing = true;
    try { await this.client.refresh(); await this.report(); }
    finally { this.refreshing = false; }
  }

  setAvailability(organisationId, value) { return this.client.setAvailability(organisationId, value); }

  async setDoNotDisturb(organisationId, enabled) {
    await this.client.setDoNotDisturb(organisationId, enabled);
    await this.refresh();
  }

  async connect(organisationId) {
    await this.client.connect(organisationId, this.metadata);
    await this.report();
  }

  callDirectory(deviceId, contactId, number, accountId) {
    const verified = this.client.directoryNumber(deviceId, contactId, number);
    const account = this.state.account(accountId), binding = account?.managed;
    if (!account?.isEnabled || !this.state.profile(account.profileID)?.isEnabled || !this.state.managedAccessValid(account)
      || binding?.deviceId !== verified.deviceId || binding?.organisationId !== verified.organisationId) {
      throw new Error('Choose an active calling account belonging to this customer.');
    }
    return this.state.call(verified.number, account.id);
  }

  async connectSetupLink(value) {
    await this.client.connectSetupLink(value, this.metadata);
    await this.report();
  }

  registrationReport(accounts) {
    return accounts.map(account => {
      const value = this.state.registrations[account.id];
      const expired = value?.state === 'registered' && value.since + value.expiresIn * 1000 <= Date.now();
      const state = !this.state.engineStatus.running || expired ? 'unregistered'
        : ['registered', 'unregistered', 'failed'].includes(value?.state) ? value.state : 'unknown';
      const code = state === 'failed' ? value?.code : this.registrationCodes.get(account.id);
      return { accountId: account.managed.remoteAccountId, state,
        ...(state !== 'unknown' && !expired && this.state.engineStatus.running && Number.isInteger(code) && code >= 100 && code <= 699 ? { sipCode: code } : {}) };
    });
  }

  async reportChanges() {
    try { await this.report(true); }
    catch (error) { if (error.code === 'configuration_changed') await this.refresh(); }
  }

  async report(onlyIfChanged = false) {
    const status = this.client.snapshot();
    if (this.stopped || this.reporting || this.applyError || !status.signedIn || status.signingIn || (onlyIfChanged && (status.busy || this.refreshing))) return;
    const managedAccounts = this.state.accounts.filter(a => a.managed);
    const signature = JSON.stringify({ configurations: this.client.configurations().map(c => [c.deviceId, c.revision]),
      registrations: this.registrationReport(managedAccounts), directCalls: directCallReport(managedAccounts, this.state.calls), running: this.state.engineStatus.running });
    const now = performance.now();
    if (onlyIfChanged && (signature === this.lastReportedActivity || now - (this.activityAttempt ?? -Infinity) < 5000)) return;
    this.activityAttempt = now;
    this.reporting = true;
    try {
      this.reconcile();
      const fingerprint = this.fingerprint;
      const configurations = this.client.configurations();
      await this.applying;
      // The engine only acknowledges settings actually applied; changes deferred by a live
      // call are retried by the next refresh and are not falsely shown as current in the portal.
      const result = await this.state.syncEngineAccounts();
      if (this.stopped || fingerprint !== this.fingerprint) return;
      const appliedIds = new Set(result?.appliedAccountIds ?? []);
      for (const config of configurations) {
        if (this.stopped || fingerprint !== this.fingerprint) break;
        const accounts = this.state.accounts.filter(a => a.managed?.deviceId === config.deviceId);
        const registrations = this.registrationReport(accounts);
        await this.client.report(config.deviceId, { revision: config.revision, registrations,
          directCalls: directCallReport(accounts, this.state.calls),
          applied: Boolean(result && this.state.engineStatus.running && accounts.every(a => appliedIds.has(a.id))) });
      }
      this.lastReportedActivity = signature;
    } finally { this.reporting = false; }
  }

  stop() {
    this.stopped = true;
    this.resetMessageNotifications();
    clearInterval(this.leaseTimer); clearInterval(this.refreshTimer);
    this.client.cancelSignIn();
    this.client.off('change', this.changed);
    this.state.off('messageNotificationsChanged', this.settingsChanged);
    this.state.engine.off('registration', this.registration);
    this.state.engine.off('exit', this.engineStopped);
    this.state.engine.off('networkRecovered', this.networkRecovered);
  }
}
