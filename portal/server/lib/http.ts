import { ZodError, z } from 'zod'
import type { Principal } from './access'
import { ServiceError } from './errors'
import { getAuth } from './auth'
import { getConfig } from './config'
import { claimProvisionedMemberships } from './scim-members'

export async function sessionPrincipal(headers: Headers): Promise<Principal> {
  const session = await getAuth().api.getSession({ headers })
  if (!session) throw new ServiceError(401, 'sign_in_required', 'Sign in to continue.')
  const actor = { userId: session.user.id, email: session.user.email, verified: session.user.emailVerified, mfa: Boolean(session.user.twoFactorEnabled), sessionCreatedAt: session.session.createdAt, sessionId: session.session.id }
  await claimProvisionedMemberships(actor)
  return actor
}
export function uuid(value: string | undefined) { return z.uuid().parse(value).toLowerCase() }
// Catch-all route parameters remain encoded. Decode each person segment once,
// after splitting the route, so an encoded slash cannot become another route.
export function userId(value: string | undefined) {
  try { return z.string().min(1).max(128).parse(value === undefined ? value : decodeURIComponent(value)) }
  catch(error) { if(error instanceof URIError) throw new ServiceError(400,'invalid_input','Choose a valid person.'); throw error }
}
export function safeFailure(error: unknown) {
  if (error instanceof ServiceError) return { statusCode: error.status, code: error.code, message: error.message }
  if (error instanceof ZodError) return { statusCode: 400, code: 'invalid_input', message: 'Check the highlighted fields and try again.', fields: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }
  // SQL and provider exceptions can contain secrets and customer data.
  return { statusCode: 500, code: 'request_failed', message: 'This request could not be completed. Please try again.' }
}
export function checkOrigin(headers: Headers) {
  if (headers.get('origin') !== new URL(getConfig().SIPPER_BASE_URL).origin) throw new ServiceError(403, 'invalid_origin', 'This request must come from the Sipper portal.')
}
