import { randomUUID } from 'node:crypto';

const phoneNumber = /^[+0-9*#]{1,128}$/;
const device = call => call?.incoming ? call.legs.get(call.winner)?.deviceId : call?.originDeviceId;
const phone = call => call.incoming ? call.winner : call.parent;
const remote = call => call.incoming ? call.parent : call.winner;

/** REFER is only a request. Authorise it before dialling or moving any media. */
export class Transfers {
  constructor(calls) { this.calls = calls; this.pending = new Map(); this.channels = new Map(); }
  save(transfer, continuation) {
    try { this.calls.state.transfer(transfer, continuation); }
    catch { this.calls.storageFailed = true; this.calls.accepting = false; this.calls.ari.emit('storageFault'); throw new Error('Transfer storage unavailable'); }
  }
  track(transfer) {
    this.pending.set(transfer.id, transfer);
    for (const id of [transfer.phone, transfer.remote, transfer.target, transfer.otherPhone].filter(Boolean)) this.channels.set(id, transfer);
    for (const id of [transfer.callId, transfer.consultationCallId]) {
      const call = this.calls.calls.get(id);
      if (call) call.transfer = transfer.id;
    }
  }
  restore(records = []) { for (const record of records) this.track({ ...record, recovered: true }); }
  reserved(call) { return this.pending.has(call.transfer); }
  run(transfer, action) {
    const calls = [transfer.callId, transfer.consultationCallId].map(id => this.calls.calls.get(id)).filter(Boolean);
    const work = Promise.allSettled([transfer.work, ...calls.map(call => call.work)]).then(action);
    transfer.work = work;
    for (const call of calls) call.work = work;
    return work;
  }
  async ari(method, path, body, query) {
    if (this.calls.storageFailed || !this.calls.canControl()) throw new Error('Gateway control unavailable');
    return this.calls.ari.request(method, path, body, query);
  }
  async progress(transfer, state) {
    try { await this.ari('POST', `channels/${transfer.phone}/transfer_progress`, undefined, { states: state }); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  event(event) {
    if (event.type === 'ChannelTransfer') {
      // Asterisk 22.11 omits state on the initial request. Subsequent events are
      // echoes of transfer_progress and must never initiate another transfer.
      if (event.state === undefined) void this.begin(event).catch(() => this.calls.ari.emit('fault'));
      return true;
    }
    const transfer = this.channels.get(event.channel?.id);
    if (!transfer) return false;
    if (transfer.phase === 'completed' && [transfer.remote, transfer.target].includes(event.channel.id)) return false;
    if (['StasisEnd', 'ChannelDestroyed'].includes(event.type)) {
      transfer.gone ??= new Set(); transfer.gone.add(event.channel.id);
      void this.run(transfer, () => this.settle(transfer)).catch(() => this.calls.ari.emit('fault'));
    } else if (event.type === 'StasisStart' && event.channel.id === transfer.target && !transfer.consultationCallId) {
      void this.run(transfer, () => this.complete(transfer)).catch(() => this.calls.ari.emit('fault'));
    }
    return true;
  }
  available(call) {
    return call?.connected && !call.ended && !call.endReason && !call.parentGone && !call.recovered && !call.transferred
      && call.configurationId && Number.isInteger(call.revision) && device(call);
  }
  async begin(event) {
    const source = event.referred_by?.source_channel?.id, call = this.calls.channels.get(source);
    // Never act on a REFER received on an upstream leg, even if a peer or bridge
    // named by the event happens to belong to one of our devices.
    if (!call || source !== phone(call)) return;
    if (this.reserved(call)) return;
    const requested = event.refer_to?.requested_destination;
    const attended = requested?.protocol_id !== undefined;
    const other = attended ? this.calls.channels.get(event.refer_to?.destination_channel?.id) : undefined;
    const valid = this.calls.accepting && this.calls.canControl() && this.calls.state && this.available(call)
      && (attended ? this.available(other) && other !== call && !this.reserved(other)
        && event.refer_to.destination_channel.id === phone(other) && device(other) === device(call)
        && other.configurationId === call.configurationId && other.revision === call.revision
        : typeof requested?.destination === 'string' && phoneNumber.test(requested.destination));
    if (!valid) return this.progress({ phone: source }, 'channel_declined');
    const transfer = { id: randomUUID(), callId: call.id, consultationCallId: other?.id, deviceId: device(call),
      phone: source, remote: remote(call), target: other ? remote(other) : randomUUID(), otherPhone: other && phone(other),
      bridge: call.bridge, otherBridge: other?.bridge, phase: 'pending', expires: Date.now() + 45_000,
      asteriskStartedAt: this.calls.asteriskStartedAt };
    // The destination is held in memory only; interrupted attempts roll back.
    transfer.request = { transferId: transfer.id, callId: call.id, deviceId: transfer.deviceId,
      ...(other ? { consultationCallId: other.id } : { destination: requested.destination }) };
    this.save(transfer); this.track(transfer);
    return this.run(transfer, async () => {
      try {
        await this.admit(transfer);
        await this.progress(transfer, 'channel_progress');
        if (other) return await this.complete(transfer);
        const route = this.calls.upstreams.get(call.configurationId, call.revision);
        if (!route || route.id !== call.upstream) throw new Error('Transfer route changed');
        await this.ari('POST', 'channels', { variables: {} }, { endpoint: `PJSIP/${encodeURIComponent(requested.destination)}@${route.id}`,
          app: 'sipper', appArgs: `transfer,${transfer.id}`, channelId: transfer.target, originator: transfer.remote,
          timeout: Math.max(1, Math.ceil((transfer.expires - Date.now()) / 1000)) });
      } catch (error) {
        if (['completed', 'failed'].includes(transfer.phase)) throw error;
        await this.fail(transfer);
      }
    });
  }
  async admit(transfer) {
    const call = this.calls.calls.get(transfer.callId), other = this.calls.calls.get(transfer.consultationCallId);
    if (!this.calls.accepting || !this.calls.canControl() || transfer.gone?.size || Date.now() >= transfer.expires || !this.available(call)
      || (transfer.consultationCallId && !this.available(other))) throw new Error('Transfer unavailable');
    const admitted = await this.calls.portal('POST', 'transfers', transfer.request);
    if (admitted.state !== 'pending' || admitted.id !== transfer.id || admitted.callId !== call.id
      || admitted.deviceId !== transfer.deviceId || admitted.configurationId !== call.configurationId
      || admitted.revision !== call.revision || (admitted.consultationCallId ?? undefined) !== transfer.consultationCallId) throw new Error('Transfer authority changed');
    const deadline = Date.parse(admitted.expiresAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Transfer expired');
    transfer.expires = Math.min(transfer.expires, deadline); this.save(transfer);
  }
  async complete(transfer) {
    if (!this.pending.has(transfer.id)) return;
    if (transfer.phase !== 'pending' || transfer.recovered) return this.settle(transfer);
    try {
      await this.admit(transfer);
      const call = this.calls.calls.get(transfer.callId), other = this.calls.calls.get(transfer.consultationCallId);
      const ids = [transfer.phone, transfer.remote, transfer.target, transfer.otherPhone].filter(Boolean);
      for (const id of ids) if ((await this.ari('GET', `channels/${id}`)).state !== 'Up') throw new Error('Transfer leg unavailable');
      for (const original of [call, other].filter(Boolean)) {
        const bridge = await this.ari('GET', `bridges/${original.bridge}`);
        if (bridge.channels.length !== 2 || !bridge.channels.includes(original.parent) || !bridge.channels.includes(original.winner)) throw new Error('Transfer bridge changed');
      }
      if (transfer.gone?.size || !this.calls.accepting || Date.now() >= transfer.expires) throw new Error('Transfer interrupted');
      transfer.phase = 'moving'; this.save(transfer);
      // Move both remote parties to a separate bridge. Before the atomic local
      // commit, recovery restores the two original bridges and reports failure.
      const bridge = `sipper-transfer-${transfer.id}`;
      await this.ari('POST', `bridges/${bridge}`, undefined, { type: 'mixing,proxy_media' });
      for (const id of [transfer.remote, transfer.target]) {
        if (transfer.gone?.size || !this.calls.accepting) throw new Error('Transfer interrupted');
        await this.ari('POST', `bridges/${bridge}/addChannel`, undefined, { channel: id });
      }
      const observed = await this.ari('GET', `bridges/${bridge}`);
      if (transfer.gone?.size || !this.calls.accepting || observed.channels.length !== 2
        || !observed.channels.includes(transfer.remote) || !observed.channels.includes(transfer.target)) throw new Error('Transfer interrupted');
      const continuation = { ...call, parent: transfer.remote, winner: transfer.target, bridge, transferred: true,
        parentGone: false, legs: new Map([[transfer.target, {}]]) };
      transfer.phase = 'completed';
      this.save(transfer, continuation);
      for (const original of [call, other].filter(Boolean)) {
        for (const id of [original.parent, ...original.legs.keys()]) this.calls.channels.delete(id);
      }
      if (other) { other.ended = true; this.calls.calls.delete(other.id); }
      Object.assign(call, continuation);
      for (const id of [call.parent, call.winner]) this.calls.channels.set(id, call);
    } catch {
      if (transfer.phase !== 'completed') return this.fail(transfer);
      if (this.calls.storageFailed) throw new Error('Transfer commit unavailable');
    }
    await this.settle(transfer);
  }
  async remove(path) {
    try { await this.ari('DELETE', path); } catch (error) { if (error.status !== 404) throw error; }
  }
  async fail(transfer) {
    if (this.calls.storageFailed || !this.calls.canControl()) throw new Error('Transfer recovery unavailable');
    if (transfer.phase === 'completed') return this.settle(transfer);
    const live = new Set((await this.ari('GET', 'channels')).map(channel => channel.id));
    if (transfer.phase === 'moving' || transfer.phase === 'failed') {
      for (const [bridge, ids] of [[transfer.bridge, [transfer.phone, transfer.remote]],
        [transfer.otherBridge, [transfer.otherPhone, transfer.target]]]) {
        if (!bridge) continue;
        const surviving = ids.filter(id => live.has(id));
        if (surviving.length) {
          // POST creates a bridge only when missing; an existing original bridge
          // is left intact, including its hold state.
          try { await this.ari('GET', `bridges/${bridge}`); }
          catch (error) { if (error.status !== 404) throw error; await this.ari('POST', `bridges/${bridge}`, undefined, { type: 'mixing,proxy_media' }); }
          for (const id of surviving) await this.ari('POST', `bridges/${bridge}/addChannel`, undefined, { channel: id });
        }
      }
    }
    if (!transfer.consultationCallId) await this.remove(`channels/${transfer.target}`);
    await this.remove(`bridges/sipper-transfer-${transfer.id}`);
    transfer.phase = 'failed'; this.save(transfer);
    await this.settle(transfer);
  }
  async settle(transfer) {
    if (!this.pending.has(transfer.id)) return;
    if (!['completed', 'failed'].includes(transfer.phase)) return this.fail(transfer);
    if (!transfer.cleaned) {
      await this.progress(transfer, transfer.phase === 'completed' ? 'channel_answered' : 'channel_declined');
      if (transfer.phase === 'completed') {
        for (const id of [transfer.phone, transfer.otherPhone].filter(Boolean)) await this.remove(`channels/${id}`);
        for (const id of [transfer.bridge, transfer.otherBridge].filter(Boolean)) await this.remove(`bridges/${id}`);
      }
      transfer.cleaned = true; this.save(transfer);
    }
    let result;
    try { result = await this.calls.portal('POST', `transfers/${transfer.id}`, { state: transfer.phase }); }
    catch (error) { if (error.status !== 404) throw error; }
    // A lost admission response can temporarily return 404 here. The portal's
    // pending-attempt reconciliation will cancel any admission that commits late.
    if (result?.endRequested && transfer.phase === 'completed') {
      const call = this.calls.calls.get(transfer.callId);
      if (call) { call.endReason = 'admin_ended'; this.calls.persist(call); }
    }
    try { this.calls.state.acknowledgeTransfer(transfer.id); }
    catch { this.calls.storageFailed = true; this.calls.accepting = false; this.calls.ari.emit('storageFault'); throw new Error('Transfer storage unavailable'); }
    this.pending.delete(transfer.id);
    for (const [id, value] of this.channels) if (value === transfer) this.channels.delete(id);
    for (const id of [transfer.callId, transfer.consultationCallId]) {
      const call = this.calls.calls.get(id);
      if (call?.transfer === transfer.id) delete call.transfer;
    }
  }
  async tick(recover = false) {
    for (const transfer of this.pending.values()) await this.run(transfer, async () => {
      if (['completed', 'failed'].includes(transfer.phase)) return this.settle(transfer);
      if (transfer.recovered || !this.calls.accepting || transfer.gone?.size || Date.now() >= transfer.expires) return this.fail(transfer);
      if (!recover) return;
      for (const id of [transfer.callId, transfer.consultationCallId].filter(Boolean)) {
        const status = await this.calls.portal('GET', `calls/${id}`);
        if (status.state !== 'answered' || status.endRequested) return this.fail(transfer);
      }
      // Recover a missed answer or hangup after an event-stream interruption.
      const live = new Map((await this.ari('GET', 'channels')).map(channel => [channel.id, channel]));
      if ([transfer.phone, transfer.remote, transfer.otherPhone].filter(Boolean).some(id => !live.has(id)) || !live.has(transfer.target)) return this.fail(transfer);
      if (live.get(transfer.target)?.state === 'Up') return this.complete(transfer);
    });
  }
  async reconcileOrphans() {
    const attempts = await this.calls.portal('GET', 'transfers');
    for (const attempt of attempts.transfers) if (!this.pending.has(attempt.id)) {
      try { await this.calls.portal('POST', `transfers/${attempt.id}`, { state: 'failed' }); }
      catch (error) {
        if (error.status === 404) continue; // Call retention removed the attempt.
        if (error.status !== 409) throw error;
        // A local completion may race the GET snapshot and remove its journal.
        // Confirm the terminal result; never rewrite it or mistake lost ownership
        // for a harmless conflict.
        const current = await this.calls.portal('GET', `transfers/${attempt.id}`);
        if (!['completed', 'failed'].includes(current.state)) throw error;
      }
    }
  }
}
