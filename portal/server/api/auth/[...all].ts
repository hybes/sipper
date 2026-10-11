import { getAuth } from '../../lib/auth'

export default defineEventHandler(event => getAuth().handler(toWebRequest(event)))
