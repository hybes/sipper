// Navigation pane: phone pages, profiles with their accounts, and settings.

import { displayLabel } from '../../core/models.js';
import { isRegistered, registration, registrationShortLabel } from '../../core/sip.js';
import { cx, Icon, IconButton, showMenu, StatusDot } from '../components.js';
import { PROFILE_ICONS } from '../icons.js';
import { html, useState } from '../lib.js';
import { accountsIn, act, registrationOf, useAppState } from '../store.js';
import { useUI } from '../ui.js';
import { deleteProfileWithChoice, showAccountMenu } from './actions.js';

function NavItem({ kind, icon, label, badge }) {
  const ui = useUI();
  const selected = ui.selection.kind === kind;
  return html`<button type="button" class=${cx('nav-item', selected && 'selected')} aria-current=${selected ? 'page' : undefined}
    onClick=${() => ui.navigate({ kind })}>
    <${Icon} name=${icon} />
    <span class="nav-item-label">${label}</span>
    ${badge > 0 ? html`<span class="nav-badge" aria-label=${`${badge} missed ${badge === 1 ? 'call' : 'calls'}`}>${badge}</span>` : null}
  </button>`;
}

function AccountRow({ account, profile }) {
  const state = useAppState();
  const ui = useUI();
  const live = account.isEnabled && profile.isEnabled;
  const status = live ? registrationOf(state, account.id) : registration.unregistered();
  const voicemail = state.voicemail[account.id];
  const inCall = state.calls.some((call) => call.accountID === account.id);
  const selected = ui.selection.kind === 'account' && ui.selection.id === account.id;
  return html`<button type="button" class=${cx('account-row', selected && 'selected', !live && 'disabled')} aria-current=${selected ? 'page' : undefined}
    onClick=${() => ui.navigate({ kind: 'account', id: account.id })}
    onContextMenu=${(event) => {
      event.preventDefault();
      showAccountMenu(state, ui, account);
    }}>
    <${StatusDot} registration=${status} />
    <span class="account-text">
      <span class="account-label">${displayLabel(account)}</span>
      <span class="account-caption">${live ? registrationShortLabel(status) : 'Disabled'}</span>
    </span>
    ${voicemail?.newCount > 0 ? html`<span class="account-voicemail" title=${`${voicemail.newCount} new voicemail ${voicemail.newCount === 1 ? 'message' : 'messages'}`}>
      <${Icon} name="mailUnread" size=${12} />${voicemail.newCount}
    </span>` : null}
    ${inCall ? html`<span class="account-in-call" title="In a call"><${Icon} name="call" size=${12} /></span>` : null}
  </button>`;
}

function ProfileGroup({ profile, collapsed, onToggle }) {
  const state = useAppState();
  const ui = useUI();
  const members = accountsIn(state, profile.id);
  const selected = ui.selection.kind === 'profile' && ui.selection.id === profile.id;
  const menu = () => showMenu([
    { label: 'Add account…', onSelect: () => ui.openDialog({ kind: 'addAccount', profileID: profile.id }) },
    { label: 'Edit profile…', onSelect: () => ui.openDialog({ kind: 'editProfile', id: profile.id }) },
    { label: profile.isEnabled ? 'Disable profile' : 'Enable profile', onSelect: () => act('setProfileEnabled', profile.id, !profile.isEnabled) },
    state.profiles.length > 1 && 'separator',
    state.profiles.length > 1 && { label: 'Delete profile…', onSelect: () => deleteProfileWithChoice(state, profile) },
  ]);

  return html`<section class=${cx('profile-group', !profile.isEnabled && 'disabled', `tint-${profile.colorName}`)} aria-label=${profile.name}>
    <div class="profile-header">
      <button type="button" class="profile-chevron" aria-expanded=${String(!collapsed)}
        aria-label=${collapsed ? `Show accounts in ${profile.name}` : `Hide accounts in ${profile.name}`} onClick=${onToggle}>
        <${Icon} name=${collapsed ? 'chevronRight' : 'chevronDown'} size=${12} />
      </button>
      <button type="button" class=${cx('profile-name', selected && 'selected')} aria-current=${selected ? 'page' : undefined}
        onClick=${() => ui.navigate({ kind: 'profile', id: profile.id })}
        onContextMenu=${(event) => {
          event.preventDefault();
          menu();
        }}>
        <${Icon} name=${PROFILE_ICONS[profile.iconName] ?? 'building'} size=${14} className="profile-icon" />
        <span>${profile.name}</span>
      </button>
      <${IconButton} icon="more" label=${`${profile.name} options`} className="profile-more" onClick=${menu} />
    </div>
    ${collapsed ? null : html`<div class="profile-accounts">
      ${members.length === 0
        ? html`<button type="button" class="sidebar-empty-add" onClick=${() => ui.openDialog({ kind: 'addAccount', profileID: profile.id })}>
            <${Icon} name="add" size=${12} />Add account
          </button>`
        : members.map((account) => html`<${AccountRow} key=${account.id} account=${account} profile=${profile} />`)}
    </div>`}
  </section>`;
}

function EngineStatus() {
  const state = useAppState();
  if (state.engineStatus.error && !state.engineStatus.running) {
    return html`<span class="sidebar-status danger-text" title=${state.engineStatus.error}><${Icon} name="warning" size=${12} />Engine stopped</span>`;
  }
  if (state.settings.doNotDisturb) {
    return html`<span class="sidebar-status"><${Icon} name="moon" size=${12} />Do Not Disturb</span>`;
  }
  const registered = state.accounts.filter((a) => isRegistered(registrationOf(state, a.id))).length;
  return html`<span class="sidebar-status">${registered === 0 ? 'No accounts registered' : `${registered} registered`}</span>`;
}

export function Sidebar() {
  const state = useAppState();
  const ui = useUI();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (id) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return html`<nav class="sidebar" aria-label="Sipper">
    <div class="sidebar-scroll">
      <div class="nav-section">
        <${NavItem} kind="dialer" icon="dialer" label="Dialer" />
        <${NavItem} kind="history" icon="history" label="History" badge=${state.unseenMissedCalls} />
        <${NavItem} kind="contacts" icon="contacts" label="Contacts" />
      </div>
      ${state.profiles.map((profile) => html`<${ProfileGroup} key=${profile.id} profile=${profile}
        collapsed=${collapsed.has(profile.id)} onToggle=${() => toggle(profile.id)} />`)}
    </div>
    <div class="sidebar-footer">
      <div class="sidebar-footer-row">
        <${IconButton} icon="add" label="Add an account or profile" onClick=${() => showMenu([
          { label: 'Add account…', onSelect: () => ui.openDialog({ kind: 'addAccount', profileID: null }) },
          { label: 'Add profile…', onSelect: () => ui.openDialog({ kind: 'addProfile' }) },
        ])} />
        <${EngineStatus} />
      </div>
      <${NavItem} kind="settings" icon="settings" label="Settings" />
    </div>
  </nav>`;
}
