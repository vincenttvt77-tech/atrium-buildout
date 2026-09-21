import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { recordBookingReview, getBookingReview, listBookingReviews, resolveBookingReviewRecord } from '../booking-review.ts'
import { reconcileCalendarBookingReview, calendarBookingReviewForCall } from '../../calendar/booking-review.ts'
import type { BookingReviewAttempt, CalendarBookingReviewResolution } from '../../calendar/types.ts'

const now = new Date('2032-06-01T10:00:00.000Z'), callId = 'synthetic-review-call'
const attempt: BookingReviewAttempt = { externalId: 'synthetic-property|+15555550101|slot-2032-06-01T14:00',
  slotId: 'slot-2032-06-01T14:00', startsAt: '2032-06-01T14:00:00.000Z', endsAt: '2032-06-01T14:30:00.000Z', unitId: '12A' }
const input = () => ({ callId, now, phone: '+15555550101', name: 'Synthetic visitor', email: null, work: { revision: 4 },
  booking: { ...attempt, status: 'arranging' } })
const receipt = (): CalendarBookingReviewResolution => calendarBookingReviewForCall(reconcileCalendarBookingReview({ bookings: [], blocks: [] },
  { requestId: 'review-request-one', callId, sourceRevision: 4, actorId: 'staff-user', checkedAt: now.toISOString(), attempt }), callId)!
const resolving = (resolution = receipt()) => ({ callId, sourceRevision: 4, resolution, now })
const callback = (at: string) => ({ value: '+15555550999', callId, excerpt: 'Please use my callback number.', at, confidence: 1 })

async function seeded() { const store = new MemoryDocumentStore(); await recordBookingReview(store, input()); return store }

test('exact attempt and latest caller callback remain separate from provider identity', async () => {
  const store = await seeded()
  const updated = await recordBookingReview(store, { ...input(), now: new Date('2032-06-01T10:01:00.000Z'), work: { revision: 6 },
    callbackPhone: callback('2032-06-01T10:01:00.000Z'), name: 'Updated visitor' })
  assert.equal(updated.phone, '+15555550101'); assert.equal(updated.callbackPhone?.value, '+15555550999')
  assert.equal(updated.booking?.endsAt, attempt.endsAt); assert.equal(updated.booking?.externalId, attempt.externalId)
  const older = await recordBookingReview(store, { ...input(), work: { revision: 5 }, name: 'Old contact' })
  assert.deepEqual(older, updated)
})

test('historic review remains readable but cannot resolve without exact saved end and booking key', async () => {
  const store = new MemoryDocumentStore(), { endsAt: _end, externalId: _key, ...historic } = input().booking
  await recordBookingReview(store, { ...input(), booking: historic })
  assert.equal((await getBookingReview(store, callId))?.needsReview, true)
  await assert.rejects(resolveBookingReviewRecord(store, resolving()), { code: 'booking_review_evidence_incomplete' })
  assert.equal((await getBookingReview(store, callId))?.needsReview, true)
  await recordBookingReview(store, input())
  assert.equal((await resolveBookingReviewRecord(store, resolving())).needsReview, false, 'trusted same-attempt replay may restore exact missing evidence')
})

test('different attempted unit/time/key cannot silently replace active review evidence', async () => {
  const store = await seeded(), before = await getBookingReview(store, callId)
  for (const change of [{ unitId: '12B' }, { externalId: 'another-key' }, { endsAt: '2032-06-01T15:00:00.000Z' },
    { slotId: 'slot-2032-06-01T15:00', startsAt: '2032-06-01T15:00:00.000Z', endsAt: '2032-06-01T15:30:00.000Z' }]) {
    await assert.rejects(recordBookingReview(store, { ...input(), work: { revision: 5 }, booking: { ...input().booking, ...change } }),
      { code: 'booking_review_attempt_conflict' })
  }
  assert.deepEqual(await getBookingReview(store, callId), before)
})

test('closure requires existing review, exact source revision and matching calendar receipt', async () => {
  const empty = new MemoryDocumentStore()
  await assert.rejects(resolveBookingReviewRecord(empty, resolving()), { code: 'booking_review_missing' })
  assert.deepEqual(await empty.list('booking-review:'), [])
  const store = await seeded()
  await assert.rejects(resolveBookingReviewRecord(store, { ...resolving(), sourceRevision: 5 }), { code: 'booking_review_receipt_conflict' })
  await recordBookingReview(store, { ...input(), work: { revision: 5 } })
  await assert.rejects(resolveBookingReviewRecord(store, resolving()), { code: 'booking_review_revision_conflict' })
  assert.equal((await getBookingReview(store, callId))?.needsReview, true)
})

test('pending tombstone completes monotonically without losing actor, original revision or callback provenance', async () => {
  const store = await seeded()
  await recordBookingReview(store, { ...input(), callbackPhone: callback(now.toISOString()) })
  const pending = await resolveBookingReviewRecord(store, resolving())
  assert.equal(pending.needsReview, false); assert.equal(pending.resolution?.projection, 'pending')
  const completeReceipt = { ...receipt(), projection: 'complete' as const }
  const complete = await resolveBookingReviewRecord(store, { ...resolving(completeReceipt), now: new Date('2032-06-01T10:01:00.000Z') })
  assert.equal(complete.resolution?.projection, 'complete'); assert.equal(complete.sourceRevision, 4)
  assert.equal(complete.callbackPhone?.callId, callId); assert.equal(complete.resolution?.actorId, 'staff-user')
  assert.deepEqual(await resolveBookingReviewRecord(store, resolving()), complete, 'late pending response cannot downgrade complete')
  assert.deepEqual(await listBookingReviews(store), [complete], 'resolved history remains available with needsReviewfalse')
})

test('later stale or higher-revision caller projections cannot reopen or overwrite terminal evidence', async () => {
  const store = await seeded(), closed = await resolveBookingReviewRecord(store, resolving())
  for (const revision of [2, 4, 100]) {
    const result = await recordBookingReview(store, { ...input(), work: { revision }, name: 'Late stale name',
      now: new Date('2032-06-02T10:00:00.000Z'), booking: { ...input().booking, unitId: '12B' } })
    assert.deepEqual(result, closed)
  }
})

test('a different receipt cannot alter an existing resolution or disguise a changed staff actor', async () => {
  const store = await seeded(), closed = await resolveBookingReviewRecord(store, resolving())
  for (const change of [{ requestId: 'another-request-id' }, { actorId: 'different-staff' }, { checkedAt: '2032-06-02T10:00:00.000Z' }]) {
    await assert.rejects(resolveBookingReviewRecord(store, resolving({ ...receipt(), ...change })), { code: 'booking_review_receipt_conflict' })
  }
  assert.deepEqual(await getBookingReview(store, callId), closed)
})

test('lost document update response is recoverable without reopening or creating a second record', async () => {
  const store = await seeded(), original = store.update.bind(store)
  let fail = true
  store.update = async (key, initial, fn) => { const value = await original(key, initial, fn)
    if (fail) { fail = false; throw new Error('response lost') }; return value }
  await assert.rejects(resolveBookingReviewRecord(store, resolving()), /response lost/)
  const saved = await getBookingReview(store, callId)
  assert.equal(saved?.needsReview, false)
  assert.deepEqual(await resolveBookingReviewRecord(store, resolving()), saved)
  assert.equal((await listBookingReviews(store)).length, 1)
})

test('invalid closed records and mismatched callback provenance fail closed on listing', async () => {
  const store = await seeded(), saved = (await getBookingReview(store, callId))!
  for (const change of [{ needsReview: false }, { sourceRevision: -1 }, { callbackPhone: { ...callback(now.toISOString()), callId: 'different-call' } },
    { resolution: { ...receipt(), callId: 'different-call' }, needsReview: false }]) {
    await store.set(saved.id, { ...saved, ...change })
    await assert.rejects(listBookingReviews(store))
  }
  await store.set(saved.id, saved)
  assert.deepEqual(await getBookingReview(store, callId), saved)
})
