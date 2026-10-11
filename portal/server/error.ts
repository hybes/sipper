import { browserHeaders } from './lib/browser-security'

// Production failures must not trigger Nuxt's unauthenticated internal HTML
// error subrequest after the original edge credentials have been stripped.
// Application APIs already provide their own actionable, sanitised errors.
export default defineNitroErrorHandler((error, event) => {
  const candidate = error.statusCode
  const statusCode = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500
  const messages: Record<number, string> = {
    400: 'Invalid request', 401: 'Sign in required', 403: 'Access denied',
    404: 'Not found', 405: 'Method not allowed', 413: 'Request too large',
    415: 'Unsupported content type', 429: 'Too many requests',
  }
  for (const [name, value] of Object.entries(browserHeaders)) setHeader(event, name, value)
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  setResponseStatus(event, statusCode)
  return send(event, JSON.stringify({ statusCode, message: messages[statusCode] ?? 'Request could not be completed' }), 'application/json; charset=utf-8')
})
