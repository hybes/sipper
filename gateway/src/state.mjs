import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/** Local recovery metadata only. Never persist SIP settings, caller data or destinations. */
export class State {
  constructor(path, instanceId, binding) {
    if (!isAbsolute(path)) throw new Error('Gateway state path must be absolute');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error('Gateway state directory must be private');
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd); chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS endings (id TEXT PRIMARY KEY, reason TEXT NOT NULL);`);
    this.owner = instanceId;
    const previous = this.db.prepare('SELECT binding FROM identity WHERE id=1').get();
    if (previous && previous.binding !== binding) { this.db.close(); throw new Error('Gateway state belongs to another service'); }
    this.db.prepare('INSERT INTO identity VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner').run(binding, instanceId);
  }
  change(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT owner FROM identity WHERE id=1').get().owner !== this.owner) throw new Error('Gateway state ownership changed');
      work(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  load() {
    return { calls: this.db.prepare('SELECT data FROM calls').all().map(row => JSON.parse(row.data)),
      routes: this.db.prepare('SELECT data FROM routes').all().map(row => JSON.parse(row.data)),
      transfers: this.db.prepare('SELECT data FROM transfers').all().map(row => JSON.parse(row.data)),
      endings: this.db.prepare('SELECT id,reason FROM endings').all() };
  }
  save(call) {
    this.change(() => this.writeCall(call));
  }
  writeCall(call) {
    const data = { id: call.id, parent: call.parent, incoming: call.incoming, expires: call.expires,
      upstream: call.upstream, reported: call.reported, bridge: call.bridge, winner: call.winner,
      connected: call.connected, endReason: call.endReason, originDeviceId: call.originDeviceId, asteriskStartedAt: call.asteriskStartedAt,
      configurationId: call.configurationId, revision: call.revision, transferred: call.transferred,
      legs: [...call.legs].map(([id, leg]) => [id, { deviceId: leg.deviceId }]) };
    this.db.prepare('INSERT OR REPLACE INTO calls VALUES (?,?)').run(call.id, JSON.stringify(data));
  }
  transfer(value, continuation) {
    const data = Object.fromEntries(['id', 'callId', 'consultationCallId', 'deviceId', 'phone', 'remote', 'target',
      'otherPhone', 'bridge', 'otherBridge', 'phase', 'expires', 'cleaned', 'asteriskStartedAt'].map(key => [key, value[key]]));
    this.change(() => {
      this.db.prepare('INSERT OR REPLACE INTO transfers VALUES (?,?)').run(value.id, JSON.stringify(data));
      // The new topology and its outcome must survive together. The consultation
      // leg now belongs to the continuing call, so it must not get an end outbox.
      if (continuation) {
        this.writeCall(continuation);
        if (value.consultationCallId) this.db.prepare('DELETE FROM calls WHERE id=?').run(value.consultationCallId);
      }
    });
  }
  acknowledgeTransfer(id) { this.change(() => this.db.prepare('DELETE FROM transfers WHERE id=?').run(id)); }
  route(route) {
    this.change(() => this.db.prepare('INSERT OR REPLACE INTO routes VALUES (?,?)').run(route.id,
      JSON.stringify({ id: route.id, configurationId: route.configurationId, revision: route.revision })));
  }
  removeRoute(id) { this.change(() => this.db.prepare('DELETE FROM routes WHERE id=?').run(id)); }
  finish(call) {
    this.change(() => {
      if (call.reported) this.db.prepare('INSERT OR REPLACE INTO endings VALUES (?,?)').run(call.id, call.endReason);
      this.db.prepare('DELETE FROM calls WHERE id=?').run(call.id);
    });
  }
  acknowledged(id) { this.change(() => this.db.prepare('DELETE FROM endings WHERE id=?').run(id)); }
  close() { this.db.close(); }
}
