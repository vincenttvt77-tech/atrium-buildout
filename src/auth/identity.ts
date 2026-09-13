import { AuthorizationError } from './model.ts'
import type { AuthenticatedUser, SessionAudience, User } from './model.ts'

const principals = new WeakSet<object>()

/** Internal issuer: call only after password/session verification and current-user validation. */
export function issueAuthenticatedUser(user: User, session?: { id: string; expiresAt: number }, audience: SessionAudience = 'staff'): AuthenticatedUser {
  if (audience !== 'staff' && audience !== 'resident') throw new AuthorizationError('unauthenticated')
  const principal = Object.freeze({ kind: 'user' as const, audience, userId: user.id, username: user.username,
    displayName: user.displayName, credentialVersion: user.credentialVersion,
    ...(session ? { sessionId: session.id, sessionExpiresAt: session.expiresAt } : {}) })
  principals.add(principal)
  return principal
}
export function assertAuthenticatedUser(value: unknown): asserts value is AuthenticatedUser {
  if (!value || typeof value !== 'object' || !principals.has(value)) throw new AuthorizationError('unauthenticated')
}
/** A resident session never acquires staff authority from the person's memberships. */
export function assertStaffUser(value: unknown): asserts value is AuthenticatedUser {
  assertAuthenticatedUser(value)
  if (value.audience !== 'staff') throw new AuthorizationError('forbidden')
}
