import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordChangeService, PasswordChangeError } from '../password-change.ts'
import type { PasswordChangeRepository, PasswordChangeReservation } from '../password-change.ts'
import { issueAuthenticatedUser } from '../identity.ts'
import type { AuthenticatedUser } from '../model.ts'
import { hashPassword } from '../../ops/accounts.ts'

let hash: string, replacement: string
before(async () => { hash = await hashPassword('synthetic old password'); replacement = await hashPassword('synthetic next password') })
const principal = issueAuthenticatedUser({ id: 'synthetic-user', username: 'synthetic-user', displayName: 'Synthetic staff', status: 'active', credentialVersion: 1 })
function fixture(options: { verified?: boolean; error?: Error; badHash?: boolean } = {}) {
  const calls: string[] = [], hashed: string[] = []
  let reserved: PasswordChangeReservation | undefined
  const repository: PasswordChangeRepository = {
    async reserve(actor, attemptId) {
      assert.equal(actor, principal); calls.push('reserve-committed')
      if (options.error) throw options.error
      reserved = { attemptId, credentialVersion: 1, passwordHash: options.badHash ? 'invalid' : hash }
      return reserved
    },
    async commit(actor, reservation, next) {
      assert.equal(actor, principal); assert.equal(reservation, reserved); assert.equal(next, replacement); calls.push('commit')
    },
  }
  const service = createPasswordChangeService(repository, {
    async verify(value, expected) { assert.equal(value, 'synthetic old password'); assert.equal(expected, hash); calls.push('verify'); return options.verified !== false },
    async hash(value) { hashed.push(value); calls.push('hash'); return replacement },
  })
  return { service, calls, hashed }
}
test('only a runtime-issued human principal can start a password attempt', async () => {
  const f = fixture()
  await assert.rejects(f.service.changeOwnPassword({ ...principal } as AuthenticatedUser,
    { currentPassword: 'synthetic old password', newPassword: 'synthetic next password' }), { code: 'unauthenticated' })
  assert.deepEqual(f.calls, [])
})
test('new password policy counts Unicode code points, bounds code units and refuses identity fields', async () => {
  for (const newPassword of ['a'.repeat(14), '😀'.repeat(14), 'a'.repeat(257), 'a'.repeat(15) + '\ud800', null]) {
    const f = fixture()
    await assert.rejects(f.service.changeOwnPassword(principal, { currentPassword: 'synthetic old password', newPassword }), { code: 'invalid_password' })
    assert.deepEqual(f.calls, [])
  }
  const f = fixture()
  await assert.rejects(f.service.changeOwnPassword(principal,
    { currentPassword: 'synthetic old password', newPassword: 'synthetic next password', userId: 'another-user' } as any), { code: 'invalid_password' })
  assert.deepEqual(f.calls, [])
})
test('valid passwords preserve spaces, Unicode and normalization exactly with no composition rule', async () => {
  for (const newPassword of [' '.repeat(15), '😀'.repeat(15), 'a'.repeat(256), '  cafe\u0301 password  ']) {
    const f = fixture()
    await f.service.changeOwnPassword(principal, { currentPassword: 'synthetic old password', newPassword })
    assert.deepEqual(f.hashed, [newPassword])
    assert.deepEqual(f.calls, ['reserve-committed', 'verify', 'hash', 'commit'])
  }
})
test('failed current-password verification consumes the reservation without hashing or writing a replacement', async () => {
  const f = fixture({ verified: false })
  await assert.rejects(f.service.changeOwnPassword(principal, { currentPassword: 'synthetic old password', newPassword: 'synthetic next password' }), { code: 'incorrect_password', status: 400 })
  assert.deepEqual(f.calls, ['reserve-committed', 'verify'])
})
test('unchanged password is rejected after current-password verification without another credential write', async () => {
  const f = fixture()
  await assert.rejects(f.service.changeOwnPassword(principal, { currentPassword: 'synthetic old password', newPassword: 'synthetic old password' }), { code: 'password_unchanged' })
  assert.deepEqual(f.calls, ['reserve-committed', 'verify'])
})
test('durable rate denial stops before scrypt and preserves its safe retry interval', async () => {
  const f = fixture({ error: new PasswordChangeError('rate_limited', 123) })
  await assert.rejects(f.service.changeOwnPassword(principal, { currentPassword: 'synthetic old password', newPassword: 'synthetic next password' }),
    { code: 'rate_limited', status: 429, retryAfterSeconds: 123 })
  assert.deepEqual(f.calls, ['reserve-committed'])
})
test('malformed stored credentials and raw database errors fail without exposing details or doing scrypt', async () => {
  for (const f of [fixture({ badHash: true }), fixture({ error: new Error('synthetic private DB details') })]) {
    await assert.rejects(f.service.changeOwnPassword(principal, { currentPassword: 'synthetic old password', newPassword: 'synthetic next password' }), error => {
      assert.ok(error instanceof PasswordChangeError); assert.equal(error.code, 'password_change_unavailable')
      assert.doesNotMatch(error.message, /private DB details/); return true
    })
    assert.deepEqual(f.calls, ['reserve-committed'])
  }
})
