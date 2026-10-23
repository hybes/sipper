import { z } from 'zod'
import { sessionPrincipal, safeFailure, checkOrigin, uuid, userId } from '../../lib/http'
import { ServiceError } from '../../lib/errors'
import * as platform from '../../lib/platform'
import * as management from '../../lib/management'
import * as billing from '../../lib/billing'
import { configurePilot } from '../../lib/pilot'
import { managePeople } from '../../lib/bulk'
import { createSetupLink, revokeSetupLink } from '../../lib/setup-links'
import * as staff from '../../lib/workspace-staff'
import { changeMemberRole, removeMember } from '../../lib/customer-members'
import { serviceOverview, failedInvitationEmails, retryInvitationEmail, customerCallActivity, requestCallEnd } from '../../lib/service-operations'
import { organisationDirectory, saveDirectoryContact, deleteDirectoryContact, importDirectoryContacts } from '../../lib/directory'
import { ownDevices, leaveDevice, ownCallingPreferences, setCallingPreference } from '../../lib/devices'
import { companySignIn, saveCompanySignIn, verifyCompanyDomain, setCompanySignInEnabled } from '../../lib/company-sign-in'
import { scimSettings,rotateScimToken,revokeScimToken,provisionedUsers } from '../../lib/scim-settings'
import { messagingRequest } from '../../lib/messages'
import { meetingRequest, customerMeetings, adminEndMeeting } from '../../lib/meetings'

export default defineEventHandler(async event => {
  try {
    const method = event.method
    const headers = new Headers(getRequestHeaders(event) as Record<string, string>)
    if (!['GET', 'HEAD'].includes(method)) checkOrigin(headers)
    const actor = await sessionPrincipal(headers)
    const parts = (getRouterParam(event, 'path') ?? '').split('/')
    let body: unknown
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (!getHeader(event, 'content-type')?.startsWith('application/json')) throw new ServiceError(415, 'json_required', 'Send this request as JSON.')
      try { body = JSON.parse(await limitedBody(event)) }
      catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError(400, 'invalid_json', 'Send valid JSON.') }
    }
    if (parts.join('/') === 'overview' && method === 'GET') return { ...await platform.overview(actor), billing: billing.billingAvailability() }
    if (parts.join('/') === 'me/devices' && method === 'GET') return await ownDevices(actor, getQuery(event))
    if(parts.length>=4 && parts[0]==='me' && parts[1]==='messages') return await messagingRequest(actor,{organisationId:uuid(parts[2])},method,parts.slice(3),body,getQuery(event))
    if(parts.length>=4 && parts[0]==='me' && parts[1]==='conferencing') return await meetingRequest(actor,{organisationId:uuid(parts[2])},method,parts.slice(3),body)
    if (parts.join('/') === 'me/calling-preferences' && method === 'GET') return await ownCallingPreferences(actor)
    if (parts.length === 3 && parts[0] === 'me' && parts[1] === 'calling-preferences' && method === 'PATCH') return await setCallingPreference(actor, uuid(parts[2]), body)
    if (parts.length === 3 && parts[0] === 'me' && parts[1] === 'devices' && method === 'DELETE') return await leaveDevice(actor, uuid(parts[2]))
    if (parts.join('/') === 'service' && method === 'GET') return await serviceOverview(actor)
    if (parts.join('/') === 'service/email-failures' && method === 'GET') return await failedInvitationEmails(actor, z.string().optional().parse(getQuery(event).before))
    if (parts.length === 4 && parts[0] === 'service' && parts[1] === 'email-failures' && parts[3] === 'retry' && method === 'POST') {
      z.object({}).strict().parse(body)
      return await retryInvitationEmail(actor, uuid(parts[2]))
    }
    if (parts.join('/') === 'invitations/accept' && method === 'POST') return await platform.acceptInvitation(actor, z.object({ token: z.string().min(32).max(256) }).strict().parse(body).token)
    if (parts.join('/') === 'invitations/inspect' && method === 'POST') return await platform.inspectInvitation(actor, z.object({ token: z.string().max(256) }).strict().parse(body).token)
    if (parts.length === 2 && parts[0] === 'workspace-invitations' && method === 'POST') {
      const token = z.object({ token: z.string().max(256) }).strict().parse(body).token
      if (parts[1] === 'inspect') return await staff.inspectWorkspaceInvitation(actor, token)
      if (parts[1] === 'accept') return await staff.acceptWorkspaceInvitation(actor, token)
    }
    if (parts[0] === 'workspaces') {
      if (parts.length === 1 && method === 'POST') return await platform.createWorkspace(actor, body)
      const id = uuid(parts[1])
      if (parts.length === 2 && method === 'GET') return await platform.workspaceDetails(actor, id)
      if (parts.length === 3 && parts[2] === 'staff' && method === 'GET') return await staff.workspaceStaff(actor, id)
      if (parts.length === 3 && parts[2] === 'staff-invitations' && method === 'POST') return await staff.inviteWorkspaceStaff(actor, id, body)
      if (parts.length === 4 && parts[2] === 'staff-invitations' && method === 'DELETE') return await staff.revokeWorkspaceInvitation(actor, id, uuid(parts[3]))
      if (parts.length === 4 && parts[2] === 'staff') {
        if (method === 'PATCH') return await staff.changeWorkspaceMember(actor, id, userId(parts[3]), body)
        if (method === 'DELETE') return await staff.changeWorkspaceMember(actor, id, userId(parts[3]), null)
      }
      if (parts.length === 3 && parts[2] === 'organisations' && method === 'POST') return await platform.createOrganisation(actor, id, body)
      if (parts.length === 3 && parts[2] === 'audit' && method === 'GET') return await management.auditHistory(actor, id, z.string().optional().parse(getQuery(event).before))
      if (parts.length === 4 && parts[2] === 'seats') {
        if (method === 'PUT') return await platform.assignSeat(actor, id, userId(parts[3]))
        if (method === 'DELETE') return await platform.releaseSeat(actor, id, userId(parts[3]))
      }
      if (parts.length === 4 && parts[2] === 'billing' && method === 'POST') {
        if (parts[3] === 'pilot') return await configurePilot(actor, id, body)
        if (parts[3] === 'checkout') return await billing.checkout(actor, id, body)
        if (parts[3] === 'portal') return await billing.billingPortal(actor, id)
        if (parts[3] === 'quantity') return await billing.changeQuantity(actor, id, body)
        if (parts[3] === 'test') return await billing.configureTestBilling(actor, id, body)
      }
    }
    if (parts[0] === 'organisations') {
      const id = uuid(parts[1])
      if (parts.length === 2 && method === 'GET') return await platform.organisationDetails(actor, id)
      if(parts.length===3 && parts[2]==='meetings' && method==='GET')return await customerMeetings(actor,id,getQuery(event))
      if(parts.length===3 && parts[2]==='provisioning') {
        if(method==='GET')return await scimSettings(actor,id)
        if(method==='POST')return await rotateScimToken(actor,id,body)
        if(method==='DELETE')return await revokeScimToken(actor,id)
      }
      if(parts.length===4 && parts[2]==='provisioning' && parts[3]==='users' && method==='GET')return await provisionedUsers(actor,id,getQuery(event))
      if (parts.length === 3 && parts[2] === 'company-sign-in') {
        if (method === 'GET') return await companySignIn(actor, id)
        if (method === 'PUT') return await saveCompanySignIn(actor, id, body)
        if (method === 'PATCH') return await setCompanySignInEnabled(actor, id, body)
      }
      if (parts.length === 4 && parts[2] === 'company-sign-in' && parts[3] === 'verify' && method === 'POST') {
        z.object({}).strict().parse(body)
        return await verifyCompanyDomain(actor, id)
      }
      if (parts.length === 3 && parts[2] === 'directory' && method === 'GET') return await organisationDirectory(actor,id,getQuery(event))
      if (parts.length === 3 && parts[2] === 'directory' && method === 'POST') return await saveDirectoryContact(actor,id,null,body)
      if (parts.length === 3 && parts[2] === 'calls' && method === 'GET') return await customerCallActivity(actor, id,
        z.string().optional().parse(getQuery(event).before), z.string().optional().parse(getQuery(event).call))
      if (parts.length === 3 && method === 'POST') {
        if (parts[2] === 'bulk') return await managePeople(actor, id, body)
        if (parts[2] === 'invitations') return await platform.inviteMember(actor, id, body)
        if (parts[2] === 'configurations') return await platform.createConfiguration(actor, id, body)
        if (parts[2] === 'groups') return await management.createGroup(actor, id, body)
      }
      if (parts.length === 4) {
        if (parts[2] === 'groups' && method === 'PATCH') return await management.updateGroup(actor, id, uuid(parts[3]), body)
        if (parts[2] === 'directory' && parts[3] === 'import' && method === 'POST') return await importDirectoryContacts(actor,id,body)
        if (parts[2] === 'directory' && method === 'PATCH') return await saveDirectoryContact(actor,id,uuid(parts[3]),body)
        if (parts[2] === 'directory' && method === 'DELETE') return await deleteDirectoryContact(actor,id,uuid(parts[3]),Number(z.string().regex(/^[1-9][0-9]{0,9}$/).parse(getQuery(event).revision)))
        if (parts[2] === 'members' && method === 'DELETE') return await removeMember(actor, id, userId(parts[3]))
        if (parts[2] === 'setup-links' && method === 'DELETE') return await revokeSetupLink(actor, id, uuid(parts[3]))
        if (parts[2] === 'invitations' && method === 'DELETE') return await management.revokeInvitation(actor, id, uuid(parts[3]))
        if (parts[2] === 'devices' && method === 'DELETE') return await platform.revokeDevice(actor, id, uuid(parts[3]))
        if (parts[2] === 'configurations' && method === 'PATCH') return await management.updateConfiguration(actor, id, uuid(parts[3]), body)
        if (parts[2] === 'configurations' && method === 'DELETE') return await management.deleteConfiguration(actor, id, uuid(parts[3]))
        if (parts[2] === 'groups' && method === 'DELETE') return await management.deleteGroup(actor, id, uuid(parts[3]))
      }
      if (parts.length === 5) {
        if(parts[2]==='meetings' && parts[4]==='end' && method==='POST') {z.object({}).strict().parse(body);return await adminEndMeeting(actor,id,uuid(parts[3]))}
        if (parts[2] === 'calls' && parts[4] === 'end' && method === 'POST') {
          z.object({}).strict().parse(body)
          return await requestCallEnd(actor,id,uuid(parts[3]))
        }
        if (parts[2] === 'members' && parts[4] === 'role' && method === 'PATCH') return await changeMemberRole(actor, id, userId(parts[3]), body)
        if (parts[2] === 'members' && parts[4] === 'setup-link' && method === 'POST') return await createSetupLink(actor, id, userId(parts[3]))
        if (parts[2] === 'members' && parts[4] === 'status' && method === 'PATCH') return await platform.setMemberStatus(actor, id, userId(parts[3]), z.object({ status: z.enum(['active', 'suspended']) }).strict().parse(body).status)
        if (parts[2] === 'groups' && method === 'PUT') {
          if (parts[4] === 'members') return await management.setGroupMembers(actor, id, uuid(parts[3]), body)
          if (parts[4] === 'configurations') return await management.setGroupConfigurations(actor, id, uuid(parts[3]), body)
        }
      }
      if (parts.length === 6 && parts[2] === 'configurations' && parts[4] === 'users') {
        if (method === 'PUT') return await platform.assignConfiguration(actor, id, uuid(parts[3]), userId(parts[5]))
        if (method === 'DELETE') return await management.unassignConfiguration(actor, id, uuid(parts[3]), userId(parts[5]))
      }
    }
    throw new ServiceError(404, 'not_found', 'Not found.')
  } catch (error) {
    const failure = safeFailure(error)
    setResponseStatus(event, failure.statusCode)
    return failure
  }
})
