import { setTimeout } from 'node:timers/promises'
import { meetingsAvailable, reconcileMeetingAccess, runOneMeetingControl } from '../server/lib/meetings'
import { getPool } from '../server/lib/db'
import { trackWorkerProgress } from '../server/lib/worker-progress'

if(!meetingsAvailable())throw new Error('Configure meetings before starting the meeting worker')
let running=true,nextSweep=0
process.on('SIGTERM',()=>{running=false})
process.on('SIGINT',()=>{running=false})
const progress=await trackWorkerProgress('meeting')
while(running) {
  try {
    if(Date.now()>=nextSweep){await reconcileMeetingAccess();nextSweep=Date.now()+5000}
    const worked=await runOneMeetingControl();await progress.progressed()
    if(!worked)await setTimeout(250)
  } catch {console.error('Meeting worker could not process its queue');await setTimeout(1000)}
}
await progress.stop().catch(()=>console.error('Meeting worker stop could not be recorded'))
await getPool().end()
