import { authenticEdge, browserHeaders, contentSecurityPolicy, portalPermissions } from '../lib/browser-security'
import { getConfig } from '../lib/config'

export default defineNitroPlugin(nitro => {
  nitro.hooks.hook('request', event => {
    const secret = getConfig().SIPPER_EDGE_SHARED_SECRET
    const health = event.path.split('?')[0] === '/api/health' && ['GET', 'HEAD'].includes(event.method)
    if (!secret || health || authenticEdge(getHeader(event, 'x-sipper-edge-secret'), secret)) return
    // Nitro serves public assets before user middleware and catches exceptions
    // thrown by this observation hook. Explicitly end the response here; throwing
    // would only log the failure and then serve the requested asset/page.
    for (const [name, value] of Object.entries(browserHeaders)) setHeader(event, name, value)
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    setResponseStatus(event, 403)
    return send(event, 'Origin access denied', 'text/plain; charset=utf-8')
  })
  nitro.hooks.hook('render:html', (html, { event }) => {
    if (getConfig().NODE_ENV !== 'production') return
    setHeader(event,'Permissions-Policy',portalPermissions(event.path.split('?')[0]!))
    setHeader(event, 'Content-Security-Policy', contentSecurityPolicy([...html.head, ...html.bodyAppend],getConfig().SIPPER_MEETING_PUBLIC_URL))
  })
})
