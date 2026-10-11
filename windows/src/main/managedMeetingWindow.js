import { randomUUID } from 'node:crypto';
import { ManagedError } from './managedClient.js';
import { meetingCSP, meetingOrigin } from './managedMeetings.js';

// One media window per installation; changing the customer never transfers its grant.
export class ManagedMeetingWindows {
  constructor({ client, state, createWindow, pageURL }) {
    this.client = client; this.state = state; this.createWindow = createWindow; this.pageURL = pageURL; this.entry = null;
    this.cleanup = Promise.resolve();
    this.changed = () => { if (this.entry && !this.authorised(this.entry)) this.close(); };
    client.on('change', this.changed);
  }
  authorised(entry) {
    const status = this.client.snapshot();
    return this.entry === entry && !entry.win.isDestroyed() && status.signedIn && !status.signingIn
      && status.identity?.id === entry.userId && status.enrollments.some(e => e.deviceId === entry.deviceId && e.organisationId === entry.organisationId)
      && status.organisations.some(o => o.id === entry.organisationId && o.status === 'active' && o.licensed);
  }
  owns(win) { return Boolean(this.entry && this.entry.win === win && !win.isDestroyed()); }
  owned(win) {
    if (!this.owns(win) || !this.authorised(this.entry)) throw new ManagedError('access_denied', 'This meeting window is unavailable.');
    return this.entry;
  }
  canCapture(win) {
    if (!this.owns(win) || !this.authorised(this.entry)) return false;
    const e = this.entry;
    return Boolean(this.state.ownsMeetingAudio(e.reference) && e.grant && e.mediaConnected && e.details?.canJoin && Date.parse(e.details.expiresAt) > Date.now()
      && Date.parse(e.details.meeting.expiresAt) > Date.now() && !e.details.meeting.endedAt);
  }
  policy(reference) {
    const e = this.entry;
    return meetingCSP(e?.reference === reference && e.grant && this.state.ownsMeetingAudio(e.reference) && this.authorised(e)
      ? meetingOrigin(e.grant.url, this.client.allowLocalDevelopment) : null);
  }
  async withdraw(entry, sessionId = entry.sessionId) {
    try { await this.client.leaveMeeting(entry.deviceId, entry.meetingId, sessionId); return true; }
    catch { return false; } // Local media/window disposal never depends on this acknowledgement.
  }
  async open(deviceId, meetingId) {
    if (this.entry) {
      if (this.entry.deviceId !== deviceId || this.entry.meetingId !== meetingId) throw new ManagedError('meeting_active', 'Leave the open meeting before joining another.');
      this.entry.win.show(); this.entry.win.focus(); return { opened: true };
    }
    const status = this.client.snapshot(), binding = status.enrollments.find(e => e.deviceId === deviceId);
    if (!status.identity || !binding) throw new ManagedError('access_denied', 'Connect this customer before joining a meeting.');
    const entry = { deviceId, meetingId, organisationId: binding.organisationId, userId: status.identity.id,
      reference: randomUUID(), sessionId: randomUUID(), epoch: 0, captureEpoch: 0, mediaConnected: false, ready: false, preparing: false, grant: null, details: null, error: null, screen: null };
    entry.win = this.createWindow(entry);
    const destroyed = new Promise(resolve => {
      if (entry.win.webContents.isDestroyed()) resolve();
      else entry.win.webContents.once('destroyed', resolve);
    });
    this.entry = entry;
    entry.win.on('closed', () => {
      entry.epoch++; this.cancelScreen(entry); entry.grant = null;
      if (this.entry === entry) this.entry = null;
      this.cleanup = destroyed.then(() => this.state.releaseMeetingAudio(entry.reference, { restore: entry.restorePhone !== false }));
      this.cleanup.catch(() => {});
      void this.withdraw(entry);
    });
    entry.win.webContents.on('render-process-gone', () => { if (this.entry === entry) this.close(); });
    if (!this.authorised(entry)) { this.close(); throw new ManagedError('access_denied', 'This customer is unavailable.'); }
    entry.win.show();
    await entry.win.loadURL(`${this.pageURL}?room=${entry.reference}&loading=1`).catch(() => { if (this.entry === entry) this.close(); });
    await this.prepare(entry);
    return { opened: this.entry === entry };
  }
  async prepare(entry) {
    if (!this.authorised(entry) || entry.preparing) return;
    entry.preparing = true; entry.mediaConnected = false;
    const version = ++entry.epoch, nonce = entry.sessionId;
    const current = () => this.authorised(entry) && entry.epoch === version;
    try {
      let details = await this.client.meetingDetails(entry.deviceId, entry.meetingId);
      if (!current()) return;
      entry.details = details; entry.error = null;
      if (details.canJoin) {
        await this.cleanup.catch(() => {});
        if (this.state.meetingAudio && this.state.meetingAudio.reference !== entry.reference)
          await this.state.releaseMeetingAudio(this.state.meetingAudio.reference);
        try { await this.state.claimMeetingAudio(entry.reference); }
        catch { throw new ManagedError('phone_audio_unavailable', 'Could not switch from your phone call. Check its hold status and try joining again.'); }
        if (!current()) { await this.state.releaseMeetingAudio(entry.reference, { restore: entry.restorePhone !== false }); return; }
        if (Date.parse(details.expiresAt) <= Date.now()) details = await this.client.meetingDetails(entry.deviceId, entry.meetingId);
        if (!current() || !details.canJoin) throw new ManagedError('cancelled', 'Meeting access changed while switching audio.');
        const grant = await this.client.joinMeeting(entry.deviceId, entry.meetingId, nonce);
        if (!current()) { await this.withdraw(entry, nonce); return; }
        if (Date.parse(details.expiresAt) <= Date.now()) details = await this.client.meetingDetails(entry.deviceId, entry.meetingId);
        if (!current() || !details.canJoin || Date.parse(details.expiresAt) <= Date.now()) throw new ManagedError('cancelled', 'Refresh meeting access and join again.');
        entry.details = details;
        entry.grant = grant;
      }
    } catch (error) {
      if (!current()) { await this.withdraw(entry, nonce); return; }
      await this.state.releaseMeetingAudio(entry.reference).catch(() => {});
      entry.error = { code: error.code ?? 'unavailable', message: error.code ? error.message : 'Could not prepare the meeting. Try again.' };
      if (['access_denied', 'sign_in_required', 'cancelled'].includes(error.code)) { this.close(); return; }
      if (error.code !== 'unavailable') { await this.withdraw(entry, nonce); entry.sessionId = randomUUID(); }
    } finally {
      if (current()) {
        entry.preparing = false; entry.ready = true;
        await entry.win.loadURL(`${this.pageURL}?room=${entry.reference}`).catch(() => { if (this.entry === entry) this.close(); });
      }
    }
  }
  initial(win) {
    const e = this.owned(win);
    // A delayed IPC request from the loading document must never receive the later grant.
    if (new URL(win.webContents.getURL()).searchParams.has('loading')) return { pending: true, details: null, grant: null, error: null };
    if (e.grant && (!this.state.ownsMeetingAudio(e.reference) || Date.parse(e.details?.expiresAt) <= Date.now())) {
      void this.state.releaseMeetingAudio(e.reference).catch(() => {});
      return { pending: false, details: e.details, grant: null, error: { code: 'meeting_changed', message: 'Refresh meeting access and join again.' } };
    }
    return structuredClone({ pending: !e.ready, details: e.details, grant: e.grant, error: e.error,
      returnPhone: Boolean(this.state.meetingAudio?.restore) });
  }
  async retry(win) {
    const e = this.owned(win);
    if (e.preparing || e.retrying) return;
    e.retrying = true; e.epoch++; e.mediaConnected = false; e.captureEpoch++; this.cancelScreen(e);
    try {
      await this.state.releaseMeetingAudio(e.reference);
      if (e.grant || e.retired) { e.grant = null; await this.withdraw(e); if (!this.authorised(e)) return; e.sessionId = randomUUID(); e.retired = false; }
      await this.prepare(e);
    } finally { e.retrying = false; }
  }
  async details(win) {
    const e = this.owned(win), version = e.epoch;
    try {
      const value = await this.client.meetingDetails(e.deviceId, e.meetingId);
      if (this.owned(win) !== e || e.epoch !== version) throw new ManagedError('cancelled', 'The meeting changed.');
      e.details = value;
      return value;
    } catch (error) {
      if (this.entry === e && ['access_denied', 'sign_in_required', 'cancelled'].includes(error.code)) this.close();
      throw error;
    }
  }
  mediaState(win, connected) {
    if (typeof connected !== 'boolean') throw new ManagedError('invalid_meeting_input', 'Invalid media state.');
    const e = this.owned(win);
    if (e.mediaConnected !== connected) e.captureEpoch++;
    e.mediaConnected = connected;
    if (!connected) this.cancelScreen(e);
  }
  async retire(win) {
    const e = this.owned(win);
    e.mediaConnected = false; e.captureEpoch++; e.grant = null; e.retired = true; this.cancelScreen(e);
    const withdrawn = this.withdraw(e);
    await this.state.releaseMeetingAudio(e.reference);
    return withdrawn;
  }
  async end(win) {
    const e = this.owned(win), value = await this.client.endMeeting(e.deviceId, e.meetingId);
    if (this.entry === e && e.details) { e.details = { ...e.details, canJoin: false, meeting: value.meeting }; this.cancelScreen(e); }
    return value;
  }
  remove(win, userId) {
    const e = this.owned(win);
    return this.client.removeMeetingPerson(e.deviceId, e.meetingId, userId);
  }
  cancelScreen(entry = this.entry) {
    if (!entry?.screen) return;
    const pending = entry.screen; entry.screen = null;
    try { pending.callback({}); } catch { /* The requesting frame may have been destroyed. */ }
  }
  chooseScreen(win, requestId, sourceId, audio) {
    const e = this.owned(win), pending = e.screen;
    if (!pending || pending.id !== requestId || typeof audio !== 'boolean') throw new ManagedError('cancelled', 'Screen selection has expired.');
    const source = pending.sources.find(source => source.id === sourceId);
    if (sourceId == null) { this.cancelScreen(e); return; }
    if (!source || !this.canCapture(win)) { this.cancelScreen(e); throw new ManagedError('cancelled', 'Screen selection has expired.'); }
    e.screen = null;
    try { pending.callback({ video: source, ...(audio && pending.audio ? { audio: 'loopback' } : {}) }); }
    catch { /* No capture survives a destroyed frame. */ }
  }
  close(win = this.entry?.win) { if (this.owns(win)) win.destroy(); }
  async closeForPhone() {
    if (this.entry) this.entry.restorePhone = false;
    this.close();
    await this.cleanup.catch(() => {});
    if (this.state.meetingAudio) await this.state.releaseMeetingAudio(this.state.meetingAudio.reference, { restore: false });
  }
  async stop() {
    this.client.off('change', this.changed); const entry = this.entry;
    if (entry) entry.restorePhone = false;
    this.close(); await this.cleanup;
    return entry ? this.withdraw(entry) : true;
  }
}
