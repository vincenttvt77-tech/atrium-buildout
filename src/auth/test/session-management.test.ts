import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../identity.ts'
import { createSessionManagementService, SessionManagementError, sessionLabel, validateSessionRecord } from '../session-management.ts'
import type { UserSessionRepository } from '../session-management.ts'
import type { User, UserSessionRecord } from '../model.ts'
import { mintUserSession, verifyUserSessionClaims, USER_SESSION_TTL_MS } from '../session.ts'

const user: User = { id: 'user-a', username: 'staff-a', displayName: 'Staff A', status: 'active', credentialVersion: 1 }
const NOW = Date.now()
const SECRET = 'synthetic session management secret for tests'
const record = (patch: Partial<UserSessionRecord> = {}): UserSessionRecord => ({ id: randomUUID(), userId: user.id,
  credentialVersion: 1, label: 'Browser session', createdAt: NOW, lastSeenAt: NOW,
  expiresAt: NOW + USER_SESSION_TTL_MS, revokedAt: null, ...patch })
const base = issueAuthenticatedUser(user)
const current = record(), managed = issueAuthenticatedUser(user, { id: current.id, expiresAt: current.expiresAt })
const fail = (code: SessionManagementError['code']) => (error: unknown) => error instanceof SessionManagementError && error.code === code
function repository(patch: Partial<UserSessionRepository> = {}): UserSessionRepository {
  return {
    async start(_principal, input) { return record({ id: input.id, label: input.label }) },
    async resolve() { return current }, async list() { return [current] },
    async revoke() { return { revokedIds: [], currentRevoked: false } }, ...patch,
  }
}
test('registration assigns a fresh unpredictable id after password identity and refuses caller-shaped principals', async () => {
  const service = createSessionManagementService(repository())
  const first = await service.start(base, { label: 'Chrome on Mac' }), second = await service.start(base, { label: 'Chrome on Mac' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(first.sessionExpiresAt, NOW + USER_SESSION_TTL_MS)
  await assert.rejects(service.start({ ...base }, { label: 'Browser' }))
  await assert.rejects(service.start(first, { label: 'Browser' }), fail('invalid_session'))
})
test('signed cookies retain the exact registered expiry through repeat minting and have no legacy fallback', () => {
  const first = mintUserSession(managed, new Date(NOW), SECRET)
  const later = mintUserSession(managed, new Date(NOW + 60_000), SECRET)
  assert.equal(first, later)
  assert.equal(verifyUserSessionClaims(first, new Date(NOW + 60_000), SECRET)?.sessionId, current.id)
  assert.equal(verifyUserSessionClaims(first, new Date(current.expiresAt), SECRET), null)
  assert.equal(verifyUserSessionClaims(first.replace(/^a4/, 'a3'), new Date(NOW), SECRET), null)
  assert.throws(() => mintUserSession(base, new Date(NOW), SECRET), /registered session/)
})
test('database clock ahead of application request does not extend or reject the registered lifetime', () => {
  const created = NOW + 5_000, row = record({ createdAt: created, lastSeenAt: created, expiresAt: created + USER_SESSION_TTL_MS })
  const principal = issueAuthenticatedUser(user, { id: row.id, expiresAt: row.expiresAt })
  assert.equal(verifyUserSessionClaims(mintUserSession(principal, new Date(NOW), SECRET), new Date(NOW), SECRET)?.expiresAt, row.expiresAt)
  assert.equal(validateSessionRecord(row).expiresAt - row.createdAt, USER_SESSION_TTL_MS)
})
test('malformed or overlong repository lifetimes and unsafe labels fail closed', () => {
  for (const patch of [{ createdAt: NaN }, { expiresAt: NOW + USER_SESSION_TTL_MS + 1 }, { lastSeenAt: current.expiresAt },
    { revokedAt: NOW - 1 }, { label: '\nsecret' }, { id: 'guessable-id' }]) {
    assert.throws(() => validateSessionRecord(record(patch)), fail('session_unavailable'))
  }
})
test('registration rejects foreign, stale, revoked and expired readback without issuing a cookie principal', async () => {
  for (const patch of [{ userId: 'user-b' }, { credentialVersion: 2 }, { revokedAt: NOW },
    { createdAt: NOW - USER_SESSION_TTL_MS - 1000, lastSeenAt: NOW - 1000, expiresAt: NOW - 1 }]) {
    const service = createSessionManagementService(repository({ async start(_principal, input) { return record({ id: input.id, ...patch }) } }))
    await assert.rejects(service.start(base, { label: 'Browser session' }), fail('session_unavailable'))
  }
})
test('session lists reject another identity, duplicates and missing current sessions', async () => {
  for (const rows of [[record({ userId: 'user-b' }), current], [current, current], [record()]]) {
    const service = createSessionManagementService(repository({ async list() { return rows } }))
    await assert.rejects(service.list(managed), error => error instanceof SessionManagementError)
  }
})
test('listing without a managed session cannot call the repository', async () => {
  let reads = 0
  const service = createSessionManagementService(repository({ async list() { reads++; return [current] } }))
  await assert.rejects(service.list(base), fail('unauthenticated'))
  assert.equal(reads, 0)
})
test('revoke-other-session responses cannot hide revoking the current session', async () => {
  const service = createSessionManagementService(repository({ async revoke() { return { revokedIds: [current.id], currentRevoked: true } } }))
  await assert.rejects(service.revoke(managed, 'others'), fail('session_unavailable'))
})
test('single-session revocation refuses unrelated readback and duplicate identifiers', async () => {
  const target = randomUUID()
  for (const ids of [[randomUUID()], [target, target]]) {
    const service = createSessionManagementService(repository({ async revoke() { return { revokedIds: ids, currentRevoked: false } } }))
    await assert.rejects(service.revoke(managed, target), fail('session_unavailable'))
  }
})
test('session infrastructure errors are sanitized and never retried automatically', async () => {
  let attempts = 0
  const service = createSessionManagementService(repository({ async revoke() { attempts++; throw new Error('postgres://private-secret') } }))
  await assert.rejects(service.revoke(managed, 'others'), error => fail('session_unavailable')(error) && !String(error).includes('private-secret'))
  assert.equal(attempts, 1)
})
test('session lists and revocation receipts are immutable', async () => {
  const service = createSessionManagementService(repository())
  const rows = await service.list(managed), result = await service.revoke(managed, 'others')
  assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0])); assert.ok(Object.isFrozen(result.revokedIds))
})
test('coarse session labels never retain arbitrary user-agent information', () => {
  assert.equal(sessionLabel('Mozilla iPhone Safari/123 private-personal-token'), 'Safari on iPhone')
  assert.equal(sessionLabel('Unknown private-personal-token'), 'Browser session')
  assert.equal(sessionLabel('x'.repeat(2049)), 'Browser session')
  assert.equal(sessionLabel(['Chrome/1']), 'Browser session')
  assert.equal(sessionLabel('Chrome/1 Edg/2 Windows'), 'Edge on Windows')
})
