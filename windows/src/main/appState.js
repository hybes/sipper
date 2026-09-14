// The Windows app's model: persisted data, the SIP engine and runtime call state. A port of
// Sipper/State/AppState.swift without iCloud sync. It lives in the main process; windows get
// snapshots over IPC and call its methods. Operating-system features (notifications, the
// ringtone, the incoming-call window, the tray) listen to its events rather than being called
// from here, so this file runs under plain Node in tests.
//
// Events:
//   change (keys)                 state keys that changed; send them to the windows
//   alert ({ title, message })    something the user must read
//   showWindow                    bring the main window forward
//   navigate ({ kind, id })       select a sidebar item
//   prefillDialer ({ text })      put a number in the dialer (sip:/tel: links)
//   incomingCall ({ call, accountLabel, ring, showAlert, notify })
//   ringingEnded ({ callId, anyStillRinging })   stop the ringtone / close the alert for a call
//   missedCall (record)           post a missed-call notification
//   launchAtLoginChanged (enabled), trayVisibilityChanged (visible)

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isImportURL, parseImportURL } from '../core/importParser.js';
import { LogBuffer } from '../core/logBuffer.js';
import * as M from '../core/models.js';
import * as S from '../core/sip.js';
import { STORE_FILES } from './store.js';

export const STATE_KEYS = [
  'profiles', 'accounts', 'history', 'contacts', 'settings', 'registrations', 'voicemail', 'calls',
  'selectedCallID', 'dialerAccountID', 'pendingImport', 'engineStatus', 'audioDevices', 'codecs',
  'unseenMissedCalls', 'transferStatus',
];

const byOrder = (a, b) => a.sortOrder - b.sortOrder || Date.parse(a.createdAt) - Date.parse(b.createdAt);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const callKey = (call) => `${call.id}:${call.startedAt}`;

/** "2026-09-14 10.15.00 from Alice 2001 via Desk.wav", safe for Windows file names. */
export function recordingFileName(call, accountLabel, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  const who = call.remoteName ? `${call.remoteName} ${call.remoteNumber}` : call.remoteNumber;
  const raw = `${when} ${call.direction === 'incoming' ? 'from' : 'to'} ${who} via ${accountLabel}`;
  // eslint-disable-next-line no-control-regex
  const safe = raw.replace(/[/:\\?%*|"<>\u0000-\u001f]/g, '-').slice(0, 180).trim();
  return `${safe}.wav`;
}

export class AppState extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./store.js').JSONStore} options.store
   * @param {{ lookup(id): object, set(id, password): void, remove(id): void }} options.passwords
   * @param {import('./engineClient.js').EngineClient} options.engine
   * @param {object} [options.platform]  nullAudio, recordingsDirectory(), microphoneStatus()
   * @param {string} [options.version]
   */
  constructor({ store, passwords, engine, platform = {}, version = 'dev' }) {
    super();
    this.store = store;
    this.passwords = passwords;
    this.engine = engine;
    this.platform = {
      nullAudio: false,
      recordingsDirectory: () => path.join(os.homedir(), 'Documents', 'Sipper Recordings'),
      microphoneStatus: () => 'granted',
      ...platform,
    };
    this.defaultUserAgent = `Sipper/${version} (Windows)`;
    this.log = new LogBuffer({ mirror: process.env.SIPPER_LOG_STDERR === '1' });

    this.profiles = [];
    this.accounts = [];
    this.history = [];
    this.contacts = [];
    this.settings = M.defaultSettings('');

    this.registrations = {};
    this.voicemail = {};
    this.calls = [];
    this.selectedCallID = null;
    this.dialerAccountID = null;
    this.pendingImport = null;
    this.engineStatus = { running: false, error: null, pjsip: '' };
    this.audioDevices = [];
    this.codecs = [];
    this.unseenMissedCalls = 0;
    this.transferStatus = null;

    this.declinedCallIDs = new Set();
    this.recordIDs = new Map();
    this.endedCallKeys = [];
    this.recordingRequests = new Set();
    this.recordingOptOuts = new Set();
    this.recordingStarting = new Set();
    this.recordingPaths = new Map();
    this.timers = new Set();
    this.transferTimer = null;
    this.pendingChanges = new Set();
    this.engineStarting = null;
    this.stopping = false;
    this.engineCrashes = [];

    this.#wireEngine();
  }

  // MARK: Loading and saving

  load() {
    const decodeList = (file, decode) => {
      const raw = this.store.load(file);
      return Array.isArray(raw) ? raw.map(decode).filter(Boolean) : [];
    };
    this.profiles = decodeList(STORE_FILES.profiles, M.decodeProfile);
    this.accounts = decodeList(STORE_FILES.accounts, M.decodeAccount);
    this.history = decodeList(STORE_FILES.history, M.decodeCallRecord);
    this.contacts = decodeList(STORE_FILES.contacts, M.decodeContact);
    this.settings = M.decodeSettings(this.store.load(STORE_FILES.settings), '');

    if (this.profiles.length === 0) {
      const profile = M.makeProfile({ name: M.DEFAULT_PROFILE_NAME });
      this.profiles = [profile];
      for (const account of this.accounts) account.profileID = profile.id;
      this.#persist('profiles', 'accounts');
    } else {
      const fallback = this.profiles[0].id;
      let changed = false;
      for (const account of this.accounts) {
        if (!this.profiles.some((p) => p.id === account.profileID)) {
          account.profileID = fallback;
          changed = true;
        }
      }
      if (changed) this.#persist('accounts');
    }
    this.profiles.sort(byOrder);
    this.accounts.sort(byOrder);
    this.contacts.sort(byName);
    this.history.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    if (this.history.length > M.MAX_HISTORY) this.history = this.history.slice(0, M.MAX_HISTORY);
    for (const record of this.history) {
      if (record.endedAt === null) {
        // Left over from a crash or forced quit while a call was in progress.
        record.endedAt = record.connectedAt ?? record.startedAt;
        if (record.outcome === 'failed' && record.connectedAt) record.outcome = 'completed';
      }
    }
    this.unseenMissedCalls = 0;
    const lastUsed = this.settings.lastUsedAccountID;
    this.dialerAccountID = (lastUsed && this.accounts.find((a) => a.id === lastUsed)?.id)
      ?? this.accounts.find((a) => a.isEnabled)?.id ?? null;
    this.#changed(...STATE_KEYS);
  }

  #persist(...keys) {
    for (const key of keys) this.store.saveSoon(STORE_FILES[key], this[key]);
  }

  /** Writes everything now (used when quitting). */
  flush() {
    for (const key of Object.keys(STORE_FILES)) this.store.saveNow(STORE_FILES[key], this[key]);
  }

  // MARK: Change notification

  #changed(...keys) {
    const schedule = this.pendingChanges.size === 0;
    for (const key of keys) this.pendingChanges.add(key);
    if (!schedule) return;
    queueMicrotask(() => {
      const changed = [...this.pendingChanges];
      this.pendingChanges.clear();
      this.emit('change', changed);
    });
  }

  /** Values for the windows. Import passwords stay in the main process. */
  snapshot(keys = STATE_KEYS) {
    const out = {};
    for (const key of keys) {
      if (key === 'pendingImport') {
        out.pendingImport = this.pendingImport && {
          ...this.pendingImport,
          candidates: this.pendingImport.candidates.map(({ password, ...candidate }) => candidate),
        };
      } else {
        out[key] = this[key];
      }
    }
    return out;
  }

  #alert(title, message) {
    this.emit('alert', { title, message });
  }

  #later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  // MARK: Engine lifecycle

  #wireEngine() {
    const engine = this.engine;
    engine.on('log', (line) => this.log.append(line));
    engine.on('registration', (event) => {
      if (!this.accounts.some((a) => a.id === event.accountId)) return;
      this.registrations[event.accountId] = S.registrationFromEngine(event);
      this.#changed('registrations');
    });
    engine.on('incomingCall', (event) => this.#onIncomingCall(S.callFromEngine(event.call)));
    engine.on('callChanged', (event) => this.#onCallChanged(S.callFromEngine(event.call)));
    engine.on('callEnded', (event) => this.#onCallEnded(S.callFromEngine(event.call)));
    engine.on('voicemail', (event) => {
      if (!this.accounts.some((a) => a.id === event.accountId)) return;
      this.voicemail[event.accountId] = S.parseVoicemail(event.body);
      this.#changed('voicemail');
    });
    engine.on('transferStatus', (event) => this.#onTransferStatus(event));
    engine.on('exit', () => this.#onEngineExit());
  }

  get engineRunning() {
    return this.engineStatus.running;
  }

  startEngine() {
    if (this.engineStatus.running) return Promise.resolve();
    if (!this.engineStarting) {
      this.engineStarting = this.#startEngine().finally(() => {
        this.engineStarting = null;
      });
    }
    return this.engineStarting;
  }

  async #startEngine() {
    try {
      if (!this.engine.isAlive) {
        const pjsip = await this.engine.launch();
        this.engineStatus = { ...this.engineStatus, pjsip };
      }
      await this.engine.request('start', this.#startParams());
      this.engineStatus = { ...this.engineStatus, running: true, error: null };
      this.#changed('engineStatus');
      await Promise.all([this.refreshAudioDevices(), this.refreshCodecs()]);
      this.#syncEngineAccounts();
    } catch (error) {
      this.engineStatus = { ...this.engineStatus, running: false, error: error.message };
      for (const account of this.accounts) {
        this.registrations[account.id] = S.registration.failed(0, 'Engine not running');
      }
      this.log.append(`Sipper: starting the SIP engine failed: ${error.message}`);
      this.#changed('engineStatus', 'registrations');
    }
  }

  async restartEngine() {
    if (this.engineStarting) await this.engineStarting;
    if (this.engineStatus.running && this.engine.isAlive) {
      try {
        await this.engine.request('stop');
      } catch (error) {
        this.log.append(`Sipper: stopping the SIP engine failed: ${error.message}`);
      }
    }
    this.engineStatus = { ...this.engineStatus, running: false };
    await this.startEngine();
    if (!this.engineStatus.running) {
      this.#alert('Could not restart the SIP engine', this.engineStatus.error ?? 'The SIP engine did not start.');
    }
  }

  async shutdown() {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try {
      await this.engine.shutdown();
    } catch {
      // The process is going away either way.
    }
    this.flush();
  }

  #onEngineExit() {
    const wasRunning = this.engineStatus.running;
    this.engineStatus = { ...this.engineStatus, running: false };
    for (const call of [...this.calls]) {
      this.#onCallEnded({ ...call, state: 'disconnected', endedAt: Date.now(), lastStatusCode: 0, lastStatusText: 'Engine stopped' });
    }
    if (this.stopping) {
      this.#changed('engineStatus');
      return;
    }
    this.engineStatus.error = 'The SIP engine stopped unexpectedly.';
    for (const account of this.#activeAccounts()) {
      this.registrations[account.id] = S.registration.failed(0, 'Engine stopped');
    }
    this.log.append('Sipper: the SIP engine stopped unexpectedly');
    this.#changed('engineStatus', 'registrations');
    const now = Date.now();
    this.engineCrashes = this.engineCrashes.filter((time) => now - time < 60000);
    this.engineCrashes.push(now);
    if (wasRunning && this.engineCrashes.length <= 3) {
      this.#later(1000, () => this.startEngine());
    }
  }

  #stunServers() {
    const servers = [];
    const add = (value) => {
      const server = value.trim();
      if (server && !servers.includes(server)) servers.push(server);
    };
    add(this.settings.stunServer);
    for (const account of this.#activeAccounts()) add(account.stunServer);
    return servers;
  }

  #startParams() {
    const s = this.settings;
    return {
      userAgent: s.userAgent.trim() || this.defaultUserAgent,
      stunServers: this.#stunServers(),
      logLevel: s.sipLogLevel,
      echoMode: s.echoMode === 'off' ? 'off' : 'webrtc',
      echoTail: s.echoTailMilliseconds,
      ports: { udp: s.localUDPPort, tcp: s.localTCPPort, tls: s.localTLSPort },
      verifyTls: s.verifyTLSCertificates,
      nullAudio: Boolean(this.platform.nullAudio),
      inputDevice: s.inputDeviceName,
      outputDevice: s.outputDeviceName,
      codecs: s.codecs.map((codec) => ({ id: codec.codecID, enabled: codec.isEnabled })),
    };
  }

  /** Accounts that should be live in the engine: enabled and in an enabled profile. */
  #activeAccounts() {
    return this.accounts.filter((account) => account.isEnabled && this.profile(account.profileID)?.isEnabled);
  }

  #engineAccount(account, password) {
    return {
      id: account.id,
      aor: M.addressOfRecord(account),
      registrar: M.registrarURI(account),
      proxy: M.proxyURI(account),
      regTimeout: account.registrationExpiry,
      authUsername: M.effectiveAuthUsername(account),
      password,
      srtp: account.srtp,
      useIce: account.useICE,
      useStun: Boolean(account.stunServer.trim() || this.settings.stunServer.trim()),
    };
  }

  #syncEngineAccounts() {
    if (!this.engineStatus.running) return;
    const active = this.#activeAccounts();
    const entries = [];
    for (const account of this.accounts) {
      if (!active.includes(account)) this.registrations[account.id] = S.registration.unregistered();
    }
    for (const account of active) {
      if (!this.registrations[account.id]) this.registrations[account.id] = S.registration.registering();
      const lookup = this.passwords.lookup(account.id);
      if (lookup.status === 'found') {
        entries.push(this.#engineAccount(account, lookup.password));
      } else if (lookup.status === 'missing') {
        this.registrations[account.id] = S.registration.failed(0, 'No password stored. Edit the account to enter it.');
      } else {
        this.registrations[account.id] = S.registration.failed(0,
          `The stored password could not be read (${lookup.reason}). Edit the account and enter the password again.`);
      }
    }
    this.#changed('registrations');
    this.engine.request('syncAccounts', { accounts: entries, stunServers: this.#stunServers() })
      .catch((error) => this.log.append(`Sipper: updating accounts failed: ${error.message}`));
  }

  async refreshAudioDevices() {
    if (!this.engineStatus.running) return;
    try {
      const devices = await this.engine.request('audioDevices');
      this.audioDevices = devices.map((d) => ({
        id: d.index, name: d.name, inputChannels: d.inputs, outputChannels: d.outputs, driver: d.driver,
      }));
      this.#changed('audioDevices');
    } catch (error) {
      this.log.append(`Sipper: listing audio devices failed: ${error.message}`);
    }
  }

  async refreshCodecs() {
    if (!this.engineStatus.running) return;
    try {
      const live = await this.engine.request('codecs');
      this.codecs = live;
      this.#changed('codecs');
      if (this.settings.codecs.length === 0 && live.length > 0) {
        this.updateSettings({ codecs: M.seedCodecs(live) });
      } else if (live.length > 0) {
        const known = new Set(this.settings.codecs.map((c) => c.codecID));
        const missing = live.filter((codec) => !known.has(codec.id));
        if (missing.length > 0) {
          this.updateSettings({
            codecs: [...this.settings.codecs, ...missing.map((codec) => ({ codecID: codec.id, isEnabled: codec.priority > 0 }))],
          });
        }
      }
    } catch (error) {
      this.log.append(`Sipper: listing codecs failed: ${error.message}`);
    }
  }

  // MARK: Settings

  updateSettings(patch) {
    const old = this.settings;
    const next = M.decodeSettings({ ...old, ...patch }, '');
    this.settings = next;
    this.#persist('settings');
    this.#changed('settings');

    if (old.launchAtLogin !== next.launchAtLogin) this.emit('launchAtLoginChanged', next.launchAtLogin);
    if (old.showTrayIcon !== next.showTrayIcon) this.emit('trayVisibilityChanged', next.showTrayIcon);
    if (!this.engineStatus.running) return;

    const networkChanged = old.localUDPPort !== next.localUDPPort || old.localTCPPort !== next.localTCPPort
      || old.localTLSPort !== next.localTLSPort || old.userAgent !== next.userAgent
      || old.verifyTLSCertificates !== next.verifyTLSCertificates || old.sipLogLevel !== next.sipLogLevel
      || old.stunServer !== next.stunServer;
    if (networkChanged) {
      this.restartEngine();
      return;
    }
    const quietly = (promise) => promise.catch((error) => this.log.append(`Sipper: ${error.message}`));
    if (old.inputDeviceName !== next.inputDeviceName || old.outputDeviceName !== next.outputDeviceName) {
      quietly(this.engine.request('setAudioDevices', { input: next.inputDeviceName, output: next.outputDeviceName }));
    }
    if (JSON.stringify(old.codecs) !== JSON.stringify(next.codecs)) {
      quietly(this.engine.request('setCodecs', { codecs: next.codecs.map((c) => ({ id: c.codecID, enabled: c.isEnabled })) }));
    }
    if (old.echoMode !== next.echoMode || old.echoTailMilliseconds !== next.echoTailMilliseconds) {
      quietly(this.engine.request('setEcho', { mode: next.echoMode === 'off' ? 'off' : 'webrtc', tail: next.echoTailMilliseconds }));
    }
  }

  // MARK: Profiles

  profile(id) {
    return this.profiles.find((p) => p.id === id) ?? null;
  }

  accountsIn(profileID) {
    return this.accounts.filter((a) => a.profileID === profileID);
  }

  addProfile({ name, colorName = 'blue', iconName = 'building.2', isEnabled = true } = {}) {
    const trimmed = String(name ?? '').trim();
    const profile = M.makeProfile({
      name: trimmed || 'Profile',
      colorName,
      iconName,
      isEnabled,
      sortOrder: Math.max(-1, ...this.profiles.map((p) => p.sortOrder)) + 1,
    });
    this.profiles.push(profile);
    this.#persist('profiles');
    this.#changed('profiles');
    if (!isEnabled) this.#syncEngineAccounts();
    return profile;
  }

  updateProfile(profile) {
    const index = this.profiles.findIndex((p) => p.id === profile.id);
    if (index < 0) return;
    const wasEnabled = this.profiles[index].isEnabled;
    this.profiles[index] = { ...this.profiles[index], ...profile, name: String(profile.name ?? '').trim() || 'Profile', updatedAt: M.stamp() };
    this.#persist('profiles');
    this.#changed('profiles');
    if (wasEnabled !== this.profiles[index].isEnabled) this.#syncEngineAccounts();
  }

  setProfileEnabled(id, enabled) {
    const profile = this.profile(id);
    if (profile) this.updateProfile({ ...profile, isEnabled: enabled });
  }

  /** Deletes a profile. Its accounts move to `destination`, or are deleted when it is null or unknown. */
  deleteProfile(id, destination = null) {
    const index = this.profiles.findIndex((p) => p.id === id);
    if (this.profiles.length <= 1 || index < 0) return;
    const members = this.accountsIn(id);
    if (destination && destination !== id && this.profile(destination)) {
      for (const member of members) this.#replaceAccount({ ...member, profileID: destination });
    } else {
      for (const member of members) this.deleteAccount(member.id);
    }
    this.profiles.splice(index, 1);
    this.#persist('profiles');
    this.#changed('profiles');
    this.emit('profileDeleted', id);
    this.#syncEngineAccounts();
  }

  reorderProfiles(orderedIDs) {
    const position = new Map(orderedIDs.map((id, index) => [id, index]));
    this.profiles.sort((a, b) => (position.get(a.id) ?? 1e9) - (position.get(b.id) ?? 1e9));
    this.profiles.forEach((profile, index) => {
      if (profile.sortOrder !== index) {
        profile.sortOrder = index;
        profile.updatedAt = M.stamp();
      }
    });
    this.#persist('profiles');
    this.#changed('profiles');
  }

  // MARK: Accounts

  account(id) {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  registration(id) {
    return this.registrations[id] ?? S.registration.unregistered();
  }

  registeredAccounts() {
    return this.accounts.filter((a) => S.isRegistered(this.registration(a.id)));
  }

  duplicateAccount(username, domain, excluding = null) {
    return this.accounts.find((a) => a.id !== excluding && M.accountMatches(a, username, domain)) ?? null;
  }

  passwordFor(accountID) {
    const lookup = this.passwords.lookup(accountID);
    return lookup.status === 'found' ? lookup.password : '';
  }

  addAccount(draft, password) {
    const account = M.makeAccount({ ...draft, id: draft.id ?? M.newID() });
    if (!this.profile(account.profileID)) account.profileID = this.profiles[0].id;
    account.sortOrder = Math.max(-1, ...this.accountsIn(account.profileID).map((a) => a.sortOrder)) + 1;
    this.passwords.set(account.id, password);
    this.accounts.push(account);
    this.#persist('accounts');
    if (!this.dialerAccountID) this.dialerAccountID = account.id;
    this.#changed('accounts', 'dialerAccountID');
    this.#syncEngineAccounts();
    return account;
  }

  /** Saves an edited account; `password` null keeps the stored one. */
  updateAccount(account, password = null) {
    if (password !== null) this.passwords.set(account.id, password);
    this.#replaceAccount(account);
    this.#syncEngineAccounts();
  }

  #replaceAccount(account) {
    const index = this.accounts.findIndex((a) => a.id === account.id);
    if (index < 0) return;
    this.accounts[index] = { ...this.accounts[index], ...account, updatedAt: M.stamp() };
    this.#persist('accounts');
    this.#changed('accounts');
  }

  setAccountEnabled(id, enabled) {
    const account = this.account(id);
    if (!account) return;
    this.#replaceAccount({ ...account, isEnabled: enabled });
    this.#syncEngineAccounts();
  }

  deleteAccount(id) {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.passwords.remove(id);
    delete this.registrations[id];
    delete this.voicemail[id];
    if (this.dialerAccountID === id) this.dialerAccountID = this.accounts.find((a) => a.isEnabled)?.id ?? null;
    this.#persist('accounts');
    this.#changed('accounts', 'registrations', 'voicemail', 'dialerAccountID');
    this.emit('accountDeleted', id);
    this.#syncEngineAccounts();
  }

  reorderAccounts(profileID, orderedIDs) {
    const position = new Map(orderedIDs.map((id, index) => [id, index]));
    this.accountsIn(profileID)
      .sort((a, b) => (position.get(a.id) ?? 1e9) - (position.get(b.id) ?? 1e9))
      .forEach((account, order) => {
        if (account.sortOrder !== order) {
          account.sortOrder = order;
          account.updatedAt = M.stamp();
        }
      });
    this.accounts.sort(byOrder);
    this.#persist('accounts');
    this.#changed('accounts');
  }

  moveAccount(id, profileID) {
    const account = this.account(id);
    if (!account || !this.profile(profileID)) return;
    const sortOrder = Math.max(-1, ...this.accountsIn(profileID).map((a) => a.sortOrder)) + 1;
    this.#replaceAccount({ ...account, profileID, sortOrder });
    this.#syncEngineAccounts();
  }

  setDialerAccount(id) {
    if (id !== null && !this.account(id)) return;
    this.dialerAccountID = id;
    this.#changed('dialerAccountID');
  }

  reRegister(id) {
    this.registrations[id] = S.registration.registering();
    this.#changed('registrations');
    this.engine.request('setRegistration', { accountId: id, enabled: true })
      .catch((error) => {
        this.registrations[id] = S.registration.failed(0, error.message);
        this.#changed('registrations');
      });
  }

  reRegisterAll() {
    for (const account of this.#activeAccounts()) this.registrations[account.id] = S.registration.registering();
    this.#changed('registrations');
    this.engine.request('reRegisterAll').catch((error) => this.log.append(`Sipper: ${error.message}`));
  }

  // MARK: Calls

  get activeCall() {
    return this.calls.find((c) => c.id === this.selectedCallID) ?? this.calls[0] ?? null;
  }

  /** The account the dialer uses. */
  get dialerAccount() {
    return (this.dialerAccountID && this.account(this.dialerAccountID))
      || this.registeredAccounts()[0] || this.accounts[0] || null;
  }

  #call(callID) {
    return this.calls.find((c) => c.id === callID) ?? null;
  }

  #warnIfMicrophoneBlocked() {
    if (this.platform.microphoneStatus() === 'denied') {
      this.#alert('Microphone access needed',
        'Windows is blocking Sipper from using the microphone. Open Settings › Privacy & security › Microphone and turn on “Let desktop apps access your microphone”.');
    }
  }

  async call(target, accountID = null) {
    const trimmed = String(target ?? '').trim();
    if (!trimmed) return false;
    if (!this.engineStatus.running) {
      this.#alert('Cannot place call', this.engineStatus.error ?? 'The SIP engine is not running.');
      return false;
    }
    const account = (accountID && this.account(accountID)) || this.dialerAccount;
    if (!account) {
      this.#alert('No account', 'Add a SIP account before placing a call.');
      return false;
    }
    const registration = this.registration(account.id);
    if (!S.isRegistered(registration) && M.usesSeparateServer(account)) {
      this.#alert('Account not registered', `${M.displayLabel(account)} is not registered: ${S.registrationDetail(registration)}`);
      return false;
    }
    this.#warnIfMicrophoneBlocked();
    try {
      for (const other of this.calls) {
        if (other.state === 'confirmed' && !other.isOnHold) this.#request('setHold', { callId: other.id, hold: true });
      }
      const raw = await this.engine.request('makeCall', { accountId: account.id, uri: M.callURI(account, trimmed) });
      this.#trackCall(S.callFromEngine(raw));
      if (this.#call(raw.id)) this.selectedCallID = raw.id;
      this.dialerAccountID = account.id;
      if (this.settings.lastUsedAccountID !== account.id) this.updateSettings({ lastUsedAccountID: account.id });
      this.#changed('selectedCallID', 'dialerAccountID');
      this.emit('navigate', { kind: 'dialer' });
      return true;
    } catch (error) {
      this.#alert('Call failed', error.message);
      return false;
    }
  }

  callVoicemail(accountID = null) {
    const account = (accountID && this.account(accountID)) || this.dialerAccount;
    if (!account) return Promise.resolve(false);
    return this.call(account.voicemailNumber || '*97', account.id);
  }

  callBack(recordID) {
    const record = this.history.find((r) => r.id === recordID);
    if (!record) return Promise.resolve(false);
    return this.call(record.remoteNumber, this.account(record.accountID) ? record.accountID : null);
  }

  answer(callID) {
    if (!this.calls.some((c) => c.id === callID && c.state === 'incoming')) return;
    this.emit('ringingEnded', { callId: callID, anyStillRinging: this.calls.some((c) => c.id !== callID && c.state === 'incoming') });
    for (const other of this.calls) {
      if (other.id !== callID && other.state === 'confirmed' && !other.isOnHold) this.#request('setHold', { callId: other.id, hold: true });
    }
    this.#warnIfMicrophoneBlocked();
    this.#request('answer', { callId: callID, code: 200 });
    if (this.settings.muteMicrophoneOnAnswer) this.#request('setMuted', { callId: callID, muted: true });
    this.selectedCallID = callID;
    this.#changed('selectedCallID');
    this.emit('navigate', { kind: 'dialer' });
    this.emit('showWindow');
  }

  decline(callID) {
    if (!this.calls.some((c) => c.id === callID && c.state === 'incoming')) return;
    this.declinedCallIDs.add(callID);
    this.emit('ringingEnded', { callId: callID, anyStillRinging: this.calls.some((c) => c.id !== callID && c.state === 'incoming') });
    this.#request('hangup', { callId: callID, code: 486 });
  }

  hangup(callID) {
    this.#request('hangup', { callId: callID, code: 0 });
  }

  hangupActiveCall() {
    const call = this.activeCall;
    if (!call) return;
    if (call.state === 'incoming') this.decline(call.id);
    else this.hangup(call.id);
  }

  answerOrHangUp() {
    const call = this.activeCall;
    if (!call) return;
    if (call.state === 'incoming') this.answer(call.id);
    else this.hangup(call.id);
  }

  toggleMute(callID) {
    const call = this.#call(callID);
    if (call) this.#request('setMuted', { callId: callID, muted: !call.isMuted });
  }

  toggleHold(callID) {
    const call = this.#call(callID);
    if (call) this.#request('setHold', { callId: callID, hold: !call.isOnHold });
  }

  swapToCall(callID) {
    for (const other of this.calls) {
      if (other.id !== callID && other.state === 'confirmed' && !other.isOnHold) this.#request('setHold', { callId: other.id, hold: true });
    }
    if (this.#call(callID)?.isOnHold) this.#request('setHold', { callId: callID, hold: false });
    this.selectCall(callID);
  }

  selectCall(callID) {
    this.selectedCallID = callID;
    this.#changed('selectedCallID');
  }

  sendDTMF(digits, callID) {
    const cleaned = String(digits ?? '').replace(/[^0-9*#ABCDabcd]/g, '');
    if (cleaned) this.#request('sendDtmf', { callId: callID, digits: cleaned });
  }

  async transfer(callID, target) {
    const call = this.#call(callID);
    const account = call && this.account(call.accountID);
    if (!account) return;
    try {
      await this.engine.request('transfer', { callId: callID, uri: M.callURI(account, target) });
      this.#setTransferStatus(`Transferring to ${String(target).trim()}…`);
    } catch (error) {
      this.#alert('Transfer failed', error.message);
    }
  }

  async attendedTransfer(callID, otherCallID) {
    try {
      await this.engine.request('attendedTransfer', { callId: callID, otherCallId: otherCallID });
      this.#setTransferStatus('Completing transfer…');
    } catch (error) {
      this.#alert('Transfer failed', error.message);
    }
  }

  #setTransferStatus(text) {
    this.transferStatus = text;
    this.#changed('transferStatus');
  }

  #request(method, params) {
    this.engine.request(method, params).catch((error) => this.log.append(`Sipper: ${method} failed: ${error.message}`));
  }

  /** Adds or updates a call from the engine. Returns the stored call, or null for a call that already ended. */
  #trackCall(call, { openRecord = true } = {}) {
    const key = callKey(call);
    if (this.endedCallKeys.includes(key)) return null;
    const index = this.calls.findIndex((c) => c.id === call.id);
    const existing = index >= 0 && this.calls[index].startedAt === call.startedAt ? this.calls[index] : null;
    if (!call.remoteName) call.remoteName = existing?.remoteName || this.contactForNumber(call.remoteNumber)?.name || '';
    if (index >= 0) this.calls[index] = call;
    else this.calls.push(call);
    if (!existing && openRecord) this.#beginRecord(call);
    this.#changed('calls');
    return call;
  }

  #onIncomingCall(call) {
    if (this.settings.doNotDisturb) {
      // Rejected as busy; the record is written, as declined, when the engine reports the end.
      if (!this.#trackCall(call, { openRecord: false })) return;
      this.declinedCallIDs.add(call.id);
      this.#request('hangup', { callId: call.id, code: 486 });
      return;
    }
    const tracked = this.#trackCall(call);
    if (!tracked) return;
    if (this.selectedCallID === null) {
      this.selectedCallID = call.id;
      this.#changed('selectedCallID');
    }
    const otherCallInProgress = this.calls.some((c) => c.id !== call.id && c.state === 'confirmed');
    this.emit('incomingCall', {
      call: tracked,
      accountLabel: this.account(call.accountID) ? M.displayLabel(this.account(call.accountID)) : '',
      ring: otherCallInProgress ? null : { ringtone: this.settings.ringtone, volume: this.settings.ringVolume },
      showAlert: this.settings.showIncomingCallAlert,
      notify: this.settings.showNotifications,
    });
    const delay = this.settings.autoAnswerSeconds;
    if (delay > 0) {
      const key = callKey(call);
      this.#later(delay * 1000, () => {
        const current = this.#call(call.id);
        if (current && callKey(current) === key && current.state === 'incoming') this.answer(call.id);
      });
    }
  }

  #onCallChanged(call) {
    const tracked = this.#trackCall(call);
    if (!tracked) return;
    if (tracked.state === 'confirmed' || tracked.state === 'connecting') {
      this.emit('ringingEnded', { callId: tracked.id, anyStillRinging: this.calls.some((c) => c.state === 'incoming') });
    }
    if (this.#shouldRecord(tracked)) this.#startRecordingIfReady(tracked);
  }

  #onCallEnded(call) {
    const key = callKey(call);
    this.endedCallKeys.push(key);
    if (this.endedCallKeys.length > 100) this.endedCallKeys.shift();
    const existing = this.calls.find((c) => callKey(c) === key);
    if (!call.remoteName) call.remoteName = existing?.remoteName || this.contactForNumber(call.remoteNumber)?.name || '';
    this.calls = this.calls.filter((c) => c.id !== call.id);
    this.emit('ringingEnded', { callId: call.id, anyStillRinging: this.calls.some((c) => c.state === 'incoming') });
    this.#finishRecord(call);
    this.recordingRequests.delete(call.id);
    this.recordingOptOuts.delete(call.id);
    this.recordingPaths.delete(key);
    this.declinedCallIDs.delete(call.id);
    this.transferStatus = null;
    if (this.selectedCallID === call.id) this.selectedCallID = this.calls[0]?.id ?? null;
    this.#changed('calls', 'history', 'selectedCallID', 'transferStatus');
  }

  #onTransferStatus(event) {
    if (event.final) {
      const succeeded = Math.floor(event.code / 100) === 2;
      this.#setTransferStatus(succeeded ? 'Transfer completed' : `Transfer failed: ${event.code} ${event.text}`);
      if (succeeded) this.hangup(event.callId);
      if (this.transferTimer) clearTimeout(this.transferTimer);
      this.transferTimer = this.#later(4000, () => this.#setTransferStatus(null));
    } else {
      this.#setTransferStatus(`Transfer: ${event.code} ${event.text}`);
    }
  }

  outcome(call) {
    if (call.connectedAt) return 'completed';
    if (call.direction === 'outgoing') {
      switch (call.lastStatusCode) {
        case 486: case 600: return 'busy';
        case 480: case 408: return 'noAnswer';
        case 487: return 'cancelled';
        case 603: case 403: return 'declined';
        default: return 'failed';
      }
    }
    return this.declinedCallIDs.has(call.id) ? 'declined' : 'missed';
  }

  // MARK: History

  #beginRecord(call) {
    const record = M.makeCallRecord({
      accountID: call.accountID,
      direction: call.direction,
      outcome: 'failed',
      remoteNumber: call.remoteNumber,
      remoteName: call.remoteName,
      remoteURI: call.remoteURI,
      startedAt: new Date(call.startedAt).toISOString(),
    });
    this.recordIDs.set(callKey(call), record.id);
    this.history.unshift(record);
    this.#trimHistory();
    this.#persist('history');
    this.#changed('history');
  }

  #finishRecord(call) {
    const key = callKey(call);
    const recordID = this.recordIDs.get(key);
    this.recordIDs.delete(key);
    let record = recordID && this.history.find((r) => r.id === recordID);
    if (!record) {
      record = M.makeCallRecord({
        accountID: call.accountID, direction: call.direction, remoteNumber: call.remoteNumber,
        remoteName: call.remoteName, remoteURI: call.remoteURI, startedAt: new Date(call.startedAt).toISOString(),
      });
      this.history.unshift(record);
      this.#trimHistory();
    }
    record.outcome = this.outcome(call);
    record.connectedAt = call.connectedAt ? new Date(call.connectedAt).toISOString() : null;
    record.endedAt = new Date(call.endedAt ?? Date.now()).toISOString();
    record.statusCode = call.lastStatusCode;
    record.statusText = call.lastStatusText;
    if (!record.remoteName) record.remoteName = call.remoteName;
    const recordings = this.recordingPaths.get(key);
    if (recordings?.length) record.recordingPath = recordings[recordings.length - 1];
    this.#persist('history');
    this.#changed('history');
    if (M.recordWasMissed(record)) this.#noteMissed(record);
  }

  #trimHistory() {
    if (this.history.length > M.MAX_HISTORY) this.history.length = M.MAX_HISTORY;
  }

  #noteMissed(record) {
    this.unseenMissedCalls += 1;
    this.#changed('unseenMissedCalls');
    if (this.settings.showNotifications) this.emit('missedCall', record);
  }

  markMissedCallsSeen() {
    if (this.unseenMissedCalls === 0) return;
    this.unseenMissedCalls = 0;
    this.#changed('unseenMissedCalls');
  }

  deleteHistory(ids) {
    const doomed = new Set(ids);
    this.history = this.history.filter((r) => !doomed.has(r.id));
    this.#persist('history');
    this.#changed('history');
  }

  clearHistory() {
    this.history = [];
    this.#persist('history');
    this.#changed('history');
  }

  // MARK: Recording

  get recordingsDirectory() {
    return this.settings.recordingsFolderPath.trim() || this.platform.recordingsDirectory();
  }

  toggleRecording(callID) {
    const call = this.#call(callID);
    if (!call) return;
    if (call.isRecording) {
      this.recordingRequests.delete(callID);
      this.recordingOptOuts.add(callID);
      this.#request('stopRecording', { callId: callID });
    } else if (this.settings.recordCalls && !this.recordingOptOuts.has(callID)) {
      // Automatic recording is on and starts once the call has audio.
    } else {
      this.recordingOptOuts.delete(callID);
      this.recordingRequests.add(callID);
      this.#startRecordingIfReady(call);
    }
  }

  #shouldRecord(call) {
    if (this.recordingOptOuts.has(call.id)) return false;
    return this.settings.recordCalls || this.recordingRequests.has(call.id);
  }

  async #startRecordingIfReady(call) {
    if (call.state !== 'confirmed' || !call.hasActiveMedia || call.isRecording || this.recordingStarting.has(call.id)) return;
    this.recordingStarting.add(call.id);
    const key = callKey(call);
    try {
      const directory = this.recordingsDirectory;
      fs.mkdirSync(directory, { recursive: true });
      const accountLabel = this.account(call.accountID) ? M.displayLabel(this.account(call.accountID)) : 'unknown account';
      const file = path.join(directory, recordingFileName(call, accountLabel));
      await this.engine.request('startRecording', { callId: call.id, path: file });
      this.recordingPaths.set(key, [...(this.recordingPaths.get(key) ?? []), file]);
    } catch (error) {
      this.recordingRequests.delete(call.id);
      this.#alert('Could not start recording', error.message);
    } finally {
      this.recordingStarting.delete(call.id);
    }
  }

  /** The recording file of a history record, when it still exists. */
  recordingPath(recordID) {
    const record = this.history.find((r) => r.id === recordID);
    return record?.recordingPath && fs.existsSync(record.recordingPath) ? record.recordingPath : null;
  }

  deleteRecording(recordID) {
    const record = this.history.find((r) => r.id === recordID);
    if (!record?.recordingPath) return;
    fs.rmSync(record.recordingPath, { force: true });
    record.recordingPath = null;
    this.#persist('history');
    this.#changed('history');
  }

  // MARK: Contacts

  contact(id) {
    return this.contacts.find((c) => c.id === id) ?? null;
  }

  contactForNumber(number) {
    return this.contacts.find((c) => M.contactMatchesNumber(c, number)) ?? null;
  }

  #cleanContact(fields) {
    return {
      ...fields,
      name: String(fields.name ?? '').trim(),
      numbers: (fields.numbers ?? [])
        .map((n) => M.makeContactNumber({ ...n, number: String(n.number ?? '').trim() }))
        .filter((n) => n.number),
    };
  }

  addContact(fields) {
    const contact = M.makeContact(this.#cleanContact(fields));
    this.contacts.push(contact);
    this.contacts.sort(byName);
    this.#persist('contacts');
    this.#changed('contacts');
    return contact;
  }

  updateContact(fields) {
    const index = this.contacts.findIndex((c) => c.id === fields.id);
    if (index < 0) return;
    this.contacts[index] = { ...this.contacts[index], ...this.#cleanContact(fields), updatedAt: M.stamp() };
    this.contacts.sort(byName);
    this.#persist('contacts');
    this.#changed('contacts');
  }

  deleteContact(id) {
    this.contacts = this.contacts.filter((c) => c.id !== id);
    this.#persist('contacts');
    this.#changed('contacts');
  }

  toggleFavorite(id) {
    const contact = this.contact(id);
    if (contact) this.updateContact({ ...contact, isFavorite: !contact.isFavorite });
  }

  // MARK: Links and import

  /** Opens a sip:, sips:, tel: or sipper://add-accounts link. */
  handleURL(link) {
    const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(String(link ?? '').trim())?.[1] ?? '').toLowerCase();
    if (['sip', 'sips', 'tel'].includes(scheme)) {
      this.#prefillFromLink(String(link).trim(), scheme);
      return;
    }
    if (!isImportURL(link)) {
      this.#alert('Unsupported link', `Sipper does not know how to open ${link}.`);
      return;
    }
    try {
      const request = parseImportURL(link);
      for (const candidate of request.candidates) {
        candidate.existingAccountID = this.duplicateAccount(candidate.account.username, candidate.account.domain)?.id ?? null;
      }
      this.pendingImport = request;
      this.#changed('pendingImport');
      this.emit('showWindow');
    } catch (error) {
      this.#alert('Import failed', error.message);
    }
  }

  /** Never dials unattended: any web page can open a sip: link. Pre-fills the dialer instead. */
  #prefillFromLink(link, scheme) {
    const address = S.parseSIPAddress(link);
    const text = scheme === 'tel'
      ? address.user || link.slice(4)
      : address.user ? `${address.user}@${address.host}` : link;
    const onDomain = address.host && this.accounts.find((a) => a.domain.toLowerCase() === address.host.toLowerCase());
    if (onDomain) {
      this.dialerAccountID = onDomain.id;
      this.#changed('dialerAccountID');
    }
    this.emit('showWindow');
    this.emit('navigate', { kind: 'dialer' });
    this.emit('prefillDialer', { text });
  }

  /**
   * Adds or updates the selected candidates of the pending import. `choice` is
   * { kind: 'existing', id } or { kind: 'new', name }. Returns the number imported.
   */
  commitImport(selectedIDs, choice) {
    const request = this.pendingImport;
    if (!request) return 0;
    const selected = new Set(selectedIDs);
    let profileID;
    if (choice?.kind === 'existing') {
      profileID = this.profile(choice.id) ? choice.id : this.profiles[0].id;
    } else {
      const used = new Set(this.profiles.map((p) => p.colorName));
      profileID = this.addProfile({
        name: choice?.name || request.profileName || 'Imported',
        colorName: M.PROFILE_COLORS.find((color) => !used.has(color)) ?? 'blue',
      }).id;
    }

    let imported = 0;
    for (const candidate of request.candidates) {
      if (!selected.has(candidate.id) || candidate.validationErrors.length > 0) continue;
      try {
        const existing = candidate.existingAccountID && this.account(candidate.existingAccountID);
        const draft = candidate.account;
        if (existing) {
          this.updateAccount({
            ...existing,
            displayName: draft.displayName || existing.displayName,
            authUsername: draft.authUsername,
            server: draft.server,
            port: draft.port,
            transport: draft.transport,
            voicemailNumber: draft.voicemailNumber,
            callerIDName: draft.callerIDName,
            callerIDNumber: draft.callerIDNumber,
            notes: draft.notes || existing.notes,
            label: draft.label || existing.label,
            source: draft.source,
            isEnabled: true,
          }, candidate.password);
        } else {
          this.addAccount({ ...draft, profileID }, candidate.password);
        }
        imported += 1;
      } catch (error) {
        this.#alert('Could not save account', error.message);
      }
    }
    this.pendingImport = null;
    this.#changed('pendingImport');
    if (imported > 0) this.emit('navigate', { kind: 'profile', id: profileID });
    return imported;
  }

  cancelImport() {
    this.pendingImport = null;
    this.#changed('pendingImport');
  }

  toggleDoNotDisturb() {
    this.updateSettings({ doNotDisturb: !this.settings.doNotDisturb });
  }
}
