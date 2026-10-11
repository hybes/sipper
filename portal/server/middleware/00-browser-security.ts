import { authenticEdge, browserHeaders, contentSecurityPolicy, edgeClientIP, portalPermissions } from '../lib/browser-security'
import { getConfig } from '../lib/config'
import { requestIp } from '../lib/activity'

export default defineEventHandler(event => {
  const config = getConfig()
  for (const [name, value] of Object.entries(browserHeaders)) setHeader(event, name, value)
  setHeader(event,'Permissions-Policy',portalPermissions(event.path.split('?')[0]!))
  if (config.NODE_ENV === 'production') {
    setHeader(event, 'Content-Security-Policy', contentSecurityPolicy([],config.SIPPER_MEETING_PUBLIC_URL))
    setHeader(event, 'Strict-Transport-Security', 'max-age=31536000')
  }
  const fromEdge = authenticEdge(getHeader(event, 'x-sipper-edge-secret'), config.SIPPER_EDGE_SHARED_SECRET)
  const health = event.path.split('?')[0] === '/api/health' && ['GET', 'HEAD'].includes(event.method)
  if (config.SIPPER_EDGE_SHARED_SECRET && !fromEdge && !health) {
    setHeader(event, 'Cache-Control', 'no-store')
    throw createError({ statusCode: 403, statusMessage: 'Origin access denied' })
  }
  const clientIP = fromEdge ? edgeClientIP(getHeader(event, 'x-sipper-client-ip'))
    : requestIp(event.node.req.socket.remoteAddress, getHeader(event, 'x-forwarded-for') ?? null, config.SIPPER_TRUSTED_PROXY_IPS)
  // Better Auth and native telemetry share the verified address. No request can
  // provide this internal header directly, even when running without an edge.
  delete event.node.req.headers['x-sipper-verified-ip']
  delete event.node.req.headers['x-sipper-edge-secret']
  delete event.node.req.headers['x-sipper-client-ip']
  if (clientIP) event.node.req.headers['x-sipper-verified-ip'] = clientIP
  event.context.sipperClientIP = clientIP
})
