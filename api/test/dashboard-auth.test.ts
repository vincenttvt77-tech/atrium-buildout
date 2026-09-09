import { before, after, beforeEach, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import handler, { decorateDashboard } from '../dashboard.ts'
import { hashPassword } from '../../src/ops/accounts.ts'
import type { OpsAccount } from '../../src/ops/accounts.ts'
import { authorizeOps, mintSession, OPS_COOKIE } from '../../src/ops/session.ts'

const PASSWORD = 'local-test-only-password'
const ENV_KEYS = ['OPS_ACCOUNTS_JSON', 'OPS_SESSION_SECRET', 'OPS_DASHBOARD_PASSCODE', 'DASHBOARD_TOKEN'] as const
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
let account: OpsAccount

before(async () => {
  account = { username: 'larkin', passwordHash: await hashPassword(PASSWORD), tenantId: 'demo-larkin', displayName: 'Larkin', assistantIds: [] }
})
beforeEach(() => {
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify([account])
  process.env.OPS_SESSION_SECRET = 'dashboard-test-only-independent-session-signing-key'
  process.env.OPS_DASHBOARD_PASSCODE = 'old-shared-passcode'
  delete process.env.DASHBOARD_TOKEN
})
after(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

async function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = {
    code: 0, body: '' as string | unknown, headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this },
    send(body: string) { this.body = body; return this },
    json(body: unknown) { this.body = body; return this },
    setHeader(key: string, value: string) { this.headers[key] = value; return this },
  }
  await handler({ method, body, headers: { host: 'localhost:4300', ...headers } }, res)
  return res
}

describe('named account dashboard sign-in', () => {
  test('offers username and password fields without exposing a configured password or hash', async () => {
    const res = await request('GET')
    assert.equal(res.code, 401)
    assert.match(String(res.body), /name="username"/)
    assert.match(String(res.body), /name="password"/)
    assert.doesNotMatch(String(res.body), /name="passcode"/)
    assert.equal(String(res.body).includes(PASSWORD), false)
    assert.equal(String(res.body).includes(account.passwordHash), false)
    assert.match(res.headers['cache-control']!, /no-store/)
  })

  test('successful form sign-in issues a scoped session and serves only nonsecret identity', async () => {
    const login = await request('POST', new URLSearchParams({ username: 'LARKIN', password: PASSWORD }).toString(), { 'content-type': 'application/x-www-form-urlencoded' })
    assert.equal(login.code, 303)
    assert.equal(login.headers['location'], '/api/dashboard')
    const cookie = login.headers['set-cookie']!
    assert.match(cookie, /^atrium_ops=a2\./)
    assert.match(cookie, /HttpOnly; SameSite=Strict/)
    const auth = authorizeOps({ cookie }, new Date())
    assert.deepEqual(auth, { ok: true, via: 'session', username: account.username, tenantId: account.tenantId, displayName: account.displayName, assistantIds: [] })
    const page = await request('GET', undefined, { cookie })
    assert.equal(page.code, 200)
    assert.match(String(page.body), /window\.ATRIUM_ACCOUNT=Object\.freeze\(\{"username":"larkin","tenantId":"demo-larkin","displayName":"Larkin"\}\)/)
    assert.equal(String(page.body).includes(account.passwordHash), false)
    assert.equal(String(page.body).includes(PASSWORD), false)
    assert.match(page.headers['set-cookie']!, /^atrium_ops=a2\./, 'page access renews its named session')
  })

  test('bad credentials and malformed password values cannot sign in', async () => {
    for (const body of [{ username: account.username, password: 'wrong' }, { username: 'unknown', password: PASSWORD }, { username: account.username, password: { value: PASSWORD } }]) {
      const res = await request('POST', body)
      assert.equal(res.code, 401)
      assert.match(String(res.body), /The username or password was not right/)
      assert.equal(res.headers['set-cookie'], undefined)
      assert.equal(String(res.body).includes(PASSWORD), false)
    }
  })

  test('the old shared passcode cannot bypass account sign-in through any supported channel', async () => {
    const legacyCookie = `${OPS_COOKIE}=${mintSession(new Date(), 'old-shared-passcode')}`
    const get = await request('GET', undefined, { cookie: legacyCookie, 'x-ops-passcode': 'old-shared-passcode' })
    assert.equal(get.code, 401)
    const post = await request('POST', { passcode: 'old-shared-passcode' })
    assert.equal(post.code, 401)
    assert.equal(post.headers['set-cookie'], undefined)
  })

  test('a malformed named-account configuration stays closed even when a shared passcode exists', async () => {
    process.env.OPS_ACCOUNTS_JSON = ''
    const get = await request('GET', undefined, { 'x-ops-passcode': 'old-shared-passcode' })
    assert.equal(get.code, 503)
    assert.match(String(get.body), /Sign-in is unavailable/)
    assert.doesNotMatch(String(get.body), /name="passcode"/)
    assert.equal((await request('POST', { passcode: 'old-shared-passcode' })).code, 503)
  })

  test('legacy sign-in remains usable only when named-account configuration is absent', async () => {
    delete process.env.OPS_ACCOUNTS_JSON
    const page = await request('GET')
    assert.equal(page.code, 401)
    assert.match(String(page.body), /name="passcode"/)
    const login = await request('POST', { passcode: 'old-shared-passcode' })
    assert.equal(login.code, 303)
    const auth = authorizeOps({ cookie: login.headers['set-cookie']! }, new Date())
    assert.equal(auth.ok && auth.tenantId, 'legacy')
  })

  test('logout clears the session with matching secure attributes', async () => {
    const res = await request('POST', { action: 'logout' }, { host: 'portal.example.com', 'x-forwarded-proto': 'https' })
    assert.equal(res.code, 200)
    assert.match(res.headers['set-cookie']!, /Max-Age=0; HttpOnly; SameSite=Strict; Secure/)
  })

  test('identity decoration escapes script boundaries and excludes all secret fields', () => {
    const displayName = '</script><img src=x onerror=alert(1)>\u2028&'
    const html = decorateDashboard('<html><head></head><body></body></html>', {
      ok: true, via: 'session', username: 'larkin', tenantId: 'demo-larkin', displayName, assistantIds: ['private-assistant-routing'],
    })
    assert.equal(html.match(/<script>/g)?.length, 1)
    assert.equal(html.match(/<\/script>/g)?.length, 1)
    assert.equal(html.includes('<img'), false)
    assert.equal(html.includes('private-assistant-routing'), false)
    const value = /Object\.freeze\((.*)\);<\/script>/.exec(html)?.[1]
    assert.ok(value)
    assert.deepEqual(JSON.parse(value), { username: 'larkin', tenantId: 'demo-larkin', displayName })
  })
})
