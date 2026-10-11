import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { engineExecutable, engineStartParams, startEngine } from '../support.mjs';

test('native digest backend matches independent MD5 and SHA-256 vectors', { skip: !fs.existsSync(engineExecutable) }, async t => {
  const engine = await startEngine('digest'); t.after(() => engine.shutdown());
  await engine.request('start', engineStartParams);
  for (const algorithm of ['md5', 'sha256']) {
    const hash = value => createHash(algorithm).update(value).digest('hex');
    const password = 'fictional-gateway-secret', ha1 = hash(`gateway-test:sipper.test:${password}`), ha2 = hash('REGISTER:sip:sipper.test');
    for (const qop of [false, true]) for (const precomputed of [false, true]) {
      const expected = hash(`${ha1}:fixture-nonce:${qop ? '00000001:fixture-cnonce:auth:' : ''}${ha2}`);
      assert.equal(await engine.request('testDigest', { algorithm, qop, precomputed, credential: precomputed ? ha1 : password }), expected);
    }
  }
  await assert.rejects(engine.request('testDigest', { algorithm: 'sha512-256' }), /unavailable/);
});
