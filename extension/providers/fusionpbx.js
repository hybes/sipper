// FusionPBX provider: detection and scraping of the extension edit and list pages.
//
// Pure functions over a DOM Document plus a URL-like location. The document may be a
// live page, a DOMParser document built from captured HTML, or a jsdom document in
// tests; nothing here touches browser-only globals. Markup facts come from the
// FusionPBX sources (master/5.5 and 4.4.1): see extension/README.md.

export const EDIT_PATH = /\/app\/extensions\/extension_edit\.php$/i;
export const LIST_PATH = /\/app\/extensions\/extensions\.php$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cleanText(node) {
  if (!node) return '';
  return String(node.textContent || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True for dotted host names and IPv4/IPv6 literals; false for words such as "default".
export function looksLikeHostname(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v.length > 253 || /\s/.test(v)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return true;
  if (v.includes(':') && /^\[?[0-9a-f:.]+\]?$/.test(v)) return true;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v);
}

export function toURL(location) {
  if (location instanceof URL) return location;
  if (typeof location === 'string') return new URL(location);
  return new URL(location.href);
}

function control(root, name) {
  return root.querySelector(`input[name="${name}"], select[name="${name}"], textarea[name="${name}"]`);
}

function selectedOption(select) {
  if (!select) return null;
  const explicit = select.querySelector('option[selected]');
  if (explicit) return explicit;
  const index = select.selectedIndex;
  return index >= 0 ? select.options[index] : null;
}

// Value of a named control, or null when it is absent. Selects return the selected
// option's value; the option text is available through selectedText().
function value(root, name) {
  const el = control(root, name);
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const opt = selectedOption(el);
    return opt ? (opt.getAttribute('value') ?? cleanText(opt)) : '';
  }
  if (tag === 'textarea') return String(el.value ?? el.textContent ?? '');
  return String(el.value ?? el.getAttribute('value') ?? '');
}

function selectedText(root, name) {
  const el = control(root, name);
  if (!el || el.tagName.toLowerCase() !== 'select') return null;
  return cleanText(selectedOption(el));
}

function trimOrEmpty(v) {
  return v == null ? '' : String(v).trim();
}

// ---------------------------------------------------------------------------
// Detection

const MARKERS = [
  ['theme-css', (doc) => !!doc.querySelector("link[href*='/themes/'][href*='css.php']")],
  ['main-content', (doc) => !!doc.getElementById('main_content')],
  ['message-container', (doc) => !!doc.getElementById('message_container')],
  ['domains-container', (doc) => !!doc.getElementById('domains_container')],
  ['body-header', (doc) => !!doc.getElementById('body_header')],
  ['php-assets', (doc) => !!doc.querySelector("script[src*='.js.php'], link[href*='.css.php']")],
  ['hide-password-fields', (doc) =>
    Array.from(doc.querySelectorAll('script:not([src])')).some((s) => /hide_password_fields/.test(s.textContent || ''))],
  ['title', (doc) => /fusionpbx/i.test(doc.title || '')],
];

export function fusionPBXMarkers(doc) {
  const found = [];
  for (const [name, test] of MARKERS) {
    try {
      if (test(doc)) found.push(name);
    } catch {
      // A marker that throws on an odd document is simply absent.
    }
  }
  return found;
}

function editForm(doc) {
  return doc.querySelector("form#frm, form[name='frm']");
}

// The extension number rendered as text when the user lacks the extension_extension
// permission: the first label/value row of the form (class vncellreq / vtable) with no
// control inside the value cell.
function plainExtension(form) {
  for (const tr of form.querySelectorAll('tr')) {
    const cells = Array.from(tr.children).filter((c) => c.tagName === 'TD');
    if (cells.length < 2) continue;
    const [label, cell] = cells;
    if (!/\bvncell(?:req)?\b/.test(label.className || '')) continue;
    if (!/\bvtable\b/.test(cell.className || '')) continue;
    if (cell.querySelector('input, select, textarea, a, button')) return null;
    const t = cleanText(cell);
    return /^[0-9A-Za-z*#+._-]{1,64}$/.test(t) ? t : null;
  }
  return null;
}

function hasExtensionField(form) {
  return !!control(form, 'extension') || !!plainExtension(form);
}

// -> { matched, page: 'extension-edit' | 'extension-list' | 'other', confidence, markers, reason }
export function detect(doc, location) {
  const loc = toURL(location);
  const markers = fusionPBXMarkers(doc);
  const base = { matched: markers.length >= 2 || markers.includes('title'), page: 'other', confidence: Math.min(1, markers.length / 4), markers, reason: null };

  if (EDIT_PATH.test(loc.pathname)) {
    const form = editForm(doc);
    const id = loc.searchParams.get('id') || '';
    if (form && id && hasExtensionField(form)) {
      return { ...base, matched: true, page: 'extension-edit', confidence: 1 };
    }
    if (form && !id) {
      return { ...base, matched: true, reason: 'extension-add' };
    }
    return { ...base, matched: true, reason: form ? 'edit-form-incomplete' : 'no-edit-form' };
  }

  if (LIST_PATH.test(loc.pathname)) {
    const rows = listRows(doc);
    if (rows.length > 0 || doc.querySelector("table.list, table.tr_hover, form#form_list, form[name='frm']")) {
      return { ...base, matched: true, page: 'extension-list', confidence: 1 };
    }
    return { ...base, matched: true, reason: 'no-list-table' };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Edit page

function headerDomain(doc) {
  for (const a of doc.querySelectorAll('a.header_domain_selector_domain')) {
    const spans = Array.from(a.querySelectorAll('span')).map(cleanText).filter(Boolean);
    const t = spans.length ? spans[spans.length - 1] : cleanText(a);
    if (t) return t;
  }
  for (const a of doc.querySelectorAll('a.domain_selector_domain')) {
    const t = cleanText(a);
    if (t) return t;
  }
  return '';
}

// Domain name in order of reliability: the domain select, the multi-tenant header,
// a hostname-like user_context, and finally the web host.
export function resolveDomain(doc, form, location, userContext) {
  const loc = toURL(location);
  const select = form.querySelector("select[name='domain_uuid']");
  if (select) {
    const opt = selectedOption(select);
    const name = cleanText(opt);
    if (name) return { name, source: 'select', uuid: opt.getAttribute('value') || '' };
  }
  const hidden = form.querySelector("input[name='domain_uuid']");
  const uuid = hidden ? trimOrEmpty(hidden.value ?? hidden.getAttribute('value')) : '';
  const header = headerDomain(doc);
  if (header) return { name: header, source: 'header', uuid };
  if (looksLikeHostname(userContext)) return { name: String(userContext).trim().toLowerCase(), source: 'user_context', uuid };
  return { name: loc.hostname, source: 'hostname', uuid };
}

// -> account draft (plain JSON) or null when the page is not an extension edit page.
export function scrapeEditPage(doc, location) {
  const loc = toURL(location);
  const form = editForm(doc);
  if (!form) return null;

  const extensionInput = control(form, 'extension');
  const extension = extensionInput ? trimOrEmpty(extensionInput.value ?? extensionInput.getAttribute('value')) : trimOrEmpty(plainExtension(form));
  if (!extension) return null;

  const userContext = trimOrEmpty(value(form, 'user_context'));
  const domain = resolveDomain(doc, form, loc, userContext);
  const enabledRaw = value(form, 'enabled');
  const outboundName = selectedText(form, 'outbound_caller_id_name') ?? value(form, 'outbound_caller_id_name');
  const outboundNumber = selectedText(form, 'outbound_caller_id_number') ?? value(form, 'outbound_caller_id_number');
  const uuidParam = loc.searchParams.get('id') || '';

  return {
    extension,
    extensionSource: extensionInput ? 'input' : 'text',
    // Select by name: FusionPBX places a hidden decoy type=password input before the real one.
    password: trimOrEmpty(value(form, 'password')),
    hasPasswordField: !!control(form, 'password'),
    numberAlias: trimOrEmpty(value(form, 'number_alias')),
    effectiveCallerIdName: trimOrEmpty(value(form, 'effective_caller_id_name')),
    effectiveCallerIdNumber: trimOrEmpty(value(form, 'effective_caller_id_number')),
    outboundCallerIdName: trimOrEmpty(outboundName),
    outboundCallerIdNumber: trimOrEmpty(outboundNumber),
    description: trimOrEmpty(value(form, 'description')),
    userContext,
    enabled: enabledRaw == null ? null : enabledRaw !== 'false',
    domainName: domain.name,
    domainSource: domain.source,
    domainUuid: domain.uuid,
    uuid: UUID.test(uuidParam) ? uuidParam : trimOrEmpty(value(form, 'extension_uuid')) || uuidParam,
    server: loc.hostname,
    editURL: loc.href,
    title: cleanText(doc.querySelector('title')) || String(doc.title || ''),
  };
}

// ---------------------------------------------------------------------------
// List page

function cellsOf(tr) {
  return Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
}

// Column index of a sortable header (th_order_by renders <th><a href='?order_by=FIELD…'>),
// which is language-independent, unlike the visible header text.
function headerIndex(table, field) {
  if (!table) return -1;
  for (const tr of table.querySelectorAll('tr')) {
    const cells = cellsOf(tr);
    for (let i = 0; i < cells.length; i += 1) {
      const a = cells[i].querySelector(`a[href*='order_by=${field}']`);
      if (a && !cells[i].querySelector("a[href*='extension_edit.php']")) return i;
    }
  }
  return -1;
}

function editAnchors(tr) {
  return Array.from(tr.querySelectorAll("a[href*='extension_edit.php?id=']"));
}

function listRows(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('tr')) {
    if (editAnchors(tr).length > 0) rows.push(tr);
  }
  return rows;
}

// -> [{ extension, uuid, editURL, callerIdName, domainName, userContext, enabled }]
export function scrapeListPage(doc, location) {
  const loc = toURL(location);
  const showAll = (loc.searchParams.get('show') || '') === 'all';
  const seen = new Set();
  const results = [];

  for (const tr of listRows(doc)) {
    const anchors = editAnchors(tr);
    const anchor = anchors.find((a) => cleanText(a)) || anchors[0];
    const extension = cleanText(anchor);
    if (!extension) continue;

    let editURL;
    try {
      editURL = new URL(anchor.getAttribute('href'), loc.href);
    } catch {
      continue;
    }
    const uuid = editURL.searchParams.get('id') || '';
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);

    const table = tr.closest('table');
    const cells = cellsOf(tr);
    const extCell = anchor.closest('td');
    const extIndex = cells.indexOf(extCell);

    let callerIdName = '';
    const cidIndex = headerIndex(table, 'effective_caller_id_name');
    if (cidIndex >= 0 && cells[cidIndex] && cidIndex !== extIndex) {
      callerIdName = cleanText(cells[cidIndex]);
    } else if (extIndex >= 0 && cells[extIndex + 1] && /\bhide-xs\b/.test(cells[extIndex + 1].className || '')) {
      callerIdName = cleanText(cells[extIndex + 1]);
    }

    let domainName = '';
    const domainIndex = headerIndex(table, 'domain_name');
    if (domainIndex >= 0 && cells[domainIndex] && domainIndex !== extIndex) {
      domainName = cleanText(cells[domainIndex]);
    } else if (showAll && extIndex > 0) {
      for (let i = 0; i < extIndex; i += 1) {
        const cell = cells[i];
        if (cell.querySelector('input, a, button')) continue;
        const t = cleanText(cell);
        if (looksLikeHostname(t)) {
          domainName = t;
          break;
        }
      }
    }

    let userContext = '';
    const ctxIndex = headerIndex(table, 'user_context');
    if (ctxIndex >= 0 && cells[ctxIndex] && ctxIndex !== extIndex) userContext = cleanText(cells[ctxIndex]);

    let enabled = null;
    const enabledIndex = headerIndex(table, 'enabled');
    if (enabledIndex >= 0 && cells[enabledIndex] && enabledIndex !== extIndex) {
      const t = cleanText(cells[enabledIndex]).toLowerCase();
      if (t === 'true' || t === 'false') enabled = t === 'true';
    }

    results.push({ extension, uuid, editURL: editURL.href, callerIdName, domainName, userContext, enabled });
  }
  return results;
}

export const fusionpbx = {
  id: 'fusionpbx',
  name: 'FusionPBX',
  detect,
  scrapeEditPage,
  scrapeListPage,
  // Where in the PBX web UI the user should go when the current page cannot be imported.
  navigationHint: 'Open Accounts → Extensions and pick an extension to import it, or stay on the list to import several at once.',
};

export default fusionpbx;
