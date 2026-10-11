// The main window: title bar, navigation pane, the selected page and dialogs, plus keyboard
// shortcuts and the ringtone.

import { callDisplayName } from '../core/sip.js';
import { html, render, useEffect, useMemo, useRef, useState } from './lib.js';
import { ring, stopRinging } from './ringer.js';
import { accountByID, act, activeCall, loadState, profileByID, useAppState } from './store.js';
import { UIContext } from './ui.js';
import { AccountDialog, AccountPage, ProfileDialog, ProfilePage } from './views/accounts.js';
import { ContactDialog, ContactsPage } from './views/contacts.js';
import { CallBanner, DialerPage } from './views/dialer.js';
import { HistoryPage } from './views/history.js';
import { MessagesPage } from './views/messages.js';
import { ImportDialog } from './views/importDialog.js';
import { SettingsPage } from './views/settings.js';
import { Sidebar } from './views/sidebar.js';

function App() {
  const state = useAppState();
  const [selection, setSelection] = useState({ kind: 'dialer' });
  const [dialog, setDialog] = useState(null);
  const [dialString, setDialString] = useState('');
  const [focusDialerToken, setFocusDialerToken] = useState(0);
  const [setupLink, setSetupLink] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;

  const ui = useMemo(() => ({
    selection,
    setupLink, setSetupLink,
    navigate: setSelection,
    openDialog: setDialog,
    closeDialog: () => setDialog(null),
    dialString,
    setDialString,
    focusDialerToken,
  }), [selection, dialString, focusDialerToken, setupLink]);

  useEffect(() => {
    const unsubscribers = [
      window.sipper.on('navigate', (target) => {
        if (typeof target.setupLink === 'string') setSetupLink(target.setupLink);
        if (target.kind === 'removed') setSelection((current) => (current.id === target.id ? { kind: 'dialer' } : current));
        else { const { setupLink: _setupLink, ...selection } = target; setSelection(selection); }
      }),
      window.sipper.on('prefillDialer', ({ text }) => {
        setDialString(text);
        setSelection({ kind: 'dialer' });
        setFocusDialerToken((token) => token + 1);
      }),
      window.sipper.on('command', (command) => {
        if (command === 'newCall') act('prepareNewCall');
      }),
      window.sipper.on('ring', ({ ringtone, volume }) => ring(ringtone, volume)),
      window.sipper.on('ringStop', () => stopRinging()),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      const call = activeCall(stateRef.current);
      const handled = () => event.preventDefault();
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        handled();
        act('answerOrHangUp');
      } else if (event.shiftKey && key === 'd') {
        handled();
        if (call?.state === 'incoming') act('decline', call.id);
      } else if (event.shiftKey && key === 'm') {
        handled();
        if (call?.state === 'confirmed') act('toggleMute', call.id);
      } else if (event.shiftKey && key === 'h') {
        handled();
        if (call?.state === 'confirmed') act('toggleHold', call.id);
      } else if (event.shiftKey && key === 'a') {
        handled();
        setDialog({ kind: 'addAccount', profileID: null });
      } else if (event.altKey && key === 'd') {
        handled();
        act('toggleDoNotDisturb');
      } else if (!event.shiftKey && !event.altKey) {
        const pages = { 1: 'dialer', 2: 'history', 3: 'contacts', 4: 'messages', ',': 'settings' };
        if (key === 'n') {
          handled();
          act('prepareNewCall');
        } else if (pages[key]) {
          handled();
          setSelection({ kind: pages[key] });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const call = activeCall(state);
  useEffect(() => {
    document.title = call ? `${callDisplayName(call)} – Sipper` : 'Sipper';
  }, [call?.id, call?.remoteName, call?.remoteNumber]);

  let page;
  switch (selection.kind) {
    case 'history': page = html`<${HistoryPage} />`; break;
    case 'contacts': page = html`<${ContactsPage} />`; break;
    case 'messages': page = html`<${MessagesPage} />`; break;
    case 'settings': page = html`<${SettingsPage} />`; break;
    case 'account':
      page = accountByID(state, selection.id) ? html`<${AccountPage} key=${selection.id} id=${selection.id} />` : html`<${DialerPage} />`;
      break;
    case 'profile':
      page = profileByID(state, selection.id) ? html`<${ProfilePage} key=${selection.id} id=${selection.id} />` : html`<${DialerPage} />`;
      break;
    default: page = html`<${DialerPage} />`;
  }

  const dialogs = {
    addAccount: AccountDialog,
    editAccount: AccountDialog,
    addProfile: ProfileDialog,
    editProfile: ProfileDialog,
    addContact: ContactDialog,
    editContact: ContactDialog,
  };
  const DialogView = dialog ? dialogs[dialog.kind] : null;

  return html`<${UIContext.Provider} value=${ui}>
    <div class="app-window">
      <header class="titlebar">
        <img class="titlebar-icon" src="../../resources/tray@2x.png" alt="" />
        <span class="titlebar-title">Sipper</span>
      </header>
      <div class="shell">
        <${Sidebar} />
        <main class="content">
          ${state.calls.length > 0 && selection.kind !== 'dialer' ? html`<${CallBanner} />` : null}
          ${page}
        </main>
      </div>
    </div>
    ${state.pendingImport
      ? html`<${ImportDialog} key=${state.pendingImport.candidates.map((c) => c.id).join()} />`
      : DialogView ? html`<${DialogView} key=${JSON.stringify(dialog)} mode=${dialog} />` : null}
  </${UIContext.Provider}>`;
}

loadState().then(() => {
  document.body.classList.add(`platform-${window.sipper.platform}`);
  render(html`<${App} />`, document.getElementById('root'));
});
