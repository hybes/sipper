import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Ari } from './ari.mjs';
import { Upstreams } from './upstreams.mjs';
import { Calls } from './calls.mjs';
import { State } from './state.mjs';
import { reportRegistrations } from './registrations.mjs';
import { reportUpstreamStatus } from './upstream-status.mjs';

const env = process.env;
function required(name) { if (!env[name]) throw new Error(`Missing ${name}`); return env[name]; }
const origin = new URL(required('SIPPER_PORTAL_URL'));
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
  || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))) throw new Error('Invalid SIPPER_PORTAL_URL');
const key = required('SIPPER_GATEWAY_API_KEY');
if (key.length < 32) throw new Error('SIPPER_GATEWAY_API_KEY is too short');
const allowed = new Set(required('SIPPER_UPSTREAM_HOSTS').split(',').map(host => host.trim().toLowerCase()).filter(Boolean));
if (!allowed.size) throw new Error('SIPPER_UPSTREAM_HOSTS is empty');
const instanceId = randomUUID();
let leaseLost = false;
let leaseDeadline = 0;
async function portal(method, path, body) {
  const started = performance.now();
  const response = await fetch(new URL(`/api/gateway/${path}`, origin), { method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-sipper-controller': instanceId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    if (['gateway_lease_lost', 'gateway_already_owned'].includes(failure.code)) { leaseLost = true; calls.accepting = false; }
    const error = new Error(`Gateway API failed (${response.status})`); error.status = response.status; throw error;
  }
  const result = await response.json();
  // Server ownership lasts 30 seconds. Count from before the request with a
  // safety margin, without depending on wall-clock agreement between hosts.
  if (path === 'heartbeat') leaseDeadline = started + 25_000;
  return result;
}
const ari = new Ari({ url: env.SIPPER_ARI_URL ?? 'http://127.0.0.1:8088/ari', password: required('SIPPER_ARI_PASSWORD') });
const upstreams = new Upstreams(ari, allowed), calls = new Calls(ari, portal, upstreams);
calls.accepting = false;
let stopping = false, owned = false, storageFailed = false, routesNeedCheck = true, nextRefresh = 0, state, recovery, registrationPoll;
calls.canControl = () => ari.connected && !leaseLost && !storageFailed && performance.now() < leaseDeadline;
ari.on('storageFault', () => { storageFailed = true; calls.accepting = false; });
ari.on('fault', () => { calls.accepting = false; nextRefresh = 0; ari.close(); });
ari.on('disconnected', () => { calls.accepting = false; nextRefresh = 0; });
ari.on('event', event => {
  if (event.type === 'ApplicationReplaced') { leaseLost = true; calls.accepting = false; }
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { stopping = true; calls.accepting = false; nextRefresh = 0; });
try {
  const ownership = await portal('POST', 'heartbeat', { instanceId, ready: false });
  owned = true;
  if (typeof ownership.gatewayId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(ownership.gatewayId)) throw new Error('Gateway identity unavailable');
  state = new State(required('SIPPER_STATE_FILE'), instanceId, `${ownership.gatewayId}|${origin.origin}|${ari.url.href}`);
  calls.state = state; upstreams.state = state;
  recovery = state.load(); calls.restore(recovery);
  while (!leaseLost && !storageFailed && (!stopping || calls.calls.size || calls.pendingEnds.size || calls.transfers.pending.size)) {
    if (Date.now() >= nextRefresh) {
      nextRefresh = Date.now() + 10_000;
      try {
        // Establish ownership before (re)connecting: a second WebSocket would
        // otherwise replace the current controller's event subscription.
        await portal('POST', 'heartbeat', { instanceId, ready: ari.connected && calls.accepting && !stopping });
        if (!ari.connected) { routesNeedCheck = true; await ari.connect(); }
        const info = await ari.request('GET', 'asterisk/info'), startedAt = info.status?.startup_time;
        if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) throw new Error('Asterisk startup identity unavailable');
        if (calls.asteriskStartedAt && calls.asteriskStartedAt !== startedAt) {
          calls.accepting = false; routesNeedCheck = true;
          await portal('POST', 'heartbeat', { instanceId, ready: false });
        }
        calls.asteriskStartedAt = startedAt;
        if (recovery) await calls.verifyRecovery();
        // The event connection can recover after Asterisk itself restarted.
        // Reuse complete live routes; recreate missing ones from fresh policy.
        if (routesNeedCheck) { await upstreams.restore(recovery?.routes ?? [...upstreams.accounts.values()]); routesNeedCheck = false; }
        recovery = undefined;
        await calls.reconcile();
        const snapshot = await portal('GET', 'upstreams');
        await upstreams.reconcile(snapshot.accounts, calls.inUse);
        const readiness = await portal('POST', 'heartbeat', { instanceId, ready: ari.connected && !stopping });
        calls.accepting = ari.connected && !stopping && !leaseLost && !storageFailed;
        if (calls.accepting && !registrationPoll) {
          const current = () => calls.accepting && !stopping && !leaseLost;
          // Capture before reading Asterisk. A late snapshot cannot be relabelled
          // with the generation issued after readiness recovers.
          const report = (method, path, body) => portal(method, path, { ...body, registrationGeneration: readiness.registrationGeneration });
          registrationPoll = Promise.allSettled([
            reportRegistrations(ari, report, snapshot.endpoints, current),
            ...(env.SIPPER_AMI_PASSWORD ? [reportUpstreamStatus({ url: env.SIPPER_AMI_URL, password: env.SIPPER_AMI_PASSWORD },
              report, [...upstreams.accounts.values()], current)] : []),
          ]).then(results => { if (results.some(result => result.status === 'rejected')) throw new Error('Registration reporting unavailable'); })
            .catch(() => console.error('Gateway registration reporting unavailable; previous records will become stale.'))
            .finally(() => { registrationPoll = undefined; });
        }
      } catch (error) {
        calls.accepting = false;
        if (!leaseLost) await portal('POST', 'heartbeat', { instanceId, ready: false }).catch(() => {});
        // Existing bridged calls keep running during a portal outage.
        console.error(error.code === 'recovery_state_missing'
          ? 'Gateway recovery records do not match live calls; restore the correct state volume. New calls are paused.'
          : 'Gateway refresh unavailable; new calls are paused.');
      }
    }
    if (ari.connected && !leaseLost && !storageFailed) await calls.tick();
    await delay(500);
  }
} catch {
  console.error('Gateway controller could not start. Check private service connectivity and configuration.');
  process.exitCode = 1;
} finally {
  calls.accepting = false;
  await registrationPoll;
  // Only the owner may withdraw routes. Preserve live conversations when a
  // process loses its lease; the replacement must reconcile them separately.
  if (owned && !leaseLost) {
    await portal('POST', 'heartbeat', { instanceId, ready: false }).catch(() => {});
    if (!leaseLost && !storageFailed && !calls.calls.size) {
      for (const id of upstreams.accounts.keys()) await upstreams.remove(id).catch(() => {});
      await portal('POST', 'release', {}).catch(() => {});
    }
  }
  ari.close();
  state?.close();
  if (storageFailed) { console.error('Gateway recovery storage failed; new calls are paused. Repair storage before restarting.'); process.exitCode = 1; }
  if (leaseLost) { console.error('Gateway controller ownership was lost; exiting without changing the replacement’s routes.'); process.exitCode = 1; }
}
