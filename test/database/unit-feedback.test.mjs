import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import leads from '../../api/leads.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { emptyProfile } from '../../src/leads/profile.ts'
import { profileKey } from '../../src/leads/consolidate.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

const original = process.env.ATRIUM_RUNTIME_MODE
const phone = '+12125550123', cookies = {}
let db, app, runtime, server, origin, credentials
const settings = { capacity: 2, slotMinutes: 30, startIntervalMinutes: 30, bufferMinutes: 0, minimumNoticeMinutes: 0, bookingWindowDays: null, sameUnitPolicy: 'exclusive', hours: { 1: { openHour: 9, closeHour: 18 } } }
const buildings = [ ['organization-a', 'property-a1', 'America/New_York', 'NY'], ['organization-a', 'property-a2', 'America/Chicago', 'IL'], ['organization-b', 'property-b1', 'America/Los_Angeles', 'CA'] ]
async function publish([org, id, zone, jurisdiction], version = 1, activate = true) {
  const bundle = { property: { id, organizationId: org, buildingName: id, timeZone: zone, jurisdiction, tourSettings: settings },
    inventory: ['12A', `${id}-only`].map(unitId => ({ unitId, floorPlanId: 'one', bedrooms: 1, bathrooms: 1, sqft: 700, floor: 12, monthlyRent: 4000, availableFrom: '2026-09-01', status: 'available' })),
    floorplans: [{ id: 'one', name: `${id} plan`, bedrooms: 1, bathrooms: 1, sqft: 700 }], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES($1,$2,$3,'published',$4,'2026-09-09T12:00:00Z','synthetic-unit-feedback','2026-09-09T12:00:00Z')`, [org, id, version, JSON.stringify(bundle)])
  if (activate) await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2', [org, id, version])
}
before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase(); credentials = await seedFoundationTestDatabase(db.admin)
  app = db.createAppConnection()
  runtime = createDatabaseRuntime({ app, auth: db.auth, sessionSecret: randomBytes(36).toString('base64url') })
  for (const building of buildings) {
    await publish(building)
    await db.admin.query('INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4)', [building[0], building[1], profileKey(phone), JSON.stringify({ ...emptyProfile(phone, new Date()), name: building[1] })])
  }
  server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let raw = ''; for await (const chunk of req) raw += chunk
      try { req.body = JSON.parse(raw) } catch { req.body = raw }
      req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = body => { res.end(body); return res }
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
      await (req.url.startsWith('/api/dashboard') ? dashboard : leads)(req, res)
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: 'test-server-failed' })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`
  for (const username of ['owner-a', 'owner-b', 'staff-a', 'viewer-a']) {
    const response = await fetch(`${origin}/api/dashboard`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: credentials.password }) })
    assert.equal(response.status, 303); cookies[username] = response.headers.get('set-cookie').split(';')[0]; await response.text()
  }
})
after(async () => {
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  if (app) await app.close(); if (db) await db.close()
  original === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = original
})
async function request({ user = 'owner-a', property = 'property-a1', org = 'organization-a', version = 1, body } = {}) {
  const response = await fetch(origin + '/api/leads', { method: body ? 'POST' : 'GET', headers: { cookie: cookies[user],
    'x-atrium-organization-id': org, 'x-atrium-property-id': property, 'x-atrium-config-version': String(version), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json(), requestId: response.headers.get('x-request-id') }
}
const entry = extra => ({ action: 'unit_feedback_add', idempotencyKey: randomUUID(), unitId: '12A', sentiment: 'negative', category: 'price', note: 'Synthetic pricing feedback.', leadPhone: phone, observedDate: '2026-09-09', ...extra })

test('HTTP saves and descriptors are isolated across two properties and two organizations', async () => {
  const scopes = [{}, { property: 'property-a2' }, { user: 'owner-b', org: 'organization-b', property: 'property-b1' }]
  const key = randomUUID()
  const saves = await Promise.all(scopes.map((scope, i) => request({ ...scope, body: entry({ idempotencyKey: key, note: `Private observation ${i}` }) })))
  assert.ok(saves.every(result => result.status === 200), JSON.stringify(saves.map(result => result.body)))
  assert.equal(new Set(saves.map(result => result.body.unitFeedback.id)).size, 3)
  for (const [i, scope] of scopes.entries()) {
    const read = await request(scope)
    assert.equal(read.status, 200); assert.equal(read.body.unitFeedback.length, 1)
    assert.equal(read.body.unitFeedback[0].note, `Private observation ${i}`)
    assert.equal(read.body.feedbackUnits[0].floorPlanName, `${scope.property ?? 'property-a1'} plan`)
    assert.equal(read.body.scope.propertyId, scope.property ?? 'property-a1')
    assert.equal(read.body.unitFeedback[0].createdBy.id, scope.user ?? 'owner-a')
    assert.equal(read.body.feedbackInventory.source, 'synthetic-unit-feedback')
  }
  const foreign = saves[0].body.unitFeedback
  const response = await request({ property: 'property-a2', body: { action: 'unit_feedback_edit', id: foreign.id, expectedRevision: 1, idempotencyKey: randomUUID(), sentiment: 'positive', category: 'other', observedDate: '2026-09-09' } })
  assert.equal(response.status, 404)
})

test('unit and prospect references are checked against the selected property; viewer writes are denied', async () => {
  assert.equal((await request({ body: entry({ unitId: 'property-a2-only' }) })).status, 404)
  assert.equal((await request({ body: entry({ leadPhone: '+12125550999' }) })).status, 404)
  assert.equal((await request({ body: entry({ createdBy: { id: 'someone-else' } }) })).status, 400)
  assert.equal((await request({ user: 'viewer-a', body: entry() })).status, 403)
  assert.equal((await request({ user: 'viewer-a' })).status, 200)
  assert.equal((await request({ user: 'staff-a', property: 'property-a2', body: entry() })).status, 403)
  assert.equal((await request({ user: 'staff-a', body: entry() })).status, 200)
  assert.equal((await request({ org: 'organization-b', property: 'property-b1' })).status, 403)
  assert.equal((await request({ version: 999, body: entry() })).status, 409)
})

test('real concurrent duplicate creates collapse and revision-fenced edits cannot lose a writer', async () => {
  const body = entry()
  const writes = await Promise.all(Array.from({ length: 8 }, () => request({ body })))
  assert.ok(writes.every(result => result.status === 200))
  const record = writes[0].body.unitFeedback
  assert.ok(writes.every(result => result.body.unitFeedback.id === record.id))
  const rows = await db.admin.query('SELECT * FROM atrium.operational_documents WHERE property_id=$1 AND key=$2', ['property-a1', `unit-feedback:${record.id}`])
  assert.equal(rows.rowCount, 1)
  assert.equal((await request({ body: { ...body, note: 'Changed under the same retry key' } })).status, 409)
  const edit = { action: 'unit_feedback_edit', id: record.id, expectedRevision: 1, sentiment: 'neutral', category: 'layout', observedDate: '2026-09-09' }
  const edits = await Promise.all(['first', 'second'].map(note => request({ body: { ...edit, idempotencyKey: randomUUID(), note } })))
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409])
  assert.equal((await request()).body.unitFeedback.find(item => item.id === record.id).revision, 2)
})

test('feedback and audit use one commit; audit failure rolls both back', async () => {
  const saved = await request({ body: entry() }); assert.equal(saved.status, 200)
  const transaction = await db.admin.query(`SELECT xmin::text FROM atrium.operational_documents WHERE property_id='property-a1' AND key=$1
    UNION ALL SELECT xmin::text FROM atrium.audit_events WHERE request_id=$2`, [`unit-feedback:${saved.body.unitFeedback.id}`, saved.requestId])
  assert.ok(transaction.rowCount >= 2); assert.equal(new Set(transaction.rows.map(row => row.xmin)).size, 1)
  const originalTransaction = app.transaction.bind(app)
  app.transaction = (context, work) => originalTransaction(context, client => work(new Proxy(client, { get(target, key) {
    if (key !== 'query') return Reflect.get(target, key)
    return (...args) => String(args[0]).includes('INSERT INTO atrium.audit_events') ? Promise.reject(new Error('Synthetic audit outage')) : client.query(...args)
  } })))
  let failed
  try { failed = await request({ body: entry() }); assert.equal(failed.status, 503) }
  finally { app.transaction = originalTransaction }
  assert.equal((await db.admin.query('SELECT 1 FROM atrium.audit_events WHERE request_id=$1', [failed.requestId])).rowCount, 0)
  // Successful create above was the only new record in this test.
  assert.equal((await request()).body.unitFeedback.length, 4)
})

test('published configuration changing during save rolls back feedback and audit', async () => {
  await publish(buildings[0], 2, false)
  const originalTransaction = app.transaction.bind(app)
  let changed = false
  app.transaction = (context, work) => originalTransaction(context, client => work(new Proxy(client, { get(target, key) {
    if (key !== 'query') return Reflect.get(target, key)
    return async (...args) => {
      const result = await client.query(...args)
      if (!changed && String(args[0]).includes('INSERT INTO atrium.audit_events')) {
        changed = true
        await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
      }
      return result
    }
  } })))
  let result
  try { result = await request({ body: entry() }); assert.equal(result.status, 409); assert.equal(result.body.code, 'property_configuration_changed') }
  finally { app.transaction = originalTransaction }
  assert.equal(changed, true)
  assert.equal((await db.admin.query('SELECT 1 FROM atrium.audit_events WHERE request_id=$1', [result.requestId])).rowCount, 0)
  assert.equal((await request({ version: 2 })).body.unitFeedback.length, 4)
})
