import { nativePrincipal, clientResource } from '../../lib/native-auth'
import { safeFailure, uuid } from '../../lib/http'
import { enrolDevice, provisionDevice } from '../../lib/platform'
import { clientOrganisations, reportDevice, leaveDevice, ownCallingPreferences, setCallingPreference } from '../../lib/devices'
import { ServiceError } from '../../lib/errors'
import { recordDeviceRequest, recordConfigurationDelivery } from '../../lib/activity'
import { savePushToken, removePushToken, deviceCall } from '../../lib/mobile-calls'
import { redeemSetupLink } from '../../lib/setup-links'
import { deviceDirectory, deviceDirectoryStatus } from '../../lib/directory'
import { messagingRequest } from '../../lib/messages'
import { meetingRequest } from '../../lib/meetings'

export default defineEventHandler(async event => {
  try {
    // Token verification needs method, URL and headers only; avoid consuming the body before validation below.
    const actor = await nativePrincipal(new Request(getRequestURL(event), { method: event.method, headers: new Headers(getRequestHeaders(event) as Record<string, string>) }))
    const parts = (getRouterParam(event, 'path') ?? '').split('/')
    const method = event.method
    const ip = event.context.sipperClientIP as string | null
    let body: unknown
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (!getHeader(event, 'content-type')?.startsWith('application/json')) throw new ServiceError(415, 'json_required', 'Send JSON.')
      try { body = JSON.parse(await limitedBody(event)) } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError(400, 'invalid_json', 'Send valid JSON.') }
    }
    if (parts.join('/') === 'organisations' && method === 'GET') return await clientOrganisations(actor)
    if (parts.join('/') === 'calling-preferences' && method === 'GET') return await ownCallingPreferences(actor)
    if (parts.length === 3 && parts[0] === 'organisations' && parts[2] === 'calling-preference' && method === 'PATCH') return await setCallingPreference(actor, uuid(parts[1]), body)
    if (parts.join('/') === 'setup-links/redeem' && method === 'POST') return await redeemSetupLink(actor, body)
    if (parts.length === 3 && parts[0] === 'organisations' && parts[2] === 'devices' && method === 'POST') {
      const device = await enrolDevice(actor, uuid(parts[1]), body)
      await recordDeviceRequest(actor, device.id, 'enrolment', ip)
      return device
    }
    if (parts[0] === 'devices') {
      const id = uuid(parts[1])
      if(parts.length>=4 && parts[2]==='conferencing') {
        const result=await meetingRequest(actor,{deviceId:id},method,parts.slice(3),body)
        await recordDeviceRequest(actor,id,'meetings',ip)
        return result
      }
      if(parts.length>=4 && parts[2]==='messages') {
        const result=await messagingRequest(actor,{deviceId:id},method,parts.slice(3),body,getQuery(event))
        await recordDeviceRequest(actor,id,'messages',ip)
        return result
      }
      if (parts.length === 4 && parts[2] === 'directory' && parts[3] === 'status' && method === 'POST') {
        const status = await deviceDirectoryStatus(actor,id,body)
        await recordDeviceRequest(actor,id,'directory',ip)
        return status
      }
      if (parts.length === 3 && parts[2] === 'directory' && method === 'GET') {
        const directory = await deviceDirectory(actor,id,getQuery(event))
        await recordDeviceRequest(actor,id,'directory',ip)
        return directory
      }
      if (parts.length === 3 && parts[2] === 'push' && ['PUT', 'DELETE'].includes(method)) {
        await recordDeviceRequest(actor, id, 'push_token', ip)
        return method === 'PUT' ? await savePushToken(actor, id, body) : await removePushToken(actor, id)
      }
      if (parts[2] === 'calls' && (parts.length === 4 || parts.length === 5)) {
        const action = parts.length === 4 && method === 'GET' ? 'status' : method === 'POST' ? parts[4] : null
        if (action === 'status' || action === 'wake' || action === 'answer' || action === 'decline') {
          await recordDeviceRequest(actor, id, 'call', ip)
          return await deviceCall(actor, id, uuid(parts[3]), action)
        }
      }
      if (parts.length === 3 && parts[2] === 'configuration' && method === 'GET') {
        await recordDeviceRequest(actor, id, 'configuration', ip)
        const configuration = await provisionDevice(actor, id)
        await recordConfigurationDelivery(actor, id)
        return configuration
      }
      if (parts.length === 3 && parts[2] === 'report' && method === 'POST') {
        await recordDeviceRequest(actor, id, 'report', ip)
        return await reportDevice(actor, id, body)
      }
      if (parts.length === 2 && method === 'DELETE') {
        await recordDeviceRequest(actor, id, 'sign_out', ip)
        return await leaveDevice(actor, id)
      }
    }
    throw new ServiceError(404, 'not_found', 'Not found.')
  } catch (error) {
    const failure = safeFailure(error)
    setResponseStatus(event, failure.statusCode)
    if (failure.statusCode === 401) setHeader(event, 'WWW-Authenticate', `Bearer resource="${clientResource()}"`)
    return failure
  }
})
