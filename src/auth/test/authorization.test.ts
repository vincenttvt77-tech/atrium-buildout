import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createAuthorizationService, assertAuthorizedScope, mintUserSession, hashPassword, USER_SESSION_TTL_MS } from '../index.ts'
import { AuthorizationError } from '../model.ts'
import type { AuthorizationRepository, Organization, Property, User, Credential, Membership, PropertyGrant,
  ChannelBinding, AuthLookupContext, AuthenticatedUser, Permission } from '../model.ts'

const PASSWORD = 'synthetic-auth-test-password-123!'
const SECRET = 'synthetic-session-signing-secret-at-least-32-characters'
const NOW = new Date('2032-06-01T12:00:00Z')
let passwordHash: string
before(async () => { passwordHash = await hashPassword(PASSWORD) })
const copy = <T>(value: T): T => structuredClone(value)

class TestRepository implements AuthorizationRepository {
  contexts: AuthLookupContext[] = []
  users: User[] = ['staff', 'viewer', 'owner', 'both'].map(username => ({ id: `user-${username}`, username,
    displayName: username, status: 'active', credentialVersion: 1 }))
  organizations: Organization[] = ['a', 'b'].map(id => ({ id: `org-${id}`, name: `Organization ${id}`, status: 'active', permissionVersion: 1 }))
  properties: Property[] = ['a1', 'a2', 'b1', 'b2'].map(id => ({ id: `property-${id}`, organizationId: `org-${id[0]}`,
    name: 'Shared building name', timeZone: id[0] === 'a' ? 'America/New_York' : 'America/Chicago', status: 'active', permissionVersion: 1 }))
  memberships: Membership[] = [
    { id: 'member-staff', userId: 'user-staff', organizationId: 'org-a', role: 'staff', status: 'active', access: 'properties', permissionVersion: 1 },
    { id: 'member-viewer', userId: 'user-viewer', organizationId: 'org-a', role: 'viewer', status: 'active', access: 'organization', permissionVersion: 1 },
    { id: 'member-owner', userId: 'user-owner', organizationId: 'org-a', role: 'owner', status: 'active', access: 'properties', permissionVersion: 1 },
    { id: 'member-both-a', userId: 'user-both', organizationId: 'org-a', role: 'staff', status: 'active', access: 'properties', permissionVersion: 1 },
    { id: 'member-both-b', userId: 'user-both', organizationId: 'org-b', role: 'admin', status: 'active', access: 'properties', permissionVersion: 1 },
  ]
  grants: PropertyGrant[] = [
    { membershipId: 'member-staff', organizationId: 'org-a', propertyId: 'property-a1', status: 'active', permissionVersion: 1 },
    { membershipId: 'member-owner', organizationId: 'org-a', propertyId: 'property-a1', status: 'active', permissionVersion: 1 },
    { membershipId: 'member-both-a', organizationId: 'org-a', propertyId: 'property-a1', status: 'active', permissionVersion: 1 },
    { membershipId: 'member-both-b', organizationId: 'org-b', propertyId: 'property-b2', status: 'active', permissionVersion: 1 },
  ]
  bindings: ChannelBinding[] = [{ id: 'binding-vapi', provider: 'vapi', externalId: 'synthetic-assistant', organizationId: 'org-a',
    propertyId: 'property-a1', status: 'active', capabilities: ['read', 'operate'], permissionVersion: 1 }]
  note(context: AuthLookupContext) { assert.ok(Object.isFrozen(context)); this.contexts.push(context) }
  async findCredentialByUsername(username: string): Promise<Credential | null> {
    const user = this.users.find(user => user.username === username)
    return user ? { userId: user.id, passwordHash, credentialVersion: user.credentialVersion } : null
  }
  async getUser(id: string) { return copy(this.users.find(user => user.id === id) ?? null) }
  async getOrganization(id: string, context: AuthLookupContext) { this.note(context); return copy(this.organizations.find(org => org.id === id) ?? null) }
  async getProperty(id: string, context: AuthLookupContext) { this.note(context); return copy(this.properties.find(property => property.id === id) ?? null) }
  async getMembership(userId: string, organizationId: string, context: AuthLookupContext) { this.note(context); return copy(this.memberships.find(member => member.userId === userId && member.organizationId === organizationId) ?? null) }
  async listMemberships(userId: string, context: AuthLookupContext) { this.note(context); return copy(this.memberships.filter(member => member.userId === userId)) }
  async listProperties(organizationId: string, context: AuthLookupContext) { this.note(context); return copy(this.properties.filter(property => property.organizationId === organizationId)) }
  async listPropertyGrants(membershipId: string, context: AuthLookupContext) { this.note(context); return copy(this.grants.filter(grant => grant.membershipId === membershipId)) }
  async findChannelBinding(provider: string, externalId: string) { return copy(this.bindings.find(binding => binding.provider === provider && binding.externalId === externalId) ?? null) }
}
async function setup(username = 'staff') {
  const repository = new TestRepository(), service = createAuthorizationService(repository)
  const principal = await service.authenticatePassword(username, PASSWORD)
  assert.ok(principal)
  return { repository, service, principal }
}
const denied = (code: string) => (error: unknown) => error instanceof AuthorizationError && error.code === code

test('password authentication reuses scrypt and unknown users never become a dummy account', async () => {
  const repository = new TestRepository(), service = createAuthorizationService(repository)
  assert.equal((await service.authenticatePassword(' STAFF ', PASSWORD))?.userId, 'user-staff')
  assert.equal(await service.authenticatePassword('staff', 'wrong-password'), null)
  assert.equal(await service.authenticatePassword('missing', PASSWORD), null)
  assert.equal(await service.authenticatePassword('missing', 'dummy-credential-timing-only-not-an-account'), null)
  assert.equal(await service.authenticatePassword('staff', { password: PASSWORD }), null)
  repository.users[0]!.status = 'inactive'
  assert.equal(await service.authenticatePassword('staff', PASSWORD), null)
})

test('property scope requires explicit grants even for an owner and never infers old tenant IDs', async () => {
  const { service, principal } = await setup('owner')
  const scope = await service.authorizeProperty(principal, 'property-a1', 'manage_organization')
  assert.equal(scope.organizationId, 'org-a')
  await assert.rejects(service.authorizeProperty(principal, 'property-a2', 'read'), denied('forbidden'))
  await assert.rejects(service.authorizeProperty(principal, 'property-b1', 'read'), denied('forbidden'))
  await assert.rejects(service.authorizeProperty(principal, 'unknown-property', 'read'), denied('forbidden'))
  await assert.rejects(service.authorizeProperty(principal, 'demo-larkin', 'read'), denied('forbidden'))
})

test('password rotation between hash lookup and current-user lookup does not authenticate the old password', async () => {
  const repository = new TestRepository(), service = createAuthorizationService(repository)
  const originalGet = repository.getUser.bind(repository)
  repository.getUser = async id => {
    repository.users.find(user => user.id === id)!.credentialVersion++
    return originalGet(id)
  }
  assert.equal(await service.authenticatePassword('staff', PASSWORD), null)
})

test('viewer access is read-only and explicit organization membership lists only its properties', async () => {
  const { service, principal } = await setup('viewer')
  assert.equal((await service.authorizeProperty(principal, 'property-a2', 'read')).actor.kind, 'user')
  for (const permission of ['operate', 'configure', 'manage_members', 'manage_organization'] as const) {
    await assert.rejects(service.authorizeProperty(principal, 'property-a1', permission), denied('forbidden'))
  }
  assert.deepEqual((await service.listAuthorizedProperties(principal)).map(property => property.id), ['property-a1', 'property-a2'])
})

test('one identity can switch between granted properties in two organizations without broadening either membership', async () => {
  const { service, principal, repository } = await setup('both')
  assert.deepEqual((await service.listAuthorizedProperties(principal)).map(property => [property.organizationId, property.id, property.role]),
    [['org-a', 'property-a1', 'staff'], ['org-b', 'property-b2', 'admin']])
  const scopes = await Promise.all(['property-a1', 'property-b2'].map(id => service.authorizeProperty(principal, id, 'operate')))
  assert.deepEqual(scopes.map(scope => scope.organizationId), ['org-a', 'org-b'])
  await assert.rejects(service.authorizeProperty(principal, 'property-b1', 'read'), denied('forbidden'))
  assert.ok(repository.contexts.every(context => context.kind === 'user' && context.userId === 'user-both' && context.credentialVersion === 1))
})

test('revocation and permission changes apply to already-authenticated principals on the next authorization', async () => {
  const { service, principal, repository } = await setup()
  const first = await service.authorizeProperty(principal, 'property-a1', 'operate')
  const member = repository.memberships[0]!, grant = repository.grants[0]!
  member.role = 'viewer'; member.permissionVersion++
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'operate'), denied('forbidden'))
  const readOnly = await service.authorizeProperty(principal, 'property-a1', 'read')
  assert.notEqual(readOnly.permissionVersion, first.permissionVersion)
  grant.status = 'revoked'; grant.permissionVersion++
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('forbidden'))
  assert.deepEqual(await service.listAuthorizedProperties(principal), [])
  grant.status = 'active'; member.status = 'revoked'; member.permissionVersion++
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('forbidden'))
})

test('disabled users, organizations, and properties fail closed; invalid versions and zones are rejected', async () => {
  const { service, principal, repository } = await setup()
  repository.organizations[0]!.status = 'inactive'
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('forbidden'))
  repository.organizations[0]!.status = 'active'; repository.properties[0]!.status = 'inactive'
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('forbidden'))
  repository.properties[0]!.status = 'active'; repository.properties[0]!.timeZone = 'America/Miami'
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('invalid_record'))
  repository.properties[0]!.timeZone = 'America/New_York'; repository.memberships[0]!.permissionVersion = 0
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('invalid_record'))
  repository.memberships[0]!.permissionVersion = 1; repository.users[0]!.status = 'inactive'
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('unauthenticated'))
})

test('misowned or duplicated grant records cannot authorize across organizations', async () => {
  const { service, principal, repository } = await setup()
  repository.grants[0]!.organizationId = 'org-b'
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('invalid_record'))
  repository.grants[0]!.organizationId = 'org-a'; repository.grants.push(copy(repository.grants[0]!))
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('invalid_record'))
})

test('scopes and identities are immutable server objects, not reusable JSON authority', async () => {
  const { service, principal } = await setup()
  const scope = await service.authorizeProperty(principal, 'property-a1', 'operate')
  assertAuthorizedScope(scope, 'operate')
  assert.ok(Object.isFrozen(scope)); assert.ok(Object.isFrozen(scope.actor)); assert.ok(Object.isFrozen(scope.permissions))
  assert.throws(() => (scope.permissions as Permission[]).push('manage_organization'))
  assert.throws(() => assertAuthorizedScope(JSON.parse(JSON.stringify(scope))), denied('forbidden'))
  await assert.rejects(service.authorizeProperty({ ...principal }, 'property-a1', 'read'), denied('unauthenticated'))
  await assert.rejects(service.authorizeProperty({ userId: principal.userId, role: 'owner' } as unknown as AuthenticatedUser, 'property-a1', 'read'), denied('unauthenticated'))
})

test('a3 session contains no property/role authority and rechecks current user plus credential version', async () => {
  const { service, principal, repository } = await setup()
  const token = mintUserSession(principal, NOW, SECRET)
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
  assert.deepEqual(Object.keys(claims).sort(), ['credentialVersion', 'expiresAt', 'userId'])
  assert.equal((await service.authenticateSession(token, NOW, SECRET))?.userId, principal.userId)
  repository.users[0]!.credentialVersion++
  assert.equal(await service.authenticateSession(token, NOW, SECRET), null)
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), denied('unauthenticated'))
  repository.users[0]!.credentialVersion--; repository.users[0]!.status = 'inactive'
  assert.equal(await service.authenticateSession(token, NOW, SECRET), null)
})

test('session tampering, expiry, overlong lifetime, and secret rotation cannot authenticate', async () => {
  const { service, principal } = await setup()
  const token = mintUserSession(principal, NOW, SECRET, 1000)
  assert.equal(await service.authenticateSession(token, new Date(NOW.getTime() + 1000), SECRET), null)
  assert.equal(await service.authenticateSession(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, NOW, SECRET), null)
  assert.equal(await service.authenticateSession(token, NOW, SECRET + '-rotated'), null)
  assert.equal(await service.authenticateSession('a2.legacy.signature', NOW, SECRET), null)
  assert.throws(() => mintUserSession(principal, NOW, SECRET, USER_SESSION_TTL_MS + 1), /lifetime/)
  assert.throws(() => mintUserSession(principal, NOW, 'too-short'), /signing secret/)
  const payload = Buffer.from(JSON.stringify({ userId: principal.userId, credentialVersion: 1, expiresAt: NOW.getTime() + USER_SESSION_TTL_MS + 1 })).toString('base64url')
  const signature = createHmac('sha256', SECRET).update(`atrium-database-user-session-v3|${payload}`).digest('base64url')
  assert.equal(await service.authenticateSession(`a3.${payload}.${signature}`, NOW, SECRET), null)
})

test('verified channel routing uses current binding ownership and capabilities, never a user role', async () => {
  const repository = new TestRepository(), service = createAuthorizationService(repository)
  const scope = await service.authorizeChannel('vapi', 'synthetic-assistant', 'operate')
  assert.deepEqual(scope.actor, { kind: 'channel', bindingId: 'binding-vapi', provider: 'vapi', externalId: 'synthetic-assistant', bindingVersion: 1 })
  assert.equal(scope.organizationId, 'org-a'); assert.equal(scope.propertyId, 'property-a1')
  assert.ok(repository.contexts.every(context => context.kind === 'channel'))
  await assert.rejects(service.authorizeChannel('vapi', 'synthetic-assistant', 'configure'), denied('forbidden'))
  await assert.rejects(service.authorizeChannel('vapi', 'unknown', 'read'), denied('forbidden'))
  repository.bindings[0]!.organizationId = 'org-b'
  await assert.rejects(service.authorizeChannel('vapi', 'synthetic-assistant', 'read'), denied('invalid_record'))
  repository.bindings[0]!.organizationId = 'org-a'; repository.bindings[0]!.status = 'inactive'
  await assert.rejects(service.authorizeChannel('vapi', 'synthetic-assistant', 'read'), denied('forbidden'))
})

test('repository outages do not downgrade to legacy accounts or fabricated scope', async () => {
  const { service, principal, repository } = await setup()
  repository.getProperty = async () => { throw new Error('Synthetic database unavailable') }
  await assert.rejects(service.authorizeProperty(principal, 'property-a1', 'read'), /database unavailable/)
})
