// The dialer, the active call screen and the call banner shown on other pages.

import { timeOfDay } from '../../core/format.js';
import { displayLabel, recordDisplayName } from '../../core/models.js';
import { callDisplayName, registrationDetail, registrationShortLabel } from '../../core/sip.js';
import {
  Button, CallControl, CallStatusText, cx, EmptyState, Icon, IconButton, Keypad, PageHeader, Select,
} from '../components.js';
import { html, useEffect, useRef, useState } from '../lib.js';
import {
  accountByID, accountIsLive, accountsIn, act, activeCall, dialerAccount, registrationOf, useAppState,
} from '../store.js';
import { useUI } from '../ui.js';
import { recordIcon, recordTone } from './actions.js';

export function DialerPage() {
  const state = useAppState();
  const ui = useUI();
  const call = activeCall(state);
  let body;
  if (call && !state.showingNewCall) {
    body = html`<${ActiveCall} key=${`${call.id}:${call.startedAt}`} call=${call} />`;
  } else if (state.accounts.length === 0) {
    body = html`<${EmptyState} icon="call" title="No SIP accounts"
      description="Add an account by hand, or open an extension in FusionPBX and use the Sipper browser extension to import it.">
      <${Button} kind="accent" onClick=${() => ui.openDialog({ kind: 'addAccount', profileID: null })}>Add account…</${Button}>
    </${EmptyState}>`;
  } else {
    body = html`<${IdleDialer} />`;
  }
  return html`<div class="page">
    <${PageHeader} title="Dialer">
      <${Button} icon="personAdd" onClick=${() => ui.openDialog({ kind: 'addAccount', profileID: null })}>Add account</${Button}>
    </${PageHeader}>
    <div class="page-body scroll">${body}</div>
  </div>`;
}

function IdleDialer() {
  const state = useAppState();
  const ui = useUI();
  const input = useRef(null);
  const clearTimer = useRef(null);
  const cleared = useRef(false);
  const account = dialerAccount(state);
  const call = activeCall(state);
  const status = account ? registrationOf(state, account.id) : null;
  const recent = state.history.slice(0, 5);

  useEffect(() => {
    input.current?.focus();
  }, [ui.focusDialerToken]);

  const place = async () => {
    if (!ui.dialString.trim()) return;
    if (await act('call', ui.dialString, account?.id ?? null)) ui.setDialString('');
  };

  const groups = state.profiles
    .map((profile) => ({
      label: profile.name,
      options: accountsIn(state, profile.id).map((a) => ({
        value: a.id,
        label: `${displayLabel(a)} — ${accountIsLive(state, a) ? registrationShortLabel(registrationOf(state, a.id)) : 'Disabled'}`,
      })),
    }))
    .filter((group) => group.options.length > 0);

  return html`<div class="dialer" onKeyDown=${(event) => {
    if (call && event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      act('selectCall', call.id);
    }
  }}>
    ${call ? html`<div class="new-call-return">
      <${Button} onClick=${() => act('selectCall', call.id)} title="Return to the current call (Escape)">Return to ${callDisplayName(call)}</${Button}>
      <p class="caption">Your current call will be held when you place another.</p>
    </div>` : null}
    <div class="dialer-from">
      <label class="caption" for="dialer-account">From</label>
      <${Select} id="dialer-account" value=${account?.id} groups=${groups} onChange=${(id) => act('setDialerAccount', id)} />
      ${status ? html`<span class=${cx('caption', `status-text-${status.state}`)} title=${registrationDetail(status)}>${registrationShortLabel(status)}</span>` : null}
    </div>

    <div class="dialer-number">
      <input ref=${input} class="dialer-number-input selectable" value=${ui.dialString} placeholder=${account?.managed?.mode === 'gateway' ? 'Phone number or extension' : 'Number or SIP address'}
        aria-label="Number to call" spellcheck=${false}
        onInput=${(event) => ui.setDialString(event.currentTarget.value)}
        onKeyDown=${(event) => {
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            place();
          }
        }} />
      ${ui.dialString ? html`<${IconButton} icon="backspace" label="Delete the last character (hold to clear)"
        onPointerDown=${() => {
          cleared.current = false;
          clearTimer.current = setTimeout(() => {
            cleared.current = true;
            ui.setDialString('');
          }, 600);
        }}
        onPointerUp=${() => clearTimeout(clearTimer.current)}
        onPointerLeave=${() => clearTimeout(clearTimer.current)}
        onClick=${() => {
          if (!cleared.current) ui.setDialString((text) => text.slice(0, -1));
          cleared.current = false;
          input.current?.focus();
        }} />` : null}
    </div>

    <${Keypad}
      onKey=${(digit) => {
        ui.setDialString((text) => text + digit);
        input.current?.focus();
      }}
      onLongPressZero=${() => ui.setDialString((text) => `${text}+`)} />

    <div class="dialer-actions">
      <${Button} size="large" icon="voicemail" title=${`Call voicemail (${account?.voicemailNumber || '*97'})`}
        onClick=${() => act('callVoicemail', account?.id ?? null)}>Voicemail</${Button}>
      <${Button} size="large" kind="success" icon="call" disabled=${!ui.dialString.trim()} onClick=${place}>Call</${Button}>
    </div>
    ${state.meetingActive ? html`<p class="caption" role="status">Calling will leave your meeting.</p>` : null}

    ${recent.length > 0 ? html`<section class="recent" aria-label="Recent calls">
      <div class="recent-header">
        <span class="caption">Recent</span>
        <button type="button" class="link-button" onClick=${() => ui.navigate({ kind: 'history' })}>Show all</button>
      </div>
      ${recent.map((record) => html`<button type="button" key=${record.id} class="recent-row" title=${`Call ${record.remoteNumber} again`}
        onClick=${() => act('callBack', record.id)}>
        <${Icon} name=${recordIcon(record)} className=${recordTone(record)} />
        <span class="recent-name">${recordDisplayName(record)}</span>
        <span class="caption tabular">${timeOfDay(new Date(record.startedAt))}</span>
      </button>`)}
    </section>` : null}
  </div>`;
}

function ActiveCall({ call }) {
  const state = useAppState();
  const [showKeypad, setShowKeypad] = useState(false);
  const [keypadCall, setKeypadCall] = useState(null);
  const [digitsSent, setDigitsSent] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [target, setTarget] = useState('');
  const account = accountByID(state, call.accountID);
  const members = call.conferenceID ? state.calls.filter(other => other.conferenceID === call.conferenceID) : [];
  const conferencing = members.length === 2;
  const onHold = conferencing ? members.some(member => member.isOnHold) : call.isOnHold;
  const others = state.calls.filter((other, index, calls) => other.id !== call.id &&
    (!call.conferenceID || other.conferenceID !== call.conferenceID) &&
    (!other.conferenceID || calls.findIndex(c => c.conferenceID === other.conferenceID) === index));
  const connected = call.state === 'confirmed';

  const sendDigits = (digits) => {
    if (conferencing && !keypadCall) return;
    act('sendDTMF', digits, keypadCall || call);
    setDigitsSent((sent) => sent + digits);
  };

  useEffect(() => {
    if (!connected) return undefined;
    const onKey = (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target.closest?.('input, textarea, select, [role="dialog"]')) return;
      if (/^[0-9*#]$/.test(event.key)) {
        event.preventDefault();
        sendDigits(event.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connected, call.id, call.startedAt, call.conferenceID, keypadCall]);

  useEffect(() => {
    if (onHold) { setShowKeypad(false); setKeypadCall(null); }
    if (keypadCall && !state.calls.some(c => c.id === keypadCall.id && c.startedAt === keypadCall.startedAt &&
        c.accountID === keypadCall.accountID && c.conferenceID === keypadCall.conferenceID)) {
      setKeypadCall(null); setShowKeypad(false); setDigitsSent('');
    }
    if (conferencing) setTransferOpen(false);
  }, [state.calls, conferencing, keypadCall, onHold]);

  const transferInput = useRef(null);
  useEffect(() => {
    if (!connected) setTransferOpen(false);
  }, [connected]);
  useEffect(() => {
    if (transferOpen) transferInput.current?.focus();
  }, [transferOpen]);

  const blindTransfer = () => {
    const destination = target.trim();
    if (!destination) return;
    act('transfer', call, destination);
    setTarget('');
    setTransferOpen(false);
  };
  const connectedOthers = others.filter((other) => other.state === 'confirmed' && other.accountID === call.accountID && !other.isTransferring && !other.conferenceID);

  return html`<div class="active-call">
    ${state.meetingActive ? html`<p class="caption" role="status">Answering or resuming a phone call will leave your meeting.</p>` : null}
    <div class="active-call-header">
      ${!conferencing ? html`<span class=${cx('active-call-icon', connected && 'connected')}>
        <${Icon} name=${call.direction === 'incoming' ? 'callIncomingFilled' : 'callOutgoingFilled'} size=${28} />
      </span>` : null}
      <h2 class="active-call-name selectable">${conferencing ? 'Conference' : callDisplayName(call)}</h2>
      ${!conferencing && call.remoteName ? html`<p class="active-call-number selectable">${call.remoteNumber}</p>` : null}
      <p class="active-call-status" aria-live="polite">${conferencing
        ? members.every(c => c.isOnHold) ? 'On hold' : onHold ? 'One participant on hold' : 'Connected'
        : html`<${CallStatusText} call=${call} />`}</p>
      ${account ? html`<p class="caption">via ${displayLabel(account)}</p>` : null}
      ${call.isRecording ? html`<p class="recording-badge"><${Icon} name="record" size=${12} />Recording</p>` : null}
      ${digitsSent ? html`<p class="dtmf-history mono" aria-label=${`Digits sent: ${digitsSent}`}>${digitsSent}</p>` : null}
    </div>

    ${conferencing ? html`<section class="conference-participants" aria-label="Conference participants">
      ${members.map(member => html`<div class="conference-participant" key=${`${member.id}:${member.startedAt}`}>
        <div class="other-call-text"><strong class="selectable">${callDisplayName(member)}</strong>
          <span class="caption"><${CallStatusText} call=${member} />${member.isRecording ? ' · Recording' : ''}</span>
        </div>
        <div class="conference-participant-actions">
          <${Button} disabled=${state.changingAudio || member.isOnHold} onClick=${() => {
            setKeypadCall(member); setDigitsSent(''); setShowKeypad(true);
          }}>Keypad</${Button}>
          <${Button} disabled=${state.changingAudio} title=${`Talk to ${callDisplayName(member)} separately; hold the other participant`}
            onClick=${() => act('separateConference', member)}>Separate</${Button}>
          <${IconButton} kind="danger" icon="callEnd" label=${`Remove ${callDisplayName(member)} from the conference`}
            onClick=${() => act('hangup', member)} />
        </div>
      </div>`)}
    </section>` : null}

    ${call.state === 'incoming' ? html`<div class="call-answer-row">
      <${Button} size="large" kind="danger" icon="callEnd" title="Decline (Ctrl+Shift+D)" onClick=${() => act('decline', call.id)}>Decline</${Button}>
      <${Button} size="large" kind="success" icon="call" title="Answer (Ctrl+Enter)" onClick=${() => act('answer', call.id)}>${state.meetingActive ? 'Switch & answer' : 'Answer'}</${Button}>
    </div>` : html`
      ${showKeypad ? html`${conferencing && keypadCall ? html`<div class="conference-participant-actions">
        <p class="caption">Keypad for ${callDisplayName(keypadCall)}</p>
        <${Button} onClick=${() => { setShowKeypad(false); setKeypadCall(null); }}>Close keypad</${Button}>
      </div>` : null}
        <${Keypad} compact onKey=${sendDigits} />` : null}
      <div class="call-controls">
        <${CallControl} icon=${call.isMuted ? 'micOff' : 'mic'} label=${call.isMuted ? 'Unmute' : 'Mute'} shortcut="Ctrl+Shift+M"
          active=${call.isMuted} disabled=${!connected} onClick=${() => act('toggleMute', call)} />
        <${CallControl} icon=${onHold ? 'play' : 'pause'} label=${onHold ? 'Resume' : 'Hold'} shortcut="Ctrl+Shift+H"
          active=${onHold} disabled=${!connected || state.changingAudio} onClick=${() => act('toggleHold', call)} />
        ${!conferencing ? html`<${CallControl} icon="keypad" label="Keypad" active=${showKeypad} disabled=${!connected} onClick=${() => setShowKeypad((open) => !open)} />
          <${CallControl} icon="transfer" label="Transfer" active=${transferOpen} disabled=${!connected || call.isTransferring || state.changingAudio} onClick=${() => setTransferOpen((open) => !open)} />` : null}
        <${CallControl} icon=${call.isRecording ? 'recordStop' : 'record'} label=${call.isRecording ? 'Stop' : 'Record'} tone="recording"
          active=${call.isRecording} disabled=${!connected} onClick=${() => act('toggleRecording', call)} />
      </div>
      ${!conferencing && !call.isTransferring && connectedOthers.length > 0 ? html`<div class="conference-merge-actions">
        ${connectedOthers.map(other => html`<${Button} key=${`${other.id}:${other.startedAt}`} disabled=${state.changingAudio}
          onClick=${() => act('mergeConference', call, other)}>Merge with ${callDisplayName(other)}</${Button}>`)}
      </div>` : null}
      ${transferOpen ? html`<div class="transfer-panel card">
        <label class="field">
          <span class="field-label">Transfer to</span>
          <span class="inline-form">
            <input class="text-field" ref=${transferInput} value=${target} placeholder=${account?.managed?.mode === 'gateway' ? 'Phone number or extension' : 'Number or SIP address'} spellcheck=${false}
              onInput=${(event) => setTarget(event.currentTarget.value)}
              onKeyDown=${(event) => {
                if (event.key === 'Enter') blindTransfer();
                if (event.key === 'Escape') setTransferOpen(false);
              }} />
            <${Button} kind="accent" disabled=${!connected || call.isTransferring || state.changingAudio || !target.trim()} onClick=${blindTransfer}>Transfer</${Button}>
          </span>
        </label>
        ${connectedOthers.length > 0 ? html`<p class="caption">Or connect this caller with another call</p>
          ${connectedOthers.map((other) => html`<${Button} key=${other.id} disabled=${!connected || call.isTransferring || state.changingAudio} onClick=${() => {
            act('attendedTransfer', call, other);
            setTransferOpen(false);
          }}>Connect with ${callDisplayName(other)}</${Button}>`)}` : null}
      </div>` : null}
      <div class=${connected ? 'call-answer-row' : ''}>
      ${connected ? html`<${Button} size="large" icon="call" disabled=${call.isTransferring || state.changingAudio} title="Add call (Ctrl+N)" onClick=${() => act('prepareNewCall', '', call.accountID)}>Add call</${Button}>` : null}
      <${Button} size="large" kind="danger" icon="callEnd" block title="Hang up (Ctrl+Enter)" onClick=${() => act(conferencing ? 'endConference' : 'hangup', call)}>
        ${conferencing ? 'End conference' : connected ? 'Hang up' : 'Cancel'}
      </${Button}>
      </div>`}

    ${call.transferStatus ? html`<p class="caption transfer-status" aria-live="polite">${call.transferStatus}</p>` : null}

    ${others.length > 0 ? html`<section class="other-calls" aria-label="Other calls">
      <h3 class="caption">Other calls</h3>
      ${others.map((other) => html`<div key=${other.id} class="other-call card">
        <${Icon} name=${other.state === 'incoming' ? 'callIncoming' : 'pause'} className=${other.state === 'incoming' ? 'success-text' : 'secondary'} />
        <div class="other-call-text">
          <span class="ellipsis">${other.conferenceID ? 'Conference' : callDisplayName(other)}</span>
          <span class="caption"><${CallStatusText} call=${other} /></span>
        </div>
        ${other.state === 'incoming' ? html`
          <${Button} kind="success" onClick=${() => act('answer', other.id)}>Answer</${Button}>
          <${Button} onClick=${() => act('decline', other.id)}>Decline</${Button}>` : html`
          <${Button} disabled=${state.changingAudio} onClick=${() => act('swapToCall', other)}>Swap</${Button}>
          <${IconButton} kind="danger" icon="callEnd" label=${other.conferenceID ? 'End this conference' : 'Hang up this call'}
            onClick=${() => act(other.conferenceID ? 'endConference' : 'hangup', other)} />`}
      </div>`)}
    </section>` : null}
  </div>`;
}

/** Compact strip above non-dialer pages while a call is active. */
export function CallBanner() {
  const state = useAppState();
  const ui = useUI();
  const call = activeCall(state);
  if (!call) return null;
  const connected = call.state === 'confirmed';
  return html`<div class="call-banner" role="region" aria-label="Current call">
    <${Icon} name=${call.state === 'incoming' ? 'callIncomingFilled' : 'call'} className=${call.state === 'incoming' ? 'success-text' : 'accent-text'} />
    <div class="call-banner-text">
      <strong class="ellipsis">${call.conferenceID ? 'Conference' : callDisplayName(call)}</strong>
      <span class="caption"><${CallStatusText} call=${call} />${call.isRecording ? ' · Recording' : ''}</span>
    </div>
    ${state.calls.length > 1 ? html`<span class="caption">${state.calls.length} calls</span>` : null}
    ${call.state === 'incoming' ? html`
      <${Button} kind="success" onClick=${() => act('answer', call.id)}>${state.meetingActive ? 'Switch & answer' : 'Answer'}</${Button}>
      <${Button} kind="danger" onClick=${() => act('decline', call.id)}>Decline</${Button}>` : html`
      <${IconButton} kind="standard" icon=${call.isMuted ? 'micOff' : 'mic'} label=${call.isMuted ? 'Unmute' : 'Mute'}
        active=${call.isMuted} disabled=${!connected} onClick=${() => act('toggleMute', call)} />
      <${IconButton} kind="standard" icon=${call.isOnHold ? 'play' : 'pause'} label=${call.isOnHold ? 'Resume' : 'Hold'}
        active=${call.isOnHold} disabled=${!connected || state.changingAudio} onClick=${() => act('toggleHold', call)} />
      <${IconButton} kind="danger" icon="callEnd" label=${call.conferenceID ? 'End conference' : 'Hang up'}
        onClick=${() => act(call.conferenceID ? 'endConference' : 'hangup', call)} />`}
    <${Button} onClick=${() => { act('selectCall', call.id); ui.navigate({ kind: 'dialer' }); }}>Show</${Button}>
  </div>`;
}
