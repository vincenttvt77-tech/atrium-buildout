import { DatabaseConnection } from './connection.ts'

export class LoginProtectionRepositoryError extends Error {
  constructor() {
    super('Sign-in protection is unavailable.')
    this.name = 'LoginProtectionRepositoryError'
  }
}
/** Pre-login reservations commit before any credential lookup/scrypt. No raw identity enters this port. */
export class PostgresLoginProtectionRepository {
  private connection: DatabaseConnection
  constructor(connection: DatabaseConnection) {
    if (connection.role !== 'atrium_authenticator') throw new Error('Login protection requires the authenticator database role.')
    this.connection = connection
  }
  async reserve(input: { usernameKey: string; clientKey: string }): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'usernameKey' && key !== 'clientKey')
      || typeof input.usernameKey !== 'string' || !/^[0-9a-f]{64}$/.test(input.usernameKey)
      || typeof input.clientKey !== 'string' || !/^[0-9a-f]{64}$/.test(input.clientKey)) throw new LoginProtectionRepositoryError()
    try {
      const result = await this.connection.transaction({}, async client => {
        const result = await client.query('SELECT * FROM atrium.reserve_login_attempt($1,$2)', [input.usernameKey, input.clientKey])
        const row = result.rows[0]
        if (result.rows.length !== 1 || typeof row.allowed !== 'boolean'
          || !Number.isSafeInteger(row.retry_after_seconds) || row.retry_after_seconds < (row.allowed ? 0 : 1)
          || row.retry_after_seconds > 2147483647 || (row.allowed && row.retry_after_seconds !== 0)) throw new LoginProtectionRepositoryError()
        return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds }
      })
      return result
    } catch { throw new LoginProtectionRepositoryError() }
  }
}
