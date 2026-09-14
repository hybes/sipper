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
  if (call) {
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

  return html`<div class="dialer">
    <div class="dialer-from">
      <label class="caption" for="dialer-account">From</label>
      <${Select} id="dialer-account" value=${account?.id} groups=${groups} onChange=${(id) => act('setDialerAccount', id)} />
      ${status ? html`<span class=${cx('caption', `status-text-${status.state}`)} title=${registrationDetail(status)}>${registrationShortLabel(status)}</span>` : null}
    </div>

    <div class="dialer-number">
      <input ref=${input} class="dialer-number-input selectable" value=${ui.dialString} placeholder="Number or SIP address"
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
  const [digitsSent, setDigitsSent] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [target, setTarget] = useState('');
  const account = accountByID(state, call.accountID);
  const others = state.calls.filter((other) => other.id !== call.id);
  const connected = call.state === 'confirmed';

  const sendDigits = (digits) => {
    act('sendDTMF', digits, call.id);
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
  }, [connected, call.id]);

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
    act('transfer', call.id, destination);
    setTarget('');
    setTransferOpen(false);
  };
  const connectedOthers = others.filter((other) => other.state === 'confirmed');

  return html`<div class="active-call">
    <div class="active-call-header">
      <span class=${cx('active-call-icon', connected && 'connected')}>
        <${Icon} name=${call.direction === 'incoming' ? 'callIncomingFilled' : 'callOutgoingFilled'} size=${28} />
      </span>
      <h2 class="active-call-name selectable">${callDisplayName(call)}</h2>
      ${call.remoteName ? html`<p class="active-call-number selectable">${call.remoteNumber}</p>` : null}
      <p class="active-call-status" aria-live="polite"><${CallStatusText} call=${call} /></p>
      ${account ? html`<p class="caption">via ${displayLabel(account)}</p>` : null}
      ${call.isRecording ? html`<p class="recording-badge"><${Icon} name="record" size=${12} />Recording</p>` : null}
      ${digitsSent ? html`<p class="dtmf-history mono" aria-label=${`Digits sent: ${digitsSent}`}>${digitsSent}</p>` : null}
    </div>

    ${call.state === 'incoming' ? html`<div class="call-answer-row">
      <${Button} size="large" kind="danger" icon="callEnd" title="Decline (Ctrl+Shift+D)" onClick=${() => act('decline', call.id)}>Decline</${Button}>
      <${Button} size="large" kind="success" icon="call" title="Answer (Ctrl+Enter)" onClick=${() => act('answer', call.id)}>Answer</${Button}>
    </div>` : html`
      ${showKeypad ? html`<${Keypad} compact onKey=${sendDigits} />` : null}
      <div class="call-controls">
        <${CallControl} icon=${call.isMuted ? 'micOff' : 'mic'} label=${call.isMuted ? 'Unmute' : 'Mute'} shortcut="Ctrl+Shift+M"
          active=${call.isMuted} disabled=${!connected} onClick=${() => act('toggleMute', call.id)} />
        <${CallControl} icon=${call.isOnHold ? 'play' : 'pause'} label=${call.isOnHold ? 'Resume' : 'Hold'} shortcut="Ctrl+Shift+H"
          active=${call.isOnHold} disabled=${!connected} onClick=${() => act('toggleHold', call.id)} />
        <${CallControl} icon="keypad" label="Keypad" active=${showKeypad} disabled=${!connected} onClick=${() => setShowKeypad((open) => !open)} />
        <${CallControl} icon="transfer" label="Transfer" active=${transferOpen} disabled=${!connected} onClick=${() => setTransferOpen((open) => !open)} />
        <${CallControl} icon=${call.isRecording ? 'recordStop' : 'record'} label=${call.isRecording ? 'Stop' : 'Record'} tone="recording"
          active=${call.isRecording} disabled=${!connected} onClick=${() => act('toggleRecording', call.id)} />
      </div>
      ${transferOpen ? html`<div class="transfer-panel card">
        <label class="field">
          <span class="field-label">Transfer to</span>
          <span class="inline-form">
            <input class="text-field" ref=${transferInput} value=${target} placeholder="Number or SIP address" spellcheck=${false}
              onInput=${(event) => setTarget(event.currentTarget.value)}
              onKeyDown=${(event) => {
                if (event.key === 'Enter') blindTransfer();
                if (event.key === 'Escape') setTransferOpen(false);
              }} />
            <${Button} kind="accent" disabled=${!target.trim()} onClick=${blindTransfer}>Transfer</${Button}>
          </span>
        </label>
        ${connectedOthers.length > 0 ? html`<p class="caption">Or connect this caller with another call</p>
          ${connectedOthers.map((other) => html`<${Button} key=${other.id} onClick=${() => {
            act('attendedTransfer', call.id, other.id);
            setTransferOpen(false);
          }}>Connect with ${callDisplayName(other)}</${Button}>`)}` : null}
      </div>` : null}
      <${Button} size="large" kind="danger" icon="callEnd" block title="Hang up (Ctrl+Enter)" onClick=${() => act('hangup', call.id)}>
        ${connected ? 'Hang up' : 'Cancel'}
      </${Button}>`}

    ${state.transferStatus ? html`<p class="caption transfer-status" aria-live="polite">${state.transferStatus}</p>` : null}

    ${others.length > 0 ? html`<section class="other-calls" aria-label="Other calls">
      <h3 class="caption">Other calls</h3>
      ${others.map((other) => html`<div key=${other.id} class="other-call card">
        <${Icon} name=${other.state === 'incoming' ? 'callIncoming' : 'pause'} className=${other.state === 'incoming' ? 'success-text' : 'secondary'} />
        <div class="other-call-text">
          <span class="ellipsis">${callDisplayName(other)}</span>
          <span class="caption"><${CallStatusText} call=${other} /></span>
        </div>
        ${other.state === 'incoming' ? html`
          <${Button} kind="success" onClick=${() => act('answer', other.id)}>Answer</${Button}>
          <${Button} onClick=${() => act('decline', other.id)}>Decline</${Button}>` : html`
          <${Button} onClick=${() => act('swapToCall', other.id)}>Swap</${Button}>
          <${IconButton} kind="danger" icon="callEnd" label="Hang up this call" onClick=${() => act('hangup', other.id)} />`}
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
      <strong class="ellipsis">${callDisplayName(call)}</strong>
      <span class="caption"><${CallStatusText} call=${call} />${call.isRecording ? ' · Recording' : ''}</span>
    </div>
    ${state.calls.length > 1 ? html`<span class="caption">${state.calls.length} calls</span>` : null}
    ${call.state === 'incoming' ? html`
      <${Button} kind="success" onClick=${() => act('answer', call.id)}>Answer</${Button}>
      <${Button} kind="danger" onClick=${() => act('decline', call.id)}>Decline</${Button}>` : html`
      <${IconButton} kind="standard" icon=${call.isMuted ? 'micOff' : 'mic'} label=${call.isMuted ? 'Unmute' : 'Mute'}
        active=${call.isMuted} disabled=${!connected} onClick=${() => act('toggleMute', call.id)} />
      <${IconButton} kind="standard" icon=${call.isOnHold ? 'play' : 'pause'} label=${call.isOnHold ? 'Resume' : 'Hold'}
        active=${call.isOnHold} disabled=${!connected} onClick=${() => act('toggleHold', call.id)} />
      <${IconButton} kind="danger" icon="callEnd" label="Hang up" onClick=${() => act('hangup', call.id)} />`}
    <${Button} onClick=${() => ui.navigate({ kind: 'dialer' })}>Show</${Button}>
  </div>`;
}
