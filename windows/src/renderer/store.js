// The renderer's copy of AppState. The main process sends changed keys; components re-render
// through useAppState(). Actions go back through window.sipper.invoke.

import { displayLabel } from '../core/models.js';
import { isRegistered, registration } from '../core/sip.js';
import { useEffect, useState } from './lib.js';

let current = null;
const listeners = new Set();

export async function loadState() {
  const early = [];
  window.sipper.on('state', (partial) => {
    if (!current) {
      early.push(partial);
      return;
    }
    current = { ...current, ...partial };
    for (const listener of listeners) listener(current);
  });
  current = await window.sipper.getState();
  for (const partial of early) current = { ...current, ...partial };
  return current;
}

export function useAppState() {
  const [state, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    setState(current);
    return () => listeners.delete(setState);
  }, []);
  return state;
}

export const act = (method, ...args) => window.sipper.invoke(method, ...args);
export const service = (name, ...args) => window.sipper.app(name, ...args);

// MARK: Selectors (mirroring AppState's computed properties)

export const profileByID = (state, id) => state.profiles.find((p) => p.id === id) ?? null;
export const accountByID = (state, id) => state.accounts.find((a) => a.id === id) ?? null;
export const accountsIn = (state, profileID) => state.accounts.filter((a) => a.profileID === profileID);
export const registrationOf = (state, id) => state.registrations[id] ?? registration.unregistered();
export const contactByID = (state, id) => state.contacts.find((c) => c.id === id) ?? null;

export const accountIsLive = (state, account) => account.isEnabled && (profileByID(state, account.profileID)?.isEnabled ?? false);

export function activeCall(state) {
  return state.calls.find((c) => c.id === state.selectedCallID) ?? state.calls[0] ?? null;
}

export function dialerAccount(state) {
  return accountByID(state, state.dialerAccountID)
    ?? state.accounts.find((a) => isRegistered(registrationOf(state, a.id)))
    ?? state.accounts[0]
    ?? null;
}

export function accountLabel(state, id, fallback = 'Removed account') {
  const account = accountByID(state, id);
  return account ? displayLabel(account) : fallback;
}
