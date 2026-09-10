import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoginProtection, LoginProtectionError, requestLoginAddress } from '../login-protection.ts'

const secret = 'synthetic-login-protection-secret-for-tests'
function recorder() {
  const keys: Array<{ usernameKey: string; clientKey: string }> = []
  const protection = createLoginProtection({ reserve: async value => { keys.push(value); return { allowed: true, retryAfterSeconds: 0 } } }, secret)
  return { keys, protection }
}

test('canonical usernames share a private budget without consulting account existence', async () => {
  const { keys, protection } = recorder()
  await protection.reserve('  ALICE  ', '192.0.2.10')
  await protection.reserve('alice', '192.0.2.11')
  await protection.reserve('another-user', '192.0.2.10')
  assert.equal(keys[0]!.usernameKey, keys[1]!.usernameKey)
  assert.notEqual(keys[0]!.usernameKey, keys[2]!.usernameKey)
  assert.equal(keys[0]!.clientKey, keys[2]!.clientKey)
  assert.notEqual(keys[0]!.clientKey, keys[1]!.clientKey)
  for (const value of keys) for (const digest of Object.values(value)) assert.match(digest, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(keys), /alice|192\.0\.2/i)
})

test('malformed usernames share one bounded bucket, independently of valid usernames', async () => {
  const { keys, protection } = recorder()
  for (const value of [null, undefined, [], {}, '', 'a'.repeat(65), 'a b']) await protection.reserve(value, null)
  assert.equal(new Set(keys.map(value => value.usernameKey)).size, 1)
  await protection.reserve('invalid-username', null)
  assert.notEqual(keys.at(-1)!.usernameKey, keys[0]!.usernameKey)
})

test('IPv4 and all mapped IPv6 aliases share one client budget', async () => {
  const { keys, protection } = recorder()
  for (const ip of ['192.0.2.10', '::ffff:192.0.2.10', '::ffff:c000:20a', '0:0:0:0:0:FFFF:C000:020A']) {
    await protection.reserve('alice', ip)
  }
  assert.equal(new Set(keys.map(value => value.clientKey)).size, 1)
})

test('IPv6 representation and host rotation within a /64 do not reset the client budget', async () => {
  const { keys, protection } = recorder()
  for (const ip of ['2001:db8:1234:5678::1', '2001:0DB8:1234:5678:0:0:0:1', '2001:db8:1234:5678:ffff::abcd']) {
    await protection.reserve('alice', ip)
  }
  assert.equal(new Set(keys.map(value => value.clientKey)).size, 1)
  await protection.reserve('alice', '2001:db8:1234:5679::1')
  assert.notEqual(keys.at(-1)!.clientKey, keys[0]!.clientKey)
})

test('unknown, chained, zoned and malformed address inputs share a fail-closed client bucket', async () => {
  const { keys, protection } = recorder()
  for (const ip of [null, undefined, {}, [], '', 'unknown', '192.0.2.1,192.0.2.2', '[::1]:99', 'fe80::1%lo0', 'anything']) {
    await protection.reserve('alice', ip)
  }
  assert.equal(new Set(keys.map(value => value.clientKey)).size, 1)
})

test('local/non-Vercel requests ignore spoofed proxy headers', () => {
  assert.equal(requestLoginAddress({ headers: { 'x-forwarded-for': '192.0.2.1', 'x-vercel-forwarded-for': '192.0.2.2' },
    socket: { remoteAddress: '127.0.0.1' } }, {}), '127.0.0.1')
  assert.equal(requestLoginAddress({ headers: { 'x-forwarded-for': '192.0.2.1' } }, {}), 'unknown')
})

test('Vercel requests accept only a single valid provider address, never an alternate spoofable header', () => {
  assert.equal(requestLoginAddress({ headers: { 'x-vercel-forwarded-for': '2001:db8::1' } }, { VERCEL: '1' }), '2001:db8::1')
  for (const value of [undefined, ['192.0.2.1'], '192.0.2.1, 192.0.2.2', 'fe80::1%lo0', ' 192.0.2.1 ']) {
    assert.equal(requestLoginAddress({ headers: { 'x-vercel-forwarded-for': value, 'x-forwarded-for': '192.0.2.9' },
      socket: { remoteAddress: '127.0.0.1' } }, { VERCEL: '1' }), 'unknown')
  }
})

test('a denied reservation preserves database retry timing, including clock rollback', async () => {
  const protection = createLoginProtection({ reserve: async () => ({ allowed: false, retryAfterSeconds: 960 }) }, secret)
  await assert.rejects(protection.reserve('alice', '192.0.2.1'), error => error instanceof LoginProtectionError
    && error.code === 'rate_limited' && error.retryAfterSeconds === 960)
})

test('failed and malformed reservation responses never allow password work or reveal database details', async () => {
  for (const response of [null, {}, { allowed: true, retryAfterSeconds: 1 }, { allowed: false, retryAfterSeconds: 0 },
    { allowed: 'true', retryAfterSeconds: 0 }, { allowed: true, retryAfterSeconds: '0' },
    { allowed: false, retryAfterSeconds: NaN }, { allowed: false, retryAfterSeconds: 2147483648 }]) {
    const protection = createLoginProtection({ reserve: async () => response as any }, secret)
    await assert.rejects(protection.reserve('alice', '192.0.2.1'), error => error instanceof LoginProtectionError && error.code === 'login_unavailable')
  }
  const protection = createLoginProtection({ reserve: async () => { throw new Error('private database details') } }, secret)
  await assert.rejects(protection.reserve('alice', '192.0.2.1'), error => error instanceof LoginProtectionError
    && error.code === 'login_unavailable' && !error.message.includes('private'))
})

test('deployment secret separation prevents reusable public username/address digests', async () => {
  const { keys, protection } = recorder()
  await protection.reserve('alice', '192.0.2.1')
  let otherKeys: unknown
  await createLoginProtection({ reserve: async value => { otherKeys = value; return { allowed: true, retryAfterSeconds: 0 } } }, 'different-synthetic-secret-for-tests-only')
    .reserve('alice', '192.0.2.1')
  assert.notDeepEqual(keys[0], otherKeys)
  assert.throws(() => createLoginProtection({ reserve: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, 'short'))
})
