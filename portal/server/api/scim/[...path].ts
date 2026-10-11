import { authenticateScim,scimRequest } from '../../lib/scim'
import { ScimError,scimFailure } from '../../lib/scim-protocol'
import { ServiceError } from '../../lib/errors'

export default defineEventHandler(async event=>{
  setHeader(event,'Content-Type','application/scim+json; charset=utf-8')
  setHeader(event,'Cache-Control','no-store')
  try {
    const [version,organisationId,...path]=(getRouterParam(event,'path')??'').split('/')
    if(version!=='v2' || !organisationId) throw new ScimError(404,undefined,'Resource not found.')
    // Browser sessions and native app tokens cannot authorise SCIM operations.
    const connection=await authenticateScim(organisationId,getHeader(event,'authorization'))
    let body:unknown
    if(['POST','PUT','PATCH'].includes(event.method)) {
      if(!['application/scim+json','application/json'].includes(getHeader(event,'content-type')?.split(';')[0]?.trim().toLowerCase()??'')) throw new ScimError(415,undefined,'Send SCIM JSON.')
      try {body=JSON.parse(await limitedBody(event,1024*1024))}
      catch(error) {
        if(error instanceof ServiceError) throw new ScimError(error.status,undefined,error.message)
        throw new ScimError(400,'invalidSyntax','Send valid JSON.')
      }
    }
    const reply=await scimRequest(connection,event.method,path,getQuery(event),body,getHeader(event,'if-match'))
    setResponseStatus(event,reply.status)
    if(reply.etag)setHeader(event,'ETag',reply.etag)
    if(reply.location)setHeader(event,'Location',reply.location)
    return reply.status===204?sendNoContent(event):reply.body
  } catch(error) {
    const failure=scimFailure(error)
    setResponseStatus(event,failure.status)
    if(failure.status===401)setHeader(event,'WWW-Authenticate','Bearer realm="Sipper provisioning"')
    if(failure.status===429)setHeader(event,'Retry-After',60)
    return failure.body
  }
})
