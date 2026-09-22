import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileCalendarBookingReview, findCalendarBookingReviewResolution, calendarBookingReviewForCall,
  completeCalendarBookingReviewResolution, validateCalendarBookingReviewResolution, bookingReviewBlocksCreate } from '../booking-review.ts'
import type { BookingReviewAttempt, CalendarState, SlotBooking } from '../types.ts'
import { MemoryCalendarStore, KvCalendarStore } from '../store.ts'
import { storeBackedCalendar } from '../port.ts'
import { rescheduleBooking } from '../reschedule.ts'
import type { BookingIntent } from '../../booking/types.ts'
import { interactionId, propertyId } from '../../domain/ids.ts'

const now = new Date('2032-06-01T10:00:00.000Z')
const attempt: BookingReviewAttempt = { externalId: 'property-review|+15555550101|slot-2032-06-01T14:00',
  slotId: 'slot-2032-06-01T14:00', startsAt: '2032-06-01T14:00:00.000Z', endsAt: '2032-06-01T14:30:00.000Z', unitId: '12A' }
const callId = 'call-review-original'
const input = () => ({ requestId: 'review-request-one', callId, sourceRevision: 4, actorId: 'staff-user', checkedAt: now.toISOString(), attempt: { ...attempt } })
const booking = (): SlotBooking => ({ ...attempt, prospectName: 'Synthetic visitor', prospectPhone: '+15555550101', prospectEmail: null,
  bookedAt: now.toISOString(), interactionId: callId })
const state = (bookings: SlotBooking[] = []): CalendarState => ({ bookings, blocks: [] })
const options = { timeZone: 'America/New_York', unitIds: ['12A', '12B'], minimumNoticeMinutes: 0, capacity: 2 }
const intent = (id = callId): BookingIntent => ({ intentId: `intent-${id}`, idempotencyKey: attempt.externalId, createdAt: now,
  request: { propertyId: propertyId('property-review'), interactionId: interactionId(id), personId: null,
    prospectName: 'Synthetic visitor', prospectPhone: '+15555550101', prospectEmail: null, unitId: attempt.unitId, floorPlanId: null,
    slot: { slotId: attempt.slotId, startsAt: new Date(attempt.startsAt), endsAt: new Date(attempt.endsAt) } } })
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected)

test('exact reservation observation retains calendar data and records actor/revision with pending projection', () => {
  const original = { ...state([booking()]), emergencyHolds: [{ interactionId: callId, kind: 'gas' as const, recordedAt: now.toISOString() }],
    tourChangeHolds: [{ interactionId: callId, recordedAt: now.toISOString() }] }
  const result = reconcileCalendarBookingReview(original, input())
  assert.deepEqual(result.bookings, original.bookings)
  assert.deepEqual(result.emergencyHolds, original.emergencyHolds)
  assert.deepEqual(result.tourChangeHolds, original.tourChangeHolds)
  assert.equal(original.bookingReviewResolutions, undefined)
  const receipt = findCalendarBookingReviewResolution(result, input().requestId)!
  assert.equal(receipt.outcome, 'confirmed'); assert.equal(receipt.projection, 'pending')
  assert.deepEqual(receipt.booking, { ...attempt, revision: 0 })
  assert.equal(receipt.actorId, 'staff-user'); assert.equal(receipt.sourceRevision, 4)
  validateCalendarBookingReviewResolution(result, receipt)
})

test('absence is recorded with same-state create fence, not a create or claimed cancellation', () => {
  const result = reconcileCalendarBookingReview(state(), input())
  assert.equal(result.bookings.length, 0)
  assert.equal(calendarBookingReviewForCall(result, callId)!.outcome, 'not_booked')
  assert.equal(calendarBookingReviewForCall(result, callId)!.booking, null)
  assert.equal(bookingReviewBlocksCreate(result, callId, 'another-key'), true)
  assert.equal(bookingReviewBlocksCreate(result, 'different-call', attempt.externalId), true)
  assert.equal(bookingReviewBlocksCreate(result, 'different-call', 'different-key'), false)
})

for (const [label, alter] of [
  ['duplicate external key', (b: SlotBooking) => [b, { ...b, interactionId: 'other-call' }]],
  ['duplicate call reservation', (b: SlotBooking) => [b, { ...b, externalId: 'another-key' }]],
  ['other-call same external key', (b: SlotBooking) => [{ ...b, interactionId: 'other-call' }]],
  ['same call other external key', (b: SlotBooking) => [{ ...b, externalId: 'another-key' }]],
  ['different unit', (b: SlotBooking) => [{ ...b, unitId: '12B' }]],
  ['missing exact end', (b: SlotBooking) => { const { endsAt: _endsAt, ...incomplete } = b; return [incomplete] }],
  ['different end', (b: SlotBooking) => [{ ...b, endsAt: '2032-06-01T14:45:00.000Z' }]],
  ['moved interval', (b: SlotBooking) => [{ ...b, slotId: 'slot-2032-06-01T15:00', startsAt: '2032-06-01T15:00:00.000Z' }]],
  ['prior move returned to original time', (b: SlotBooking) => [{ ...b, revision: 2 }]],
  ['malformed reschedule history', (b: SlotBooking) => [{ ...b, rescheduleHistory: {} as never }]],
] as const) test(`${label} remains unresolved and does not append a fence`, () => {
  const before = state(alter(booking())), original = structuredClone(before)
  assert.throws(() => reconcileCalendarBookingReview(before, input()), code('booking_review_calendar_conflict'))
  assert.deepEqual(before, original)
})

test('missing or malformed immutable attempt evidence cannot infer a duration from current settings', () => {
  for (const change of [{ endsAt: undefined }, { externalId: undefined }, { startsAt: '2032-06-01T14:00:00Z' },
    { slotId: 'slot-2032-06-01T15:00' }, { endsAt: attempt.startsAt }, { unitId: '' }]) {
    assert.throws(() => reconcileCalendarBookingReview(state(), { ...input(), attempt: { ...attempt, ...change } as BookingReviewAttempt }),
      code('booking_review_evidence_incomplete'))
  }
  for (const change of [{ sourceRevision: -1 }, { sourceRevision: 0.5 }, { actorId: '' }, { checkedAt: 'not-an-instant' }]) {
    assert.throws(() => reconcileCalendarBookingReview(state(), { ...input(), ...change }), code('booking_review_receipt_invalid'))
  }
})

test('same saved request replays exactly; changed identity cannot reuse its receipt', () => {
  const result = reconcileCalendarBookingReview(state([booking()]), input())
  assert.deepEqual(reconcileCalendarBookingReview(result, { ...input(), checkedAt: '2032-06-02T10:00:00.000Z' }), result)
  for (const changed of [{ sourceRevision: 5 }, { actorId: 'other-staff' }, { callId: 'other-call' }, { attempt: { ...attempt, unitId: '12B' } }]) {
    assert.throws(() => reconcileCalendarBookingReview(result, { ...input(), ...changed }), code('booking_review_request_conflict'))
  }
  assert.throws(() => reconcileCalendarBookingReview(result, { ...input(), requestId: 'review-other-request' }), code('booking_review_already_checked'))
})

test('pending projection prevents manual move and exact confirmation replay until mismatches are investigated', () => {
  const pending = reconcileCalendarBookingReview(state([booking()]), input())
  assert.throws(() => rescheduleBooking(pending, { externalId: attempt.externalId, requestId: 'move-request-one', expectedRevision: 0,
    slotId: 'slot-2032-06-01T15:00' }, now, options, 'staff-user'), code('booking_review_projection_pending'))
  const removed = { ...pending, bookings: [] }
  assert.throws(() => completeCalendarBookingReviewResolution(removed, input().requestId), code('booking_review_calendar_changed'))
  assert.throws(() => reconcileCalendarBookingReview(removed, input()), code('booking_review_calendar_changed'))
  const changed = { ...pending, bookings: [{ ...booking(), unitId: '12B' }] }
  assert.throws(() => completeCalendarBookingReviewResolution(changed, input().requestId), code('booking_review_calendar_conflict'))
  assert.equal(calendarBookingReviewForCall(changed, callId)?.projection, 'pending')
})

test('completed review allows later manual move and returns immutable history on old request replay', () => {
  const pending = reconcileCalendarBookingReview(state([booking()]), input())
  const completed = completeCalendarBookingReviewResolution(pending, input().requestId)
  const moved = rescheduleBooking(completed, { externalId: attempt.externalId, requestId: 'move-request-one', expectedRevision: 0,
    slotId: 'slot-2032-06-01T15:00' }, now, options, 'staff-user')
  assert.equal(moved.bookings[0]!.slotId, 'slot-2032-06-01T15:00')
  assert.deepEqual(reconcileCalendarBookingReview(moved, input()), moved)
  assert.deepEqual(completeCalendarBookingReviewResolution(moved, input().requestId), moved)
  assert.equal(calendarBookingReviewForCall(moved, callId)?.attempt.slotId, attempt.slotId)
  assert.throws(() => validateCalendarBookingReviewResolution(moved, calendarBookingReviewForCall(moved, callId)!), code('booking_review_calendar_conflict'))
})

test('new call can book same key after completed absence; original call stays permanently fenced', async () => {
  const store = new MemoryCalendarStore()
  await store.mutate(current => reconcileCalendarBookingReview(current, input()))
  const port = storeBackedCalendar(store, () => now, options)
  await assert.rejects(port.createBooking(intent('new-call')), /reconciled by staff/)
  await store.mutate(current => completeCalendarBookingReviewResolution(current, input().requestId))
  await assert.rejects(port.createBooking(intent()), /reconciled by staff/)
  assert.deepEqual(await port.createBooking(intent('new-call')), { externalId: attempt.externalId })
  const current = await store.read()
  assert.equal(current.bookings.length, 1); assert.equal(current.bookings[0]!.interactionId, 'new-call')
  await assert.rejects(port.createBooking(intent()), /reconciled by staff/)
  assert.deepEqual(reconcileCalendarBookingReview(current, input()), current, 'completed absence is historical, not a cancellation of the new tour')
})

test('receipt corruption fails admission closed, including unknown projection and duplicate call receipts', () => {
  const current = reconcileCalendarBookingReview(state(), input()), receipt = current.bookingReviewResolutions![0]!
  for (const receipts of [[{ ...receipt, projection: 'typo' }], [receipt, { ...receipt, requestId: 'different-request' }],
    [{ ...receipt, outcome: 'confirmed', booking: null }], [{ ...receipt, sourceRevision: -1 }]]) {
    assert.throws(() => bookingReviewBlocksCreate({ ...current, bookingReviewResolutions: receipts as never }, 'new-call', 'other-key'))
  }
})

/** This fake implements the actual compare-and-set at EVAL execution, not a raw delayed overwrite. */
function kvHarness() {
  let raw: string | null = null, pauseCreate = true, reached!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { reached = resolve })
  const unpause = new Promise<void>(resolve => { release = resolve })
  const metrics = { conflictingCas: 0, committedCreates: 0 }
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const parts = JSON.parse(String(init?.body)) as string[]
    if (parts[0] === 'GET') return Response.json({ result: raw })
    assert.equal(parts[0], 'EVAL')
    const candidate = JSON.parse(parts[6]!) as CalendarState
    if (pauseCreate && candidate.bookings.length) { pauseCreate = false; reached(); await unpause }
    if ((parts[4] === 'missing' && raw !== null) || (parts[4] === 'present' && raw !== parts[5])) {
      metrics.conflictingCas++; return Response.json({ result: 0 })
    }
    raw = parts[6]!
    if (candidate.bookings.length) metrics.committedCreates++
    return Response.json({ result: 1 })
  }) as typeof fetch
  return { store: new KvCalendarStore('https://kv.invalid', 'synthetic-token', { fetchImpl }), arrived, release, metrics }
}

test('real KV adapter late create CAS loses to absence fence and cannot land on callback retry', async () => {
  const fixture = kvHarness(), port = storeBackedCalendar(fixture.store, () => now, options)
  const creating = port.createBooking(intent())
  const rejected = assert.rejects(creating, /reconciled by staff/)
  await fixture.arrived
  await fixture.store.mutate(current => reconcileCalendarBookingReview(current, input()))
  fixture.release(); await rejected
  const current = await fixture.store.read()
  assert.equal(current.bookings.length, 0)
  assert.equal(current.bookingReviewResolutions?.[0]?.outcome, 'not_booked')
  assert.equal(fixture.metrics.conflictingCas, 1)
  assert.equal(fixture.metrics.committedCreates, 0)
})

test('lost calendar resolution acknowledgement recovers same evidence without a second receipt', async () => {
  const store = new MemoryCalendarStore(), realMutate = store.mutate.bind(store)
  let lost = false
  store.mutate = async fn => { const result = await realMutate(fn); if (!lost) { lost = true; throw new Error('response lost') }; return result }
  await assert.rejects(store.mutate(current => reconcileCalendarBookingReview(current, input())), /response lost/)
  const saved = calendarBookingReviewForCall(await store.read(), callId)!
  const replay = await store.mutate(current => reconcileCalendarBookingReview(current, input()))
  assert.deepEqual(calendarBookingReviewForCall(replay, callId), saved)
  assert.equal(replay.bookingReviewResolutions?.length, 1)
})
