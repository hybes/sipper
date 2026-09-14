// Notification-area icon with registration state and quick actions (the Mac app's menu bar item).

import { Menu, nativeImage, Tray } from 'electron';

import { displayLabel } from '../core/models.js';
import { callDisplayName, isFailed, isRegistered, registrationShortLabel } from '../core/sip.js';

export class SipperTray {
  constructor({ state, iconPath, actions }) {
    this.state = state;
    this.iconPath = iconPath;
    this.actions = actions;
    this.tray = null;
    this.timer = null;
    this.onChange = (keys) => {
      if (keys.some((key) => ['accounts', 'profiles', 'registrations', 'calls', 'settings', 'voicemail'].includes(key))) this.#updateSoon();
    };
  }

  setVisible(visible) {
    if (visible && !this.tray) {
      this.tray = new Tray(nativeImage.createFromPath(this.iconPath));
      this.tray.on('click', () => this.actions.showMainWindow());
      this.state.on('change', this.onChange);
      this.#update();
    } else if (!visible && this.tray) {
      this.state.removeListener('change', this.onChange);
      this.tray.destroy();
      this.tray = null;
    }
  }

  get isVisible() {
    return this.tray !== null;
  }

  #updateSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#update(), 150);
  }

  #status() {
    const { state } = this;
    if (state.calls.length > 0) return 'in a call';
    if (state.settings.doNotDisturb) return 'Do Not Disturb';
    if (state.accounts.some((a) => isRegistered(state.registration(a.id)))) return 'registered';
    if (state.accounts.some((a) => isFailed(state.registration(a.id)))) return 'registration failed';
    return state.accounts.length === 0 ? 'no accounts' : 'not registered';
  }

  #update() {
    if (!this.tray) return;
    const { state, actions } = this;
    this.tray.setToolTip(`Sipper · ${this.#status()}`);

    const items = [];
    if (state.accounts.length === 0) {
      items.push({ label: 'No SIP accounts', enabled: false });
    } else {
      for (const profile of state.profiles) {
        const members = state.accountsIn(profile.id);
        if (members.length === 0) continue;
        if (state.profiles.length > 1) items.push({ label: profile.name, enabled: false });
        for (const account of members) {
          const voicemail = state.voicemail[account.id];
          const unread = voicemail?.newCount > 0 ? ` · ${voicemail.newCount} voicemail` : '';
          const registration = account.isEnabled && profile.isEnabled ? registrationShortLabel(state.registration(account.id)) : 'Disabled';
          items.push({
            label: `${displayLabel(account)} — ${registration}${unread}`,
            click: () => actions.showAccount(account.id),
          });
        }
      }
    }
    items.push({ type: 'separator' });
    for (const call of state.calls) {
      const incoming = call.state === 'incoming';
      items.push({
        label: `${incoming ? 'Answer' : 'Hang up'}: ${callDisplayName(call)}`,
        click: () => (incoming ? state.answer(call.id) : state.hangup(call.id)),
      });
    }
    if (state.calls.length > 0) items.push({ type: 'separator' });
    items.push(
      { label: 'New call', click: () => actions.newCall() },
      { label: 'Do Not Disturb', type: 'checkbox', checked: state.settings.doNotDisturb, click: () => state.toggleDoNotDisturb() },
      { label: 'Re-register all', enabled: state.accounts.length > 0, click: () => state.reRegisterAll() },
      { type: 'separator' },
      { label: 'Open Sipper', click: () => actions.showMainWindow() },
      { label: 'Quit Sipper', click: () => actions.quit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  destroy() {
    this.setVisible(false);
    clearTimeout(this.timer);
  }
}
