import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../identity.ts'
import { createAuthorizationService } from '../authorization.ts'
import { mintUserSession, mintResidentSession, verifyUserSessionClaims, verifyResidentSessionClaims, USER_SESSION_TTL_MS } from '../session.ts'
import { createSessionManagementService, validateSessionRecord } from '../session-management.ts'
import { mintAccountFormToken, verifyAccountFormToken } from '../account-request.ts'
import { createMfaService } from '../mfa.ts'
import { mfaConfiguration } from '../mfa-config.ts'
import type { AuthorizationRepository, User, UserSessionRecord } from '../model.ts'
import type { UserSessionRepository } from '../session-management.ts'
import type { MfaRepository } from '../mfa-model.ts'

const now = new Date(), secret = 'synthetic-audience-regression-secret-only'
const user: User = { id: 'same-person', username: 'same-person', displayName: 'Synthetic Person', status: 'active', credentialVersion: 1 }
const record = (patch: Partial<UserSessionRecord> = {}): UserSessionRecord => ({ id: randomUUID(), userId: user.id,
  audience: 'staff', credentialVersion: 1, label: 'Synthetic browser', createdAt: now.getTime(), lastSeenAt: now.getTime(),
  expiresAt: now.getTime() + USER_SESSION_TTL_MS, revokedAt: null, ...patch })
const principal = (row: UserSessionRecord) => issueAuthenticatedUser(user, { id: row.id, expiresAt: row.expiresAt }, row.audience)

test('a4 remains byte-compatible with staff cookies while resident tokens use their own signing purpose', () => {
  const staff = record(), resident = record({ audience: 'resident' })
  const payload = Buffer.from(JSON.stringify({ userId: user.id, credentialVersion: 1, sessionId: staff.id, expiresAt: staff.expiresAt })).toString('base64url')
  const legacy = `a4.${payload}.${createHmac('sha256', secret).update(`atrium-database-user-session-v4|${payload}`).digest('base64url')}`
  assert.equal(mintUserSession(principal(staff), now, secret), legacy)
  assert.equal(verifyUserSessionClaims(legacy, now, secret)?.audience, 'staff')
  const token = mintResidentSession(principal(resident), now, secret)
  assert.equal(verifyResidentSessionClaims(token, now, secret)?.audience, 'resident')
  assert.equal(verifyUserSessionClaims(token, now, secret), null)
  assert.equal(verifyResidentSessionClaims(legacy, now, secret), null)
  assert.equal(verifyUserSessionClaims(token.replace(/^r1/, 'a4'), now, secret), null)
  assert.equal(verifyResidentSessionClaims(legacy.replace(/^a4/, 'r1'), now, secret), null)
  assert.throws(() => mintUserSession(principal(resident), now, secret))
  assert.throws(() => mintResidentSession(principal(staff), now, secret))
})

test('a valid signature cannot relabel a persisted resident session as a staff session', async () => {
  const row = record({ audience: 'resident' })
  const repository = { async resolveSession() { return row }, async getUser() { return user } } as unknown as AuthorizationRepository
  const staffService = createAuthorizationService(repository), residentService = createAuthorizationService(repository, 'resident')
  // Simulate an incorrectly issued but correctly signed legacy cookie: persisted audience still wins.
  const staffShaped = issueAuthenticatedUser(user, { id: row.id, expiresAt: row.expiresAt })
  assert.equal(await staffService.authenticateSession(mintUserSession(staffShaped, now, secret), now, secret), null)
  const verified = await residentService.authenticateSession(mintResidentSession(principal(row), now, secret), now, secret)
  assert.equal(verified?.audience, 'resident')
  row.audience = 'staff'
  assert.equal(await residentService.authenticateSession(mintResidentSession(verified!, now, secret), now, secret), null)
})

test('resident principals cannot query staff property authority even when their identity has staff memberships', async () => {
  let reads = 0
  const repository = new Proxy({}, { get() { return () => { reads++; throw new Error('Staff lookup must not run') } } }) as AuthorizationRepository
  for (const service of [createAuthorizationService(repository), createAuthorizationService(repository, 'resident')]) {
    const resident = principal(record({ audience: 'resident' }))
    await assert.rejects(service.authorizeProperty(resident, 'property-one', 'read'), { code: 'forbidden' })
    await assert.rejects(service.listAuthorizedProperties(resident), { code: 'forbidden' })
  }
  assert.equal(reads, 0)
})

test('session registration checks the stored audience and never upgrades an existing resident session', async () => {
  const passwordIdentity = issueAuthenticatedUser(user, undefined, 'resident')
  let starts = 0
  const repo = { async start(_principal, input) {
    starts++; assert.equal(input.audience, 'resident')
    return record({ id: input.id, audience: 'resident' })
  } } as UserSessionRepository
  const service = createSessionManagementService(repo), resident = await service.start(passwordIdentity, { label: 'Synthetic browser' })
  assert.equal(resident.audience, 'resident')
  await assert.rejects(service.start(resident, { label: 'Another surface' }), { code: 'invalid_session' })
  assert.equal(starts, 1)
  const wrong = createSessionManagementService({ ...repo, async start(_p, input) { return record({ id: input.id, audience: 'staff' }) } })
  await assert.rejects(wrong.start(passwordIdentity, { label: 'Synthetic browser' }), { code: 'session_unavailable' })
})

test('raw session rows with missing or unknown audience are refused instead of inferring staff authority', () => {
  const { audience: _audience, ...missing } = record()
  for (const row of [missing, { ...missing, audience: null }, { ...missing, audience: 'owner' }]) {
    assert.throws(() => validateSessionRecord(row), { code: 'session_unavailable' })
  }
})

test('session lists and CSRF forms cannot cross audiences for the same identity', async () => {
  const row = record(), staff = principal(row)
  const resident = issueAuthenticatedUser(user, { id: row.id, expiresAt: row.expiresAt }, 'resident')
  const token = mintAccountFormToken(staff, now, secret), residentToken = mintAccountFormToken(resident, now, secret)
  assert.equal(verifyAccountFormToken(token, staff, now, secret), true)
  assert.equal(verifyAccountFormToken(token, resident, now, secret), false)
  assert.equal(verifyAccountFormToken(residentToken, staff, now, secret), false)
  const service = createSessionManagementService({ async list() { return [row] } } as unknown as UserSessionRepository)
  await assert.rejects(service.list(resident), { code: 'session_unavailable' })
})

test('resident MFA cannot request or expose an organization administration verifier', async () => {
  let calls = 0
  const repository = new Proxy({}, { get() { return () => { calls++; throw new Error('Administrative proof lookup must not run') } } }) as MfaRepository
  const service = createMfaService(repository, mfaConfiguration('https://atrium.test'))
  const resident = principal(record({ audience: 'resident' }))
  assert.throws(() => service.administrationAuthentication(resident), { code: 'unauthenticated' })
  await assert.rejects(service.authenticationOptions(resident, { purpose: 'organization_administration', factorId: null }), { code: 'invalid_input' })
  assert.equal(calls, 0)
})
