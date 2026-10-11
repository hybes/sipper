import { randomUUID } from 'node:crypto';
import { Transfers } from './transfers.mjs';

const destination = /^[a-zA-Z0-9_.+*#-]{1,128}$/;
const deviceEndpoint = /^d[a-f0-9]{32}$/;
const cleanCaller = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);

/** Asterisk owns SIP/dialog/media handling; this controls only admitted legs. */
export class Calls {
  constructor(ari, portal, upstreams, state) {
    this.ari = ari; this.portal = portal; this.upstreams = upstreams; this.state = state;
    this.calls = new Map(); this.channels = new Map(); this.pendingEnds = new Map(); this.accepting = true;
    this.canControl = () => true;
    this.transfers = new Transfers(this);
    this.listener = event => this.event(event);
    ari.on('event', this.listener);
  }
  persist(call) {
    try { this.state?.save(call); }
    catch { this.storageFailed = true; this.accepting = false; this.ari.emit('storageFault'); throw new Error('Gateway recovery storage unavailable'); }
  }
  acknowledge(id) {
    try { this.state?.acknowledged(id); this.pendingEnds.delete(id); }
    catch { this.storageFailed = true; this.accepting = false; this.ari.emit('storageFault'); }
  }
  restore(snapshot) {
    for (const value of snapshot.calls) {
      const call = { ...value, legs: new Map(value.legs), nextDial: new Map(), recovered: true, ended: false };
      this.calls.set(call.id, call);
      for (const id of [call.parent, ...call.legs.keys()]) this.channels.set(id, call);
    }
    for (const { id, reason } of snapshot.endings) this.pendingEnds.set(id, reason);
    this.transfers.restore(snapshot.transfers);
  }
  async verifyRecovery() {
    const app = await this.ari.request('GET', 'applications/sipper');
    if (!Array.isArray(app.channel_ids) || app.channel_ids.some(id => !this.channels.has(id) && !this.transfers.channels.has(id))) {
      const error = new Error('Recovery records do not match live Asterisk calls');
      error.code = 'recovery_state_missing'; throw error;
    }
  }
  get inUse() { return new Set([...this.calls.values()].map(call => call.upstream).filter(Boolean)); }
  queue(call, action, preserveOnError = false) {
    call.work = (call.work ?? Promise.resolve()).catch(() => {}).then(action).catch(error => {
      if (preserveOnError) throw error;
      if (!this.storageFailed) return this.end(call, 'failed');
    });
    return call.work;
  }
  event(event) {
    if (this.transfers.event(event)) return;
    const channelId = event.channel?.id;
    if (!channelId) return;
    const existing = this.channels.get(channelId);
    if (event.type === 'StasisStart') {
      if (existing) {
        if (channelId !== existing.parent) this.queue(existing, () => this.answered(existing, channelId));
        return;
      }
      const args = event.args ?? [];
      if (!this.accepting || !['incoming', 'outgoing'].includes(args[0])) {
        void this.hangup(channelId).catch(() => this.ari.emit('fault')); return;
      }
      const call = { id: randomUUID(), parent: channelId, incoming: args[0] === 'incoming', asteriskStartedAt: this.asteriskStartedAt, legs: new Map(), nextDial: new Map(), expires: Date.now() + 45_000, ended: false, connected: false };
      try { this.persist(call); }
      catch { void this.hangup(channelId).catch(() => this.ari.emit('fault')); return; }
      this.calls.set(call.id, call); this.channels.set(channelId, call);
      this.queue(call, () => this.start(call, args, event.channel));
    } else if (existing && ['StasisEnd', 'ChannelDestroyed'].includes(event.type)) {
      if (channelId === existing.parent) existing.parentGone = true;
      this.queue(existing, async () => {
        if (channelId === existing.parent || channelId === existing.winner || !existing.incoming) {
          await this.end(existing, existing.connected ? 'completed' : channelId === existing.parent ? 'caller_cancelled' : 'rejected');
        } else {
          const leg = existing.legs.get(channelId);
          if (!existing.connected && event.type === 'ChannelDestroyed' && [17, 21].includes(event.cause) && leg?.deviceId) {
            await this.portal('POST', `calls/${existing.id}`, { event: 'decline', deviceId: leg.deviceId });
          }
          existing.legs.delete(channelId); this.channels.delete(channelId);
          this.persist(existing);
        }
      });
    }
  }
  async start(call, args, channel) {
    if (call.incoming) {
      if (args.length !== 2) throw new Error('Invalid incoming route');
      const upstream = this.upstreams.accounts.get(args[1]);
      if (!upstream) throw new Error('Unknown incoming route');
      call.upstream = upstream.id;
      call.configurationId = upstream.configurationId; call.revision = upstream.revision;
      // Persist the possible server-side creation before making the request;
      // a lost response must still leave an end report to retry after recovery.
      call.reported = true; this.persist(call);
      const created = await this.portal('POST', 'calls', { callId: call.id, configurationId: upstream.configurationId, configurationRevision: upstream.revision,
        caller: { name: cleanCaller(channel.caller?.name), number: cleanCaller(channel.caller?.number) }, ringSeconds: 45 });
      if (created.state === 'ended' || call.parentGone) return this.end(call, call.parentGone ? 'caller_cancelled' : 'rejected');
      if (created.endRequested) return this.end(call, 'admin_ended');
      await this.ari.request('POST', `channels/${call.parent}/ring`);
      await this.poll(call);
    } else {
      if (args.length !== 3 || !deviceEndpoint.test(args[1]) || !destination.test(args[2])) throw new Error('Invalid outgoing route');
      call.deviceEndpoint = args[1]; call.destination = args[2];
      call.reported = true; this.persist(call);
      const admission = await this.portal('POST', 'outgoing', { callId: call.id, endpoint: call.deviceEndpoint, destination: call.destination });
      if (admission.endRequested) return this.end(call, 'admin_ended');
      const upstream = this.upstreams.get(admission.configurationId, admission.revision);
      if (!upstream || call.parentGone) throw new Error('Calling route unavailable');
      call.upstream = upstream.id; call.configurationId = admission.configurationId; call.revision = admission.revision; call.originDeviceId = admission.deviceId;
      this.persist(call);
      await this.ari.request('POST', `channels/${call.parent}/ring`);
      await this.dial(call, `PJSIP/${encodeURIComponent(call.destination)}@${upstream.id}`);
    }
  }
  async dial(call, endpoint, deviceId) {
    if (call.ended || call.parentGone) return;
    const id = randomUUID(); call.legs.set(id, { deviceId }); this.channels.set(id, call);
    this.persist(call);
    try {
      await this.ari.request('POST', 'channels', { variables: call.incoming ? { 'PJSIP_HEADER(add,X-Sipper-Call-ID)': call.id } : {} },
        { endpoint, app: 'sipper', appArgs: `leg,${call.id}`, channelId: id, timeout: Math.max(1, Math.ceil((call.expires - Date.now()) / 1000)),
          // Mobile offers use the device codec order rather than inheriting the
          // upstream's narrowband preference. Asterisk bridges/transcodes the legs.
          ...(call.incoming ? { formats: 'opus,g722,ulaw,alaw' } : { originator: call.parent }) });
      if (call.ended || call.parentGone) await this.hangup(id);
    } catch (error) {
      call.legs.delete(id); this.channels.delete(id);
      this.persist(call);
      if (!call.incoming) throw error;
    }
  }
  async answered(call, id) {
    const leg = call.legs.get(id);
    if (call.connected && id === call.winner) return;
    if (!leg || call.ended || call.parentGone || call.connected) return this.hangup(id);
    if (call.incoming) {
      try {
        const answer = await this.portal('POST', `calls/${call.id}`, { event: 'answer', deviceId: leg.deviceId });
        if (answer.endRequested) return this.end(call, 'admin_ended');
      }
      catch { await this.hangup(id); call.legs.delete(id); this.channels.delete(id); this.persist(call); return; }
    } else {
      const admitted = await this.portal('POST', 'outgoing', { callId: call.id, endpoint: call.deviceEndpoint, destination: call.destination });
      if (admitted.endRequested) return this.end(call, 'admin_ended');
      if (admitted.configurationId !== call.configurationId || admitted.revision !== call.revision) throw new Error('Calling route changed');
    }
    if (call.parentGone || call.ended) return this.end(call, 'caller_cancelled');
    call.bridge = `sipper-${call.id}`; call.winner = id;
    this.persist(call);
    await this.ari.request('POST', `bridges/${call.bridge}`, undefined, { type: 'mixing,proxy_media' });
    await this.ari.request('POST', `bridges/${call.bridge}/addChannel`, undefined, { channel: `${call.parent},${id}` });
    const connected = await this.portal('POST', `calls/${call.id}`, { event: 'connected', deviceId: call.incoming ? leg.deviceId : call.originDeviceId });
    if (connected.endRequested) return this.end(call, 'admin_ended');
    if (call.parentGone) return this.end(call, 'caller_cancelled');
    await this.ari.request('POST', `channels/${call.parent}/answer`);
    call.connected = true; call.winner = id;
    this.persist(call);
    for (const other of call.legs.keys()) if (other !== id) await this.hangup(other);
  }
  async poll(call) {
    if (call.ended || call.connected) return;
    const state = await this.portal('GET', `calls/${call.id}`);
    if (state.state === 'ended') return this.end(call, state.reason ?? 'rejected');
    if (state.endRequested) return this.end(call, 'admin_ended');
    if (call.parentGone || Date.now() >= call.expires) return this.end(call, call.parentGone ? 'caller_cancelled' : 'timed_out');
    if (!call.incoming) return;
    const eligible = new Set(state.targets.map(target => target.deviceId));
    for (const [id, leg] of call.legs) if (!eligible.has(leg.deviceId)) { await this.hangup(id); call.legs.delete(id); this.channels.delete(id); }
    for (const target of state.targets) {
      if (state.winnerDeviceId && state.winnerDeviceId !== target.deviceId) continue;
      if (!deviceEndpoint.test(target.username) || [...call.legs.values()].some(leg => leg.deviceId === target.deviceId) || (call.nextDial.get(target.deviceId) ?? 0) > Date.now()) continue;
      call.nextDial.set(target.deviceId, Date.now() + 2000);
      await this.dial(call, `PJSIP/${target.username}`, target.deviceId);
    }
  }
  async tick() {
    try { await this.transfers.tick(); }
    catch { this.accepting = false; this.ari.emit('fault'); }
    await Promise.all([...this.calls.values()].filter(call => !call.recovered && (!call.connected || call.endReason)).map(call => this.queue(call, () => call.endReason ? this.end(call, call.endReason) : this.poll(call))));
    for (const [id, reason] of this.pendingEnds) {
      try {
        await this.portal('POST', `calls/${id}`, { event: 'ended', reason });
        this.acknowledge(id);
      } catch (error) {
        if (error.status === 404) this.acknowledge(id);
      }
    }
  }
  async reconcile() {
    // Transfer recovery owns both original calls until bridge restoration or the
    // committed continuation has been reconciled. Do this before ordinary calls.
    let transferFailure;
    if (this.state) { try { await this.transfers.tick(true); } catch (error) { transferFailure = error; } }
    // WebSocket events are not replayed. Compare only legs known before the
    // snapshot so a concurrently originated leg cannot look like a lost one.
    const known = [...this.calls.values()].map(call => ({ call, legs: [...call.legs.keys()] }));
    const live = new Map((known.length ? await this.ari.request('GET', 'channels') : []).map(channel => [channel.id, channel]));
    await Promise.all(known.map(({ call, legs }) => this.queue(call, async () => {
      if (call.ended) return;
      if (this.transfers.reserved(call)) return;
      if (call.endReason) return this.end(call, call.endReason);
      if (call.asteriskStartedAt && this.asteriskStartedAt && call.asteriskStartedAt !== this.asteriskStartedAt) return this.end(call, 'failed');
      if (call.reported) {
        const status = await this.portal('GET', `calls/${call.id}`);
        if (status.state === 'ended') return this.end(call, status.reason ?? 'completed');
        if (status.endRequested) return this.end(call, 'admin_ended');
      }
      if (call.recovered) {
        let bridge;
        if (call.bridge) {
          try { bridge = await this.ari.request('GET', `bridges/${call.bridge}`); }
          catch (error) { if (error.status !== 404) throw error; }
        }
        const survived = live.get(call.parent)?.state === 'Up' && live.get(call.winner)?.state === 'Up'
          && bridge?.channels.includes(call.parent) && bridge.channels.includes(call.winner);
        if (!survived) return this.end(call, call.connected ? 'completed' : 'failed');
        if (call.reported && !call.transferred) {
          const status = await this.portal('POST', `calls/${call.id}`, { event: 'connected', deviceId: call.incoming ? call.legs.get(call.winner)?.deviceId : call.originDeviceId });
          if (status.endRequested) return this.end(call, 'admin_ended');
        }
        call.connected = true; call.recovered = false; this.persist(call);
        for (const id of legs) if (id !== call.winner) await this.hangup(id);
      }
      if (!live.has(call.parent) || (call.connected && legs.includes(call.winner) && !live.has(call.winner))) {
        return this.end(call, call.connected ? 'completed' : 'caller_cancelled');
      }
      for (const id of legs) {
        if (!call.legs.has(id)) continue;
        if (!live.has(id)) {
          call.legs.delete(id); this.channels.delete(id);
          if (!call.incoming) return this.end(call, 'failed');
        } else if (!call.connected && live.get(id).state === 'Up') await this.answered(call, id);
      }
    }, true)));
    if (transferFailure) throw transferFailure;
    if (this.state) await this.transfers.reconcileOrphans();
  }
  async hangup(id) {
    try { await this.ari.request('DELETE', `channels/${id}`); } catch (error) { if (error.status !== 404) throw error; }
  }
  async end(call, reason) {
    if (call.ended) return;
    call.endReason ??= reason; this.persist(call);
    const results = await Promise.allSettled([call.parent, ...call.legs.keys()].map(id => this.hangup(id)));
    if (call.bridge) {
      try { await this.ari.request('DELETE', `bridges/${call.bridge}`); }
      catch (error) { if (error.status !== 404) results.push({ status: 'rejected', reason: error }); }
    }
    if (results.some(result => result.status === 'rejected')) { this.ari.emit('fault'); return; }
    try { this.state?.finish(call); }
    catch { this.storageFailed = true; this.accepting = false; this.ari.emit('storageFault'); return; }
    call.ended = true;
    if (call.reported) this.pendingEnds.set(call.id, call.endReason);
    for (const id of [call.parent, ...call.legs.keys()]) this.channels.delete(id);
    this.calls.delete(call.id);
  }
}
