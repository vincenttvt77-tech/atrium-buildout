import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { mintUserSession } from '../../src/auth/index.ts'
import { OPS_COOKIE } from '../../src/ops/session.ts'
import { PostgresCalendarStore } from '../../src/database/operations.ts'
import { createCalendarHandler } from '../../api/calendar.ts'
import { rescheduleBooking, completeRescheduleProjection } from '../../src/calendar/reschedule.ts'
import { reconcileRescheduledTour } from '../../src/leads/reschedule.ts'
import { emptyProfile } from '../../src/leads/profile.ts'

const now = new Date('2032-06-01T10:00:00Z')
const originalMode = process.env.ATRIUM_RUNTIME_MODE
const properties = [['organization-a', 'property-a1', 'America/New_York', 'NY'], ['organization-a', 'property-a2', 'America/Chicago', 'IL'],
  ['organization-b', 'property-b1', 'America/Los_Angeles', 'CA'], ['organization-b', 'property-b2', 'Pacific/Honolulu', 'HI']]
const settings = { capacity: 1, slotMinutes: 30, startIntervalMinutes: 15, bufferMinutes: 0, minimumNoticeMinutes: 0,
  bookingWindowDays: null, sameUnitPolicy: 'exclusive', hours: { 1: { openHour: 9, closeHour: 18 }, 2: { openHour: 9, closeHour: 18 }, 3: { openHour: 9, closeHour: 18 }, 4: { openHour: 9, closeHour: 18 }, 5: { openHour: 9, closeHour: 18 } } }
const options = { ...settings, timeZone: 'America/New_York', unitIds: ['12A', '12B'] }
const booking = { externalId: 'same-external-booking', slotId: 'slot-2032-06-01T14:00', startsAt: '2032-06-01T14:00:00.000Z', endsAt: '2032-06-01T14:30:00.000Z',
  unitId: '12A', prospectPhone: '+12025550101', prospectName: 'Synthetic visitor', prospectEmail: 'visitor@example.com', interactionId: 'same-call', bookedAt: '2032-05-25T14:00:00.000Z' }
const input = { action: 'reschedule', externalId: booking.externalId, requestId: 'native-reschedule-one', expectedRevision: 0, slotId: 'slot-2032-06-01T14:15', unitId: '12A' }
const handler = createCalendarHandler({ now: () => now })
let db, runtime, password
before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('hex') })
  for (const [org, property, timeZone, jurisdiction] of properties) for (const version of [1, 2]) {
    const bundle = { property: { id: property, organizationId: org, buildingName: property, timeZone, jurisdiction, tourSettings: settings },
      floorplans: [{ id: 'A', name: 'Synthetic A', bedrooms: 1, bathrooms: 1, sqft: 800, description: 'Synthetic test layout', features: [] }],
      inventory: ['12A', '12B'].map(unitId => ({ unitId, floorPlanId: 'A', floor: 12, bedrooms: 1, bathrooms: 1, sqft: 800, monthlyRent: 4000, availableFrom: '2026-09-01', status: 'available' })), knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,$3,'published',$4,'2026-09-01T12:00:00Z','Synthetic calendar action fixture','2026-09-09T12:00:00Z')`, [org, property, version, JSON.stringify(bundle)])
  }
})
beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.calendars,atrium.operational_documents,atrium.audit_events')
  await db.admin.query("UPDATE atrium.memberships SET status='active'")
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1')
  for (const [org, property] of properties) {
    const profile = { ...emptyProfile(booking.prospectPhone, new Date(booking.bookedAt)), name: booking.prospectName, email: booking.prospectEmail,
      calls: [{ callId: booking.interactionId, at: booking.bookedAt, durationSeconds: null, outcome: 'Booked', toolsCalled: ['book_tour'] }],
      bookings: [{ externalId: booking.externalId, slotId: booking.slotId, startsAt: booking.startsAt, unitId: booking.unitId, status: 'confirmed', callId: booking.interactionId }] }
    await db.admin.query('INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3)', [org, property, JSON.stringify({ blocks: [], bookings: [booking] })])
    await db.admin.query('INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4)', [org, property, `lead:${booking.prospectPhone}`, JSON.stringify(profile)])
  }
})
after(async () => { await db?.close(); originalMode === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = originalMode })
async function selected(user = 'owner-a', property = 'property-a1', permission = 'operate') {
  const principal = await runtime.authorization.authenticatePassword(user, password)
  const scope = await runtime.authorization.authorizeProperty(principal, property, permission)
  return { principal, scope }
}
async function request(body, { user = 'owner-a', property = 'property-a1', org = 'organization-a', method = 'POST', query = {} } = {}) {
  const { principal } = await selected(user, property, method === 'GET' ? 'read' : user === 'viewer-a' ? 'read' : 'operate')
  const response = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this } }
  await handler({ method, atriumRuntime: runtime, headers: { cookie: `${OPS_COOKIE}=${mintUserSession(principal, now, runtime.sessionSecret)}`,
    'x-atrium-organization-id': org, 'x-atrium-property-id': property, 'x-atrium-config-version': '1' }, query: { from: '2032-06-01', to: '2032-06-03', ...query },
    body: body ? { ...body, expectedTimeZone: 'America/New_York' } : undefined }, response)
  return response
}
const snapshot = async () => ({
  calendars: (await db.admin.query('SELECT organization_id,property_id,state FROM atrium.calendars ORDER BY organization_id,property_id')).rows,
  documents: (await db.admin.query('SELECT organization_id,property_id,key,value FROM atrium.operational_documents ORDER BY organization_id,property_id,key')).rows,
  audits: (await db.admin.query('SELECT id FROM atrium.audit_events ORDER BY id')).rows,
})
async function moveUnit(calendar, documents) {
  const state = await calendar.mutate(current => rescheduleBooking(current, input, now, options, 'owner-a'))
  const changed = state.bookings[0], change = changed.rescheduleHistory[0]
  const result = await reconcileRescheduledTour(documents, { booking: changed, change })
  assert.equal(result.status, 'complete')
  return calendar.mutate(current => completeRescheduleProjection(current, booking.externalId, input.requestId, 1))
}

test('actual database calendar handler scopes unit blackouts and reports retained reservation conflicts', async () => {
  const blocked = await request({ action: 'unit_block', requestId: 'native-unit-block', unitId: '12A', date: '2032-06-01', allDay: true, reason: 'Painting' })
  assert.equal(blocked.statusCode, 200, JSON.stringify(blocked.body))
  assert.equal(blocked.body.scope.propertyId, 'property-a1')
  assert.deepEqual(blocked.body.unitBlocks[0].conflictingBookingIds, [booking.externalId])
  assert.equal(blocked.body.bookings.length, 1)
  const other = await request(undefined, { method: 'GET', property: 'property-a2' })
  assert.equal(other.statusCode, 200)
  assert.deepEqual(other.body.unitBlocks, [])
  const forbidden = await request({ action: 'unit_block', requestId: 'viewer-unit-block', unitId: '12A', date: '2032-06-01', allDay: true, reason: 'Not authorized' }, { user: 'viewer-a' })
  assert.equal(forbidden.statusCode, 403)
})

test('actual database reschedule handler atomically moves one reservation, profile, follow-ups and audits', async () => {
  const result = await request(input)
  assert.equal(result.statusCode, 200, JSON.stringify(result.body))
  assert.equal(result.body.reschedule.status, 'complete')
  assert.equal(result.body.reschedule.notificationSent, false)
  assert.equal(result.body.bookings[0].revision, 1)
  const rows = await snapshot()
  assert.equal(rows.calendars.find(row => row.property_id === 'property-a2').state.bookings[0].slotId, booking.slotId)
  assert.equal(rows.calendars.find(row => row.property_id === 'property-b1').state.bookings[0].slotId, booking.slotId)
  assert.equal(rows.documents.find(row => row.property_id === 'property-a1' && row.key.startsWith('lead:')).value.bookings[0].startsAt, '2032-06-01T14:15:00.000Z')
  const xids = (await db.admin.query(`SELECT xmin::text AS xid FROM atrium.calendars WHERE property_id='property-a1'
    UNION SELECT xmin::text AS xid FROM atrium.operational_documents WHERE property_id='property-a1'
    UNION SELECT xmin::text AS xid FROM atrium.audit_events WHERE property_id='property-a1'`)).rows
  assert.equal(xids.length, 1)
  const retry = await request(input)
  assert.equal(retry.statusCode, 200)
  assert.equal(retry.body.bookings.length, 1)
  assert.equal(retry.body.bookings[0].rescheduleHistory.length, 1)
})

test('projection failure rolls back calendar, index, lead, follow-ups and every audit', async () => {
  const { scope } = await selected(), calendar = new PostgresCalendarStore(db.app, scope, { requestId: 'calendar-projection-failure', configurationVersion: 1 })
  const before = await snapshot()
  await assert.rejects(calendar.transaction(async unit => {
    await moveUnit(unit.calendar, unit.documents)
    throw new Error('Synthetic interruption after projection')
  }), /Synthetic interruption/)
  assert.deepEqual(await snapshot(), before)
})

test('caught operation failure poisons the shared calendar/document transaction', async () => {
  const { scope } = await selected(), calendar = new PostgresCalendarStore(db.app, scope, { requestId: 'calendar-poison', configurationVersion: 1 })
  const before = await snapshot()
  await assert.rejects(calendar.transaction(async unit => {
    await unit.calendar.mutate(current => rescheduleBooking(current, input, now, options, 'owner-a'))
    try { await unit.documents.set('', {}) } catch {}
    try { await unit.documents.set('after-error', {}) } catch {}
  }), /Invalid document key/)
  assert.deepEqual(await snapshot(), before)
})

test('captured calendar/document handles expire together after their owning transaction', async () => {
  const { scope } = await selected(), calendar = new PostgresCalendarStore(db.app, scope, { requestId: 'calendar-expiry', configurationVersion: 1 })
  let unit
  await calendar.transaction(async active => { unit = active; await active.calendar.read() })
  await assert.rejects(unit.calendar.read(), { code: 'workflow_transaction_closed' })
  await assert.rejects(unit.calendar.mutate(state => state), { code: 'workflow_transaction_closed' })
  await assert.rejects(unit.documents.get('lead:one'), { code: 'workflow_transaction_closed' })
  assert.throws(() => unit.calendar.describe(), { code: 'workflow_transaction_closed' })
})

for (const kind of ['membership', 'configuration']) test(`${kind} revocation after actual calendar mutation rolls the whole unit back`, async () => {
  const { scope } = await selected()
  let changed = false
  const wrapped = { transaction: (context, work) => db.app.transaction(context, client => work(new Proxy(client, {
    get(target, key) {
      if (key !== 'query') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
      return async (...args) => {
        const result = await target.query(...args)
        if (!changed && String(args[0]).includes('INSERT INTO atrium.audit_events')) {
          changed = true
          if (kind === 'membership') await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
          else await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
        }
        return result
      }
    },
  }))) }
  const calendar = new PostgresCalendarStore(wrapped, scope, { requestId: 'calendar-revocation', configurationVersion: 1 })
  const before = await snapshot()
  await assert.rejects(calendar.transaction(unit => moveUnit(unit.calendar, unit.documents)))
  assert.equal(changed, true)
  assert.deepEqual(await snapshot(), before)
})

test('concurrent database editors cannot both commit a move from one revision', async () => {
  const results = await Promise.all([request(input), request({ ...input, requestId: 'native-concurrent-second', slotId: 'slot-2032-06-01T15:00' })])
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409])
  const current = await request(undefined, { method: 'GET' })
  assert.equal(current.body.bookings[0].revision, 1)
  assert.equal(current.body.bookings[0].rescheduleHistory.length, 1)
})
