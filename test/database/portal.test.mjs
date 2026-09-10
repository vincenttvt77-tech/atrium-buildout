import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import properties from '../../api/properties.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { mintSession, OPS_COOKIE } from '../../src/ops/session.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

const ENV_KEYS = ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'ATRIUM_SIMULATION',
  'OPS_SESSION_SECRET', 'OPS_DASHBOARD_PASSCODE', 'OPS_ACCOUNTS_JSON']
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
let db, runtime, server, origin, credentials
let injectRuntime = true
const cookies = new Map()
const unsafeLabel = '</script><img src=x onerror=alert(1)> & preview'
const buildings = [
  ['organization-a', 'property-a1', 'America/New_York', 'NY', 1],
  ['organization-a', 'property-a2', 'America/Chicago', 'IL', 2],
  ['organization-b', 'property-b1', 'America/Los_Angeles', 'CA', 1],
]

async function publish([organizationId, propertyId, timeZone, jurisdiction, version]) {
  const configuration = {
    property: { id: propertyId, organizationId, buildingName: propertyId === 'property-a1' ? unsafeLabel : propertyId,
      timeZone, jurisdiction, tourSettings: defaultSettings(),
      ...(propertyId === 'property-a1' ? { leasingPhone: '+1 (212) 555-0100', leasingHoursByDay: { monday: '9:30am - 5:00pm', sunday: 'closed' }, locationLabel: 'Synthetic New York' } : {}) },
    inventory: [], floorplans: [], knowledge: [],
  }
  await db.admin.query('BEGIN')
  try {
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,schema_version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,$3,1,'published',$4,'2026-01-01T00:00:00Z','synthetic-portal-test','2026-01-02T00:00:00Z')`,
    [organizationId, propertyId, version, JSON.stringify(configuration)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2',
      [organizationId, propertyId, version])
    await db.admin.query('COMMIT')
  } catch (error) { await db.admin.query('ROLLBACK'); throw error }
}

before(async () => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  process.env.OPS_DASHBOARD_PASSCODE = 'synthetic-legacy-passcode'
  process.env.OPS_SESSION_SECRET = randomBytes(36).toString('base64url')
  db = await createFoundationTestDatabase()
  credentials = await seedFoundationTestDatabase(db.admin)
  runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app: db.app, auth: db.auth, sessionSecret: process.env.OPS_SESSION_SECRET })
  for (const building of buildings) await publish(building)
  await db.admin.query('UPDATE atrium.users SET display_name=$1 WHERE id=$2', [unsafeLabel, 'owner-a'])
  await db.admin.query('UPDATE atrium.properties SET name=$1 WHERE id=$2', [unsafeLabel, 'property-a1'])
  server = createServer(async (req, res) => {
    try {
      if (injectRuntime) req.atriumRuntime = runtime
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 16_384) throw new Error('Test request too large') }
      req.body = body
      res.status = code => { res.statusCode = code; return res }
      res.send = body => { res.end(body); return res }
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
      const path = new URL(req.url, 'http://localhost').pathname
      await (path === '/api/properties' ? properties : dashboard)(req, res)
    } catch { res.statusCode = 500; res.end('Test server failed') }
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

async function request(path = '/api/dashboard', { cookie, method = 'GET', fields, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'manual', headers: {
    ...(cookie ? { cookie } : {}), ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers,
  }, ...(fields ? { body: new URLSearchParams(fields) } : body === undefined ? {} : { body }) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}
async function signIn(username, path = '/api/dashboard') {
  const result = await request(path, { method: 'POST', fields: { username, password: credentials.password } })
  assert.equal(result.status, 303)
  const cookie = result.headers.get('set-cookie').split(';')[0]
  await verifyMfaCookie(runtime, cookie, credentials.password)
  cookies.set(username, cookie)
  return { ...result, cookie }
}
const selected = (propertyId, organizationId = 'organization-a') => `/api/dashboard?${new URLSearchParams({ organizationId, propertyId })}`
function bootstrap(text, field) {
  const raw = new RegExp(`window\\.${field}=Object\\.freeze\\((.*?)\\);`).exec(text)?.[1]
  assert.ok(raw, `${field} bootstrap is present`)
  return JSON.parse(raw)
}

test('database login issues registered a4 user sessions and preserves the selected property URL', async () => {
  const page = await request()
  assert.equal(page.status, 401)
  assert.match(page.text, /name="username"/)
  assert.doesNotMatch(page.text, /name="passcode"/)
  const login = await signIn('owner-a', selected('property-a2'))
  assert.equal(login.headers.get('location'), selected('property-a2'))
  assert.match(login.headers.get('set-cookie'), /^atrium_ops=a4\..*HttpOnly; SameSite=Strict/)
  const payload = JSON.parse(Buffer.from(login.cookie.split('.')[1], 'base64url'))
  assert.deepEqual(Object.keys(payload).sort(), ['credentialVersion', 'expiresAt', 'sessionId', 'userId'])
  assert.equal(payload.userId, 'owner-a')
  assert.equal(login.text.includes(credentials.password), false)
  assert.match(login.headers.get('cache-control'), /no-store/)
})

test('bad passwords and configured legacy authentication cannot bypass database login', async () => {
  const legacy = `${OPS_COOKIE}=${mintSession(new Date(), process.env.OPS_DASHBOARD_PASSCODE)}`
  assert.equal((await request('/api/dashboard', { cookie: legacy, headers: { 'x-ops-passcode': process.env.OPS_DASHBOARD_PASSCODE } })).status, 401)
  for (const fields of [{ username: 'owner-a', password: 'wrong' }, { passcode: process.env.OPS_DASHBOARD_PASSCODE }]) {
    const result = await request('/api/dashboard', { method: 'POST', fields })
    assert.equal(result.status, 401)
    assert.equal(result.headers.has('set-cookie'), false)
    assert.doesNotMatch(result.text, /scrypt\$/)
  }
})

test('property picker and catalogue show only current grants and escape stored display labels', async () => {
  const cookie = cookies.get('owner-a')
  const picker = await request('/api/dashboard', { cookie })
  assert.equal(picker.status, 200)
  assert.match(picker.text, /Choose a property/)
  assert.match(picker.text, /property-a1/)
  assert.match(picker.text, /property-a2/)
  assert.doesNotMatch(picker.text, /property-b1|<img/)
  const catalogue = await request('/api/properties?organizationId=organization-b', { cookie })
  assert.equal(catalogue.status, 200)
  const entries = JSON.parse(catalogue.text).properties
  assert.deepEqual(entries.map(entry => entry.id), ['property-a1', 'property-a2'])
  assert.ok(entries.every(entry => entry.organizationId === 'organization-a' && entry.href === selected(entry.id)))
  assert.equal((await request('/api/properties')).status, 401)
  const staff = await signIn('staff-a')
  const one = await request('/api/dashboard', { cookie: staff.cookie })
  assert.equal(one.status, 303)
  assert.equal(one.headers.get('location'), selected('property-a1'))
})

test('two tabs share user login while their explicit URLs retain separate property configurations', async () => {
  const pages = await Promise.all(['property-a1', 'property-a2'].map(id => request(selected(id), { cookie: cookies.get('owner-a') })))
  const values = pages.map(page => { assert.equal(page.status, 200); return bootstrap(page.text, 'ATRIUM_PROPERTY') })
  assert.deepEqual(values.map(value => [value.propertyId, value.configurationVersion, value.timeZone]),
    [['property-a1', 1, 'America/New_York'], ['property-a2', 2, 'America/Chicago']])
  assert.deepEqual(values[0].hours, { 1: [9.5, 17] })
  assert.equal(values[0].leasingPhone, '+12125550100')
  assert.deepEqual(values[1].hours, {})
  assert.equal(values[1].leasingPhone, null)
  assert.equal(values[1].locationLabel, '')
  assert.equal(values[0].buildingName, unsafeLabel)
  assert.deepEqual(bootstrap(pages[0].text, 'ATRIUM_ACCOUNT'), { userId: 'owner-a', username: 'owner-a', displayName: unsafeLabel, sessionId: JSON.parse(Buffer.from(cookies.get('owner-a').split('.')[1], 'base64url')).sessionId })
  assert.ok(pages[0].text.includes('window.ATRIUM_RUNTIME_MODE="postgres";'))
  assert.equal(pages[0].text.includes(unsafeLabel), false)
  assert.equal(pages[0].text.includes(credentials.password), false)
  assert.equal(pages[0].text.includes('synthetic-assistant-a'), false)
  assert.deepEqual(Object.keys(values[0]).sort(), ['buildingName', 'configurationVersion', 'hours', 'leasingPhone',
    'leasingPhoneDisplay', 'locationLabel', 'organizationId', 'permissionVersion', 'permissions', 'propertyId', 'timeZone'])
})

test('foreign, mismatched, incomplete and ambiguous selections fail before protected page bootstrap', async () => {
  for (const [path, expected] of [
    [selected('property-b1', 'organization-b'), 403], [selected('property-a1', 'organization-b'), 403],
    ['/api/dashboard?propertyId=property-a1', 400], [selected('property-a1') + '&propertyId=property-a2', 400],
    [selected('unknown-property'), 403],
  ]) {
    const response = await request(path, { cookie: cookies.get('owner-a') })
    assert.equal(response.status, expected)
    assert.doesNotMatch(response.text, /window\.ATRIUM_PROPERTY=/)
  }
})

test('viewer bootstrap permits reads only and membership revocation applies on the next request', async () => {
  const { cookie } = await signIn('viewer-a')
  const allowed = await request(selected('property-a1'), { cookie })
  assert.equal(allowed.status, 200)
  assert.deepEqual(bootstrap(allowed.text, 'ATRIUM_PROPERTY').permissions, ['read'])
  await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id='member-viewer-a'")
  try {
    assert.equal((await request(selected('property-a1'), { cookie })).status, 403)
    const catalogue = await request('/api/properties', { cookie })
    assert.deepEqual(JSON.parse(catalogue.text).properties, [])
  } finally { await db.admin.query("UPDATE atrium.memberships SET status='active',permission_version=permission_version+1 WHERE id='member-viewer-a'") }
})

test('credential rotation invalidates an existing portal cookie without accepting legacy fallback', async () => {
  const { cookie } = await signIn('staff-a')
  await db.admin.query("UPDATE atrium.users SET credential_version=credential_version+1 WHERE id='staff-a'")
  const response = await request(selected('property-a1'), { cookie })
  assert.equal(response.status, 401)
  assert.match(response.text, /name="username"/)
  assert.equal((await request('/api/properties', { cookie })).status, 401)
})

test('an authorized property without published configuration stays unavailable without another property fallback', async () => {
  const { cookie } = await signIn('owner-b')
  const response = await request(selected('property-b2', 'organization-b'), { cookie })
  assert.equal(response.status, 503)
  assert.doesNotMatch(response.text, /window\.ATRIUM_PROPERTY=/)
})

test('missing database configuration and invalid mode return 503 even with a working legacy passcode', async () => {
  injectRuntime = false
  try {
    for (const mode of ['postgres', 'mistyped-mode']) {
      process.env.ATRIUM_RUNTIME_MODE = mode
      for (const path of ['/api/dashboard', '/api/properties']) {
        const result = await request(path, { headers: { 'x-ops-passcode': process.env.OPS_DASHBOARD_PASSCODE } })
        assert.equal(result.status, 503)
        assert.doesNotMatch(result.text, /name="passcode"|postgres:\/\//)
      }
    }
  } finally { process.env.ATRIUM_RUNTIME_MODE = 'postgres'; injectRuntime = true }
})

test('logout clears an absent session and both routes reject unsupported methods', async () => {
  const result = await request('/api/dashboard', { method: 'POST', body: JSON.stringify({ action: 'logout' }), headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
  assert.equal(result.status, 200)
  assert.match(result.headers.get('set-cookie'), /Max-Age=0; HttpOnly; SameSite=Strict/)
  assert.equal((await request('/api/dashboard', { method: 'PUT' })).status, 405)
  assert.equal((await request('/api/properties', { method: 'POST' })).status, 405)
})
