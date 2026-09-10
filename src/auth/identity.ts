import { AuthorizationError } from './model.ts'
import type { AuthenticatedUser, User } from './model.ts'

const principals = new WeakSet<object>()

/** Internal issuer: call only after password/session verification and current-user validation. */
export function issueAuthenticatedUser(user: User, session?: { id: string; expiresAt: number }): AuthenticatedUser {
  const principal = Object.freeze({ kind: 'user' as const, userId: user.id, username: user.username,
    displayName: user.displayName, credentialVersion: user.credentialVersion,
    ...(session ? { sessionId: session.id, sessionExpiresAt: session.expiresAt } : {}) })
  principals.add(principal)
  return principal
}
export function assertAuthenticatedUser(value: unknown): asserts value is AuthenticatedUser {
  if (!value || typeof value !== 'object' || !principals.has(value)) throw new AuthorizationError('unauthenticated')
}
