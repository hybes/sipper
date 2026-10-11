export type SortDirection = 'ascending' | 'descending'

// Keep missing activity at the end in either direction and preserve equal rows.
export function sortRows<T>(rows: T[], value: (row: T) => string | number | null | undefined, direction: SortDirection): T[] {
  return [...rows].sort((left, right) => {
    const a = value(left), b = value(right)
    const missingA = a == null || (typeof a === 'number' && !Number.isFinite(a))
    const missingB = b == null || (typeof b === 'number' && !Number.isFinite(b))
    if (missingA || missingB) return Number(missingA) - Number(missingB)
    const comparison = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'en-GB', { numeric: true, sensitivity: 'base' })
    return direction === 'ascending' ? comparison : -comparison
  })
}
