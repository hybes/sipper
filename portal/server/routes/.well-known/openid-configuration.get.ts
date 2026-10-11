import { oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
import { getAuth } from '../../lib/auth'
export default defineEventHandler(event => oauthProviderOpenIdConfigMetadata(getAuth())(toWebRequest(event)))
