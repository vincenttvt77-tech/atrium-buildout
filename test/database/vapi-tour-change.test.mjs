import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { generateSlots } from '../../src/calendar/slots.ts'
import handler from '../../api/vapi.ts'

const env = { ...process.env }, fetchBefore = globalThis.fetch, now = new Date()
const secret = 'synthetic-tour-change-webhook-secret', phone = '+12025550199'
const settings = { ...defaultSettings(), minimumNoticeMinutes: 0, capacity: 3,
  hours: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, { openHour: 9, closeHour: 18 }])) }
const slots = generateSlots(now, { ...settings, timeZone: 'America/New_York' })
let db, runtime
before(async () => {
  db = await createFoundationTestDatabase()
  await seedFoundationTestDatabase(db.admin)
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: 'synthetic-tour-change-session-secret-never-live' })
  await db.admin.query("UPDATE atrium.properties SET time_zone='America/New_York'")
  for (const [org, property] of [['organization-a', 'property-a1'], ['organization-b', 'property-b1']]) {
    const bundle = { property: { id: property, organizationId: org, buildingName: property, timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: settings },
      inventory: [{ unitId: '12A', propertyId: property, floorPlanId: 'A', floor: 12, monthlyRent: 4000, availableFrom: now.toISOString().slice(0, 10), status: 'available' }],
      floorplans: [{ id: 'A', bedrooms: 1, bathrooms: 1, sqft: 800 }], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,$4,'Synthetic tour callback test',$4)`, [org, property, JSON.stringify(bundle), now.toISOString()])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [property])
  }
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('channel-b','vapi','synthetic-assistant-b','organization-b','property-b1','active',ARRAY['read','operate'])`)
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  process.env.VAPI_WEBHOOK_SECRET = secret
  globalThis.fetch = async () => { throw new Error('Native callback tests prohibit external network') }
})
beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.calendars,atrium.operational_documents,atrium.audit_events')
})
after(async () => {
  globalThis.fetch = fetchBefore
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  await db?.close()
})
async function invoke(message, authentication = secret) {
  const res = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
  await handler({ method: 'POST', atriumRuntime: runtime, headers: { 'x-vapi-secret': authentication }, body: { message } }, res)
  return res
}
const call = (id, assistant = 'synthetic-assistant-a') => ({ id, assistantId: assistant, customer: { number: phone } })
const book = (index, id = 'book') => ({ id, name: 'book_tour', arguments: { slotId: slots[index].slotId, unitId: '12A', prospectName: 'Synthetic Visitor' } })
const tools = (id, list, assistant) => invoke({ type: 'tool-calls', call: call(id, assistant), toolCallList: list })
const calendarRows = async () => (await db.admin.query('SELECT property_id,state FROM atrium.calendars ORDER BY property_id')).rows
const requestRows = async () => (await db.admin.query("SELECT property_id,value FROM atrium.operational_documents WHERE key LIKE 'tour-change:%' ORDER BY property_id")).rows

test('real database callback preserves original, scopes same phone/call across properties, and survives finished-call retries', async () => {
  assert.equal((await tools('original', [book(1)])).statusCode, 200)
  const original = (await calendarRows())[0].state.bookings[0]
  const transcript = 'I need to reschedule my tour to a different time.'
  const request = [book(5), { id: 'contact', name: 'capture_contact', arguments: { excerpt: transcript, phone, requestType: 'tour_change' } }]
  const changed = await tools('same-callback', request)
  assert.equal(changed.statusCode, 200, JSON.stringify(changed.body))
  assert.match(changed.body.results[0].result, /staff review/)
  assert.equal((await tools('same-callback', [book(5)], 'synthetic-assistant-b')).statusCode, 200)
  assert.equal((await requestRows()).length, 1)
  assert.equal((await requestRows())[0].property_id, 'property-a1')
  assert.deepEqual((await calendarRows())[0].state.bookings, [original])
  assert.equal((await calendarRows())[1].state.bookings.length, 1)
  for (let i = 0; i < 2; i++) assert.equal((await invoke({ type: 'end-of-call-report', call: call('same-callback') })).statusCode, 200)
  assert.equal((await tools('same-callback', request)).statusCode, 200)
  assert.equal((await requestRows()).length, 1)
  const record = (await requestRows())[0].value
  assert.equal(record.identityVerified, false); assert.equal(record.notificationStatus, 'not_sent')
  const profile = (await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-a1' AND key=$1", [`lead:${phone}`])).rows[0].value
  assert.equal(profile.escalations.filter(e => e.trigger === 'tour_change').length, 1)
})

test('real database competing calls with one phone produce one future booking and one staff request', async () => {
  const results = await Promise.all([tools('competing-one', [book(1)]), tools('competing-two', [book(5)])])
  assert.equal(results.filter(r => /tour is confirmed/.test(r.body.results[0].result)).length, 1)
  assert.equal(results.filter(r => /staff review/.test(r.body.results[0].result)).length, 1)
  assert.equal((await calendarRows())[0].state.bookings.length, 1)
  assert.equal((await requestRows()).length, 1)
})

test('unverified webhook cannot write a request or calendar hold', async () => {
  const result = await invoke({ type: 'transcript', transcriptType: 'final', role: 'user', call: call('unverified'), transcript: 'Please move my tour.' }, 'wrong-secret')
  assert.equal(result.statusCode, 401)
  assert.deepEqual(await calendarRows(), [])
  assert.deepEqual(await requestRows(), [])
})
