import { setTimeout } from 'node:timers/promises'
import { runOneJob, pruneInvitationEmails } from '../server/lib/jobs'
import { getPool } from '../server/lib/db'
import { trackWorkerProgress } from '../server/lib/worker-progress'
import { pruneMessageHistory } from '../server/lib/messages'

let running = true
process.on('SIGTERM', () => { running = false })
process.on('SIGINT', () => { running = false })
const progress = await trackWorkerProgress('email').catch(() => { console.error('Email worker could not initialise progress'); process.exit(1) })
let nextPrune=0
while (running) {
  try {
    if(Date.now()>=nextPrune) {await pruneMessageHistory();await pruneInvitationEmails();nextPrune=Date.now()+60_000}
    const worked = await runOneJob(); await progress.progressed(); if (!worked) await setTimeout(1000)
  }
  catch { console.error('Background worker could not access its queue'); await setTimeout(5000) }
}
await progress.stop().catch(() => console.error('Worker stop could not be recorded'))
await getPool().end()
