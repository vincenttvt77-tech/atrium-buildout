import test from 'node:test'
import assert from 'node:assert/strict'
import { issueAuthenticatedUser } from '../identity.ts'
import type { User, AuthenticatedUser } from '../model.ts'
import { AdministrationError, assertOrganizationAdministrationScope, createOrganizationAdministrationService,
  evaluateOrganizationAuthority, evaluateMemberReplacement, evaluateInvitationCreation, evaluateInvitationAcceptance } from '../administration.ts'
import type { OrganizationAuthoritySnapshot, MemberReplacementSnapshot, ReplaceMemberInput, CreateInvitationInput,
  InvitationAcceptanceSnapshot, InvitationRecipientVerification, MfaVerification, OrganizationAdministrationRepository } from '../administration.ts'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const user = (id: string): User => ({ id, username: id, displayName: id, status: 'active', credentialVersion: 1 })
const actor = issueAuthenticatedUser(user('owner-one'))
function authority(): OrganizationAuthoritySnapshot {
  return {
    user: user('owner-one'), organization: { id: 'org-a', name: 'Organization A', status: 'active', permissionVersion: 1 },
    membership: { id: 'member-owner', userId: 'owner-one', organizationId: 'org-a', role: 'owner', status: 'active', access: 'organization', permissionVersion: 1 },
    grants: [], properties: ['property-a', 'property-b'].map(id => ({ id, organizationId: 'org-a', status: 'active', permissionVersion: 1 })),
  }
}
function replacement(): MemberReplacementSnapshot {
  return { authority: authority(), activeOwnerUserIds: ['owner-one'], target: {
    user: user('staff-one'),
    membership: { id: 'member-staff', userId: 'staff-one', organizationId: 'org-a', role: 'staff', status: 'active', access: 'properties', permissionVersion: 3 },
    grants: [{ membershipId: 'member-staff', organizationId: 'org-a', propertyId: 'property-a', status: 'active', permissionVersion: 2 }],
  } }
}
function replaceInput(): ReplaceMemberInput {
  return { organizationId: 'org-a', membershipId: 'member-staff', expectedVersion: 3, requestId: 'request-one',
    role: 'viewer', status: 'active', access: 'properties', propertyIds: ['property-a'] }
}
function inviteInput(): CreateInvitationInput {
  return { organizationId: 'org-a', requestId: 'invite-request', recipientEmail: 'recipient@example.test',
    role: 'staff', access: 'properties', propertyIds: ['property-a'] }
}
function verification(subjectId = actor.userId): MfaVerification {
  return { issuer: 'test-identity-provider', sessionId: 'verified-session', verificationId: 'verified-factor',
    subjectId, credentialVersion: 1, purpose: 'organization_administration', method: 'webauthn',
    verifiedAt: '2026-09-10T11:59:00.000Z', expiresAt: '2026-09-10T12:04:00.000Z' }
}
function recipient(): InvitationRecipientVerification {
  return { issuer: 'test-identity-provider', sessionId: 'acceptance-session', verificationId: 'verified-recipient',
    invitationId: 'invitation-one', invitationVersion: 1, recipientEmail: 'recipient@example.test',
    expiresAt: '2026-09-10T12:04:00.000Z', identity: { kind: 'existing_user', userId: 'invitee-one', credentialVersion: 1 }, mfa: null }
}
function acceptance(): InvitationAcceptanceSnapshot {
  return { invitation: { id: 'invitation-one', organizationId: 'org-a', version: 1, inviterUserId: 'owner-one',
    inviterMembershipId: 'member-owner', recipientEmail: 'recipient@example.test', state: 'pending',
    expiresAt: '2026-09-11T12:00:00.000Z', issuedVerificationId: 'creation-mfa', role: 'staff', access: 'properties', propertyIds: ['property-a'] },
  inviter: authority(), acceptingUser: user('invitee-one'), existingMembership: null }
}
const rejects = (code: string) => (error: unknown): boolean => error instanceof AdministrationError && error.code === code
function fixture(clock: () => Date = () => NOW) {
  const data = { authority: authority(), replacement: replacement(), acceptance: acceptance(), mfa: verification() as MfaVerification | null,
    recipient: recipient() as InvitationRecipientVerification | null, reads: 0, mfaCalls: 0 }
  const repository: OrganizationAdministrationRepository = {
    async readAuthority() { data.reads++; return structuredClone(data.authority) },
    async readMemberReplacement() { data.reads++; return structuredClone(data.replacement) },
    async readInvitationAcceptance() { data.reads++; return structuredClone(data.acceptance) },
  }
  const service = createOrganizationAdministrationService({ repository, now: clock,
    privilegedAuthentication: { issuer: 'test-identity-provider', sessionId: 'verified-session',
      async verifyCurrentSession() { data.mfaCalls++; return structuredClone(data.mfa) } },
    invitationAuthentication: { issuer: 'test-identity-provider', sessionId: 'acceptance-session',
      async verifyRecipient() { return structuredClone(data.recipient) } },
  })
  return { data, service, repository }
}

test('scope requires a runtime principal, current organization authority and exact verified session', async () => {
  const { service, data } = fixture()
  await assert.rejects(service.authorizeOrganization({ ...actor }, 'org-a'), rejects('unauthenticated'))
  await assert.rejects(service.authorizeOrganization({ kind: 'channel' } as unknown as AuthenticatedUser, 'org-a'), rejects('unauthenticated'))
  assert.equal(data.reads, 0)
  const scope = await service.authorizeOrganization(actor, 'org-a')
  assertOrganizationAdministrationScope(scope)
  assert.throws(() => assertOrganizationAdministrationScope({ ...scope }), rejects('forbidden'))
  assert.equal(Object.isFrozen(scope), true)
  assert.equal(Object.isFrozen(scope.propertyIds), true)
  assert.equal(scope.organizationId, 'org-a')
  assert.equal('propertyId' in scope, false)
  assert.equal('tenantId' in scope, false)
})

test('organization administration works without any published property or even a property row', async () => {
  const { service, data } = fixture()
  data.authority.properties = []
  const scope = await service.authorizeOrganization(actor, 'org-a')
  assert.deepEqual(scope.propertyIds, [])
  assert.equal(scope.role, 'owner')
})

test('revoked membership, inactive organization/user, credential rotation and nonprivileged roles fail current reads', async () => {
  for (const mutate of [
    (a: OrganizationAuthoritySnapshot) => { a.membership.status = 'revoked' },
    (a: OrganizationAuthoritySnapshot) => { a.organization.status = 'inactive' },
    (a: OrganizationAuthoritySnapshot) => { a.membership.role = 'staff' },
    (a: OrganizationAuthoritySnapshot) => { a.membership.role = 'viewer' },
  ]) {
    const { service, data } = fixture(); mutate(data.authority)
    await assert.rejects(service.authorizeOrganization(actor, 'org-a'), rejects('forbidden'))
    assert.equal(data.mfaCalls, 0)
  }
  for (const mutate of [
    (a: OrganizationAuthoritySnapshot) => { a.user.status = 'inactive' },
    (a: OrganizationAuthoritySnapshot) => { a.user.credentialVersion++ },
  ]) {
    const { service, data } = fixture(); mutate(data.authority)
    await assert.rejects(service.authorizeOrganization(actor, 'org-a'), rejects('unauthenticated'))
  }
})

test('no browser Boolean, other session, wrong issuer/subject, stale credential or expired/future/long MFA proof is accepted', async () => {
  const invalid: unknown[] = [null, true, { verified: true },
    { ...verification(), sessionId: 'other-session' }, { ...verification(), issuer: 'other-provider' },
    { ...verification(), subjectId: 'owner-two' }, { ...verification(), credentialVersion: 2 },
    { ...verification(), purpose: 'login' }, { ...verification(), method: 'password' },
    { ...verification(), expiresAt: NOW.toISOString() },
    { ...verification(), verifiedAt: '2026-09-10T12:01:00.000Z' },
    { ...verification(), expiresAt: '2026-09-10T13:00:00.000Z' },
    { ...verification(), expiresAt: '2026-02-30T12:00:00.000Z' },
  ]
  for (const proof of invalid) {
    const { service, data } = fixture(); data.mfa = proof as MfaVerification
    await assert.rejects(service.authorizeOrganization(actor, 'org-a'), rejects('mfa_required'))
  }
})

test('scope version changes on grant, membership or property status changes; old preview confers no future authority', async () => {
  const { service, data } = fixture()
  const before = await service.authorizeOrganization(actor, 'org-a')
  data.authority.properties[0]!.status = 'inactive'
  data.authority.properties[0]!.permissionVersion++
  const after = await service.authorizeOrganization(actor, 'org-a')
  assert.notEqual(before.permissionVersion, after.permissionVersion)
  assert.deepEqual(after.propertyIds, ['property-b'])
  data.authority.membership.status = 'revoked'
  await assert.rejects(service.prepareInvitation(actor, inviteInput()), rejects('forbidden'))
})

test('property-limited owner delegates only active explicit grants and cannot request organization-wide access', () => {
  const a = authority(); a.membership.access = 'properties'
  a.grants = [{ membershipId: a.membership.id, organizationId: 'org-a', propertyId: 'property-a', status: 'active', permissionVersion: 1 }]
  assert.deepEqual(evaluateOrganizationAuthority(a, actor).propertyIds, ['property-a'])
  assert.deepEqual(evaluateInvitationCreation(a, actor, inviteInput()).propertyIds, ['property-a'])
  for (const input of [{ ...inviteInput(), propertyIds: ['property-b'] }, { ...inviteInput(), propertyIds: ['unknown-property'] },
    { ...inviteInput(), access: 'organization' as const, propertyIds: [] }]) {
    assert.throws(() => evaluateInvitationCreation(a, actor, input), rejects('forbidden'))
  }
  a.grants[0]!.status = 'revoked'
  assert.throws(() => evaluateInvitationCreation(a, actor, inviteInput()), rejects('forbidden'))
})

test('cross-organization/malformed repository identities are refused, even if a requested property has the same label', () => {
  const a = authority(); a.properties[0]!.organizationId = 'org-b'
  assert.throws(() => evaluateOrganizationAuthority(a, actor), rejects('invalid_record'))
  const b = authority(); b.grants = [{ membershipId: 'other-membership', organizationId: 'org-a', propertyId: 'property-a', status: 'active', permissionVersion: 1 }]
  assert.throws(() => evaluateOrganizationAuthority(b, actor), rejects('invalid_record'))
  const c = replacement(); c.target.membership.organizationId = 'org-b'
  assert.throws(() => evaluateMemberReplacement(c, actor, replaceInput()), rejects('invalid_record'))
  assert.throws(() => evaluateInvitationCreation(authority(), actor, { ...inviteInput(), organizationId: 'org-b' }), rejects('forbidden'))
})

test('admin can manage staff/viewer but cannot invite/replace owner/admin or change itself', () => {
  const a = authority(); a.membership.role = 'admin'
  for (const role of ['owner', 'admin'] as const) {
    assert.throws(() => evaluateInvitationCreation(a, actor, { ...inviteInput(), role }), rejects('forbidden'))
    const s = replacement(); s.authority = a
    assert.throws(() => evaluateMemberReplacement(s, actor, { ...replaceInput(), role }), rejects('forbidden'))
    s.target.membership.role = role
    assert.throws(() => evaluateMemberReplacement(s, actor, replaceInput()), rejects('forbidden'))
  }
  const own = replacement(); own.authority = a; own.target = structuredClone(a)
  assert.throws(() => evaluateMemberReplacement(own, actor, { ...replaceInput(), membershipId: a.membership.id, expectedVersion: 1 }), rejects('forbidden'))
  const allowed = replacement(); allowed.authority = a
  assert.equal(evaluateMemberReplacement(allowed, actor, replaceInput()).role, 'viewer')
})

test('limited administrator cannot replace a broader existing membership even to reduce its access', () => {
  const s = replacement(); s.authority.membership.access = 'properties'
  s.authority.grants = [{ membershipId: 'member-owner', organizationId: 'org-a', propertyId: 'property-a', status: 'active', permissionVersion: 1 }]
  s.target.grants.push({ membershipId: 'member-staff', organizationId: 'org-a', propertyId: 'property-b', status: 'active', permissionVersion: 1 })
  assert.throws(() => evaluateMemberReplacement(s, actor, replaceInput()), rejects('forbidden'))
  s.target.grants = []; s.target.membership.access = 'organization'
  assert.throws(() => evaluateMemberReplacement(s, actor, replaceInput()), rejects('forbidden'))
})

test('whole replacement uses expected aggregate version and preserves global user identity', async () => {
  const { service, data } = fixture()
  const original = structuredClone(data.replacement.target.user)
  const result = await service.prepareMemberReplacement(actor, replaceInput())
  assert.equal(result.executionAuthority, false)
  assert.equal(result.value.userId, 'staff-one')
  assert.equal(result.value.expectedVersion, 3)
  assert.deepEqual(data.replacement.target.user, original)
  assert.equal('password' in result.value, false)
  assert.equal(Object.isFrozen(result.value.propertyIds), true)
  data.replacement.target.membership.permissionVersion++ // Future repository bumps this on grant changes too.
  await assert.rejects(service.prepareMemberReplacement(actor, replaceInput()), rejects('version_conflict'))
  data.replacement.target.membership.permissionVersion = Number.MAX_SAFE_INTEGER
  await assert.rejects(service.prepareMemberReplacement(actor, { ...replaceInput(), expectedVersion: Number.MAX_SAFE_INTEGER }), rejects('invalid_record'))
})

test('last active owner cannot be demoted/revoked; a deliberate self-demotion is allowed with another active owner', () => {
  const s = replacement(); s.target = structuredClone(s.authority)
  const input = { ...replaceInput(), membershipId: 'member-owner', expectedVersion: 1 }
  assert.throws(() => evaluateMemberReplacement(s, actor, input), rejects('last_owner'))
  assert.throws(() => evaluateMemberReplacement(s, actor, { ...input, role: 'owner', status: 'revoked' }), rejects('last_owner'))
  s.activeOwnerUserIds.push('owner-two')
  assert.equal(evaluateMemberReplacement(s, actor, input).role, 'viewer')
  // Re-evaluate the second concurrent owner's command after the first commits under the org lock.
  const next = replacement(); next.authority.user = user('owner-two'); next.authority.membership.userId = 'owner-two'
  next.authority.membership.id = 'member-two'; next.target = structuredClone(next.authority); next.activeOwnerUserIds = ['owner-two']
  assert.throws(() => evaluateMemberReplacement(next, { userId: 'owner-two', credentialVersion: 1 },
    { ...input, membershipId: 'member-two' }), rejects('last_owner'))
})

test('owner count snapshot must include current active owners and cannot count duplicates', () => {
  const s = replacement(); s.target = structuredClone(s.authority)
  const input = { ...replaceInput(), membershipId: 'member-owner', expectedVersion: 1 }
  for (const owners of [[], ['owner-one', 'owner-one']]) {
    s.activeOwnerUserIds = owners
    assert.throws(() => evaluateMemberReplacement(s, actor, input), rejects('invalid_record'))
  }
})

test('membership commands reject password/reset/global status fields and duplicate grants', () => {
  for (const extra of [{ newPassword: 'must-never-be-accepted' }, { userId: 'other-user' }, { userStatus: 'inactive' }, { mfaVerified: true }]) {
    assert.throws(() => evaluateMemberReplacement(replacement(), actor, { ...replaceInput(), ...extra }), rejects('invalid_input'))
  }
  assert.throws(() => evaluateMemberReplacement(replacement(), actor, { ...replaceInput(), propertyIds: ['property-a', 'property-a'] }), rejects('invalid_input'))
  assert.throws(() => evaluateInvitationCreation(authority(), actor, { ...inviteInput(), access: 'organization', propertyIds: ['property-a'] }), rejects('invalid_input'))
})

test('existing-account invitation acceptance attaches stable identity without username/profile/credential replacement', async () => {
  const { service, data } = fixture()
  const invitee = issueAuthenticatedUser(user('invitee-one'))
  const before = structuredClone(data.acceptance)
  const result = await service.prepareInvitationAcceptance(invitee, 'invitation-one')
  assert.equal(result.executionAuthority, false)
  assert.deepEqual(result.value.identity, { kind: 'existing_user', userId: invitee.userId, credentialVersion: 1 })
  assert.deepEqual(data.acceptance, before)
  assert.equal('username' in result.value.identity, false)
  data.acceptance.existingMembership = replacement().target.membership
  await assert.rejects(service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('invitation_unavailable'))
})

test('new-user acceptance needs verified enrollment, not an invented principal or an existing username owner', async () => {
  const { service, data } = fixture()
  data.recipient!.identity = { kind: 'new_user', enrollmentId: 'enrollment-one', username: 'new-person', displayName: 'New Person' }
  data.acceptance.acceptingUser = null
  const result = await service.prepareInvitationAcceptance(null, 'invitation-one')
  assert.deepEqual(result.value.identity, { kind: 'new_user', enrollmentId: 'enrollment-one', username: 'new-person', displayName: 'New Person' })
  assert.equal(JSON.stringify(result).includes('password'), false)
  assert.equal(JSON.stringify(result).includes('token'), false)
  data.acceptance.acceptingUser = user('new-person')
  await assert.rejects(service.prepareInvitationAcceptance(null, 'invitation-one'), rejects('invitation_unavailable'))
  data.acceptance.acceptingUser = null
  data.recipient!.identity = { kind: 'existing_user', userId: 'new-person', credentialVersion: 1 }
  await assert.rejects(service.prepareInvitationAcceptance(null, 'invitation-one'), rejects('unauthenticated'))
})

test('malformed trusted enrollment proof cannot turn a null or non-string username into a new identity', async () => {
  for (const username of [null, undefined, 123, [], {}, '', 'UPPERCASE', 'ab']) {
    const { service, data } = fixture()
    data.acceptance.acceptingUser = null
    data.recipient!.identity = { kind: 'new_user', enrollmentId: 'enrollment-one',
      username: username as unknown as string, displayName: 'New Person' }
    assert.throws(() => evaluateInvitationAcceptance(data.acceptance, data.recipient!), rejects('invalid_record'))
    await assert.rejects(service.prepareInvitationAcceptance(null, 'invitation-one'), rejects('invalid_record'))
    assert.equal(data.acceptance.existingMembership, null)
  }
})

test('wrong recipient/session/issuer/identity and stale invitation versions cannot prepare acceptance', async () => {
  const invitee = issueAuthenticatedUser(user('invitee-one'))
  const mutations = [
    (p: InvitationRecipientVerification) => { p.recipientEmail = 'someone-else@example.test' },
    (p: InvitationRecipientVerification) => { p.sessionId = 'different-session' },
    (p: InvitationRecipientVerification) => { p.issuer = 'different-provider' },
    (p: InvitationRecipientVerification) => { p.invitationVersion++ },
    (p: InvitationRecipientVerification) => { p.expiresAt = NOW.toISOString() },
  ]
  for (const mutate of mutations) {
    const { service, data } = fixture(); mutate(data.recipient!)
    await assert.rejects(service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('invitation_unavailable'))
  }
  const { service, data } = fixture(); data.recipient!.identity = { kind: 'existing_user', userId: 'other-user', credentialVersion: 1 }
  await assert.rejects(service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('unauthenticated'))
})

test('expired/revoked/accepted invitations and current inviter/grant revocation are not grandfathered', async () => {
  const invitee = issueAuthenticatedUser(user('invitee-one'))
  for (const state of ['revoked', 'accepted'] as const) {
    const { service, data } = fixture(); data.acceptance.invitation.state = state
    await assert.rejects(service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('invitation_unavailable'))
  }
  const expired = fixture(); expired.data.acceptance.invitation.expiresAt = NOW.toISOString()
  await assert.rejects(expired.service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('invitation_unavailable'))
  const revoked = fixture(); revoked.data.acceptance.inviter.membership.status = 'revoked'
  await assert.rejects(revoked.service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('forbidden'))
  const limited = fixture(); limited.data.acceptance.inviter.membership.access = 'properties'
  await assert.rejects(limited.service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('forbidden'))
})

test('recipient proof and invitation must remain unexpired after the awaited repository read', async () => {
  for (const kind of ['existing_user', 'new_user'] as const) {
    for (const expires of ['recipient', 'invitation'] as const) {
      let clock = new Date(NOW)
      const { service, data, repository } = fixture(() => clock)
      const expiresAt = '2026-09-10T12:00:01.000Z'
      if (expires === 'recipient') data.recipient!.expiresAt = expiresAt
      else data.acceptance.invitation.expiresAt = expiresAt
      if (kind === 'new_user') {
        data.recipient!.identity = { kind, enrollmentId: 'enrollment-one', username: 'new-person', displayName: 'New Person' }
        data.acceptance.acceptingUser = null
      }
      repository.readInvitationAcceptance = async () => {
        data.reads++
        assert.ok(clock.getTime() < Date.parse(data.recipient!.expiresAt))
        assert.ok(clock.getTime() < Date.parse(data.acceptance.invitation.expiresAt))
        await Promise.resolve()
        clock = new Date(expiresAt) // Expiry reached while the current snapshot was loading.
        return structuredClone(data.acceptance)
      }
      await assert.rejects(service.prepareInvitationAcceptance(kind === 'new_user' ? null
        : issueAuthenticatedUser(user('invitee-one')), 'invitation-one'), rejects('invitation_unavailable'))
      assert.equal(data.reads, 1)
      assert.equal(data.acceptance.invitation.state, 'pending')
    }
  }
})

test('privileged acceptance requires fresh MFA for the exact existing-user or new-enrollment session', async () => {
  const invitee = issueAuthenticatedUser(user('invitee-one'))
  const existing = fixture(); existing.data.acceptance.invitation.role = 'admin'
  await assert.rejects(existing.service.prepareInvitationAcceptance(invitee, 'invitation-one'), rejects('mfa_required'))
  existing.data.recipient!.mfa = { ...verification(invitee.userId), sessionId: 'acceptance-session' }
  assert.equal((await existing.service.prepareInvitationAcceptance(invitee, 'invitation-one')).value.role, 'admin')
  const fresh = fixture(); fresh.data.acceptance.invitation.role = 'owner'; fresh.data.acceptance.acceptingUser = null
  fresh.data.recipient!.identity = { kind: 'new_user', enrollmentId: 'enrollment-one', username: 'new-person', displayName: 'New Person' }
  fresh.data.recipient!.mfa = { ...verification(invitee.userId), sessionId: 'acceptance-session' }
  await assert.rejects(fresh.service.prepareInvitationAcceptance(null, 'invitation-one'), rejects('mfa_required'))
  fresh.data.recipient!.mfa.subjectId = 'enrollment-one'
  assert.equal((await fresh.service.prepareInvitationAcceptance(null, 'invitation-one')).value.role, 'owner')
})

test('accepting user credential rotation and inactive identity are rechecked independently of the inviter', () => {
  const s = acceptance(); s.acceptingUser!.credentialVersion++
  assert.throws(() => evaluateInvitationAcceptance(s, recipient()), rejects('unauthenticated'))
  s.acceptingUser!.credentialVersion = 1; s.acceptingUser!.status = 'inactive'
  assert.throws(() => evaluateInvitationAcceptance(s, recipient()), rejects('unauthenticated'))
})

test('provider/repository failures expose only safe unavailable error and never issue scope or write plans', async () => {
  const repository: OrganizationAdministrationRepository = {
    async readAuthority() { throw new Error('private connection diagnostic') },
    async readMemberReplacement() { throw new Error('private connection diagnostic') },
    async readInvitationAcceptance() { throw new Error('private connection diagnostic') },
  }
  const service = createOrganizationAdministrationService({ repository,
    privilegedAuthentication: { issuer: 'provider', sessionId: 'session', async verifyCurrentSession() { return null } },
    invitationAuthentication: { issuer: 'provider', sessionId: 'session', async verifyRecipient() { return null } },
  })
  await assert.rejects(service.authorizeOrganization(actor, 'org-a'), (error: unknown) => {
    assert.equal(error instanceof AdministrationError && error.code, 'administration_unavailable')
    assert.equal(String(error).includes('private connection'), false)
    return true
  })
})
