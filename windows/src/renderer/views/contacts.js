// Contacts: a searchable list with favourites, a detail pane and the contact editor.

import { shortDateTime, recordSummary } from '../../core/format.js';
import { CONTACT_NUMBER_LABELS, contactMatchesNumber, displayLabel, newID } from '../../core/models.js';
import {
  Avatar, Button, Checkbox, cleanError, confirmDialog, cx, Dialog, EmptyState, Field, Icon, IconButton, PageHeader, Select,
  showMenu, TextField, Segmented, InfoBar,
} from '../components.js';
import { html, useEffect, useRef, useState } from '../lib.js';
import { accountByID, accountIsLive, act, contactByID, service, useAppState } from '../store.js';
import { useUI } from '../ui.js';
import { recordIcon, recordTone } from './actions.js';

async function deleteContact(contact) {
  const response = await confirmDialog({
    type: 'warning',
    message: `Delete ${contact.name}?`,
    detail: 'Calls with this contact stay in history.',
    buttons: ['Delete contact', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) act('deleteContact', contact.id);
}

function contactMenu(ui, contact) {
  const number = contact.numbers[0]?.number;
  return showMenu([
    number && { label: `Call ${number}`, onSelect: () => act('call', number, contact.preferredAccountID) },
    { label: contact.isFavorite ? 'Remove from favourites' : 'Add to favourites', onSelect: () => act('toggleFavorite', contact.id) },
    { label: 'Edit…', onSelect: () => ui.openDialog({ kind: 'editContact', id: contact.id }) },
    'separator',
    { label: 'Delete…', onSelect: () => deleteContact(contact) },
  ]);
}

function ContactRow({ contact, selected, onSelect }) {
  const ui = useUI();
  return html`<button type="button" class=${cx('contact-row', selected && 'selected')} aria-current=${selected ? 'true' : undefined}
    onClick=${onSelect} onContextMenu=${(event) => {
      event.preventDefault();
      onSelect();
      contactMenu(ui, contact);
    }}>
    <${Avatar} contact=${contact} size=${32} />
    <span class="contact-row-text">
      <span class="ellipsis">${contact.name}</span>
      <span class="caption ellipsis">${contact.numbers[0]?.number || contact.company}</span>
    </span>
    ${contact.isFavorite ? html`<${Icon} name="starFilled" size=${12} className="favourite-mark" />` : null}
  </button>`;
}

function ContactDetail({ contact }) {
  const state = useAppState();
  const ui = useUI();
  const preferred = accountByID(state, contact.preferredAccountID);
  const recent = state.history.filter((record) => contactMatchesNumber(contact, record.remoteNumber)).slice(0, 8);
  return html`<div class="detail">
    <div class="detail-header">
      <${Avatar} contact=${contact} size=${56} />
      <div class="detail-header-text">
        <h2 class="detail-title selectable">${contact.name}</h2>
        ${contact.company ? html`<p class="secondary selectable">${contact.company}</p>` : null}
      </div>
      <${IconButton} icon=${contact.isFavorite ? 'starFilled' : 'star'} className=${cx('star-button', contact.isFavorite && 'on')}
        label=${contact.isFavorite ? 'Remove from favourites' : 'Add to favourites'} onClick=${() => act('toggleFavorite', contact.id)} />
      <${Button} icon="edit" onClick=${() => ui.openDialog({ kind: 'editContact', id: contact.id })}>Edit</${Button}>
      <${IconButton} icon="delete" label="Delete contact" onClick=${() => deleteContact(contact)} />
    </div>

    ${contact.numbers.length === 0
      ? html`<p class="secondary">No numbers. Edit the contact to add one.</p>`
      : html`<div class="card rows-card">
        ${contact.numbers.map((entry) => html`<div key=${entry.id} class="number-row">
          <div class="number-row-text">
            <span class="caption">${entry.label}</span>
            <span class="tabular selectable">${entry.number}</span>
          </div>
          <${Button} kind="success" icon="call" onClick=${() => act('call', entry.number, contact.preferredAccountID)}>Call</${Button}>
        </div>`)}
      </div>`}

    ${preferred ? html`<p class="caption">Calls from ${displayLabel(preferred)}</p>` : null}
    ${contact.notes ? html`<p class="selectable prose-text">${contact.notes}</p>` : null}

    ${recent.length > 0 ? html`<section aria-label="Recent calls">
      <h3 class="section-heading">Recent calls</h3>
      <div class="card rows-card">
        ${recent.map((record) => html`<div key=${record.id} class="compact-record">
          <${Icon} name=${recordIcon(record)} className=${recordTone(record)} />
          <span class="ellipsis">${recordSummary(record)}</span>
          <span class="caption tabular">${shortDateTime(new Date(record.startedAt))}</span>
        </div>`)}
      </div>
    </section>` : null}
  </div>`;
}

export function ContactsPage() {
  const [source, setSource] = useState('personal');
  const sources = html`<${Segmented} label="Contact source" value=${source} onChange=${setSource}
    options=${[{ value: 'personal', label: 'Personal' }, { value: 'company', label: 'Company directory' }]} />`;
  return source === 'company' ? html`<${CompanyDirectory} sources=${sources} />` : html`<${PersonalContacts} sources=${sources} />`;
}

function CompanyDirectory({ sources }) {
  const state = useAppState(), ui = useUI(), status = state.managed;
  const [chosenDevice, setDevice] = useState(null), [chosenAccount, setAccount] = useState(null);
  const [search, setSearch] = useState(''), [selectedID, setSelected] = useState(null);
  const [data, setData] = useState(null), [error, setError] = useState(null), [working, setWorking] = useState(false);
  const lifecycle = useRef(0), loading = useRef(null);
  const entries = status?.signedIn ? status.enrollments : [];
  const entry = entries.find(e => e.deviceId === chosenDevice) ?? entries[0], deviceId = entry?.deviceId;
  const directory = data?.deviceId === deviceId && data?.revision === entry?.directory?.revision && Date.parse(data?.expiresAt) > Date.now() ? data : null;
  const accounts = state.accounts.filter(a => a.managed?.deviceId === deviceId && a.managed?.organisationId === entry?.organisationId
    && Date.parse(a.managed.expiresAt) > Date.now() && accountIsLive(state, a));
  const accountId = accounts.find(a => a.id === chosenAccount)?.id ?? accounts[0]?.id;
  const refresh = async () => {
    const attempt = lifecycle.current;
    if (!deviceId || loading.current === attempt) return;
    loading.current = attempt; setWorking(true); setError(null);
    try { const value = await service('managedDirectoryRefresh', deviceId); if (attempt === lifecycle.current) setData(value); }
    catch (problem) { if (attempt === lifecycle.current) setError(cleanError(problem)); }
    finally { if (attempt === lifecycle.current) { loading.current = null; setWorking(false); } }
  };
  useEffect(() => {
    const attempt = ++lifecycle.current;
    setData(null); setError(null); setWorking(false); loading.current = null;
    if (deviceId) {
      service('managedDirectory', deviceId).then(value => { if (attempt === lifecycle.current) setData(value); }).catch(() => {});
      refresh();
    }
    const timer = setInterval(refresh, 60_000);
    return () => { clearInterval(timer); lifecycle.current++; };
  }, [deviceId]);
  useEffect(() => {
    if (!entry?.directory) setData(null);
  }, [deviceId, entry?.directory?.revision]);
  const query = search.trim().toLowerCase(), phone = query.replace(/[(). -]/g, '');
  const contacts = (directory?.contacts ?? []).filter(c => !query || c.name.toLowerCase().includes(query) || c.company.toLowerCase().includes(query)
    || (phone && c.numbers.some(n => n.number.includes(phone))));
  const selected = contacts.find(c => c.id === selectedID) ?? contacts[0];
  const call = async number => {
    const attempt = lifecycle.current;
    try { await service('managedDirectoryCall', deviceId, selected.id, number, accountId); }
    catch (problem) { if (attempt === lifecycle.current) setError(cleanError(problem)); }
  };
  return html`<div class="page company-directory">
    <${PageHeader} title="Contacts">${sources}</${PageHeader}>
    ${!entry ? html`<div class="page-body"><${EmptyState} icon="contacts" title="Company directory"
      description="Sign in and connect a managed customer to see their shared contacts.">
      <${Button} onClick=${() => ui.navigate({ kind: 'settings', tab: 'managed' })}>Managed accounts</${Button}>
    </${EmptyState}></div>` : html`
      <div class="directory-toolbar">
        <${Select} label="Customer" value=${deviceId} options=${entries.map(e => ({ value: e.deviceId,
          label: status.organisations.find(o => o.id === e.organisationId)?.name ?? 'Managed customer' }))} onChange=${setDevice} />
        <${TextField} label="Search company directory" placeholder="Name, company or number" value=${search} onValue=${setSearch} />
        <${Button} onClick=${refresh} disabled=${working}>${working ? 'Refreshing…' : 'Refresh'}</${Button}>
      </div>
      ${error ? html`<div class="directory-notice"><${InfoBar} severity="error" title="Directory unavailable">${error}</${InfoBar}></div>` : null}
      <div class="split">
        <div class="split-list" aria-label="Company contacts">
          ${!contacts.length ? html`<p class="caption list-empty" role="status">${working ? 'Loading directory…' : !directory ? 'Refresh to load this customer’s shared contacts.' : query ? 'No contacts match your search.' : 'No shared contacts yet.'}</p>` : null}
          ${contacts.map(contact => html`<button type="button" key=${contact.id} class=${cx('contact-row', selected?.id === contact.id && 'selected')}
            aria-current=${selected?.id === contact.id ? 'true' : undefined} onClick=${() => setSelected(contact.id)}>
            <span class="contact-row-text"><span class="ellipsis">${contact.name}</span><span class="caption ellipsis">${contact.company || contact.numbers[0].number}</span></span>
          </button>`)}
        </div>
        <div class="split-detail">
          ${selected ? html`<div class="detail"><h2 class="detail-title">${selected.name}</h2><p class="secondary">${selected.company}</p>
            <${CompanyContactStatus} key=${`${deviceId}:${directory.revision}:${selected.id}`} deviceId=${deviceId} contactId=${selected.id} />
            ${accounts.length ? html`<${Field} label="Call from"><${Select} label="Calling account" value=${accountId}
              options=${accounts.map(a => ({ value: a.id, label: displayLabel(a) }))} onChange=${setAccount} /></${Field}>`
              : html`<p class="caption">No active calling account for this customer. Refresh managed accounts to make calls.</p>`}
            ${selected.numbers.map(n => html`<div class="number-row" key=${n.number}><div class="number-row-text"><span class="caption">${n.label}</span><span class="tabular selectable">${n.number}</span></div>
              <${Button} icon="call" disabled=${!accountId} aria-label=${`Call ${selected.name}, ${n.label}, ${n.number}`} onClick=${() => call(n.number)}>Call</${Button}>
            </div>`)}
            <p class="caption">Shared contacts are managed by your administrator. Personal contacts are kept separately.</p>
          </div>` : null}
        </div>
      </div>`}
  </div>`;
}

function CompanyContactStatus({ deviceId, contactId }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true, pending = false, expiry;
    const refresh = async () => {
      if (document.hidden) { setStatus(null); return; }
      if (pending) return;
      pending = true;
      try {
        const value = await service('managedDirectoryStatus', deviceId, [contactId]);
        if (alive && !document.hidden) {
          clearTimeout(expiry);
          if (Date.parse(value.expiresAt) > Date.now()) {
            setStatus(value.contacts[0]);
            expiry = setTimeout(() => setStatus(null), Math.max(0, Date.parse(value.expiresAt) - Date.now()));
          } else setStatus(null);
        }
      } catch { if (alive) setStatus(null); }
      finally { pending = false; }
    };
    refresh();
    const timer = setInterval(refresh, 20_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { alive = false; clearInterval(timer); clearTimeout(expiry); document.removeEventListener('visibilitychange', refresh); };
  }, [deviceId, contactId]);
  const label = [status?.availability != null && ({ unset: 'Availability not set', available: 'Available', away: 'Away', busy: 'Busy' })[status.availability],
    status?.doNotDisturb && 'Do Not Disturb', status?.activity && ({ in_call: 'In a call', on_hold: 'On hold', ringing: 'Ringing', dialling: 'Dialling' })[status.activity.state],
    status?.activity && (status.activity.source === 'device' ? 'App report' : 'Gateway report')].filter(Boolean).join(' · ') || 'Status unavailable';
  return html`<p class="caption" role="status" title="Shared by this person. This does not confirm they can answer.">${label}</p>`;
}

function PersonalContacts({ sources }) {
  const state = useAppState();
  const ui = useUI();
  const [search, setSearch] = useState('');
  const [selectedID, setSelectedID] = useState(ui.selection.id ?? null);

  useEffect(() => {
    if (ui.selection.id) setSelectedID(ui.selection.id);
  }, [ui.selection.id]);

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? state.contacts.filter((contact) => contact.name.toLowerCase().includes(needle)
      || contact.company.toLowerCase().includes(needle)
      || contact.numbers.some((entry) => entry.number.toLowerCase().includes(needle)))
    : state.contacts;
  const favourites = filtered.filter((contact) => contact.isFavorite);
  const selected = filtered.find((contact) => contact.id === selectedID) ?? filtered[0] ?? null;

  const addButton = html`<${Button} icon="personAdd" onClick=${() => ui.openDialog({ kind: 'addContact' })}>Add contact</${Button}>`;

  if (state.contacts.length === 0) {
    return html`<div class="page">
      <${PageHeader} title="Contacts">${sources}${addButton}</${PageHeader}>
      <div class="page-body">
        <${EmptyState} icon="contacts" title="No contacts" description="Contacts are stored on this PC. Sipper uses them to name incoming calls.">
          <${Button} kind="accent" onClick=${() => ui.openDialog({ kind: 'addContact' })}>Add contact…</${Button}>
        </${EmptyState}>
      </div>
    </div>`;
  }

  const row = (contact) => html`<${ContactRow} key=${contact.id} contact=${contact} selected=${selected?.id === contact.id}
    onSelect=${() => setSelectedID(contact.id)} />`;

  return html`<div class="page">
    <${PageHeader} title="Contacts">
      ${sources}
      <div class="search-field">
        <${Icon} name="search" />
        <input type="search" class="text-field" placeholder="Name, company or number" aria-label="Search contacts" spellcheck=${false}
          value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
      </div>
      ${addButton}
    </${PageHeader}>
    <div class="split">
      <div class="split-list" aria-label="Contacts">
        ${filtered.length === 0 ? html`<p class="caption list-empty">No contacts match “${search.trim()}”.</p>` : null}
        ${favourites.length > 0 ? html`<h2 class="list-heading">Favourites</h2>${favourites.map(row)}` : null}
        ${filtered.length > 0 ? html`<h2 class="list-heading">${favourites.length > 0 ? 'All contacts' : 'Contacts'}</h2>${filtered.map(row)}` : null}
      </div>
      <div class="split-detail">
        ${selected ? html`<${ContactDetail} key=${selected.id} contact=${selected} />` : html`<${EmptyState} icon="contacts" title="Select a contact" />`}
      </div>
    </div>
  </div>`;
}

export function ContactDialog({ mode }) {
  const state = useAppState();
  const ui = useUI();
  const editing = mode.kind === 'editContact';
  const existing = editing ? contactByID(state, mode.id) : null;
  const [draft, setDraft] = useState(() => (existing
    ? structuredClone(existing)
    : {
      name: mode.name ?? '',
      company: '',
      isFavorite: false,
      notes: '',
      preferredAccountID: null,
      numbers: mode.number ? [{ id: newID(), label: 'Work', number: mode.number }] : [{ id: newID(), label: 'Work', number: '' }],
    }));
  const [error, setError] = useState(null);
  const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));
  const setNumber = (id, patch) => setDraft((current) => ({
    ...current,
    numbers: current.numbers.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
  }));

  const save = async () => {
    if (!draft.name.trim()) return;
    try {
      if (editing) {
        await act('updateContact', draft);
      } else {
        const contact = await act('addContact', draft);
        if (ui.selection.kind === 'contacts') ui.navigate({ kind: 'contacts', id: contact.id });
      }
      ui.closeDialog();
    } catch (problem) {
      setError(cleanError(problem));
    }
  };

  const footer = html`
    ${error ? html`<span class="footer-message"><${Icon} name="error" size=${12} />${error}</span>` : html`<span class="spacer"></span>`}
    <${Button} onClick=${ui.closeDialog}>Cancel</${Button}>
    <${Button} kind="accent" disabled=${!draft.name.trim()} onClick=${save}>${editing ? 'Save' : 'Add contact'}</${Button}>`;

  return html`<${Dialog} title=${editing ? 'Edit contact' : 'Add contact'} onClose=${ui.closeDialog} width=${520} footer=${footer}>
    <form class="form-stack" onSubmit=${(event) => {
      event.preventDefault();
      save();
    }}>
      <div class="form-grid two">
        <${Field} label="Name"><${TextField} data-autofocus value=${draft.name} onValue=${set('name')} /></${Field}>
        <${Field} label="Company"><${TextField} value=${draft.company} onValue=${set('company')} /></${Field}>
      </div>
      <${Checkbox} checked=${draft.isFavorite} onChange=${set('isFavorite')} label="Favourite" />

      <h3 class="form-section-title">Numbers</h3>
      <div class="number-edit-list">
        ${draft.numbers.map((entry, index) => html`<div key=${entry.id} class="number-edit-row">
          <${Select} label=${`Label for number ${index + 1}`} value=${entry.label}
            options=${[...new Set([...CONTACT_NUMBER_LABELS, entry.label])].map((label) => ({ value: label, label }))}
            onChange=${(label) => setNumber(entry.id, { label })} />
          <${TextField} label=${`Number ${index + 1}`} placeholder="Number or SIP address" value=${entry.number}
            onValue=${(number) => setNumber(entry.id, { number })} />
          <${IconButton} icon="dismiss" label="Remove number" onClick=${() => setDraft((current) => ({
            ...current,
            numbers: current.numbers.filter((other) => other.id !== entry.id),
          }))} />
        </div>`)}
        <div>
          <${Button} kind="subtle" icon="add" onClick=${() => setDraft((current) => ({
            ...current,
            numbers: [...current.numbers, { id: newID(), label: current.numbers.length === 0 ? 'Work' : 'Other', number: '' }],
          }))}>Add number</${Button}>
        </div>
      </div>

      <${Field} label="Call from">
        <${Select} value=${draft.preferredAccountID}
          options=${[{ value: null, label: 'The account selected in the dialer' }, ...state.accounts.map((a) => ({ value: a.id, label: displayLabel(a) }))]}
          onChange=${set('preferredAccountID')} />
      </${Field}>
      <${Field} label="Notes"><${TextField} multiline rows=${3} value=${draft.notes} onValue=${set('notes')} /></${Field}>
      <button type="submit" hidden></button>
    </form>
  </${Dialog}>`;
}
