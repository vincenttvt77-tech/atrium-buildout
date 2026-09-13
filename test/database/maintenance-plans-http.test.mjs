import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import services from '../../api/resident-services.ts'
import planning from '../../api/maintenance-plans.ts'
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
    await (url.pathname === '/api/dashboard' ? dashboard : url.pathname === '/api/maintenance-plans' ? planning : services)(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: 'synthetic-service-http-session-secret-long-enough', authOrigin: origin })
  for (const user of ['owner-a', 'owner-b', 'staff-a', 'viewer-a']) actors[user] = await login(user)
  for (const [user, property, org] of [['owner-a', 'property-a1', 'organization-a'], ['owner-a', 'property-a2', 'organization-a'],
    ['owner-b', 'property-b1', 'organization-b'], ['staff-a', 'property-a1', 'organization-a']]) {
    for (const endpoint of ['/api/resident-services','/api/maintenance-plans']) {
      const result = await request('resource=overview', { user, property, org, endpoint })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      tokens[`${endpoint}:${user}:${property}`] = result.body.formToken
    }
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
async function request(query = '', { user = 'owner-a', actor = actors[user], property = 'property-a1', org = 'organization-a', body, headers = {}, method, endpoint = '/api/maintenance-plans' } = {}) {
  const response = await fetch(origin + endpoint + (query ? '?' + query : ''), {
    method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual', headers: { cookie: actor?.cookie ?? '',
      'x-atrium-organization-id': org, 'x-atrium-property-id': property, 'x-atrium-config-version': '1',
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json', [endpoint === '/api/resident-services' ? 'x-atrium-service-form' : 'x-atrium-planning-form']: tokens[`${endpoint}:${user}:${property}`] ?? '',
        [endpoint === '/api/resident-services' ? 'x-atrium-service-action' : 'x-atrium-planning-action']: body?.action ?? '' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return { status: response.status, headers: response.headers, body: await response.json() }
}
async function save(body, options = {}) {
  const result = await request('', { ...options, body })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.receipt
}

const policyDetails = () => ({ currency: 'USD', automaticLimitCents: 10_000, managerLimitCents: 50_000, ownerLimitCents: 100_000,
  automaticCategories: ['plumbing'], excludedCategories: ['access'], requireResidentApproval: false, requireIndependentApprover: true,
  sourceReference: 'Synthetic owner maintenance authority', observedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86400_000).toISOString() })
const details = (extra = {}) => ({ route: 'internal', vendorId: null, vendorVersion: null, internalTeam: 'Building maintenance',
  scopeOfWork: 'Replace the lobby tap washer', currency: 'USD', maximumCents: 10_000, includesAllCharges: true,
  accessRequirement: 'no_unit_entry', restrictions: [], reason: 'Staff reviewed scope and total cost', ...extra })
const vendorDetails = () => ({ name: 'Synthetic approved plumbing provider', categories: ['plumbing'], status: 'approved',
  phone: '+15555550101', email: null, serviceArea: 'Selected building', hours: 'Weekday business hours', emergencyCoverage: false,
  availability: 'unknown', availabilityObservedAt: null, availabilityValidUntil: null, expectedPricing: 'Quote per job',
  responseTargetMinutes: 60, preference: 0, restrictions: '', sourceReference: 'Synthetic property vendor directory',
  observedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86400_000).toISOString() })
async function createCase() {
  const serviceOptions = { user: 'staff-a', endpoint: '/api/resident-services' }
  const created = await save(intake({ requestOrigin: 'staff_observation', location: { kind: 'common_area', label: 'Lobby' }, accessNotes: '' }), serviceOptions)
  await save(triage(created.id, 1), serviceOptions)
  return created.id
}
async function prepare(caseId, extra = {}, options = {}) {
  return save({ action: 'prepare_plan', requestId: randomUUID(), caseId, expectedCaseVersion: 2, expectedPlanVersion: 0,
    policyVersion: 1, details: details(extra) }, { user: 'staff-a', ...options })
}
async function readPlan(caseId, options = {}) {
  const result = await request(`resource=plan&caseId=${caseId}`, options)
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.detail
}

test('planning reads preserve property isolation and ordinary staff cannot publish owner authority', async () => {
  const overview = await request('resource=overview', { user: 'staff-a' })
  assert.equal(overview.status, 200); assert.equal(overview.body.canPublishPolicy, false); assert.equal(overview.body.canManageVendors, false)
  assert.equal(overview.body.policy, null)
  assert.match(overview.headers.get('cache-control'), /no-store/)
  assert.equal((await request('resource=overview', { user: 'viewer-a' })).status, 403)
  assert.equal((await request('resource=overview', { actor: null })).status, 401)
  assert.equal((await request('resource=overview', { user: 'staff-a', property: 'property-a2' })).status, 403)
  assert.equal((await request('resource=overview', { org: 'organization-b' })).status, 403)
  await verifyOrganizationSession(runtime, actors['staff-a'].principal, password)
  assert.equal((await request('', { user: 'staff-a', body: { action: 'publish_policy', requestId: randomUUID(), expectedVersion: 0,
    details: policyDetails(), reason: 'Attempted staff policy publication' } })).status, 403)
})

test('owner policy publication needs fresh exact-session passkey assurance and keeps an exact retry receipt', async () => {
  const command = { action: 'publish_policy', requestId: randomUUID(), expectedVersion: 0, details: policyDetails(), reason: 'Owner reviewed total job limits' }
  const missing = await request('', { body: command })
  assert.equal(missing.status, 403); assert.equal(missing.body.code, 'planning_mfa_required')
  await verifyOrganizationSession(runtime, actors['owner-a'].principal, password)
  const saved = await save(command)
  assert.equal(saved.resource, 'policy'); assert.equal(saved.id, 'property-a1'); assert.equal(saved.version, 1); assert.equal(saved.outcome, 'saved')
  assert.equal((await save(command)).replayed, true)
  assert.equal((await request('', { body: { ...command, reason: 'A different command using the same key' } })).body.code, 'planning_request_conflict')
  const other = await request('resource=overview', { property: 'property-a2' })
  assert.equal(other.body.policy, null)
})

test('planning forms refuse origin, session, operation and service-token substitution before writes', async () => {
  const command = { action: 'save_vendor', requestId: randomUUID(), id: null, expectedVersion: 0, details: vendorDetails(), reason: 'Reviewed vendor' }
  for (const headers of [{ origin: 'https://foreign.invalid' }, { 'x-atrium-planning-form': tokens['/api/resident-services:owner-a:property-a1'] },
    { 'x-atrium-planning-action': 'publish_policy' }]) assert.ok((await request('', { body: command, headers })).status >= 400)
  const second = await login('owner-a')
  assert.equal((await request('', { actor: second, body: command })).status, 403)
  assert.equal((await request('resource=vendors')).body.vendors.length, 0)
  await runtime.sessions.revoke(second.principal, second.principal.sessionId)
})

test('staff plan reaches automatic internal authorization without claiming vendor execution', async () => {
  const caseId = await createCase(), saved = await prepare(caseId)
  assert.equal(saved.resource, 'plan'); assert.equal(saved.version, 1)
  const result = await readPlan(caseId, { user: 'staff-a' })
  assert.equal(result.assessment.tier, 'automatic'); assert.equal(result.assessment.spendingAuthorized, true)
  assert.equal(result.assessment.readiness, 'authorized_plan'); assert.equal(result.assessment.dispatchStatus, 'not_dispatched')
  assert.equal(result.assessment.entryAuthorized, false); assert.equal(result.assessment.notificationStatus, 'not_sent')
  assert.equal(result.history[0].kind, 'prepared')
  assert.equal((await request(`resource=plan&caseId=${caseId}`, { property: 'property-a2' })).status, 404)
  assert.equal((await request(`resource=history&caseId=${caseId}`, { user: 'owner-b', property: 'property-b1', org: 'organization-b' })).status, 404)
})

test('human approval binds one exact plan, records history and cannot be changed by a conflicting decision', async () => {
  const caseId = await createCase(), saved = await prepare(caseId, { maximumCents: 75_000 })
  assert.equal((await readPlan(caseId)).assessment.readiness, 'awaiting_owner')
  const command = { action: 'decide_plan', requestId: randomUUID(), caseId, planId: saved.id, expectedPlanVersion: 1,
    decision: 'approve', reason: 'Owner reviewed the complete scope and maximum cost' }
  assert.equal((await request('', { user: 'staff-a', body: command })).status, 403)
  const accepted = await save(command)
  assert.equal(accepted.version, 1); assert.equal(accepted.outcome, 'saved'); assert.equal((await save(command)).replayed, true)
  const approved = await readPlan(caseId)
  assert.equal(approved.assessment.spendingAuthorized, true); assert.equal(approved.decision.authorityCurrent, true)
  assert.equal(approved.decision.currentRole, 'owner')
  assert.deepEqual(approved.history.map(item => item.kind), ['approved', 'prepared'])
  const conflicting = await request('', { body: { ...command, requestId: randomUUID(), decision: 'reject' } })
  assert.equal(conflicting.status, 409)
})

test('new emergency in an approval attempt commits a safety hold and never an approval', async () => {
  const caseId = await createCase(), saved = await prepare(caseId, { maximumCents: 75_000 })
  const command = { action: 'decide_plan', requestId: randomUUID(), caseId, planId: saved.id, expectedPlanVersion: 1,
    decision: 'approve', reason: 'There is now a gas leak in the hallway' }
  const held = await save(command)
  assert.equal(held.outcome, 'emergency_held'); assert.equal(held.version, 2)
  const result = await readPlan(caseId)
  assert.equal(result.decision, null); assert.equal(result.assessment.tier, 'emergency')
  assert.equal(result.assessment.spendingAuthorized, false); assert.ok(result.plan.emergencyKinds.includes('gas'))
  assert.equal(result.history[0].kind, 'safety_hold'); assert.equal((await save(command)).replayed, true)
  const withdrawn = await save({ action: 'withdraw_plan', requestId: randomUUID(), caseId, planId: saved.id, expectedPlanVersion: 2,
    reason: 'Withdraw ordinary work while staff follows the emergency protocol' }, { user: 'staff-a' })
  assert.equal(withdrawn.version, 3)
})

test('vendor review is scoped and unknown availability stays visible after spending authorization', async () => {
  const v = await save({ action: 'save_vendor', requestId: randomUUID(), id: null, expectedVersion: 0, details: vendorDetails(), reason: 'Manager reviewed approved property vendor' })
  assert.equal(v.version, 1)
  const caseId = await createCase()
  await prepare(caseId, { route: 'vendor', vendorId: v.id, vendorVersion: 1, internalTeam: null })
  const result = await readPlan(caseId)
  assert.equal(result.assessment.spendingAuthorized, true); assert.equal(result.assessment.readiness, 'awaiting_vendor')
  assert.equal((await request(`resource=vendor&id=${v.id}`, { property: 'property-a2' })).status, 404)
  await save({ action: 'save_vendor', requestId: randomUUID(), id: v.id, expectedVersion: 1,
    details: { ...vendorDetails(), status: 'suspended' }, reason: 'Suspend vendor pending renewed approval' })
  assert.equal((await readPlan(caseId)).assessment.spendingAuthorized, false)
})

test('a case clarification invalidates the already approved plan and retains its history', async () => {
  const caseId = await createCase(), saved = await prepare(caseId, { maximumCents: 75_000 })
  await save({ action: 'decide_plan', requestId: randomUUID(), caseId, planId: saved.id, expectedPlanVersion: 1, decision: 'approve', reason: 'Owner approved exact scope' })
  await save({ action: 'update_context', requestId: randomUUID(), id: caseId, expectedVersion: 2, location: { kind: 'common_area', label: 'Second floor lounge' },
    residentId: null, note: 'Staff clarified the actual affected location' }, { user: 'staff-a', endpoint: '/api/resident-services' })
  const result = await readPlan(caseId)
  assert.equal(result.assessment.readiness, 'stale_plan'); assert.equal(result.assessment.spendingAuthorized, false)
  assert.ok(result.history.some(item => item.kind === 'approved'))
})

test('planning rejects malformed queries and oversized or invented commands', async () => {
  for (const q of ['resource=vendors&limit=0', 'resource=vendors&limit=51', 'resource=vendors&limit=1&limit=2',
    'resource=plan&caseId=missing&unexpected=true', 'resource=history&caseId=missing&beforeId=missing', 'resource=overview&userId=owner-b']) {
    assert.equal((await request(q)).status, 400, q)
  }
  assert.equal((await request('', { body: 'x'.repeat(25 * 1024) })).status, 400)
  assert.equal((await request('', { body: { action: 'dispatch_vendor', requestId: randomUUID() } })).status, 400)
})
