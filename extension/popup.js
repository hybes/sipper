// Popup controller. Reads the active tab through the two functions in page.js, parses
// the captured HTML with DOMParser here in the popup (providers/), and hands accounts to
// Sipper through native messaging when it is set up, otherwise through a sipper:// URL.

import { scrapeDocument } from './providers/index.js';
import { capturePage, fetchSameOrigin } from './page.js';
import {
  MAX_PAYLOAD_BYTES,
  buildDocument,
  buildHandoffURL,
  defaultLabel,
  defaultPort,
  normaliseTransport,
  payloadSize,
  validateAccount,
} from './payload.js';

const NATIVE_HOST = 'com.hybes.sipper';
const FETCH_CAP = 50;
const PING_TIMEOUT_MS = 1500;
const SEND_TIMEOUT_MS = 8000;
const VIEWS = ['loading', 'message', 'account', 'list', 'progress', 'result'];

const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  pageURL: null,
  scrape: null,
  native: { checked: false, available: false, version: '', error: '' },
  settings: { transport: 'udp', port: '', server: '' },
  accountMode: 'manual', // 'edit' | 'manual'
  cancelled: false,
  previousView: 'message',
};

// ---------------------------------------------------------------------------
// Small DOM helpers

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  if (view !== 'progress' && view !== 'result') state.previousView = view;
}

function setText(id, text) {
  $(id).textContent = text || '';
}

function setList(id, items) {
  const el = $(id);
  el.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    el.appendChild(li);
  }
  el.hidden = items.length === 0;
}

function setError(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.hidden = !text;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function safeURL(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function showMessage(text, hint) {
  setText('message-text', text);
  setText('message-hint', hint);
  show('message');
}

function showResult(text, { failures = [], notes = [] } = {}) {
  setText('result-text', text);
  setList('result-notes', notes);
  setList('result-failures', failures.map((f) => `${f.extension}: ${f.error}`));
  show('result');
}

// ---------------------------------------------------------------------------
// Chrome plumbing

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function runInPage(func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, func, args });
  return results && results[0] ? results[0].result : undefined;
}

function sendNative(message, timeoutMs) {
  return new Promise((resolve) => {
    if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== 'function') {
      resolve({ ok: false, error: 'Native messaging is not available in this browser.' });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'No reply from Sipper.' }), timeoutMs);
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) finish({ ok: false, error: err.message || 'Native messaging failed.' });
        else if (response && typeof response === 'object') finish(response);
        else finish({ ok: false, error: 'Unexpected reply from Sipper.' });
      });
    } catch (error) {
      finish({ ok: false, error: String((error && error.message) || error) });
    }
  });
}

async function probeNative() {
  const reply = await sendNative({ type: 'ping' }, PING_TIMEOUT_MS);
  if (reply.ok && reply.type === 'pong') return { checked: true, available: true, version: String(reply.version || ''), error: '' };
  return { checked: true, available: false, version: '', error: String(reply.error || 'Unexpected reply') };
}

function settingsKey(hostname) {
  return `connection:${hostname}`;
}

async function loadSettings(hostname) {
  const defaults = { transport: 'udp', port: '', server: '' };
  if (!hostname || !chrome.storage || !chrome.storage.local) return defaults;
  try {
    const stored = await chrome.storage.local.get(settingsKey(hostname));
    const saved = stored && stored[settingsKey(hostname)];
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      transport: normaliseTransport(saved.transport),
      port: saved.port ? String(saved.port) : '',
      server: typeof saved.server === 'string' ? saved.server : '',
    };
  } catch {
    return defaults;
  }
}

function saveSettings(hostname, { transport, port, server }) {
  if (!hostname || !chrome.storage || !chrome.storage.local) return Promise.resolve();
  const value = { transport: normaliseTransport(transport), port: String(port || '').trim(), server: String(server || '').trim() };
  return chrome.storage.local.set({ [settingsKey(hostname)]: value }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Footer: what will happen on "Add"

function renderFooter() {
  const n = state.native;
  let text;
  if (!n.checked) {
    text = 'Checking for Sipper…';
  } else if (n.available) {
    text = `Sipper is installed${n.version ? ` (${n.version})` : ''}. Accounts are sent straight to the app.`;
  } else {
    text = 'Sipper’s browser link isn’t set up, so adding opens a sipper:// link and Chrome asks to open Sipper. Nothing happens if Sipper isn’t installed. To skip the prompt, turn on the browser extension in Sipper’s Settings.';
  }
  setText('sipper-status', text);
}

// ---------------------------------------------------------------------------
// Account form (edit page and manual entry)

function fillConnection(prefix, { server, port, transport }) {
  $(`${prefix}-server`).value = server || '';
  $(`${prefix}-port`).value = port || '';
  $(`${prefix}-transport`).value = normaliseTransport(transport);
  $(`${prefix}-port`).placeholder = String(defaultPort(transport));
}

function readConnection(prefix) {
  return {
    server: $(`${prefix}-server`).value.trim(),
    port: $(`${prefix}-port`).value.trim(),
    transport: normaliseTransport($(`${prefix}-transport`).value),
    profile: $(`${prefix}-profile`).value.trim(),
  };
}

function renderEdit(scrape) {
  const e = scrape.edit;
  state.accountMode = 'edit';
  setText('page-status', `${scrape.provider.name} · extension ${e.extension}`);
  const where = e.domainName && e.domainName !== scrape.hostname ? `${scrape.hostname} (domain ${e.domainName})` : scrape.hostname;
  setText('account-intro', `Read from ${where}. Check the details, then add.`);

  $('account-label').value = defaultLabel({ username: e.extension, callerIdName: e.effectiveCallerIdName, domain: e.domainName });
  $('account-display-name').value = e.effectiveCallerIdName || '';
  $('account-username').value = e.extension;
  $('account-password').value = e.password || '';
  $('account-domain').value = e.domainName || '';
  fillConnection('account', { server: state.settings.server || scrape.hostname, port: state.settings.port, transport: state.settings.transport });
  $('account-profile').value = e.domainName || scrape.hostname;

  const notes = [];
  if (!e.hasPasswordField) notes.push('The password isn’t shown on this page (your FusionPBX user lacks the permission). Enter it by hand.');
  else if (!e.password) notes.push('The password field on this page is empty. Enter it by hand.');
  if (e.domainSource === 'hostname') notes.push('The SIP domain was taken from the web address. Change it if this PBX uses a different domain name.');
  if (e.domainSource === 'user_context') notes.push('The SIP domain was taken from the User Context field.');
  if (e.enabled === false) notes.push('This extension is disabled in FusionPBX; it will not register until it is enabled.');
  setList('account-notes', notes);
  setError('account-error', '');
  $('account-back').hidden = true;
  show('account');
  $('account-label').focus();
}

function prefillManual() {
  const host = state.pageURL ? state.pageURL.hostname : '';
  state.accountMode = 'manual';
  setText('account-intro', host ? `Enter the account details by hand. Server and domain default to ${host}.` : 'Enter the account details by hand.');
  $('account-label').value = '';
  $('account-display-name').value = '';
  $('account-username').value = '';
  $('account-password').value = '';
  $('account-domain').value = host;
  fillConnection('account', { server: state.settings.server || host, port: state.settings.port, transport: state.settings.transport });
  $('account-profile').value = host;
  setList('account-notes', []);
  setError('account-error', '');
  $('account-back').hidden = false;
}

function readAccountForm() {
  const edit = state.accountMode === 'edit' && state.scrape ? state.scrape.edit : null;
  const conn = readConnection('account');
  return {
    label: $('account-label').value,
    displayName: $('account-display-name').value,
    username: $('account-username').value,
    password: $('account-password').value,
    domain: $('account-domain').value,
    server: conn.server,
    port: conn.port,
    transport: conn.transport,
    callerIdName: edit ? edit.effectiveCallerIdName : '',
    callerIdNumber: edit ? edit.effectiveCallerIdNumber : '',
    notes: edit ? edit.description : '',
  };
}

function sourceFor(providerId) {
  const s = state.scrape;
  return {
    provider: providerId,
    url: s ? s.url : state.pageURL ? state.pageURL.href : '',
    title: s ? s.title : state.tab ? state.tab.title || '' : '',
  };
}

function buildSingleAccountDocument() {
  const input = readAccountForm();
  const problems = validateAccount(input);
  if (problems.length) {
    setError('account-error', problems.join(' '));
    return null;
  }
  setError('account-error', '');
  if (!input.label.trim()) input.label = defaultLabel({ username: input.username, callerIdName: input.displayName, domain: input.domain });
  const providerId = state.accountMode === 'edit' && state.scrape ? state.scrape.provider.id : 'manual';
  return buildDocument({ source: sourceFor(providerId), profileName: $('account-profile').value, accounts: [input] });
}

async function onAccountSubmit(event) {
  event.preventDefault();
  const doc = buildSingleAccountDocument();
  if (!doc) return;
  const conn = readConnection('account');
  saveSettings(state.pageURL ? state.pageURL.hostname : '', conn);
  await handoff(doc);
}

async function onAccountCopy() {
  const doc = buildSingleAccountDocument();
  if (!doc) return;
  await copyJSON(doc, $('account-copy'));
}

async function copyJSON(doc, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

function togglePassword() {
  const input = $('account-password');
  const button = $('password-toggle');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  button.textContent = reveal ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', String(reveal));
}

// ---------------------------------------------------------------------------
// List page

function listCheckboxes() {
  return Array.from($('extension-list').querySelectorAll('input[type="checkbox"]'));
}

function selectedRows() {
  const byUuid = new Map(state.scrape.list.map((r) => [r.uuid, r]));
  return listCheckboxes()
    .filter((cb) => cb.checked)
    .map((cb) => byUuid.get(cb.value))
    .filter(Boolean);
}

function updateListCount() {
  const boxes = listCheckboxes();
  const n = boxes.filter((cb) => cb.checked).length;
  setText('list-count', `${n} of ${boxes.length} selected`);
  $('list-add').textContent = `Add ${n} to Sipper`;
  $('list-add').disabled = n === 0;
  $('list-copy').disabled = n === 0;
  $('select-all').checked = boxes.length > 0 && n === boxes.length;
  $('select-all').indeterminate = n > 0 && n < boxes.length;
  const notes = [];
  if (n > FETCH_CAP) notes.push(`Only the first ${FETCH_CAP} selected extensions are read in one go. Add the rest afterwards.`);
  setList('list-notes', notes);
}

function renderList(scrape) {
  const rows = scrape.list || [];
  setText('page-status', `${scrape.provider.name} · ${plural(rows.length, 'extension')}`);
  if (rows.length === 0) {
    showMessage('No extensions found on this page.', 'Search or page through the list, then open Sipper again.');
    return;
  }
  setText('list-intro', `Extensions listed on ${scrape.hostname}. Each selected extension’s page is read to get its password.`);

  const list = $('extension-list');
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = row.uuid;
    cb.addEventListener('change', updateListCount);
    const ext = document.createElement('span');
    ext.className = 'ext';
    ext.textContent = row.extension;
    const detail = document.createElement('span');
    detail.className = 'detail';
    if (row.callerIdName) {
      const b = document.createElement('b');
      b.textContent = row.callerIdName;
      detail.appendChild(b);
    }
    if (row.domainName) {
      detail.appendChild(document.createTextNode(`${row.callerIdName ? ' · ' : ''}${row.domainName}`));
    }
    if (row.enabled === false) detail.appendChild(document.createTextNode(`${detail.childNodes.length ? ' · ' : ''}disabled`));
    detail.title = [row.callerIdName, row.domainName].filter(Boolean).join(' · ');
    label.append(cb, ext, detail);
    li.appendChild(label);
    list.appendChild(li);
  }

  fillConnection('list', { server: state.settings.server || scrape.hostname, port: state.settings.port, transport: state.settings.transport });
  $('list-profile').value = scrape.hostname;
  setError('list-error', '');
  updateListCount();
  show('list');
  $('select-all').focus();
}

function onSelectAll(event) {
  for (const cb of listCheckboxes()) cb.checked = event.target.checked;
  updateListCount();
}

async function readSelectedExtensions(rows, conn) {
  const accounts = [];
  const failures = [];
  state.cancelled = false;
  $('progress-failures').replaceChildren();
  $('progress-bar').max = rows.length;
  show('progress');

  for (let i = 0; i < rows.length; i += 1) {
    if (state.cancelled) break;
    const row = rows[i];
    setText('progress-text', `Reading extension ${row.extension} (${i + 1} of ${rows.length})…`);
    $('progress-bar').value = i;
    try {
      // Fetch with only the extension id: list links can carry domain_uuid/domain_change,
      // which FusionPBX treats as a request to switch the session's active domain.
      const fetchURL = new URL(row.editURL);
      const id = row.uuid || fetchURL.searchParams.get('id');
      fetchURL.search = id ? `?id=${encodeURIComponent(id)}` : '';
      const result = await runInPage(fetchSameOrigin, [fetchURL.toString()]);
      if (!result || !result.ok) {
        throw new Error(result && result.error ? result.error : `HTTP ${result ? result.status : 'error'}`);
      }
      const doc = new DOMParser().parseFromString(result.html, 'text/html');
      const scraped = scrapeDocument(doc, new URL(row.editURL));
      if (scraped.page !== 'extension-edit' || !scraped.edit) {
        throw new Error('the page did not contain an extension form (signed out?)');
      }
      const e = scraped.edit;
      if (!e.password) throw new Error(e.hasPasswordField ? 'the password field is empty' : 'no password shown (missing permission)');
      const domain = e.domainSource === 'hostname' && row.domainName ? row.domainName : e.domainName;
      accounts.push({
        label: defaultLabel({ username: e.extension, callerIdName: e.effectiveCallerIdName, domain }),
        displayName: e.effectiveCallerIdName,
        username: e.extension,
        password: e.password,
        domain,
        server: conn.server,
        port: conn.port,
        transport: conn.transport,
        callerIdName: e.effectiveCallerIdName,
        callerIdNumber: e.effectiveCallerIdNumber,
        notes: e.description,
      });
    } catch (error) {
      const message = String((error && error.message) || error);
      failures.push({ extension: row.extension, error: message });
      const li = document.createElement('li');
      li.textContent = `${row.extension}: ${message}`;
      $('progress-failures').appendChild(li);
    }
  }
  $('progress-bar').value = rows.length;
  return { accounts, failures };
}

async function onListAction(copyOnly) {
  const selected = selectedRows();
  if (!selected.length) return;
  const conn = readConnection('list');
  const problems = validateAccount({ username: 'x', domain: 'x', password: 'x', port: conn.port, transport: conn.transport });
  if (problems.length) {
    setError('list-error', problems.join(' '));
    return;
  }
  setError('list-error', '');

  const notes = [];
  let rows = selected;
  if (rows.length > FETCH_CAP) {
    rows = rows.slice(0, FETCH_CAP);
    notes.push(`${selected.length} were selected; only the first ${FETCH_CAP} were read.`);
  }

  const { accounts, failures } = await readSelectedExtensions(rows, conn);
  if (state.cancelled) notes.push('Stopped early.');
  if (accounts.length === 0) {
    showResult('None of the selected extensions could be read.', { failures, notes });
    return;
  }
  const doc = buildDocument({ source: sourceFor(state.scrape.provider.id), profileName: conn.profile, accounts });
  if (copyOnly) {
    await copyJSON(doc, $('list-copy'));
    showResult(`Copied ${plural(accounts.length, 'account')} as JSON.`, { failures, notes });
    return;
  }
  saveSettings(state.pageURL ? state.pageURL.hostname : '', conn);
  await handoff(doc, { failures, notes });
}

// ---------------------------------------------------------------------------
// Hand-off to Sipper

async function handoff(doc, { failures = [], notes = [] } = {}) {
  const size = payloadSize(doc);
  if (size > MAX_PAYLOAD_BYTES) {
    showResult(`The hand-off is ${Math.round(size / 1024)} KiB; Sipper accepts up to ${MAX_PAYLOAD_BYTES / 1024} KiB. Select fewer extensions.`, { failures, notes });
    return;
  }
  const count = doc.accounts.length;

  if (state.native.available) {
    show('progress');
    setText('progress-text', `Sending ${plural(count, 'account')} to Sipper…`);
    $('progress-bar').removeAttribute('value');
    const reply = await sendNative({ type: 'add-accounts', payload: doc }, SEND_TIMEOUT_MS);
    if (reply.ok) {
      const queued = typeof reply.count === 'number' ? reply.count : count;
      showResult(`Sipper is showing the import sheet for ${plural(queued, 'account')}.`, { failures, notes });
      return;
    }
    notes = [...notes, `Sipper’s browser link failed (${reply.error || 'unknown error'}); opening the sipper:// link instead.`];
  }

  // Show the outcome first: Chrome closes the popup as soon as its "Open Sipper?" dialog appears.
  showResult(`Opening Sipper with ${plural(count, 'account')}. If Chrome asks, choose “Open Sipper”.`, { failures, notes });
  try {
    await chrome.tabs.update(state.tab.id, { url: buildHandoffURL(doc) });
  } catch (error) {
    showResult(`Could not open the sipper:// link: ${String((error && error.message) || error)}`, { failures, notes });
  }
}

// ---------------------------------------------------------------------------
// Rendering the scrape result

function renderScrape() {
  const s = state.scrape;
  if (s.page === 'extension-edit' && s.edit) {
    renderEdit(s);
    return;
  }
  if (s.page === 'extension-list') {
    renderList(s);
    return;
  }

  prefillManual();
  if (s.provider.id === 'fusionpbx') {
    setText('page-status', `${s.provider.name} · ${s.hostname}`);
    let text = 'FusionPBX detected, but this isn’t an extension page.';
    let hint = s.hint;
    if (s.reason === 'extension-add') {
      text = 'This is the form for a new extension.';
      hint = 'Save it first, then open the extension again to import it.';
    } else if (s.reason === 'edit-form-incomplete' || s.reason === 'edit-scrape-failed') {
      text = 'This looks like an extension page, but the extension number could not be read.';
      hint = 'Your FusionPBX user may not have permission to see it. You can enter the account manually.';
    } else if (s.reason === 'no-edit-form' || s.reason === 'no-list-table') {
      text = 'This looks like FusionPBX, but the page has no extension data.';
      hint = 'Sign in to FusionPBX, reload the page and open Sipper again.';
    }
    showMessage(text, hint);
    return;
  }
  setText('page-status', s.hostname || 'Unsupported page');
  showMessage(
    'This isn’t a supported PBX page.',
    'Sipper can import from FusionPBX: open Accounts → Extensions and choose an extension, or use the list to import several. On any other site you can enter an account manually.',
  );
}

async function init() {
  wireEvents();
  renderFooter();
  probeNative().then((native) => {
    state.native = native;
    renderFooter();
  });

  state.tab = await getActiveTab().catch(() => null);
  const tabURL = state.tab && state.tab.url ? safeURL(state.tab.url) : null;
  state.pageURL = tabURL;
  state.settings = await loadSettings(tabURL ? tabURL.hostname : '');

  if (!state.tab || !tabURL || !/^https?:$/.test(tabURL.protocol)) {
    setText('page-status', 'Not a web page');
    prefillManual();
    showMessage('Sipper can only read ordinary web pages (http or https).', 'Open your PBX web interface and try again, or enter an account manually.');
    return;
  }

  let capture;
  try {
    capture = await runInPage(capturePage);
  } catch (error) {
    setText('page-status', tabURL.hostname);
    prefillManual();
    showMessage('Chrome did not let the extension read this page.', `${String((error && error.message) || error)} You can still enter an account manually.`);
    return;
  }
  if (!capture || typeof capture.html !== 'string') {
    setText('page-status', tabURL.hostname);
    prefillManual();
    showMessage('The page could not be read.', 'Reload it and try again, or enter an account manually.');
    return;
  }

  const pageURL = safeURL(capture.url) || tabURL;
  state.pageURL = pageURL;
  if (pageURL.hostname !== tabURL.hostname) state.settings = await loadSettings(pageURL.hostname);
  const doc = new DOMParser().parseFromString(capture.html, 'text/html');
  state.scrape = scrapeDocument(doc, pageURL);
  renderScrape();
}

function wireEvents() {
  $('manual-toggle').addEventListener('click', () => {
    prefillManual();
    show('account');
    $('account-username').focus();
  });
  $('account-back').addEventListener('click', () => show('message'));
  $('account-form').addEventListener('submit', onAccountSubmit);
  $('account-copy').addEventListener('click', onAccountCopy);
  $('password-toggle').addEventListener('click', togglePassword);
  $('select-all').addEventListener('change', onSelectAll);
  $('list-form').addEventListener('submit', (event) => {
    event.preventDefault();
    onListAction(false);
  });
  $('list-copy').addEventListener('click', () => onListAction(true));
  $('progress-cancel').addEventListener('click', () => {
    state.cancelled = true;
    setText('progress-text', 'Stopping…');
  });
  $('result-back').addEventListener('click', () => show(state.previousView));
}

init().catch((error) => {
  setText('page-status', 'Error');
  showMessage('Something went wrong.', String((error && error.message) || error));
});
