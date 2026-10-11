import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { getPool, rows, transaction } from '../server/lib/db'
import { applySubscription, receiveWebhook, reconcileSubscriptionEvent, configureTestBilling } from '../server/lib/billing'
import { createWorkspace } from '../server/lib/platform'
import type { Principal } from '../server/lib/access'

// These are intentionally fake provider values. No test contacts Stripe.
process.env.STRIPE_SECRET_KEY = 'sk_test_local_fixture_only'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_fixture_only'
process.env.STRIPE_PRICE_MONTHLY = 'price_local_users'
const actor: Principal = { userId: randomUUID(), email: 'billing-fixture@example.invalid', verified: true, mfa: true }
let workspace: string
const customer = `cus_${randomUUID()}`, subscriptionId = `sub_${randomUUID()}`
const eventIds: string[] = []
function snapshot(status = 'active', quantity = 3): Stripe.Subscription {
  return { id: subscriptionId, customer, status, metadata: { sipper_workspace_id: workspace }, cancel_at_period_end: false,
    items: { data: [{ id: 'si_fixture', price: { id: 'price_local_users' }, quantity, current_period_start: Math.floor(Date.now()/1000), current_period_end: Math.floor(Date.now()/1000)+86400 }] } } as Stripe.Subscription
}
before(async () => {
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())', [actor.userId, 'Billing fixture', actor.email])
  workspace = (await createWorkspace(actor, { name: 'Billing fixture', kind: 'business' })).id
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,customer_id) VALUES ($1,'stripe',$2)", [workspace, customer])
})
after(async () => {
  await getPool().query('DELETE FROM workspaces WHERE id=$1', [workspace])
  await getPool().query('DELETE FROM auth_user WHERE id=$1', [actor.userId])
  await getPool().query('DELETE FROM billing_events WHERE provider_event_id=ANY($1::text[])', [eventIds])
  await getPool().end()
})
test('webhooks reject altered signatures before processing any event', async () => {
  const provider = new Stripe('sk_test_local_fixture_only')
  const payload = JSON.stringify({ id: 'evt_ignored_fixture', type: 'customer.created', data: { object: { id: customer, object: 'customer' } } })
  const signature = provider.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! })
  assert.deepEqual(await receiveWebhook(payload, signature), { received: true })
  await assert.rejects(receiveWebhook(`${payload} `, signature), (e: any) => e.code === 'invalid_webhook')
})
test('authoritative subscription state wins over out-of-order events, and event retries are idempotent', async () => {
  const first = `evt_${randomUUID()}`, old = `evt_${randomUUID()}`; eventIds.push(first, old)
  let current = snapshot('active')
  await reconcileSubscriptionEvent(first, subscriptionId, async () => current)
  assert.equal((await rows('SELECT purchased_seats FROM subscriptions WHERE workspace_id=$1', [workspace]))[0]!.purchased_seats, 3)
  current = snapshot('canceled')
  await reconcileSubscriptionEvent(old, subscriptionId, async () => current)
  await reconcileSubscriptionEvent(first, subscriptionId, async () => current)
  assert.equal((await rows('SELECT status FROM subscriptions WHERE workspace_id=$1', [workspace]))[0]!.status, 'canceled')
  assert.equal((await rows("SELECT * FROM audit_events WHERE workspace_id=$1 AND action='billing.reconciled'", [workspace])).length, 2)
})
test('unknown prices and a different billing customer never grant licences', async () => {
  const wrongPrice = snapshot(); wrongPrice.items.data[0]!.price.id = 'price_other_product'
  await assert.rejects(transaction(db => applySubscription(db, workspace, wrongPrice)), (e: any) => e.code === 'unsupported_subscription')
  await assert.rejects(transaction(db => applySubscription(db, workspace, { ...snapshot(), customer: 'cus_other' })), (e: any) => e.code === 'billing_scope_mismatch')
  await assert.rejects(configureTestBilling(actor, workspace, { quantity: 100 }), (e: any) => e.code === 'real_billing_exists')
})
