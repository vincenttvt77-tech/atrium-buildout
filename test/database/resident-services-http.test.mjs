import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import services from '../../api/resident-services.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'

const previous = process.env.ATRIUM_RUNTIME_MODE, actors = {}, tokens = {}
let db, runtime, server, origin, password
const source = () => ({ kind: 'staff_review', reference: 'Synthetic authorized occupancy schedule', version: 'review-1',
  observedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86400_000).toISOString() })
const resident = (extra = {}) => ({ action: 'add_resident', requestId: randomUUID(), details: {
  unitId: '19A', displayName: 'Synthetic Resident', relationship: 'occupant', startsOn: '2020-01-01', endsOn: null,
  phone: null, email: null, source: source(), ...extra }, reason: 'Reviewed authorized synthetic record' })
const intake = (extra = {}) => ({ action: 'create_request', requestId: randomUUID(), intake: {
  requestOrigin: 'resident_report', location: { kind: 'unit', unitId: '19A' }, residentId: null, summary: 'Kitchen tap dripping', description: '',
  category: 'plumbing', reportedPriority: 'routine', reporterName: null, reporterPhone: null, reporterEmail: null,
  accessNotes: 'Reporter asked for an afternoon visit; permission not established.', ...extra } })
const triage = (id, expectedVersion, extra = {}) => ({ action: 'triage_request', requestId: randomUUID(), id,
  expectedVersion, state: 'ready_for_planning', priority: 'routine', note: 'Staff reviewed the reported issue and context', ...extra })

before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  password = (await seedFoundationTestDatabase(db.admin)).password
  for (const [organizationId, propertyId] of [['organization-a', 'property-a1'], ['organization-a', 'property-a2'], ['organization-b', 'property-b1']]) {
    const timeZone = propertyId === 'property-a2' ? 'America/Chicago' : propertyId === 'property-b1' ? 'America/Los_Angeles' : 'America/New_York'
    const bundle = { property: { id: propertyId, organizationId, buildingName: 'Synthetic Service Building',
      timeZone, jurisdiction: 'NY', tourSettings: defaultSettings() },
    inventory: [{ unitId: '19A', floorPlanId: 'plan-3', floor: 19, bedrooms: 3, bathrooms: 2, sqft: 1400,
      monthlyRent: 5000, availableFrom: '2026-09-01', status: 'leased' }],
    floorplans: [{ id: 'plan-3', name: 'Three bedroom', bedrooms: 3, bathrooms: 2, sqft: 1400, description: 'Synthetic plan', features: [] }], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,clock_timestamp(),'synthetic-service-test',clock_timestamp())`, [organizationId, propertyId, JSON.stringify(bundle)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2', [organizationId, propertyId])
  }
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
    await (url.pathname === '/api/dashboard' ? dashboard : services)(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: 'synthetic-service-http-session-secret-long-enough', authOrigin: origin })
  for (const user of ['owner-a', 'owner-b', 'staff-a', 'viewer-a']) actors[user] = await login(user)
  for (const [user, property, org] of [['owner-a', 'property-a1', 'organization-a'], ['owner-a', 'property-a2', 'organization-a'],
    ['owner-b', 'property-b1', 'organization-b'], ['staff-a', 'property-a1', 'organization-a']]) {
    const result = await request('resource=overview', { user, property, org })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    tokens[`${user}:${property}`] = result.body.formToken
  }
})
after(async () => {
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  previous === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = previous
})
async function login(user, verify = true) {
  const response = await fetch(origin + '/api/dashboard', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, password }) })
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie').split(';')[0]; await response.text()
  const principal = await runtime.authenticate({ cookie }, new Date())
  if (verify) await verifyOrganizationSession(runtime, principal, password, { purpose: 'session_login' })
  return { cookie, principal }
}
async function request(query = '', { user = 'owner-a', actor = actors[user], property = 'property-a1', org = 'organization-a', body, headers = {}, method } = {}) {
  const response = await fetch(origin + '/api/resident-services' + (query ? '?' + query : ''), {
    method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual', headers: { cookie: actor?.cookie ?? '',
      'x-atrium-organization-id': org, 'x-atrium-property-id': property, 'x-atrium-config-version': '1',
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-atrium-service-form': tokens[`${user}:${property}`] ?? '',
        'x-atrium-service-action': body?.action ?? '' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return { status: response.status, headers: response.headers, body: await response.json() }
}
async function save(body, options = {}) {
  const result = await request('', { ...options, body })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.receipt
}

test('staff workspace exposes scoped units and real capabilities, excluding viewers and unverified sessions', async () => {
  const overview = await request('resource=overview', { user: 'staff-a' })
  assert.equal(overview.status, 200); assert.equal(overview.body.canManageResidents, false)
  assert.deepEqual(overview.body.units, [{ id: '19A', label: '19A' }])
  assert.match(overview.headers.get('cache-control'), /no-store/)
  assert.match(overview.headers.get('x-robots-tag'), /noindex/)
  assert.equal((await request('resource=overview', { user: 'viewer-a' })).status, 403)
  assert.equal((await request('resource=overview', { actor: null })).status, 401)
  const pending = await login('owner-a', false)
  assert.equal((await request('resource=overview', { actor: pending })).body.code, 'mfa_required')
  await runtime.sessions.revoke(pending.principal, pending.principal.sessionId)
  assert.equal((await request('resource=overview', { actor: pending })).status, 401)
})

test('manager creates a reviewed occupancy record while staff intake retains separate caller and access states', async () => {
  assert.equal((await request('', { user: 'staff-a', body: resident() })).status, 403)
  const record = await save(resident())
  const loaded = await request(`resource=resident&id=${record.id}`)
  assert.equal(loaded.body.resident.contextState, 'current')
  const created = await save(intake({ residentId: record.id, reporterPhone: '+15555550123' }), { user: 'staff-a' })
  const detail = (await request(`resource=request&id=${created.id}`, { user: 'staff-a' })).body.detail
  assert.equal(detail.resident.state, 'current')
  assert.equal(detail.request.residentNameAtIntake, 'Synthetic Resident')
  assert.equal(detail.request.callerIdentityVerified, false); assert.equal(detail.request.entryAuthorized, false)
  assert.equal(detail.request.dispatchStatus, 'not_dispatched'); assert.equal(detail.request.notificationStatus, 'not_sent')
  const list = await request('resource=requests&state=all', { user: 'staff-a' })
  assert.doesNotMatch(JSON.stringify(list.body), /15555550123|accessNotes|reporterPhone|residentNameAtIntake/)
  await save(triage(created.id, created.version), { user: 'staff-a' })
  const planned = (await request(`resource=request&id=${created.id}`)).body.detail.request
  assert.equal(planned.state, 'ready_for_planning'); assert.equal(planned.dispatchStatus, 'not_dispatched')
})

test('same apartment labels never authorize cross-property records or cross-organization linking', async () => {
  const other = await save(resident(), { user: 'owner-b', property: 'property-b1', org: 'organization-b' })
  assert.equal((await request(`resource=resident&id=${other.id}`)).status, 404)
  const linked = await request('', { body: intake({ residentId: other.id }) })
  assert.equal(linked.status, 400, JSON.stringify(linked.body))
  assert.equal(linked.body.code, 'service_invalid_input')
  const absent = await request('', { body: intake({ residentId: randomUUID() }) })
  assert.equal(absent.status, linked.status)
  assert.equal(absent.body.code, linked.body.code)
  assert.equal((await request('resource=residents', { user: 'staff-a', property: 'property-a2' })).status, 403)
  assert.equal((await request('resource=overview', { org: 'organization-b' })).status, 403)
  const own = await save(resident())
  assert.equal((await request(`resource=resident&id=${own.id}`, { property: 'property-a2' })).status, 404)
})

test('service forms bind exact browser account, property, origin and requested action', async () => {
  const body = intake()
  for (const headers of [{ origin: 'https://attacker.invalid' }, { 'x-atrium-service-form': 'invalid' },
    { 'content-type': 'text/plain' }, { 'x-atrium-service-action': 'triage_request' },
    { 'sec-fetch-site': 'cross-site' }]) assert.equal((await request('', { body, headers })).status, 403)
  assert.equal((await request('', { body, property: 'property-a2', headers: { 'x-atrium-service-form': tokens['owner-a:property-a1'] } })).status, 403)
  const replacement = await login('owner-a')
  assert.equal((await request('', { body, actor: replacement })).status, 403)
  await runtime.sessions.revoke(replacement.principal, replacement.principal.sessionId)
  assert.equal((await request('resource=requests', { headers: { 'x-atrium-config-version': '999' } })).status, 409)
})

test('exact committed retries return one receipt and stale notes cannot overwrite newer case work', async () => {
  const body = intake(), created = await save(body), replay = await save(body)
  assert.equal(replay.id, created.id); assert.equal(replay.version, created.version); assert.equal(replay.replayed, true)
  const changed = await request('', { body: { ...body, intake: { ...body.intake, summary: 'Different request' } } })
  assert.equal(changed.status, 409)
  const note = { action: 'add_note', requestId: randomUUID(), id: created.id, expectedVersion: created.version, note: 'Staff requested a clearer location before planning' }
  const saved = await save(note)
  assert.equal((await save(note)).version, saved.version)
  assert.equal((await request('', { body: { ...note, requestId: randomUUID(), note: 'Stale competing update' } })).status, 409)
  const detail = (await request(`resource=request&id=${created.id}`)).body.detail
  assert.equal(detail.events.length, 2)
  assert.deepEqual(detail.events.map(event => event.kind).sort(), ['intake', 'note'])
})

test('unestablished and ended unit context blocks planning without blocking intake or history', async () => {
  const unlinked = await save(intake())
  assert.equal((await request('', { body: triage(unlinked.id, unlinked.version) })).body.code, 'service_context_required')
  const ended = await save(resident({ startsOn: '2020-01-01', endsOn: '2020-02-01' }))
  const linked = await save(intake({ residentId: ended.id }))
  const detail = (await request(`resource=request&id=${linked.id}`)).body.detail
  assert.equal(detail.resident.state, 'ended')
  assert.equal((await request('', { body: triage(linked.id, linked.version) })).body.code, 'service_context_required')
  const common = await save(intake({ location: { kind: 'common_area', label: 'Lobby tap' } }))
  await save(triage(common.id, common.version))
  const observed = await save(intake({ requestOrigin: 'staff_observation' }))
  await save(triage(observed.id, observed.version))
  assert.equal((await request(`resource=request&id=${observed.id}`)).body.detail.request.entryAuthorized, false)
})

test('long case histories remain readable with complete stable event pagination', async () => {
  const created = await save(intake({ summary: 'Synthetic long-lived repair history' }))
  let version = created.version
  for (let index = 0; index < 26; index++) {
    const note = await save({ action: 'add_note', requestId: randomUUID(), id: created.id, expectedVersion: version,
      note: `Synthetic staff history update ${index + 1}` })
    version = note.version
  }
  const detail = (await request(`resource=request&id=${created.id}`)).body.detail
  assert.equal(detail.events.length, 25)
  assert.equal(detail.eventsTruncated, true)
  assert.ok(detail.nextEventsCursor)
  const cursor = detail.nextEventsCursor
  const history = await request(new URLSearchParams({ resource: 'events', id: created.id, limit: '25',
    beforeCreatedAt: cursor.createdAt, beforeId: cursor.id }).toString())
  assert.equal(history.status, 200)
  assert.equal(history.body.events.length, 2)
  assert.equal(history.body.nextCursor, null)
  assert.equal(new Set([...detail.events, ...history.body.events].map(event => event.id)).size, 27)
  assert.deepEqual([...detail.events, ...history.body.events].map(event => event.caseVersion).sort((a, b) => a - b),
    Array.from({ length: 27 }, (_, index) => index + 1))
})

test('staff can clarify unknown request context on the same case while preserving the original report', async () => {
  const location = { kind: 'unknown', label: 'Caller could not confirm apartment' }
  const created = await save(intake({ location, summary: 'Reported tap needs inspection' }))
  const record = await save(resident())
  const update = { action: 'update_context', requestId: randomUUID(), id: created.id, expectedVersion: created.version,
    location: { kind: 'unit', unitId: '19A' }, residentId: record.id, note: 'Staff clarified the apartment and selected its reviewed occupancy source' }
  const changed = await save(update, { user: 'staff-a' })
  const replay = await save(update, { user: 'staff-a' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.version, changed.version)
  const detail = (await request(`resource=request&id=${created.id}`)).body.detail
  assert.deepEqual(detail.request.location, update.location)
  assert.equal(detail.request.residentId, record.id)
  assert.deepEqual(detail.request.intakeLocation, location)
  assert.equal(detail.request.residentIdAtIntake, null)
  assert.equal(detail.request.residentVersionAtIntake, null)
  assert.equal(detail.request.residentNameAtIntake, null)
  assert.equal(detail.request.requestOrigin, 'resident_report')
  assert.equal(detail.request.state, 'needs_triage')
  const event = detail.events.find(item => item.kind === 'context')
  assert.deepEqual(event.contextLocation, update.location)
  assert.equal(event.contextResidentId, record.id)
  assert.equal(event.contextResidentVersion, record.version)
  assert.equal(event.contextResidentName, 'Synthetic Resident')
  assert.equal(detail.events.filter(item => item.kind === 'context').length, 1)
  assert.equal((await request('', { body: { ...update, requestId: randomUUID() }, user: 'staff-a' })).status, 409)
  const planned = await save(triage(created.id, changed.version))
  const revised = await save({ ...update, requestId: randomUUID(), expectedVersion: planned.version,
    location: { kind: 'common_area', label: 'Shared laundry room' }, residentId: null,
    note: 'Staff clarified that the problem is in a shared space, requiring fresh triage' })
  const after = (await request(`resource=request&id=${created.id}`)).body.detail
  assert.equal(after.request.state, 'needs_triage')
  assert.equal(after.request.version, revised.version)
  assert.deepEqual(after.request.intakeLocation, location)
  assert.equal(after.request.entryAuthorized, false)
  const other = await save(resident(), { user: 'owner-b', property: 'property-b1', org: 'organization-b' })
  assert.equal((await request('', { body: { ...update, requestId: randomUUID(), expectedVersion: revised.version, residentId: other.id } })).body.code,
    'service_invalid_input')
  await save({ ...update, requestId: randomUUID(), expectedVersion: revised.version, note: 'Staff now reports a strong smell of gas in the apartment' })
  const emergency = (await request(`resource=request&id=${created.id}`)).body.detail.request
  assert.equal(emergency.state, 'emergency_review')
  assert.equal(emergency.notificationStatus, 'not_sent')
  await save({ ...update, requestId: randomUUID(), expectedVersion: emergency.version, residentId: null,
    note: 'Additional context correction does not establish that the hazard has been resolved' })
  assert.equal((await request(`resource=request&id=${created.id}`)).body.detail.request.state, 'emergency_review')
})

test('emergency intake and later hazard notes remain immediate review with no invented notification', async () => {
  const created = await save(intake({ summary: 'I smell gas in the kitchen' }))
  const detail = await request(`resource=request&id=${created.id}`)
  assert.equal(detail.body.detail.request.priority, 'emergency')
  assert.equal(detail.body.detail.request.state, 'emergency_review')
  assert.ok(detail.body.safetyInstructions.length > 0)
  assert.equal(detail.body.safetyCallEmergencyServices, true)
  assert.equal(detail.body.detail.request.notificationStatus, 'not_sent')
  assert.equal((await request('', { body: triage(created.id, created.version) })).body.code, 'service_emergency_hold')
  const normal = await save(intake())
  const changed = await save({ action: 'add_note', requestId: randomUUID(), id: normal.id, expectedVersion: normal.version, note: 'There is smoke coming from the hallway now' })
  const later = (await request(`resource=request&id=${changed.id}`)).body.detail.request
  assert.equal(later.priority, 'emergency'); assert.equal(later.dispatchStatus, 'not_dispatched')
})

test('revoked occupancy returns previously planned work to attention without rewriting triage history', async () => {
  const record = await save(resident())
  const created = await save(intake({ residentId: record.id }))
  const planned = await save(triage(created.id, created.version))
  const before = (await request(`resource=request&id=${created.id}`)).body.detail
  assert.equal(before.request.contextNeedsReview, false)
  assert.equal(before.request.state, 'ready_for_planning')
  await save({ action: 'revoke_resident', requestId: randomUUID(), id: record.id,
    expectedVersion: record.version, reason: 'Reviewed source no longer establishes current occupancy' })
  const after = (await request(`resource=request&id=${created.id}`)).body.detail
  assert.equal(after.resident.state, 'revoked')
  assert.equal(after.request.contextNeedsReview, true)
  assert.equal(after.request.state, 'ready_for_planning')
  assert.equal(after.request.version, planned.version)
  assert.deepEqual(after.events, before.events)
  const attention = await request('resource=requests&state=attention&limit=50')
  const row = attention.body.requests.find(item => item.id === created.id)
  assert.ok(row, 'A stale planning decision must remain discoverable in Attention')
  assert.equal(row.contextNeedsReview, true)
  assert.equal(row.requestOrigin, 'resident_report')
  assert.equal((await request('', { body: triage(created.id, planned.version) })).body.code, 'service_context_required')
})

test('ambiguous resource queries and client-supplied authority or completion fields are refused', async () => {
  for (const query of ['resource=requests&resource=residents', 'resource=requests&state=resolved', 'resource=residents&limit=51',
    'resource=residents&beforeId=partial', 'resource=residents&beforeId=not-a-uuid&beforeCreatedAt=2026-09-12T12:00:00.123Z',
    'resource=request&id=bad%0Aid', 'resource=overview&organizationId=other']) {
    assert.equal((await request(query)).status, 400, query)
  }
  for (const body of [null, [], { ...intake(), intake: { ...intake().intake, callerIdentityVerified: true } },
    { ...intake(), approvedCost: 500 }, { ...intake(), action: 'resolve_request' }]) assert.equal((await request('', { body })).status, 400)
  assert.equal((await request('', { method: 'DELETE' })).status, 405)
})
