import { PostgresUserSessionRepository } from './user-sessions.ts'
import type { UserSessionClaims } from '../auth/model.ts'
import { DatabaseConnection } from './connection.ts'
import type { DatabaseContext } from './connection.ts'
import { AuthorizationError } from '../auth/model.ts'
import type { AuthLookupContext, AuthorizationRepository, Organization, Property, User, Credential, Membership,
  PropertyGrant, ChannelBinding, Role, Permission } from '../auth/model.ts'
import { validId, validVersion, normalizeUsername } from '../auth/validation.ts'

type Row = Record<string, unknown>
const MAX_ROWS = 10_000
function invalid(): never { throw new AuthorizationError('invalid_record') }
function text(value: unknown): string { return typeof value === 'string' ? value : invalid() }
/** pg returns bigint as text by default; never round an authorization version. */
function version(value: unknown): number {
  if (typeof value === 'number' && validVersion(value)) return value
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) invalid()
  const parsed = Number(value)
  return validVersion(parsed) && String(parsed) === value ? parsed : invalid()
}
function lookupContext(context: AuthLookupContext): DatabaseContext {
  if (!context || typeof context !== 'object') invalid()
  if (context.kind === 'user') {
    if (!validId(context.userId) || !validVersion(context.credentialVersion)) invalid()
    return { actorUserId: context.userId, credentialVersion: context.credentialVersion,
      ...(context.sessionId ? { actorSessionId: context.sessionId } : {}) }
  }
  if (context.kind !== 'channel' || !/^[a-z][a-z0-9_-]{0,63}$/.test(context.provider)
    || typeof context.externalId !== 'string' || !context.externalId || context.externalId.length > 256
    || /[\u0000-\u0020\u007f]/.test(context.externalId)) invalid()
  return { channelProvider: context.provider, channelExternalId: context.externalId }
}
const user = (row: Row): User => ({ id: text(row.id), username: text(row.username), displayName: text(row.display_name),
  status: text(row.status) as User['status'], credentialVersion: version(row.credential_version) })
const organization = (row: Row): Organization => ({ id: text(row.id), name: text(row.name), status: text(row.status) as Organization['status'], permissionVersion: version(row.permission_version) })
const property = (row: Row): Property => ({ id: text(row.id), organizationId: text(row.organization_id), name: text(row.name), timeZone: text(row.time_zone),
  status: text(row.status) as Property['status'], permissionVersion: version(row.permission_version) })
const membership = (row: Row): Membership => ({ id: text(row.id), userId: text(row.user_id), organizationId: text(row.organization_id), role: text(row.role) as Role,
  status: text(row.status) as Membership['status'], access: text(row.access) as Membership['access'], permissionVersion: version(row.permission_version) })
const grant = (row: Row): PropertyGrant => ({ membershipId: text(row.membership_id), organizationId: text(row.organization_id), propertyId: text(row.property_id),
  status: text(row.status) as PropertyGrant['status'], permissionVersion: version(row.permission_version) })
const binding = (row: Row): ChannelBinding => {
  if (!Array.isArray(row.capabilities) || row.capabilities.some(value => typeof value !== 'string')) invalid()
  return { id: text(row.id), provider: text(row.provider), externalId: text(row.external_id), organizationId: text(row.organization_id), propertyId: text(row.property_id),
    status: text(row.status) as ChannelBinding['status'], capabilities: [...row.capabilities] as Permission[], permissionVersion: version(row.permission_version) }
}
const USER_COLUMNS = 'id, username, display_name, status, credential_version'
const ORGANIZATION_COLUMNS = 'id, name, status, permission_version'
const PROPERTY_COLUMNS = 'id, organization_id, name, time_zone, status, permission_version'
const MEMBERSHIP_COLUMNS = 'id, user_id, organization_id, role, status, access, permission_version'
const GRANT_COLUMNS = 'membership_id, organization_id, property_id, status, permission_version'
const BINDING_COLUMNS = 'id, provider, external_id, organization_id, property_id, status, capabilities, permission_version'

/** Read-only authentication adapter. Each query has fresh transaction-local RLS context. */
export class PgAuthorizationRepository implements AuthorizationRepository {
  private connection: DatabaseConnection
  constructor(connection: DatabaseConnection) {
    if (connection.role !== 'atrium_authenticator') throw new Error('Authorization reads require the authenticator database role.')
    this.connection = connection
  }
  private async one<T>(context: DatabaseContext, sql: string, values: unknown[], map: (row: Row) => T): Promise<T | null> {
    return this.connection.transaction(context, async client => {
      const result = await client.query<Row>(sql, values)
      if (result.rows.length > 1) invalid()
      return result.rows[0] ? map(result.rows[0]) : null
    })
  }
  private async list<T>(context: DatabaseContext, sql: string, values: unknown[], map: (row: Row) => T): Promise<T[]> {
    return this.connection.transaction(context, async client => {
      const result = await client.query<Row>(`${sql} LIMIT ${MAX_ROWS + 1}`, values)
      if (result.rows.length > MAX_ROWS) throw new Error('Authorization selection exceeds the supported result limit.')
      return result.rows.map(map)
    })
  }
  async resolveSession(claims: UserSessionClaims) {
    return new PostgresUserSessionRepository(this.connection).resolve(claims)
  }
  async findCredentialByUsername(username: string): Promise<Credential | null> {
    if (normalizeUsername(username) !== username) return null
    return this.one({ loginUsername: username },
      'SELECT c.user_id, c.password_hash, u.credential_version FROM atrium.user_credentials c JOIN atrium.users u ON u.id = c.user_id WHERE u.username = $1', [username],
      row => ({ userId: text(row.user_id), passwordHash: text(row.password_hash), credentialVersion: version(row.credential_version) }))
  }
  async getUser(userId: string): Promise<User | null> {
    if (!validId(userId)) return null
    return this.one({ actorUserId: userId }, `SELECT ${USER_COLUMNS} FROM atrium.users WHERE id = $1`, [userId], user)
  }
  async getOrganization(id: string, context: AuthLookupContext): Promise<Organization | null> {
    if (!validId(id)) return null
    return this.one(lookupContext(context), `SELECT ${ORGANIZATION_COLUMNS} FROM atrium.organizations WHERE id = $1`, [id], organization)
  }
  async getProperty(id: string, context: AuthLookupContext): Promise<Property | null> {
    if (!validId(id)) return null
    return this.one(lookupContext(context), `SELECT ${PROPERTY_COLUMNS} FROM atrium.properties WHERE id = $1`, [id], property)
  }
  async getMembership(userId: string, organizationId: string, context: AuthLookupContext): Promise<Membership | null> {
    if (!validId(userId) || !validId(organizationId)) return null
    if (context.kind !== 'user' || context.userId !== userId) throw new AuthorizationError('forbidden')
    return this.one(lookupContext(context), `SELECT ${MEMBERSHIP_COLUMNS} FROM atrium.memberships WHERE user_id = $1 AND organization_id = $2`, [userId, organizationId], membership)
  }
  async listMemberships(userId: string, context: AuthLookupContext): Promise<Membership[]> {
    if (!validId(userId)) return []
    if (context.kind !== 'user' || context.userId !== userId) throw new AuthorizationError('forbidden')
    return this.list(lookupContext(context), `SELECT ${MEMBERSHIP_COLUMNS} FROM atrium.memberships WHERE user_id = $1 ORDER BY organization_id, id`, [userId], membership)
  }
  async listProperties(organizationId: string, context: AuthLookupContext): Promise<Property[]> {
    if (!validId(organizationId)) return []
    return this.list(lookupContext(context), `SELECT ${PROPERTY_COLUMNS} FROM atrium.properties WHERE organization_id = $1 ORDER BY id`, [organizationId], property)
  }
  async listPropertyGrants(membershipId: string, context: AuthLookupContext): Promise<PropertyGrant[]> {
    if (!validId(membershipId)) return []
    return this.list(lookupContext(context), `SELECT ${GRANT_COLUMNS} FROM atrium.property_grants WHERE membership_id = $1 ORDER BY property_id`, [membershipId], grant)
  }
  async findChannelBinding(provider: string, externalId: string): Promise<ChannelBinding | null> {
    const context = lookupContext({ kind: 'channel', provider, externalId })
    return this.one(context, `SELECT ${BINDING_COLUMNS} FROM atrium.channel_bindings WHERE provider = $1 AND external_id = $2`, [provider, externalId], binding)
  }
}
