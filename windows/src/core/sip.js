// SIP values seen by the app: addresses, voicemail summaries, registration states and calls.
// Ported from Sipper/SIP/SIPTypes.swift. Shared by the main process and the renderer.

/** Parses SIP name-addr strings such as `"Ben" <sip:1001@pbx.example.com>;tag=abc`. */
export function parseSIPAddress(raw) {
  let displayName = '';
  let uri = String(raw ?? '').trim();

  const open = uri.indexOf('<');
  if (open >= 0) {
    displayName = uri.slice(0, open).trim();
    if (displayName.length >= 2 && displayName.startsWith('"') && displayName.endsWith('"')) {
      displayName = displayName.slice(1, -1);
    }
    displayName = displayName.replaceAll('\\"', '"');
    const afterOpen = uri.slice(open + 1);
    const close = afterOpen.indexOf('>');
    uri = close >= 0 ? afterOpen.slice(0, close) : afterOpen;
  } else {
    const semicolon = uri.indexOf(';');
    if (semicolon >= 0) uri = uri.slice(0, semicolon);
  }

  let rest = uri;
  let isTel = false;
  for (const prefix of ['sips:', 'sip:', 'tel:']) {
    if (rest.toLowerCase().startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      isTel = prefix === 'tel:';
      break;
    }
  }
  // Strip URI parameters and headers.
  const cut = rest.search(/[;?]/);
  if (cut >= 0) rest = rest.slice(0, cut);

  let user = '';
  let host = rest;
  if (isTel) {
    user = rest;
    host = '';
  } else {
    const at = rest.indexOf('@');
    if (at >= 0) {
      user = rest.slice(0, at);
      host = rest.slice(at + 1);
    }
  }
  if (host.startsWith('[') && host.includes(']')) {
    host = host.slice(1, host.indexOf(']'));
  } else if (host.split(':').length === 2) {
    host = host.slice(0, host.lastIndexOf(':'));
  }
  try {
    user = decodeURIComponent(user);
  } catch {
    // Keep a user part that is not valid percent-encoding as it is.
  }
  return { displayName, uri, user, host };
}

const wholeNumber = (text) => (/^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : 0);

/** Parses an RFC 3842 message-summary body. */
export function parseVoicemail(body) {
  const info = { hasMessages: false, newCount: 0, oldCount: 0 };
  for (const rawLine of String(body ?? '').split(/\r|\n/)) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith('messages-waiting:')) {
      info.hasMessages = lower.includes('yes');
    } else if (lower.startsWith('voice-message:')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      const counts = value.split(' ').filter(Boolean)[0] ?? '';
      const parts = counts.split('/').filter((part) => part !== '');
      if (parts.length >= 1) info.newCount = wholeNumber(parts[0]);
      if (parts.length >= 2) info.oldCount = wholeNumber(parts[1]);
    }
  }
  if (info.newCount > 0) info.hasMessages = true;
  return info;
}

// MARK: Registration

/** Seconds before expiry at which PJSIP sends the refreshing REGISTER (reg_delay_before_refresh). */
export const REFRESH_LEAD_SECONDS = 5;

export const registration = {
  unregistered: () => ({ state: 'unregistered' }),
  registering: () => ({ state: 'registering' }),
  registered: (expiresIn, since = Date.now()) => ({ state: 'registered', expiresIn, since }),
  failed: (code, reason) => ({ state: 'failed', code, reason }),
};

/** Converts an engine `registration` event into a registration state. */
export function registrationFromEngine(event, now = Date.now()) {
  switch (event.state) {
    case 'registered': return registration.registered(event.expires, now);
    case 'registering': return registration.registering();
    case 'failed': return registration.failed(event.code || 0, event.reason || '');
    default: return registration.unregistered();
  }
}

export const isRegistered = (state) => state?.state === 'registered';
export const isFailed = (state) => state?.state === 'failed';

export function registrationShortLabel(state) {
  switch (state?.state) {
    case 'registering': return 'Registering';
    case 'registered': return 'Registered';
    case 'failed': return state.code > 0 ? `Failed (${state.code})` : 'Failed';
    default: return 'Off';
  }
}

export function registrationDetail(state) {
  switch (state?.state) {
    case 'registering': return 'Registering…';
    case 'registered': return 'Registered';
    case 'failed': return state.code > 0 ? `${state.code} ${state.reason}` : state.reason;
    default: return 'Not registered';
  }
}

/** When the next re-REGISTER is due (milliseconds since the epoch), for a live countdown. */
export function nextRefresh(state) {
  if (state?.state !== 'registered') return null;
  return state.since + (state.expiresIn - REFRESH_LEAD_SECONDS) * 1000;
}

// MARK: Calls

export const CALL_STATE_NAMES = {
  calling: 'Calling',
  incoming: 'Incoming',
  early: 'Ringing',
  connecting: 'Connecting',
  confirmed: 'Connected',
  disconnected: 'Ended',
};

/** A call as the app sees it, built from the engine's call object. Times are epoch milliseconds. */
export function callFromEngine(raw) {
  const address = parseSIPAddress(raw.remote);
  return {
    id: raw.id,
    accountID: raw.accountId,
    direction: raw.direction,
    state: raw.state,
    remoteURI: address.uri || raw.remote || '',
    remoteNumber: address.user || address.host || raw.remote || '',
    remoteName: address.displayName,
    isMuted: Boolean(raw.muted),
    isOnHold: Boolean(raw.onHold),
    isRemoteHold: Boolean(raw.remoteHold),
    hasActiveMedia: Boolean(raw.activeMedia),
    isRecording: Boolean(raw.recording),
    startedAt: raw.startedAt,
    connectedAt: raw.connectedAt ?? null,
    endedAt: raw.endedAt ?? null,
    lastStatusCode: raw.lastCode ?? 0,
    lastStatusText: raw.lastText ?? '',
  };
}

export const callDisplayName = (call) => call.remoteName || call.remoteNumber;
