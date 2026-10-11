import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bulkInput, readInvitationCsv } from '../shared/bulk'

test('invitation CSV handles spreadsheet exports while rejecting ambiguous or oversized input', () => {
  assert.deepEqual(readInvitationCsv('\uFEFFrole,email\r\nuser,"alice@example.invalid"\r\nADMIN,bob@example.invalid\r\n'), [
    { email: 'alice@example.invalid', role: 'user' }, { email: 'bob@example.invalid', role: 'admin' },
  ])
  assert.deepEqual(readInvitationCsv('email\n"a""b@example.invalid"'), [{ email: 'a"b@example.invalid', role: 'user' }])
  assert.deepEqual(readInvitationCsv('email,role\n"bad, address",user\n"new\nline",user'), [
    { email: 'bad, address', role: 'user' }, { email: 'new\nline', role: 'user' },
  ])
  for (const text of ['email,email\na,b', 'email,password\na,b', 'email\n', 'email\n"open', 'email\n"closed"extra', 'email\na,b']) assert.throws(() => readInvitationCsv(text))
  assert.equal(readInvitationCsv('email\n' + Array(100).fill('person@example.invalid').join('\n')).length, 100)
  assert.throws(() => readInvitationCsv('email\n' + Array(101).fill('person@example.invalid').join('\n')))
  assert.throws(() => readInvitationCsv('email\n' + 'a'.repeat(65_536)))
  assert.throws(() => bulkInput.parse({ action: 'suspend', userIds: [] }))
  assert.throws(() => bulkInput.parse({ action: 'suspend', userIds: Array(101).fill('id') }))
  assert.throws(() => bulkInput.parse({ action: 'assign_account', userIds: ['id'] }))
})
