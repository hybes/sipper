// Confirms accounts handed over by the browser extension or a sipper:// link (docs/PROTOCOL.md).

import { displayLabel, effectivePort, effectiveServer, transportName } from '../../core/models.js';
import { Button, Checkbox, Dialog, Field, Select, TextField } from '../components.js';
import { html, useState } from '../lib.js';
import { act, useAppState } from '../store.js';

const NEW_PROFILE = '__new__';

export function ImportDialog() {
  const state = useAppState();
  const request = state.pendingImport;
  const [selected, setSelected] = useState(() => new Set(request.candidates
    .filter((candidate) => candidate.validationErrors.length === 0 && !candidate.existingAccountID)
    .map((candidate) => candidate.id)));
  const [profileChoice, setProfileChoice] = useState(() => {
    const matching = request.profileName && state.profiles.find((p) => p.name.toLowerCase() === request.profileName.toLowerCase());
    if (matching) return matching.id;
    if (request.profileName || state.profiles.length === 0) return NEW_PROFILE;
    return state.profiles[0].id;
  });
  const [newProfileName, setNewProfileName] = useState(request.profileName ?? '');

  const count = request.candidates.length;
  const provider = request.provider === 'manual' ? '' : ` from ${request.provider === 'fusionpbx' ? 'FusionPBX' : request.provider}`;
  const title = `Add ${count === 1 ? '1 account' : `${count} accounts`}${provider}`;
  const invalid = request.candidates.filter((c) => c.validationErrors.length > 0).length;
  const selectedValid = request.candidates.filter((c) => selected.has(c.id) && c.validationErrors.length === 0).length;
  const needsName = profileChoice === NEW_PROFILE && !newProfileName.trim() && !request.profileName;

  const toggle = (id, on) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  const commit = () => {
    const choice = profileChoice === NEW_PROFILE
      ? { kind: 'new', name: newProfileName.trim() || request.profileName || 'Imported' }
      : { kind: 'existing', id: profileChoice };
    act('commitImport', [...selected], choice);
  };

  const footer = html`
    <span class="caption footer-summary">${invalid === 0 ? `${selected.size} of ${count} selected` : `${selected.size} selected · ${invalid} cannot be imported`}</span>
    <${Button} onClick=${() => act('cancelImport')}>Cancel</${Button}>
    <${Button} kind="accent" disabled=${selectedValid === 0 || needsName} onClick=${commit}>
      ${selectedValid === 1 ? 'Import 1 account' : `Import ${selectedValid} accounts`}
    </${Button}>`;

  return html`<${Dialog} title=${title} onClose=${() => act('cancelImport')} width=${640} footer=${footer}>
    ${request.sourceURL ? html`<p class="import-source selectable" title=${request.sourceURL}>${request.sourceURL}</p>` : null}
    <div class="import-list" role="list">
      ${request.candidates.map((candidate) => {
        const { account } = candidate;
        const valid = candidate.validationErrors.length === 0;
        return html`<div key=${candidate.id} class="import-row" role="listitem">
          <${Checkbox} checked=${selected.has(candidate.id)} disabled=${!valid} aria-label=${`Import ${displayLabel(account)}`}
            onChange=${(on) => toggle(candidate.id, on)} />
          <div class="import-row-text">
            <span>
              <strong>${displayLabel(account)}</strong>
              ${candidate.existingAccountID ? html`<span class="badge update">update existing</span>` : valid ? html`<span class="badge new">new</span>` : null}
            </span>
            <span class="caption">${account.username}@${account.domain} · ${transportName(account.transport)} · ${effectiveServer(account)}:${effectivePort(account)}</span>
            ${valid ? null : html`<span class="caption danger-text">${candidate.validationErrors.join(' ')}</span>`}
          </div>
        </div>`;
      })}
    </div>

    <div class="form-stack import-profile">
      <div class="form-grid two">
        <${Field} label="Add to profile">
          <${Select} value=${profileChoice} onChange=${setProfileChoice}
            options=${[...state.profiles.map((p) => ({ value: p.id, label: p.name })), { value: NEW_PROFILE, label: 'New profile' }]} />
        </${Field}>
        ${profileChoice === NEW_PROFILE ? html`<${Field} label="Profile name">
          <${TextField} value=${newProfileName} onValue=${setNewProfileName} placeholder=${request.profileName ?? 'For example Office PBX'} />
        </${Field}>` : null}
      </div>
      ${request.candidates.some((c) => c.existingAccountID) ? html`<p class="caption">
        Accounts marked “update existing” are already in Sipper and are not selected. Tick one to replace its password and connection settings; its profile and history stay as they are.
      </p>` : null}
    </div>
  </${Dialog}>`;
}
