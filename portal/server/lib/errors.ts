export class ServiceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export function requireValue<T>(value: T | undefined | null, message = 'Not found'): T {
  if (value == null) throw new ServiceError(404, 'not_found', message)
  return value
}
