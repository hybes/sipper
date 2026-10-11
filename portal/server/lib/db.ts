import pg from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import { getConfig } from './config'

let pool: pg.Pool | undefined
export function getPool() {
  return pool ??= new pg.Pool({ connectionString: getConfig().DATABASE_URL, max: 12, connectionTimeoutMillis: 5000 })
}
export type Database = Pick<PoolClient, 'query'>
export async function rows<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = [], db: Database = getPool()): Promise<T[]> {
  return (await db.query<T>(sql, values)).rows
}
export async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect()
  try {
    await db.query('BEGIN')
    const result = await fn(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}
