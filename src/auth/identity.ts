import { AuthorizationError } from './model.ts'
import type { AuthenticatedUser, User } from './model.ts'

const principals = new WeakSet<object>()

/** Internal issuer: call only after password/session verification and current-user validation. */
export function issueAuthenticatedUser(user: User): AuthenticatedUser {
  const principal = Object.freeze({ kind: 'user' as const, userId: user.id, username: user.username,
    displayName: user.displayName, credentialVersion: user.credentialVersion })
  principals.add(principal)
  return principal
}
export function assertAuthenticatedUser(value: unknown): asserts value is AuthenticatedUser {
  if (!value || typeof value !== 'object' || !principals.has(value)) throw new AuthorizationError('unauthenticated')
}
