import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import organizations from '../../api/organizations.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { mintOrganizationFormToken } from '../../src/auth/organization-management.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
const previous = process.env.ATRIUM_RUNTIME_MODE
const actors = {}, secret = 'synthetic-team-http-session-secret-long-enough'
let db, runtime, server, origin, password
before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  password = (await seedFoundationTestDatabase(db.admin)).password
  server = createServer(async (req, res) => {
    req.atriumRuntime = runtime
    let raw = ''; for await (const chunk of req) raw += chunk
    req.body = raw
    const url = new URL(req.url, origin)
    req.query = {}
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key); req.query[key] = values.length === 1 ? values[0] : values
    }
    res.status = code => { res.statusCode = code; return res }
    res.send = body => { res.end(body); return res }
    res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
    await (url.pathname === '/api/dashboard' ? dashboard : organizations)(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: secret, authOrigin: origin })
  for (const user of ['owner-a', 'owner-b', 'staff-a', 'viewer-a']) actors[user] = await login(user)
})
after(async () => {
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  previous === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = previous
})
async function login(user, verify = true) {
  const response = await fetch(origin + '/api/dashboard', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: user, password }) })
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie').split(';')[0]; await response.text()
  const principal = await runtime.authenticate({ cookie }, new Date())
  if (verify) await verifyOrganizationSession(runtime, principal, password)
  return { cookie, principal, token: mintOrganizationFormToken(principal, new Date(), secret, user === 'owner-b' ? 'organization-b' : 'organization-a') }
}
async function request(query = '?format=json&organizationId=organization-a', { user = 'owner-a', actor = actors[user], body, headers = {}, method } = {}) {
  const response = await fetch(origin + '/api/organizations' + query, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
    headers: { cookie: actor?.cookie ?? '', 'x-atrium-user-id': actor?.principal.userId ?? '', 'x-atrium-session-id': actor?.principal.sessionId ?? '',
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-atrium-csrf': actor.token, 'x-atrium-organization-action': 'replace_member' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text }
}
const command = (overrides = {}) => ({ action: 'replace_member', organizationId: 'organization-a', membershipId: 'member-staff-a',
  expectedVersion: 1, status: 'active', role: 'viewer', access: 'properties', propertyIds: ['property-a2'], requestId: randomUUID(), ...overrides })

test('Team loads real scoped identities without published property configuration', async () => {
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.property_configurations')).rows[0].n, 0)
  const page = await request('')
  assert.equal(page.status, 200); assert.match(page.body, /<title>Team — Atrium/)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(page.headers.get('cache-control'), /no-store/)
  const bootstrap = JSON.parse(page.body.match(/window\.ATRIUM_TEAM=(.*?);<\/script>/)[1])
  assert.deepEqual(bootstrap.organizations.map(value => value.id), ['organization-a'])
  const listing = await request()
  assert.equal(listing.status, 200)
  assert.equal(listing.body.userId, 'owner-a')
  assert.deepEqual(listing.body.directory.members.map(value => value.userId).sort(), ['owner-a', 'staff-a', 'viewer-a'])
  assert.doesNotMatch(JSON.stringify(listing.body), /passwordHash|password_hash|owner-b/)
  assert.equal((await request('?format=json&organizationId=organization-b')).status, 403)
  assert.equal((await request(undefined, { user: 'staff-a' })).status, 403)
  assert.equal((await request(undefined, { user: 'viewer-a' })).status, 403)
})
test('anonymous, unverified, replacement-session and ambiguous scope requests fail closed', async () => {
  assert.equal((await request(undefined, { actor: null })).status, 401)
  const pending = await login('owner-a', false)
  assert.equal((await request('', { actor: pending })).headers.get('location'), '/api/mfa')
  assert.equal((await request(undefined, { actor: pending })).body.code, 'mfa_required')
  assert.equal((await request(undefined, { headers: { 'x-atrium-session-id': randomUUID() } })).status, 409)
  for (const query of ['?format=json&organizationId=organization-a&organizationId=organization-b', '?format=json&organizationId=organization-a&limit=101',
    '?format=json&organizationId=organization-a&beforeMembershipId=', '?format=json&organizationId=organization-a&unexpected=1']) {
    assert.equal((await request(query)).status, 400)
  }
  await runtime.sessions.revoke(pending.principal, pending.principal.sessionId)
  assert.equal((await request(undefined, { actor: pending })).status, 401)
})
test('POST requires same origin, a purpose-bound form, exact identity and a full command', async () => {
  for (const headers of [{ origin: 'https://attacker.example' }, { 'x-atrium-csrf': 'invalid' },
    { 'x-atrium-user-id': 'owner-b' }, { 'x-atrium-organization-action': 'delete_member' }, { 'content-type': 'text/plain' }]) {
    assert.ok([400, 403, 409].includes((await request('', { body: command(), headers })).status))
  }
  for (const body of [null, [], '{invalid', command({ targetUserId: 'owner-b' }), command({ role: ['owner'] }), command({ propertyIds: ['property-a1', 'property-a1'] })]) {
    assert.equal((await request('', { body })).status, 400)
  }
  const failed = await request('', { body: command({ organizationId: 'organization-b', membershipId: 'member-owner-b' }) })
  assert.equal(failed.status, 403)
  assert.equal((await db.admin.query("SELECT permission_version FROM atrium.memberships WHERE id='member-staff-a'")).rows[0].permission_version, '1')
  await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES('member-owner-a-b','owner-a','organization-b','owner','organization','active')")
  const otherOrg = await request('?format=json&organizationId=organization-b')
  assert.equal(otherOrg.status, 200)
  const misplaced = await request('', { body: command({ organizationId: 'organization-b', membershipId: 'member-owner-b', role: 'owner', access: 'organization', propertyIds: [] }) })
  assert.equal(misplaced.body.code, 'invalid_organization_form')
  assert.equal(misplaced.status, 403)
})
test('saved full manifest has an exact retry receipt and stale writes cannot overwrite it', async () => {
  const input = command()
  const first = await request('', { body: input })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.receipt.version, 2); assert.equal(first.body.receipt.duplicate, false)
  assert.equal(first.body.receipt.role, 'viewer'); assert.deepEqual(first.body.receipt.propertyIds, ['property-a2'])
  const repeat = await request('', { body: input })
  assert.equal(repeat.status, 200); assert.deepEqual(repeat.body.receipt, { ...first.body.receipt, duplicate: true })
  assert.equal((await request('', { body: { ...input, role: 'staff' } })).status, 409)
  assert.equal((await request('', { body: { ...input, requestId: randomUUID() } })).status, 409)
  const current = await request()
  assert.equal(current.body.directory.members.find(value => value.userId === 'staff-a').version, 2)
  await assert.rejects(runtime.authorization.authorizeProperty(actors['staff-a'].principal, 'property-a1', 'read'), { code: 'forbidden' })
  const scope = await runtime.authorization.authorizeProperty(actors['staff-a'].principal, 'property-a2', 'read')
  assert.equal(scope.propertyId, 'property-a2')
})
test('last owner cannot revoke themselves and missing administrator assurance cannot write', async () => {
  const owner = command({ membershipId: 'member-owner-a', role: 'owner', access: 'organization', propertyIds: [], status: 'revoked' })
  const rejected = await request('', { body: owner })
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'last_owner')
  const onlyLogin = await login('owner-a', false)
  await verifyOrganizationSession(runtime, onlyLogin.principal, password, { purpose: 'session_login' })
  const expired = await request('', { actor: onlyLogin, body: command({ expectedVersion: 2 }) })
  assert.equal(expired.status, 403); assert.equal(expired.body.code, 'mfa_required')
})
