import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { getAuth } from '../../lib/auth'
export default defineEventHandler(event => oauthProviderAuthServerMetadata(getAuth())(toWebRequest(event)))
