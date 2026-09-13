import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../identity.ts'
import { mintAccountFormToken } from '../account-request.ts'
import { createOrganizationManagementService, mintOrganizationFormToken, verifyOrganizationFormToken, parseMemberReplacement } from '../organization-management.ts'
import type { OrganizationManagementRepository } from '../organization-management.ts'
import type { MfaVerification } from '../administration.ts'
const now = new Date('2026-09-13T00:00:00.000Z'), secret = 'synthetic-organization-test-secret-long-enough'
const user = { id: 'synthetic-owner', username: 'synthetic-owner', displayName: 'Synthetic Owner', status: 'active' as const, credentialVersion: 1 }
const actor = issueAuthenticatedUser(user, { id: randomUUID(), expiresAt: now.getTime() + 3600_000 })
const input = { organizationId: 'org-a', membershipId: 'member-staff', expectedVersion: 1, requestId: randomUUID(),
  status: 'active' as const, role: 'staff' as const, access: 'properties' as const, propertyIds: ['prop-b', 'prop-a'] }
test('Team forms cannot be replayed in another session, identity, credential version, or security endpoint', () => {
  const token = mintOrganizationFormToken(actor, now, secret)
  assert.equal(verifyOrganizationFormToken(token, actor, now, secret), true)
  for (const other of [issueAuthenticatedUser(user, { id: randomUUID(), expiresAt: actor.sessionExpiresAt! }),
    issueAuthenticatedUser({ ...user, id: 'other' }, { id: actor.sessionId!, expiresAt: actor.sessionExpiresAt! }),
    issueAuthenticatedUser({ ...user, credentialVersion: 2 }, { id: actor.sessionId!, expiresAt: actor.sessionExpiresAt! })]) {
    assert.equal(verifyOrganizationFormToken(token, other, now, secret), false)
  }
  assert.equal(verifyOrganizationFormToken(mintAccountFormToken(actor, now, secret), actor, now, secret), false)
  assert.equal(verifyOrganizationFormToken(token, actor, new Date(now.getTime() + 3600_000), secret), false)
  const organizationToken = mintOrganizationFormToken(actor, now, secret, 'org-a')
  assert.equal(verifyOrganizationFormToken(organizationToken, actor, now, secret, 'org-a'), true)
  assert.equal(verifyOrganizationFormToken(organizationToken, actor, now, secret, 'org-b'), false)
  assert.equal(verifyOrganizationFormToken(token, actor, now, secret, 'org-a'), false)
})
test('member commands require the complete bounded manifest and canonicalize property order', () => {
  assert.deepEqual(parseMemberReplacement(input).propertyIds, ['prop-a', 'prop-b'])
  const invalid = [null, [], { ...input, targetUserId: 'other' }, { ...input, expectedVersion: 0 },
    { ...input, role: ['owner'] }, { ...input, status: ['active'] }, { ...input, access: ['properties'] },
    { ...input, propertyIds: ['prop-a', 'prop-a'] }, { ...input, access: 'organization' },
    { ...input, propertyIds: ['invalid\n'] }, { ...input, propertyIds: Array.from({ length: 1001 }, (_, i) => `p-${i}`) }]
  for (const value of invalid) assert.throws(() => parseMemberReplacement(value), { code: 'invalid_input' })
})
test('administration service resolves fresh exact-session proof before entering the repository', async () => {
  let calls = 0
  let proof: MfaVerification | null = { issuer: 'synthetic', sessionId: actor.sessionId!, verificationId: randomUUID(),
    subjectId: actor.userId, credentialVersion: 1, purpose: 'organization_administration', method: 'webauthn',
    verifiedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() }
  const repository: OrganizationManagementRepository = {
    async listOrganizations(candidate, id) { calls++; assert.equal(candidate, actor); assert.equal(id, proof?.verificationId); return [] },
    async directory() { throw new Error('unused') }, async replaceMember() { throw new Error('unused') },
  }
  const service = createOrganizationManagementService(repository, { issuer: 'synthetic', sessionId: actor.sessionId!,
    async verifyCurrentSession() { return proof } }, () => now)
  await service.listOrganizations(actor); assert.equal(calls, 1)
  const good = proof!
  for (const value of [null, { ...good, sessionId: randomUUID() }, { ...good, subjectId: 'other' },
    { ...good, credentialVersion: 2 }, { ...good, purpose: 'session_login' },
    { ...good, verifiedAt: 'invalid' }, { ...good, expiresAt: now.toISOString() },
    { ...good, expiresAt: new Date(now.getTime() + 600_001).toISOString() }]) {
    proof = value as MfaVerification | null
    await assert.rejects(service.listOrganizations(actor), { code: 'mfa_required' })
  }
  assert.equal(calls, 1)
  await assert.rejects(service.listOrganizations({ ...actor }), { code: 'unauthenticated' })
})
