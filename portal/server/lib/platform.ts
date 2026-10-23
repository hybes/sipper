import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { rows, transaction, getPool, type Database } from './db'
import { audit, requireAdminMfa, requireOrganisation, requireVerified, requireWorkspace, isPlatformOwner, lockManagedOrganisation, canAdministerOrganisation, type Principal } from './access'
import { revokeMemberInvitations } from './customer-members'
import { ServiceError, requireValue } from './errors'
import { getConfig } from './config'
import { sealSecret, openSecret } from './crypto'
import { gatewayAccount } from './gateway'
import { groupRevision } from './management'
import { configurationInput, deviceInput, invitationInput, organisationInput, workspaceInput, type ManagedConfiguration } from '../../shared/contracts'

export async function overview(actor: Principal) {
  requireVerified(actor)
  const owner = await isPlatformOwner(actor)
  if (owner) requireAdminMfa(actor)
  const workspaces = await rows(`SELECT w.*, m.role, COALESCE(s.purchased_seats,0) AS purchased_seats,
    CASE WHEN s.provider='pilot' AND s.paid_until<=now() THEN 'expired'
      ELSE COALESCE(s.status,'inactive') END AS subscription_status,
    (SELECT count(*)::integer FROM seat_assignments a WHERE a.workspace_id=w.id) AS assigned_seats
    FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$1
    LEFT JOIN subscriptions s ON s.workspace_id=w.id WHERE ($2 OR m.user_id IS NOT NULL) ORDER BY w.created_at`, [actor.userId, owner])
  const organisations = await rows(`SELECT o.*, m.role, m.status FROM organisations o
    JOIN organisation_members m ON m.organisation_id=o.id WHERE m.user_id=$1 AND m.status<>'removed' ORDER BY o.name`, [actor.userId])
  return { user: { id: actor.userId, email: actor.email, mfa: actor.mfa }, platformOwner: owner, workspaces, organisations }
}

export async function createWorkspace(actor: Principal, input: unknown) {
  requireAdminMfa(actor)
  const value = workspaceInput.parse(input)
  return transaction(async db => {
    const workspace = (await rows('INSERT INTO workspaces (name, kind) VALUES ($1, $2) RETURNING *', [value.name, value.kind], db))[0]!
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, actor.userId])
    await audit(db, actor, workspace.id, 'workspace.created', workspace.id)
    return workspace
  })
}
export async function workspaceDetails(actor: Principal, workspaceId: string) {
  const workspace = await requireWorkspace(actor, workspaceId, 'read')
  const organisations = await rows(`SELECT o.*,
    (SELECT count(*)::integer FROM organisation_members m WHERE m.organisation_id=o.id AND m.status<>'removed') AS people_count,
    (SELECT count(*)::integer FROM devices d WHERE d.organisation_id=o.id AND d.revoked_at IS NULL) AS device_count
    FROM organisations o WHERE workspace_id=$1 ORDER BY name`, [workspaceId])
  const subscription = (await rows('SELECT provider, status, purchased_seats, paid_until, grace_until, over_capacity, cancellation_scheduled, updated_at FROM subscriptions WHERE workspace_id=$1', [workspaceId]))[0] ?? null
  const seats = await rows('SELECT s.user_id, u.name, u.email FROM seat_assignments s JOIN auth_user u ON u.id=s.user_id WHERE s.workspace_id=$1 ORDER BY u.email', [workspaceId])
  const role = await isPlatformOwner(actor) ? 'owner' : (await rows('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actor.userId]))[0]?.role
  return { workspace, organisations, subscription, seats, permissions: { manageCustomers: ['owner', 'admin'].includes(role), viewCustomers: ['owner', 'admin', 'support'].includes(role), manageBilling: ['owner', 'admin', 'billing'].includes(role), viewStaff: ['owner', 'admin'].includes(role) } }
}
export async function createOrganisation(actor: Principal, workspaceId: string, input: unknown) {
  const value = organisationInput.parse(input)
  return transaction(async db => {
    await requireWorkspace(actor, workspaceId, 'manage', db)
    const organisation = (await rows('INSERT INTO organisations (workspace_id, name) VALUES ($1, $2) RETURNING *', [workspaceId, value.name], db))[0]!
    await audit(db, actor, workspaceId, 'organisation.created', organisation.id, organisation.id)
    return organisation
  })
}
export async function organisationDetails(actor: Principal, organisationId: string) {
  const organisation = await requireOrganisation(actor, organisationId, 'inspect')
  const members = await rows(`SELECT m.user_id, m.role, m.status, m.removed_at,m.scim_user_id,m.do_not_disturb,m.availability,m.calling_preference_updated_at, u.name, u.email, s.user_id IS NOT NULL AS licensed,
    (SELECT max(d.last_login_at) FROM devices d WHERE d.organisation_id=m.organisation_id AND d.user_id=m.user_id) AS last_login_at,
    activity.last_request_at,activity.last_request_ip,activity.last_request_action
    FROM organisation_members m JOIN auth_user u ON u.id=m.user_id LEFT JOIN seat_assignments s ON s.workspace_id=m.workspace_id AND s.user_id=m.user_id
    LEFT JOIN LATERAL (SELECT last_request_at,host(last_request_ip) AS last_request_ip,last_request_action FROM devices d
      WHERE d.organisation_id=m.organisation_id AND d.user_id=m.user_id AND d.last_request_at IS NOT NULL ORDER BY last_request_at DESC LIMIT 1) activity ON true
    WHERE m.organisation_id=$1 ORDER BY u.name`, [organisationId])
  const configurations = await rows('SELECT id, label, mode, settings, revision, updated_at FROM sip_configurations WHERE organisation_id=$1 ORDER BY label', [organisationId])
  const invitations = await rows('SELECT id, email, role, expires_at, accepted_at, revoked_at FROM invitations WHERE organisation_id=$1 ORDER BY created_at DESC', [organisationId])
  const devices = await rows(`SELECT d.id,d.user_id,d.name,d.platform,d.app_version,d.os_version,d.enrolled_at,d.last_seen_at,d.revoked_at,d.applied_revision,d.status,
    d.last_login_at,d.last_request_at,host(d.last_request_ip) AS last_request_ip,d.last_request_action,d.last_configuration_at,d.last_report_at,
    p.provider AS push_provider,p.updated_at AS push_updated_at,p.disabled_at AS push_disabled_at,p.last_push_at,p.last_push_status,p.last_wake_at
    FROM devices d LEFT JOIN push_endpoints p ON p.device_id=d.id WHERE d.organisation_id=$1 ORDER BY d.enrolled_at DESC`, [organisationId])
  const assignments = await rows('SELECT configuration_id, user_id FROM sip_assignments WHERE organisation_id=$1', [organisationId])
  const gatewayRegistrations = await rows(`SELECT g.device_id,g.configuration_id,g.registration_state AS state,
    host(g.registration_ip) AS ip,g.registration_observed_at AS "observedAt",
    coalesce(n.controller_instance=g.registration_controller AND n.registration_generation=g.registration_generation AND n.ready_until>now() AND n.controller_expires_at>now(),false) AS ready,
    CASE WHEN n.controller_instance=g.registration_controller AND n.registration_generation=g.registration_generation THEN least(n.ready_until,n.controller_expires_at) END AS "readyUntil"
    FROM gateway_credentials g JOIN gateway_nodes n ON n.id=g.gateway_id
    WHERE g.organisation_id=$1 AND g.realm=n.host`, [organisationId])
  const upstreamRegistrations = await rows(`SELECT r.configuration_id,r.state,r.observed_at AS "observedAt",'gateway' AS source,
    coalesce(n.controller_instance=r.controller_instance AND n.registration_generation=r.registration_generation AND n.ready_until>now() AND n.controller_expires_at>now(),false) AS ready,
    CASE WHEN n.controller_instance=r.controller_instance AND n.registration_generation=r.registration_generation THEN least(n.ready_until,n.controller_expires_at) END AS "readyUntil"
    FROM gateway_upstream_registrations r JOIN sip_configurations c ON c.id=r.configuration_id AND c.revision=r.revision AND c.mode='gateway'
    JOIN gateway_nodes n ON n.id=r.gateway_id WHERE c.organisation_id=$1 AND n.id=$2`, [organisationId,getConfig().SIPPER_GATEWAY_ID])
  const groups = await rows(`SELECT g.id,g.name,EXISTS(SELECT 1 FROM scim_groups s WHERE s.id=g.id) AS scim_managed, ARRAY(SELECT user_id FROM group_members m WHERE m.group_id=g.id) AS user_ids, ARRAY(SELECT configuration_id FROM group_configurations c WHERE c.group_id=g.id) AS configuration_ids FROM groups g WHERE organisation_id=$1 ORDER BY name`, [organisationId])
  const setupLinks = await rows('SELECT id,user_id,created_at,expires_at,used_at,revoked_at FROM setup_links WHERE organisation_id=$1 AND expires_at>now() ORDER BY created_at DESC', [organisationId])
  // Established calls survive withdrawal; ringing recipients must still be eligible.
  // This projection deliberately excludes caller identity, numbers and SIP secrets.
  const activeCalls = await rows(`SELECT c.id,d.id AS device_id,c.direction,
    CASE WHEN c.state='answering' AND c.winner_device_id<>d.id THEN 'ringing' ELSE c.state END AS state,
    c.expires_at,c.claim_until,c.end_requested_at,n.controller_expires_at,n.ready_until,n.last_heartbeat_at
    FROM gateway_calls c LEFT JOIN call_recipients r ON c.direction='incoming' AND r.call_id=c.id AND r.organisation_id=c.organisation_id
    JOIN devices d ON d.id=CASE WHEN c.direction='outgoing' THEN c.origin_device_id ELSE r.device_id END AND d.organisation_id=c.organisation_id
    LEFT JOIN gateway_nodes n ON n.id=c.gateway_id
    WHERE c.organisation_id=$1 AND c.transferred_at IS NULL AND (
      (c.state='answered' AND (c.direction='outgoing' OR c.winner_device_id=d.id))
      OR (c.state IN ('ringing','answering') AND c.end_requested_at IS NOT NULL)
      OR (c.state IN ('ringing','answering') AND c.expires_at>now() AND (c.direction='outgoing' OR r.declined_at IS NULL)
        AND EXISTS(SELECT 1 FROM eligible_gateway_devices e WHERE e.device_id=d.id AND e.configuration_id=c.configuration_id)))`, [organisationId])
  return { organisation, members, configurations, invitations, devices, assignments, groups: groups.map(group => ({ ...group, revision: groupRevision(group) })), setupLinks, gatewayRegistrations, upstreamRegistrations, activeCalls, permissions: { manage: await canAdministerOrganisation(actor.userId, organisationId) } }
}

function hashToken(token: string) { return createHash('sha256').update(token).digest('hex') }
export async function inviteMember(actor: Principal, organisationId: string, input: unknown) {
  const value = invitationInput.parse(input)
  return transaction(async db => {
    const organisation = await lockManagedOrganisation(actor, organisationId, db)
    await db.query('UPDATE invitations SET revoked_at=now() WHERE organisation_id=$1 AND lower(email)=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [organisationId, value.email])
    const token = randomBytes(32).toString('base64url')
    const invitation = (await rows(`INSERT INTO invitations (workspace_id, organisation_id, email, role, token_hash, expires_at, created_by)
      VALUES ($1,$2,$3,$4,$5,now()+interval '7 days',$6) RETURNING id,email,role,expires_at`, [organisation.workspace_id, organisationId, value.email, value.role, hashToken(token), actor.userId], db))[0]!
    const jobId = randomUUID()
    const link = new URL('/portal/invitations/accept', getConfig().SIPPER_BASE_URL)
    link.hash = `token=${token}`
    const message = { to: value.email, subject: `You're invited to ${organisation.name} on Sipper`, text: `You've been invited to ${organisation.name}. Sign in with this email address to accept:\n\n${link}\n\nThe invitation expires in seven days. If unexpected, ignore it.` }
    const payload = sealSecret(JSON.stringify(message), `mail:${jobId}`)
    await db.query("INSERT INTO jobs (id, kind, deduplication_key, payload) VALUES ($1, 'email', $2, $3)", [jobId, `invitation:${invitation.id}`, JSON.stringify(payload)])
    await audit(db, actor, organisation.workspace_id, 'invitation.created', invitation.id, organisationId)
    return invitation
  })
}
async function customerInvitation(actor: Principal, token: string, db?: Database, lock = false) {
  requireVerified(actor)
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError(400, 'invalid_invitation', 'This invitation is invalid or expired.')
  const invitation = (await rows(`SELECT i.*,o.name AS organisation_name,m.status AS member_status,m.role AS member_role
    FROM invitations i JOIN organisations o ON o.id=i.organisation_id
    LEFT JOIN organisation_members m ON m.organisation_id=i.organisation_id AND m.user_id=$2
    WHERE i.token_hash=$1 ${lock ? 'FOR UPDATE OF i' : ''}`, [hashToken(token), actor.userId], db))[0]
  if (!invitation || invitation.accepted_at || invitation.revoked_at || new Date(invitation.expires_at) <= new Date()) throw new ServiceError(400, 'invalid_invitation', 'This invitation is invalid or expired.')
  if (invitation.email.toLowerCase() !== actor.email.toLowerCase()) throw new ServiceError(403, 'invitation_email_mismatch', 'Sign in with the email address that received this invitation.')
  if (!await canAdministerOrganisation(invitation.created_by, invitation.organisation_id, db)) throw new ServiceError(400, 'invalid_invitation', 'Ask your administrator for a new invitation.')
  if (invitation.member_status === 'suspended') throw new ServiceError(403, 'user_suspended', 'Your administrator must resume your access before you can accept an invitation.')
  return invitation
}
export async function inspectInvitation(actor: Principal, token: string) {
  const invitation = await customerInvitation(actor, token)
  return { organisationName: invitation.organisation_name as string, role: invitation.role as 'user' | 'admin', expiresAt: invitation.expires_at,
    existingRole: invitation.member_status === 'active' ? invitation.member_role as 'user' | 'admin' : null }
}
export async function acceptInvitation(actor: Principal, token: string) {
  requireVerified(actor)
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError(400, 'invalid_invitation', 'This invitation is invalid or expired.')
  return transaction(async db => {
    const hint = (await rows('SELECT organisation_id FROM invitations WHERE token_hash=$1', [hashToken(token)], db))[0]
    if (!hint) throw new ServiceError(400, 'invalid_invitation', 'This invitation is invalid or expired.')
    await db.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE', [hint.organisation_id])
    const invitation = await customerInvitation(actor, token, db, true)
    if (invitation.role === 'admin') requireAdminMfa(actor)
    await db.query(`INSERT INTO organisation_members (workspace_id, organisation_id, user_id, role) VALUES ($1,$2,$3,$4)
      ON CONFLICT (organisation_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active',removed_at=NULL,joined_at=now(),scim_user_id=NULL
      WHERE organisation_members.status='removed'`, [invitation.workspace_id, invitation.organisation_id, actor.userId, invitation.role])
    await db.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [invitation.id])
    await audit(db, actor, invitation.workspace_id, 'invitation.accepted', invitation.id, invitation.organisation_id)
    if (invitation.member_status === 'removed') await audit(db, actor, invitation.workspace_id, 'member.restored', actor.userId, invitation.organisation_id, { role: invitation.role })
    return { organisationId: invitation.organisation_id }
  })
}

export async function assignSeat(actor: Principal, workspaceId: string, userId: string) {
  return transaction(async db => {
    await requireWorkspace(actor, workspaceId, 'manage', db)
    // Serialise allocations and subscription changes on the same workspace row.
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const member = (await rows("SELECT user_id FROM organisation_members WHERE workspace_id=$1 AND user_id=$2 AND status<>'removed'", [workspaceId, userId], db))[0]
    if (!member) throw new ServiceError(404, 'not_found', 'User does not belong to this workspace.')
    if ((await rows('SELECT user_id FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId], db)).length) return { assigned: true }
    const subscription = (await rows(`SELECT purchased_seats FROM subscriptions WHERE workspace_id=$1
      AND (status IN ('active','trialing') OR (status='past_due' AND grace_until>now()))
      AND (paid_until IS NULL OR paid_until>now() OR grace_until>now())`, [workspaceId], db))[0]
    const used = Number((await rows('SELECT count(*) AS count FROM seat_assignments WHERE workspace_id=$1', [workspaceId], db))[0]!.count)
    if (!subscription || used >= subscription.purchased_seats) throw new ServiceError(409, 'no_available_seats', 'There are no available user licences. Review this workspace’s licence capacity before assigning this person.')
    await db.query('INSERT INTO seat_assignments (workspace_id,user_id) VALUES ($1,$2)', [workspaceId, userId])
    await audit(db, actor, workspaceId, 'seat.assigned', userId)
    return { assigned: true }
  })
}
export async function releaseSeat(actor: Principal, workspaceId: string, userId: string) {
  return transaction(async db => {
    await requireWorkspace(actor, workspaceId, 'manage', db)
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    await db.query('DELETE FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])
    await audit(db, actor, workspaceId, 'seat.released', userId)
    return { assigned: false }
  })
}
export async function setMemberStatus(actor: Principal, organisationId: string, userId: string, status: 'active' | 'suspended') {
  return transaction(async db => {
    const organisation = await lockManagedOrganisation(actor, organisationId, db)
    const member = requireValue((await rows('SELECT m.status,u.email FROM organisation_members m JOIN auth_user u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.user_id=$2 FOR UPDATE OF m', [organisationId, userId], db))[0])
    if (member.status === 'removed') throw new ServiceError(409, 'member_removed', 'Send a new invitation to restore this person’s customer access.')
    await db.query('UPDATE organisation_members SET status=$1 WHERE organisation_id=$2 AND user_id=$3', [status, organisationId, userId])
    if (status === 'suspended') await revokeMemberInvitations(db, organisationId, userId, member.email, false)
    await audit(db, actor, organisation.workspace_id, status === 'active' ? 'member.resumed' : 'member.suspended', userId, organisationId)
    return { status }
  })
}

export async function createConfiguration(actor: Principal, organisationId: string, input: unknown) {
  const value = configurationInput.parse(input)
  return transaction(async db => {
    const organisation = await requireOrganisation(actor, organisationId, true, db)
    const id = randomUUID()
    const envelope = sealSecret(value.password, `sip:${organisationId}:${id}`)
    const config = (await rows(`INSERT INTO sip_configurations (id, organisation_id, label, mode, settings, secret_envelope)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,label,mode,settings,revision`, [id, organisationId, value.label, value.mode, JSON.stringify(value.settings), JSON.stringify(envelope)], db))[0]!
    await audit(db, actor, organisation.workspace_id, 'sip_configuration.created', id, organisationId)
    return config
  })
}
export async function assignConfiguration(actor: Principal, organisationId: string, configurationId: string, userId: string) {
  return transaction(async db => {
    const organisation = await requireOrganisation(actor, organisationId, true, db)
    requireValue((await rows('SELECT id FROM sip_configurations WHERE organisation_id=$1 AND id=$2', [organisationId, configurationId], db))[0])
    requireValue((await rows("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status<>'removed' FOR SHARE", [organisationId, userId], db))[0])
    await db.query('INSERT INTO sip_assignments (organisation_id,configuration_id,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [organisationId, configurationId, userId])
    await audit(db, actor, organisation.workspace_id, 'sip_configuration.assigned', configurationId, organisationId, { userId })
    return { assigned: true }
  })
}

export async function requireLicensedMember(actor: Principal, organisationId: string, db: Database = getPool()) {
  requireVerified(actor)
  const member = (await rows(`SELECT m.*,o.name FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
    JOIN seat_assignments a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
    JOIN subscriptions s ON s.workspace_id=m.workspace_id
    WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active'
    AND (s.status IN ('active','trialing') OR (s.status='past_due' AND s.grace_until>now()))
    AND (s.paid_until IS NULL OR s.paid_until>now() OR s.grace_until>now())
    AND (SELECT count(*) FROM seat_assignments sa WHERE sa.workspace_id=m.workspace_id)<=s.purchased_seats`, [organisationId, actor.userId], db))[0]
  if (!member) throw new ServiceError(403, 'managed_access_unavailable', 'An active membership and assigned licence are required.')
  return member
}
export async function enrolDevice(actor: Principal, organisationId: string, input: unknown) {
  const value = deviceInput.parse(input)
  return transaction(async db => {
    // Removal locks the same membership before revoking its devices, so a pending
    // enrolment cannot leave a new unrevoked installation after removal commits.
    await db.query('SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 FOR UPDATE', [organisationId, actor.userId])
    const member = await requireLicensedMember(actor, organisationId, db)
    const existing = (await rows('SELECT id,revoked_at FROM devices WHERE organisation_id=$1 AND user_id=$2 AND installation_id=$3 FOR UPDATE', [organisationId, actor.userId, value.installationId], db))[0]
    if (existing?.revoked_at) throw new ServiceError(403, 'device_revoked', 'This device was revoked. Contact your administrator.')
    const result = (await rows(`INSERT INTO devices (organisation_id,user_id,installation_id,name,platform,app_version,os_version,last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (organisation_id,user_id,installation_id)
      DO UPDATE SET name=EXCLUDED.name, app_version=EXCLUDED.app_version, os_version=EXCLUDED.os_version, last_seen_at=now()
      WHERE devices.revoked_at IS NULL RETURNING id,name,platform`, [organisationId, actor.userId, value.installationId, value.name, value.platform, value.appVersion, value.osVersion], db))[0]
    if (!result) throw new ServiceError(403, 'device_revoked', 'This device was revoked. Contact your administrator.')
    if (!existing) await audit(db, actor, member.workspace_id, 'device.enrolled', result.id, organisationId)
    return result
  })
}
export async function provisionDevice(actor: Principal, deviceId: string): Promise<ManagedConfiguration> {
  return transaction(async db => {
    const device = (await rows('SELECT * FROM devices WHERE id=$1 AND user_id=$2', [deviceId, actor.userId], db))[0]
    if (!device || device.revoked_at) throw new ServiceError(403, 'device_unavailable', 'This device is not enrolled or has been revoked.')
    const member = await requireLicensedMember(actor, device.organisation_id, db)
    const configs = await rows(`SELECT c.* FROM sip_configurations c WHERE c.organisation_id=$1 AND (EXISTS (SELECT 1 FROM sip_assignments a WHERE a.configuration_id=c.id AND a.user_id=$2) OR EXISTS (SELECT 1 FROM group_configurations g JOIN group_members m ON m.group_id=g.group_id WHERE g.configuration_id=c.id AND m.user_id=$2)) ORDER BY c.id`, [device.organisation_id, actor.userId], db)
    const accounts: ManagedConfiguration['accounts'] = []
    for (const c of configs) {
      accounts.push(c.mode === 'gateway' ? await gatewayAccount(db, deviceId, c as Parameters<typeof gatewayAccount>[2])
        : { id: c.id, label: c.label, mode: c.mode, revision: c.revision, doNotDisturb: member.do_not_disturb, settings: c.settings, password: openSecret(c.secret_envelope, `sip:${c.organisation_id}:${c.id}`) })
    }
    // Direct-call policy, a gateway move or credential rotation changes what the client must apply.
    const revision = createHash('sha256').update(JSON.stringify(accounts.map(({ password: _password, ...account }) => account))).digest('hex')
    await db.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [deviceId])
    return {
      schemaVersion: 1, organisation: { id: device.organisation_id, name: member.name }, deviceId, revision,
      expiresAt: new Date(Date.now() + getConfig().SIPPER_CONFIG_TTL_SECONDS * 1000).toISOString(),
      accounts,
    }
  })
}
export async function revokeDevice(actor: Principal, organisationId: string, deviceId: string) {
  return transaction(async db => {
    const organisation = await requireOrganisation(actor, organisationId, true, db)
    const result = await db.query('UPDATE devices SET revoked_at=COALESCE(revoked_at,now()) WHERE organisation_id=$1 AND id=$2 RETURNING id', [organisationId, deviceId])
    requireValue(result.rows[0])
    await audit(db, actor, organisation.workspace_id, 'device.revoked', deviceId, organisationId)
    return { revoked: true }
  })
}
