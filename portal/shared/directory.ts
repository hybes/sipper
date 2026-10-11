import { z } from 'zod'
import { readCsv } from './csv'

const text = z.string().trim().max(160).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value), 'Control characters are not allowed')
const number = z.string().trim().max(128).regex(/^[+0-9*#(). -]+$/, 'Enter a telephone number or extension')
  .transform(value => value.replace(/[(). -]/g, '')).pipe(z.string().regex(/^\+?[0-9*#]{1,64}$/, 'Enter a telephone number or extension'))
export const directoryContactInput = z.object({
  name: text.pipe(z.string().min(1)), company: text.default(''),
  memberUserId: z.string().min(1).max(128).nullable().optional(),
  numbers: z.array(z.object({ label: text.pipe(z.string().min(1).max(32)), number }).strict()).min(1).max(5)
    .refine(values => new Set(values.map(value => value.number)).size === values.length, 'Use each number once'),
}).strict()
export type DirectoryContactInput = z.infer<typeof directoryContactInput>
export interface DirectoryContact extends DirectoryContactInput { id: string; revision: number; updatedAt: string }
export interface DirectoryPage {
  organisation: { id: string; name: string }
  revision: string
  contacts: DirectoryContact[]
  nextCursor: string | null
}
export interface ManagedDirectoryPage extends DirectoryPage { deviceId: string; expiresAt: string }

export interface DirectoryStatus {
  deviceId: string; organisationId: string; revision: string; expiresAt: string
  contacts: Array<{ contactId: string; availability: 'unset' | 'available' | 'away' | 'busy' | null; doNotDisturb: boolean | null; activity: DirectoryActivity | null }>
}
export interface DirectoryActivity {
  state: 'in_call' | 'on_hold' | 'ringing' | 'dialling'
  source: 'device' | 'gateway'
  observedAt: string
}

export interface DirectoryImportResult {
  results: Array<{ index: number; status: 'imported' | 'skipped' | 'invalid'; message: string }>
}

export function readDirectoryCsv(source: string): DirectoryContactInput[] {
  const { header, records } = readCsv(source)
  const columns = ['name', 'company', 'number', 'label', ...[2,3,4,5].flatMap(index => [`number${index}`, `label${index}`])]
  if (!header.includes('name') || !header.includes('number') || header.some(value => !columns.includes(value))) {
    throw new Error('Use name and number columns. Optional columns: company, label, number2/label2 through number5/label5.')
  }
  return records.map(cells => {
    const value = (column: string) => cells[header.indexOf(column)] ?? ''
    return { name: value('name'), company: value('company'), numbers: [1,2,3,4,5].flatMap(index => {
      const suffix = index === 1 ? '' : String(index), number = value(`number${suffix}`), label = value(`label${suffix}`)
      return index === 1 || number || label ? [{ number, label: label || 'Work' }] : []
    }) }
  })
}

// Numbers have already been normalised by directoryContactInput.
export function directoryContactKey(contact: DirectoryContactInput) {
  return JSON.stringify([contact.name, contact.company, contact.numbers.map(value => [value.number,value.label]).sort()])
}
