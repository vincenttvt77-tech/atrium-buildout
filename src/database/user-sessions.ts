import { assertAuthenticatedUser } from '../auth/identity.ts'
import type { AuthenticatedUser, UserSessionClaims, UserSessionRecord } from '../auth/model.ts'
import { SessionManagementError, assertManagedSession, validateSessionRecord } from '../auth/session-management.ts'
import type { UserSessionRepository } from '../auth/session-management.ts'
import { validSessionId } from '../auth/session.ts'
import { validId, validVersion } from '../auth/validation.ts'
import { DatabaseConnection } from './connection.ts'
import type { DatabaseContext } from './connection.ts'

function context(principal: AuthenticatedUser): DatabaseContext {
  return { actorUserId: principal.userId, credentialVersion: principal.credentialVersion,
    ...(principal.sessionId ? { actorSessionId: principal.sessionId } : {}) }
}
function rowRecord(row: Record<string, unknown>): UserSessionRecord {
  return validateSessionRecord({ id: row.id, userId: row.user_id, label: row.label,
    credentialVersion: Number(row.credential_version), createdAt: Number(row.created_at_ms),
    lastSeenAt: Number(row.last_seen_at_ms), expiresAt: Number(row.expires_at_ms),
    revokedAt: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms) })
}
function failure(error: unknown): never {
  if (error instanceof SessionManagementError) throw error
  if ((error as { code?: string })?.code === '22023') throw new SessionManagementError('invalid_session')
  if ((error as { code?: string })?.code === '28000') throw new SessionManagementError('unauthenticated')
  throw new SessionManagementError('session_unavailable')
}
/** Finite self-session commands; no raw credential access or ambient transaction reuse. */
export class PostgresUserSessionRepository implements UserSessionRepository {
  private connection: DatabaseConnection
  constructor(connection: DatabaseConnection) {
    if (connection.role !== 'atrium_authenticator') throw new Error('Session registration requires the authenticator database role.')
    this.connection = connection
  }
  async start(principal: AuthenticatedUser, input: { id: string; label: string }): Promise<UserSessionRecord> {
    assertAuthenticatedUser(principal)
    if (principal.sessionId !== undefined || principal.sessionExpiresAt !== undefined) throw new SessionManagementError('invalid_session')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'id' && key !== 'label') || !validSessionId(input.id)
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 100 || /[\u0000-\u001f\u007f]/.test(input.label)) throw new SessionManagementError('invalid_session')
    try {
      return await this.connection.transaction(context(principal), async client => {
        const rows = (await client.query('SELECT * FROM atrium.start_user_session($1::uuid,$2)', [input.id, input.label])).rows
        if (rows.length !== 1) throw new SessionManagementError('session_unavailable')
        const record = rowRecord(rows[0])
        if (record.id !== input.id || record.userId !== principal.userId || record.credentialVersion !== principal.credentialVersion
          || record.revokedAt !== null) throw new SessionManagementError('session_unavailable')
        return record
      })
    } catch (error) { failure(error) }
  }
  async resolve(claims: UserSessionClaims): Promise<UserSessionRecord | null> {
    if (!claims || typeof claims !== 'object' || Array.isArray(claims) || !validId(claims.userId)
      || !validVersion(claims.credentialVersion) || !validSessionId(claims.sessionId)
      || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= 0) return null
    try {
      return await this.connection.transaction({ actorUserId: claims.userId, credentialVersion: claims.credentialVersion,
        actorSessionId: claims.sessionId }, async client => {
        const rows = (await client.query('SELECT * FROM atrium.resolve_user_session($1::bigint)', [claims.expiresAt])).rows
        if (!rows.length) return null
        if (rows.length !== 1) throw new SessionManagementError('session_unavailable')
        const record = rowRecord(rows[0])
        if (record.id !== claims.sessionId || record.userId !== claims.userId || record.credentialVersion !== claims.credentialVersion
          || record.expiresAt !== claims.expiresAt || record.revokedAt !== null) throw new SessionManagementError('session_unavailable')
        return record
      })
    } catch (error) { failure(error) }
  }
  async list(principal: AuthenticatedUser): Promise<UserSessionRecord[]> {
    assertManagedSession(principal)
    try {
      return await this.connection.transaction(context(principal), async client => {
        const records = (await client.query('SELECT * FROM atrium.list_user_sessions()')).rows.map(rowRecord)
        if (records.length > 20 || records.some(row => row.userId !== principal.userId
          || row.credentialVersion !== principal.credentialVersion || row.revokedAt !== null)
          || !records.some(row => row.id === principal.sessionId && row.expiresAt === principal.sessionExpiresAt)) throw new SessionManagementError('unauthenticated')
        return records
      })
    } catch (error) { failure(error) }
  }
  async revoke(principal: AuthenticatedUser, targetSessionId: string | 'others'): Promise<{ revokedIds: string[]; currentRevoked: boolean }> {
    assertManagedSession(principal)
    if (targetSessionId !== 'others' && !validSessionId(targetSessionId)) throw new SessionManagementError('invalid_session')
    try {
      return await this.connection.transaction(context(principal), async client => {
        const rows = (await client.query('SELECT * FROM atrium.revoke_user_sessions($1)', [targetSessionId])).rows
        const row = rows[0]
        if (rows.length !== 1 || !Array.isArray(row.revoked_ids) || row.revoked_ids.length > 20
          || row.revoked_ids.some((id: unknown) => !validSessionId(id))
          || new Set(row.revoked_ids).size !== row.revoked_ids.length || typeof row.current_revoked !== 'boolean'
          || row.current_revoked !== row.revoked_ids.includes(principal.sessionId)
          || (targetSessionId === 'others' ? row.current_revoked : row.revoked_ids.some((id: string) => id !== targetSessionId))) throw new SessionManagementError('session_unavailable')
        return { revokedIds: row.revoked_ids, currentRevoked: row.current_revoked }
      })
    } catch (error) { failure(error) }
  }
}
