// Actions and display rules used by several views.

import { displayLabel } from '../../core/models.js';
import { cleanError, confirmDialog, showMenu } from '../components.js';
import { accountsIn, act, service } from '../store.js';

export async function deleteAccountWithConfirmation(account) {
  const response = await confirmDialog({
    type: 'warning',
    message: `Delete ${displayLabel(account)}?`,
    detail: 'The account is unregistered and its stored password removed. Call history is kept.',
    buttons: ['Delete account', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) act('deleteAccount', account.id);
}

/** Offers to move a profile's accounts to each other profile, or to delete them with it. */
export async function deleteProfileWithChoice(state, profile) {
  const members = accountsIn(state, profile.id);
  const others = state.profiles.filter((p) => p.id !== profile.id);
  if (members.length === 0) {
    const response = await confirmDialog({
      type: 'warning',
      message: `Delete the profile “${profile.name}”?`,
      buttons: ['Delete profile', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) act('deleteProfile', profile.id, null);
    return;
  }
  const buttons = [...others.map((other) => `Move accounts to ${other.name}`), 'Delete profile and its accounts', 'Cancel'];
  const response = await confirmDialog({
    type: 'warning',
    message: `Delete the profile “${profile.name}”?`,
    detail: `${members.length === 1 ? '1 account belongs' : `${members.length} accounts belong`} to this profile. Move them to another profile or delete them with it. Call history is kept.`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response < others.length) act('deleteProfile', profile.id, others[response].id);
  else if (response === others.length) act('deleteProfile', profile.id, null);
}

export function showAccountMenu(state, ui, account) {
  const others = state.profiles.filter((p) => p.id !== account.profileID);
  return showMenu([
    {
      label: 'Call from this account',
      onSelect: () => {
        act('setDialerAccount', account.id);
        ui.navigate({ kind: 'dialer' });
        ui.focusDialer();
      },
    },
    { label: 'Call voicemail', onSelect: () => act('callVoicemail', account.id) },
    'separator',
    { label: 'Re-register', enabled: account.isEnabled, onSelect: () => act('reRegister', account.id) },
    { label: account.isEnabled ? 'Disable' : 'Enable', onSelect: () => act('setAccountEnabled', account.id, !account.isEnabled) },
    { label: 'Edit…', onSelect: () => ui.openDialog({ kind: 'editAccount', id: account.id }) },
    others.length > 0 && {
      label: 'Move to',
      submenu: others.map((profile) => ({ label: profile.name, onSelect: () => act('moveAccount', account.id, profile.id) })),
    },
    'separator',
    { label: 'Delete…', onSelect: () => deleteAccountWithConfirmation(account) },
  ]);
}

export async function openRecording(record) {
  const problem = await service('openRecording', record.id);
  if (problem) {
    confirmDialog({ type: 'error', message: 'Could not open the recording', detail: problem, buttons: ['OK'] });
  }
}

export async function deleteRecording(record) {
  const response = await confirmDialog({
    type: 'warning',
    message: 'Delete this recording?',
    detail: 'The file is deleted from disk. The call stays in history.',
    buttons: ['Delete recording', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) {
    try {
      await act('deleteRecording', record.id);
    } catch (error) {
      confirmDialog({ type: 'error', message: 'Could not delete the recording', detail: cleanError(error), buttons: ['OK'] });
    }
  }
}

export function recordIcon(record) {
  if (record.direction === 'incoming') {
    if (record.outcome === 'missed') return 'callMissed';
    if (record.outcome === 'declined') return 'callDeclined';
    return 'callIncomingFilled';
  }
  return record.outcome === 'completed' ? 'callOutgoingFilled' : 'callOutgoing';
}

export function recordTone(record) {
  // A call still in progress carries a placeholder outcome until it ends.
  if (!record.endedAt) return '';
  if (record.outcome === 'missed') return 'danger-text';
  if (record.outcome === 'failed') return 'warning-text';
  if (record.outcome === 'completed') return '';
  return 'secondary';
}
