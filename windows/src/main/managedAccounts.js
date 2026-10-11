import { createHash } from 'node:crypto';
import { makeAccount, makeProfile } from '../core/models.js';
import { validateConfiguration } from './managedContracts.js';

export function directCallReport(accounts, calls) {
  return accounts.filter(account => account.managed?.mode === 'direct').map(account => {
    const report = { accountId: account.managed.remoteAccountId, ringing: 0, dialling: 0, connected: 0, held: 0 };
    for (const call of calls) {
      if (call.accountID !== account.id || call.state === 'disconnected') continue;
      if (call.connectedAt != null || call.state === 'confirmed') report[call.isOnHold || call.isRemoteHold ? 'held' : 'connected']++;
      else report[call.direction === 'incoming' ? 'ringing' : 'dialling']++;
    }
    return report;
  });
}

function localId(namespace) {
  const hex = createHash('sha256').update(namespace).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`.toUpperCase();
}
export function mapManagedConfiguration(origin, raw, now = Date.now()) {
  const config = validateConfiguration(raw, raw.organisation.id, raw.deviceId, now);
  const namespace = `sipper-managed:${origin}:${config.deviceId}`;
  const profile = { ...makeProfile({ id: localId(`${namespace}:profile`), name: config.organisation.name, colorName: 'teal' }),
    managed: { organisationId: config.organisation.id, deviceId: config.deviceId } };
  const accounts = config.accounts.map((account, index) => ({ ...makeAccount({
    id: localId(`${namespace}:account:${account.id}`), profileID: profile.id, label: account.label,
    ...account.settings, srtp: account.settings.srtp === 'required' ? 'mandatory' : account.settings.srtp,
    source: 'managed', sortOrder: index,
  }), managed: { organisationId: config.organisation.id, deviceId: config.deviceId, remoteAccountId: account.id, mode: account.mode, doNotDisturb: account.doNotDisturb === true, expiresAt: config.expiresAt } }));
  return { profile, accounts, passwords: new Map(accounts.map((a, i) => [a.id, config.accounts[i].password])) };
}
