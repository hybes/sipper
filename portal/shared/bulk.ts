import { z } from 'zod'
import { readCsv, CSV_ROW_LIMIT } from './csv'

export const BULK_LIMIT = CSV_ROW_LIMIT
export const bulkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('invite'), entries: z.array(z.unknown()).min(1).max(BULK_LIMIT) }).strict(),
  z.object({ action: z.enum(['suspend', 'resume', 'assign_seat', 'release_seat']), userIds: z.array(z.unknown()).min(1).max(BULK_LIMIT) }).strict(),
  z.object({ action: z.literal('assign_account'), userIds: z.array(z.unknown()).min(1).max(BULK_LIMIT), configurationId: z.uuid().transform(id => id.toLowerCase()) }).strict(),
])
export type BulkInput = z.infer<typeof bulkInput>
export interface BulkResult { results: Array<{ index: number; ok: boolean; code?: string; message: string }> }

// This import format deliberately accepts only email and role, never SIP credentials.
export function readInvitationCsv(source: string): Array<{ email: string; role: string }> {
  const { header, records } = readCsv(source)
  if (!header.includes('email') || new Set(header).size !== header.length || header.some(value => !['email', 'role'].includes(value))) {
    throw new Error('Use an email column and an optional role column (user or admin).')
  }
  return records.map(cells => {
    return { email: cells[header.indexOf('email')]!, role: cells[header.indexOf('role')]?.toLowerCase() || 'user' }
  })
}
