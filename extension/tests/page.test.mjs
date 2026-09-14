import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { capturePage, fetchSameOrigin } from '../page.js';
import { scrapeDocument } from '../providers/index.js';
import { fixture, parse, editURL, UUID1, EXT_ROOT } from './helpers.mjs';

function withGlobals(window, fn) {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  globalThis.document = window.document;
  globalThis.location = window.location;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

test('page.js functions are self-contained (no imports, no module-scope references)', () => {
  const source = readFileSync(new URL('page.js', EXT_ROOT), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /^(const|let|var)\s/m, 'no module-scope bindings that would be lost on serialisation');
  assert.match(String(capturePage), /^function capturePage\(\)/);
  assert.match(String(fetchSameOrigin), /^async function fetchSameOrigin\(url\)/);
});

test('capturePage returns the page and reflects live form values without touching the page', () => {
  const url = editURL(UUID1);
  const dom = new JSDOM(fixture('master-edit-select.html'), { url });
  const { document } = dom.window;
  document.querySelector("input[name='password']").value = 'changed-by-user';
  document.querySelector("select[name='domain_uuid']").value = '0a1b2c3d-0000-4000-8000-000000000003';
  document.querySelector("input[name='description']").value = 'edited';

  const captured = withGlobals(dom.window, () => capturePage());
  assert.equal(captured.url, url);
  assert.equal(captured.title, 'Extension - FusionPBX');
  assert.ok(captured.html.startsWith('<html'));

  const { doc } = parse(captured.html, url);
  const s = scrapeDocument(doc, new URL(url));
  assert.equal(s.page, 'extension-edit');
  assert.equal(s.edit.password, 'changed-by-user');
  assert.equal(s.edit.domainName, 'third.example.com');
  assert.equal(s.edit.description, 'edited');

  // The live page keeps its original attributes: the clone was modified, not the document.
  assert.equal(document.querySelector("input[name='password']").getAttribute('value'), 'Sec"ret\'s&1');
  assert.equal(document.querySelector("select[name='domain_uuid'] option[selected]").textContent, 'tenant.example.com');
});

test('fetchSameOrigin refuses other origins and reports fetch failures as data', async () => {
  const dom = new JSDOM('<p>x</p>', { url: 'https://pbx.example.com/app/extensions/extensions.php' });
  const calls = [];
  dom.window.fetch = async (href, init) => {
    calls.push({ href, init });
    return { ok: true, status: 200, url: href, text: async () => '<html><body>ok</body></html>' };
  };
  const results = await withGlobals(dom.window, () => {
    globalThis.fetch = dom.window.fetch;
    return Promise.all([
      fetchSameOrigin('https://evil.example.net/x'),
      fetchSameOrigin(`extension_edit.php?id=${UUID1}`),
    ]);
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, 'Not on this site');
  assert.equal(results[1].ok, true);
  assert.equal(results[1].html, '<html><body>ok</body></html>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].href, `https://pbx.example.com/app/extensions/extension_edit.php?id=${UUID1}`);
  assert.equal(calls[0].init.credentials, 'same-origin');

  const failing = await withGlobals(dom.window, () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    return fetchSameOrigin('extension_edit.php?id=x');
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'network down');
});
