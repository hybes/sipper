import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ManagedMeetingWindows } from '../src/main/managedMeetingWindow.js';
import { meetingCSP, meetingOrigin } from '../src/main/managedMeetings.js';
import { changeMeetingCapture, changeMeetingDevice, stopMeetingCapture } from '../src/renderer/meetingCapture.js';

const deviceId = randomUUID(), meetingId = randomUUID(), organisationId = randomUUID();
function harness(t) {
  const client = new EventEmitter(), wins = [], joins = [], leaves = [];
  const status = { signedIn: true, signingIn: false, identity: { id: 'fixture-user' }, enrollments: [{ deviceId, organisationId }], organisations: [{ id: organisationId, status: 'active', licensed: true }] };
  const details = { expiresAt: new Date(Date.now() + 30_000).toISOString(), userId: 'fixture-user', canJoin: true,
    meeting: { id: meetingId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), endedAt: null } };
  const control = { pauseJoin: null, pauseLeave: null, failure: null, keepContents: false };
  const claims = [], releases = [], state = {
    meetingAudio: null,
    ownsMeetingAudio: reference => state.meetingAudio?.reference === reference,
    claimMeetingAudio: async reference => { claims.push(reference); state.meetingAudio = { reference }; },
    releaseMeetingAudio: async (reference, options) => {
      releases.push({ reference, options }); if (state.meetingAudio?.reference === reference) state.meetingAudio = null;
    },
  };
  client.snapshot = () => structuredClone(status);
  client.meetingDetails = async () => structuredClone(details);
  client.joinMeeting = async (_device, _meeting, sessionId) => {
    joins.push(sessionId); if (control.pauseJoin) await control.pauseJoin;
    if (control.failure) throw control.failure;
    return { sessionId, url: 'wss://meet.example.invalid', token: 'fixture-only-token' };
  };
  client.leaveMeeting = async (_device, _meeting, sessionId) => { leaves.push(sessionId); if (control.pauseLeave) await control.pauseLeave; };
  client.endMeeting = async () => ({ meeting: { ...details.meeting, endedAt: new Date().toISOString() } });
  const windows = new ManagedMeetingWindows({ client, state, pageURL: 'app://sipper/src/renderer/meeting.html', createWindow: () => {
    const win = new EventEmitter(); win.webContents = new EventEmitter(); win.destroyed = false; win.urls = [];
    win.isDestroyed = () => win.destroyed;
    win.contentsDestroyed = false; win.webContents.isDestroyed = () => win.contentsDestroyed;
    win.destroy = () => { if (!win.destroyed) { win.destroyed = true;
      if (!control.keepContents) { win.contentsDestroyed = true; win.webContents.emit('destroyed'); }
      win.emit('closed'); } };
    win.loadURL = async url => win.urls.push(url); win.show = () => {}; win.focus = () => {};
    win.webContents.getURL = () => win.urls.at(-1);
    wins.push(win); return win;
  } });
  t.after(() => windows.stop());
  return { client, windows, state, status, details, control, wins, joins, leaves, claims, releases };
}

test('returning to phone waits for destroyed media contents and does not restore a former call', async t => {
  const h = harness(t); await h.windows.open(deviceId, meetingId);
  const win = h.wins[0], reference = h.windows.entry.reference;
  h.control.keepContents = true;
  const closing = h.windows.closeForPhone();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.destroyed, true); assert.equal(h.state.ownsMeetingAudio(reference), true);
  assert.equal(h.releases.length, 0, 'Native audio stays claimed until the media frame is destroyed');
  win.contentsDestroyed = true; win.webContents.emit('destroyed'); await closing;
  assert.equal(h.state.meetingAudio, null); assert.equal(h.releases.at(-1).options.restore, false);
});
test('meeting window keeps scoped grants private, gates capture and closes on observed withdrawal', async t => {
  const h = harness(t);
  await h.windows.open(deviceId, meetingId);
  const win = h.wins[0], entry = h.windows.entry;
  assert.equal(h.windows.initial(win).grant.sessionId, h.joins[0]);
  const preparedURL = win.urls.pop();
  assert.deepEqual(h.windows.initial(win), { pending: true, details: null, grant: null, error: null }, 'The loading document receives no grant even after preparation finishes');
  win.urls.push(preparedURL);
  assert.throws(() => h.windows.initial({ isDestroyed: () => false }), { code: 'access_denied' });
  assert.equal(h.windows.canCapture(win), false);
  h.windows.mediaState(win, true); assert.equal(h.windows.canCapture(win), true);
  h.windows.mediaState(win, false); assert.equal(h.windows.canCapture(win), false);
  await assert.rejects(h.windows.open(randomUUID(), meetingId), { code: 'meeting_active' });
  assert.match(h.windows.policy(entry.reference), /connect-src wss:\/\/meet.example.invalid https:\/\/meet.example.invalid;/);
  assert.match(h.windows.policy(randomUUID()), /connect-src 'none'/);
  h.status.organisations[0].licensed = false; h.client.emit('change');
  assert.equal(win.isDestroyed(), true); assert.equal(h.windows.entry, null); assert.equal(entry.grant, null);
  assert.ok(h.leaves.includes(h.joins[0]));
});
test('closing during join withdraws the exact UUID and a late grant cannot load or replace a room', async t => {
  const h = harness(t); let resume; h.control.pauseJoin = new Promise(resolve => { resume = resolve; });
  const pending = h.windows.open(deviceId, meetingId);
  while (!h.joins.length) await new Promise(resolve => setImmediate(resolve));
  const closed = h.wins[0], nonce = h.joins[0]; h.windows.close();
  assert.deepEqual(h.leaves, [nonce]);
  h.control.pauseJoin = null; await h.windows.open(deviceId, meetingId);
  const current = h.windows.entry; resume(); await pending;
  assert.equal(h.windows.entry, current); assert.equal(closed.urls.length, 1, 'Only the initial capture-free loading page was loaded');
  assert.notEqual(h.windows.initial(current.win).grant.sessionId, nonce);
  assert.equal(h.leaves.filter(id => id === nonce).length, 2, 'Late success is withdrawn again');
});
test('uncertain joins retain their UUID; retired/granted retries are serial and use a fresh UUID', async t => {
  const h = harness(t); h.control.failure = Object.assign(Error('fixture outage'), { code: 'unavailable' });
  await h.windows.open(deviceId, meetingId); const win = h.wins[0], first = h.joins[0];
  h.control.failure = null; await h.windows.retry(win);
  assert.deepEqual(h.joins, [first, first]);
  await h.windows.retire(win); assert.equal(h.windows.canCapture(win), false);
  let resume; h.control.pauseLeave = new Promise(resolve => { resume = resolve; });
  const retry = h.windows.retry(win); await h.windows.retry(win);
  h.control.pauseLeave = null; resume(); await retry;
  assert.equal(h.joins.length, 3); assert.notEqual(h.joins[2], first);
  assert.equal(h.windows.initial(win).grant.sessionId, h.joins[2]);
});
test('screen selection is bound to an active media window, expires on reconnection and defaults to video only', async t => {
  const h = harness(t); await h.windows.open(deviceId, meetingId); const win = h.wins[0], e = h.windows.entry;
  h.windows.mediaState(win, true);
  const source = { id: 'window:fixture', name: 'Example window' }, replies = [];
  const picker = () => { e.screen = { id: randomUUID(), sources: [source], audio: true, callback: value => replies.push(value) }; return e.screen.id; };
  let id = picker(); h.windows.chooseScreen(win, id, source.id, false); assert.deepEqual(replies.pop(), { video: source });
  id = picker(); h.windows.chooseScreen(win, id, source.id, true); assert.deepEqual(replies.pop(), { video: source, audio: 'loopback' });
  id = picker(); h.windows.mediaState(win, false); assert.deepEqual(replies.pop(), {});
  assert.throws(() => h.windows.chooseScreen(win, id, source.id, true), { code: 'cancelled' });
  h.windows.mediaState(win, true); id = picker();
  assert.throws(() => h.windows.chooseScreen(win, id, 'foreign-source', false), { code: 'cancelled' }); assert.deepEqual(replies.pop(), {});
  id = picker(); await h.windows.end(win); assert.deepEqual(replies.pop(), {}); assert.equal(h.windows.canCapture(win), false);
});
test('meeting origins reject credentials and paths, and insecure signalling requires isolated loopback development', () => {
  assert.equal(meetingOrigin('wss://meet.example.invalid'), 'wss://meet.example.invalid');
  assert.equal(meetingOrigin('ws://localhost:1234', true), 'ws://localhost:1234');
  for (const url of ['https://meet.example.invalid', 'ws://localhost:1234', 'wss://user:secret@meet.example.invalid', 'wss://meet.example.invalid/rtc', 'wss://meet.example.invalid/?x=1', 'wss://meet.example.invalid/#fragment']) assert.throws(() => meetingOrigin(url));
  assert.throws(() => meetingOrigin('ws://other.example.invalid', true));
  assert.ok(!meetingCSP('wss://meet.example.invalid').includes('unsafe-inline'));
});
test('capture stops both screen sources before failed unpublish and fences a late capture result', async () => {
  const stopped = [], publications = new Map(); let release;
  const track = id => ({ mediaStreamTrack: { readyState: 'live' }, stop() { stopped.push(id); this.mediaStreamTrack.readyState = 'ended'; } });
  const screen = track('screen'), sound = track('sound'); publications.set('screen_share', { track: screen }); publications.set('screen_share_audio', { track: sound });
  const room = { localParticipant: { trackPublications: publications, getTrackPublication: source => publications.get(source),
    unpublishTrack: async () => { assert.deepEqual(stopped.slice(0, 2), ['screen', 'sound']); throw Error('offline'); },
    setCameraEnabled: async () => { await new Promise(resolve => { release = resolve; }); const camera = track('camera'); publications.set('camera', { track: camera }); return { track: camera }; } } };
  await assert.rejects(changeMeetingCapture(room, 'screen_share', false, () => true));
  assert.equal(screen.mediaStreamTrack.readyState, 'ended'); assert.equal(sound.mediaStreamTrack.readyState, 'ended');
  let current = true; const enabling = changeMeetingCapture(room, 'camera', true, () => current);
  current = false; release(); await enabling;
  assert.equal(publications.get('camera').track.mediaStreamTrack.readyState, 'ended');
  publications.set('microphone', { track: track('microphone') }); stopMeetingCapture(room);
  assert.equal(publications.get('microphone').track.mediaStreamTrack.readyState, 'ended');
});
test('input changes fence late capture on leave, including rejection; speaker changes never stop the microphone', async () => {
  for (const fails of [false, true]) {
    let release, current = true, stopped = false, unpublished = false;
    const track = { stop() { stopped = true; } };
    const room = { switchActiveDevice: async (kind, id, exact) => { assert.equal(kind, 'audioinput'); assert.equal(id, ''); assert.equal(exact, false); await new Promise(resolve => { release = resolve; }); if (fails) throw Error('denied'); return true; },
      localParticipant: { getTrackPublication: () => ({ track }), unpublishTrack: async value => { assert.equal(value, track); assert.equal(stopped, true); unpublished = true; } } };
    const pending = changeMeetingDevice(room, 'audioinput', '', () => current);
    current = false; release();
    if (fails) await assert.rejects(pending); else await pending;
    assert.equal(stopped, true); assert.equal(unpublished, true);
  }
  let touched = false;
  const output = { switchActiveDevice: async () => false, localParticipant: { getTrackPublication: () => { touched = true; } } };
  await assert.rejects(changeMeetingDevice(output, 'audiooutput', 'speaker', () => true));
  assert.equal(touched, false);
  await assert.rejects(changeMeetingDevice(output, 'unknown', '', () => true));
});
