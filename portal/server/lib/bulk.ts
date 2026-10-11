import { z } from 'zod'
import { requireOrganisation, requireWorkspace, type Principal } from './access'
import { rows } from './db'
import { ServiceError, requireValue } from './errors'
import { safeFailure } from './http'
import * as platform from './platform'
import { invitationInput } from '../../shared/contracts'
import { bulkInput, type BulkResult } from '../../shared/bulk'

export async function managePeople(actor: Principal, organisationId: string, input: unknown): Promise<BulkResult> {
  const org = await requireOrganisation(actor, organisationId)
  const value = bulkInput.parse(input)
  if (value.action === 'assign_seat' || value.action === 'release_seat') await requireWorkspace(actor, org.workspace_id, 'manage')
  if (value.action === 'assign_account') requireValue((await rows('SELECT id FROM sip_configurations WHERE organisation_id=$1 AND id=$2', [organisationId, value.configurationId]))[0])
  const entries = value.action === 'invite' ? value.entries : value.userIds
  const seen = new Set<string>(), results: BulkResult['results'] = []
  // Separate transactions preserve successful rows. Existing operations recheck access and capacity.
  for (const [index, entry] of entries.entries()) {
    try {
      const invitation = value.action === 'invite' ? invitationInput.parse(entry) : null
      const id = invitation?.email ?? z.string().min(1).max(128).parse(entry)
      if (seen.has(id)) throw new ServiceError(400, 'duplicate_row', 'This person is already included in this batch.')
      seen.add(id)
      if (invitation) {
        const member = await rows("SELECT m.user_id FROM organisation_members m JOIN auth_user u ON u.id=m.user_id WHERE m.organisation_id=$1 AND lower(u.email)=$2 AND m.status<>'removed'", [organisationId, invitation.email])
        if (member.length) throw new ServiceError(409, 'already_member', 'This person already belongs to this customer.')
        await platform.inviteMember(actor, organisationId, invitation)
      } else {
        requireValue((await rows('SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND user_id=$2', [organisationId, id]))[0], 'Person not found in this customer.')
        if (value.action === 'suspend' || value.action === 'resume') await platform.setMemberStatus(actor, organisationId, id, value.action === 'suspend' ? 'suspended' : 'active')
        else if (value.action === 'assign_seat') await platform.assignSeat(actor, org.workspace_id, id)
        else if (value.action === 'release_seat') await platform.releaseSeat(actor, org.workspace_id, id)
        else if (value.action === 'assign_account') await platform.assignConfiguration(actor, organisationId, value.configurationId, id)
      }
      results.push({ index, ok: true, message: invitation ? 'Invitation queued' : 'Updated' })
    } catch (error) {
      const failure = safeFailure(error)
      results.push({ index, ok: false, code: failure.code, message: failure.code === 'invalid_input' ? value.action === 'invite' ? 'Check the email address and role (user or admin).' : 'Invalid person ID.' : failure.message })
    }
  }
  return { results }
}
