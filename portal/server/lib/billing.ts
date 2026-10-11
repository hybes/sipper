import Stripe from 'stripe'
import { z } from 'zod'
import { getConfig } from './config'
import { rows, transaction, type Database } from './db'
import { requireWorkspace, audit, type Principal } from './access'
import { ServiceError } from './errors'

let instance: Stripe | undefined
function stripe() {
  const key = getConfig().STRIPE_SECRET_KEY
  if (!key) throw new ServiceError(503, 'billing_not_configured', 'Payments are not available yet. Your workspace is saved.')
  return instance ??= new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 })
}
export function billingAvailability() {
  const c = getConfig()
  return { checkout: Boolean(c.STRIPE_SECRET_KEY && c.STRIPE_WEBHOOK_SECRET && (c.STRIPE_PRICE_MONTHLY || c.STRIPE_PRICE_ANNUAL)),
    monthly: Boolean(c.STRIPE_PRICE_MONTHLY), annual: Boolean(c.STRIPE_PRICE_ANNUAL),
    localTestBilling: c.NODE_ENV !== 'production' && c.SIPPER_ALLOW_TEST_BILLING === 'true' }
}
const purchaseInput = z.object({ quantity: z.number().int().min(1).max(100000), interval: z.enum(['monthly', 'annual']) }).strict()

export async function checkout(actor: Principal, workspaceId: string, input: unknown) {
  const value = purchaseInput.parse(input)
  const c = getConfig()
  const price = value.interval === 'monthly' ? c.STRIPE_PRICE_MONTHLY : c.STRIPE_PRICE_ANNUAL
  if (!price || !c.STRIPE_WEBHOOK_SECRET) throw new ServiceError(503, 'billing_not_configured', 'This subscription is not available for purchase yet.')
  return transaction(async db => {
    const workspace = await requireWorkspace(actor, workspaceId, 'billing', db)
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const sub = (await rows('SELECT * FROM subscriptions WHERE workspace_id=$1', [workspaceId], db))[0]
    if (sub?.subscription_id && !['canceled', 'incomplete_expired'].includes(sub.status)) throw new ServiceError(409, 'subscription_exists', 'Manage the existing subscription instead of purchasing another.')
    if (sub?.checkout_id) {
      const pending = await stripe().checkout.sessions.retrieve(sub.checkout_id)
      if (pending.status === 'open' && pending.url) return { url: pending.url }
      if (pending.status === 'complete' && !['canceled', 'incomplete_expired'].includes(sub.status)) throw new ServiceError(409, 'payment_processing', 'Your payment is being confirmed. Refresh the billing page shortly.')
    }
    const customerId = sub?.customer_id ?? (await stripe().customers.create({ name: workspace.name, email: actor.email, metadata: { sipper_workspace_id: workspaceId } }, { idempotencyKey: `sipper-customer:${workspaceId}` })).id
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription', customer: customerId, line_items: [{ price, quantity: value.quantity }],
      client_reference_id: workspaceId, metadata: { sipper_workspace_id: workspaceId },
      subscription_data: { metadata: { sipper_workspace_id: workspaceId } },
      success_url: `${c.SIPPER_BASE_URL}/portal/workspaces/${workspaceId}?checkout=complete`,
      cancel_url: `${c.SIPPER_BASE_URL}/portal/workspaces/${workspaceId}?checkout=cancelled`,
      allow_promotion_codes: true,
    }, { idempotencyKey: `sipper-checkout:${workspaceId}:${sub?.checkout_id ?? 'initial'}` })
    await db.query(`INSERT INTO subscriptions (workspace_id,provider,customer_id,checkout_id) VALUES ($1,'stripe',$2,$3)
      ON CONFLICT (workspace_id) DO UPDATE SET provider='stripe',customer_id=$2,checkout_id=$3`, [workspaceId, customerId, session.id])
    await audit(db, actor, workspaceId, 'billing.checkout_started', workspaceId, undefined, value)
    return { url: session.url }
  })
}
export async function billingPortal(actor: Principal, workspaceId: string) {
  await requireWorkspace(actor, workspaceId, 'billing')
  const sub = (await rows("SELECT customer_id FROM subscriptions WHERE workspace_id=$1 AND provider='stripe'", [workspaceId]))[0]
  if (!sub?.customer_id) throw new ServiceError(409, 'no_billing_account', 'Purchase a subscription before opening billing.')
  const session = await stripe().billingPortal.sessions.create({ customer: sub.customer_id, return_url: `${getConfig().SIPPER_BASE_URL}/portal/workspaces/${workspaceId}` })
  return { url: session.url }
}
export async function changeQuantity(actor: Principal, workspaceId: string, input: unknown) {
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(100000) }).strict().parse(input)
  return transaction(async db => {
    await requireWorkspace(actor, workspaceId, 'billing', db)
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const used = Number((await rows('SELECT count(*) AS count FROM seat_assignments WHERE workspace_id=$1', [workspaceId], db))[0]!.count)
    if (quantity < used) throw new ServiceError(409, 'seats_in_use', `Release ${used - quantity} user licence(s) before reducing the subscription.`)
    const sub = (await rows("SELECT subscription_id FROM subscriptions WHERE workspace_id=$1 AND provider='stripe'", [workspaceId], db))[0]
    if (!sub?.subscription_id) throw new ServiceError(409, 'no_subscription', 'There is no paid subscription to change.')
    const live = await stripe().subscriptions.retrieve(sub.subscription_id)
    const item = live.items.data[0]
    if (live.items.data.length !== 1 || !item) throw new ServiceError(409, 'unsupported_subscription', 'This subscription needs a billing review.')
    const changed = await stripe().subscriptions.update(live.id, { items: [{ id: item.id, quantity }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete' })
    await applySubscription(db, workspaceId, changed)
    await audit(db, actor, workspaceId, 'billing.quantity_requested', workspaceId, undefined, { quantity })
    return { updated: true, paymentPending: Boolean(changed.pending_update) }
  })
}

// Kept separate from transport so replay/order and capacity behaviour can be exercised without live keys.
export async function applySubscription(db: Database, workspaceId: string, subscription: Stripe.Subscription) {
  const c = getConfig()
  const item = subscription.items.data[0]
  const knownPrice = item && [c.STRIPE_PRICE_MONTHLY, c.STRIPE_PRICE_ANNUAL].filter(Boolean).includes(item.price.id)
  if (subscription.items.data.length !== 1 || !knownPrice) throw new ServiceError(409, 'unsupported_subscription', 'Subscription price is not configured for Sipper user licences.')
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const existing = (await rows('SELECT * FROM subscriptions WHERE workspace_id=$1 FOR UPDATE', [workspaceId], db))[0]
  if (!existing || existing.customer_id !== customer || subscription.metadata.sipper_workspace_id !== workspaceId) throw new ServiceError(409, 'billing_scope_mismatch', 'Subscription does not match this workspace.')
  if (existing.subscription_id && existing.subscription_id !== subscription.id && !['canceled', 'incomplete_expired', 'inactive'].includes(existing.status)) {
    await db.query("INSERT INTO audit_events (workspace_id,action,target_id) VALUES ($1,'billing.other_subscription_ignored',$2)", [workspaceId, subscription.id])
    return
  }
  const seats = item.quantity ?? 0
  const used = Number((await rows('SELECT count(*) AS count FROM seat_assignments WHERE workspace_id=$1', [workspaceId], db))[0]!.count)
  const paidUntil = new Date(item.current_period_end * 1000)
  const graceUntil = subscription.status === 'past_due' && c.SIPPER_BILLING_GRACE_DAYS > 0
    ? new Date(item.current_period_start * 1000 + c.SIPPER_BILLING_GRACE_DAYS * 86400000) : null
  await db.query(`UPDATE subscriptions SET subscription_id=$2,status=$3,purchased_seats=$4,paid_until=$5,grace_until=$6,
    over_capacity=$7,cancellation_scheduled=$8,updated_at=now() WHERE workspace_id=$1`,
  [workspaceId, subscription.id, subscription.status, seats, paidUntil, graceUntil, used > seats, subscription.cancel_at_period_end])
}
export async function receiveWebhook(payload: string, signature: string) {
  const secret = getConfig().STRIPE_WEBHOOK_SECRET
  if (!secret) throw new ServiceError(503, 'billing_not_configured', 'Payments are not configured.')
  let event: Stripe.Event
  try { event = stripe().webhooks.constructEvent(payload, signature, secret) }
  catch { throw new ServiceError(400, 'invalid_webhook', 'Invalid webhook signature.') }
  const object = event.data.object as { id: string; object: string; subscription?: string | { id: string } | null }
  const subscriptionId = object.object === 'subscription' ? object.id : typeof object.subscription === 'string' ? object.subscription : object.subscription?.id
  if (!subscriptionId) return { received: true }
  return reconcileSubscriptionEvent(event.id, subscriptionId)
}
export async function reconcileSubscriptionEvent(eventId: string, subscriptionId: string, readSubscription: (id: string) => Promise<Stripe.Subscription> = id => stripe().subscriptions.retrieve(id)) {
  // Fetch once to locate the billing workspace, then again inside its lock. Event arrival order is not state order.
  const initial = await readSubscription(subscriptionId)
  const workspaceId = initial.metadata.sipper_workspace_id
  if (!workspaceId || !z.uuid().safeParse(workspaceId).success) return { received: true }
  await transaction(async db => {
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    await db.query('INSERT INTO billing_events (provider_event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId])
    const processed = (await rows('SELECT processed_at FROM billing_events WHERE provider_event_id=$1 FOR UPDATE', [eventId], db))[0]
    if (processed?.processed_at) return
    await applySubscription(db, workspaceId, await readSubscription(subscriptionId))
    await db.query('UPDATE billing_events SET processed_at=now() WHERE provider_event_id=$1', [eventId])
    await db.query("INSERT INTO audit_events (workspace_id,action,target_id) VALUES ($1,'billing.reconciled',$2)", [workspaceId, eventId])
  })
  return { received: true }
}
export async function configureTestBilling(actor: Principal, workspaceId: string, input: unknown) {
  const c = getConfig()
  if (c.NODE_ENV === 'production' || c.SIPPER_ALLOW_TEST_BILLING !== 'true') throw new ServiceError(404, 'not_found', 'Not found.')
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(1000) }).strict().parse(input)
  return transaction(async db => {
    await requireWorkspace(actor, workspaceId, 'billing', db)
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const existing = (await rows('SELECT provider FROM subscriptions WHERE workspace_id=$1', [workspaceId], db))[0]
    if (existing?.provider === 'stripe') throw new ServiceError(409, 'real_billing_exists', 'Test billing cannot replace a Stripe subscription.')
    const used = Number((await rows('SELECT count(*) AS count FROM seat_assignments WHERE workspace_id=$1', [workspaceId], db))[0]!.count)
    if (quantity < used) throw new ServiceError(409, 'seats_in_use', 'Release assigned licences before reducing test capacity.')
    await db.query(`INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until) VALUES ($1,'test','active',$2,now()+interval '30 days')
      ON CONFLICT (workspace_id) DO UPDATE SET purchased_seats=$2,paid_until=now()+interval '30 days',over_capacity=false`, [workspaceId, quantity])
    await audit(db, actor, workspaceId, 'billing.local_test_enabled', workspaceId, undefined, { quantity })
    return { testOnly: true, purchasedSeats: quantity }
  })
}
