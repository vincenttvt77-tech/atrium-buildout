import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import properties from '../../api/properties.ts'
import calendar from '../../api/calendar.ts'
import leads from '../../api/leads.ts'
import vapi from '../../api/vapi.ts'
import account from '../../api/account.ts'
import mfa from '../../api/mfa.ts'
import organizations from '../../api/organizations.ts'
import services from '../../api/resident-services.ts'
import workflows from '../../api/workflows.ts'
import planning from '../../api/maintenance-plans.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { mintResidentSession, verifyUserSessionClaims } from '../../src/auth/session.ts'
import { OPS_COOKIE } from '../../src/ops/session.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'

const previousEnv = { ...process.env }, originalFetch = globalThis.fetch
const residentCookieName = 'atrium_resident_session'
const privateBuilding = 'Synthetic audience protected building'
const privateNote = 'Synthetic staff-only maintenance history'
const handlers = new Map([
  ['/api/dashboard', dashboard], ['/api/properties', properties], ['/api/calendar', calendar], ['/api/leads', leads],
  ['/api/vapi', vapi], ['/api/account', account], ['/api/mfa', mfa], ['/api/organizations', organizations],
  ['/api/resident-services', services], ['/api/workflows', workflows], ['/api/maintenance-plans', planning],
])
const scoped = { 'x-atrium-organization-id': 'organization-a', 'x-atrium-property-id': 'property-a1', 'x-atrium-config-version': '1' }
const staffReads = [
  ['/api/dashboard?organizationId=organization-a&propertyId=property-a1', 401],
  ['/api/properties', 401], ['/api/calendar?from=2032-06-01&to=2032-06-01', 401],
  ['/api/leads', 401], ['/api/vapi', 401], ['/api/account', 303], ['/api/mfa', 303],
  ['/api/organizations', 303], ['/api/organizations?format=json&organizationId=organization-a', 401],
  ['/api/resident-services?resource=overview', 401], ['/api/resident-services?resource=requests&state=all', 401],
  ['/api/workflows?state=all&limit=25', 401], ['/api/maintenance-plans?resource=overview', 401],
]
let db, runtime, server, origin, password, secret, staff, resident, forgedStaffCookie, caseId, serviceToken, teamToken, accountToken
let remoteRequests = 0
const serverErrors = []

before(async () => {
  for (const key of ['ATRIUM_SIMULATION', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'OPS_ACCOUNTS_JSON',
    'OPS_DASHBOARD_PASSCODE', 'DASHBOARD_TOKEN', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'VAPI_ASSISTANT_ID', 'VERCEL']) delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  secret = randomBytes(40).toString('base64url')
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  const bundle = { property: { id: 'property-a1', organizationId: 'organization-a', buildingName: privateBuilding,
    timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings() }, inventory: [], floorplans: [], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations
    (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES('organization-a','property-a1',1,'published',$1,clock_timestamp(),'synthetic-session-audience',clock_timestamp())`, [JSON.stringify(bundle)])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 70_000) throw new Error('Synthetic oversized request') }
      req.body = raw
      const url = new URL(req.url, origin)
      req.query = Object.fromEntries(url.searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = body => { res.end(body); return res }
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
      const handler = handlers.get(url.pathname)
      if (!handler) { res.statusCode = 404; res.end(); return }
      await handler(req, res)
    } catch (error) {
      serverErrors.push({ name: error.name, code: error.code })
      res.statusCode = 500; res.end('Synthetic session audience handler failed')
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: secret, authOrigin: origin })
  globalThis.fetch = async () => { remoteRequests++; throw new Error('Session audience tests cannot contact external providers') }

  const signedIn = await request('/api/dashboard', { method: 'POST', body: new URLSearchParams({ username: 'owner-a', password }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Synthetic staff browser' } })
  assert.equal(signedIn.status, 303, 'The fixture must sign in through the actual staff HTTP endpoint')
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const principal = await runtime.authenticate({ cookie }, new Date())
  assert.ok(principal)
  await verifyOrganizationSession(runtime, principal, password)
  staff = { cookie, principal }

  // Registration is an internal foundation method, not a resident enrollment or consent endpoint.
  const residentPrincipal = await runtime.signInResident('owner-a', password, '127.0.0.1', 'Synthetic resident browser')
  assert.ok(residentPrincipal)
  const token = mintResidentSession(residentPrincipal, new Date(), secret)
  resident = { token, cookie: `${residentCookieName}=${token}`, principal: residentPrincipal }
  // Valid historical a4 envelope and HMAC, deliberately referencing a real resident registry row.
  // Prefix validation cannot reject this: persisted audience must be checked too.
  const payload = Buffer.from(JSON.stringify({ userId: residentPrincipal.userId, credentialVersion: residentPrincipal.credentialVersion,
    sessionId: residentPrincipal.sessionId, expiresAt: residentPrincipal.sessionExpiresAt })).toString('base64url')
  const signature = createHmac('sha256', secret).update(`atrium-database-user-session-v4|${payload}`).digest('base64url')
  forgedStaffCookie = `${OPS_COOKIE}=a4.${payload}.${signature}`

  const serviceOverview = await request('/api/resident-services?resource=overview', { cookie: staff.cookie })
  assert.equal(serviceOverview.status, 200)
  serviceToken = serviceOverview.json.formToken
  const created = await request('/api/resident-services', { cookie: staff.cookie, method: 'POST',
    headers: { ...jsonHeaders(), 'x-atrium-service-form': serviceToken, 'x-atrium-service-action': 'create_request' },
    body: { action: 'create_request', requestId: randomUUID(), intake: { requestOrigin: 'staff_observation',
      location: { kind: 'common_area', label: 'Synthetic lobby' }, residentId: null, summary: 'Synthetic loose door handle',
      description: privateNote, category: 'other', reportedPriority: 'routine', reporterName: null, reporterPhone: null,
      reporterEmail: null, accessNotes: '' } } })
  assert.equal(created.status, 200, JSON.stringify(created.json)); caseId = created.json.receipt.id
  const directory = await request('/api/organizations?format=json&organizationId=organization-a', { cookie: staff.cookie })
  assert.equal(directory.status, 200); teamToken = directory.json.formToken
  const security = await request('/api/account', { cookie: staff.cookie })
  assert.equal(security.status, 200)
  accountToken = /data-form-token="([A-Za-z0-9_.-]+)"/.exec(security.text)?.[1]
  assert.ok(accountToken)
}, { timeout: 120_000 })

after(async () => {
  globalThis.fetch = originalFetch
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
})

function jsonHeaders(extra = {}) {
  return { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra }
}
async function request(path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const response = await originalFetch(origin + path, { method, redirect: 'manual', headers: {
    ...scoped, ...(staff ? { 'x-atrium-user-id': staff.principal.userId, 'x-atrium-session-id': staff.principal.sessionId } : {}),
    ...(cookie ? { cookie } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const text = await response.text()
  for (const value of [password, secret]) if (value) assert.equal(text.includes(value), false, 'No credential may appear in an HTTP response')
  assert.doesNotMatch(text, /password_hash|scrypt\$|postgres(?:ql)?:\/\//)
  let json; try { json = JSON.parse(text) } catch { /* Expected HTML for actual pages. */ }
  return { status: response.status, headers: response.headers, text, json }
}
async function assertStaffDenied(cookie) {
  for (const [path, status] of [...staffReads, [`/api/resident-services?resource=request&id=${caseId}`, 401]]) {
    const result = await request(path, { cookie, headers: { 'x-atrium-session-id': resident.principal.sessionId } })
    assert.equal(result.status, status, `${path}: ${result.text.slice(0, 250)}`)
    if (status === 303) assert.equal(result.headers.get('location'), '/api/dashboard?reauthenticate=1')
    for (const value of [privateBuilding, privateNote, caseId, staff.principal.sessionId, resident.principal.sessionId]) {
      assert.equal(result.text.includes(value), false, `${path} must not disclose private staff content`)
    }
    assert.match(result.headers.get('cache-control') || '', /no-store/)
    assert.equal(result.headers.get('set-cookie'), null, 'A resident cookie must not become a renewed staff session')
  }
}
async function durableState() {
  const rows = await db.admin.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.user_id) FROM atrium.user_credentials c) AS credentials,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM atrium.memberships m) AS memberships,
    (SELECT jsonb_agg(to_jsonb(s)-'last_seen_at_ms' ORDER BY s.id) FROM atrium.user_sessions s) AS sessions,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM atrium.mfa_factors f) AS factors,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM atrium.mfa_challenges c) AS challenges,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM atrium.mfa_password_checks c) AS password_checks`)
  const detail = await request(`/api/resident-services?resource=request&id=${caseId}`, { cookie: staff.cookie })
  assert.equal(detail.status, 200)
  return { ...rows.rows[0], request: detail.json.detail.request, events: detail.json.detail.events }
}

test('one owner can hold separate persisted staff and resident sessions without exchanging their audience', async () => {
  assert.equal(staff.principal.userId, resident.principal.userId)
  assert.notEqual(staff.principal.sessionId, resident.principal.sessionId)
  assert.equal(staff.principal.audience, 'staff'); assert.equal(resident.principal.audience, 'resident')
  const rows = (await db.admin.query('SELECT id,audience FROM atrium.user_sessions WHERE id=ANY($1::uuid[]) ORDER BY audience',
    [[staff.principal.sessionId, resident.principal.sessionId]])).rows
  assert.deepEqual(rows.map(row => row.audience), ['resident', 'staff'])
  assert.match(staff.cookie, /^atrium_ops=a4\./); assert.match(resident.token, /^r1\./)
  assert.equal((await runtime.authenticateResident({ cookie: resident.cookie }, new Date())).sessionId, resident.principal.sessionId)
  assert.equal(await runtime.authenticate({ cookie: resident.cookie }, new Date()), null)
  assert.equal(await runtime.authenticateResident({ cookie: staff.cookie }, new Date()), null)
  assert.equal(await runtime.authenticateResident({ cookie: `${residentCookieName}=${staff.cookie.split('=')[1]}` }, new Date()), null)
})

test('resident cookie alone cannot read staff pages, catalogues, operational records or security forms', async () => {
  await assertStaffDenied(resident.cookie)
})

test('a genuine r1 token pasted into the staff cookie is refused at every actual staff HTTP boundary', async () => {
  await assertStaffDenied(`${OPS_COOKIE}=${resident.token}`)
})

test('a correctly signed a4 envelope cannot promote the same owner resident SID into a staff session', async () => {
  const token = forgedStaffCookie.split('=')[1]
  const parsed = verifyUserSessionClaims(token, new Date(), secret)
  assert.ok(parsed, 'The crafted token must pass actual a4 cryptographic verification')
  assert.equal(parsed.audience, 'staff'); assert.equal(parsed.sessionId, resident.principal.sessionId)
  assert.equal(await runtime.authenticate({ cookie: forgedStaffCookie }, new Date()), null, 'Registry audience must independently refuse the valid staff envelope')
  await assertStaffDenied(forgedStaffCookie)
})

test('coexisting staff and resident cookies select the intended audience in either cookie order', async () => {
  for (const cookie of [`${resident.cookie}; ${staff.cookie}`, `${staff.cookie}; ${resident.cookie}`]) {
    assert.equal((await runtime.authenticate({ cookie }, new Date())).sessionId, staff.principal.sessionId)
    assert.equal((await runtime.authenticateResident({ cookie }, new Date())).sessionId, resident.principal.sessionId)
    const result = await request('/api/properties', { cookie })
    assert.equal(result.status, 200); assert.ok(result.json.properties.some(property => property.id === 'property-a1'))
    const current = await request('/api/account', { cookie })
    assert.equal(current.status, 200); assert.ok(current.text.includes(staff.principal.sessionId))
    assert.equal(current.text.includes(resident.principal.sessionId), false, 'Staff security page must not list resident sessions')
  }
})

test('resident cookies cannot mutate staff requests, team access, MFA or credentials even with copied valid staff forms', async () => {
  const before = await durableState()
  const changes = [
    ['/api/resident-services', { action: 'add_note', requestId: randomUUID(), id: caseId, expectedVersion: 1,
      note: 'This resident-session staff write must never be recorded' }, { 'x-atrium-service-form': serviceToken, 'x-atrium-service-action': 'add_note' }],
    ['/api/organizations', { action: 'replace_member', requestId: randomUUID(), organizationId: 'organization-a', membershipId: 'member-staff-a',
      expectedVersion: 1, status: 'active', role: 'viewer', access: 'properties', propertyIds: ['property-a1'] },
    { 'x-atrium-organization-action': 'replace_member', 'x-atrium-csrf': teamToken }],
    ['/api/mfa', { action: 'authentication-options', purpose: 'organization_administration', factorId: null },
      { 'x-atrium-account-action': 'authentication-options', 'x-atrium-csrf': accountToken }],
    ['/api/mfa', { action: 'password', password }, { 'x-atrium-account-action': 'password', 'x-atrium-csrf': accountToken }],
    ['/api/account', { action: 'change-password', currentPassword: password, newPassword: randomBytes(24).toString('base64url') },
      { 'x-atrium-account-action': 'change-password', 'x-atrium-csrf': accountToken }],
    ['/api/account', { action: 'revoke-other-sessions' }, { 'x-atrium-account-action': 'revoke-other-sessions', 'x-atrium-csrf': accountToken }],
    ['/api/workflows', { action: 'cancel', id: randomUUID(), expectedRevision: '0'.repeat(64), reason: 'no_longer_needed' }, {}],
  ]
  for (const cookie of [resident.cookie, `${OPS_COOKIE}=${resident.token}`, forgedStaffCookie]) {
    for (const [path, body, extra] of changes) {
      const result = await request(path, { cookie, method: 'POST', headers: jsonHeaders(extra), body })
      assert.equal(result.status, 401, `${path} must reject the audience before command execution: ${result.text}`)
      assert.equal(result.headers.get('set-cookie'), null)
    }
  }
  assert.deepEqual(await durableState(), before, 'Rejected resident requests must not change staff data, factors, sessions, memberships or credentials')
})

test('ordinary a4 staff login still reaches the real protected routes and records one authorized staff change', async () => {
  const payload = JSON.parse(Buffer.from(staff.cookie.split('.')[1], 'base64url').toString('utf8'))
  assert.deepEqual(Object.keys(payload).sort(), ['credentialVersion', 'expiresAt', 'sessionId', 'userId'], 'Retain the original a4 wire format')
  for (const [path] of staffReads) {
    const result = await request(path, { cookie: staff.cookie })
    assert.equal(result.status, 200, `${path}: ${result.text.slice(0, 250)}`)
  }
  const result = await request('/api/resident-services', { cookie: staff.cookie, method: 'POST',
    headers: jsonHeaders({ 'x-atrium-service-form': serviceToken, 'x-atrium-service-action': 'add_note' }),
    body: { action: 'add_note', requestId: randomUUID(), id: caseId, expectedVersion: 1, note: 'An authorized staff session reviewed this request' } })
  assert.equal(result.status, 200, JSON.stringify(result.json)); assert.equal(result.json.receipt.version, 2)
  const detail = await request(`/api/resident-services?resource=request&id=${caseId}`, { cookie: staff.cookie })
  assert.equal(detail.json.detail.request.version, 2); assert.equal(detail.json.detail.events.length, 2)
  assert.equal(remoteRequests, 0, 'No external provider transport is part of this foundation test')
  assert.deepEqual(serverErrors, [])
})
