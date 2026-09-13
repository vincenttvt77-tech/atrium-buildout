import pg from 'pg'
import type { PoolConfig, PoolClient } from 'pg'
import { isHostedRuntime } from '../store/config.ts'
import { DatabaseConfigurationError } from './errors.ts'
export { DatabaseConfigurationError } from './errors.ts'

export type DatabaseRole = 'atrium_app' | 'atrium_authenticator'
export interface DatabaseContext {
  actorUserId?: string
  actorSessionId?: string
  credentialVersion?: number
  organizationId?: string
  propertyId?: string
  loginUsername?: string
  channelProvider?: string
  channelExternalId?: string
  channelBindingId?: string
  channelBindingVersion?: number
}

/** One deployment connection per role, never one environment file per staff login. */
export function databasePoolConfig(role: DatabaseRole, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (env.ATRIUM_SIMULATION) throw new DatabaseConfigurationError()
  const key = role === 'atrium_app' ? 'ATRIUM_DATABASE_URL' : 'ATRIUM_AUTH_DATABASE_URL'
  let url: URL
  try { url = new URL(env[key] ?? '') } catch { throw new DatabaseConfigurationError() }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password
    || !/^\/[^/]+$/.test(url.pathname) || url.search || url.hash) throw new DatabaseConfigurationError()
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const ca = env.ATRIUM_DATABASE_CA?.trim()
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
    // URL sslmode/PGOPTIONS cannot weaken TLS or inject session-level scope.
    ssl: loopback && !isHostedRuntime(env) ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    application_name: `atrium-${role}`, allowExitOnIdle: true,
    options: '-c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000',
  }
}

const settings = [
  ['atrium.actor_user_id', 'actorUserId'], ['atrium.session_id', 'actorSessionId'], ['atrium.credential_version', 'credentialVersion'],
  ['atrium.organization_id', 'organizationId'], ['atrium.property_id', 'propertyId'],
  ['atrium.login_username', 'loginUsername'], ['atrium.channel_provider', 'channelProvider'],
  ['atrium.channel_external_id', 'channelExternalId'], ['atrium.channel_binding_id', 'channelBindingId'],
  ['atrium.channel_binding_version', 'channelBindingVersion'],
] as const

/** Owns a single client for each transaction; context never survives commit or rollback. */
export class DatabaseConnection {
  readonly pool: pg.Pool
  readonly role: DatabaseRole
  constructor(config: PoolConfig, role: DatabaseRole) {
    this.pool = new pg.Pool(config)
    this.role = role
    // Do not log connection strings or server errors containing statement parameters.
    this.pool.on('error', () => console.error('[database]', JSON.stringify({ code: 'idle_connection_error', role })))
  }
  async transaction<T>(context: DatabaseContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (process.env.ATRIUM_SIMULATION) throw new DatabaseConfigurationError()
    const client = await this.pool.connect()
    let discard = false
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      // Shared transaction poolers may discard startup options. Apply trusted
      // bounds on the leased backend before any identity or application query;
      // LOCAL settings disappear on either commit or rollback.
      await client.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true),
        pg_catalog.set_config('statement_timeout', '10000', true),
        pg_catalog.set_config('lock_timeout', '5000', true),
        pg_catalog.set_config('idle_in_transaction_session_timeout', '15000', true)`)
      const identity = await client.query<{ rolname: string; login_role: string; rolsuper: boolean; rolbypassrls: boolean;
        rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; admin_member: boolean; other_runtime_member: boolean; account_executor_member: boolean }>(
        `SELECT rolname, session_user AS login_role, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
           pg_catalog.pg_has_role(current_user, 'atrium_admin', 'MEMBER') AS admin_member,
           pg_catalog.pg_has_role(current_user, $1, 'MEMBER') AS other_runtime_member,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles executor WHERE executor.rolname IN ('atrium_account_executor','atrium_login_executor','atrium_session_executor','atrium_mfa_executor','atrium_organization_executor')
             AND pg_catalog.pg_has_role(current_user, executor.oid, 'MEMBER')) AS account_executor_member
         FROM pg_catalog.pg_roles WHERE rolname = current_user`,
      [this.role === 'atrium_app' ? 'atrium_authenticator' : 'atrium_app'])
      const row = identity.rows[0]
      if (!row || row.rolname !== this.role || row.login_role !== this.role || row.rolsuper || row.rolbypassrls
        || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.admin_member || row.other_runtime_member || row.account_executor_member) throw new DatabaseConfigurationError()
      // Bind every known key, including empty ones: inherited state is never authority.
      await client.query(`SELECT ${settings.map(([name], index) => `pg_catalog.set_config('${name}', $${index + 1}, true)`).join(', ')}`,
        settings.map(([, key]) => String(context[key] ?? '')))
      const result = await work(client)
      const committed = await client.query('COMMIT')
      // PostgreSQL answers ROLLBACK (without throwing) if a callback swallowed a
      // SQL error and left the transaction aborted. Never return its success value.
      if (committed.command !== 'COMMIT') throw new Error('The database transaction was rolled back.')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { discard = true }
      throw error
    } finally { client.release(discard) }
  }
  async close(): Promise<void> { await this.pool.end() }
}
