import type { AuthenticatedUser } from '../auth/model.ts'
import type { ReplaceMemberInput, OrganizationAuthority } from '../auth/administration.ts'
import { AdministrationError } from '../auth/administration.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { normalizeUsername, validId, validVersion } from '../auth/validation.ts'
import { parseMemberReplacement } from '../auth/organization-management.ts'
import type { OrganizationSummary, OrganizationDirectory, OrganizationDirectoryOptions, OrganizationMember,
  MemberReplacementReceipt, OrganizationManagementRepository } from '../auth/organization-management.ts'
import type { DatabaseConnection } from './connection.ts'

type RecordValue = Record<string, any>
const bad = (): never => { throw new AdministrationError('invalid_record') }
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : bad()
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
  && !/[\u0000-\u001f\u007f]/.test(value)
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 1000 || !value.every(validId) || new Set(value).size !== value.length) bad()
  return [...value as string[]]
}
const summary = (value: unknown): OrganizationSummary => {
  const row = record(value)
  if (!validId(row.id) || !text(row.name)) bad()
  return { id: row.id, name: row.name }
}
function member(value: unknown): OrganizationMember {
  const row = record(value), propertyIds = ids(row.propertyIds)
  if (!validId(row.membershipId) || !validId(row.userId) || typeof row.username !== 'string'
    || normalizeUsername(row.username) !== row.username || !text(row.displayName)
    || !['active','inactive'].includes(row.userStatus) || !['owner','admin','staff','viewer'].includes(row.role)
    || !['active','revoked'].includes(row.status) || !['organization','properties'].includes(row.access)
    || (row.access === 'organization' && propertyIds.length !== 0) || !validVersion(row.version) || typeof row.canManage !== 'boolean') bad()
  return { membershipId: row.membershipId, userId: row.userId, username: row.username, displayName: row.displayName,
    userStatus: row.userStatus, role: row.role, status: row.status, access: row.access, propertyIds,
    version: row.version, canManage: row.canManage }
}
const proofId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const knownCodes = ['unauthenticated','forbidden','invalid_input','invalid_record','version_conflict','last_owner','mfa_required'] as const

/** Finite organization commands; no raw identity/grant writes or credential capability. */
export class PostgresOrganizationAdministrationRepository implements OrganizationManagementRepository {
  private readonly connection: DatabaseConnection
  constructor(connection: DatabaseConnection) {
    if (connection.role !== 'atrium_app') throw new AdministrationError('administration_unavailable')
    this.connection = connection
  }
  private async call(principal: AuthenticatedUser, organizationId: string | undefined, verificationId: string,
    query: string, parameters: unknown[]): Promise<unknown> {
    assertManagedSession(principal)
    if (!proofId(verificationId)) throw new AdministrationError('mfa_required')
    try {
      return await this.connection.transaction({ actorUserId: principal.userId, credentialVersion: principal.credentialVersion,
        actorSessionId: principal.sessionId!, ...(organizationId ? { organizationId } : {}) }, async client => {
        const result = await client.query(query, parameters)
        if (result.rows.length !== 1 || !Object.hasOwn(result.rows[0], 'result')) bad()
        return result.rows[0].result
      })
    } catch (error) {
      if (error instanceof AdministrationError) throw error
      const failure = error as { code?: unknown; message?: unknown }
      const code = knownCodes.find(value => value === failure.message)
      if (failure.code === 'P0001' && code) throw new AdministrationError(code)
      throw new AdministrationError('administration_unavailable')
    }
  }
  async listOrganizations(principal: AuthenticatedUser, verificationId: string): Promise<OrganizationSummary[]> {
    const result = await this.call(principal, undefined, verificationId,
      'SELECT atrium.list_administrable_organizations($1::uuid) AS result', [verificationId])
    if (!Array.isArray(result) || result.length > 1000) bad()
    const rows = (result as unknown[]).map(summary)
    if (new Set(rows.map(row => row.id)).size !== rows.length) bad()
    return rows
  }
  async directory(principal: AuthenticatedUser, organizationId: string, verificationId: string,
    options: OrganizationDirectoryOptions): Promise<OrganizationDirectory> {
    if (!validId(organizationId) || !options || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
      || (options.beforeMembershipId !== undefined && !validId(options.beforeMembershipId))) throw new AdministrationError('invalid_input')
    const result = record(await this.call(principal, organizationId, verificationId,
      'SELECT atrium.organization_directory($1,$2::uuid,$3,$4) AS result', [organizationId, verificationId, options.limit, options.beforeMembershipId ?? null]))
    const organization = { ...summary(result.organization), permissionVersion: result.organization.permissionVersion }
    if (organization.id !== organizationId || !validVersion(organization.permissionVersion)
      || !Array.isArray(result.properties) || result.properties.length > 1000
      || !Array.isArray(result.members) || result.members.length > options.limit
      || (result.nextCursor !== null && !validId(result.nextCursor))) bad()
    const properties = result.properties.map((value: unknown) => {
      const row = record(value)
      if (!['active','inactive'].includes(row.status) || !validVersion(row.permissionVersion)) bad()
      return { ...summary(row), status: row.status as 'active' | 'inactive', permissionVersion: row.permissionVersion as number }
    })
    const actor = record(result.actor), propertyIds = ids(actor.propertyIds)
    if (actor.organizationId !== organizationId || actor.userId !== principal.userId || actor.credentialVersion !== principal.credentialVersion
      || !validId(actor.membershipId) || !['owner','admin'].includes(actor.role) || !['organization','properties'].includes(actor.access)
      || typeof actor.permissionVersion !== 'string' || !/^[a-f0-9]{64}$/.test(actor.permissionVersion)
      || !propertyIds.every(id => properties.some((property: { id: string; status: string }) => property.id === id && property.status === 'active'))) bad()
    const authority: OrganizationAuthority = { organizationId, userId: principal.userId, membershipId: actor.membershipId,
      credentialVersion: principal.credentialVersion, role: actor.role, access: actor.access, propertyIds, permissionVersion: actor.permissionVersion }
    const members = result.members.map(member)
    if (new Set(members.map((row: OrganizationMember) => row.membershipId)).size !== members.length
      || new Set(properties.map((row: { id: string }) => row.id)).size !== properties.length
      || (result.nextCursor !== null && result.nextCursor !== members.at(-1)?.membershipId)) bad()
    return { organization, actor: authority, properties, members, nextCursor: result.nextCursor }
  }
  async replaceMember(principal: AuthenticatedUser, input: ReplaceMemberInput, verificationId: string): Promise<MemberReplacementReceipt> {
    const parsed = parseMemberReplacement(input)
    const row = record(await this.call(principal, parsed.organizationId, verificationId,
      'SELECT atrium.replace_organization_member($1::jsonb,$2::uuid) AS result', [JSON.stringify(parsed), verificationId]))
    const propertyIds = ids(row.propertyIds)
    if (row.organizationId !== parsed.organizationId || row.membershipId !== parsed.membershipId || row.requestId !== parsed.requestId
      || !validId(row.userId) || !validVersion(row.version) || row.version !== parsed.expectedVersion + 1
      || typeof row.duplicate !== 'boolean' || row.actorAccessChanged !== (row.userId === principal.userId)
      || row.role !== parsed.role || row.status !== parsed.status || row.access !== parsed.access
      || JSON.stringify([...propertyIds].sort()) !== JSON.stringify(parsed.propertyIds)) bad()
    return { organizationId: row.organizationId, membershipId: row.membershipId, userId: row.userId, version: row.version,
      requestId: row.requestId, duplicate: row.duplicate, actorAccessChanged: row.actorAccessChanged,
      role: row.role, status: row.status, access: row.access, propertyIds }
  }
}
