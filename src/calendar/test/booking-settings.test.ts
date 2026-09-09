import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storeBackedCalendar } from '../port.ts'
import { MemoryCalendarStore } from '../store.ts'
import { defaultSettings } from '../settings.ts'
import { generateSlots } from '../slots.ts'
import type { SlotOptions } from '../slots.ts'
import type { CalendarStore } from '../types.ts'
import type { BookingIntent, BookingRequest, TourSlot } from '../../booking/types.ts'
import { bookTour } from '../../booking/book.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const START = new Date('2026-09-08T14:00:00Z')
const END = new Date('2026-09-08T18:00:00Z')
const PROPERTY = propertyId('property-calendar-test')
const options: SlotOptions = { minimumNoticeMinutes: 0, capacity: 2, unitIds: ['12A', '12B', '12C'] }
const request = (slot: TourSlot, unitId: string | null = '12A', phone = '+15555550101'): BookingRequest => ({
  propertyId: PROPERTY, interactionId: interactionId(`call-${phone}`), personId: null,
  prospectName: 'Local calendar test', prospectPhone: phone, prospectEmail: null,
  unitId, floorPlanId: null, slot,
})
const intent = (slot: TourSlot, key: string, unitId: string | null = '12A'): BookingIntent => ({
  intentId: key, idempotencyKey: key, createdAt: NOW, request: request(slot, unitId),
})

test('calendar queries honor both range boundaries, including dates beyond the default two weeks', async () => {
  const cal = storeBackedCalendar(new MemoryCalendarStore(), () => NOW, options)
  const from = new Date('2026-12-08T15:00:00Z')
  const to = new Date('2026-12-08T17:00:00Z')
  const slots = await cal.listSlots(PROPERTY, from, to)
  assert.equal(slots.length, 4)
  assert.ok(slots.every(slot => slot.startsAt >= from && slot.startsAt < to))
  assert.deepEqual(await cal.listSlots(PROPERTY, from, from), [])
  await assert.rejects(cal.listSlots(PROPERTY, to, from), /date range/)
})

test('simultaneous callers share staff capacity without overselling it', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, options)
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  const results = await Promise.allSettled([
    cal.createBooking(intent(slot, 'staff-a', '12A')),
    cal.createBooking(intent(slot, 'staff-b', '12B')),
    cal.createBooking(intent(slot, 'staff-c', '12C')),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal((await store.read()).bookings.length, 2)
})

test('overlapping staggered starts consume the same staff capacity', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, { ...options, startIntervalMinutes: 15 })
  const slots = await cal.listSlots(PROPERTY, START, END)
  await cal.createBooking(intent(slots[0]!, 'stagger-a', '12A'))
  await cal.createBooking(intent(slots[1]!, 'stagger-b', '12B'))
  await assert.rejects(cal.createBooking(intent(slots[1]!, 'stagger-c', '12C')), /already booked/)
  await cal.createBooking(intent(slots[2]!, 'stagger-d', '12C'))
  assert.equal((await store.read()).bookings.length, 3, 'the first staff member becomes available at the exclusive end boundary')
})

test('new bookings persist actual tour and buffered occupancy; read-back ignores later rules and elapsed time', async () => {
  let clock = NOW
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => clock, { ...options, bufferMinutes: 10 })
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  const original = intent(slot, 'immutable', ' 12a ')
  await cal.createBooking(original)
  const stored = (await store.read()).bookings[0]!
  assert.equal(stored.unitId, '12A')
  assert.equal(stored.startsAt, slot.startsAt.toISOString())
  assert.equal(stored.endsAt, slot.endsAt.toISOString())
  assert.equal(stored.occupiedStartsAt, new Date(slot.startsAt.getTime() - 10 * 60000).toISOString())
  assert.equal(stored.occupiedEndsAt, new Date(slot.endsAt.getTime() + 10 * 60000).toISOString())

  await store.mutate(state => ({ ...state, settings: { ...defaultSettings(),
    slotMinutes: 60, startIntervalMinutes: 60, bufferMinutes: 30,
    minimumNoticeMinutes: 10080, bookingWindowDays: 1, hours: {},
  }, settingsRevision: 1 }))
  clock = new Date('2027-01-01T00:00:00Z')
  const read = await cal.readBooking('immutable')
  assert.deepEqual(read, { externalId: 'immutable', slot, unitId: '12A' })
  assert.deepEqual(await cal.createBooking({ ...original, request: { ...original.request, unitId: '12A' } }), { externalId: 'immutable' })
  assert.deepEqual((await store.read()).bookings[0], stored)
})

test('legacy bookings retain their original half-hour duration after settings change', async () => {
  const store = new MemoryCalendarStore()
  const slot = generateSlots(NOW, options)[0]!
  await store.mutate(state => ({ ...state, settings: { ...defaultSettings(), slotMinutes: 60 }, bookings: [{
    slotId: slot.slotId, externalId: 'legacy', prospectName: 'Legacy test', prospectPhone: '+15555550101',
    prospectEmail: null, unitId: '12A', bookedAt: NOW.toISOString(),
  }] }))
  const cal = storeBackedCalendar(store, () => new Date('2027-01-01T00:00:00Z'), options)
  assert.deepEqual((await cal.readBooking('legacy'))?.slot, slot)
})

test('a persisted staff buffer still reserves time when future buffer settings are reduced', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, { ...options, capacity: 1, bufferMinutes: 15 })
  const slots = await cal.listSlots(PROPERTY, START, END)
  await cal.createBooking(intent(slots[0]!, 'buffer-original', '12A'))
  await store.mutate(state => ({ ...state, settings: { ...defaultSettings(), capacity: 1, bufferMinutes: 0 } }))
  await assert.rejects(cal.createBooking(intent(slots[1]!, 'buffer-overlap', '12B')), /already booked/)
  await cal.createBooking(intent(slots[2]!, 'buffer-after', '12B'))
  assert.equal((await store.read()).bookings.length, 2)
})

test('same-key changed apartment or actual interval conflicts instead of confirming an unrelated booking', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, options)
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  await cal.createBooking(intent(slot, 'same-key', '12A'))
  await assert.rejects(cal.createBooking(intent(slot, 'same-key', '12B')), /booking conflict/)
  await assert.rejects(cal.createBooking(intent({ ...slot, endsAt: new Date(slot.endsAt.getTime() + 15 * 60000) }, 'same-key', '12A')), /booking conflict/)
  assert.equal((await store.read()).bookings.length, 1)
})

test('booking flow does not confirm a second apartment using the same prospect and start', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, options)
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  const first = await bookTour(request(slot, '12A'), cal, { now: NOW, makeIntentId: () => 'first' })
  assert.equal(first.state.status, 'confirmed')
  const changed = await bookTour(request(slot, '12B'), cal, { now: NOW, makeIntentId: () => 'changed' })
  assert.equal(changed.state.status, 'slot_taken')
  assert.equal((await store.read()).bookings.length, 1)
  assert.equal((await store.read()).bookings[0]?.unitId, '12A')
})

test('unit-specific availability and conflict alternatives exclude the occupied apartment', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, options)
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  await cal.createBooking(intent(slot, 'unit-first', '12A'))
  assert.ok((await cal.listSlots(PROPERTY, START, END, '12B')).some(candidate => candidate.slotId === slot.slotId))
  assert.ok(!(await cal.listSlots(PROPERTY, START, END, ' 12a ')).some(candidate => candidate.slotId === slot.slotId))
  const result = await bookTour(request(slot, '12A', '+15555550102'), cal, { now: NOW, makeIntentId: () => 'unit-second' })
  assert.equal(result.state.status, 'slot_taken')
  if (result.state.status !== 'slot_taken') throw new Error('expected a conflict')
  assert.ok(result.state.alternatives.length > 0)
  assert.ok(result.state.alternatives.every(candidate => candidate.slotId !== slot.slotId))
})

test('same apartment may share a time only when configured, while capacity remains enforced', async () => {
  const store = new MemoryCalendarStore()
  await store.mutate(state => ({ ...state, settings: { ...defaultSettings(), capacity: 2, sameUnitPolicy: 'shared' } }))
  const cal = storeBackedCalendar(store, () => NOW, options)
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  await cal.createBooking(intent(slot, 'shared-a', '12A'))
  await cal.createBooking(intent(slot, 'shared-b', '12A'))
  await assert.rejects(cal.createBooking(intent(slot, 'shared-c', '12A')), /already booked/)
})

test('unknown inventory units cannot be offered or booked', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, options)
  const slot = (await cal.listSlots(PROPERTY, START, END))[0]!
  assert.deepEqual(await cal.listSlots(PROPERTY, START, END, '99Z'), [])
  await assert.rejects(cal.createBooking(intent(slot, 'unknown-unit', '99Z')), /not in this property inventory/)
  assert.equal((await store.read()).bookings.length, 0)
})

test('a CAS retry rechecks newer capacity settings before committing', async () => {
  const backing = new MemoryCalendarStore()
  const seedCalendar = storeBackedCalendar(backing, () => NOW, options)
  const slot = (await seedCalendar.listSlots(PROPERTY, START, END))[0]!
  await seedCalendar.createBooking(intent(slot, 'existing-staff', '12A'))
  let callbacks = 0
  const racingStore: CalendarStore = {
    read: () => backing.read(),
    describe: () => backing.describe(),
    mutate: async fn => {
      callbacks++
      const tentative = fn(await backing.read())
      assert.equal(tentative.bookings.length, 2, 'the old capacity would have accepted the booking')
      await backing.mutate(state => ({ ...state, settings: { ...defaultSettings(), capacity: 1 }, settingsRevision: 1 }))
      callbacks++
      return backing.mutate(fn)
    },
  }
  const cal = storeBackedCalendar(racingStore, () => NOW, options)
  await assert.rejects(cal.createBooking(intent(slot, 'racing-staff', '12B')), /already booked/)
  assert.equal(callbacks, 2)
  assert.equal((await backing.read()).bookings.length, 1)
})

test('staff browsing options cannot bypass booking notice or booking horizon', async () => {
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => NOW, { ...options, enforceBookingRules: false, minimumNoticeMinutes: 10080, bookingWindowDays: 1 })
  const slot = generateSlots(NOW, { ...options, from: START, to: END, enforceBookingRules: false })[0]!
  await assert.rejects(cal.createBooking(intent(slot, 'staff-view-bypass')), /already booked or blocked/)
  assert.equal((await store.read()).bookings.length, 0)
})
