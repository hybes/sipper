export const CSV_ROW_LIMIT = 100
export const CSV_SIZE_LIMIT = 65_536

export function readCsv(source: string) {
  if (new TextEncoder().encode(source).length > CSV_SIZE_LIMIT) throw new Error('Use a CSV file smaller than 64 KB.')
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const records: string[][] = []
  let record: string[] = [], field = '', quoted = false, closed = false
  function cell() { record.push(field.trim()); field = ''; closed = false }
  function row() {
    cell()
    if (record.some(value => value)) records.push(record)
    record = []
    if (records.length > CSV_ROW_LIMIT + 1) throw new Error(`Import up to ${CSV_ROW_LIMIT} rows at a time.`)
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') { quoted = false; closed = true }
      else field += char
    } else if (char === ',') cell()
    else if (char === '\n') row()
    else if (char === '"' && !field && !closed) quoted = true
    else if (char === '"' || (closed && char.trim())) throw new Error('Check the quotation marks in your CSV file.')
    else if (!closed) field += char
  }
  if (quoted) throw new Error('Close the quotation marks in your CSV file.')
  row()
  const header = records.shift()?.map(value => value.toLowerCase()) ?? []
  if (!header.length || header.some(value => !value) || new Set(header).size !== header.length) throw new Error('Use each column heading once.')
  if (!records.length) throw new Error('Add at least one row below the column headings.')
  for (const [index, cells] of records.entries()) {
    if (cells.length !== header.length) throw new Error(`Row ${index + 2} has a different number of columns from the heading.`)
  }
  return { header, records }
}
