import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { authenticateAccount, hashPassword, readAccountsConfig, verifyPassword } from '../accounts.ts'
import type { OpsAccount } from '../accounts.ts'
import { authorizeOps, mintAccountSession, mintSession, OPS_COOKIE, SESSION_TTL_MS, verifyAccountSession } from '../session.ts'

const NOW = new Date('2026-09-09T16:00:00Z')
const PASSWORD = 'a-test-only-account-password'
const SESSION_SECRET = 'test-session-signing-key-independent-of-password'
let account: OpsAccount
let other: OpsAccount
let changedHash: string

before(async () => {
  const passwordHash = await hashPassword(PASSWORD)
  changedHash = await hashPassword('a-different-test-only-password')
  account = { username: 'larkin', passwordHash, tenantId: 'demo-larkin', displayName: 'Larkin', assistantIds: ['assistant-larkin'] }
  other = { ...account, username: 'second', tenantId: 'second-workspace', displayName: 'Second', assistantIds: ['assistant-second'] }
})

function configured(accounts: OpsAccount[] = [account, other], overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { OPS_ACCOUNTS_JSON: JSON.stringify(accounts), OPS_SESSION_SECRET: SESSION_SECRET,
    OPS_DASHBOARD_PASSCODE: 'legacy-test-passcode', ...overrides }
}

describe('named-account provisioning and authentication', () => {
  test('salted scrypt hashes accept the password and reject a wrong password', async () => {
    assert.match(account.passwordHash, /^scrypt\$65536\$8\$1\$/)
    assert.equal(await verifyPassword(PASSWORD, account.passwordHash), true)
    assert.equal(await verifyPassword(`${PASSWORD}x`, account.passwordHash), false)
    assert.notEqual(account.passwordHash, await hashPassword(PASSWORD), 'each account receives a fresh salt')
  })

  test('malformed hashes and invalid password bounds fail safely', async () => {
    for (const bad of ['', 'plaintext', account.passwordHash.replace('65536', '1'), `${account.passwordHash}=`, 'scrypt$65536$8$1$bad$bad']) {
      assert.equal(await verifyPassword(PASSWORD, bad), false)
    }
    assert.equal(await verifyPassword('x'.repeat(257), account.passwordHash), false)
    assert.equal(await verifyPassword('', account.passwordHash), false)
    await assert.rejects(hashPassword('short'), /between 12 and 256/)
    await assert.rejects(hashPassword('x'.repeat(257)), /between 12 and 256/)
  })

  test('a normalized username authenticates only its own configured password', async () => {
    const env = configured([account, { ...other, passwordHash: changedHash }])
    assert.equal((await authenticateAccount(' LARKIN ', PASSWORD, env))?.tenantId, 'demo-larkin')
    assert.equal(await authenticateAccount('second', PASSWORD, env), null)
    assert.equal(await authenticateAccount('missing', PASSWORD, env), null)
    assert.equal(await authenticateAccount('larkin', 'wrong', env), null)
  })

  test('only absent account configuration permits legacy mode', () => {
    assert.deepEqual(readAccountsConfig({}), { mode: 'legacy' })
    for (const raw of ['', ' ', 'null', '{}', '[]', '[', '[null]']) {
      assert.deepEqual(readAccountsConfig(configured([account], { OPS_ACCOUNTS_JSON: raw })), { mode: 'invalid' })
    }
    for (const secret of ['', 'short', ' '.repeat(40)]) {
      assert.deepEqual(readAccountsConfig(configured([account], { OPS_SESSION_SECRET: secret })), { mode: 'invalid' })
    }
  })

  test('ambiguous identities, reserved tenants, unsafe IDs, and invalid hashes are rejected', () => {
    const invalid = [
      [account, account],
      [account, { ...other, assistantIds: account.assistantIds }],
      [{ ...account, tenantId: 'legacy' }],
      [{ ...account, tenantId: '../another' }],
      [{ ...account, username: 'Larkin' }],
      [{ ...account, passwordHash: PASSWORD }],
      [{ ...account, displayName: 'bad\nname' }],
      [{ ...account, assistantIds: ['bad/id'] }],
      [{ ...account, assistantIds: ['same', 'same'] }],
    ]
    for (const accounts of invalid) assert.deepEqual(readAccountsConfig(configured(accounts)), { mode: 'invalid' })
    assert.equal(readAccountsConfig(configured([account, { ...account, username: 'coworker' }])).mode, 'accounts', 'coworkers may share their tenant and assistant')
  })
})

describe('named sessions bind the identity and tenant on the server', () => {
  test('returns only the authenticated identity, even with a supplied tenant header', () => {
    const env = configured()
    const token = mintAccountSession(NOW, account, env)
    const auth = authorizeOps({ cookie: `${OPS_COOKIE}=${token}`, 'x-tenant-id': other.tenantId }, NOW, env)
    assert.deepEqual(auth, { ok: true, via: 'session', username: 'larkin', tenantId: 'demo-larkin', displayName: 'Larkin', assistantIds: ['assistant-larkin'] })
    assert.equal(JSON.stringify(auth).includes(account.passwordHash), false)
  })

  test('expires at its lifetime boundary and refuses invalid lifetimes', () => {
    const env = configured()
    const token = mintAccountSession(NOW, account, env, 60_000)
    assert.equal(verifyAccountSession(token, new Date(NOW.getTime() + 59_999), env)?.username, 'larkin')
    assert.equal(verifyAccountSession(token, new Date(NOW.getTime() + 60_000), env), null)
    for (const ttl of [0, -1, SESSION_TTL_MS + 1, Infinity, NaN]) {
      assert.throws(() => mintAccountSession(NOW, account, env, ttl), /Invalid session lifetime/)
    }
  })

  test('changing a signed tenant, username, expiry, or signature cannot grant access', () => {
    const env = configured()
    const token = mintAccountSession(NOW, account, env)
    const [, payload, signature] = token.split('.')
    const original = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    for (const mutation of [{ tenantId: other.tenantId }, { username: other.username }, { expiresAt: NOW.getTime() + 1000 }]) {
      const forged = Buffer.from(JSON.stringify({ ...original, ...mutation })).toString('base64url')
      assert.equal(verifyAccountSession(`a2.${forged}.${signature}`, NOW, env), null)
    }
    assert.equal(verifyAccountSession(`${token.slice(0, -2)}xx`, NOW, env), null)
  })

  test('rotation, removal, password reset, tenant reassignment, and assistant changes revoke sessions', () => {
    const env = configured()
    const token = mintAccountSession(NOW, account, env)
    const changes = [
      configured([other]),
      configured([account, other], { OPS_SESSION_SECRET: `${SESSION_SECRET}-rotated` }),
      configured([{ ...account, passwordHash: changedHash }, other]),
      configured([{ ...account, tenantId: 'replacement' }, other]),
      configured([{ ...account, assistantIds: ['replacement-assistant'] }, other]),
    ]
    for (const changed of changes) assert.equal(verifyAccountSession(token, NOW, changed), null)
    assert.throws(() => mintAccountSession(NOW, { ...account, tenantId: other.tenantId }, env), /not configured/)
  })

  test('unrelated account changes do not sign the operator out', () => {
    const token = mintAccountSession(NOW, account, configured())
    assert.equal(verifyAccountSession(token, NOW, configured([account, { ...other, passwordHash: changedHash }]))?.username, account.username)
  })

  test('legacy cookies and passcode headers cannot bypass named or malformed account configuration', () => {
    const legacy = mintSession(NOW, 'legacy-test-passcode')
    const headers = { cookie: `${OPS_COOKIE}=${legacy}`, 'x-ops-passcode': 'legacy-test-passcode' }
    assert.deepEqual(authorizeOps(headers, NOW, configured()), { ok: false, reason: 'unauthenticated' })
    assert.deepEqual(authorizeOps(headers, NOW, configured([account], { OPS_ACCOUNTS_JSON: '' })), { ok: false, reason: 'not_configured' })
    const token = mintAccountSession(NOW, account, configured())
    assert.deepEqual(authorizeOps({ cookie: `${OPS_COOKIE}=${token}` }, NOW, configured([account], { OPS_SESSION_SECRET: '' })), { ok: false, reason: 'not_configured' })
  })

  test('malformed sessions are rejected without throwing', () => {
    for (const token of [undefined, '', '.', 'a2.e30.bad', 'a2.%%%.' + 'x'.repeat(43), 'a2.' + 'x'.repeat(4096)]) {
      assert.equal(verifyAccountSession(token, NOW, configured()), null)
    }
  })
})
