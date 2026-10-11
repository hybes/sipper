import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { audit, requireOrganisation, requireVerified, type Principal } from './access'
import { getConfig } from './config'
import { rows, transaction } from './db'
import { ServiceError, requireValue } from './errors'
import { requireLicensedMember } from './platform'

const hash = (reference: string) => createHash('sha256').update(reference).digest('hex')
const referenceInput = z.object({ reference: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()

export async function createSetupLink(actor: Principal, organisationId: string, userId: string) {
  return transaction(async db => {
    const org = await requireOrganisation(actor, organisationId, true, db)
    const target = requireValue((await rows('SELECT u.id,u.email,u."emailVerified" AS verified FROM organisation_members m JOIN auth_user u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.user_id=$2 FOR UPDATE OF m', [organisationId, userId], db))[0])
    await requireLicensedMember({ userId: target.id, email: target.email, verified: target.verified, mfa: false }, organisationId, db)
    await db.query('UPDATE setup_links SET revoked_at=now() WHERE organisation_id=$1 AND user_id=$2 AND used_at IS NULL AND revoked_at IS NULL', [organisationId, userId])
    const reference = randomBytes(32).toString('base64url')
    const link = (await rows("INSERT INTO setup_links (organisation_id,user_id,token_hash,created_by,expires_at) VALUES ($1,$2,$3,$4,now()+interval '15 minutes') RETURNING id,expires_at", [organisationId, userId, hash(reference), actor.userId], db))[0]!
    await audit(db, actor, org.workspace_id, 'setup_link.created', link.id, organisationId, { userId })
    const url = new URL('/portal/setup', getConfig().SIPPER_BASE_URL)
    // Fragments never reach the web server, referrer headers or ordinary access logs.
    url.hash = `ref=${reference}`
    return { id: link.id, url: url.href, expiresAt: link.expires_at }
  })
}

export async function revokeSetupLink(actor: Principal, organisationId: string, id: string) {
  return transaction(async db => {
    const org = await requireOrganisation(actor, organisationId, true, db)
    requireValue((await rows('UPDATE setup_links SET revoked_at=COALESCE(revoked_at,now()) WHERE organisation_id=$1 AND id=$2 AND used_at IS NULL RETURNING id', [organisationId, id], db))[0])
    await audit(db, actor, org.workspace_id, 'setup_link.revoked', id, organisationId)
    return { revoked: true }
  })
}

export async function redeemSetupLink(actor: Principal, input: unknown) {
  requireVerified(actor)
  const { reference } = referenceInput.parse(input)
  return transaction(async db => {
    const link = (await rows('SELECT id,organisation_id FROM setup_links WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE', [hash(reference), actor.userId], db))[0]
    if (!link) throw new ServiceError(404, 'setup_link_unavailable', 'This setup link is expired, already used or belongs to another person. Ask your administrator for a new link.')
    const member = await requireLicensedMember(actor, link.organisation_id, db)
    await db.query('UPDATE setup_links SET used_at=now() WHERE id=$1', [link.id])
    await audit(db, actor, member.workspace_id, 'setup_link.used', link.id, link.organisation_id)
    return { userId: actor.userId, organisation: { id: link.organisation_id, name: member.name, status: 'active', licensed: true } }
  })
}
