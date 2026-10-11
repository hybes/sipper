import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { getConfig } from '../server/lib/config'
import type { Principal } from '../server/lib/access'
import * as platform from '../server/lib/platform'

export async function gatewayFixture() {
  assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
  const nodeId = getConfig().SIPPER_GATEWAY_ID
  assert.equal((await rows('SELECT id FROM gateway_nodes WHERE id=$1', [nodeId])).length, 0, 'Fixture must not replace an existing gateway')
  const id = randomUUID(), email = `${id}@example.invalid`
  const actor: Principal = { userId: id, email, verified: true, mfa: true }
  await rows('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now()) RETURNING id', [id, 'Gateway fixture', email])
  const workspace = (await platform.createWorkspace(actor, { name: 'Isolated gateway test', kind: 'business' })).id
  const organisation = (await platform.createOrganisation(actor, workspace, { name: 'Fictional customer' })).id
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [workspace, organisation, id])
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until) VALUES ($1,'test','active',1,now()+interval '1 day')", [workspace])
  await platform.assignSeat(actor, workspace, id)
  const configuration = await platform.createConfiguration(actor, organisation, { label: 'Fictional upstream', mode: 'gateway', password: 'never-send-upstream-secret-to-device', settings: { username: '1001', authUsername: 'upstream-auth', domain: 'pbx.example.invalid', server: 'sip.example.invalid' } })
  await platform.assignConfiguration(actor, organisation, configuration.id, id)
  const devices = await Promise.all(['ios', 'android'].map(devicePlatform => platform.enrolDevice(actor, organisation, {
    installationId: randomUUID(), name: 'Gateway fixture phone', platform: devicePlatform, appVersion: 'test', osVersion: 'test',
  })))
  await getPool().query("INSERT INTO gateway_nodes (id,host,port,ready_until) VALUES ($1,'localhost',5061,now()+interval '10 minutes')", [nodeId])
  return { actor, workspace, organisation, configuration, devices, nodeId,
    cleanup: async () => {
      await getPool().query('DELETE FROM workspaces WHERE id=$1', [workspace])
      await getPool().query('DELETE FROM auth_user WHERE id=$1', [id])
      await getPool().query('DELETE FROM gateway_nodes WHERE id=$1', [nodeId])
    },
  }
}
