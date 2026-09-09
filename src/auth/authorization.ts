import { createHash } from 'node:crypto'
import { verifyPassword } from '../ops/accounts.ts'
import { issueAuthenticatedUser, assertAuthenticatedUser } from './identity.ts'
import { verifyUserSessionClaims } from './session.ts'
import { AuthorizationError } from './model.ts'
import type { AuthorizationRepository, AuthenticatedUser, AuthorizedScope, AuthorizedProperty, User, Property,
  Organization, PropertyGrant, ScopeActor, Permission, AuthLookupContext } from './model.ts'
import { normalizeUsername, validId, validVersion, validateUser, validateOrganization, validateProperty, validateMembership,
  validatePropertyGrant, validateChannelBinding, rolePermissions, requirePermission } from './validation.ts'

// A valid non-account hash gives unknown usernames the same scrypt work as known ones.
// Its value is public test data, never a usable credential or account fallback.
const DUMMY_HASH = 'scrypt$65536$8$1$sJl4quDnOuWgpsgheoICHw$N41jo_SyTN1lydYshkm-5kizyPqsHyK_YkIPEHOnMvc'
const scopes = new WeakSet<object>()
const POLICY_VERSION = 'atrium-property-authorization-v1'
function forbidden(): never { throw new AuthorizationError('forbidden') }
function invalid(): never { throw new AuthorizationError('invalid_record') }
function validPasswordHash(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = /^scrypt\$65536\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(value)
  return Boolean(parts && Buffer.from(parts[1]!, 'base64url').toString('base64url') === parts[1]
    && Buffer.from(parts[2]!, 'base64url').toString('base64url') === parts[2])
}

function issueScope(organizationId: string, propertyId: string, actor: ScopeActor,
  permissions: readonly Permission[], authority: unknown): AuthorizedScope {
  const scope = Object.freeze({ organizationId, propertyId, actor: Object.freeze({ ...actor }),
    permissions: Object.freeze([...permissions]),
    permissionVersion: createHash('sha256').update(JSON.stringify([POLICY_VERSION, authority])).digest('base64url'),
  })
  scopes.add(scope)
  return scope
}

/** Guards object provenance and permission; database RLS still checks current authority. */
export function assertAuthorizedScope(value: unknown, permission?: Permission): asserts value is AuthorizedScope {
  if (!value || typeof value !== 'object' || !scopes.has(value)) throw new AuthorizationError('forbidden')
  if (permission !== undefined) requirePermission((value as AuthorizedScope).permissions, permission)
}

/** These methods require server-owned repositories; no browser claim becomes authority. */
export function createAuthorizationService(repository: AuthorizationRepository) {
  async function currentUser(principal: AuthenticatedUser): Promise<User> {
    assertAuthenticatedUser(principal)
    const raw = await repository.getUser(principal.userId)
    if (!raw) throw new AuthorizationError('unauthenticated')
    const user = validateUser(raw)
    if (user.id !== principal.userId) invalid()
    if (user.status !== 'active' || user.credentialVersion !== principal.credentialVersion) throw new AuthorizationError('unauthenticated')
    return user
  }

  async function activeProperty(propertyId: string, context: AuthLookupContext): Promise<{ property: Property; organization: Organization }> {
    if (!validId(propertyId)) forbidden()
    const raw = await repository.getProperty(propertyId, context)
    if (!raw) forbidden()
    const property = validateProperty(raw)
    if (property.id !== propertyId) invalid()
    if (property.status !== 'active') forbidden()
    const rawOrganization = await repository.getOrganization(property.organizationId, context)
    if (!rawOrganization) forbidden()
    const organization = validateOrganization(rawOrganization)
    if (organization.id !== property.organizationId) invalid()
    if (organization.status !== 'active') forbidden()
    return { property, organization }
  }

  async function authenticatePassword(username: unknown, password: unknown): Promise<AuthenticatedUser | null> {
    const normalized = normalizeUsername(username)
    const credential = normalized ? await repository.findCredentialByUsername(normalized) : null
    // Malformed repository credentials cannot select a faster, invalid-hash path.
    const usableHash = credential && validPasswordHash(credential.passwordHash)
      ? credential.passwordHash : DUMMY_HASH
    const verified = await verifyPassword(typeof password === 'string' ? password : '', usableHash)
    if (!credential || !normalized || !verified || usableHash === DUMMY_HASH) return null
    if (!validId(credential.userId) || !validVersion(credential.credentialVersion)) invalid()
    const raw = await repository.getUser(credential.userId)
    if (!raw) return null
    const user = validateUser(raw)
    if (user.id !== credential.userId || user.username !== normalized) invalid()
    return user.status === 'active' && user.credentialVersion === credential.credentialVersion ? issueAuthenticatedUser(user) : null
  }

  async function authenticateSession(token: string | undefined, now: Date, secret: string): Promise<AuthenticatedUser | null> {
    const claims = verifyUserSessionClaims(token, now, secret)
    if (!claims) return null
    const raw = await repository.getUser(claims.userId)
    if (!raw) return null
    const user = validateUser(raw)
    if (user.id !== claims.userId) invalid()
    return user.status === 'active' && user.credentialVersion === claims.credentialVersion ? issueAuthenticatedUser(user) : null
  }

  async function authorizeProperty(principal: AuthenticatedUser, propertyId: string, permission: Permission): Promise<AuthorizedScope> {
    const user = await currentUser(principal)
    const context: AuthLookupContext = Object.freeze({ kind: 'user', userId: user.id, credentialVersion: user.credentialVersion })
    const { property, organization } = await activeProperty(propertyId, context)
    const rawMembership = await repository.getMembership(user.id, organization.id, context)
    if (!rawMembership) forbidden()
    const membership = validateMembership(rawMembership)
    if (membership.userId !== user.id || membership.organizationId !== organization.id) invalid()
    if (membership.status !== 'active') forbidden()
    const permissions = rolePermissions(membership.role)
    requirePermission(permissions, permission)
    let grant: PropertyGrant | null = null
    if (membership.access === 'properties') {
      const grants = await repository.listPropertyGrants(membership.id, context)
      if (!Array.isArray(grants)) invalid()
      const seen = new Set<string>()
      for (const raw of grants) {
        const candidate = validatePropertyGrant(raw)
        if (candidate.membershipId !== membership.id || candidate.organizationId !== organization.id || seen.has(candidate.propertyId)) invalid()
        seen.add(candidate.propertyId)
        if (candidate.propertyId === property.id && candidate.status === 'active') grant = candidate
      }
      if (!grant) forbidden()
    }
    return issueScope(organization.id, property.id, { kind: 'user', userId: user.id, membershipId: membership.id,
      role: membership.role, credentialVersion: user.credentialVersion }, permissions,
    [user.id, user.credentialVersion, organization.id, organization.permissionVersion, property.id, property.permissionVersion,
      membership.id, membership.permissionVersion, membership.role, membership.access, grant?.permissionVersion ?? null])
  }

  async function listAuthorizedProperties(principal: AuthenticatedUser): Promise<readonly AuthorizedProperty[]> {
    const user = await currentUser(principal)
    const context: AuthLookupContext = Object.freeze({ kind: 'user', userId: user.id, credentialVersion: user.credentialVersion })
    const memberships = await repository.listMemberships(user.id, context)
    if (!Array.isArray(memberships)) invalid()
    const organizations = new Set<string>(), propertyIds = new Set<string>()
    const result: AuthorizedProperty[] = []
    for (const raw of memberships) {
      const membership = validateMembership(raw)
      if (membership.userId !== user.id || organizations.has(membership.organizationId)) invalid()
      organizations.add(membership.organizationId)
      if (membership.status !== 'active') continue
      const rawOrganization = await repository.getOrganization(membership.organizationId, context)
      if (!rawOrganization) continue
      const organization = validateOrganization(rawOrganization)
      if (organization.id !== membership.organizationId) invalid()
      if (organization.status !== 'active') continue
      const properties = await repository.listProperties(organization.id, context)
      if (!Array.isArray(properties)) invalid()
      for (const rawProperty of properties) {
        const property = validateProperty(rawProperty)
        if (property.organizationId !== organization.id || propertyIds.has(property.id)) invalid()
        propertyIds.add(property.id)
        if (property.status !== 'active') continue
        let scope: AuthorizedScope
        try { scope = await authorizeProperty(principal, property.id, 'read') }
        catch (error) {
          if (error instanceof AuthorizationError && error.code === 'forbidden') continue
          throw error
        }
        if (scope.actor.kind !== 'user') invalid()
        result.push(Object.freeze({ id: property.id, organizationId: organization.id, organizationName: organization.name,
          name: property.name, timeZone: property.timeZone, role: scope.actor.role,
          permissions: scope.permissions, permissionVersion: scope.permissionVersion }))
      }
    }
    return Object.freeze(result.sort((left, right) => left.organizationId.localeCompare(right.organizationId) || left.id.localeCompare(right.id)))
  }

  /** Call only after verifying the provider's signature/credential; arguments are routing identities, not tool arguments. */
  async function authorizeChannel(provider: string, externalId: string, permission: Permission): Promise<AuthorizedScope> {
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider)
      || typeof externalId !== 'string' || !externalId || externalId.length > 256 || /[\u0000-\u0020\u007f]/.test(externalId)) forbidden()
    const raw = await repository.findChannelBinding(provider, externalId)
    if (!raw) forbidden()
    const binding = validateChannelBinding(raw)
    if (binding.provider !== provider || binding.externalId !== externalId) invalid()
    if (binding.status !== 'active') forbidden()
    const context: AuthLookupContext = Object.freeze({ kind: 'channel', provider, externalId })
    const { property, organization } = await activeProperty(binding.propertyId, context)
    if (binding.organizationId !== organization.id) invalid()
    requirePermission(binding.capabilities, permission)
    return issueScope(organization.id, property.id, { kind: 'channel', bindingId: binding.id, provider, externalId, bindingVersion: binding.permissionVersion },
      [...binding.capabilities].sort(), [organization.id, organization.permissionVersion, property.id, property.permissionVersion,
        binding.id, binding.permissionVersion, [...binding.capabilities].sort()])
  }

  return Object.freeze({ authenticatePassword, authenticateSession, authorizeProperty, listAuthorizedProperties, authorizeChannel })
}
