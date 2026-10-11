import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestIp } from '../server/lib/activity'
import { registrationState, REGISTRATION_FRESHNESS_MS } from '../shared/registration-status'
import { sortRows } from '../shared/table-sort'
import { activityDate, activityAge } from '../app/utils/labels'
import { uuid } from '../server/lib/http'

test('native UUID paths are canonical before account and call-winner comparisons', () => {
  assert.equal(uuid('ABCD1234-1234-4234-8234-ABCDEF123456'), 'abcd1234-1234-4234-8234-abcdef123456')
  assert.throws(() => uuid('not-a-device'))
})

test('activity timestamps show a full date and safely handle missing records', () => {
  const date = new Date(2026, 8, 22, 14, 35)
  assert.equal(activityDate(date.toISOString()), '22 Sept 2026, 14:35')
  for (const value of [undefined, null, '', 'invalid']) assert.equal(activityDate(value), 'Not recorded')
})

test('activity ages stay relative alongside the full timestamp', () => {
  const now = Date.parse('2026-09-26T12:00:00Z')
  const ago = (minutes: number) => activityAge(new Date(now - minutes * 60_000).toISOString(), now)
  assert.equal(ago(-1), 'Just now')
  assert.equal(ago(0), 'Just now')
  assert.equal(ago(59), '59 min ago')
  assert.equal(ago(60), '1h ago')
  assert.equal(ago(1439), '23h ago')
  assert.equal(ago(1440), '1 day ago')
  assert.equal(ago(5760), '4 days ago')
  for (const value of [undefined, null, '', 'invalid']) assert.equal(activityAge(value, now), 'Not recorded')
})

test('management tables sort real values, keep missing activity last and do not mutate source rows', () => {
  const rows = [{ name: 'Device 10', at: 10 }, { name: 'device 2', at: 20 }, { name: 'Missing', at: null }, { name: 'Invalid', at: NaN }, { name: 'Also recent', at: 20 }]
  assert.deepEqual(sortRows(rows, row => row.at, 'descending').map(row => row.name), ['device 2', 'Also recent', 'Device 10', 'Missing', 'Invalid'])
  assert.deepEqual(sortRows(rows, row => row.at, 'ascending').map(row => row.name), ['Device 10', 'device 2', 'Also recent', 'Missing', 'Invalid'])
  assert.deepEqual(sortRows(rows.slice(0, 2), row => row.name, 'ascending').map(row => row.name), ['device 2', 'Device 10'])
  assert.equal(rows[0]!.name, 'Device 10')
})

test('IP attribution ignores untrusted forwarding headers and walks trusted proxies from the socket', () => {
  assert.equal(requestIp('::ffff:192.0.2.10', '198.51.100.90', ''), '192.0.2.10')
  assert.equal(requestIp('192.0.2.10', '198.51.100.90', '127.0.0.1'), '192.0.2.10')
  assert.equal(requestIp('127.0.0.1', '198.51.100.90, 192.0.2.10', '127.0.0.1'), '192.0.2.10')
  assert.equal(requestIp('::1', '198.51.100.90, 192.0.2.10', '::1,192.0.2.10'), '198.51.100.90')
  assert.equal(requestIp('127.0.0.1', 'not-an-ip', '127.0.0.1'), null)
  assert.equal(requestIp(undefined, '198.51.100.90', '127.0.0.1'), null)
})

test('registration badges never imply an old or revoked report is currently registered', () => {
  const now = Date.now(), fresh = { state: 'registered', observedAt: new Date(now).toISOString() }
  assert.equal(registrationState(fresh, null, now).label, 'Registered')
  assert.equal(registrationState(fresh, null, now + REGISTRATION_FRESHNESS_MS + 1).label, 'Stale')
  assert.equal(registrationState(fresh, new Date(now).toISOString(), now).label, 'Revoked')
  assert.equal(registrationState(undefined, null, now).label, 'Not reported')
  assert.equal(registrationState({ state: 'registered', observedAt: 'invalid' }, null, now).label, 'Stale')
  assert.equal(registrationState({ ...fresh, state: 'failed' }, null, now).label, 'Failed')
  const gateway = { ...fresh, source: 'gateway', ready: true, readyUntil: new Date(now + 60_000).toISOString() }
  assert.equal(registrationState(gateway, null, now).label, 'Registered')
  assert.equal(registrationState(gateway, null, now + 45_001).label, 'Stale')
  assert.equal(registrationState({ ...gateway, readyUntil: null }, null, now).label, 'Stale')
  assert.equal(registrationState({ ...gateway, readyUntil: new Date(now - 1).toISOString() }, null, now).label, 'Stale')
  assert.equal(registrationState({ ...gateway, ready: false }, null, now - 1000).label, 'Stale', 'Server withdrawal overrides a slightly behind UI clock')
})


test('direct call summaries distinguish fresh counts, stale and withdrawn observations', async () => {
  const { directCallSummary } = await import('../shared/service-status')
  const now = Date.now(), counts = { accountId: 'account', ringing: 1, dialling: 0, connected: 0, held: 0 }
  const report = { accounts: [counts], source: 'device', observedAt: new Date(now).toISOString() }
  assert.equal(directCallSummary([], now).label, 'Not reported')
  assert.equal(directCallSummary([report], now).label, 'Ringing')
  assert.equal(directCallSummary([report], now + 180_001).label, 'Unconfirmed')
  assert.equal(directCallSummary([{ ...report, withdrawn: true }], now).count, 0)
  assert.equal(directCallSummary([{ ...report, confirmed: false }], now).label, 'Unconfirmed')
  assert.equal(directCallSummary([{ ...report, observedAt: 'invalid' }], now).label, 'Unconfirmed')
  assert.equal(directCallSummary([{ ...report, observedAt: new Date(now + 60_001).toISOString() }], now).label, 'Unconfirmed')
  const state = (values: Partial<typeof counts>) => ({ ...report, accounts: [{ ...counts, ringing: 0, ...values }] })
  assert.equal(directCallSummary([state({})], now).label, 'No active calls reported')
  assert.equal(directCallSummary([state({ dialling: 1 })], now).label, 'Dialling')
  assert.equal(directCallSummary([state({ held: 1 })], now).label, 'On hold')
  const mixed = directCallSummary([state({ held: 1, connected: 1 }), { ...report, withdrawn: true }], now)
  assert.equal(mixed.label, 'In a call'); assert.equal(mixed.count, 2); assert.equal(mixed.stale, true)
})
