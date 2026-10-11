// Authenticated gateway call control stays in the main process, alongside provisioning.
import { setTimeout as sleep } from 'node:timers/promises';
import { callFromEngine } from '../core/sip.js';
import { callUnavailable } from './managedContracts.js';
import { ManagedError } from './managedClient.js';

export const callIdentity = call => ({ callId: call.id, accountId: call.accountID, expectedStartedAt: call.startedAt });
const unavailable = () => new ManagedError('call_unavailable', 'This call is no longer available.');

export class ManagedCalls {
  constructor(client, engine) { this.client = client; this.engine = engine; }

  async status(offer, action = 'status') {
    const value = await this.client.call(offer.call.gatewayCallId, offer.binding, action, offer.controller.signal);
    offer.controller.signal.throwIfAborted();
    // An in-flight status request can finish after the answer claim. Never roll it back.
    if (!offer.latest || value.version >= offer.latest.version) offer.latest = value;
    return offer.latest;
  }

  async prepare(offer) {
    const value = await this.status(offer);
    if (callUnavailable(value) || !value.caller) throw unavailable();
    const raw = await this.engine.request('setManagedCaller', { ...callIdentity(offer.call),
      gatewayCallId: value.id, name: value.caller.name, number: value.caller.number || 'Unknown caller' });
    offer.controller.signal.throwIfAborted();
    return callFromEngine(raw);
  }

  async claim(offer) {
    const value = await this.status(offer, 'answer');
    if (callUnavailable(value) || !value.claimedByThisDevice || !['answering', 'answered'].includes(value.state)) throw unavailable();
    return value.id;
  }

  decline(offer) {
    return this.client.call(offer.call.gatewayCallId, offer.binding, 'decline').catch(() => {});
  }

  async monitor(offer, currentCall) {
    let deadline = offer.call.startedAt + 90_000;
    const signal = offer.controller.signal;
    while (!signal.aborted) {
      const current = currentCall();
      if (!current || current.connectedAt || current.state !== 'incoming') return;
      let dismiss = Date.now() >= deadline;
      try {
        if (!dismiss) {
          const value = await this.status(offer);
          dismiss = callUnavailable(value);
          deadline = Math.min(deadline, Date.parse(value.expiresAt));
        }
      } catch (error) {
        if (signal.aborted) return;
        dismiss = error.code !== 'unavailable';
      }
      if (dismiss) {
        await this.engine.request('hangup', { ...callIdentity(offer.call), code: 480, onlyIfRinging: true }).catch(() => {});
        return;
      }
      try { await sleep(1000, undefined, { signal, ref: false }); } catch { return; }
    }
  }
}
