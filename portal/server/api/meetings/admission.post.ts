import { admitMeetingConnection, requireMeetingAdmissionKey } from '../../lib/meetings'
import { safeFailure } from '../../lib/http'
import { ServiceError } from '../../lib/errors'

export default defineEventHandler(async event=>{
  try {
    requireMeetingAdmissionKey(getHeader(event,'authorization'))
    if(!getHeader(event,'content-type')?.startsWith('application/json'))throw new ServiceError(415,'json_required','Send JSON.')
    let input:unknown
    try {input=JSON.parse(await limitedBody(event))} catch(error) {if(error instanceof ServiceError)throw error;throw new ServiceError(400,'invalid_json','Send valid JSON.')}
    return await admitMeetingConnection(input)
  } catch(error) {const failure=safeFailure(error);setResponseStatus(event,failure.statusCode);return failure}
})
