import { receiveWebhook } from '../../lib/billing'
import { safeFailure } from '../../lib/http'

export default defineEventHandler(async event => {
  try {
    return await receiveWebhook(await limitedBody(event, 1048576), getHeader(event, 'stripe-signature') ?? '')
  } catch (error) {
    const failure = safeFailure(error)
    setResponseStatus(event, failure.statusCode)
    return failure
  }
})
