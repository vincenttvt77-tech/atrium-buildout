import { randomUUID } from 'node:crypto'
import { assertAuthenticatedUser, issueAuthenticatedUser } from './identity.ts'
import type { AuthenticatedUser, UserSessionClaims, UserSessionRecord } from './model.ts'
import { USER_SESSION_TTL_MS, validSessionId } from './session.ts'
import { validId, validVersion } from './validation.ts'

export class SessionManagementError extends Error {
  readonly code: 'unauthenticated' | 'invalid_session' | 'session_unavailable'
  readonly status: number
  constructor(code: SessionManagementError['code']) {
    super(code === 'unauthenticated' ? 'Your sign-in is no longer current. Sign in again.'
      : code === 'invalid_session' ? 'Choose a session from the current account security page.'
        : 'The session change could not be confirmed. Reload account security before trying again.')
    this.name = 'SessionManagementError'; this.code = code
    this.status = code === 'unauthenticated' ? 401 : code === 'invalid_session' ? 400 : 503
  }
}
export interface UserSessionRepository {
  start(principal: AuthenticatedUser, input: { id: string; label: string }): Promise<UserSessionRecord>
  resolve(claims: UserSessionClaims): Promise<UserSessionRecord | null>
  list(principal: AuthenticatedUser): Promise<UserSessionRecord[]>
  revoke(principal: AuthenticatedUser, targetSessionId: string | 'others'): Promise<{ revokedIds: string[]; currentRevoked: boolean }>
}

/** Repository data is never a session proof without identity, version and lifetime checks. */
export function validateSessionRecord(raw: unknown): UserSessionRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SessionManagementError('session_unavailable')
  const value = raw as UserSessionRecord
  if (!validSessionId(value.id) || !validId(value.userId) || !validVersion(value.credentialVersion)
    || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100 || /[\u0000-\u001f\u007f]/.test(value.label)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.lastSeenAt) || !Number.isSafeInteger(value.expiresAt)
    || value.createdAt <= 0 || value.lastSeenAt < value.createdAt || value.lastSeenAt >= value.expiresAt
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > USER_SESSION_TTL_MS
    || (value.revokedAt !== null && (!Number.isSafeInteger(value.revokedAt) || value.revokedAt < value.createdAt))) {
    throw new SessionManagementError('session_unavailable')
  }
  return Object.freeze({ id: value.id, userId: value.userId, credentialVersion: value.credentialVersion, label: value.label,
    createdAt: value.createdAt, lastSeenAt: value.lastSeenAt, expiresAt: value.expiresAt, revokedAt: value.revokedAt })
}
export function assertManagedSession(principal: AuthenticatedUser): void {
  assertAuthenticatedUser(principal)
  if (!validSessionId(principal.sessionId) || !Number.isSafeInteger(principal.sessionExpiresAt)) throw new SessionManagementError('unauthenticated')
}

/** A coarse, unverified browser hint; never retain raw user-agent strings or infer location. */
export function sessionLabel(userAgent: unknown): string {
  if (typeof userAgent !== 'string' || userAgent.length > 2048) return 'Browser session'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /(?:Chrome|CriOS)\//.test(userAgent) ? 'Chrome'
    : /(?:Firefox|FxiOS)\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  const device = /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad'
    : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows'
      : /Macintosh|Mac OS X/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : null
  return device ? `${browser} on ${device}` : `${browser} session`
}
export function createSessionManagementService(repository: UserSessionRepository) {
  return Object.freeze({
    /** Internal registration after password verification; callers cannot supply a session id. */
    async start(principal: AuthenticatedUser, input: { label: string }): Promise<AuthenticatedUser> {
      assertAuthenticatedUser(principal)
      if (principal.sessionId !== undefined || principal.sessionExpiresAt !== undefined) throw new SessionManagementError('invalid_session')
      const label = input?.label
      if (typeof label !== 'string' || !label.trim() || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) throw new SessionManagementError('invalid_session')
      try {
        const id = randomUUID(), record = validateSessionRecord(await repository.start(principal, { id, label }))
        if (record.id !== id || record.userId !== principal.userId || record.credentialVersion !== principal.credentialVersion
          || record.revokedAt !== null || record.expiresAt <= Date.now()) throw new SessionManagementError('session_unavailable')
        return issueAuthenticatedUser({ id: principal.userId, username: principal.username, displayName: principal.displayName,
          credentialVersion: principal.credentialVersion, status: 'active' }, { id, expiresAt: record.expiresAt })
      } catch (error) {
        if (error instanceof SessionManagementError) throw error
        throw new SessionManagementError('session_unavailable')
      }
    },
    async list(principal: AuthenticatedUser): Promise<readonly UserSessionRecord[]> {
      assertManagedSession(principal)
      try {
        const rows = await repository.list(principal)
        if (!Array.isArray(rows) || rows.length > 20) throw new SessionManagementError('session_unavailable')
        const ids = new Set<string>(), records = rows.map(raw => {
          const row = validateSessionRecord(raw)
          if (row.userId !== principal.userId || row.credentialVersion !== principal.credentialVersion || row.revokedAt !== null
            || ids.has(row.id)) throw new SessionManagementError('session_unavailable')
          ids.add(row.id); return row
        })
        if (!ids.has(principal.sessionId!)) throw new SessionManagementError('unauthenticated')
        return Object.freeze(records)
      } catch (error) {
        if (error instanceof SessionManagementError) throw error
        throw new SessionManagementError('session_unavailable')
      }
    },
    async revoke(principal: AuthenticatedUser, targetSessionId: string | 'others'): Promise<Readonly<{ revokedIds: readonly string[]; currentRevoked: boolean }>> {
      assertManagedSession(principal)
      if (targetSessionId !== 'others' && !validSessionId(targetSessionId)) throw new SessionManagementError('invalid_session')
      try {
        const result = await repository.revoke(principal, targetSessionId)
        if (!result || !Array.isArray(result.revokedIds) || result.revokedIds.length > 20
          || result.revokedIds.some(id => !validSessionId(id)) || new Set(result.revokedIds).size !== result.revokedIds.length
          || typeof result.currentRevoked !== 'boolean' || result.currentRevoked !== result.revokedIds.includes(principal.sessionId!)
          || (targetSessionId === principal.sessionId && !result.currentRevoked)
          || (targetSessionId === 'others' ? result.currentRevoked : result.revokedIds.some(id => id !== targetSessionId))) {
          throw new SessionManagementError('session_unavailable')
        }
        return Object.freeze({ revokedIds: Object.freeze([...result.revokedIds]), currentRevoked: result.currentRevoked })
      } catch (error) {
        if (error instanceof SessionManagementError) throw error
        throw new SessionManagementError('session_unavailable')
      }
    },
  })
}
