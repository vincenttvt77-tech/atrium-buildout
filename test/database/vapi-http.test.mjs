import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createHash } from 'node:crypto'
import handler from '../../api/vapi.ts'
import syncHandler from '../../api/vapi-sync.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { mintUserSession } from '../../src/auth/index.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'

const originalEnv = { ...process.env }, originalFetch = globalThis.fetch
const NOW = new Date()
const day = new Date(NOW.getTime() + 3 * 86400000).toISOString().slice(0, 10)
const sourceAt = new Date(NOW.getTime() - 60000).toISOString()
const publishedAt = new Date(NOW.getTime() - 30000).toISOString()
const secret = 'synthetic-webhook-secret-for-http-contract'
const sessionSecret = 'synthetic-session-secret-for-http-contract-tests'
let db, runtime, server, port, cookies, runtimeLookups = 0
const upstreamRequests = []

function propertyBundle(organizationId, propertyId, timeZone, jurisdiction, rent) {
  const tourSettings = { ...defaultSettings(), minimumNoticeMinutes: 0, capacity: 2,
    hours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { openHour: 10, closeHour: 18 }])) }
  return {
    property: { id: propertyId, organizationId, buildingName: `Synthetic ${propertyId}`, timeZone, jurisdiction,
      tourSettings, tourCapacityPerSlot: 2 },
    inventory: [{ unitId: '4A', propertyId, floorPlanId: 'one-bed', floor: 4,
      monthlyRent: rent, availableFrom: NOW.toISOString().slice(0, 10), status: 'available' },
    { unitId: '9l', propertyId, floorPlanId: 'one-bed', floor: 9,
      monthlyRent: rent, availableFrom: `${NOW.getUTCFullYear() + 1}-08-01`, status: 'available' }],
    floorplans: [{ id: 'one-bed', bedrooms: 1, bathrooms: 1, sqft: 750 }],
    knowledge: [{ id: 'hours', propertyId, topic: 'hours', question: 'When is the leasing office open?',
      answer: `The ${jurisdiction} leasing desk for ${propertyId} is open from ten until six.`,
      keywords: ['leasing', 'office', 'hours'], propertyScope: [propertyId], jurisdictionScope: [jurisdiction],
      status: 'published', version: 1, source: 'Synthetic approved policy', ownerId: 'test-owner', approvedBy: 'test-reviewer',
      approvedAt: sourceAt, reviewBy: new Date(NOW.getTime() + 365 * 86400000).toISOString() }],
  }
}

async function publish(organizationId, propertyId, timeZone, jurisdiction, rent, inventoryReadAt = sourceAt) {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query('UPDATE atrium.properties SET time_zone=$2 WHERE id=$1', [propertyId, timeZone])
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,$4,'synthetic-http-test',$5)`,
    [organizationId, propertyId, JSON.stringify(propertyBundle(organizationId, propertyId, timeZone, jurisdiction, rent)), inventoryReadAt, publishedAt])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [propertyId])
    await db.admin.query('COMMIT')
  } catch (error) { await db.admin.query('ROLLBACK'); throw error }
}

before(async () => {
  db = await createFoundationTestDatabase()
  const credentials = await seedFoundationTestDatabase(db.admin)
  await publish('organization-a', 'property-a1', 'America/Chicago', 'IL', 2800)
  await publish('organization-a', 'property-a2', 'America/Chicago', 'IL', 9876, new Date(NOW.getTime() - 3600000).toISOString())
  await publish('organization-b', 'property-b1', 'America/Los_Angeles', 'CA', 4200)
  await publish('organization-b', 'property-b2', 'Pacific/Honolulu', 'HI', 5100)
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('channel-b','vapi','synthetic-assistant-b','organization-b','property-b1','active',ARRAY['read','operate'])`)
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('channel-stale','vapi','synthetic-assistant-stale','organization-a','property-a2','active',ARRAY['read','operate'])`)
  runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app: db.app, auth: db.auth, sessionSecret })
  cookies = {}
  for (const username of ['owner-a', 'owner-b', 'viewer-a']) {
    const verified = await runtime.authorization.authenticatePassword(username, credentials.password)
    const principal = await runtime.sessions.start(verified, { label: 'Synthetic Vapi HTTP session' })
    await verifyMfaSession(runtime, principal, credentials.password)
    cookies[username] = `atrium_ops=${mintUserSession(principal, new Date(), sessionSecret)}`
  }
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  process.env.VAPI_WEBHOOK_SECRET = secret
  process.env.VAPI_PRIVATE_KEY = 'synthetic-key-never-sent-over-network'
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url))
    assert.equal(target.origin, 'https://api.vapi.ai')
    assert.equal(options?.method ?? 'GET', 'GET', 'No live assistant writes are permitted in these tests')
    const assistantId = target.searchParams.get('assistantId')
    assert.ok(assistantId, 'Property history must always include an assistant allowlist')
    upstreamRequests.push(assistantId)
    return new Response(JSON.stringify([
      { id: `history-${assistantId}`, assistantId, transcript: `Only ${assistantId}`, startedAt: sourceAt },
      { id: 'foreign-provider-call', assistantId: 'unbound-foreign-assistant', transcript: 'Must never be exposed', startedAt: sourceAt },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      req.body = raw || undefined
      Object.defineProperty(req, 'atriumRuntime', { get() { runtimeLookups++; return runtime } })
      res.status = function (code) { this.statusCode = code; return this }
      res.json = function (value) { this.setHeader('content-type', 'application/json'); this.end(JSON.stringify(value)); return this }
      await (req.url === '/api/vapi-sync' ? syncHandler : handler)(req, res)
    } catch (error) {
      res.statusCode = 500; res.end(JSON.stringify({ testHarnessError: error.message }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})
after(async () => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (server) await new Promise(resolve => server.close(resolve))
  if (db) await db.close()
})

function http(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }) } catch (error) { reject(error) } })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
function post(assistantId, callId, tools, headers = {}) {
  return http('POST', '/api/vapi', { organizationId: 'organization-b', propertyId: 'property-b1',
    message: { type: 'tool-calls', call: { id: callId, assistantId, customer: { number: '+15555550101' } }, toolCallList: tools } },
  { 'x-vapi-secret': secret, ...headers })
}
const tool = (name, args) => ({ id: name, name, arguments: args })
const headers = (username = 'owner-a', propertyId = 'property-a1', organizationId = 'organization-a') => ({
  cookie: cookies[username], 'x-atrium-organization-id': organizationId, 'x-atrium-property-id': propertyId, 'x-atrium-config-version': '1',
})

test('HTTP webhook secrets are checked before any runtime or SQL access', async () => {
  const before = runtimeLookups
  const rejected = await post('synthetic-assistant-a', 'unverified', [tool('answer_question', { question: 'I smell gas' })], { 'x-vapi-secret': 'wrong' })
  assert.equal(rejected.status, 401)
  assert.equal(rejected.body.safetyInstruction, undefined)
  assert.equal(runtimeLookups, before)
  delete process.env.VAPI_WEBHOOK_SECRET
  try { assert.equal((await post('synthetic-assistant-a', 'unconfigured', [])).status, 503) }
  finally { process.env.VAPI_WEBHOOK_SECRET = secret }
  assert.equal(runtimeLookups, before)
})

test('HTTP bearer takes precedence over stale phone credentials and persists in the bound property', async () => {
  const response = await post('synthetic-assistant-a', 'bearer-stale-legacy',
    [tool('capture_contact', { name: 'Bearer Visitor', excerpt: 'My name is Bearer Visitor' })],
    { authorization: `Bearer ${secret}`, 'x-vapi-secret': 'stale-phone-secret', 'x-vapi-signature': 'stale-signature' })
  assert.equal(response.status, 200)
  assert.equal(response.body.scope.propertyId, 'property-a1')
  const records = (await db.admin.query("SELECT property_id,value FROM atrium.operational_documents WHERE key='call:bearer-stale-legacy'")).rows
  assert.deepEqual(records.map(row => [row.property_id, row.value.name]), [['property-a1', 'Bearer Visitor']])
})

test('HTTP invalid, empty and multiple Authorization never fall back to a valid legacy credential', async () => {
  const before = runtimeLookups
  for (const authorization of ['Bearer wrong', '', 'Bearer ', `Basic ${secret}`,
    `Bearer ${secret}, Bearer wrong`, [`Bearer ${secret}`, 'Bearer wrong'], [`Bearer ${secret}`, `Bearer ${secret}`]]) {
    const response = await post('synthetic-assistant-a', 'rejected-bearer',
      [tool('capture_contact', { name: 'Rejected Visitor', excerpt: 'My name is Rejected Visitor' })],
      { authorization, 'x-vapi-signature': secret })
    assert.equal(response.status, 401)
    assert.deepEqual(response.body, { error: 'unauthorized' })
    assert.equal(runtimeLookups, before)
  }
  const records = await db.admin.query("SELECT 1 FROM atrium.operational_documents WHERE key='call:rejected-bearer'")
  assert.equal(records.rowCount, 0)
})

test('HTTP absent Authorization preserves both legacy credential headers and refuses unsigned calls', async () => {
  const body = { message: { type: 'tool-calls', call: { id: 'legacy-secret-compat', assistantId: 'synthetic-assistant-a' },
    toolCallList: [tool('capture_contact', { name: 'Legacy Visitor', excerpt: 'My name is Legacy Visitor' })] } }
  for (const headers of [{ 'x-vapi-secret': secret }, { 'x-vapi-signature': secret }]) {
    const response = await http('POST', '/api/vapi', body, headers)
    assert.equal(response.status, 200)
    assert.equal(response.body.scope.propertyId, 'property-a1')
  }
  const before = runtimeLookups
  assert.equal((await http('POST', '/api/vapi', body)).status, 401)
  assert.equal(runtimeLookups, before)
})

test('concurrent properties with the same call and apartment IDs use separate facts, knowledge and stored state', async () => {
  const tools = name => [tool('capture_contact', { name, excerpt: `My name is ${name}` }),
    tool('check_availability', { unitId: '4A' }), tool('answer_question', { topic: 'hours', question: 'When is the leasing office open?' })]
  const [a, b] = await Promise.all([
    post('synthetic-assistant-a', 'same-call-id', tools('Alpha Visitor')),
    post('synthetic-assistant-b', 'same-call-id', tools('Beta Visitor')),
  ])
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.equal(a.body.scope.propertyId, 'property-a1'); assert.equal(b.body.scope.propertyId, 'property-b1')
  assert.match(a.body.results[1].result, /2,800|two thousand eight hundred/i)
  assert.doesNotMatch(a.body.results[1].result, /4,200|four thousand two hundred/i)
  assert.match(b.body.results[1].result, /4,200|four thousand two hundred/i)
  assert.match(a.body.results[2].result, /IL leasing desk for property-a1/)
  assert.match(b.body.results[2].result, /CA leasing desk for property-b1/)
  const records = (await db.admin.query("SELECT property_id,value FROM atrium.operational_documents WHERE key='call:same-call-id' ORDER BY property_id")).rows
  assert.deepEqual(records.map(row => [row.property_id, row.value.name, row.value.routing.channelBindingId]),
    [['property-a1', 'Alpha Visitor', 'channel-a'], ['property-b1', 'Beta Visitor', 'channel-b']])
})

test('HTTP tour tools use each property timezone, settings and inventory without accepting body overrides', async () => {
  const offeredA = await post('synthetic-assistant-a', 'tour-a', [tool('list_tour_slots', { preferredDate: day, unitId: '4A', timeZone: 'Pacific/Honolulu' })])
  const offeredB = await post('synthetic-assistant-b', 'tour-b', [tool('list_tour_slots', { preferredDate: day, unitId: '4A' })])
  assert.equal(offeredA.status, 200); assert.equal(offeredB.status, 200)
  const aSlot = offeredA.body.results[0].result.match(/slot-[0-9T:-]+/)[0]
  const bSlot = offeredB.body.results[0].result.match(/slot-[0-9T:-]+/)[0]
  assert.equal(Date.parse(bSlot.slice(5) + ':00Z') - Date.parse(aSlot.slice(5) + ':00Z'), 2 * 3600000)
  assert.match(offeredA.body.results[0].result, /10:00 AM/)
  assert.match(offeredB.body.results[0].result, /10:00 AM/)
  const booked = await post('synthetic-assistant-b', 'tour-b', [tool('book_tour', { slotId: bSlot, unitId: '4A', prospectName: 'Beta Visitor' })])
  assert.equal(booked.status, 200)
  assert.match(booked.body.results[0].result, /tour is confirmed|10:00 AM/)
  const states = (await db.admin.query('SELECT property_id,state FROM atrium.calendars ORDER BY property_id')).rows
  assert.equal(states.find(row => row.property_id === 'property-b1').state.bookings.length, 1)
  assert.equal(states.find(row => row.property_id === 'property-a1')?.state.bookings.length ?? 0, 0)
  const unknown = await post('synthetic-assistant-b', 'bad-unit', [tool('list_tour_slots', { preferredDate: day, unitId: '08E' })])
  assert.match(unknown.body.results[0].result, /not in the building inventory/)
})

test('finished-call HTTP projection persists its original property, channel and timezone provenance', async () => {
  const response = await http('POST', '/api/vapi', { message: { type: 'end-of-call-report',
    call: { id: 'same-call-id', assistantId: 'synthetic-assistant-b', customer: { number: '+15555550101' } },
    endedAt: new Date().toISOString() } }, { 'x-vapi-secret': secret })
  assert.equal(response.status, 200)
  const receipt = (await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-b1' AND key='call-receipt:same-call-id'")).rows[0].value
  assert.equal(receipt.status, 'complete')
  assert.equal(receipt.timeZone, 'America/Los_Angeles')
  assert.equal(receipt.scope.organizationId, 'organization-b')
  assert.equal(receipt.scope.channelBindingId, 'channel-b')
  assert.equal(receipt.scope.configurationVersion, 1)
})

test('a non-New-York property preserves a June 1 move-in date and canonical mixed-case unit IDs', async () => {
  const quote = await post('synthetic-assistant-b', 'date-warning', [tool('check_availability', {
    unitId: '9L', moveIn: `${NOW.getUTCFullYear() + 1}-06-01`,
  })])
  assert.equal(quote.status, 200)
  assert.match(quote.body.results[0].result, /not free until August 1, which is later than the June 1 they mentioned/)
  assert.doesNotMatch(quote.body.results[0].result, /May 31|July 31/)
  const slots = await post('synthetic-assistant-b', 'mixed-case-unit', [tool('list_tour_slots', { unitId: '9L', preferredDate: day })])
  assert.equal(slots.status, 200)
  assert.match(slots.body.results[0].result, /Real open tour times for residence 9l/)
})

test('a fixed stale database snapshot withholds prices and availability for generic, named-unit and floor-plan requests', async () => {
  const response = await post('synthetic-assistant-stale', 'stale-inventory', [
    { id: 'generic', name: 'check_availability', arguments: { bedrooms: 'one bedroom', budget: 'ten thousand dollars' } },
    { id: 'unit', name: 'check_availability', arguments: { unitId: '4A' } },
    { id: 'plan', name: 'check_availability', arguments: { unitId: 'one-bed' } },
  ])
  assert.equal(response.status, 200)
  assert.equal(response.body.scope.propertyId, 'property-a2')
  assert.equal(response.body.results.length, 3)
  for (const result of response.body.results) {
    assert.match(result.result, /cannot verify current rent, concessions, availability, or move-in dates/)
    assert.doesNotMatch(result.result, /\$|9,876|nine thousand|Residence 4A is available|open now|pulling up the live list/i)
  }
  const state = (await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-a2' AND key='call:stale-inventory'")).rows[0].value
  assert.deepEqual(state.unitsDiscussed, [])
  assert.equal(state.qualification.budget.value.maxMonthly, 10000)
  const persisted = (await db.admin.query("SELECT inventory_read_at FROM atrium.property_configurations WHERE property_id='property-a2' AND version=1")).rows[0].inventory_read_at
  assert.equal(persisted.toISOString(), new Date(NOW.getTime() - 3600000).toISOString())
})

test('ops history is property allowlisted, invalidates on binding changes and never falls back for unbound properties', async () => {
  const a = await http('GET', '/api/vapi', undefined, headers())
  assert.equal(a.status, 200)
  assert.deepEqual(a.body.calls.map(call => call.id), ['history-synthetic-assistant-a'])
  assert.ok(a.body.events.every(event => event.name !== 'Beta Visitor'))
  const before = upstreamRequests.length
  await db.admin.query("UPDATE atrium.channel_bindings SET permission_version=permission_version+1 WHERE id='channel-a'")
  assert.equal((await http('GET', '/api/vapi', undefined, headers())).status, 200)
  assert.equal(upstreamRequests.length, before + 1)
  const unbound = await http('GET', '/api/vapi', undefined, headers('owner-b', 'property-b2', 'organization-b'))
  assert.equal(unbound.status, 200); assert.deepEqual(unbound.body.calls, [])
  assert.equal(upstreamRequests.length, before + 1)
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=permission_version+1 WHERE id='channel-a'")
  try {
    const disconnected = await http('GET', '/api/vapi', undefined, headers())
    assert.equal(disconnected.status, 200); assert.deepEqual(disconnected.body.calls, [])
    assert.equal((await post('synthetic-assistant-a', 'deactivated', [])).status, 403)
  } finally { await db.admin.query("UPDATE atrium.channel_bindings SET status='active',permission_version=permission_version+1 WHERE id='channel-a'") }
})

test('ops runtime resolution carries the same request identity as the HTTP response', async () => {
  const load = runtime.loadUserProperty
  let requestId
  runtime.loadUserProperty = function (...args) {
    requestId = args[3]
    return load.apply(this, args)
  }
  try {
    const response = await http('GET', '/api/vapi', undefined, headers())
    assert.equal(response.status, 200)
    assert.ok(requestId)
    assert.equal(requestId, response.headers['x-request-id'])
  } finally { runtime.loadUserProperty = load }
})

for (const change of ['membership', 'binding']) test(`a ${change} revoked during an upstream history fetch prevents the response from releasing calls`, { timeout: 10000 }, async () => {
  // A new fingerprint forces a fetch rather than a warm cached response.
  await db.admin.query("UPDATE atrium.channel_bindings SET permission_version=permission_version+1 WHERE id='channel-b'")
  const fetch = globalThis.fetch
  let release, reached
  const blocked = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { reached = resolve })
  globalThis.fetch = async (...args) => {
    reached()
    await blocked
    return fetch(...args)
  }
  let pending
  try {
    pending = http('GET', '/api/vapi', undefined, headers('owner-b', 'property-b1', 'organization-b'))
    await entered
    if (change === 'membership') await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id='member-owner-b'")
    else await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=permission_version+1 WHERE id='channel-b'")
    release()
    const response = await pending
    assert.equal(response.status, change === 'membership' ? 403 : 409)
    assert.equal(response.body.calls, undefined)
    assert.equal(response.body.events, undefined)
    assert.doesNotMatch(JSON.stringify(response.body), /history-synthetic|Only synthetic|Beta Visitor/)
  } finally {
    release()
    await pending?.catch(() => {})
    globalThis.fetch = fetch
    if (change === 'membership') await db.admin.query("UPDATE atrium.memberships SET status='active',permission_version=permission_version+1 WHERE id='member-owner-b'")
    else await db.admin.query("UPDATE atrium.channel_bindings SET status='active',permission_version=permission_version+1 WHERE id='channel-b'")
  }
})

test('unknown bindings, call identity changes and revoked staff cannot reuse another property or cached history', async () => {
  assert.equal((await post('unknown-assistant', 'unknown-call', [])).status, 403)
  assert.equal((await http('GET', '/api/vapi', undefined, headers('owner-a', 'property-b1', 'organization-b'))).status, 403)
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('channel-other-a','vapi','synthetic-other-a','organization-a','property-a1','active',ARRAY['read','operate'])`)
  assert.equal((await post('synthetic-other-a', 'same-call-id', [tool('capture_contact', { name: 'Replacement', excerpt: 'Replacement' })])).status, 409)
  assert.equal((await db.admin.query("SELECT value->>'name' AS name FROM atrium.operational_documents WHERE property_id='property-a1' AND key='call:same-call-id'")).rows[0].name, 'Alpha Visitor')
  const before = upstreamRequests.length
  await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id='member-owner-a'")
  try { assert.equal((await http('GET', '/api/vapi', undefined, headers())).status, 403) }
  finally { await db.admin.query("UPDATE atrium.memberships SET status='active',permission_version=permission_version+1 WHERE id='member-owner-a'") }
  assert.equal(upstreamRequests.length, before)
})

test('database assistant sync checks configure permission and never publishes the bundled assistant', async () => {
  const before = upstreamRequests.length
  assert.equal((await http('POST', '/api/vapi-sync', {}, headers('viewer-a'))).status, 403)
  const response = await http('POST', '/api/vapi-sync', {}, headers('owner-b', 'property-b1', 'organization-b'))
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'property_assistant_publish_unavailable')
  assert.equal(upstreamRequests.length, before)
})

test('database outages produce sanitized retryable failures rather than demo facts or successful tools', async () => {
  const transaction = db.app.transaction
  db.app.transaction = async () => { throw new Error('postgres://private-user:private-password@unavailable.example/database') }
  try {
    const response = await post('synthetic-assistant-b', 'outage-call', [tool('check_availability', { unitId: '4A' })])
    assert.equal(response.status, 503)
    assert.equal(response.body.code, 'workspace_unavailable')
    assert.doesNotMatch(JSON.stringify(response.body), /private-password|unavailable\.example|Larkin|4,200/)
    const policy = await post('synthetic-assistant-b', 'outage-policy', [tool('answer_question', {
      question: 'Are pets allowed, is there a fire pit, and can I smoke in my apartment?',
    })])
    assert.equal(policy.status, 503)
    assert.equal(policy.body.code, 'workspace_unavailable')
    assert.equal(policy.body.safetyInstruction, undefined)
  } finally { db.app.transaction = transaction }
})

test('verified emergency reports retain generic safety guidance during a database outage without confirming actions', async () => {
  const transaction = db.app.transaction
  db.app.transaction = async () => { throw new Error('postgres://private-user:private-password@unavailable.example/database') }
  try {
    const response = await post('synthetic-assistant-b', 'outage-emergency', [
      tool('book_tour', { unitId: '4A', slotId: 'slot-2032-06-01T17:00' }),
      tool('unknown_tool', '{"evidence":{"question":"I smell \\u0067as"'),
    ])
    assert.equal(response.status, 503)
    assert.equal(response.body.code, 'emergency_persistence_unavailable')
    assert.equal(response.body.retryable, true)
    assert.match(response.body.safetyInstruction, /leave the apartment and building/)
    assert.deepEqual(response.body.results.map(result => result.toolCallId), ['book_tour', 'unknown_tool'])
    for (const result of response.body.results) {
      assert.match(result.result, /call 911/)
      assert.match(result.result, /I have not contacted emergency services or building staff/)
      assert.match(result.result, /This requested action was not confirmed/)
    }
    assert.doesNotMatch(JSON.stringify(response.body), /private-password|unavailable\.example|Larkin|4,200|property-b1/)
    const transcript = await http('POST', '/api/vapi', { message: { type: 'transcript', role: 'user', transcriptType: 'final',
      transcript: 'My apartment is flooding', call: { id: 'outage-transcript', assistantId: 'synthetic-assistant-b' } } }, { 'x-vapi-secret': secret })
    assert.equal(transcript.status, 503)
    assert.match(transcript.body.safetyInstruction, /Stay out of the water/)
  } finally { db.app.transaction = transaction }
  assert.equal((await db.admin.query("SELECT count(*) AS n FROM atrium.operational_documents WHERE key IN ('call:outage-emergency','call:outage-transcript')")).rows[0].n, '0')
})

test('initial call-record failure and failed routing cannot suppress guidance or expose property data', async () => {
  const transaction = db.app.transaction
  db.app.transaction = function (context, work) {
    return transaction.call(this, context, async client => {
      const guarded = Object.create(client)
      guarded.query = (...args) => {
        if (/INSERT INTO atrium\.operational_documents/.test(String(args[0]))) throw new Error('Synthetic call write unavailable')
        return client.query(...args)
      }
      return work(guarded)
    })
  }
  try {
    const response = await post('synthetic-assistant-b', 'claim-emergency', [tool('answer_question', { question: 'I smell gas' })])
    assert.equal(response.status, 503)
    assert.match(response.body.safetyInstruction, /call 911/)
    assert.equal(response.body.scope, undefined)
  } finally { db.app.transaction = transaction }
  for (const assistantId of ['unknown-assistant', 'invalid assistant']) {
    const response = await post(assistantId, 'unbound-emergency', [tool('answer_question', { question: 'I smell gas' })])
    assert.equal(response.status, 503)
    assert.match(response.body.safetyInstruction, /call 911/)
    assert.equal(response.body.scope, undefined)
    assert.doesNotMatch(JSON.stringify(response.body), /Larkin|4,200|property-b1/)
  }
  assert.equal((await db.admin.query("SELECT count(*) AS n FROM atrium.operational_documents WHERE key IN ('call:claim-emergency','call:unbound-emergency')")).rows[0].n, '0')
})

test('invalid database runtime selection fails closed at both HTTP routes without falling back to demo auth', async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'invalid'
  const before = runtimeLookups
  try {
    for (const path of ['/api/vapi', '/api/vapi-sync']) {
      const response = await http('POST', path, {}, headers())
      assert.equal(response.status, 503)
      assert.equal(response.body.code, 'workspace_unavailable')
    }
  } finally { process.env.ATRIUM_RUNTIME_MODE = 'postgres' }
  assert.equal(runtimeLookups, before)
})

test('finished-call projection failure rolls back receipt/profile/followups and leaves the accepted call ending', async () => {
  const callId = 'atomic-finish-failure', phone = '+15555550193'
  const captured = await post('synthetic-assistant-b', callId, [
    tool('capture_contact', { name: 'Atomic Fixture', phone, excerpt: 'My name is Atomic Fixture and that is my callback number.' }),
    tool('capture_loss_reason', { kind: 'priced_out', detail: 'The stated rent exceeds my budget', evidence: 'That rent is above my budget' }),
  ])
  assert.equal(captured.status,200)
  const transaction = db.app.transaction
  let failed = 0
  db.app.transaction = function (context, work) {
    return transaction.call(this, context, async client => {
      const guarded=Object.create(client)
      guarded.query=(...args)=>{
        if (/INSERT INTO atrium\.operational_documents/.test(String(args[0])) && String(args[1]?.[2]).startsWith('followup:')) {
          failed++; throw new Error('Synthetic follow-up projection failure')
        }
        return client.query(...args)
      }
      return work(guarded)
    })
  }
  const endedAt=NOW.toISOString()
  let response
  try { response=await http('POST','/api/vapi',{message:{type:'end-of-call-report',call:{id:callId,assistantId:'synthetic-assistant-b'},endedAt}},{'x-vapi-secret':secret}) }
  finally { db.app.transaction=transaction }
  assert.equal(response.status,503)
  assert.equal(failed,1)
  const call=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-b1' AND key=$1",[`call:${callId}`])).rows[0].value
  assert.equal(call.work.phase,'ending')
  assert.equal(call.completedAt,undefined)
  assert.equal(call.phone,phone)
  const rolledBack=(await db.admin.query("SELECT key FROM atrium.operational_documents WHERE property_id='property-b1' AND (key=$1 OR key=$2 OR value->>'createdFromCall'=$3)",[`call-receipt:${callId}`,`lead:${phone}`,callId])).rows
  assert.deepEqual(rolledBack,[])
  const failureAudit=(await db.admin.query('SELECT record_key FROM atrium.audit_events WHERE request_id=$1',[response.headers['x-request-id']])).rows
  assert.ok(failureAudit.length>0)
  assert.ok(failureAudit.every(row=>row.record_key===`sha256:${createHash('sha256').update(`call:${callId}`).digest('hex')}`),
    'only durable call admission/ending audit may survive failed projection')
  // Retry omits all report dates/contact; the first accepted event remains authoritative.
  const retry=await http('POST','/api/vapi',{message:{type:'end-of-call-report',call:{id:callId,assistantId:'synthetic-assistant-b'}}},{'x-vapi-secret':secret})
  assert.equal(retry.status,200)
  const projected=(await db.admin.query(`SELECT key,value,xmin::text AS xid FROM atrium.operational_documents
    WHERE property_id='property-b1' AND (key=$1 OR key=$2 OR key=$3 OR value->>'createdFromCall'=$4)`,
  [`call:${callId}`,`call-receipt:${callId}`,`lead:${phone}`,callId])).rows
  assert.ok(projected.length>=4)
  assert.equal(new Set(projected.map(row=>row.xid)).size,1)
  const complete=projected.find(row=>row.key===`call:${callId}`).value
  assert.equal(complete.work.phase,'complete')
  assert.equal(complete.completedAt,endedAt)
  assert.equal(complete.work.intents.length,2)
  assert.equal(projected.find(row=>row.key===`call-receipt:${callId}`).value.outcome,null)
  assert.equal(projected.find(row=>row.key===`lead:${phone}`).value.calls[0].at,endedAt)
  const projectionAudit=(await db.admin.query("SELECT xmin::text AS xid FROM atrium.audit_events WHERE request_id=$1",[retry.headers['x-request-id']])).rows
  assert.ok(projectionAudit.filter(row=>row.xid===projected[0].xid).length>=5)
})

test('completed PostgreSQL calls retain exact tool result cache and reject contradictory report timestamps', async () => {
  const callId='atomic-finish-cache', args={name:'Cached Fixture',phone:'+15555550194',excerpt:'My name is Cached Fixture and this is my number.'}
  const original=await post('synthetic-assistant-b',callId,[tool('capture_contact',args)])
  assert.equal(original.status,200)
  const end={message:{type:'end-of-call-report',call:{id:callId,assistantId:'synthetic-assistant-b'},endedAt:NOW.toISOString()}}
  assert.equal((await http('POST','/api/vapi',end,{'x-vapi-secret':secret})).status,200)
  const duplicate=await post('synthetic-assistant-b',callId,[tool('capture_contact',args)])
  assert.equal(duplicate.status,200)
  assert.deepEqual(duplicate.body.results,original.body.results)
  const changed=structuredClone(end)
  changed.message.endedAt=new Date(NOW.getTime()+60000).toISOString()
  assert.equal((await http('POST','/api/vapi',changed,{'x-vapi-secret':secret})).status,409)
  const profile=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-b1' AND key='lead:+15555550194'")).rows[0].value
  assert.equal(profile.calls.length,1)
  assert.equal(profile.calls[0].at,NOW.toISOString())
})
