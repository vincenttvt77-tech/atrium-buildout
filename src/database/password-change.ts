import type { AuthenticatedUser } from '../auth/model.ts'
import { assertAuthenticatedUser } from '../auth/identity.ts'
import { validId, validVersion } from '../auth/validation.ts'
import { PasswordChangeError } from '../auth/password-change.ts'
import type { PasswordChangeRepository, PasswordChangeReservation } from '../auth/password-change.ts'
import { DatabaseConnection } from './connection.ts'

/** Only finite self-service commands; the role still has no direct credential writes. */
export class PostgresPasswordChangeRepository implements PasswordChangeRepository {
  private connection: DatabaseConnection
  constructor(connection: DatabaseConnection) {
    if (connection.role !== 'atrium_authenticator') throw new Error('Password changes require the authenticator database role.')
    this.connection = connection
  }
  async reserve(principal: AuthenticatedUser, attemptId: string): Promise<PasswordChangeReservation> {
    assertAuthenticatedUser(principal)
    if (!validId(attemptId)) throw new PasswordChangeError('password_change_unavailable')
    const result = await this.connection.transaction({ actorUserId: principal.userId, credentialVersion: principal.credentialVersion,
      ...(principal.sessionId ? { actorSessionId: principal.sessionId } : {}) },
      client => client.query('SELECT * FROM atrium.reserve_password_change($1)', [attemptId]))
    const row = result.rows[0]
    if (result.rows.length !== 1) throw new PasswordChangeError('password_change_unavailable')
    if (row.outcome === 'session_changed') throw new PasswordChangeError('unauthenticated')
    if (row.outcome === 'rate_limited') {
      const retry = Number(row.retry_after_seconds)
      if (!Number.isSafeInteger(retry) || retry < 1 || retry > 900) throw new PasswordChangeError('password_change_unavailable')
      throw new PasswordChangeError('rate_limited', retry)
    }
    const version = Number(row.credential_version)
    if (row.outcome !== 'reserved' || row.attempt_id !== attemptId || row.user_id !== principal.userId
      || typeof row.password_hash !== 'string' || !validVersion(version) || String(version) !== String(row.credential_version)) {
      throw new PasswordChangeError('password_change_unavailable')
    }
    return { attemptId, passwordHash: row.password_hash, credentialVersion: version }
  }
  async commit(principal: AuthenticatedUser, reservation: PasswordChangeReservation, replacementHash: string): Promise<void> {
    assertAuthenticatedUser(principal)
    if (!validId(reservation.attemptId) || reservation.credentialVersion !== principal.credentialVersion) throw new PasswordChangeError('unauthenticated')
    const result = await this.connection.transaction({ actorUserId: principal.userId, credentialVersion: principal.credentialVersion,
      ...(principal.sessionId ? { actorSessionId: principal.sessionId } : {}) },
      client => client.query('SELECT atrium.commit_password_change($1,$2,$3) AS outcome',
        [reservation.attemptId, reservation.passwordHash, replacementHash]))
    if (result.rows[0]?.outcome === 'session_changed') throw new PasswordChangeError('unauthenticated')
    if (result.rows.length !== 1 || result.rows[0]?.outcome !== 'changed') throw new PasswordChangeError('password_change_unavailable')
  }
}
