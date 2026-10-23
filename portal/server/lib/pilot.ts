import { z } from 'zod'
import { audit, isPlatformOwner, requireAdminMfa, requireWorkspace, type Principal } from './access'
import { rows, transaction } from './db'
import { ServiceError } from './errors'

const pilotInput = z.object({
  quantity: z.number().int().min(1).max(1000),
  expiresAt: z.iso.datetime(),
  expectedUpdatedAt: z.iso.datetime().nullable(),
}).strict()

// A pilot is an explicitly granted, expiring entitlement. It never enables the
// development billing endpoint or fabricates a Stripe payment in production.
export async function configurePilot(actor: Principal, workspaceId: string, input: unknown) {
  requireAdminMfa(actor)
  const value = pilotInput.parse(input)
  return transaction(async db => {
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    if (!await isPlatformOwner(actor, db)) throw new ServiceError(404, 'not_found', 'Not found.')
    await requireWorkspace(actor, workspaceId, 'billing', db)
    const existing = (await rows('SELECT * FROM subscriptions WHERE workspace_id=$1', [workspaceId], db))[0]
    if (existing && existing.provider !== 'pilot') {
      throw new ServiceError(409, 'subscription_exists', 'Pilot licences cannot replace an existing subscription.')
    }
    const now = (await rows('SELECT now() AS time', [], db))[0]!.time as Date
    const expiresAt = new Date(value.expiresAt)
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 90 * 86400000) {
      throw new ServiceError(400, 'invalid_pilot_expiry', 'Choose a future expiry within the next 90 days.')
    }
    // A retried save must not extend the period or create another audit event.
    if (existing?.status === 'active' && existing.purchased_seats === value.quantity &&
        existing.paid_until.getTime() === expiresAt.getTime()) {
      return { pilot: true, purchasedSeats: value.quantity, expiresAt: value.expiresAt }
    }
    if ((existing?.updated_at.toISOString() ?? null) !== value.expectedUpdatedAt) {
      throw new ServiceError(409, 'pilot_changed', 'Pilot licences have changed. Reload the workspace before saving again.')
    }
    const used = Number((await rows('SELECT count(*) AS count FROM seat_assignments WHERE workspace_id=$1', [workspaceId], db))[0]!.count)
    if (value.quantity < used) throw new ServiceError(409, 'seats_in_use', 'Release assigned licences before reducing pilot capacity.')
    await db.query(`INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until)
      VALUES ($1,'pilot','active',$2,$3)
      ON CONFLICT (workspace_id) DO UPDATE SET status='active',purchased_seats=$2,paid_until=$3,
      over_capacity=false,cancellation_scheduled=false,updated_at=clock_timestamp()`, [workspaceId, value.quantity, expiresAt])
    await audit(db, actor, workspaceId, 'billing.pilot_updated', workspaceId, undefined,
      { quantity: value.quantity, expiresAt: value.expiresAt })
    return { pilot: true, purchasedSeats: value.quantity, expiresAt: value.expiresAt }
  })
}
