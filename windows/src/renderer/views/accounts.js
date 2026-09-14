// Account and profile pages, and their editors.

import {
  accountValidationErrors, addressOfRecord, defaultLabel, displayLabel, effectivePort, effectiveServer, makeAccount,
  PROFILE_COLORS, PROFILE_ICONS as PROFILE_ICON_NAMES, SRTP_MODES, SRTP_NAMES, TRANSPORTS, transportDefaultPort, transportName,
  usesSeparateServer,
} from '../../core/models.js';
import { isFailed, isRegistered, registration, registrationShortLabel } from '../../core/sip.js';
import {
  Button, cleanError, cx, Dialog, EmptyState, Field, Icon, IconButton, InfoBar, PageHeader, RegistrationDetail, Segmented, Select,
  StatusDot, TextField, Toggle,
} from '../components.js';
import { PROFILE_ICONS } from '../icons.js';
import { html, useEffect, useRef, useState } from '../lib.js';
import { accountByID, accountsIn, act, profileByID, registrationOf, useAppState } from '../store.js';
import { useUI } from '../ui.js';
import { deleteAccountWithConfirmation, deleteProfileWithChoice } from './actions.js';
import { HistoryRow } from './history.js';

export function AccountPage({ id }) {
  const state = useAppState();
  const ui = useUI();
  const [quickDial, setQuickDial] = useState('');
  const account = accountByID(state, id);
  if (!account) return html`<div class="page"><${EmptyState} icon="info" title="This account was removed" /></div>`;

  const profile = profileByID(state, account.profileID);
  const live = account.isEnabled && (profile?.isEnabled ?? true);
  const status = registrationOf(state, account.id);
  const voicemail = state.voicemail[account.id];
  const recent = state.history.filter((record) => record.accountID === account.id).slice(0, 10);
  const placeQuickCall = async () => {
    if (quickDial.trim() && await act('call', quickDial, account.id)) setQuickDial('');
  };

  const rows = [
    ['Username', account.username],
    account.authUsername && ['Auth username', account.authUsername],
    ['Domain', account.domain],
    ['Server', usesSeparateServer(account) ? effectiveServer(account) : 'Same as domain'],
    ['Transport', `${transportName(account.transport)} · port ${effectivePort(account)}`],
    ['Registration', `Every ${account.registrationExpiry} s`],
    ['Media encryption', SRTP_NAMES[account.srtp]],
    account.stunServer && ['STUN server', account.stunServer],
    account.useICE && ['ICE', 'On'],
    account.displayName && ['Display name', account.displayName],
    (account.callerIDName || account.callerIDNumber) && ['Caller ID', `${account.callerIDName} ${account.callerIDNumber}`.trim()],
    ['Voicemail', account.voicemailNumber],
    ['Address of record', addressOfRecord(account)],
    account.source !== 'manual' && ['Imported from', account.source === 'fusionpbx' ? 'FusionPBX' : account.source],
  ].filter(Boolean);

  return html`<div class="page">
    <${PageHeader} title=${displayLabel(account)}>
      <${Button} icon="sync" disabled=${!live} onClick=${() => act('reRegister', account.id)}>Re-register</${Button}>
      <${Button} icon="edit" onClick=${() => ui.openDialog({ kind: 'editAccount', id: account.id })}>Edit</${Button}>
    </${PageHeader}>
    <div class="page-body scroll">
      <div class="detail">
        <div class="overview">
          <${StatusDot} registration=${live ? status : registration.unregistered()} size=${12} />
          <div class="overview-text">
            <span class=${cx(live && isFailed(status) ? 'danger-text' : 'secondary')}>
              ${live ? html`<${RegistrationDetail} registration=${status} />` : account.isEnabled ? 'The profile is disabled' : 'The account is disabled'}
            </span>
            ${profile ? html`<button type="button" class=${cx('profile-chip', `tint-${profile.colorName}`)} onClick=${() => ui.navigate({ kind: 'profile', id: profile.id })}>
              <${Icon} name=${PROFILE_ICONS[profile.iconName] ?? 'building'} size=${12} />${profile.name}
            </button>` : null}
          </div>
          <${Toggle} checked=${account.isEnabled} label="Enabled" onChange=${(on) => act('setAccountEnabled', account.id, on)} />
        </div>

        ${!state.engineStatus.running && state.engineStatus.error
          ? html`<${InfoBar} severity="error" title="The SIP engine is not running.">${state.engineStatus.error}</${InfoBar}>` : null}

        <section class="card card-section" aria-label="Quick call">
          <h2 class="card-title">Quick call</h2>
          <div class="quick-call">
            <${TextField} label="Number or SIP address" placeholder="Number or SIP address" value=${quickDial} onValue=${setQuickDial}
              onKeyDown=${(event) => event.key === 'Enter' && placeQuickCall()} />
            <${Button} kind="success" icon="call" disabled=${!quickDial.trim()} onClick=${placeQuickCall}>Call</${Button}>
            <${Button} icon=${voicemail?.newCount > 0 ? 'mailUnread' : 'voicemail'} title=${`Dial ${account.voicemailNumber}`}
              onClick=${() => act('callVoicemail', account.id)}>${voicemail?.newCount > 0 ? `Voicemail (${voicemail.newCount})` : 'Voicemail'}</${Button}>
          </div>
        </section>

        <section class="card card-section" aria-label="Connection">
          <h2 class="card-title">Connection</h2>
          <dl class="details-grid">${rows.map(([label, value]) => html`<dt>${label}</dt><dd class="selectable">${value}</dd>`)}</dl>
        </section>

        ${account.notes ? html`<section class="card card-section" aria-label="Notes">
          <h2 class="card-title">Notes</h2>
          <p class="selectable prose-text">${account.notes}</p>
        </section>` : null}

        ${recent.length > 0 ? html`<section class="card" aria-label="Recent calls">
          <h2 class="card-title card-inset-title">Recent calls</h2>
          <div class="card-list" role="list">${recent.map((record) => html`<${HistoryRow} key=${record.id} record=${record} />`)}</div>
        </section>` : null}

        <div class="detail-footer">
          <${Button} kind="subtle" icon="delete" className="danger-text" onClick=${() => deleteAccountWithConfirmation(account)}>Delete account…</${Button}>
        </div>
      </div>
    </div>
  </div>`;
}

export function ProfilePage({ id }) {
  const state = useAppState();
  const ui = useUI();
  const profile = profileByID(state, id);
  if (!profile) return html`<div class="page"><${EmptyState} icon="info" title="This profile was removed" /></div>`;
  const members = accountsIn(state, profile.id);
  const registered = members.filter((a) => isRegistered(registrationOf(state, a.id))).length;
  const count = `${members.length} ${members.length === 1 ? 'account' : 'accounts'}`;
  const summary = profile.isEnabled ? `${registered} of ${count} registered` : `Disabled · ${count}`;

  return html`<div class="page">
    <${PageHeader} title=${profile.name}>
      <${Button} icon="personAdd" onClick=${() => ui.openDialog({ kind: 'addAccount', profileID: profile.id })}>Add account</${Button}>
      <${Button} icon="edit" onClick=${() => ui.openDialog({ kind: 'editProfile', id: profile.id })}>Edit</${Button}>
    </${PageHeader}>
    <div class="page-body scroll">
      <div class=${cx('detail', `tint-${profile.colorName}`)}>
        <div class="overview">
          <span class="profile-badge-large"><${Icon} name=${PROFILE_ICONS[profile.iconName] ?? 'building'} size=${24} /></span>
          <div class="overview-text"><span class="secondary">${summary}</span></div>
          <${Toggle} checked=${profile.isEnabled} label="Enabled" onChange=${(on) => act('setProfileEnabled', profile.id, on)} />
        </div>

        ${members.length === 0
          ? html`<${EmptyState} icon="personAdd" title="No accounts in this profile" description="Add an account, or move one here from another profile.">
              <${Button} onClick=${() => ui.openDialog({ kind: 'addAccount', profileID: profile.id })}>Add account…</${Button}>
            </${EmptyState}>`
          : html`<div class="card rows-card" role="list">
            ${members.map((account) => {
              const live = account.isEnabled && profile.isEnabled;
              const status = registrationOf(state, account.id);
              return html`<div key=${account.id} role="listitem" class="member-row" onDblClick=${() => ui.navigate({ kind: 'account', id: account.id })}>
                <${StatusDot} registration=${live ? status : registration.unregistered()} />
                <div class="member-text">
                  <span class="ellipsis">${displayLabel(account)}</span>
                  <span class="caption ellipsis">${account.username}@${account.domain} · ${transportName(account.transport)}</span>
                </div>
                <span class=${cx('caption', live && isFailed(status) && 'danger-text')}>${live ? registrationShortLabel(status) : 'Disabled'}</span>
                <${Button} onClick=${() => ui.navigate({ kind: 'account', id: account.id })}>Show</${Button}>
              </div>`;
            })}
          </div>`}

        ${state.profiles.length > 1 ? html`<div class="detail-footer">
          <${Button} kind="subtle" icon="delete" className="danger-text" onClick=${() => deleteProfileWithChoice(state, profile)}>Delete profile…</${Button}>
        </div>` : null}
      </div>
    </div>
  </div>`;
}

const TRANSPORT_OPTIONS = TRANSPORTS.map((transport) => ({ value: transport, label: transportName(transport) }));
const SRTP_OPTIONS = SRTP_MODES.map((mode) => ({ value: mode, label: SRTP_NAMES[mode] }));

export function AccountDialog({ mode }) {
  const state = useAppState();
  const ui = useUI();
  const editing = mode.kind === 'editAccount';
  const existing = editing ? accountByID(state, mode.id) : null;
  const [draft, setDraft] = useState(() => (existing
    ? { ...existing }
    : makeAccount({
      profileID: profileByID(state, mode.profileID)?.id ?? state.profiles[0]?.id,
      transport: state.settings.defaultTransport,
    })));
  const [password, setPassword] = useState('');
  const [originalPassword, setOriginalPassword] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [portText, setPortText] = useState(existing?.port ? String(existing.port) : '');
  const [advanced, setAdvanced] = useState(Boolean(existing && (existing.stunServer || existing.useICE || existing.srtp !== 'disabled'
    || existing.displayName || existing.notes || existing.callerIDName || existing.callerIDNumber)));
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  // A new form keeps quiet until the first edit; Save stays disabled meanwhile.
  const [touched, setTouched] = useState(editing);
  const previousTransport = useRef(draft.transport);

  useEffect(() => {
    if (!editing) return;
    act('passwordFor', mode.id).then((stored) => {
      setPassword(stored);
      setOriginalPassword(stored);
    });
  }, []);

  useEffect(() => {
    // A port equal to the old transport's default follows the new default.
    if (previousTransport.current !== draft.transport && Number(portText.trim()) === transportDefaultPort(previousTransport.current)) {
      setPortText('');
    }
    previousTransport.current = draft.transport;
  }, [draft.transport]);

  const set = (key) => (value) => {
    setSaveError(null);
    setTouched(true);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const portTrimmed = portText.trim();
  const portValid = portTrimmed === '' || (/^\d+$/.test(portTrimmed) && Number(portTrimmed) >= 1 && Number(portTrimmed) <= 65535);
  const parsedPort = portValid && portTrimmed !== '' && Number(portTrimmed) !== transportDefaultPort(draft.transport) ? Number(portTrimmed) : null;
  const candidate = { ...draft, port: parsedPort };

  let validation = null;
  if (saveError) validation = saveError;
  else if (!portValid) validation = 'Port must be a number between 1 and 65535.';
  else if (accountValidationErrors(candidate)[0]) validation = accountValidationErrors(candidate)[0];
  else if (!password) validation = 'Password is required.';
  else {
    const duplicate = state.accounts.find((a) => a.id !== draft.id
      && a.username === draft.username.trim() && a.domain.toLowerCase() === draft.domain.trim().toLowerCase());
    if (duplicate) validation = `${displayLabel(duplicate)} already exists in ${profileByID(state, duplicate.profileID)?.name ?? 'another profile'}.`;
  }

  const save = async () => {
    if (validation || saving) return;
    const account = { ...candidate };
    for (const key of ['label', 'username', 'authUsername', 'domain', 'server', 'stunServer', 'voicemailNumber']) account[key] = account[key].trim();
    if (account.authUsername === account.username) account.authUsername = '';
    if (account.server.toLowerCase() === account.domain.toLowerCase()) account.server = '';
    if (!account.voicemailNumber) account.voicemailNumber = '*97';
    setSaving(true);
    try {
      if (editing) {
        await act('updateAccount', account, password === originalPassword ? null : password);
      } else {
        const added = await act('addAccount', account, password);
        ui.navigate({ kind: 'account', id: added.id });
      }
      ui.closeDialog();
    } catch (error) {
      setSaveError(cleanError(error));
    } finally {
      setSaving(false);
    }
  };

  const footer = html`
    ${validation && touched ? html`<span class="footer-message" role="status"><${Icon} name="error" size=${12} />${validation}</span>` : html`<span class="spacer"></span>`}
    <${Button} onClick=${ui.closeDialog}>Cancel</${Button}>
    <${Button} kind="accent" disabled=${Boolean(validation) || saving} onClick=${save}>${editing ? 'Save' : 'Add account'}</${Button}>`;

  return html`<${Dialog} title=${editing ? 'Edit account' : 'Add account'} onClose=${ui.closeDialog} width=${600} footer=${footer}>
    <form class="form-stack" onSubmit=${(event) => {
      event.preventDefault();
      save();
    }}>
      <div class="form-grid two">
        <${Field} label="Label">
          <${TextField} data-autofocus value=${draft.label} onValue=${set('label')}
            placeholder=${draft.username && draft.domain ? defaultLabel(draft) : 'Optional'} />
        </${Field}>
        <${Field} label="Profile">
          <${Select} value=${draft.profileID} options=${state.profiles.map((p) => ({ value: p.id, label: p.name }))} onChange=${set('profileID')} />
        </${Field}>
      </div>
      <${Toggle} checked=${draft.isEnabled} label="Enabled" onChange=${set('isEnabled')} />

      <h3 class="form-section-title">Sign-in</h3>
      <div class="form-grid two">
        <${Field} label="Username"><${TextField} value=${draft.username} onValue=${set('username')} placeholder="Extension, for example 1001" /></${Field}>
        <${Field} label="Auth username"><${TextField} value=${draft.authUsername} onValue=${set('authUsername')} placeholder="Same as username" /></${Field}>
      </div>
      <${Field} label="Password">
        <span class="password-field">
          <${TextField} type=${showPassword ? 'text' : 'password'} value=${password} autocomplete="off"
            onValue=${(value) => {
              setSaveError(null);
              setTouched(true);
              setPassword(value);
            }} />
          <${IconButton} kind="standard" icon=${showPassword ? 'eyeOff' : 'eye'} label=${showPassword ? 'Hide password' : 'Show password'}
            onClick=${(event) => {
              event.preventDefault();
              setShowPassword((shown) => !shown);
            }} />
        </span>
      </${Field}>

      <h3 class="form-section-title">Server</h3>
      <${Field} label="Domain"><${TextField} value=${draft.domain} onValue=${set('domain')} placeholder="pbx.example.com" /></${Field}>
      <${Field} label="Outbound proxy" hint="Only when SIP traffic goes to a different host than the domain.">
        <${TextField} value=${draft.server} onValue=${set('server')} placeholder="Same as domain" />
      </${Field}>
      <div class="form-grid two">
        <div class="field">
          <span class="field-label">Transport</span>
          <${Segmented} label="Transport" value=${draft.transport} options=${TRANSPORT_OPTIONS} onChange=${set('transport')} />
        </div>
        <${Field} label="Port">
          <${TextField} value=${portText} inputmode="numeric" invalid=${!portValid} placeholder=${String(transportDefaultPort(draft.transport))}
            onValue=${(value) => {
              setSaveError(null);
              setTouched(true);
              setPortText(value);
            }} />
        </${Field}>
      </div>

      <div class="expander">
        <button type="button" class="expander-header" aria-expanded=${String(advanced)} onClick=${() => setAdvanced((open) => !open)}>
          <span>Advanced</span><${Icon} name=${advanced ? 'chevronDown' : 'chevronRight'} size=${12} />
        </button>
        ${advanced ? html`<div class="expander-body">
          <${Field} label="Display name" hint="Shown to the people you call.">
            <${TextField} value=${draft.displayName} onValue=${set('displayName')} />
          </${Field}>
          <div class="form-grid two">
            <${Field} label="Registration expiry (seconds)">
              <${TextField} type="number" min="60" max="86400" step="60" value=${String(draft.registrationExpiry)}
                onValue=${(value) => set('registrationExpiry')(Number.parseInt(value, 10) || 0)} />
            </${Field}>
            <${Field} label="Media encryption (SRTP)">
              <${Select} value=${draft.srtp} options=${SRTP_OPTIONS} onChange=${set('srtp')} />
            </${Field}>
          </div>
          <div class="form-grid two">
            <${Field} label="STUN server"><${TextField} value=${draft.stunServer} onValue=${set('stunServer')} placeholder="Uses the global setting" /></${Field}>
            <${Field} label="Voicemail number"><${TextField} value=${draft.voicemailNumber} onValue=${set('voicemailNumber')} placeholder="*97" /></${Field}>
          </div>
          <${Toggle} checked=${draft.useICE} label="Use ICE" onChange=${set('useICE')} />
          <div class="form-grid two">
            <${Field} label="Caller ID name"><${TextField} value=${draft.callerIDName} onValue=${set('callerIDName')} /></${Field}>
            <${Field} label="Caller ID number"><${TextField} value=${draft.callerIDNumber} onValue=${set('callerIDNumber')} /></${Field}>
          </div>
          <${Field} label="Notes"><${TextField} multiline rows=${3} value=${draft.notes} onValue=${set('notes')} /></${Field}>
        </div>` : null}
      </div>
      <button type="submit" hidden></button>
    </form>
  </${Dialog}>`;
}

export function ProfileDialog({ mode }) {
  const state = useAppState();
  const ui = useUI();
  const editing = mode.kind === 'editProfile';
  const existing = editing ? profileByID(state, mode.id) : null;
  const [draft, setDraft] = useState(() => (existing ? { ...existing } : { name: '', colorName: 'blue', iconName: 'building.2', isEnabled: true }));
  const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));
  const valid = draft.name.trim() !== '';

  const save = async () => {
    if (!valid) return;
    if (editing) {
      await act('updateProfile', draft);
    } else {
      const profile = await act('addProfile', draft);
      ui.navigate({ kind: 'profile', id: profile.id });
    }
    ui.closeDialog();
  };

  const footer = html`<span class="spacer"></span>
    <${Button} onClick=${ui.closeDialog}>Cancel</${Button}>
    <${Button} kind="accent" disabled=${!valid} onClick=${save}>${editing ? 'Save' : 'Add profile'}</${Button}>`;

  return html`<${Dialog} title=${editing ? 'Edit profile' : 'Add profile'} onClose=${ui.closeDialog} width=${460} footer=${footer}>
    <form class=${cx('form-stack', `tint-${draft.colorName}`)} onSubmit=${(event) => {
      event.preventDefault();
      save();
    }}>
      <${Field} label="Name"><${TextField} data-autofocus value=${draft.name} onValue=${set('name')} placeholder="For example Office PBX" /></${Field}>
      <${Toggle} checked=${draft.isEnabled} label="Enabled" onChange=${set('isEnabled')} />

      <h3 class="form-section-title">Colour</h3>
      <div class="swatches" role="radiogroup" aria-label="Colour">
        ${PROFILE_COLORS.map((color) => html`<button type="button" role="radio" aria-checked=${String(draft.colorName === color)}
          aria-label=${color[0].toUpperCase() + color.slice(1)} class=${cx('swatch', `tint-${color}`, draft.colorName === color && 'selected')}
          onClick=${() => set('colorName')(color)}>
          ${draft.colorName === color ? html`<${Icon} name="checkmark" size=${14} />` : null}
        </button>`)}
      </div>

      <h3 class="form-section-title">Icon</h3>
      <div class="icon-grid" role="radiogroup" aria-label="Icon">
        ${PROFILE_ICON_NAMES.map((name) => html`<button type="button" role="radio" aria-checked=${String(draft.iconName === name)}
          aria-label=${PROFILE_ICONS[name]} title=${PROFILE_ICONS[name]} class=${cx('icon-choice', draft.iconName === name && 'selected')}
          onClick=${() => set('iconName')(name)}>
          <${Icon} name=${PROFILE_ICONS[name] ?? 'building'} size=${18} />
        </button>`)}
      </div>
      <button type="submit" hidden></button>
    </form>
  </${Dialog}>`;
}
