import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../identity.ts'
import { createMfaService, assertMfaPasswordVerification, publicMfaState } from '../mfa.ts'
import { mfaConfiguration } from '../mfa-config.ts'
import { hashPassword } from '../../ops/accounts.ts'
import type { MfaRepository, MfaState, MfaPasswordReservation } from '../mfa-model.ts'

let passwordHash: string
const password = 'Synthetic passkey setup password!'
before(async () => { passwordHash = await hashPassword(password) })
function fixture(overrides: Partial<MfaRepository> = {}) {
  const principal = issueAuthenticatedUser({ id: 'synthetic-user', username: 'synthetic-user', displayName: 'Synthetic User',
    status: 'active', credentialVersion: 1 }, { id: randomUUID(), expiresAt: Date.now() + 3600000 })
  const current: MfaState = { userId: principal.userId, sessionId: principal.sessionId!, credentialVersion: 1, securityVersion: 1,
    userHandle: randomBytes(32).toString('base64url'), everEnabled: false, required: true, factors: [], assurances: [], recoveryRemaining: 0 }
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected repository command') }
  const repository: MfaRepository = { readState: async () => structuredClone(current), reservePassword: unavailable,
    completePassword: unavailable, beginCeremony: unavailable, claimCeremony: unavailable, finishCeremony: unavailable,
    rejectCeremony: unavailable, revokeFactor: unavailable, rotateRecoveryCodes: unavailable, redeemRecoveryCode: unavailable,
    currentProof: async () => null, ...overrides }
  const service = createMfaService(repository, mfaConfiguration('https://portal.atrium.example'))
  return { service, repository, principal, current }
}
test('password-only required session is refused and caller-shaped principal is not authority', async () => {
  const { service, principal } = fixture()
  await assert.rejects(service.requireLogin(principal), { code: 'mfa_required' })
  await assert.rejects(service.state({ ...principal }), { code: 'unauthenticated' })
})
test('public security projection omits identity handles and credential material', () => {
  const { current } = fixture()
  current.factors.push({ id: randomUUID(), label: 'Device', credentialId: 'credential-private-selector', publicKey: 'cose-bytes',
    counter: 0, counterRevision: 1, status: 'pending', backupEligible: false, backedUp: false, transports: [], createdAt: Date.now(), lastUsedAt: null })
  const serialized = JSON.stringify(publicMfaState(current))
  for (const secret of [current.userHandle, 'credential-private-selector', 'cose-bytes', 'counterRevision']) assert.ok(!serialized.includes(secret))
  assert.equal(publicMfaState(current).sessionVerified, false)
})
test('fresh password reservation is committed before real password verification and opaque result is required', async () => {
  const { service, repository, principal } = fixture()
  let reserved = false, completed = false
  repository.reservePassword = async (_, id) => {
    reserved = true
    return { id, userId: principal.userId, sessionId: principal.sessionId!, credentialVersion: 1, securityVersion: 1,
      passwordHash, expiresAt: Date.now() + 300000 }
  }
  repository.completePassword = async (_, verified) => {
    assert.ok(reserved); assertMfaPasswordVerification(verified)
    assert.throws(() => assertMfaPasswordVerification(structuredClone(verified)), { code: 'reauthentication_required' })
    completed = true
    return { id: verified.reservation.id, securityVersion: 1, expiresAt: Date.now() + 300000 }
  }
  await assert.rejects(service.password(principal, 'incorrect password'), { code: 'incorrect_password' })
  assert.equal(completed, false)
  assert.ok((await service.password(principal, password)).id)
  assert.ok(completed)
})
test('password reservation bound to another SID cannot issue reauthentication', async () => {
  const { service, repository, principal } = fixture()
  repository.reservePassword = async (_, id): Promise<MfaPasswordReservation> => ({ id, userId: principal.userId,
    sessionId: randomUUID(), credentialVersion: 1, securityVersion: 1, passwordHash, expiresAt: Date.now() + 300000 })
  await assert.rejects(service.password(principal, password), { code: 'mfa_unavailable' })
})
test('another user state is not accepted', async () => {
  const { service, principal, current } = fixture()
  current.userId = 'another-user'
  await assert.rejects(service.state(principal), { code: 'mfa_unavailable' })
})
test('pending credentials cannot be used for administrator verification', async () => {
  const { service, principal, current } = fixture()
  const id = randomUUID()
  current.factors.push({ id, label: 'Unfinished', credentialId: randomBytes(32).toString('base64url'), publicKey: 'unused',
    counter: 0, counterRevision: 1, status: 'pending', backupEligible: false, backedUp: false, transports: [], createdAt: Date.now(), lastUsedAt: null })
  await assert.rejects(service.authenticationOptions(principal, { purpose: 'organization_administration', factorId: id }), { code: 'invalid_input' })
})
test('state can display ten active keys plus a temporary recovery replacement, never eleven active keys', async () => {
  const { service, principal, current } = fixture()
  current.everEnabled = true
  current.factors = Array.from({ length: 11 }, (_, index) => ({ id: randomUUID(), label: `Device ${index}`,
    credentialId: randomBytes(32).toString('base64url'), publicKey: 'unused', counter: 0, counterRevision: 1,
    status: index === 10 ? 'pending' as const : 'active' as const, backupEligible: false, backedUp: false,
    transports: [], createdAt: Date.now(), lastUsedAt: null }))
  assert.equal((await service.state(principal)).factors.length, 11)
  current.factors[10]!.status = 'active'
  await assert.rejects(service.state(principal), { code: 'mfa_unavailable' })
  current.factors[10]!.status = 'pending'
  current.factors.push({ ...current.factors[10]!, id: randomUUID() })
  await assert.rejects(service.state(principal), { code: 'mfa_unavailable' })
})
test('administrator proof adapter refuses another registered session of the same account', async () => {
  const { service, principal } = fixture()
  const other = issueAuthenticatedUser({ id: principal.userId, username: principal.username, displayName: principal.displayName,
    credentialVersion: 1, status: 'active' }, { id: randomUUID(), expiresAt: principal.sessionExpiresAt! })
  const adapter = service.administrationAuthentication(principal)
  assert.equal(await adapter.verifyCurrentSession(principal), null)
  await assert.rejects(adapter.verifyCurrentSession(other), { code: 'unauthenticated' })
})
test('raw recovery codes never enter the repository; rejected persistence never returns plaintext', async () => {
  const { service, repository, principal } = fixture()
  let hashes: string[] = []
  repository.rotateRecoveryCodes = async (_, input) => {
    assert.equal(input.codes.length, 10)
    for (const code of input.codes) assert.match(code.hash, /^[a-f0-9]{64}$/)
    hashes = input.codes.map(code => code.hash)
    return { requestId: input.requestId, securityVersion: 1, count: 10 }
  }
  const result = await service.rotateRecovery(principal, { requestId: randomUUID(), expectedSecurityVersion: 1, reauthenticationId: randomUUID() })
  assert.equal(result.codes.length, 10)
  assert.equal(new Set(result.codes).size, 10)
  for (const code of result.codes) { assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/); assert.ok(!hashes.includes(code)) }
  repository.rotateRecoveryCodes = async () => { throw new Error('Synthetic storage failure') }
  await assert.rejects(service.rotateRecovery(principal, { requestId: randomUUID(), expectedSecurityVersion: 1, reauthenticationId: randomUUID() }))
})
