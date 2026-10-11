import { setTimeout } from 'node:timers/promises'
import { runOnePushJob } from '../server/lib/push-jobs'
import { cleanUpCalls } from '../server/lib/mobile-calls'
import { closePushConnections } from '../server/lib/push-providers'
import { getPool } from '../server/lib/db'
import { trackWorkerProgress } from '../server/lib/worker-progress'

let running = true, lastCleanup = 0
process.on('SIGTERM', () => { running = false })
process.on('SIGINT', () => { running = false })
const progress = await trackWorkerProgress('push').catch(() => { console.error('Push worker could not initialise progress'); process.exit(1) })
// Run independently of SMTP: a slow mail server must not delay an incoming call.
while (running) {
  try {
    if (Date.now() - lastCleanup > 60_000) { await cleanUpCalls(); lastCleanup = Date.now() }
    const worked = await runOnePushJob()
    await progress.progressed()
    if (!worked) await setTimeout(100)
  } catch { console.error('Push worker could not process its queue'); await setTimeout(1000) }
}
closePushConnections()
await progress.stop().catch(() => console.error('Worker stop could not be recorded'))
await getPool().end()
