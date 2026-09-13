import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import mfa from '../../api/mfa.ts'
import account from '../../api/account.ts'
import properties from '../../api/properties.ts'
import calendar from '../../api/calendar.ts'
import leads from '../../api/leads.ts'
import vapi from '../../api/vapi.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { SoftwareAuthenticator } from '../helpers/software-authenticator.mjs'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

const oldEnv = { ...process.env }, originalFetch = globalThis.fetch
const paths = new Map([['/api/dashboard', dashboard], ['/api/mfa', mfa], ['/api/account', account],
  ['/api/properties', properties], ['/api/calendar', calendar], ['/api/leads', leads], ['/api/vapi', vapi]])
const scopeHeaders = { 'x-atrium-organization-id': 'organization-a', 'x-atrium-property-id': 'property-a1', 'x-atrium-config-version': '1' }
let db, server, origin, password, secret, runtimes, owner, sibling, ownerDevice, ownerFactor, cursor = 0, remoteRequests = 0
const connections = [], served = [0, 0], sqlFailures = []

before(async () => {
  delete process.env.ATRIUM_SIMULATION
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  secret = randomBytes(40).toString('base64url')
  const bundle = { property: { id: 'property-a1', organizationId: 'organization-a', buildingName: 'Synthetic MFA building',
    timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings() }, inventory: [], floorplans: [], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES('organization-a','property-a1',1,'published',$1,now(),'synthetic-mfa-http',now())`, [JSON.stringify(bundle)])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  server = createServer(async (req, res) => {
    try {
      const chosen = cursor++ % 2; served[chosen]++
      req.atriumRuntime = runtimes[chosen]
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 70_000) throw new Error('Synthetic oversized request') }
      req.body = body
      req.query = Object.fromEntries(new URL(req.url, origin).searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
      await paths.get(new URL(req.url, origin).pathname)(req, res)
    } catch { res.statusCode = 500; res.end('Synthetic MFA HTTP handler failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  // Allocate the listening port before trusted configuration. The Host header is
  // never used to decide RP/origin. Both independent pools serve this one origin.
  origin = `http://localhost:${server.address().port}`
  runtimes = [0, 1].map(() => {
    const app = db.createAppConnection()
    const auth = new DatabaseConnection({ ...db.auth.pool.options, password: db.auth.pool.options.password, max: 2 }, 'atrium_authenticator')
    connections.push(app, auth)
    const transaction = auth.transaction.bind(auth)
    auth.transaction = async (...args) => {
      try { return await transaction(...args) } catch (error) { sqlFailures.push({ code: error.code, routine: error.routine, table: error.table, constraint: error.constraint }); throw error }
    }
    return createDatabaseRuntime({ app, auth, sessionSecret: secret, authOrigin: origin })
  })
  globalThis.fetch = async () => { remoteRequests++; throw new Error('MFA tests must not contact an external provider') }
})
after(async () => {
  globalThis.fetch = originalFetch
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await Promise.all(connections.map(connection => connection.close()))
  if (db) await db.close()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
})
async function request(path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const response = await originalFetch(origin + path, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const text = await response.text()
  let json; try { json = JSON.parse(text) } catch { /* Real HTML response. */ }
  for (const value of [password, secret]) assert.equal(text.includes(value), false, 'Responses must not disclose credentials')
  assert.doesNotMatch(text, /password_hash|scrypt\$|postgres(?:ql)?:\/\//)
  return { status: response.status, headers: response.headers, text, json }
}
async function login(username) {
  const response = await request('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString() })
  assert.equal(response.status, 303, `password login: ${JSON.stringify(sqlFailures)}`)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return { cookie, ...JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url')) }
}
async function page(session) {
  const result = await request('/api/mfa', { cookie: session.cookie })
  assert.equal(result.status, 200, `MFA GET: ${JSON.stringify(sqlFailures)}`)
  const raw = /window\.ATRIUM_MFA=(.*?);<\/script>/.exec(result.text)?.[1]
  assert.ok(raw)
  const data = JSON.parse(raw)
  assert.equal(data.userId, session.userId); assert.equal(data.sessionId, session.sessionId)
  assert.match(result.headers.get('cache-control'), /no-store/)
  assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.doesNotMatch(raw, /credentialId|publicKey|userHandle|passwordHash|challengeHash|code_hash/)
  return { ...session, ...data }
}
async function action(current, name, fields, overrides = {}) {
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-atrium-account-action': name, 'x-atrium-user-id': current.userId, 'x-atrium-session-id': current.sessionId,
    'x-atrium-csrf': current.formToken, ...overrides }
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key]
  return request('/api/mfa', { cookie: current.cookie, method: 'POST', headers, body: { action: name, ...fields } })
}
async function ok(current, name, fields) {
  const response = await action(current, name, fields)
  assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.json)} / ${JSON.stringify(sqlFailures)}`)
  assert.equal(response.json.ok, true); assert.equal(response.json.userId, current.userId); assert.equal(response.json.sessionId, current.sessionId)
  return response.json
}
async function reauthenticate(current) { return (await ok(current, 'password', { password })).reauthenticationId }
async function enroll(current, { reauthenticationId, recoveryGrantId = null, device = new SoftwareAuthenticator() } = {}) {
  reauthenticationId ??= await reauthenticate(current)
  const options = await ok(current, 'registration-options', { label: 'Synthetic HTTP passkey', reauthenticationId, recoveryGrantId })
  assert.equal(options.optionsJSON.rp.id, 'localhost'); assert.equal(options.optionsJSON.authenticatorSelection.userVerification, 'required')
  const response = device.registrationResponse({ origin, rpId: 'localhost', challenge: options.optionsJSON.challenge })
  const saved = await ok(current, 'registration-finish', { challengeId: options.challengeId, response })
  assert.equal(saved.receipt.outcome, 'factor_pending'); assert.equal(saved.receipt.assurance, null)
  return { device, factorId: saved.receipt.factorId, options, saved, userHandle: options.optionsJSON.user.id }
}
async function assertion(current, device, factorId, purpose = 'session_login', override = {}) {
  const options = await ok(current, 'authentication-options', { purpose, factorId })
  assert.equal(options.optionsJSON.rpId, 'localhost'); assert.equal(options.optionsJSON.userVerification, 'required')
  assert.deepEqual(options.optionsJSON.allowCredentials.map(item => item.id), [device.credentialId])
  const response = device.authenticationResponse({ origin, rpId: 'localhost', challenge: options.optionsJSON.challenge, ...override })
  return { options, response, result: await action(current, 'authentication-finish', { challengeId: options.challengeId, response }) }
}
async function signed(current, device, factorId, purpose = 'session_login') {
  const result = await assertion(current, device, factorId, purpose)
  assert.equal(result.result.status, 200, `${purpose}: ${JSON.stringify(result.result.json)} / ${JSON.stringify(sqlFailures)}`)
  assert.equal(result.result.json.receipt.outcome, 'verified')
  assert.equal(result.result.json.receipt.assurance.purpose, purpose)
  return result
}
async function principal(session, runtime = runtimes[0]) { return runtime.authenticate({ cookie: session.cookie }, new Date()) }
async function proof(session) {
  const actor = await principal(session)
  assert.ok(actor)
  return runtimes[1].mfa.administrationAuthentication(actor).verifyCurrentSession(actor)
}
async function protectedRefusal(session) {
  const dashboard = await request('/api/dashboard', { cookie: session.cookie })
  assert.equal(dashboard.status, 303); assert.equal(dashboard.headers.get('location'), '/api/mfa')
  for (const path of ['/api/properties', '/api/calendar', '/api/leads', '/api/vapi']) {
    const response = await request(path, { cookie: session.cookie, headers: scopeHeaders })
    assert.equal(response.status, 403, `${path} refuses a pending MFA session`)
    assert.equal(response.json.code, 'mfa_required')
  }
}

test('HTTP password→pending enrollment→signed assertion establishes only the exact session; admin needs separate proof', async () => {
  owner = await page(await login('owner-a')); sibling = await page(await login('owner-a'))
  assert.equal(owner.state.required, true); assert.equal(owner.state.everEnabled, false)
  await protectedRefusal(owner)
  assert.equal(await proof(owner), null)
  const enrolled = await enroll(owner); ownerDevice = enrolled.device; ownerFactor = enrolled.factorId
  assert.equal(enrolled.saved.state.sessionVerified, false)
  await protectedRefusal(owner)
  const pendingInSibling = await action(sibling, 'authentication-options', { purpose: 'session_login', factorId: ownerFactor })
  assert.ok(pendingInSibling.status >= 400, 'Pending key cannot be activated from another session')
  await signed(owner, ownerDevice, ownerFactor)
  assert.equal((await page(owner)).state.sessionVerified, true)
  assert.equal((await request('/api/calendar?from=2032-06-01&to=2032-06-01', { cookie: owner.cookie, headers: scopeHeaders })).status, 200)
  assert.equal(await proof(owner), null)
  await protectedRefusal(sibling)
  const step = await signed(owner, ownerDevice, ownerFactor, 'organization_administration')
  const real = await proof(owner)
  assert.equal(real.subjectId, owner.userId); assert.equal(real.sessionId, owner.sessionId)
  assert.equal(real.purpose, 'organization_administration')
  assert.ok(Date.parse(real.expiresAt) - Date.parse(real.verifiedAt) <= 600000)
  assert.equal(await proof(sibling), null)
  const duplicate = await action(owner, 'authentication-finish', { challengeId: step.options.challengeId, response: step.response })
  assert.equal(duplicate.status, 409, 'Completed challenge is not a reusable verification API')
  assert.ok(served.every(count => count > 0), 'Each request crosses independent runtime pools')
})

test('unenrolled viewer remains password-only; after enrollment a new session requires an assertion', async () => {
  const viewer = await page(await login('viewer-a'))
  assert.equal(viewer.state.required, false)
  assert.equal((await request('/api/calendar?from=2032-06-01&to=2032-06-01', { cookie: viewer.cookie, headers: scopeHeaders })).status, 200)
  const enrolled = await enroll(viewer)
  await signed(viewer, enrolled.device, enrolled.factorId)
  assert.equal((await page(viewer)).state.required, true)
  const fresh = await page(await login('viewer-a'))
  await protectedRefusal(fresh)
  await signed(fresh, enrolled.device, enrolled.factorId)
  assert.equal((await request('/api/properties', { cookie: fresh.cookie })).status, 200)
})

test('HTTP CSRF, origin and target boundaries refuse before creating challenges or password reservations', async () => {
  const current = await page(await login('owner-b')), before = (await db.admin.query("SELECT count(*)::int n FROM atrium.mfa_password_checks WHERE user_id='owner-b'")).rows[0].n
  for (const headers of [{ origin: 'https://attacker.test' }, { origin: 'http://localhost:1' },
    { 'x-atrium-csrf': null }, { 'x-atrium-csrf': owner.formToken }, { 'x-atrium-user-id': owner.userId },
    { 'x-atrium-session-id': owner.sessionId }, { 'content-type': 'text/plain' }, { 'x-atrium-account-action': 'registration-options' }]) {
    const response = await action(current, 'password', { password }, headers)
    assert.ok([400, 403, 409].includes(response.status))
  }
  for (const target of [{ userId: owner.userId }, { organizationId: 'organization-a' }, { role: 'owner' }]) {
    assert.equal((await action(current, 'password', { password, ...target })).status, 400)
  }
  assert.equal((await db.admin.query("SELECT count(*)::int n FROM atrium.mfa_password_checks WHERE user_id='owner-b'")).rows[0].n, before)
  const wrong = await action(current, 'password', { password: 'Definitely not the current password' })
  assert.equal(wrong.status, 400); assert.equal(wrong.json.code, 'incorrect_password')
  assert.equal((await page(current)).state.factors.length, 0)
  const anonymous = await request('/api/mfa')
  assert.equal(anonymous.status, 303); assert.equal(anonymous.headers.get('location'), '/api/dashboard?reauthenticate=1')
})

test('real cryptographic failures consume the attempt and cross-account credentials never establish assurance', async () => {
  const current = await page(await login('staff-a')), enrolled = await enroll(current)
  const wrong = await assertion(current, enrolled.device, enrolled.factorId, 'session_login', { origin: 'https://attacker.test' })
  assert.equal(wrong.result.status, 400); assert.equal(wrong.result.json.code, 'verification_failed')
  const validSameChallenge = enrolled.device.authenticationResponse({ origin, rpId: 'localhost', challenge: wrong.options.optionsJSON.challenge })
  assert.equal((await action(current, 'authentication-finish', { challengeId: wrong.options.challengeId, response: validSameChallenge })).status, 409)
  assert.equal((await page(current)).state.sessionVerified, false)
  await signed(current, enrolled.device, enrolled.factorId)
  const noUv = await assertion(current, enrolled.device, enrolled.factorId, 'organization_administration', { uv: false })
  assert.equal(noUv.result.status, 400); assert.equal(await proof(current), null)
  const foreignOptions = await ok(current, 'authentication-options', { purpose: 'organization_administration', factorId: enrolled.factorId })
  const foreign = await action(current, 'authentication-finish', { challengeId: foreignOptions.challengeId,
    response: ownerDevice.authenticationResponse({ origin, rpId: 'localhost', challenge: foreignOptions.optionsJSON.challenge }) })
  // The assertion credential identity is a different user's even though the body is well formed and signed.
  assert.equal(foreign.status, 400)
  assert.equal(await proof(current), null)
})

test('backup addition/removal requires existing-factor proof and cannot remove the last active passkey', async () => {
  owner = await page(owner)
  const unverifiedReauth = await reauthenticate(owner)
  const refused = await action(owner, 'registration-options', { label: 'Unverified addition',
    reauthenticationId: unverifiedReauth, recoveryGrantId: null })
  assert.equal(refused.status, 403); assert.equal(refused.json.code, 'mfa_required')
  await signed(owner, ownerDevice, ownerFactor, 'manage_factors')
  const backup = await enroll(owner)
  await signed(owner, backup.device, backup.factorId)
  assert.equal(await proof(owner), null, 'Changing factor state invalidates prior administrator proof')
  owner = await page(owner)
  await signed(owner, ownerDevice, ownerFactor, 'manage_factors')
  const reauth = await reauthenticate(owner)
  const removed = await ok(owner, 'remove-factor', { factorId: backup.factorId, requestId: randomUUID(),
    expectedSecurityVersion: owner.state.securityVersion, reauthenticationId: reauth })
  assert.deepEqual(removed.state.factors.map(factor => factor.id), [ownerFactor])
  const unknown = await action(owner, 'authentication-options', { factorId: backup.factorId, purpose: 'session_login' })
  assert.equal(unknown.status, 400)
  owner = await page(owner)
  await signed(owner, ownerDevice, ownerFactor, 'manage_factors')
  const last = await action(owner, 'remove-factor', { factorId: ownerFactor, requestId: randomUUID(),
    expectedSecurityVersion: owner.state.securityVersion, reauthenticationId: await reauthenticate(owner) })
  assert.equal(last.status, 409); assert.equal(last.json.code, 'last_factor')
  assert.deepEqual((await page(owner)).state.factors.map(factor => factor.id), [ownerFactor])
})

test('recovery code grants only replacement enrollment; signed replacement revokes old factors and sibling sessions', async () => {
  owner = await page(owner)
  await signed(owner, ownerDevice, ownerFactor, 'manage_factors')
  const reauth = await reauthenticate(owner)
  const generated = await ok(owner, 'rotate-recovery', { requestId: randomUUID(), expectedSecurityVersion: owner.state.securityVersion, reauthenticationId: reauth })
  assert.equal(generated.codes.length, 10)
  const current = await page(await login('owner-a')), recoveryReauth = await reauthenticate(current)
  const redeemed = await ok(current, 'recover', { code: generated.codes[0], requestId: randomUUID(), expectedSecurityVersion: current.state.securityVersion, reauthenticationId: recoveryReauth })
  assert.equal(redeemed.state.sessionVerified, false); assert.equal(redeemed.state.administratorVerified, false)
  assert.equal(await proof(current), null)
  assert.ok(await principal(owner), 'Recovery code alone does not revoke other sessions')
  const replacement = await enroll(current, { reauthenticationId: recoveryReauth, recoveryGrantId: redeemed.recoveryGrantId })
  assert.equal(replacement.saved.state.sessionVerified, false)
  assert.ok(await principal(owner), 'Pending replacement does not claim completed recovery')
  await signed(current, replacement.device, replacement.factorId)
  assert.equal(await principal(owner), null); assert.equal(await principal(sibling), null)
  const state = await page(current)
  assert.deepEqual(state.state.factors.map(factor => factor.id), [replacement.factorId])
  assert.equal(state.state.recoveryRemaining, 0)
  assert.equal(await proof(current), null)
  const actor = await principal(current)
  const adapter = runtimes[0].mfa.administrationAuthentication(actor)
  await signed(current, replacement.device, replacement.factorId, 'organization_administration')
  assert.ok(await adapter.verifyCurrentSession(actor))
  await runtimes[1].sessions.revoke(actor, actor.sessionId)
  await assert.rejects(adapter.verifyCurrentSession(actor), error => ['unauthenticated', 'mfa_unavailable'].includes(error.code))
  assert.equal((await request('/api/mfa', { cookie: current.cookie })).status, 303)
  const persisted = JSON.stringify((await db.admin.query('SELECT row_to_json(e) FROM atrium.mfa_events e')).rows)
  for (const code of generated.codes) assert.equal(persisted.includes(code), false)
  assert.equal(remoteRequests, 0)
})
