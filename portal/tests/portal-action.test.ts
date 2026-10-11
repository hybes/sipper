import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { usePortal } from '../app/composables/usePortal'

test('portal actions always expose a readable error and clear their busy state', async () => {
  const runtime = globalThis as typeof globalThis & { ref?: typeof ref, useToast?: () => { add: (value: { title: string }) => void } }
  const previousRef = runtime.ref, previousToast = runtime.useToast
  const titles: string[] = []
  runtime.ref = ref; runtime.useToast = () => ({ add: value => { titles.push(value.title) } })
  try {
    const portal = usePortal()
    for (const cause of [new Error(''), { data: { message: '   ' }, message: null }, { data: { message: {} }, message: 0 }]) {
      assert.equal(await portal.action(async () => { throw cause }), undefined)
      assert.equal(portal.error.value, 'This request could not be completed.')
      assert.equal(titles.at(-1), portal.error.value); assert.equal(portal.busy.value, false)
    }
    await portal.action(async () => { throw { data: { message: ' Check your sign-in details. ' }, message: 'fallback' } })
    assert.equal(portal.error.value, 'Check your sign-in details.')
    for (const response of [undefined, { status: 502 }]) {
      const cause = Object.assign(new Error('[POST] "/api/platform/private-customer?token=do-not-display": request failed'), { name: 'FetchError', response })
      assert.equal(await portal.action(async () => { throw cause }), undefined)
      assert.equal(portal.error.value, response ? 'This request could not be completed.' : 'Could not connect to Sipper. Check your connection and try again.')
      assert.equal(titles.at(-1), portal.error.value); assert.equal(portal.busy.value, false)
    }
    await portal.action(async () => { throw { name: 'FetchError', response: { status: 403 }, data: { message: ' Verify your email address. ' }, message: 'private request details' } })
    assert.equal(portal.error.value, 'Verify your email address.')
    await portal.action(async () => { throw new Error('Start sign-in again in the app.') })
    assert.equal(portal.error.value, 'Start sign-in again in the app.')
    assert.equal(await portal.action(async () => 42), 42)
    assert.equal(portal.error.value, ''); assert.equal(portal.busy.value, false)
  } finally { runtime.ref = previousRef; runtime.useToast = previousToast }
})
