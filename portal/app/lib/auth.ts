import { createAuthClient } from 'better-auth/vue'
import { twoFactorClient } from 'better-auth/client/plugins'

import { oauthProviderClient } from '@better-auth/oauth-provider/client'

export const auth = createAuthClient({ plugins: [twoFactorClient(), oauthProviderClient()] })
