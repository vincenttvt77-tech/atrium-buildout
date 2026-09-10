import { createHash } from 'node:crypto'
import { assertAuthenticatedUser } from './identity.ts'
import type { AuthenticatedUser, User, Organization, Membership, PropertyGrant, Role } from './model.ts'
import { normalizeUsername, validId, validVersion, validateUser, validateOrganization,
  validateMembership, validatePropertyGrant } from './validation.ts'

export type AdministrationCode = 'unauthenticated' | 'forbidden' | 'invalid_input' | 'invalid_record'
  | 'version_conflict' | 'last_owner' | 'mfa_required' | 'invitation_unavailable' | 'administration_unavailable'
export class AdministrationError extends Error {
  readonly code: AdministrationCode
  readonly status: number
  constructor(code: AdministrationCode) {
    super(code === 'mfa_required' ? 'Verify this session with multi-factor authentication before continuing.'
      : code === 'last_owner' ? 'The organization must retain an active owner.'
        : code === 'version_conflict' ? 'This membership changed. Reload it before continuing.'
          : code === 'unauthenticated' ? 'Sign in again before continuing.'
            : code === 'administration_unavailable' ? 'Organization administration is unavailable.'
              : 'This organization administration request is not permitted.')
    this.code = code
    this.status = code === 'unauthenticated' ? 401 : code === 'invalid_input' ? 400
      : code === 'version_conflict' || code === 'last_owner' ? 409
        : code === 'invalid_record' || code === 'administration_unavailable' ? 503 : 403
  }
}
const fail = (code: AdministrationCode): never => { throw new AdministrationError(code) }
const require = (condition: unknown, code: AdministrationCode = 'invalid_record'): void => { if (!condition) fail(code) }

/** Deliberately independent of timezone, inventory and published configuration. */
export interface AdministrationProperty {
  id: string; organizationId: string; status: 'active' | 'inactive'; permissionVersion: number
}
export interface OrganizationAuthoritySnapshot {
  user: User
  organization: Organization
  membership: Membership
  grants: PropertyGrant[]
  /** Complete organization property identity/status list, not a published property snapshot. */
  properties: AdministrationProperty[]
}
export interface MemberSnapshot { user: User; membership: Membership; grants: PropertyGrant[] }
export interface MemberReplacementSnapshot {
  authority: OrganizationAuthoritySnapshot
  target: MemberSnapshot
  /** Complete set: membership active AND user active AND role owner. Read under the organization lock at commit. */
  activeOwnerUserIds: string[]
}
export interface AccessManifest { role: Role; access: 'organization' | 'properties'; propertyIds: readonly string[] }
export interface ReplaceMemberInput extends AccessManifest {
  organizationId: string; membershipId: string; expectedVersion: number; status: 'active' | 'revoked'; requestId: string
}
export interface CreateInvitationInput extends AccessManifest {
  organizationId: string; requestId: string; recipientEmail: string
}
export interface OrganizationAuthority {
  readonly organizationId: string
  readonly userId: string
  readonly membershipId: string
  readonly credentialVersion: number
  readonly role: 'owner' | 'admin'
  readonly access: 'organization' | 'properties'
  readonly propertyIds: readonly string[]
  readonly permissionVersion: string
}
/** Runtime-issued preview/read scope. It is NOT a database command credential. */
export interface OrganizationAdministrationScope extends OrganizationAuthority {
  readonly kind: 'organization_administration'
  readonly verificationId: string
}
const scopes = new WeakSet<object>()
export function assertOrganizationAdministrationScope(value: unknown): asserts value is OrganizationAdministrationScope {
  if (!value || typeof value !== 'object' || !scopes.has(value)) fail('forbidden')
}

/** Real server adapter, bound to this exact authenticated session; never construct from HTTP fields. */
export interface PrivilegedAuthentication {
  readonly issuer: string
  readonly sessionId: string
  verifyCurrentSession(principal: AuthenticatedUser): Promise<MfaVerification | null>
}
export interface MfaVerification {
  issuer: string; sessionId: string; verificationId: string; subjectId: string
  credentialVersion: number
  purpose: 'organization_administration'
  method: 'webauthn' | 'totp'
  verifiedAt: string; expiresAt: string
}
export interface OrganizationInvitation extends AccessManifest {
  id: string; organizationId: string; version: number
  inviterUserId: string; inviterMembershipId: string
  recipientEmail: string
  state: 'pending' | 'revoked' | 'accepted'
  expiresAt: string
  /** Reference to the persisted issuer MFA audit; no token or factor secret. */
  issuedVerificationId: string
}
export type AcceptanceIdentity = { kind: 'existing_user'; userId: string; credentialVersion: number }
  | { kind: 'new_user'; enrollmentId: string; username: string; displayName: string }
/** Returned ONLY by a trusted request-bound token/recipient/enrollment verifier. */
export interface InvitationRecipientVerification {
  issuer: string; sessionId: string; verificationId: string
  invitationId: string; invitationVersion: number; recipientEmail: string
  expiresAt: string
  identity: AcceptanceIdentity
  /** Required before accepting an owner/admin role; may be absent for staff/viewer. */
  mfa: MfaVerification | null
}
export interface InvitationAuthentication {
  readonly issuer: string
  readonly sessionId: string
  /**
   * Existing: prove token + verified recipient belong to this signed-in user/session.
   * New: prove recipient ownership and a new enrollment with user-chosen credentials.
   * Password policy/screening/hash preparation happen here, outside SQL locks; no global upsert.
   * The adapter must not treat possession of a username, a token alone, or a browser flag as recipient ownership.
   */
  verifyRecipient(invitationId: string, principal: AuthenticatedUser | null): Promise<InvitationRecipientVerification | null>
}
export interface InvitationAcceptanceSnapshot {
  invitation: OrganizationInvitation
  /** Current issuer authority; an invitation never preserves revoked delegation rights. */
  inviter: OrganizationAuthoritySnapshot
  /** Existing-user acceptance must recheck current active identity/credential version. */
  acceptingUser: User | null
  /** Existing membership is not replaced by accepting an invitation. Use member administration instead. */
  existingMembership: Membership | null
}
/** Trusted read-only port. Return current owned records; no credentials or global directory reads. */
export interface OrganizationAdministrationRepository {
  readAuthority(principal: AuthenticatedUser, organizationId: string): Promise<OrganizationAuthoritySnapshot | null>
  readMemberReplacement(principal: AuthenticatedUser, organizationId: string, membershipId: string): Promise<MemberReplacementSnapshot | null>
  readInvitationAcceptance(verification: InvitationRecipientVerification): Promise<InvitationAcceptanceSnapshot | null>
}

/** Diagnostic previews, not approval tokens. No transaction method accepts these as execution authority. */
export interface AdministrationPlan<T> {
  readonly executionAuthority: false
  readonly operation: 'member.replace' | 'invitation.create' | 'invitation.accept'
  readonly value: Readonly<T>
}
export interface MembershipReplacement {
  organizationId: string; membershipId: string; userId: string; expectedVersion: number
  role: Role; status: 'active' | 'revoked'; access: 'organization' | 'properties'; propertyIds: readonly string[]
}
export interface InvitationAcceptance {
  organizationId: string; invitationId: string; invitationVersion: number
  identity: Readonly<AcceptanceIdentity>; role: Role; access: 'organization' | 'properties'; propertyIds: readonly string[]
}
/**
 * NEXT transaction boundary, intentionally unimplemented here. Request adapters bind real session/MFA
 * and recipient proofs; this repository rechecks them, actor/target versions and owner counts under
 * locks. It NEVER executes an AdministrationPlan. New identity + credential + membership + grants +
 * token consumption + secret-free receipt/audit commit together, with unique username INSERT only.
 */
export interface OrganizationAdministrationTransactions {
  replaceMember(principal: AuthenticatedUser, input: ReplaceMemberInput): Promise<{ membershipId: string; version: number }>
  createInvitation(principal: AuthenticatedUser, input: CreateInvitationInput): Promise<{ invitationId: string; version: number }>
  acceptInvitation(input: ExistingUserAcceptanceCommand | NewUserAcceptanceCommand): Promise<{ organizationId: string; userId: string; membershipId: string }>
}
export interface ExistingUserAcceptanceCommand {
  kind: 'existing_user'; principal: AuthenticatedUser; requestId: string; invitationToken: string
}
export interface NewUserAcceptanceCommand {
  kind: 'new_user'; requestId: string; invitationToken: string
  username: string; displayName: string; newPassword: string
}

const email = (value: unknown): value is string => typeof value === 'string' && value.length <= 254
  && !/[\ud800-\udfff]/u.test(value) && value === value.toLowerCase() && /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(value)
const ownKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
function ids(values: readonly string[], code: AdministrationCode): string[] {
  require(Array.isArray(values) && values.length <= 1000 && values.every(validId) && new Set(values).size === values.length, code)
  return [...values].sort()
}
function manifest(value: AccessManifest, code: AdministrationCode): AccessManifest {
  require(value && ['owner', 'admin', 'staff', 'viewer'].includes(value.role)
    && ['organization', 'properties'].includes(value.access), code)
  const propertyIds = ids(value.propertyIds, code)
  require(value.access !== 'organization' || propertyIds.length === 0, code)
  return { role: value.role, access: value.access, propertyIds: Object.freeze(propertyIds) }
}
function currentMember(value: MemberSnapshot, organizationId: string): MemberSnapshot {
  try {
    const user = validateUser(value.user), membership = validateMembership(value.membership)
    require(membership.organizationId === organizationId && membership.userId === user.id)
    require(Array.isArray(value.grants) && value.grants.length <= 1000)
    const grants = value.grants.map(validatePropertyGrant)
    require(grants.every(grant => grant.membershipId === membership.id && grant.organizationId === organizationId)
      && new Set(grants.map(grant => grant.propertyId)).size === grants.length)
    return { user, membership, grants }
  } catch (error) { if (error instanceof AdministrationError) throw error; return fail('invalid_record') }
}
/** Atemporal policy: use a CURRENT trusted snapshot, never a browser role or cached scope. */
export function evaluateOrganizationAuthority(snapshot: OrganizationAuthoritySnapshot,
  identity: { userId: string; credentialVersion: number }): OrganizationAuthority {
  try {
    const organization = validateOrganization(snapshot.organization)
    const { user, membership, grants } = currentMember(snapshot, organization.id)
    require(user.id === identity.userId && validVersion(identity.credentialVersion)
      && user.credentialVersion === identity.credentialVersion && user.status === 'active', 'unauthenticated')
    require(organization.status === 'active' && membership.status === 'active'
      && (membership.role === 'owner' || membership.role === 'admin'), 'forbidden')
    require(Array.isArray(snapshot.properties) && snapshot.properties.length <= 1000)
    const properties = snapshot.properties.map(property => {
      require(property && validId(property.id) && property.organizationId === organization.id
        && ['active', 'inactive'].includes(property.status) && validVersion(property.permissionVersion))
      return { id: property.id, status: property.status, version: property.permissionVersion }
    }).sort((a, b) => a.id.localeCompare(b.id))
    require(new Set(properties.map(property => property.id)).size === properties.length)
    require(grants.every(grant => properties.some(property => property.id === grant.propertyId)))
    const propertyIds = properties.filter(property => property.status === 'active'
      && (membership.access === 'organization' || grants.some(grant => grant.propertyId === property.id && grant.status === 'active')))
      .map(property => property.id)
    const permissionVersion = createHash('sha256').update(JSON.stringify([organization.id, organization.permissionVersion,
      user.id, user.credentialVersion, membership, [...grants].sort((a, b) => a.propertyId.localeCompare(b.propertyId)), properties])).digest('hex')
    return Object.freeze({ organizationId: organization.id, userId: user.id, membershipId: membership.id,
      credentialVersion: user.credentialVersion, role: membership.role as 'owner' | 'admin', access: membership.access,
      propertyIds: Object.freeze(propertyIds), permissionVersion })
  } catch (error) { if (error instanceof AdministrationError) throw error; return fail('invalid_record') }
}
function delegation(authority: OrganizationAuthority, desired: AccessManifest): void {
  require(authority.role === 'owner' || desired.role === 'staff' || desired.role === 'viewer', 'forbidden')
  require(desired.access !== 'organization' || authority.access === 'organization', 'forbidden')
  require(desired.propertyIds.every(id => authority.propertyIds.includes(id)), 'forbidden')
}
export function evaluateMemberReplacement(snapshot: MemberReplacementSnapshot, identity: { userId: string; credentialVersion: number },
  input: ReplaceMemberInput): MembershipReplacement {
  require(ownKeys(input, ['organizationId', 'membershipId', 'expectedVersion', 'status', 'requestId', 'role', 'access', 'propertyIds'])
    && validId(input.organizationId) && validId(input.membershipId) && validId(input.requestId)
    && validVersion(input.expectedVersion) && ['active', 'revoked'].includes(input.status), 'invalid_input')
  const authority = evaluateOrganizationAuthority(snapshot.authority, identity)
  require(authority.organizationId === input.organizationId, 'forbidden')
  const target = currentMember(snapshot.target, authority.organizationId)
  require(target.membership.id === input.membershipId, 'forbidden')
  require(target.membership.permissionVersion === input.expectedVersion, 'version_conflict')
  require(input.expectedVersion < Number.MAX_SAFE_INTEGER, 'invalid_record')
  const desired = manifest(input, 'invalid_input')
  delegation(authority, desired)
  require(authority.role === 'owner' || ((target.membership.role === 'staff' || target.membership.role === 'viewer')
    && target.user.id !== authority.userId), 'forbidden')
  // A limited administrator cannot alter an existing wider membership, even when narrowing it.
  require(authority.access === 'organization' || (target.membership.access === 'properties'
    && target.grants.filter(grant => grant.status === 'active').every(grant => authority.propertyIds.includes(grant.propertyId))), 'forbidden')
  require(input.status !== 'active' || target.user.status === 'active', 'forbidden')
  const owners = ids(snapshot.activeOwnerUserIds, 'invalid_record')
  require(owners.length > 0)
  if (authority.role === 'owner') require(owners.includes(authority.userId))
  const activeOwner = target.user.status === 'active' && target.membership.status === 'active' && target.membership.role === 'owner'
  if (activeOwner) {
    require(owners.includes(target.user.id))
    require((input.status === 'active' && desired.role === 'owner') || owners.length > 1, 'last_owner')
  }
  return Object.freeze({ organizationId: authority.organizationId, membershipId: target.membership.id,
    userId: target.user.id, expectedVersion: input.expectedVersion, status: input.status, ...desired })
}
export function evaluateInvitationCreation(snapshot: OrganizationAuthoritySnapshot, identity: { userId: string; credentialVersion: number },
  input: CreateInvitationInput): Readonly<CreateInvitationInput> {
  require(ownKeys(input, ['organizationId', 'requestId', 'recipientEmail', 'role', 'access', 'propertyIds'])
    && validId(input.organizationId) && validId(input.requestId) && email(input.recipientEmail), 'invalid_input')
  const authority = evaluateOrganizationAuthority(snapshot, identity)
  require(authority.organizationId === input.organizationId, 'forbidden')
  const desired = manifest(input, 'invalid_input')
  delegation(authority, desired)
  return Object.freeze({ organizationId: authority.organizationId, requestId: input.requestId, recipientEmail: input.recipientEmail, ...desired })
}
/** Temporal expiry/verified recipient checks belong to the service and are repeated by the future SQL command. */
export function evaluateInvitationAcceptance(snapshot: InvitationAcceptanceSnapshot,
  verification: InvitationRecipientVerification): InvitationAcceptance {
  const invite = snapshot.invitation
  require(invite && validId(invite.id) && validId(invite.organizationId) && validVersion(invite.version)
    && validId(invite.inviterUserId) && validId(invite.inviterMembershipId) && validId(invite.issuedVerificationId)
    && email(invite.recipientEmail) && ['pending', 'revoked', 'accepted'].includes(invite.state))
  require(invite.id === verification.invitationId && invite.version === verification.invitationVersion
    && invite.recipientEmail === verification.recipientEmail && invite.state === 'pending', 'invitation_unavailable')
  const authority = evaluateOrganizationAuthority(snapshot.inviter,
    { userId: invite.inviterUserId, credentialVersion: snapshot.inviter.user.credentialVersion })
  require(authority.organizationId === invite.organizationId && authority.membershipId === invite.inviterMembershipId, 'invitation_unavailable')
  const desired = manifest(invite, 'invalid_record')
  delegation(authority, desired)
  require(snapshot.existingMembership === null, 'invitation_unavailable')
  const identity = verification.identity
  if (identity.kind === 'existing_user') {
    require(snapshot.acceptingUser !== null, 'unauthenticated')
    let user: User
    try { user = validateUser(snapshot.acceptingUser!) } catch { return fail('invalid_record') }
    require(user.id === identity.userId && user.status === 'active' && user.credentialVersion === identity.credentialVersion, 'unauthenticated')
  } else {
    require(identity.kind === 'new_user' && validId(identity.enrollmentId) && typeof identity.username === 'string'
      && normalizeUsername(identity.username) === identity.username
      && typeof identity.displayName === 'string' && identity.displayName.trim().length > 0 && identity.displayName.length <= 200
      && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(identity.displayName), 'invalid_record')
    require(snapshot.acceptingUser === null, 'invitation_unavailable')
  }
  const safeIdentity: AcceptanceIdentity = identity.kind === 'existing_user'
    ? { kind: 'existing_user', userId: identity.userId, credentialVersion: identity.credentialVersion }
    : { kind: 'new_user', enrollmentId: identity.enrollmentId, username: identity.username, displayName: identity.displayName }
  return Object.freeze({ organizationId: authority.organizationId, invitationId: invite.id, invitationVersion: invite.version,
    identity: Object.freeze(safeIdentity), ...desired })
}

const time = (value: string): number => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : NaN
function mfa(proof: MfaVerification | null, binding: { issuer: string; sessionId: string },
  subjectId: string, credentialVersion: number, now: number): MfaVerification {
  require(proof && validId(binding.issuer) && validId(binding.sessionId) && proof.issuer === binding.issuer
    && proof.sessionId === binding.sessionId && validId(proof.verificationId) && proof.subjectId === subjectId
    && proof.credentialVersion === credentialVersion && proof.purpose === 'organization_administration'
    && (proof.method === 'webauthn' || proof.method === 'totp') && time(proof.verifiedAt) <= now
    && now < time(proof.expiresAt) && time(proof.expiresAt) - time(proof.verifiedAt) <= 10 * 60_000, 'mfa_required')
  return proof!
}
function principal(value: AuthenticatedUser): void {
  try { assertAuthenticatedUser(value) } catch { fail('unauthenticated') }
}
function plan<T>(operation: AdministrationPlan<T>['operation'], value: T): AdministrationPlan<T> {
  return Object.freeze({ executionAuthority: false, operation, value: Object.freeze(value) })
}
/** Read-only preparation. There is no default MFA/enrollment adapter and no production stub. */
export function createOrganizationAdministrationService(options: {
  repository: OrganizationAdministrationRepository
  privilegedAuthentication: PrivilegedAuthentication
  invitationAuthentication: InvitationAuthentication
  now?: () => Date
}) {
  const { repository, privilegedAuthentication, invitationAuthentication } = options
  const now = (): number => {
    const result = (options.now ?? (() => new Date()))().getTime()
    require(Number.isFinite(result))
    return result
  }
  async function guarded<T>(callback: () => Promise<T>): Promise<T> {
    try { return await callback() } catch (error) {
      if (error instanceof AdministrationError) throw error
      return fail('administration_unavailable')
    }
  }
  async function verification(user: AuthenticatedUser): Promise<MfaVerification> {
    return mfa(await privilegedAuthentication.verifyCurrentSession(user), privilegedAuthentication, user.userId, user.credentialVersion, now())
  }
  return Object.freeze({
    authorizeOrganization(user: AuthenticatedUser, organizationId: string): Promise<OrganizationAdministrationScope> {
      return guarded(async () => {
        principal(user); require(validId(organizationId), 'invalid_input')
        const snapshot = await repository.readAuthority(user, organizationId)
        require(snapshot, 'forbidden')
        const authority = evaluateOrganizationAuthority(snapshot!, user)
        require(authority.organizationId === organizationId, 'forbidden')
        const proof = await verification(user)
        const scope = Object.freeze({ ...authority, kind: 'organization_administration' as const, verificationId: proof.verificationId })
        scopes.add(scope)
        return scope
      })
    },
    prepareMemberReplacement(user: AuthenticatedUser, input: ReplaceMemberInput): Promise<AdministrationPlan<MembershipReplacement>> {
      return guarded(async () => {
        principal(user)
        require(input && validId(input.organizationId) && validId(input.membershipId), 'invalid_input')
        const snapshot = await repository.readMemberReplacement(user, input.organizationId, input.membershipId)
        require(snapshot, 'forbidden')
        const result = evaluateMemberReplacement(snapshot!, user, input)
        await verification(user)
        return plan('member.replace', result)
      })
    },
    prepareInvitation(user: AuthenticatedUser, input: CreateInvitationInput): Promise<AdministrationPlan<Readonly<CreateInvitationInput>>> {
      return guarded(async () => {
        principal(user); require(input && validId(input.organizationId), 'invalid_input')
        const snapshot = await repository.readAuthority(user, input.organizationId)
        require(snapshot, 'forbidden')
        const result = evaluateInvitationCreation(snapshot!, user, input)
        await verification(user)
        return plan('invitation.create', result)
      })
    },
    prepareInvitationAcceptance(user: AuthenticatedUser | null, invitationId: string): Promise<AdministrationPlan<InvitationAcceptance>> {
      return guarded(async () => {
        if (user !== null) principal(user)
        require(validId(invitationId), 'invalid_input')
        const proof = await invitationAuthentication.verifyRecipient(invitationId, user)
        require(proof && proof.issuer === invitationAuthentication.issuer && validId(proof.issuer)
          && proof.sessionId === invitationAuthentication.sessionId && validId(proof.sessionId) && validId(proof.verificationId)
          && proof.invitationId === invitationId && validVersion(proof.invitationVersion) && email(proof.recipientEmail)
          && now() < time(proof.expiresAt), 'invitation_unavailable')
        require(user === null ? proof!.identity?.kind === 'new_user' : proof!.identity?.kind === 'existing_user'
          && proof!.identity.userId === user.userId && proof!.identity.credentialVersion === user.credentialVersion, 'unauthenticated')
        const snapshot = await repository.readInvitationAcceptance(proof!)
        const checkedAt = now()
        require(snapshot && checkedAt < time(proof!.expiresAt)
          && checkedAt < time(snapshot.invitation.expiresAt), 'invitation_unavailable')
        const result = evaluateInvitationAcceptance(snapshot!, proof!)
        if (result.role === 'owner' || result.role === 'admin') {
          const identity = result.identity
          mfa(proof!.mfa, invitationAuthentication, identity.kind === 'existing_user' ? identity.userId : identity.enrollmentId,
            identity.kind === 'existing_user' ? identity.credentialVersion : 1, now())
        }
        return plan('invitation.accept', result)
      })
    },
  })
}
