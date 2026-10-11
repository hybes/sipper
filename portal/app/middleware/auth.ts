import { auth } from '~/lib/auth'

export default defineNuxtRouteMiddleware(async to => {
  if (import.meta.server) return
  const legacyHash = legacyCustomerInvitationHash(to.path, to.query.token)
  if (legacyHash) return navigateTo({ path: to.path, hash: legacyHash }, { replace: true })
  const session = await auth.getSession()
  const invitationNext = invitationAuthPath(to.path, to.query.next)
  if (!session.data) return navigateTo(invitationNext
    ? { path: '/portal/sign-in', query: { next: invitationNext }, hash: to.hash }
    : { path: '/portal/sign-in', query: { next: to.fullPath } })
})
