// Sipper's persisted records (profiles, accounts, contacts, call history, settings) and the
// rules around them, ported from the Mac app (Sipper/Models). Records are plain objects that
// serialise to the same JSON the Mac app writes. Decoders fill in defaults so files from older
// versions keep loading. Used by the main process and the renderer, so no Node imports.

export const TRANSPORTS = ['udp', 'tcp', 'tls'];
export const SRTP_MODES = ['disabled', 'optional', 'mandatory'];
export const SRTP_NAMES = { disabled: 'Off', optional: 'Optional', mandatory: 'Required' };
export const PROFILE_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'pink', 'indigo', 'gray'];
/** Profile icon names. They are the Mac app's SF Symbol names so profiles mean the same on both. */
export const PROFILE_ICONS = [
  'building.2', 'briefcase', 'house', 'phone.badge.waveform', 'network',
  'server.rack', 'person.2', 'star', 'flag', 'globe', 'wrench.and.screwdriver',
  'headphones', 'antenna.radiowaves.left.and.right', 'cloud', 'storefront',
];
export const DEFAULT_PROFILE_NAME = 'Personal';
export const CONTACT_NUMBER_LABELS = ['Work', 'Mobile', 'Home', 'Extension', 'Main', 'Other'];
export const RINGTONES = [
  { id: 'classicUK', name: 'Classic (UK)' },
  { id: 'classicUS', name: 'Classic (US)' },
  { id: 'digital', name: 'Digital' },
  { id: 'marimba', name: 'Marimba' },
  { id: 'silent', name: 'Silent' },
];
export const ECHO_MODES = [
  { id: 'software', name: 'On (WebRTC)' },
  { id: 'off', name: 'Off' },
];
export const OUTCOMES = {
  completed: 'Completed',
  missed: 'Missed',
  declined: 'Declined',
  busy: 'Busy',
  noAnswer: 'No answer',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const MAX_HISTORY = 5000;

export function newID() {
  return globalThis.crypto.randomUUID().toUpperCase();
}

/** Now as an ISO 8601 string with milliseconds, the format of every stored date. */
export function stamp(date = new Date()) {
  return date.toISOString();
}

// Decoding helpers: a value of the wrong type falls back to the default.
const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const int = (value, fallback) => (Number.isInteger(value) ? value : fallback);
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const optionalString = (value) => (typeof value === 'string' && value ? value : null);
const isoDate = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const time = Date.parse(value);
  return Number.isNaN(time) ? fallback : new Date(time).toISOString();
};
const optionalDate = (value) => isoDate(value, null);

// MARK: Transports

export function transportDefaultPort(transport) {
  return transport === 'tls' ? 5061 : 5060;
}

export function transportName(transport) {
  return String(transport).toUpperCase();
}

/** Parses user or extension supplied values such as "TLS" or " tcp ". */
export function parseTransport(value) {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase();
  return TRANSPORTS.includes(normalised) ? normalised : null;
}

// MARK: Profiles

export function makeProfile(fields = {}) {
  const createdAt = fields.createdAt ?? stamp();
  return {
    id: fields.id ?? newID(),
    name: fields.name ?? '',
    colorName: oneOf(fields.colorName, PROFILE_COLORS, 'blue'),
    iconName: fields.iconName ?? 'building.2',
    isEnabled: fields.isEnabled ?? true,
    sortOrder: fields.sortOrder ?? 0,
    createdAt,
    updatedAt: fields.updatedAt ?? createdAt,
  };
}

export function decodeProfile(raw) {
  if (!raw || typeof raw !== 'object' || !optionalString(raw.id)) return null;
  const createdAt = isoDate(raw.createdAt, stamp());
  return {
    id: raw.id,
    name: str(raw.name, 'Profile'),
    colorName: oneOf(raw.colorName, PROFILE_COLORS, 'blue'),
    iconName: str(raw.iconName, 'building.2'),
    isEnabled: bool(raw.isEnabled, true),
    sortOrder: int(raw.sortOrder, 0),
    createdAt,
    updatedAt: isoDate(raw.updatedAt, createdAt),
  };
}

// MARK: Accounts

export function makeAccount(fields = {}) {
  const createdAt = fields.createdAt ?? stamp();
  return {
    id: fields.id ?? newID(),
    profileID: fields.profileID ?? '',
    label: fields.label ?? '',
    displayName: fields.displayName ?? '',
    username: fields.username ?? '',
    authUsername: fields.authUsername ?? '',
    domain: fields.domain ?? '',
    server: fields.server ?? '',
    port: fields.port ?? null,
    transport: oneOf(fields.transport, TRANSPORTS, 'udp'),
    isEnabled: fields.isEnabled ?? true,
    registrationExpiry: fields.registrationExpiry ?? 300,
    srtp: oneOf(fields.srtp, SRTP_MODES, 'disabled'),
    stunServer: fields.stunServer ?? '',
    useICE: fields.useICE ?? false,
    voicemailNumber: fields.voicemailNumber ?? '*97',
    callerIDName: fields.callerIDName ?? '',
    callerIDNumber: fields.callerIDNumber ?? '',
    notes: fields.notes ?? '',
    sortOrder: fields.sortOrder ?? 0,
    createdAt,
    updatedAt: fields.updatedAt ?? createdAt,
    source: fields.source ?? 'manual',
  };
}

export function decodeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!optionalString(raw.id) || !optionalString(raw.profileID)) return null;
  if (typeof raw.username !== 'string' || typeof raw.domain !== 'string') return null;
  const createdAt = isoDate(raw.createdAt, stamp());
  return {
    id: raw.id,
    profileID: raw.profileID,
    label: str(raw.label),
    displayName: str(raw.displayName),
    username: raw.username,
    authUsername: str(raw.authUsername),
    domain: raw.domain,
    server: str(raw.server),
    port: int(raw.port, null),
    transport: oneOf(raw.transport, TRANSPORTS, 'udp'),
    isEnabled: bool(raw.isEnabled, true),
    registrationExpiry: int(raw.registrationExpiry, 300),
    srtp: oneOf(raw.srtp, SRTP_MODES, 'disabled'),
    stunServer: str(raw.stunServer),
    useICE: bool(raw.useICE, false),
    voicemailNumber: str(raw.voicemailNumber, '*97'),
    callerIDName: str(raw.callerIDName),
    callerIDNumber: str(raw.callerIDNumber),
    notes: str(raw.notes),
    sortOrder: int(raw.sortOrder, 0),
    createdAt,
    updatedAt: isoDate(raw.updatedAt, createdAt),
    source: str(raw.source, 'manual'),
  };
}

const sameText = (a, b) => a.toLowerCase() === b.toLowerCase();

export const effectiveAuthUsername = (account) => account.authUsername || account.username;
export const effectiveServer = (account) => account.server || account.domain;
export const effectivePort = (account) => account.port ?? transportDefaultPort(account.transport);
export const usesSeparateServer = (account) => account.server !== '' && !sameText(account.server, account.domain);
export const defaultLabel = (account) => `${account.username}@${account.domain}`;
export const displayLabel = (account) => account.label || defaultLabel(account);

/** Address of record, e.g. `"Ben" <sip:1001@pbx.example.com>`. */
export function addressOfRecord(account) {
  const uri = `sip:${account.username}@${account.domain}`;
  const name = account.displayName.trim();
  if (!name) return uri;
  return `"${name.replaceAll('"', "'")}" <${uri}>`;
}

const transportParameter = (account) => `;transport=${account.transport}`;
const bracketedHost = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

/** Registrar URI. Always the domain; the proxy carries the transport and host. */
export const registrarURI = (account) => `sip:${account.domain}${transportParameter(account)}`;

/** Outbound proxy URI (`sip:host:port;transport=tcp;lr`). */
export const proxyURI = (account) =>
  `sip:${bracketedHost(effectiveServer(account))}:${effectivePort(account)}${transportParameter(account)};lr`;

/** Removes spaces, dashes, brackets and dots from a phone number, keeping + * # and DTMF letters. */
export function normaliseDialString(raw) {
  return String(raw ?? '').replace(/[^0-9+*#ABCDabcd]/g, '');
}

/** Builds a dialable SIP URI for a number or address typed by the user. */
export function callURI(account, target) {
  const trimmed = String(target ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('sip:') || lower.startsWith('sips:')) return trimmed;
  if (trimmed.includes('@')) return `sip:${trimmed}`;
  return `sip:${normaliseDialString(trimmed)}@${account.domain}${transportParameter(account)}`;
}

/** Duplicate rule from docs/PROTOCOL.md: same username and case-insensitive domain. */
export function accountMatches(account, username, domain) {
  return account.username === username && sameText(account.domain, domain);
}

/** Validation errors for the editor and importer. */
export function accountValidationErrors(account) {
  const errors = [];
  if (!account.username.trim()) errors.push('Username is required.');
  if (!account.domain.trim()) errors.push('Domain is required.');
  if (/\s/.test(account.domain.trim())) errors.push('Domain must not contain spaces.');
  if (account.port !== null && account.port !== undefined && !(account.port >= 1 && account.port <= 65535)) {
    errors.push('Port must be between 1 and 65535.');
  }
  if (!(account.registrationExpiry >= 60 && account.registrationExpiry <= 86400)) {
    errors.push('Registration expiry must be between 60 and 86400 seconds.');
  }
  return errors;
}

// MARK: Contacts

export function makeContactNumber(fields = {}) {
  return { id: fields.id ?? newID(), label: fields.label ?? 'Work', number: fields.number ?? '' };
}

export function makeContact(fields = {}) {
  const createdAt = fields.createdAt ?? stamp();
  return {
    id: fields.id ?? newID(),
    name: fields.name ?? '',
    company: fields.company ?? '',
    numbers: (fields.numbers ?? []).map(makeContactNumber),
    preferredAccountID: fields.preferredAccountID ?? null,
    isFavorite: fields.isFavorite ?? false,
    notes: fields.notes ?? '',
    createdAt,
    updatedAt: fields.updatedAt ?? createdAt,
  };
}

export function decodeContact(raw) {
  if (!raw || typeof raw !== 'object' || !optionalString(raw.id)) return null;
  const createdAt = isoDate(raw.createdAt, stamp());
  const numbers = Array.isArray(raw.numbers) ? raw.numbers : [];
  return {
    id: raw.id,
    name: str(raw.name),
    company: str(raw.company),
    numbers: numbers
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({ id: optionalString(entry.id) ?? newID(), label: str(entry.label, 'Work'), number: str(entry.number) })),
    preferredAccountID: optionalString(raw.preferredAccountID),
    isFavorite: bool(raw.isFavorite, false),
    notes: str(raw.notes),
    createdAt,
    updatedAt: isoDate(raw.updatedAt, createdAt),
  };
}

export function contactInitials(contact) {
  return contact.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join('')
    .toUpperCase();
}

/** True when any stored number matches the dialled digits. */
export function contactMatchesNumber(contact, number) {
  const wanted = normaliseDialString(number);
  if (!wanted) return false;
  return contact.numbers.some((entry) => normaliseDialString(entry.number) === wanted);
}

// MARK: Call history

export function makeCallRecord(fields = {}) {
  return {
    id: fields.id ?? newID(),
    accountID: fields.accountID ?? '',
    direction: fields.direction ?? 'outgoing',
    outcome: fields.outcome ?? 'failed',
    remoteNumber: fields.remoteNumber ?? '',
    remoteName: fields.remoteName ?? '',
    remoteURI: fields.remoteURI ?? '',
    startedAt: fields.startedAt ?? stamp(),
    connectedAt: fields.connectedAt ?? null,
    endedAt: fields.endedAt ?? null,
    statusCode: fields.statusCode ?? 0,
    statusText: fields.statusText ?? '',
    recordingPath: fields.recordingPath ?? null,
  };
}

export function decodeCallRecord(raw) {
  if (!raw || typeof raw !== 'object' || !optionalString(raw.id) || !optionalString(raw.accountID)) return null;
  return {
    id: raw.id,
    accountID: raw.accountID,
    direction: oneOf(raw.direction, ['incoming', 'outgoing'], 'outgoing'),
    outcome: oneOf(raw.outcome, Object.keys(OUTCOMES), 'failed'),
    remoteNumber: str(raw.remoteNumber),
    remoteName: str(raw.remoteName),
    remoteURI: str(raw.remoteURI),
    startedAt: isoDate(raw.startedAt, stamp()),
    connectedAt: optionalDate(raw.connectedAt),
    endedAt: optionalDate(raw.endedAt),
    statusCode: int(raw.statusCode, 0),
    statusText: str(raw.statusText),
    recordingPath: optionalString(raw.recordingPath),
  };
}

/** Talk time in seconds (zero when the call never connected). */
export function recordDuration(record, now = Date.now()) {
  if (!record.connectedAt) return 0;
  const end = record.endedAt ? Date.parse(record.endedAt) : now;
  return Math.max(0, (end - Date.parse(record.connectedAt)) / 1000);
}

export const recordWasMissed = (record) => record.direction === 'incoming' && record.outcome === 'missed';
export const recordDisplayName = (record) => record.remoteName || record.remoteNumber;

// MARK: Settings

export function defaultSettings(userAgent = 'Sipper') {
  return {
    inputDeviceName: null,
    outputDeviceName: null,
    ringtone: 'classicUK',
    ringVolume: 0.8,
    echoMode: 'software',
    echoTailMilliseconds: 200,
    codecs: [],
    showNotifications: true,
    showIncomingCallAlert: true,
    doNotDisturb: false,
    launchAtLogin: false,
    startHidden: false,
    showTrayIcon: true,
    muteMicrophoneOnAnswer: false,
    lastUsedAccountID: null,
    recordCalls: false,
    recordingsFolderPath: '',
    autoAnswerSeconds: 0,
    stunServer: '',
    verifyTLSCertificates: true,
    localUDPPort: 0,
    localTCPPort: 0,
    localTLSPort: 0,
    userAgent,
    defaultTransport: 'udp',
    sipLogLevel: 4,
  };
}

export function decodeSettings(raw, userAgent) {
  const defaults = defaultSettings(userAgent);
  if (!raw || typeof raw !== 'object') return defaults;
  return {
    inputDeviceName: optionalString(raw.inputDeviceName),
    outputDeviceName: optionalString(raw.outputDeviceName),
    ringtone: oneOf(raw.ringtone, RINGTONES.map((r) => r.id), defaults.ringtone),
    ringVolume: Math.min(1, Math.max(0, num(raw.ringVolume, defaults.ringVolume))),
    echoMode: oneOf(raw.echoMode, ECHO_MODES.map((m) => m.id), defaults.echoMode),
    echoTailMilliseconds: int(raw.echoTailMilliseconds, defaults.echoTailMilliseconds),
    codecs: Array.isArray(raw.codecs)
      ? raw.codecs
        .filter((c) => c && typeof c.codecID === 'string')
        .map((c) => ({ codecID: c.codecID, isEnabled: bool(c.isEnabled, true) }))
      : [],
    showNotifications: bool(raw.showNotifications, defaults.showNotifications),
    showIncomingCallAlert: bool(raw.showIncomingCallAlert, defaults.showIncomingCallAlert),
    doNotDisturb: bool(raw.doNotDisturb, defaults.doNotDisturb),
    launchAtLogin: bool(raw.launchAtLogin, defaults.launchAtLogin),
    startHidden: bool(raw.startHidden, defaults.startHidden),
    showTrayIcon: bool(raw.showTrayIcon, defaults.showTrayIcon),
    muteMicrophoneOnAnswer: bool(raw.muteMicrophoneOnAnswer, defaults.muteMicrophoneOnAnswer),
    lastUsedAccountID: optionalString(raw.lastUsedAccountID),
    recordCalls: bool(raw.recordCalls, defaults.recordCalls),
    recordingsFolderPath: str(raw.recordingsFolderPath, defaults.recordingsFolderPath),
    autoAnswerSeconds: Math.min(30, Math.max(0, int(raw.autoAnswerSeconds, defaults.autoAnswerSeconds))),
    stunServer: str(raw.stunServer, defaults.stunServer),
    verifyTLSCertificates: bool(raw.verifyTLSCertificates, defaults.verifyTLSCertificates),
    localUDPPort: int(raw.localUDPPort, 0),
    localTCPPort: int(raw.localTCPPort, 0),
    localTLSPort: int(raw.localTLSPort, 0),
    userAgent: str(raw.userAgent, defaults.userAgent),
    defaultTransport: oneOf(raw.defaultTransport, TRANSPORTS, defaults.defaultTransport),
    sipLogLevel: Math.min(6, Math.max(0, int(raw.sipLogLevel, defaults.sipLogLevel))),
  };
}

// MARK: Codecs

/** Default codec order for FreeSWITCH/FusionPBX-style PBXs: wideband first, G.711 as the
 * universal fallback, everything else available but off. */
export const CODEC_PREFERRED_ORDER = [
  'opus/48000/2', 'G722/16000/1', 'PCMU/8000/1', 'PCMA/8000/1',
  'speex/16000/1', 'speex/8000/1', 'iLBC/8000/1', 'GSM/8000/1',
  'speex/32000/1', 'G7221/16000/1', 'G7221/32000/1',
];
export const CODECS_ENABLED_BY_DEFAULT = new Set(['opus/48000/2', 'G722/16000/1', 'PCMU/8000/1', 'PCMA/8000/1']);

/** Codec preferences for a first launch, from the engine's codec list. */
export function seedCodecs(codecs) {
  const rank = new Map(CODEC_PREFERRED_ORDER.map((id, index) => [id, index]));
  return [...codecs]
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((codec) => ({ codecID: codec.id, isEnabled: CODECS_ENABLED_BY_DEFAULT.has(codec.id) }));
}

/** "opus 48 kHz stereo", "PCMU 8 kHz". */
export function codecDisplayName(id) {
  const parts = id.split('/');
  if (parts.length < 2) return id;
  const whole = (text) => (/^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : null);
  const rate = Math.trunc((whole(parts[1]) ?? 0) / 1000);
  const channels = parts.length > 2 ? whole(parts[2]) ?? 1 : 1;
  return `${parts[0]} ${rate} kHz${channels > 1 ? ' stereo' : ''}`;
}
