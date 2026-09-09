import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rescheduleBooking, completeRescheduleProjection, previewReschedule } from '../reschedule.ts'
import { MemoryCalendarStore } from '../store.ts'
import type { CalendarState, SlotBooking } from '../types.ts'
import { addUnitBlock, prepareUnitBlock } from '../unit-blocks.ts'

const now = new Date('2032-06-01T10:00:00Z')
const options = { timeZone: 'America/New_York', unitIds: ['12A', '12B'], minimumNoticeMinutes: 0, capacity: 1, startIntervalMinutes: 15 }
const booking: SlotBooking = { externalId: 'immutable-external-id', slotId: 'slot-2032-06-01T14:00',
  startsAt: '2032-06-01T14:00:00.000Z', endsAt: '2032-06-01T14:30:00.000Z', prospectName: 'Synthetic visitor', prospectEmail: null,
  prospectPhone: '+12025550101', unitId: '12A', bookedAt: '2032-05-25T14:00:00.000Z', interactionId: 'call-original' }
const initial = (): CalendarState => ({ bookings: [structuredClone(booking)], blocks: [] })
const request = (extra = {}) => ({ externalId: booking.externalId, requestId: 'reschedule-request-one', expectedRevision: 0, slotId: 'slot-2032-06-01T14:15', ...extra })

test('reschedule excludes itself from capacity and retains stable identity, bookedAt and history', () => {
  const state = rescheduleBooking(initial(), request(), now, options, 'staff-user')
  const changed = state.bookings[0]!
  assert.equal(state.bookings.length, 1)
  assert.equal(changed.externalId, booking.externalId)
  assert.equal(changed.bookedAt, booking.bookedAt)
  assert.equal(changed.interactionId, booking.interactionId)
  assert.equal(changed.startsAt, '2032-06-01T14:15:00.000Z')
  assert.equal(changed.revision, 1)
  assert.equal(changed.rescheduleHistory?.[0]?.from.startsAt, booking.startsAt)
  assert.equal(changed.rescheduleHistory?.[0]?.projection, 'pending')
  assert.equal(changed.rescheduleHistory?.[0]?.actorId, 'staff-user')
})

test('unavailable time, blocked unit and current settings refuse the change without modifying original', () => {
  const full = initial()
  full.bookings.push({ ...booking, externalId: 'other-booking', unitId: '12B', slotId: 'slot-2032-06-01T15:00', startsAt: '2032-06-01T15:00:00.000Z', endsAt: '2032-06-01T15:30:00.000Z' })
  const before = structuredClone(full)
  assert.throws(() => rescheduleBooking(full, request({ slotId: 'slot-2032-06-01T15:00' }), now, options, 'staff'), /original tour is unchanged/)
  assert.deepEqual(full, before)
  const blocked = addUnitBlock(initial(), prepareUnitBlock({ requestId: 'unit-block-request', unitId: '12A', date: '2032-06-01', allDay: true, reason: 'Move out' }, options.unitIds, options.timeZone, now))
  assert.throws(() => rescheduleBooking(blocked, request(), now, options, 'staff'), /original tour is unchanged/)
  assert.throws(() => rescheduleBooking(initial(), request(), now, { ...options, minimumNoticeMinutes: 600 }, 'staff'), /current tour hours, notice/)
  assert.throws(() => rescheduleBooking(initial(), request({ unitId: 'foreign' }), now, options, 'staff'), /property inventory/)
})

test('exact reschedule retry is cached, changed request payload conflicts, and pending projection blocks only another move', () => {
  const state = rescheduleBooking(initial(), request(), now, options, 'staff')
  assert.deepEqual(rescheduleBooking(state, request(), new Date('2033-01-01'), options, 'staff'), state)
  assert.throws(() => rescheduleBooking(state, request({ slotId: 'slot-2032-06-01T15:00' }), now, options, 'staff'), /already used/)
  assert.throws(() => rescheduleBooking(state, request({ requestId: 'reschedule-request-two', expectedRevision: 1 }), now, options, 'staff'), /still being reconciled/)
  const complete = completeRescheduleProjection(state, booking.externalId, 'reschedule-request-one', 1)
  const twice = rescheduleBooking(complete, request({ requestId: 'reschedule-request-two', expectedRevision: 1, slotId: 'slot-2032-06-01T15:00' }), now, options, 'staff')
  assert.equal(twice.bookings[0]?.rescheduleHistory?.length, 2)
  assert.throws(() => completeRescheduleProjection(twice, booking.externalId, 'reschedule-request-one', 1), /changed before reconciliation/)
})

test('two staff editors race on one revision; only one new time lands', async () => {
  const store = new MemoryCalendarStore()
  await store.mutate(initial)
  const results = await Promise.allSettled(['14:15', '14:30'].map((time, i) => store.mutate(state => rescheduleBooking(state,
    request({ requestId: `reschedule-race-${i}`, slotId: `slot-2032-06-01T${time}` }), now, options, 'staff'))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal((await store.read()).bookings.length, 1)
  assert.equal((await store.read()).bookings[0]?.revision, 1)
})

test('preview includes overlapping time when only this reservation occupied it', () => {
  const preview = previewReschedule(initial(), booking.externalId, undefined, now,
    { start: new Date('2032-06-01T14:00Z'), end: new Date('2032-06-01T15:00Z') }, options)
  assert.equal(preview.booking.revision, 0)
  assert.ok(preview.slots.some(slot => slot.slotId === 'slot-2032-06-01T14:15'))
  assert.equal(preview.notificationSent, false)
})

test('emergency holds and duplicate external identity refuse a manual move', () => {
  const held = { ...initial(), emergencyHolds: [{ interactionId: 'call-original', kind: 'gas' as const, recordedAt: now.toISOString() }] }
  assert.throws(() => rescheduleBooking(held, request(), now, options, 'staff'), /safety hold/)
  const corrupt = initial(); corrupt.bookings.push({ ...booking })
  assert.throws(() => rescheduleBooking(corrupt, request(), now, options, 'staff'), /administrator review/)
})
