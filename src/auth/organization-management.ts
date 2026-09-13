import { createHmac } from 'node:crypto'
import type { AuthenticatedUser, Role } from './model.ts'
import { AdministrationError } from './administration.ts'
import type { OrganizationAuthority, PrivilegedAuthentication, ReplaceMemberInput } from './administration.ts'
import { assertManagedSession } from './session-management.ts'
import { mintAccountFormToken, verifyAccountFormToken } from './account-request.ts'
import { validId, validVersion } from './validation.ts'

export interface OrganizationSummary { id: string; name: string }
export interface OrganizationMember {
  membershipId: string; userId: string; username: string; displayName: string
  userStatus: 'active' | 'inactive'; role: Role; status: 'active' | 'revoked'
  access: 'organization' | 'properties'; propertyIds: string[]; version: number; canManage: boolean
}
export interface OrganizationDirectory {
  organization: OrganizationSummary & { permissionVersion: number }
  actor: OrganizationAuthority
  properties: { id: string; name: string; status: 'active' | 'inactive'; permissionVersion: number }[]
  members: OrganizationMember[]
  nextCursor: string | null
}
export interface MemberReplacementReceipt {
  organizationId: string; membershipId: string; userId: string; version: number; requestId: string
  duplicate: boolean; actorAccessChanged: boolean
  role: Role; status: 'active' | 'revoked'; access: 'organization' | 'properties'; propertyIds: string[]
}
export interface OrganizationDirectoryOptions { limit: number; beforeMembershipId?: string }
/** Proof is resolved outside database locks; the repository checks it again at execution. */
export interface OrganizationManagementRepository {
  listOrganizations(principal: AuthenticatedUser, proofId: string): Promise<OrganizationSummary[]>
  directory(principal: AuthenticatedUser, organizationId: string, proofId: string,
    options: OrganizationDirectoryOptions): Promise<OrganizationDirectory>
  replaceMember(principal: AuthenticatedUser, input: ReplaceMemberInput, proofId: string): Promise<MemberReplacementReceipt>
}
const formSecret = (secret: string, organizationId: string | null): string => createHmac('sha256', secret)
  .update('atrium-organization-form-v1.' + JSON.stringify([organizationId, organizationId === null ? 'directory' : 'replace_member'])).digest('hex')
export const mintOrganizationFormToken = (principal: AuthenticatedUser, now: Date, secret: string, organizationId: string | null = null): string =>
  mintAccountFormToken(principal, now, formSecret(secret, organizationId))
export const verifyOrganizationFormToken = (token: unknown, principal: AuthenticatedUser, now: Date, secret: string, organizationId: string | null = null): boolean =>
  verifyAccountFormToken(token, principal, now, formSecret(secret, organizationId))

export function parseMemberReplacement(value: unknown): ReplaceMemberInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdministrationError('invalid_input')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).sort().join(',') !== 'access,expectedVersion,membershipId,organizationId,propertyIds,requestId,role,status'
    || !validId(fields.organizationId) || !validId(fields.membershipId) || !validId(fields.requestId)
    || !validVersion(fields.expectedVersion) || (typeof fields.role !== 'string' || !['owner', 'admin', 'staff', 'viewer'].includes(fields.role))
    || (typeof fields.status !== 'string' || !['active', 'revoked'].includes(fields.status)) || (typeof fields.access !== 'string' || !['organization', 'properties'].includes(fields.access))
    || !Array.isArray(fields.propertyIds) || fields.propertyIds.length > 1000 || !fields.propertyIds.every(validId)
    || new Set(fields.propertyIds).size !== fields.propertyIds.length
    || (fields.access === 'organization' && fields.propertyIds.length !== 0)) throw new AdministrationError('invalid_input')
  return { organizationId: fields.organizationId, membershipId: fields.membershipId, requestId: fields.requestId,
    expectedVersion: fields.expectedVersion, role: fields.role as Role, status: fields.status as 'active' | 'revoked',
    access: fields.access as 'organization' | 'properties', propertyIds: [...fields.propertyIds].sort() }
}

export function createOrganizationManagementService(repository: OrganizationManagementRepository,
  authentication: PrivilegedAuthentication, now: () => Date = () => new Date()) {
  async function proof(principal: AuthenticatedUser): Promise<string> {
    assertManagedSession(principal)
    const verified = await authentication.verifyCurrentSession(principal), time = now().getTime()
    if (!verified || verified.issuer !== authentication.issuer || verified.sessionId !== authentication.sessionId
      || verified.sessionId !== principal.sessionId || verified.subjectId !== principal.userId
      || verified.credentialVersion !== principal.credentialVersion || verified.purpose !== 'organization_administration'
      || !validId(verified.verificationId) || !['webauthn', 'totp'].includes(verified.method)
      || !Number.isFinite(time) || !Number.isFinite(Date.parse(verified.verifiedAt)) || Date.parse(verified.verifiedAt) > time
      || !Number.isFinite(Date.parse(verified.expiresAt)) || Date.parse(verified.expiresAt) <= time
      || Date.parse(verified.expiresAt) - Date.parse(verified.verifiedAt) > 10 * 60_000) throw new AdministrationError('mfa_required')
    return verified.verificationId
  }
  return Object.freeze({
    async listOrganizations(principal: AuthenticatedUser): Promise<OrganizationSummary[]> {
      return repository.listOrganizations(principal, await proof(principal))
    },
    async directory(principal: AuthenticatedUser, organizationId: string, options: OrganizationDirectoryOptions): Promise<OrganizationDirectory> {
      if (!validId(organizationId) || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
        || (options.beforeMembershipId !== undefined && !validId(options.beforeMembershipId))) throw new AdministrationError('invalid_input')
      return repository.directory(principal, organizationId, await proof(principal), options)
    },
    async replaceMember(principal: AuthenticatedUser, input: ReplaceMemberInput): Promise<MemberReplacementReceipt> {
      const parsed = parseMemberReplacement(input)
      return repository.replaceMember(principal, parsed, await proof(principal))
    },
  })
}
