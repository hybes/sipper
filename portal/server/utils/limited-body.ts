import { ServiceError } from '../lib/errors'

export async function limitedBody(event: Parameters<typeof readRawBody>[0], limit = 65536) {
  const chunks: Buffer[] = []
  let size = 0
  // A normal async iterator destroys the socket on early exit, before a 413 can finish.
  for await (const chunk of event.node.req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      setHeader(event, 'Connection', 'close')
      throw new ServiceError(413, 'request_too_large', 'This request is too large.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString()
}
