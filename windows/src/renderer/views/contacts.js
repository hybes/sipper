// Contacts: a searchable list with favourites, a detail pane and the contact editor.

import { shortDateTime, recordSummary } from '../../core/format.js';
import { CONTACT_NUMBER_LABELS, contactMatchesNumber, displayLabel, newID } from '../../core/models.js';
import {
  Avatar, Button, Checkbox, cleanError, confirmDialog, cx, Dialog, EmptyState, Field, Icon, IconButton, PageHeader, Select,
  showMenu, TextField,
} from '../components.js';
import { html, useEffect, useState } from '../lib.js';
import { accountByID, act, contactByID, useAppState } from '../store.js';
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
      <${PageHeader} title="Contacts">${addButton}</${PageHeader}>
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
