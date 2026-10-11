import { gatewayPrincipal, gatewayCall, incomingGatewayCall } from '../../lib/mobile-calls'
import { safeFailure, uuid } from '../../lib/http'
import { ServiceError } from '../../lib/errors'
import { admitGatewayTransfer, gatewayTransfer, pendingGatewayTransfers } from '../../lib/gateway-transfers'
import { gatewayHeartbeat, gatewayUpstreams, admitGatewayOutgoing, requireGatewayController, releaseGatewayController, recordGatewayRegistrations, recordUpstreamRegistrations } from '../../lib/gateway'

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    const gateway = gatewayPrincipal(getHeader(event, 'authorization'))
    const parts = (getRouterParam(event, 'path') ?? '').split('/')
    let body: unknown
    if (event.method === 'POST') {
      if (!getHeader(event, 'content-type')?.startsWith('application/json')) throw new ServiceError(415, 'json_required', 'Send JSON.')
      try { body = JSON.parse(await limitedBody(event)) } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError(400, 'invalid_json', 'Send valid JSON.') }
    }
    if (parts.join('/') === 'heartbeat' && event.method === 'POST') return await gatewayHeartbeat(gateway, body)
    const instance = getHeader(event, 'x-sipper-controller')
    await requireGatewayController(gateway, instance)
    if (parts.join('/') === 'release' && event.method === 'POST') return await releaseGatewayController(gateway, instance!)
    if (parts.join('/') === 'upstreams' && event.method === 'GET') return await gatewayUpstreams(gateway)
    if (parts.join('/') === 'registrations' && event.method === 'POST') return await recordGatewayRegistrations(gateway, instance!, body)
    if (parts.join('/') === 'upstream-registrations' && event.method === 'POST') return await recordUpstreamRegistrations(gateway, instance!, body)
    if (parts.join('/') === 'outgoing' && event.method === 'POST') return await admitGatewayOutgoing(gateway, body)
    if (parts.join('/') === 'transfers' && event.method === 'POST') return await admitGatewayTransfer(gateway, instance!, body)
    if (parts.join('/') === 'transfers' && event.method === 'GET') return await pendingGatewayTransfers(gateway, instance!)
    if (parts.length === 2 && parts[0] === 'transfers' && ['GET', 'POST'].includes(event.method)) {
      return await gatewayTransfer(gateway, instance!, uuid(parts[1]), body)
    }
    if (parts.join('/') === 'calls' && event.method === 'POST') return await incomingGatewayCall(gateway, body)
    if (parts.length === 2 && parts[0] === 'calls' && ['GET', 'POST'].includes(event.method)) {
      return await gatewayCall(gateway, uuid(parts[1]), body)
    }
    throw new ServiceError(404, 'not_found', 'Not found.')
  } catch (error) {
    const failure = safeFailure(error)
    setResponseStatus(event, failure.statusCode)
    return failure
  }
})
