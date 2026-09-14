import test from 'node:test';
import assert from 'node:assert/strict';
import { fusionpbx, detect, scrapeEditPage, scrapeListPage, looksLikeHostname } from '../providers/fusionpbx.js';
import { scrapeDocument } from '../providers/index.js';
import { load, parse, fixture, editURL, listURL, UUID1, UUID2, UUID3 } from './helpers.mjs';

test('provider shape', () => {
  assert.equal(fusionpbx.id, 'fusionpbx');
  assert.equal(fusionpbx.name, 'FusionPBX');
  for (const fn of ['detect', 'scrapeEditPage', 'scrapeListPage']) assert.equal(typeof fusionpbx[fn], 'function');
});

test('looksLikeHostname', () => {
  assert.equal(looksLikeHostname('tenant.example.com'), true);
  assert.equal(looksLikeHostname('192.0.2.5'), true);
  assert.equal(looksLikeHostname('PBX.Example.COM'), true);
  assert.equal(looksLikeHostname('default'), false);
  assert.equal(looksLikeHostname('public'), false);
  assert.equal(looksLikeHostname(''), false);
  assert.equal(looksLikeHostname('has space.com'), false);
});

// ---------------------------------------------------------------- edit page: master/5.5

test('master edit page with the domain select', () => {
  const { doc, url } = load('master-edit-select.html', editURL(UUID1, '&page=0&order_by=extension&order=asc'));
  const d = detect(doc, url);
  assert.equal(d.matched, true);
  assert.equal(d.page, 'extension-edit');
  assert.equal(d.confidence, 1);
  assert.ok(d.markers.includes('theme-css'));
  assert.ok(d.markers.includes('hide-password-fields'));

  const e = scrapeEditPage(doc, url);
  assert.equal(e.extension, '1001');
  assert.equal(e.extensionSource, 'input');
  assert.equal(e.password, 'Sec"ret\'s&1', 'reads the named password input, decoded, not the decoy');
  assert.equal(e.hasPasswordField, true);
  assert.equal(e.numberAlias, '');
  assert.equal(e.effectiveCallerIdName, 'Alex Morgan');
  assert.equal(e.effectiveCallerIdNumber, '1001');
  assert.equal(e.outboundCallerIdName, 'Example Ltd', 'select-based outbound caller id');
  assert.equal(e.outboundCallerIdNumber, '441onward');
  assert.equal(e.description, 'Desk phone');
  assert.equal(e.userContext, 'tenant.example.com');
  assert.equal(e.enabled, true);
  assert.equal(e.domainName, 'tenant.example.com', 'the selected domain option wins over the header');
  assert.equal(e.domainSource, 'select');
  assert.equal(e.domainUuid, '0a1b2c3d-0000-4000-8000-000000000002');
  assert.equal(e.uuid, UUID1);
  assert.equal(e.server, 'pbx.example.com');
  assert.equal(e.title, 'Extension - FusionPBX');
  assert.ok(!('voicemailPassword' in e), 'voicemail password is never collected');
});

test('master edit page with a hidden domain_uuid uses the header domain', () => {
  const { doc, url } = load('master-edit-hidden-domain.html', editURL(UUID2));
  assert.equal(detect(doc, url).page, 'extension-edit');
  const e = scrapeEditPage(doc, url);
  assert.equal(e.extension, '1002');
  assert.equal(e.password, 'p4ss-1002');
  assert.equal(e.effectiveCallerIdName, 'Front & Desk');
  assert.equal(e.description, 'Lobby <phone>');
  assert.equal(e.enabled, false);
  assert.equal(e.outboundCallerIdName, 'Example Ltd', 'text-input outbound caller id');
  assert.equal(e.domainName, 'tenant.example.com');
  assert.equal(e.domainSource, 'header');
  assert.equal(e.domainUuid, '0a1b2c3d-0000-4000-8000-000000000002');
  assert.equal(doc.querySelector("input[name='domain_uuid']").type, 'hidden');
});

test('master edit page with the extension as plain text and no password permission', () => {
  const { doc, url } = load('master-edit-plain-extension.html', editURL(UUID3));
  assert.equal(doc.querySelector("input[name='extension']"), null);
  assert.equal(detect(doc, url).page, 'extension-edit');
  const e = scrapeEditPage(doc, url);
  assert.equal(e.extension, '1003');
  assert.equal(e.extensionSource, 'text');
  assert.equal(e.hasPasswordField, false);
  assert.equal(e.password, '');
  assert.equal(e.effectiveCallerIdName, 'Meeting Room');
  assert.equal(e.domainName, 'tenant.example.com', 'no select and no header: hostname-like user_context');
  assert.equal(e.domainSource, 'user_context');
});

test('master edit page falls back to the web host when user_context is not a hostname', () => {
  const { doc, url } = load('master-edit-default-context.html', editURL(UUID3));
  const e = scrapeEditPage(doc, url);
  assert.equal(e.userContext, 'default');
  assert.equal(e.domainName, 'pbx.example.com');
  assert.equal(e.domainSource, 'hostname');
  assert.equal(e.password, 'p4ss-1003');
  assert.equal(e.description, 'Boardroom');
});

test('domain fallback order: select > header > user_context > hostname', () => {
  const base = fixture('master-edit-select.html');
  const u = editURL(UUID1);
  const withoutSelect = base.replace(/<select class='formfld' name='domain_uuid'>[\s\S]*?<\/select>/, '');
  assert.equal(scrapeEditPage(parse(withoutSelect, u).doc, u).domainSource, 'header');
  assert.equal(scrapeEditPage(parse(withoutSelect, u).doc, u).domainName, 'other.example.com');
  const withoutHeader = withoutSelect.replace(/<a href='select:domain'[\s\S]*?<\/a>/, '');
  assert.equal(scrapeEditPage(parse(withoutHeader, u).doc, u).domainSource, 'user_context');
  const withoutContext = withoutHeader.replace(/name='user_context' maxlength='255' value="tenant.example.com"/, "name='user_context' maxlength='255' value=\"public\"");
  const last = scrapeEditPage(parse(withoutContext, u).doc, u);
  assert.equal(last.domainSource, 'hostname');
  assert.equal(last.domainName, 'pbx.example.com');
});

test('the add page is FusionPBX but not importable', () => {
  const { doc, url } = load('master-edit-add.html', `${editURL('').replace('?id=', '')}`);
  const d = detect(doc, url);
  assert.equal(d.matched, true);
  assert.equal(d.page, 'other');
  assert.equal(d.reason, 'extension-add');
  const s = scrapeDocument(doc, url);
  assert.equal(s.page, 'other');
  assert.equal(s.provider.id, 'fusionpbx');
  assert.equal(s.edit, null);
});

test('DOMParser path (as used by the popup) gives the same result as a live document', () => {
  const u = editURL(UUID1);
  const live = scrapeEditPage(load('master-edit-select.html', u).doc, u);
  const parsed = scrapeEditPage(parse(fixture('master-edit-select.html'), u).doc, u);
  assert.deepEqual(parsed, live);
});

// ---------------------------------------------------------------- edit page: 4.4.1

test('4.4.1 edit page with hidden domain and textarea description', () => {
  const { doc, url } = load('legacy-441-edit.html', editURL(UUID1));
  const d = detect(doc, url);
  assert.equal(d.page, 'extension-edit');
  assert.ok(d.markers.includes('theme-css'));
  assert.ok(d.markers.includes('main-content'));
  const e = scrapeEditPage(doc, url);
  assert.equal(e.extension, '1001');
  assert.equal(e.password, 'legacy"pass');
  assert.equal(e.effectiveCallerIdName, 'Alex Morgan');
  assert.equal(e.outboundCallerIdName, 'Example Ltd');
  assert.equal(e.description, 'Desk phone\nsecond line', 'textarea keeps its newlines');
  assert.equal(e.enabled, true);
  assert.equal(e.domainName, 'tenant.example.com');
  assert.equal(e.domainSource, 'header', 'a.domain_selector_domain in the 4.4 header');
  assert.equal(e.uuid, UUID1);
});

test('4.4.1 edit page with the domain select and a non-hostname user_context', () => {
  const { doc, url } = load('legacy-441-edit-select.html', editURL(UUID2));
  const e = scrapeEditPage(doc, url);
  assert.equal(e.extension, '1002');
  assert.equal(e.domainName, 'tenant.example.com');
  assert.equal(e.domainSource, 'select');
  assert.equal(e.userContext, 'default');
  assert.equal(e.description, '');
});

// ---------------------------------------------------------------- list page

test('master list page with show=all: domain column, registration dots, checkboxes', () => {
  const { doc, url } = load('master-list.html', listURL('?show=all'));
  const d = detect(doc, url);
  assert.equal(d.page, 'extension-list');
  const rows = scrapeListPage(doc, url);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.extension), ['1001', '1002', '1003']);
  assert.deepEqual(rows.map((r) => r.uuid), [UUID1, UUID2, UUID3]);
  assert.equal(rows[0].editURL, `https://pbx.example.com/app/extensions/extension_edit.php?id=${UUID1}&show=all`);
  assert.equal(rows[1].editURL, `https://pbx.example.com/app/extensions/extension_edit.php?id=${UUID2}&show=all&domain_uuid=0a1b2c3d-0000-4000-8000-000000000001&domain_change=true`);
  assert.deepEqual(rows.map((r) => r.callerIdName), ['Alex Morgan', 'Front & Desk', '']);
  assert.deepEqual(rows.map((r) => r.domainName), ['tenant.example.com', 'other.example.com', 'tenant.example.com']);
  assert.deepEqual(rows.map((r) => r.userContext), ['tenant.example.com', 'other.example.com', 'tenant.example.com']);
  assert.deepEqual(rows.map((r) => r.enabled), [true, false, true]);
});

test('master list page for a restricted user: no checkbox, registration or domain columns', () => {
  const { doc, url } = load('master-list-single.html', listURL());
  const rows = scrapeListPage(doc, url);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.extension), ['2001', '2002']);
  assert.deepEqual(rows.map((r) => r.callerIdName), ['Reception', 'Warehouse']);
  assert.deepEqual(rows.map((r) => r.domainName), ['', '']);
  assert.equal(rows[0].editURL, `https://pbx.example.com/app/extensions/extension_edit.php?id=${UUID1}`);
});

test('4.4.1 list page with sortable Domain column and per-row icon links', () => {
  const { doc, url } = load('legacy-441-list.html', listURL('?show=all'));
  assert.equal(detect(doc, url).page, 'extension-list');
  const rows = scrapeListPage(doc, url);
  assert.equal(rows.length, 2, 'the edit icon link does not create a second row');
  assert.deepEqual(rows.map((r) => r.extension), ['1001', '1002']);
  assert.deepEqual(rows.map((r) => r.domainName), ['tenant.example.com', 'other.example.com']);
  assert.deepEqual(rows.map((r) => r.callerIdName), ['', ''], '4.4.1 has no caller id column');
  assert.deepEqual(rows.map((r) => r.userContext), ['tenant.example.com', 'other.example.com']);
  assert.deepEqual(rows.map((r) => r.enabled), [true, false]);
  assert.equal(rows[1].editURL, `https://pbx.example.com/app/extensions/extension_edit.php?id=${UUID2}`);
});

test('scrapeDocument wraps list results', () => {
  const { doc, url } = load('master-list.html', listURL('?show=all'));
  const s = scrapeDocument(doc, url);
  assert.equal(s.provider.id, 'fusionpbx');
  assert.equal(s.page, 'extension-list');
  assert.equal(s.list.length, 3);
  assert.equal(s.edit, null);
  assert.equal(s.title, 'Extensions - FusionPBX');
  assert.equal(s.hostname, 'pbx.example.com');
});

test('a login page returned for an edit URL is not an edit page', () => {
  const { doc, url } = load('master-login.html', editURL(UUID1));
  const d = detect(doc, url);
  assert.equal(d.matched, true);
  assert.equal(d.page, 'other');
  assert.equal(d.reason, 'no-edit-form');
  assert.equal(scrapeDocument(doc, url).edit, null);
});
