import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import account from '../../api/account.ts'
import dashboard from '../../api/dashboard.ts'
import properties from '../../api/properties.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

const ENV_KEYS = ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL',
  'ATRIUM_SIMULATION', 'OPS_SESSION_SECRET', 'OPS_DASHBOARD_PASSCODE', 'OPS_ACCOUNTS_JSON']
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const unsafeLabel = '</script><img src=x onerror=alert(1)> & account'
let db, runtime, server, origin, credentials, initialHash
let passwordChanges = 0, propertyTransactions = 0
const databaseFailures = []

before(async () => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  process.env.OPS_SESSION_SECRET = randomBytes(36).toString('base64url')
  db = await createFoundationTestDatabase()
  credentials = await seedFoundationTestDatabase(db.admin)
  initialHash = (await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
  for (const id of ['no-memberships', 'zero-grants', 'invalid-inputs', 'revoked-user']) {
    await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')", [id])
    await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [id, initialHash])
  }
  await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES('member-zero-grants','zero-grants','organization-a','staff','properties','active')")
  await db.admin.query('UPDATE atrium.users SET display_name=$1 WHERE id=$2', [unsafeLabel, 'no-memberships'])
  runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app: db.app, auth: db.auth, sessionSecret: process.env.OPS_SESSION_SECRET })
  // Count calls while retaining the complete production service, database and scrypt path.
  const realChanges = runtime.passwordChanges
  runtime.passwordChanges = { async changeOwnPassword(...args) {
    passwordChanges++
    return realChanges.changeOwnPassword(...args)
  } }
  const authTransaction = db.auth.transaction.bind(db.auth)
  db.auth.transaction = async (...args) => {
    try { return await authTransaction(...args) }
    catch (error) {
      // SQL state and object names aid triage without logging queries, hashes or parameters.
      databaseFailures.push({ code: error.code, routine: error.routine, table: error.table, constraint: error.constraint })
      throw error
    }
  }
  const appTransaction = db.app.transaction.bind(db.app)
  db.app.transaction = (...args) => { propertyTransactions++; return appTransaction(...args) }
  server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 16_384) throw new Error('Test request too large') }
      req.body = body
      res.status = code => { res.statusCode = code; return res }
      res.send = body => { res.end(body); return res }
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
      const path = new URL(req.url, 'http://localhost').pathname
      const handler = path === '/api/account' ? account : path === '/api/properties' ? properties : dashboard
      await handler(req, res)
    } catch { res.statusCode = 500; res.end('Synthetic account test server failed') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  if (db) await db.close()
  for (const key of ENV_KEYS) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key]
})

async function request(path, { cookie, method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body }) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}
async function login(username, password = credentials.password) {
  const result = await request('/api/dashboard', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString() })
  return { ...result, cookie: result.headers.get('set-cookie')?.split(';')[0] }
}
async function signedIn(username) {
  const result = await login(username)
  assert.equal(result.status, 303)
  assert.ok(result.cookie)
  return result.cookie
}
function formToken(text) {
  const token = /\bdata-form-token="([A-Za-z0-9_.-]+)"/.exec(text)?.[1]
  assert.ok(token, 'the real GET account form supplies a signed token')
  return token
}
async function form(username, cookie) {
  cookie ??= await signedIn(username)
  const page = await request('/api/account', { cookie })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes(`data-user-id="${username}"`))
  const sessionId = JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[1], 'base64url').toString('utf8')).sessionId
  assert.ok(page.text.includes(`data-session-id="${sessionId}"`))
  return { cookie, page, token: formToken(page.text), sessionId }
}
function changeHeaders(username, token, sessionId) {
  return { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-atrium-account-action': 'change-password', 'x-atrium-user-id': username, 'x-atrium-csrf': token,
    ...(sessionId ? { 'x-atrium-session-id': sessionId } : {}) }
}
function changeBody(currentPassword = credentials.password, newPassword = 'Synthetic replacement phrase 2026!') {
  return { action: 'change-password', currentPassword, newPassword }
}
async function postChange(username, currentForm, body = changeBody(), headers = {}) {
  return request('/api/account', { method: 'POST', cookie: currentForm.cookie,
    headers: { ...changeHeaders(username, currentForm.token, currentForm.sessionId), ...headers }, body: JSON.stringify(body) })
}
async function credentialState() {
  return (await db.admin.query(`SELECT u.id,u.credential_version,c.password_hash
    FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id ORDER BY u.id`)).rows
}
async function securityState() {
  const attempts = await db.admin.query('SELECT id,user_id,credential_version,reserved_at,consumed_at FROM atrium.password_change_attempts ORDER BY id')
  const events = await db.admin.query('SELECT id,user_id,operation,prior_credential_version,credential_version FROM atrium.account_security_events ORDER BY id')
  return { attempts: attempts.rows, events: events.rows }
}
function noSecrets(response, extra = []) {
  for (const secret of [initialHash, credentials.password, process.env.OPS_SESSION_SECRET, ...extra]) {
    assert.equal(response.text.includes(secret), false, 'response must not contain a credential or submitted password')
  }
  assert.doesNotMatch(response.text, /scrypt\$|postgres(?:ql)?:\/\/|password_hash|ATRIUM_AUTH_DATABASE_URL/)
}

test('account GET is identity-only with no property grants or configuration and safely renders its owner', async () => {
  const beforeApp = propertyTransactions
  for (const username of ['no-memberships', 'zero-grants']) {
    const currentForm = await form(username)
    const page = currentForm.page
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(page.headers.get('cache-control'), /no-store/)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.doesNotMatch(page.text, /window\.ATRIUM_PROPERTY|organization-b|synthetic-assistant-a/)
    noSecrets(page)
    if (username === 'no-memberships') {
      assert.equal(page.text.includes(unsafeLabel), false)
      assert.match(page.text, /&lt;\/script&gt;&lt;img/)
    }
    // Account settings remain readable before MFA. Verify the staff session here
    // so the following assertion still tests absent property grants, not step-up.
    await verifyMfaCookie(runtime, currentForm.cookie, credentials.password)
    const picker = await request('/api/dashboard', { cookie: currentForm.cookie })
    assert.equal(picker.status, 403)
    assert.match(picker.text, /does not have access to an active property/)
    assert.match(picker.text, /href="\/api\/account"/)
    const scopedHeaders = await request('/api/account?organizationId=organization-b&propertyId=property-b1&userId=owner-b', {
      cookie: currentForm.cookie, headers: { 'x-atrium-organization-id': 'organization-b', 'x-atrium-property-id': 'property-b1' } })
    assert.equal(scopedHeaders.status, 200)
    assert.ok(scopedHeaders.text.includes(`data-user-id="${username}"`))
    assert.doesNotMatch(scopedHeaders.text, /data-user-id="owner-b"/)
  }
  assert.equal(propertyTransactions, beforeApp, 'identity management must not query the property app role')
})

test('unauthenticated and revoked sessions cannot open or submit the account form', async () => {
  const beforeChanges = passwordChanges
  const noSession = await request('/api/account')
  assert.equal(noSession.status, 303)
  assert.equal(noSession.headers.get('location'), '/api/dashboard?reauthenticate=1')
  const noSessionPost = await request('/api/account', { method: 'POST', headers: changeHeaders('owner-a', 'invalid'), body: JSON.stringify(changeBody()) })
  assert.equal(noSessionPost.status, 401)
  const currentForm = await form('revoked-user')
  await db.admin.query("UPDATE atrium.users SET status='inactive' WHERE id='revoked-user'")
  assert.equal((await request('/api/account', { cookie: currentForm.cookie })).status, 303)
  const revoked = await postChange('revoked-user', currentForm)
  assert.equal(revoked.status, 401)
  assert.equal(JSON.parse(revoked.text).code, 'unauthenticated')
  assert.equal(passwordChanges, beforeChanges)
  noSecrets(noSessionPost); noSecrets(revoked)
})

test('cross-origin, missing or invalid CSRF and changed account identity are refused before credential work', async () => {
  const username = 'invalid-inputs', currentForm = await form(username)
  const otherForm = await form('owner-b')
  const beforeState = await credentialState(), beforeSecurity = await securityState(), beforeChanges = passwordChanges
  const base = changeHeaders(username, currentForm.token, currentForm.sessionId)
  const cases = [
    ['missing origin', { origin: null }, 403],
    ['foreign origin', { origin: 'https://attacker.invalid' }, 403],
    ['origin path', { origin: `${origin}/path` }, 403],
    ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 403],
    ['missing action header', { 'x-atrium-account-action': null }, 403],
    ['wrong action header', { 'x-atrium-account-action': 'change-user' }, 403],
    ['simple form type', { 'content-type': 'application/x-www-form-urlencoded' }, 403],
    ['missing token', { 'x-atrium-csrf': null }, 403],
    ['tampered token', { 'x-atrium-csrf': `x${currentForm.token}` }, 403],
    ['non-ASCII token signature', { 'x-atrium-csrf': `${currentForm.token.split('.')[0]}.${'é'.repeat(43)}` }, 403],
    ['another account token', { 'x-atrium-csrf': otherForm.token }, 403],
    ['missing rendered identity', { 'x-atrium-user-id': null }, 409],
    ['different rendered identity', { 'x-atrium-user-id': 'owner-b' }, 409],
  ]
  for (const [label, changes, status] of cases) {
    const headers = { ...base, ...changes }
    for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key]
    const result = await request('/api/account', { method: 'POST', cookie: currentForm.cookie, headers, body: JSON.stringify(changeBody()) })
    assert.equal(result.status, status, label)
    assert.equal(result.headers.has('set-cookie'), false, label)
    noSecrets(result)
  }
  // A stale tab from user A carrying its original token cannot affect current cookie B.
  const switched = await request('/api/account', { method: 'POST', cookie: otherForm.cookie, headers: base, body: JSON.stringify(changeBody()) })
  assert.equal(switched.status, 403)
  assert.equal(passwordChanges, beforeChanges)
  assert.deepEqual(await credentialState(), beforeState)
  assert.deepEqual(await securityState(), beforeSecurity, 'invalid security context cannot reserve attempts or append events')
})

test('malformed JSON, oversized payloads and browser-selected target users cannot change any credential', async () => {
  const username = 'invalid-inputs', currentForm = await form(username)
  const beforeState = await credentialState(), beforeSecurity = await securityState(), beforeChanges = passwordChanges
  const malicious = [
    '{not-json', 'null', '[]', '"a string"',
    JSON.stringify({ ...changeBody(), userId: 'owner-b' }),
    JSON.stringify({ ...changeBody(), username: 'owner-b' }),
    JSON.stringify({ ...changeBody(), organizationId: 'organization-b' }),
    JSON.stringify({ ...changeBody(), target: { userId: 'owner-b' } }),
    JSON.stringify({ ...changeBody(), currentPassword: {} }),
    JSON.stringify({ ...changeBody(), newPassword: null }),
    JSON.stringify({ ...changeBody(), newPassword: 'X'.repeat(4100) }),
    '{"action":"change-password","currentPassword":"wrong","newPassword":"Synthetic replacement phrase","__proto__":{"userId":"owner-b"}}',
  ]
  for (const body of malicious) {
    const result = await request('/api/account', { method: 'POST', cookie: currentForm.cookie, headers: changeHeaders(username, currentForm.token, currentForm.sessionId), body })
    assert.equal(result.status, 400)
    assert.equal(JSON.parse(result.text).code, 'invalid_password')
    assert.equal(result.headers.has('set-cookie'), false)
    noSecrets(result)
  }
  // Action selection is now a shared account-command boundary, checked before
  // password payload validation; neither a missing nor switched action is admitted.
  for (const body of ['{}', JSON.stringify({ ...changeBody(), action: 'reset-password' })]) {
    const result = await request('/api/account', { method: 'POST', cookie: currentForm.cookie, headers: changeHeaders(username, currentForm.token, currentForm.sessionId), body })
    assert.equal(result.status, 400)
    assert.equal(JSON.parse(result.text).code, 'invalid_session')
    assert.equal(result.headers.has('set-cookie'), false)
    noSecrets(result)
  }
  assert.equal(passwordChanges, beforeChanges)
  assert.deepEqual(await credentialState(), beforeState)
  assert.deepEqual(await securityState(), beforeSecurity)
})

test('wrong current password and unchanged password preserve credentials and existing sessions', async () => {
  const username = 'viewer-a', currentForm = await form(username), beforeState = await credentialState()
  for (const [input, code] of [
    [changeBody('Definitely wrong current password'), 'incorrect_password'],
    [changeBody(credentials.password, credentials.password), 'password_unchanged'],
  ]) {
    const response = await postChange(username, currentForm, input)
    assert.equal(response.status, 400)
    assert.equal(JSON.parse(response.text).code, code)
    assert.equal(response.headers.has('set-cookie'), false)
    noSecrets(response, [input.currentPassword, input.newPassword])
  }
  assert.deepEqual(await credentialState(), beforeState)
  assert.equal((await request('/api/account', { cookie: currentForm.cookie })).status, 200)
  assert.equal((await login(username)).status, 303)
})

test('a grantless account can change its own password, invalidating every prior session and form', async () => {
  const username = 'no-memberships', currentForm = await form(username)
  const secondCookie = await signedIn(username)
  const otherCookie = await signedIn('owner-b')
  const beforeState = await credentialState(), beforeApp = propertyTransactions
  const newPassword = 'Synthetic grantless replacement phrase 2026!'
  const result = await postChange(username, currentForm, changeBody(credentials.password, newPassword))
  assert.equal(result.status, 200, `valid change failed: ${JSON.stringify(databaseFailures)}`)
  assert.deepEqual(JSON.parse(result.text), { status: 'password_changed', userId: username })
  assert.match(result.headers.get('set-cookie'), /^atrium_ops=;.*Max-Age=0/)
  assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  noSecrets(result, [newPassword])
  const afterState = await credentialState()
  for (const old of beforeState) {
    const changed = afterState.find(row => row.id === old.id)
    if (old.id === username) {
      assert.equal(Number(changed.credential_version), Number(old.credential_version) + 1)
      assert.notEqual(changed.password_hash, old.password_hash)
    } else assert.deepEqual(changed, old)
  }
  const security = await securityState()
  const events = security.events.filter(event => event.user_id === username)
  assert.equal(events.length, 1, 'one credential change has one durable audit event')
  assert.equal(events[0].operation, 'password.changed')
  assert.equal(Number(events[0].prior_credential_version), 1)
  assert.equal(Number(events[0].credential_version), 2)
  assert.ok(security.attempts.find(attempt => attempt.id === events[0].id && attempt.user_id === username)?.consumed_at)
  for (const cookie of [currentForm.cookie, secondCookie]) {
    assert.equal((await request('/api/account', { cookie })).status, 303)
    assert.equal((await request('/api/properties', { cookie })).status, 401)
    assert.equal((await request('/api/dashboard', { cookie })).status, 401)
    const oldSubmission = await postChange(username, { ...currentForm, cookie })
    assert.equal(oldSubmission.status, 401)
  }
  assert.equal((await login(username)).status, 401)
  const newLogin = await login(username, newPassword)
  assert.equal(newLogin.status, 303)
  assert.equal((await request('/api/account', { cookie: newLogin.cookie })).status, 200)
  // Old form tokens are rejected even when the browser already has a new valid cookie.
  const staleForm = await postChange(username, { ...currentForm, cookie: newLogin.cookie }, changeBody(newPassword, 'Another synthetic new password 2026!'))
  assert.equal(staleForm.status, 403)
  assert.equal((await request('/api/account', { cookie: otherCookie })).status, 200)
  assert.equal(propertyTransactions, beforeApp)
})

test('a lost successful response can be recovered through forced sign-in without exposing the workspace', async () => {
  const cookie = await signedIn('owner-a')
  const result = await request('/api/dashboard?reauthenticate=1', { cookie })
  assert.equal(result.status, 200)
  assert.match(result.text, /Welcome back/)
  assert.match(result.text, /name="username"/)
  assert.match(result.text, /name="password"/)
  assert.doesNotMatch(result.text, /Choose a property\.|window\.ATRIUM_PROPERTY|owner-a/)
  assert.equal(result.headers.has('set-cookie'), false, 'forced sign-in must not silently renew the old session')
  assert.match(result.headers.get('cache-control'), /no-store/)
  noSecrets(result)
})
