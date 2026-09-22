import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import account from '../../api/account.ts'
import dashboard from '../../api/dashboard.ts'
import properties from '../../api/properties.ts'
import calendar from '../../api/calendar.ts'
import leads from '../../api/leads.ts'
import vapi from '../../api/vapi.ts'
import sync from '../../api/vapi-sync.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { PostgresDocumentStore } from '../../src/database/operations.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

const keys = ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'ATRIUM_SIMULATION',
  'OPS_SESSION_SECRET', 'OPS_DASHBOARD_PASSCODE', 'OPS_ACCOUNTS_JSON', 'VERCEL']
const original = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = globalThis.fetch
const servers = [], connections = []
const handlers = new Map([['/api/account', account], ['/api/dashboard', dashboard], ['/api/properties', properties],
  ['/api/calendar', calendar], ['/api/leads', leads], ['/api/vapi', vapi], ['/api/vapi-sync', sync]])
const scopeHeaders = { 'x-atrium-organization-id': 'organization-a', 'x-atrium-property-id': 'property-a1', 'x-atrium-config-version': '1' }
let db, first, second, password, hash, secret, remoteRequests = 0

async function endpoint() {
  const app = db.createAppConnection()
  const auth = new DatabaseConnection({ ...db.auth.pool.options, password: db.auth.pool.options.password, max: 2 }, 'atrium_authenticator')
  connections.push(app, auth)
  const runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app, auth, sessionSecret: secret })
  const server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 16_384) throw new Error('Synthetic request too large') }
      req.body = body
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
      const handler = handlers.get(new URL(req.url, 'http://localhost').pathname)
      if (!handler) { res.statusCode = 404; res.end(); return }
      await handler(req, res)
    } catch { res.statusCode = 500; res.end('Synthetic session test server failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server)
  return { runtime, origin: `http://127.0.0.1:${server.address().port}` }
}

before(async () => {
  for (const key of keys) delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  secret = process.env.OPS_SESSION_SECRET = randomBytes(36).toString('base64url')
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  hash = (await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
  for (const id of ['session-list', 'session-foreign', 'session-switch', 'session-logout', 'session-self', 'session-failure', 'session-password']) {
    await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')", [id])
    await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [id, hash])
  }
  first = await endpoint(); second = await endpoint()
  globalThis.fetch = async () => { remoteRequests++; throw new Error('No remote requests are allowed in session HTTP tests') }
})
after(async () => {
  globalThis.fetch = originalFetch
  for (const server of servers) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await Promise.all(connections.map(connection => connection.close()))
  if (db) await db.close()
  for (const key of keys) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key]
})

async function request(target, path = '/api/account', { cookie, method = 'GET', headers = {}, fields, body } = {}) {
  const response = await originalFetch(`${target.origin}${path}`, { method, redirect: 'manual', headers: {
    ...(cookie ? { cookie } : {}), ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers,
  }, ...(fields ? { body: new URLSearchParams(fields).toString() } : body === undefined ? {} : { body }) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}
function claims(cookie) {
  const token = cookie.split('=')[1]
  assert.match(token, /^a4\./)
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}
async function login(target, username, suppliedPassword = password) {
  const result = await request(target, '/api/dashboard', { method: 'POST', fields: { username, password: suppliedPassword },
    headers: { 'user-agent': 'Mozilla/5.0 Macintosh Chrome/140.0.0.0' } })
  assert.equal(result.status, 303)
  const cookie = result.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  await verifyMfaCookie(target.runtime, cookie, suppliedPassword)
  return { cookie, ...claims(cookie) }
}
async function form(target, session) {
  const page = await request(target, '/api/account', { cookie: session.cookie })
  assert.equal(page.status, 200)
  const token = /data-form-token="([A-Za-z0-9_.-]+)"/.exec(page.text)?.[1]
  assert.ok(token)
  assert.ok(page.text.includes(`data-user-id="${session.userId}"`))
  assert.ok(page.text.includes(`data-session-id="${session.sessionId}"`))
  return { ...session, token, page }
}
function headers(target, current, action) {
  return { origin: target.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-atrium-account-action': action, 'x-atrium-user-id': current.userId,
    'x-atrium-session-id': current.sessionId, 'x-atrium-csrf': current.token }
}
async function mutate(target, current, payload, overrides = {}) {
  const values = { ...headers(target, current, payload.action), ...overrides }
  for (const key of Object.keys(values)) if (values[key] === null) delete values[key]
  return request(target, '/api/account', { method: 'POST', cookie: current.cookie, headers: values, body: JSON.stringify(payload) })
}
async function logout(target, current, overrides = {}) {
  const values = { ...headers(target, current, 'logout'), ...overrides }
  for (const key of Object.keys(values)) if (values[key] === null) delete values[key]
  return request(target, '/api/dashboard', { method: 'POST', cookie: current.cookie, headers: values, body: JSON.stringify({ action: 'logout' }) })
}
const record = async id => (await db.admin.query('SELECT * FROM atrium.user_sessions WHERE id=$1', [id])).rows[0]
function noSecrets(response) {
  for (const value of [password, hash, secret]) assert.equal(response.text.includes(value), false)
  assert.doesNotMatch(response.text, /scrypt\$|password_hash|postgres(?:ql)?:\/\//)
}
async function refusedEverywhere(target, cookie) {
  for (const [path, method, status] of [
    ['/api/dashboard', 'GET', 401], ['/api/account', 'GET', 303], ['/api/properties', 'GET', 401],
    ['/api/calendar', 'GET', 401], ['/api/leads', 'GET', 401], ['/api/vapi', 'GET', 401], ['/api/vapi-sync', 'POST', 401],
  ]) {
    const response = await request(target, path, { cookie, method, headers: scopeHeaders })
    assert.equal(response.status, status, `${method} ${path} must reject the revoked/unregistered cookie`)
    assert.doesNotMatch(response.text, /window\.ATRIUM_PROPERTY|Synthetic private content/)
    noSecrets(response)
  }
  assert.equal(remoteRequests, 0)
}

test('separate sign-ins have registered identities, fixed expiry and only their own sessions on the account page', async () => {
  const a = await login(first, 'session-list'), b = await login(second, 'session-list')
  const foreign = await login(first, 'session-foreign')
  assert.notEqual(a.sessionId, b.sessionId)
  assert.deepEqual(Object.keys(claims(a.cookie)).sort(), ['credentialVersion', 'expiresAt', 'sessionId', 'userId'])
  const stored = await record(a.sessionId)
  assert.equal(Number(stored.expires_at_ms), a.expiresAt)
  assert.equal(Number(stored.expires_at_ms) - Number(stored.created_at_ms), 8 * 60 * 60_000)
  const current = await form(second, a)
  assert.ok(current.page.text.includes(b.sessionId)); assert.equal(current.page.text.includes(foreign.sessionId), false)
  assert.match(current.page.text, /Chrome on Mac/)
  const renewed = await request(second, '/api/dashboard', { cookie: a.cookie })
  assert.equal(renewed.status, 403, 'a grantless user still has account access')
  const renewedCookie = renewed.headers.get('set-cookie').split(';')[0]
  assert.deepEqual(claims(renewedCookie), claims(a.cookie), 'page use must not extend the registered expiry')
  const laterPrincipal = await second.runtime.authenticate({ cookie: a.cookie }, new Date(a.expiresAt))
  assert.equal(laterPrincipal, null, 'absolute expiry is enforced even when the session was just used')
  noSecrets(current.page)
})

test('revoke another own session persists across instances and invalidates already-issued property scope', async () => {
  const a = await login(first, 'owner-a'), b = await login(second, 'owner-a')
  const current = await form(first, a)
  const principal = await second.runtime.authenticate({ cookie: b.cookie }, new Date())
  const scope = await second.runtime.authorization.authorizeProperty(principal, 'property-a1', 'operate')
  assert.equal(scope.actor.sessionId, b.sessionId)
  const store = new PostgresDocumentStore(second.runtime.app, scope, { requestId: 'session-revocation-proof' })
  await store.set('session-proof', { label: 'Synthetic private content' })
  const revoked = await mutate(first, current, { action: 'revoke-session', sessionId: b.sessionId })
  assert.equal(revoked.status, 200)
  assert.equal(JSON.parse(revoked.text).currentRevoked, false)
  assert.equal(revoked.headers.get('set-cookie'), null)
  assert.notEqual((await record(b.sessionId)).revoked_at_ms, null)
  await refusedEverywhere(second, b.cookie)
  const exactRetry = await mutate(first, current, { action: 'revoke-session', sessionId: b.sessionId })
  assert.equal(exactRetry.status, 200)
  assert.deepEqual(JSON.parse(exactRetry.text).revokedIds, [], 'an owned, already revoked target permits a verified idempotent retry')
  assert.equal(JSON.parse(exactRetry.text).currentRevoked, false)
  await assert.rejects(store.get('session-proof'), { code: 'forbidden' })
  await assert.rejects(store.set('session-proof', { label: 'must not overwrite' }), { code: 'forbidden' })
  assert.deepEqual((await db.admin.query("SELECT value FROM atrium.operational_documents WHERE key='session-proof'")).rows[0].value,
    { label: 'Synthetic private content' })
  assert.equal((await request(second, '/api/account', { cookie: a.cookie })).status, 200)
})

test('foreign targets and stale forms cannot revoke or change a different account or session', async () => {
  const a = await login(first, 'session-switch'), b = await login(second, 'session-switch')
  const foreign = await login(first, 'session-foreign'), current = await form(first, a)
  const foreignTarget = await mutate(first, current, { action: 'revoke-session', sessionId: foreign.sessionId })
  assert.equal(foreignTarget.status, 400)
  assert.equal(JSON.parse(foreignTarget.text).code, 'invalid_session')
  const absentTarget = await mutate(first, current, { action: 'revoke-session', sessionId: randomUUID() })
  assert.equal(absentTarget.status, 400)
  assert.deepEqual(JSON.parse(absentTarget.text), JSON.parse(foreignTarget.text), 'unknown and foreign targets are indistinguishable')
  assert.equal((await record(foreign.sessionId)).revoked_at_ms, null)
  for (const [name, candidate, overrides] of [
    ['same-account new session', { ...current, cookie: b.cookie }, {}],
    ['another signed-in identity', { ...current, cookie: foreign.cookie }, {}],
    ['missing CSRF', current, { 'x-atrium-csrf': null }],
    ['missing session selection', current, { 'x-atrium-session-id': null }],
    ['stale session selection', current, { 'x-atrium-session-id': b.sessionId }],
    ['cross-origin form', current, { origin: 'https://attacker.invalid' }],
  ]) {
    const result = await mutate(first, candidate, { action: 'revoke-other-sessions' }, overrides)
    assert.ok([403, 409].includes(result.status), name)
    assert.equal(result.headers.get('set-cookie'), null)
  }
  const extraTarget = await mutate(first, current, { action: 'revoke-session', sessionId: b.sessionId, userId: foreign.userId })
  assert.equal(extraTarget.status, 400)
  for (const value of [a, b, foreign]) assert.equal((await record(value.sessionId)).revoked_at_ms, null)
})

test('revoke others retains only the current account session and current-session revocation clears its cookie', async () => {
  const a = await login(first, 'session-self'), b = await login(second, 'session-self'), c = await login(first, 'session-self')
  const foreign = await login(second, 'session-foreign'), current = await form(first, a)
  const result = await mutate(first, current, { action: 'revoke-other-sessions' })
  assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).currentRevoked, false)
  assert.equal(result.headers.get('set-cookie'), null)
  assert.notEqual((await record(b.sessionId)).revoked_at_ms, null)
  assert.notEqual((await record(c.sessionId)).revoked_at_ms, null)
  assert.equal((await record(a.sessionId)).revoked_at_ms, null)
  assert.equal((await record(foreign.sessionId)).revoked_at_ms, null)
  await refusedEverywhere(second, b.cookie)
  const self = await mutate(second, await form(second, a), { action: 'revoke-session', sessionId: a.sessionId })
  assert.equal(self.status, 200); assert.equal(JSON.parse(self.text).currentRevoked, true)
  assert.match(self.headers.get('set-cookie'), /Max-Age=0/)
  await refusedEverywhere(first, a.cookie)
})

test('logout is session-bound and same-origin; a copied cookie cannot be replayed after revocation', async () => {
  const a = await login(first, 'session-logout'), b = await login(second, 'session-logout')
  const current = await form(first, a)
  for (const [name, selected, overrides] of [
    ['cross origin', current, { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' }],
    ['same account with a new current session', { ...current, cookie: b.cookie }, {}],
    ['missing CSRF', current, { 'x-atrium-csrf': null }],
    ['wrong session selection', current, { 'x-atrium-session-id': b.sessionId }],
    ['missing identity', current, { 'x-atrium-user-id': null }],
  ]) {
    const refused = await logout(first, selected, overrides)
    assert.ok([403, 409].includes(refused.status), name)
    assert.equal(refused.headers.get('set-cookie'), null)
    for (const session of [a, b]) assert.equal((await record(session.sessionId)).revoked_at_ms, null)
  }
  const result = await logout(second, current)
  assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /Max-Age=0/)
  assert.notEqual((await record(a.sessionId)).revoked_at_ms, null)
  assert.equal((await record(b.sessionId)).revoked_at_ms, null)
  await refusedEverywhere(first, a.cookie)
  const retry = await logout(second, current)
  assert.equal(retry.status, 200); assert.match(retry.headers.get('set-cookie'), /Max-Age=0/)
})

test('audit failure rolls back revocation and logout cannot falsely report success or clear the cookie', async () => {
  const current = await login(first, 'session-failure'), activeForm = await form(first, current)
  await db.admin.query('REVOKE INSERT ON atrium.user_session_events FROM atrium_session_executor')
  try {
    const result = await mutate(first, activeForm, { action: 'revoke-session', sessionId: current.sessionId })
    assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null)
    const failedLogout = await logout(second, activeForm)
    assert.equal(failedLogout.status, 503); assert.equal(failedLogout.headers.get('set-cookie'), null)
    assert.equal((await record(current.sessionId)).revoked_at_ms, null)
    assert.equal((await request(second, '/api/account', { cookie: current.cookie })).status, 200)
    noSecrets(result); noSecrets(failedLogout)
  } finally { await db.admin.query('GRANT INSERT ON atrium.user_session_events TO atrium_session_executor') }
  const retry = await mutate(second, activeForm, { action: 'revoke-session', sessionId: current.sessionId })
  assert.equal(retry.status, 200)
  await refusedEverywhere(first, current.cookie)
})

test('password rotation invalidates every registered session and only a new login restores access', async () => {
  const a = await login(first, 'session-password'), b = await login(second, 'session-password')
  const foreign = await login(second, 'session-foreign'), current = await form(first, a)
  const newPassword = 'Synthetic session rotation phrase 2026!'
  const result = await mutate(first, current, { action: 'change-password', currentPassword: password, newPassword })
  assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /Max-Age=0/)
  for (const old of [a, b]) await refusedEverywhere(second, old.cookie)
  const oldPassword = await request(first, '/api/dashboard', { method: 'POST', fields: { username: a.userId, password } })
  assert.equal(oldPassword.status, 401)
  const fresh = await login(second, a.userId, newPassword)
  assert.notEqual(fresh.sessionId, a.sessionId)
  assert.equal(fresh.credentialVersion, a.credentialVersion + 1)
  const staleForm = await mutate(second, { ...current, cookie: fresh.cookie }, { action: 'revoke-other-sessions' })
  assert.ok([403, 409].includes(staleForm.status))
  assert.equal((await request(first, '/api/account', { cookie: foreign.cookie })).status, 200)
  assert.equal(result.text.includes(newPassword), false)
})

test('a correctly signed old a3 cookie has no compatibility path through any protected HTTP route', async () => {
  const payload = Buffer.from(JSON.stringify({ userId: 'owner-b', credentialVersion: 1, expiresAt: Date.now() + 3_600_000 })).toString('base64url')
  const signature = createHmac('sha256', secret).update(`atrium-database-user-session-v3|${payload}`).digest('base64url')
  await refusedEverywhere(first, `atrium_ops=a3.${payload}.${signature}`)
  assert.equal(remoteRequests, 0)
})


test('property picker and grantless page execute their actual rendered logout script over real HTTP', async () => {
  for (const [username, status] of [['owner-a', 200], ['session-list', 403]]) {
    const current = await login(first, username)
    const page = await request(first, '/api/dashboard', { cookie: current.cookie })
    assert.equal(page.status, status)
    const tag = page.text.match(/<form id="signout-form"[^>]*>/)?.[0]
    assert.ok(tag)
    const dataset = Object.fromEntries([['userId', 'user-id'], ['sessionId', 'session-id'], ['formToken', 'form-token']]
      .map(([key, attribute]) => [key, new RegExp(`data-${attribute}="([A-Za-z0-9_.-]+)"`).exec(tag)?.[1]]))
    assert.equal(dataset.userId, current.userId); assert.equal(dataset.sessionId, current.sessionId); assert.ok(dataset.formToken)
    const script = [...page.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(value => value.includes("getElementById('signout-form')"))
    assert.ok(script)
    const button = { disabled: true, textContent: 'Sign out' }, notice = { textContent: '' }, next = { hidden: true }, location = { href: '/api/dashboard' }
    let submit, sent = 0, response
    const form = { dataset, querySelector: () => button, addEventListener(name, listener) { assert.equal(name, 'submit'); submit = listener } }
    runInNewContext(script, { document: { getElementById: id => ({ 'signout-form': form, 'signout-notice': notice, 'signout-next': next })[id] },
      location, AbortController, setTimeout, clearTimeout,
      async fetch(path, options) {
        sent++
        assert.equal(path, '/api/dashboard'); assert.equal(options.method, 'POST')
        assert.equal(options.headers['content-type'], 'application/json')
        // Browser-provided Origin/Cookie complete the actual renderer's request.
        response = await originalFetch(`${second.origin}${path}`, { ...options, headers: { ...options.headers,
          origin: second.origin, 'sec-fetch-site': 'same-origin', cookie: current.cookie } })
        return response
      },
    })
    assert.equal(button.disabled, false)
    await submit({ preventDefault() {} })
    assert.equal(sent, 1); assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal(location.href, '/api/dashboard?reauthenticate=1')
    assert.equal(notice.textContent, '')
    assert.notEqual((await record(current.sessionId)).revoked_at_ms, null)
    await refusedEverywhere(first, current.cookie)
  }
})
