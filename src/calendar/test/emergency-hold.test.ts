import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryCalendarStore, KvCalendarStore } from '../store.ts'
import { storeBackedCalendar } from '../port.ts'
import { heldEmergency, holdEmergency } from '../safety.ts'
import { generateSlots } from '../slots.ts'
import type { CalendarState } from '../types.ts'
import type { BookingIntent } from '../../booking/types.ts'
import { bookTour } from '../../booking/book.ts'
import { interactionId, propertyId } from '../../domain/ids.ts'
import type { EmergencySignal } from '../../escalation/emergency.ts'

const NOW = new Date('2032-06-01T12:00:00Z')
const OPTIONS = { minimumNoticeMinutes: 0, capacity: 2, timeZone: 'America/New_York' }
const SLOT = generateSlots(NOW, OPTIONS)[0]!
const GAS: EmergencySignal = { kind: 'gas', matched: 'Synthetic caller words are private', callEmergencyServices: true }
const FLOOD: EmergencySignal = { kind: 'flooding', matched: 'Synthetic flooding excerpt', callEmergencyServices: false }
function intent(callId: string, key = `booking-${callId}`): BookingIntent {
  return { intentId: key, idempotencyKey: key, createdAt: NOW, request: {
    propertyId: propertyId('property-emergency-hold-test'), interactionId: interactionId(callId), personId: null,
    prospectName: 'Synthetic Visitor', prospectPhone: '+15165550128', prospectEmail: null,
    slot: SLOT, unitId: null, floorPlanId: null,
  } }
}

test('a calendar hold blocks its interaction while other calls and separate stores remain usable', async () => {
  const store = new MemoryCalendarStore(), otherStore = new MemoryCalendarStore()
  const calendar = storeBackedCalendar(store, () => NOW, OPTIONS)
  await holdEmergency(store, 'held-call', GAS, NOW)
  await assert.rejects(calendar.createBooking(intent('held-call')), /^Error: CALENDAR_INTERACTION_PAUSED$/)
  await calendar.createBooking(intent('unrelated-call'))
  await storeBackedCalendar(otherStore, () => NOW, OPTIONS).createBooking(intent('held-call'))
  assert.equal((await store.read()).bookings.length, 1)
  assert.equal((await otherStore.read()).bookings.length, 1)
  assert.deepEqual((await store.read()).emergencyHolds, [{ interactionId: 'held-call', kind: 'gas', recordedAt: NOW.toISOString() }])
})

test('a hold precedes the idempotency shortcut but does not cancel a booking committed earlier', async () => {
  const store = new MemoryCalendarStore()
  const calendar = storeBackedCalendar(store, () => NOW, OPTIONS)
  const original = intent('booking-before-hold')
  const created = await calendar.createBooking(original)
  const before = (await store.read()).bookings
  await holdEmergency(store, String(original.request.interactionId), GAS, NOW)
  await assert.rejects(calendar.createBooking(original), /^Error: CALENDAR_INTERACTION_PAUSED$/)
  assert.deepEqual((await store.read()).bookings, before, 'the hold blocks admission, not historical bookings')
  assert.equal((await calendar.readBooking(created.externalId))?.externalId, created.externalId)
})

test('held severity cannot downgrade and the calendar guard never stores caller excerpts', async () => {
  const store = new MemoryCalendarStore()
  await holdEmergency(store, 'severity-call', FLOOD, NOW)
  await holdEmergency(store, 'severity-call', GAS, new Date(NOW.getTime() + 1000))
  await holdEmergency(store, 'severity-call', FLOOD, new Date(NOW.getTime() + 2000))
  const state = await store.read()
  assert.equal(heldEmergency(state, 'severity-call')?.kind, 'gas')
  assert.deepEqual(state.emergencyHolds, [{ interactionId: 'severity-call', kind: 'gas', recordedAt: NOW.toISOString() }])
  assert.doesNotMatch(JSON.stringify(state), /caller words|flooding excerpt/)
})

test('a competing KV hold invalidates the tentative booking CAS and the retry observes the hold', async () => {
  let remote: string | null = null
  let injected = false, reads = 0, evals = 0
  const committed: CalendarState[] = []
  let guardStore: KvCalendarStore
  const booking = intent('kv-cas-held-call')
  const fakeRedis: typeof fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body)) as string[]
    let result: unknown
    if (command[0] === 'GET') { reads++; result = remote }
    else if (command[0] === 'EVAL') {
      evals++
      const candidate = JSON.parse(command[6]!) as CalendarState
      if (!injected && candidate.bookings.length > 0) {
        injected = true
        // A second adapter commits the emergency after the booking computed its
        // tentative state, but before that stale state reaches Redis compare/set.
        await holdEmergency(guardStore, String(booking.request.interactionId), GAS, NOW)
      }
      const matches = command[4] === 'missing' ? remote === null : remote === command[5]
      if (matches) { remote = command[6]!; committed.push(candidate); result = 1 }
      else result = 0
    } else throw new Error(`Unexpected mock Redis command ${command[0]}`)
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const options = { key: 'atrium:test-emergency:calendar', fetchImpl: fakeRedis }
  guardStore = new KvCalendarStore('https://redis-emergency-test.invalid', 'synthetic-test-token', options)
  const bookingStore = new KvCalendarStore('https://redis-emergency-test.invalid', 'synthetic-test-token', options)
  const calendar = storeBackedCalendar(bookingStore, () => NOW, OPTIONS)
  await assert.rejects(calendar.createBooking(booking), /^Error: CALENDAR_INTERACTION_PAUSED$/)
  assert.equal(injected, true, 'the initial callback accepted a real bookable slot')
  assert.equal(reads, 3, 'booking read, competing hold read, then stale booking retry read')
  assert.equal(evals, 2, 'only the competing hold commits; the stale booking CAS conflicts')
  assert.equal(committed.length, 1)
  assert.deepEqual(committed[0]!.bookings, [])
  assert.equal(heldEmergency(committed[0]!, String(booking.request.interactionId))?.kind, 'gas')
})

test('bookTour preserves the emergency marker instead of offering calendar alternatives', async () => {
  const store = new MemoryCalendarStore()
  const booking = intent('book-flow-held-call')
  await holdEmergency(store, String(booking.request.interactionId), GAS, NOW)
  await assert.rejects(bookTour(booking.request, storeBackedCalendar(store, () => NOW, OPTIONS), {
    now: NOW, makeIntentId: () => booking.intentId,
  }), /^Error: CALENDAR_INTERACTION_PAUSED$/)
  assert.deepEqual((await store.read()).bookings, [])
})
