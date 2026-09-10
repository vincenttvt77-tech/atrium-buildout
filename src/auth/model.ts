/** Database identities are independent of the old Redis tenant namespace. */
export type RecordStatus = 'active' | 'inactive'
export type AccessStatus = 'active' | 'revoked'
export type Role = 'owner' | 'admin' | 'staff' | 'viewer'
export type Permission = 'read' | 'operate' | 'configure' | 'manage_members' | 'manage_organization'

export interface Organization {
  id: string
  name: string
  status: RecordStatus
  permissionVersion: number
}
export interface Property {
  id: string
  organizationId: string
  name: string
  timeZone: string
  status: RecordStatus
  permissionVersion: number
}
export interface User {
  id: string
  username: string
  displayName: string
  status: RecordStatus
  credentialVersion: number
}
export interface UserSessionRecord {
  id: string
  userId: string
  credentialVersion: number
  label: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  revokedAt: number | null
}
export interface UserSessionClaims { userId: string; credentialVersion: number; sessionId: string; expiresAt: number }
export interface Credential {
  userId: string
  passwordHash: string
  /** Read atomically with the hash; prevents password rotation racing verification. */
  credentialVersion: number
}
export interface Membership {
  id: string
  userId: string
  organizationId: string
  role: Role
  status: AccessStatus
  /** Organization-wide access is explicit; the role alone never grants it. */
  access: 'organization' | 'properties'
  permissionVersion: number
}
export interface PropertyGrant {
  membershipId: string
  organizationId: string
  propertyId: string
  status: AccessStatus
  permissionVersion: number
}
export interface ChannelBinding {
  id: string
  provider: string
  externalId: string
  organizationId: string
  propertyId: string
  status: RecordStatus
  capabilities: Permission[]
  permissionVersion: number
}
/** Server-derived immutable inputs for transaction-local authorization reads. */
export type AuthLookupContext = Readonly<{ kind: 'user'; userId: string; credentialVersion: number; sessionId?: string }>
  | Readonly<{ kind: 'channel'; provider: string; externalId: string }>

/**
 * Server-owned repository. Implementations must bind query parameters, return current
 * records, and enforce uniqueness/ownership in the database as well as in this module.
 * No method accepts a browser-supplied role, organization grant, or old tenant ID.
 */
export interface AuthorizationRepository {
  findCredentialByUsername(username: string): Promise<Credential | null>
  getUser(userId: string): Promise<User | null>
  resolveSession(claims: UserSessionClaims): Promise<UserSessionRecord | null>
  getOrganization(organizationId: string, context: AuthLookupContext): Promise<Organization | null>
  getProperty(propertyId: string, context: AuthLookupContext): Promise<Property | null>
  getMembership(userId: string, organizationId: string, context: AuthLookupContext): Promise<Membership | null>
  listMemberships(userId: string, context: AuthLookupContext): Promise<Membership[]>
  listProperties(organizationId: string, context: AuthLookupContext): Promise<Property[]>
  listPropertyGrants(membershipId: string, context: AuthLookupContext): Promise<PropertyGrant[]>
  findChannelBinding(provider: string, externalId: string): Promise<ChannelBinding | null>
}

/** Opaque at runtime: only objects issued by this module's authentication paths work. */
export interface AuthenticatedUser {
  readonly kind: 'user'
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly credentialVersion: number
  readonly sessionId?: string
  readonly sessionExpiresAt?: number
}
export type ScopeActor = Readonly<{
  kind: 'user'; userId: string; membershipId: string; role: Role; credentialVersion: number; sessionId?: string
}> | Readonly<{
  kind: 'channel'; bindingId: string; provider: string; externalId: string; bindingVersion: number
}>
/**
 * Request-local authority, not a session token. Never deserialize it from a browser,
 * persist it as a worker's future authority, or translate it to a legacy tenant ID.
 * Reauthorize before a delayed operation; database transactions still check ownership.
 */
export interface AuthorizedScope {
  readonly organizationId: string
  readonly propertyId: string
  readonly actor: ScopeActor
  readonly permissions: readonly Permission[]
  readonly permissionVersion: string
}
export interface AuthorizedProperty {
  readonly id: string
  readonly organizationId: string
  readonly organizationName: string
  readonly name: string
  readonly timeZone: string
  readonly role: Role
  readonly permissions: readonly Permission[]
  readonly permissionVersion: string
}

export class AuthorizationError extends Error {
  readonly code: 'unauthenticated' | 'forbidden' | 'invalid_record'
  constructor(code: AuthorizationError['code']) {
    super(code === 'unauthenticated' ? 'Authentication is required.'
      : code === 'forbidden' ? 'Access to this property or operation is not permitted.'
        : 'Authorization configuration is invalid.')
    this.code = code
  }
}
