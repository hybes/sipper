import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, detectProvider, scrapeDocument } from '../providers/index.js';
import { generic } from '../providers/generic.js';
import { detect } from '../providers/fusionpbx.js';
import { load, editURL } from './helpers.mjs';

test('provider registry lists FusionPBX before the generic fallback', () => {
  assert.deepEqual(providers.map((p) => p.id), ['fusionpbx', 'generic']);
});

test('a random page is not FusionPBX even with lookalike ids and paths', () => {
  const { doc, url } = load('random.html', 'https://www.example.com/');
  const d = detect(doc, url);
  assert.equal(d.matched, false);
  assert.equal(d.page, 'other');
  const s = scrapeDocument(doc, url);
  assert.equal(s.provider.id, 'generic');
  assert.equal(s.page, 'other');
  assert.equal(s.edit, null);
  assert.equal(s.list, null);
  assert.deepEqual(s.suggestion, { server: 'www.example.com', domain: 'www.example.com' });
});

test('a random page at the FusionPBX edit path without the form is not an edit page', () => {
  const { doc, url } = load('random.html', editURL('abc'));
  const s = scrapeDocument(doc, url);
  // the lookalike form#frm with input[name=extension] does exist, and the path matches:
  // that is treated as an edit page because it is exactly what FusionPBX renders.
  assert.equal(s.page, 'extension-edit');
  assert.equal(s.edit.extension, 'not-a-pbx');

  const stripped = load('random.html', editURL('abc'));
  stripped.doc.querySelector('#frm').remove();
  const s2 = scrapeDocument(stripped.doc, stripped.url);
  assert.equal(s2.page, 'other');
  assert.equal(s2.provider.id, 'fusionpbx', 'the path alone identifies FusionPBX');
  assert.equal(s2.reason, 'no-edit-form');
});

test('a FusionPBX page that is not an extension page is detected with a navigation hint', () => {
  const { doc, url } = load('master-dashboard.html', 'https://pbx.example.com/core/dashboard/index.php');
  const d = detect(doc, url);
  assert.equal(d.matched, true);
  assert.equal(d.page, 'other');
  assert.ok(d.confidence > 0.5);
  const s = scrapeDocument(doc, url);
  assert.equal(s.provider.id, 'fusionpbx');
  assert.equal(s.page, 'other');
  assert.match(s.hint, /Extensions/);
});

test('generic provider always matches with zero confidence', () => {
  const d = generic.detect();
  assert.equal(d.matched, true);
  assert.equal(d.confidence, 0);
  assert.equal(generic.scrapeEditPage(), null);
  assert.deepEqual(generic.scrapeListPage(), []);
});

test('detectProvider picks the highest confidence match', () => {
  const dash = load('master-dashboard.html', 'https://pbx.example.com/core/dashboard/index.php');
  assert.equal(detectProvider(dash.doc, dash.url).provider.id, 'fusionpbx');
  const random = load('random.html', 'https://www.example.com/');
  assert.equal(detectProvider(random.doc, random.url).provider.id, 'generic');
});
