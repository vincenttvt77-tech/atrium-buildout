import { TEST_AUTH_ORIGIN } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import account from '../../api/account.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

const ENV_KEYS = ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL',
  'ATRIUM_SIMULATION', 'OPS_SESSION_SECRET', 'OPS_DASHBOARD_PASSCODE', 'OPS_ACCOUNTS_JSON', 'VERCEL']
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const servers = [], connections = [], instances = []
const databaseFailures = []
let db, credentials, credentialHash, first, second

function newRuntime() {
  // Each instance has its own real pools; no process-local limiter or shared mock.
  const app = db.createAppConnection()
  // pg keeps the password non-enumerable; an object spread alone loses this
  // synthetic credential and would test connection setup instead of protection.
  const auth = new DatabaseConnection({ ...db.auth.pool.options, password: db.auth.pool.options.password, max: 2 }, 'atrium_authenticator')
  const transaction = auth.transaction.bind(auth)
  auth.transaction = async (...args) => {
    try { return await transaction(...args) }
    catch (error) {
      // State/routine only: never log parameters, hashes, addresses or credentials.
      databaseFailures.push({ name: error.name, code: error.code, routine: error.routine })
      throw error
    }
  }
  connections.push(app, auth)
  const runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app, auth, sessionSecret: process.env.OPS_SESSION_SECRET })
  const instance = { runtime, passwordChecks: 0, reservations: 0 }
  const authorization = runtime.authorization
  runtime.authorization = { ...authorization, async authenticatePassword(...args) {
    instance.passwordChecks++
    return authorization.authenticatePassword(...args)
  } }
  const protection = runtime.loginProtection
  runtime.loginProtection = { async reserve(...args) {
    instance.reservations++
    return protection.reserve(...args)
  } }
  instances.push(instance)
  return instance
}

async function endpoint(instance) {
  const server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = instance.runtime
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 16_384) throw new Error('Synthetic request too large')
      }
      req.body = body
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
      const path = new URL(req.url, 'http://localhost').pathname
      await (path === '/api/account' ? account : dashboard)(req, res)
    } catch { res.statusCode = 500; res.end('Synthetic login protection test server failed') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  return { instance, origin: `http://127.0.0.1:${server.address().port}` }
}

before(async () => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  process.env.OPS_SESSION_SECRET = randomBytes(36).toString('base64url')
  // Presence of a legacy credential must never provide a fallback in database mode.
  process.env.OPS_DASHBOARD_PASSCODE = 'Synthetic legacy fallback must not authenticate'
  db = await createFoundationTestDatabase()
  credentials = await seedFoundationTestDatabase(db.admin)
  credentialHash = (await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
  for (const id of ['normal-user', 'restart-user', 'client-user', 'outage-user', 'fresh-client-user', 'unknown-client-user']) {
    await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')", [id])
    await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [id, credentialHash])
  }
  first = await endpoint(newRuntime())
  second = await endpoint(newRuntime())
})

after(async () => {
  for (const server of servers) {
    server.close(); server.closeAllConnections(); await once(server, 'close')
  }
  await Promise.all(connections.map(connection => connection.close()))
  if (db) await db.close()
  for (const key of ENV_KEYS) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key]
})

async function request(target, { path = '/api/dashboard', method = 'GET', fields, body, cookie, headers = {} } = {}) {
  const response = await fetch(`${target.origin}${path}`, { method, redirect: 'manual',
    headers: { ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { cookie } : {}), ...headers },
    ...(fields ? { body: new URLSearchParams(fields).toString() } : body === undefined ? {} : { body }) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}
async function login(target, username, { password = credentials.password, headers = {}, ...options } = {}) {
  const response = await request(target, { method: 'POST', fields: { username, password }, headers, ...options })
  return { ...response, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
function vercel(address) {
  process.env.VERCEL = '1'
  return { 'x-vercel-forwarded-for': address }
}
function checks() { return instances.reduce((total, instance) => total + instance.passwordChecks, 0) }
function noSecrets(response) {
  for (const secret of [credentials.password, credentialHash, process.env.OPS_SESSION_SECRET, process.env.OPS_DASHBOARD_PASSCODE]) {
    assert.equal(response.text.includes(secret), false)
  }
  assert.doesNotMatch(response.text, /scrypt\$|password_hash|postgres(?:ql)?:\/\/|atrium_authenticator|reserve_login_attempt/i)
}
function limited(response) {
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('set-cookie'), null, 'a refused login cannot mint or clear a session')
  const retry = response.headers.get('retry-after')
  assert.match(retry, /^[1-9][0-9]*$/)
  assert.ok(Number(retry) <= 900, 'rolling-window retry must be bounded to fifteen minutes')
  assert.match(response.headers.get('cache-control'), /no-store/)
  noSecrets(response)
}
async function reserve(target, username, address, count) {
  for (let attempt = 0; attempt < count; attempt++) {
    await target.instance.runtime.loginProtection.reserve(username, address)
  }
}

test('ordinary known and unknown failures stay generic; a correct password still signs in', async () => {
  const headers = vercel('198.51.100.10'), beforeChecks = checks()
  const known = await login(first, 'normal-user', { password: 'Synthetic wrong password', headers })
  const unknown = await login(second, 'absent-normal-user', { password: 'Synthetic wrong password', headers })
  assert.equal(known.status, 401, JSON.stringify(databaseFailures)); assert.equal(unknown.status, 401)
  assert.equal(known.text, unknown.text)
  assert.equal(known.headers.get('set-cookie'), null)
  assert.equal(unknown.headers.get('set-cookie'), null)
  const signedIn = await login(first, 'normal-user', { headers })
  assert.equal(signedIn.status, 303); assert.ok(signedIn.cookie)
  assert.equal(checks() - beforeChecks, 3, 'admitted HTTP requests use the real password verifier')
  noSecrets(known); noSecrets(unknown); noSecrets(signedIn)
})

test('canonical account budget spans independent runtimes and successes do not reset it', async () => {
  const headers = vercel('198.51.100.20')
  const initial = await login(first, '  OWNER-A  ', { headers })
  assert.equal(initial.status, 303); assert.ok(initial.cookie)
  await reserve(first, 'Owner-A', '198.51.100.21', 9)
  await reserve(second, '  owner-a ', '198.51.100.22', 9)
  const twentieth = await login(second, 'OWNER-A', { headers: vercel('198.51.100.23') })
  assert.equal(twentieth.status, 303)
  const beforeChecks = checks()
  limited(await login(first, ' owner-a ', { headers: vercel('198.51.100.24') }))
  limited(await login(second, 'OWNER-A', { headers: vercel('198.51.100.25') }))
  assert.equal(checks(), beforeChecks, 'limited attempts must stop before credential lookup/hash work')
  const other = await login(first, 'owner-b', { headers: vercel('198.51.100.24') })
  assert.equal(other.status, 303, 'one account limit must not disable other accounts on a client below its budget')
  const active = await request(second, { path: '/api/account', cookie: initial.cookie })
  assert.equal(active.status, 200, 'existing sessions remain valid when further password attempts are limited')
  assert.match(active.text, /data-user-id="owner-a"/)
})

test('a restarted runtime retains account limits and unknown accounts expose the same refusal', async () => {
  await reserve(first, 'restart-user', '198.51.100.33', 10)
  await reserve(second, 'restart-user', '198.51.100.34', 10)
  const restarted = await endpoint(newRuntime())
  await reserve(restarted, 'absent-limited-user', '198.51.100.30', 20)
  const beforeChecks = checks()
  const known = await login(restarted, 'restart-user', { headers: vercel('198.51.100.31') })
  const unknown = await login(second, 'ABSENT-LIMITED-USER', { headers: vercel('198.51.100.32') })
  limited(known); limited(unknown)
  assert.equal(known.text, unknown.text, 'rate-limit responses must not reveal account existence')
  assert.equal(checks(), beforeChecks)
  assert.notEqual(first.instance.runtime.auth.pool, restarted.instance.runtime.auth.pool)
  assert.notEqual(second.instance.runtime.auth.pool, restarted.instance.runtime.auth.pool)
})

test('the shared local client budget ignores rotating forwarded headers and counts successful attempts', async () => {
  delete process.env.VERCEL
  for (let index = 0; index < 99; index++) {
    await first.instance.runtime.loginProtection.reserve(`local-client-fill-${index}`, '127.0.0.1')
  }
  const hundredth = await login(second, 'client-user', { headers: {
    'x-forwarded-for': '203.0.113.1', 'x-vercel-forwarded-for': '203.0.113.2', 'x-real-ip': '203.0.113.3',
  } })
  assert.equal(hundredth.status, 303); assert.ok(hundredth.cookie)
  const beforeChecks = checks()
  for (let index = 4; index < 7; index++) {
    limited(await login(index % 2 ? first : second, 'fresh-client-user', { headers: {
      'x-forwarded-for': `203.0.113.${index}`, 'x-vercel-forwarded-for': `192.0.2.${index}`, 'x-real-ip': `192.0.2.${index + 10}`,
    } }))
  }
  assert.equal(checks(), beforeChecks)
  const beforeReservations = instances.reduce((total, instance) => total + instance.reservations, 0)
  const active = await request(first, { path: '/api/account', cookie: hundredth.cookie })
  assert.equal(active.status, 200)
  const session = JSON.parse(Buffer.from(hundredth.cookie.split('.')[1], 'base64url'))
  const token = /data-form-token="([A-Za-z0-9_.-]+)"/.exec(active.text)?.[1]
  assert.ok(token)
  const logout = await request(second, { method: 'POST', cookie: hundredth.cookie, body: JSON.stringify({ action: 'logout' }),
    headers: { origin: second.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-atrium-user-id': session.userId, 'x-atrium-session-id': session.sessionId, 'x-atrium-csrf': token } })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i)
  assert.equal(instances.reduce((total, instance) => total + instance.reservations, 0), beforeReservations,
    'session reads and logout do not consume or depend on the password-attempt budget')
})

test('Vercel-controlled client identity is separate; missing and invalid addresses share a bounded bucket', async () => {
  // A new trusted upstream client is not the saturated local socket bucket.
  const success = await login(first, 'fresh-client-user', { headers: vercel('198.51.100.50') })
  assert.equal(success.status, 303)
  for (let index = 0; index < 100; index++) {
    await second.instance.runtime.loginProtection.reserve(`unknown-client-fill-${index}`, undefined)
  }
  const beforeChecks = checks()
  for (const headers of [
    { 'x-forwarded-for': '198.51.100.51' },
    { 'x-vercel-forwarded-for': 'not-an-ip', 'x-forwarded-for': '198.51.100.52' },
    { 'x-vercel-forwarded-for': '198.51.100.53,198.51.100.54' },
  ]) limited(await login(second, 'unknown-client-user', { headers }))
  assert.equal(checks(), beforeChecks, 'untrusted or malformed addresses cannot select a fresh client bucket')
})

test('login-protection SQL failure refuses even a valid password without fallback; recovery restores normal login', async () => {
  const headers = vercel('198.51.100.60'), beforeChecks = checks()
  // Break only the limiter's database capability: credential reads remain usable,
  // so a fallback to ordinary authentication would incorrectly issue a session.
  await db.admin.query('REVOKE EXECUTE ON FUNCTION atrium.reserve_login_attempt(text,text) FROM atrium_authenticator')
  try {
    const failed = await login(first, 'outage-user', { headers })
    assert.equal(failed.status, 503)
    assert.equal(failed.headers.get('set-cookie'), null)
    assert.equal(checks(), beforeChecks, 'database protection failures cannot fall back to password authentication')
    noSecrets(failed)
    const legacy = await request(second, { method: 'POST', fields: { passcode: process.env.OPS_DASHBOARD_PASSCODE }, headers })
    assert.equal(legacy.status, 503)
    assert.equal(legacy.headers.get('set-cookie'), null)
    assert.equal(checks(), beforeChecks)
    noSecrets(legacy)
  } finally { await db.admin.query('GRANT EXECUTE ON FUNCTION atrium.reserve_login_attempt(text,text) TO atrium_authenticator') }
  const recovered = await login(second, 'outage-user', { headers })
  assert.equal(recovered.status, 303); assert.ok(recovered.cookie)
  assert.equal(checks(), beforeChecks + 1)
})
