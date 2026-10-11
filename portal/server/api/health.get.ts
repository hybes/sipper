import { getPool } from '../lib/db'

export default defineEventHandler(async event => {
  try { await getPool().query('SELECT 1'); return { status: 'ok' } }
  catch { setResponseStatus(event, 503); return { status: 'unavailable' } }
})
