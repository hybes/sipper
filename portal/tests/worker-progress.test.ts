import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getPool, rows } from '../server/lib/db'
import { trackWorkerProgress, workerProgressFile } from '../server/lib/worker-progress'
import { workerStatus, workerStaleAfter } from '../shared/worker-status'

after(() => getPool().end())
test('worker progress requires completed polls, expires, remains instance-specific and stops cleanly', async t => {
  const directory = await mkdtemp(join(tmpdir(),'sipper-worker-test-'))
  const worker = await trackWorkerProgress('push',directory)
  t.after(async () => { await getPool().query('DELETE FROM worker_progress WHERE id=$1',[worker.id]); await rm(directory,{recursive:true,force:true}) })
  const file = workerProgressFile('push',directory)
  const state = async () => (await rows('SELECT * FROM worker_progress WHERE id=$1',[worker.id]))[0]!
  const health = () => spawnSync(process.execPath,['--import','tsx','scripts/worker-health.ts','push'],{env:{...process.env,TMPDIR:directory},encoding:'utf8'}).status
  assert.equal(workerStatus(await state() as any).label,'Starting')
  assert.equal(health(),1)
  // A process can resume after a newer worker pruned its old database record.
  await getPool().query('DELETE FROM worker_progress WHERE id=$1',[worker.id])
  await worker.progressed()
  assert.equal(health(),0)
  const value=JSON.parse(await readFile(file,'utf8')), initial=await state()
  assert.equal(value.id,worker.id)
  assert.equal(workerStatus(initial as any).label,'Polling')
  await worker.progressed()
  assert.equal((await state()).progressed_at.getTime(),initial.progressed_at.getTime(),'busy polling must not write a heartbeat per job')
  for (const kind of ['email','push','meeting'] as const) {
    assert.equal(workerStatus({...initial,kind} as any,initial.progressed_at.getTime()+workerStaleAfter[kind]-1).label,'Polling')
    assert.equal(workerStatus({...initial,kind} as any,initial.progressed_at.getTime()+workerStaleAfter[kind]).label,'Stale')
  }
  for (const progressedAt of [Date.now()-45_000,Date.now()+60_000,'not-a-timestamp',null]) {
    await writeFile(file,JSON.stringify({...value,progressedAt}))
    assert.equal(health(),1)
  }
  await writeFile(file,'incomplete')
  assert.equal(health(),1)
  await worker.stop()
  assert.equal(workerStatus(await state() as any).label,'Stopped')
  await worker.progressed()
  assert.equal(health(),1,'stopped processes cannot renew their health')
  assert.equal(workerStatus({kind:'push',started_at:null,progressed_at:null,stopped_at:null}).label,'Not reported')
  assert.equal(workerStatus({kind:'push',started_at:new Date(Date.now()-45_000),progressed_at:null,stopped_at:null}).label,'Stale')
  for (const [script,label] of [['worker.ts','Email'],['push-worker.ts','Push']]) {
    const failed=spawnSync(process.execPath,['--import','tsx',`scripts/${script}`],{
      env:{...process.env,TMPDIR:directory,DATABASE_URL:'postgresql://private-user:private-password@127.0.0.1:1/unavailable_test'},encoding:'utf8',timeout:10000,
    })
    assert.equal(failed.status,1)
    assert.equal(failed.stderr.trim(),`${label} worker could not initialise progress`)
  }
})
