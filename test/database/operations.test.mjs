import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService, mintUserSession } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresDocumentStore, PostgresCalendarStore, propertyCalendar } from '../../src/database/operations.ts'
import { holdEmergency } from '../../src/calendar/safety.ts'
import { detectEmergency } from '../../src/escalation/emergency.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'

let db, authorization, credentials, owner, scope, concurrent
const now = new Date('2026-09-07T12:00:00Z')
before(async () => {
  db = await createFoundationTestDatabase()
  credentials = await seedFoundationTestDatabase(db.admin)
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  owner = await authorization.authenticatePassword('owner-a', credentials.password)
  assert.ok(owner)
  scope = await authorization.authorizeProperty(owner, 'property-a1', 'operate')
  concurrent = db.createAppConnection()
})
after(async () => { if (concurrent) await concurrent.close(); if (db) await db.close() })

test('database password sessions list only accessible properties and recheck current grants', async () => {
  const secret = 'synthetic-session-secret-for-integration-test'
  const runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app: db.app, auth: db.auth, sessionSecret: secret })
  const registered = await runtime.sessions.start(owner, { label: 'Synthetic operations session' })
  await verifyMfaSession(runtime, registered, credentials.password)
  const sessionNow = new Date()
  const session = mintUserSession(registered, sessionNow, secret)
  const principal = await authorization.authenticateSession(session, sessionNow, secret)
  assert.ok(principal)
  assert.deepEqual((await authorization.listAuthorizedProperties(principal)).map(property => property.id), ['property-a1','property-a2'])
  await assert.rejects(authorization.authorizeProperty(principal, 'property-b1', 'read'), { code: 'forbidden' })
  const staff = await authorization.authenticatePassword('staff-a', credentials.password)
  assert.deepEqual((await authorization.listAuthorizedProperties(staff)).map(property => property.id), ['property-a1'])
  await db.admin.query("UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1 WHERE membership_id='member-staff-a'")
  await assert.rejects(authorization.authorizeProperty(staff, 'property-a1', 'read'), { code: 'forbidden' })
})

test('concurrent document updates do not lose changes; audit failure rolls the mutation back', async () => {
  const store = new PostgresDocumentStore(concurrent, scope, { requestId: 'document-test' })
  await Promise.all(Array.from({length: 20}, () => store.update('counter', { count: 0 }, current => ({ count: current.count + 1 }))))
  assert.deepEqual(await store.get('counter'), { count: 20 })
  const audit = (await db.admin.query("SELECT * FROM atrium.audit_events WHERE operation='document.update'")).rows
  assert.equal(audit.length, 20)
  assert.ok(audit.every(row => /^sha256:/.test(row.record_key) && row.actor_user_id === 'owner-a'))
  // Invalid audit attribution fails after the document INSERT, proving rollback.
  const failing = new PostgresDocumentStore(concurrent, scope, { requestId: 'invalid audit request id' })
  await assert.rejects(failing.set('must-not-commit', { count: 1 }), { code: '23514' })
  assert.equal(await store.get('must-not-commit'), null)
  await assert.rejects(store.update('counter', {count:0}, async () => ({count:999})), /synchronous JSON/)
  assert.deepEqual(await store.get('counter'), {count:20})
  await store.set('percent%key', { exact: true })
  await store.set('percent-other-key', { exact: false })
  assert.deepEqual(await store.list('percent%'), ['percent%key'])
})

test('real concurrent tour reservations honor three staff, unit exclusivity, and property identity', async () => {
  const store = new PostgresCalendarStore(concurrent, scope, { requestId: 'calendar-test' })
  const otherScope = await authorization.authorizeProperty(owner, 'property-a2', 'operate')
  assert.throws(() => propertyCalendar(store, otherScope, () => now, {}), {code:'forbidden'})
  const calendar = propertyCalendar(store, scope, () => now, { minimumNoticeMinutes: 0, capacity: 3, timeZone: 'America/New_York', unitIds: ['1A','1B','1C','1D'] })
  const slots = await calendar.listSlots('property-a1', new Date('2026-09-08T14:00:00Z'), new Date('2026-09-08T18:00:00Z'))
  assert.ok(slots.length > 0)
  // Staff-capacity cases represent independent visitors, not repeat bookings by one prospect.
  const visitorPhones = new Map()
  const request = (id, unit, propertyId = 'property-a1') => {
    if (!visitorPhones.has(id)) visitorPhones.set(id, `+1555777${String(visitorPhones.size).padStart(4, '0')}`)
    return { intentId: id, idempotencyKey: id, createdAt: now,
      request: { propertyId, interactionId: `call-${id}`, personId: null, prospectName: 'Synthetic prospect', prospectPhone: visitorPhones.get(id), prospectEmail: null, unitId: unit, floorPlanId: null, slot: slots[0] } }
  }
  await assert.rejects(calendar.listSlots('property-b1', now, new Date('2026-09-09T00:00:00Z')), { code: 'forbidden' })
  await assert.rejects(calendar.createBooking(request('wrong-property','1A','property-b1')), { code: 'forbidden' })
  const result = await Promise.allSettled(['1A','1B','1C','1D'].map((unit,index) => calendar.createBooking(request(`tour-${index}`,unit))))
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 3)
  const saved = await store.read()
  assert.equal(saved.bookings.length, 3)
  assert.ok(saved.bookings.every(item => item.startsAt === slots[0].startsAt.toISOString()))
  const existing = saved.bookings[0]
  await assert.rejects(calendar.createBooking(request('duplicate-unit',existing.unitId)), /booked|taken/)
  assert.equal((await calendar.readBooking(existing.externalId)).slot.startsAt.toISOString(), existing.startsAt)
  await holdEmergency(store, 'call-paused', detectEmergency('I smell gas')[0], now)
  await assert.rejects(calendar.createBooking(request('paused','1D')), /paused|emergency/i)
})

test('stale issued scopes stop working after revocation, without producing an empty calendar', async () => {
  const store = new PostgresCalendarStore(concurrent, scope, { requestId: 'revocation-test' })
  await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id='member-owner-a'")
  await assert.rejects(store.read(), { code: 'forbidden' })
  await assert.rejects(store.mutate(current => current), { code: 'forbidden' })
})
