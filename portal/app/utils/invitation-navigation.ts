export function isInvitationPath(path: string) {
  return path === '/portal/workspace-invitation' || path === '/portal/invitations/accept'
}

export function invitationAuthPath(path: string, next?: unknown) {
  if (isInvitationPath(path)) return path
  if (path === '/portal/security' && typeof next === 'string' && isInvitationPath(next)) return `${path}?next=${next}`
  return null
}

// References stay out of sign-in callback URLs and only follow known invitation routes.
export function invitationDestination(path: string, hash: string) {
  const supported = isInvitationPath(path) || ['/portal/workspace-invitation', '/portal/invitations/accept'].some(next => path === invitationAuthPath('/portal/security', next))
  return supported && /^#token=[A-Za-z0-9_-]{43}$/.test(hash) ? path + hash : path
}

export function legacyCustomerInvitationHash(path: string, token: unknown) {
  return path === '/portal/invitations/accept' && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? `#token=${token}` : ''
}
