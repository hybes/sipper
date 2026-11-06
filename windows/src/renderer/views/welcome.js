// First run, and whenever there are no accounts: sign in to get phone lines from an
// organisation, or set an account up by hand.

import { Button, cleanError, InfoBar } from '../components.js';
import { html, useState } from '../lib.js';
import { service, useAppState } from '../store.js';
import { useUI } from '../ui.js';

function waitingText(status) {
  const connected = status.enrollments.filter((e) => e.configured).length;
  if (status.busy) return 'Getting your phone lines…';
  if (status.organisations.length === 0) return 'No organisation has added this email address yet. Ask your administrator to invite you.';
  if (!status.organisations.some((o) => o.status === 'active' && o.licensed)) return 'Your administrator needs to assign you a licence before your phone lines can be added.';
  if (connected === 0 && status.enrollments.length === 0) return 'Connecting to your organisation…';
  return 'Your administrator has not assigned any phone lines yet. They appear here as soon as they are added.';
}

export function WelcomePage() {
  const state = useAppState();
  const ui = useUI();
  const status = state.managed;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const run = async (action, ...args) => {
    setWorking(true);
    setError(null);
    try { await service(action, ...args); }
    catch (failure) { setError(cleanError(failure)); }
    finally { setWorking(false); }
  };
  const busy = working || status.busy;
  const manual = () => ui.openDialog({ kind: 'addAccount', profileID: null });
  const shownError = error || status.error;

  let signIn;
  if (status.signingIn) {
    signIn = html`<p class="welcome-status" role="status">Finish signing in in your browser, then come back here.</p>
      <div class="welcome-actions"><${Button} onClick=${() => run('managedCancelSignIn')}>Cancel</${Button}></div>`;
  } else if (status.signedIn) {
    signIn = html`<p class="welcome-status" role="status">Signed in as <strong>${status.identity.email}</strong>. ${waitingText(status)}</p>
      <div class="welcome-actions">
        <${Button} kind="accent" disabled=${busy} onClick=${() => run('managedConnectAvailable')}>Refresh</${Button}>
        <${Button} disabled=${busy} onClick=${() => run('managedSignOut')}>Sign out</${Button}>
      </div>`;
  } else {
    signIn = html`<p class="welcome-text">Use the email your organisation or provider set up for you. Your phone lines are added automatically.</p>
      <div class="welcome-actions"><${Button} kind="accent" disabled=${busy} onClick=${() => run('managedSignIn')}>Sign in</${Button}></div>`;
  }

  return html`<div class="welcome">
    <div class="welcome-inner">
      <img src="../../resources/icon-256.png" alt="" width="72" height="72" />
      <h1 class="welcome-title">Welcome to Sipper</h1>
      ${shownError ? html`<${InfoBar} severity="error" title="Sign-in">${shownError}</${InfoBar}>` : null}
      <section class="welcome-option" aria-label="Sign in">
        <h2 class="welcome-option-title">Sign in</h2>
        ${signIn}
      </section>
      <section class="welcome-option" aria-label="Set up manually">
        <h2 class="welcome-option-title">Set up manually</h2>
        <p class="welcome-text">Enter SIP details yourself. No sign-in needed.</p>
        <div class="welcome-actions"><${Button} disabled=${status.signingIn} onClick=${manual}>Set up manually</${Button}></div>
      </section>
      <div class="welcome-links">
        ${state.history.length ? html`<button type="button" class="link-button" onClick=${() => ui.navigate({ kind: 'history' })}>History</button>` : null}
        ${state.contacts.length ? html`<button type="button" class="link-button" onClick=${() => ui.navigate({ kind: 'contacts' })}>Contacts</button>` : null}
        <button type="button" class="link-button" onClick=${() => ui.navigate({ kind: 'settings' })}>Settings</button>
      </div>
    </div>
  </div>`;
}
