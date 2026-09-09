import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { MemoryCalendarStore } from '../../calendar/store.ts'
import { holdTourChange, listTourChangeRequests, recordTourChangeRequest, reviewTourChangeRequest,
  tourChangeExcerpt, tourChangeHold, tourProspectPhone } from '../tour-change.ts'

test('tour change detector distinguishes personal requests from policy, hypothetical and negative statements', () => {
  for (const words of ['I need to reschedule my tour for Wednesday at four', 'Can you move our appointment?',
    'Please cancel the tour', 'I cannot make my showing', 'I already booked a tour. I want to reschedule my tour.',
    'I already booked a tour. Can you move it to Wednesday?', 'I need to reschedule my tour if possible']) {
    assert.ok(tourChangeExcerpt(words), words)
  }
  for (const words of ['Can I book a new tour?', 'What is your reschedule policy?', 'If I book, can I reschedule my tour?',
    'I do not want to reschedule my tour', "I'm not trying to reschedule my tour", "Don't cancel my appointment", 'I want to move into the building',
    'Can I bring my pet on the tour?', 'Please change my phone number']) assert.equal(tourChangeExcerpt(words), null, words)
  assert.equal(tourProspectPhone('call-123456789'), null)
  assert.equal(tourProspectPhone('(202) 555-0123'), '+12025550123')
})

test('request delivery and review are idempotent, original time/evidence survives and contact changes reopen review', async () => {
  const store = new MemoryDocumentStore(), at = new Date('2032-06-01T10:00:00Z')
  const input = { callId: 'synthetic-request', at, reason: 'caller_requested' as const, excerpt: 'Please move my tour to Friday' }
  const first = await recordTourChangeRequest(store, input)
  assert.equal(first.status, 'pending')
  const reviewed = await reviewTourChangeRequest(store, { id: first.id, expectedRevision: 0, actorId: 'staff-a', at, note: 'Reviewed with caller' })
  assert.equal(reviewed.status, 'reviewed')
  assert.deepEqual(await reviewTourChangeRequest(store, { id: first.id, expectedRevision: 0, actorId: 'staff-a', at, note: 'Reviewed with caller' }), reviewed)
  assert.deepEqual(await recordTourChangeRequest(store, { ...input, at: new Date('2032-06-02T12:00:00Z') }), reviewed)
  const changed = await recordTourChangeRequest(store, { ...input, at: new Date('2032-06-02T12:00:00Z'), phone: '2025550123' })
  assert.equal(changed.status, 'pending')
  assert.equal(changed.firstRequestedAt, first.firstRequestedAt)
  assert.deepEqual(changed.excerpts, first.excerpts)
  assert.equal(changed.identityVerified, false)
  assert.equal(changed.notificationStatus, 'not_sent')
  await assert.rejects(reviewTourChangeRequest(store, { id: first.id, expectedRevision: 0, actorId: 'staff-a', at }), { code: 'tour_change_conflict' })
  assert.equal((await listTourChangeRequests(store)).length, 1)
})

test('call-only calendar holds persist through retries and do not invent emergency holds', async () => {
  const store = new MemoryCalendarStore(), at = new Date('2032-06-01T10:00:00Z')
  await holdTourChange(store, 'call-a', at)
  await holdTourChange(store, 'call-a', new Date('2032-06-02T10:00:00Z'))
  const state = await store.read()
  assert.equal(state.tourChangeHolds?.length, 1)
  assert.equal(state.tourChangeHolds?.[0]?.recordedAt, at.toISOString())
  assert.equal(tourChangeHold(state, 'call-a'), true)
  assert.equal(tourChangeHold(state, 'call-b'), false)
  assert.equal(state.emergencyHolds, undefined)
})

test('a bounded non-BMP excerpt survives storage, listing and retry at the same Unicode boundary', async () => {
  const store = new MemoryDocumentStore()
  const input = { callId: 'unicode-request', at: new Date('2032-06-01T10:00:00Z'), reason: 'caller_requested' as const,
    excerpt: '🙂'.repeat(1001), name: '🙂'.repeat(121) }
  const saved = await recordTourChangeRequest(store, input)
  assert.equal([...saved.excerpts[0]!].length, 1000)
  assert.equal([...saved.name!].length, 120)
  assert.deepEqual(await listTourChangeRequests(store), [saved])
  assert.deepEqual(await recordTourChangeRequest(store, input), saved)
})

test('ninth distinct request reopens review and retains latest words without cycling exact or evicted replays', async () => {
  const store = new MemoryDocumentStore(), at = new Date('2032-06-01T10:00:00Z')
  const input = { callId: 'evidence-overflow', at, reason: 'caller_requested' as const }
  let saved = await recordTourChangeRequest(store, { ...input, excerpt: 'Please move my tour, detail 0' })
  for (let i = 1; i < 8; i++) saved = await recordTourChangeRequest(store, { ...input, excerpt: `Please move my tour, detail ${i}` })
  const reviewed = await reviewTourChangeRequest(store, { id: saved.id, expectedRevision: saved.revision, at, actorId: 'staff-a' })
  const cancellation = 'Actually cancel my tour; I will not attend.'
  const updated = await recordTourChangeRequest(store, { ...input, excerpt: cancellation })
  assert.equal(updated.status, 'pending')
  assert.equal(updated.revision, reviewed.revision + 1)
  assert.equal(updated.excerpts.length, 8)
  assert.equal(updated.excerpts[0], 'Please move my tour, detail 0')
  assert.equal(updated.excerpts.at(-1), cancellation)
  assert.equal(updated.excerptHashes?.length, 9)
  assert.deepEqual(await recordTourChangeRequest(store, { ...input, excerpt: cancellation }), updated)
  const secondReview = await reviewTourChangeRequest(store, { id: updated.id, expectedRevision: updated.revision, at, actorId: 'staff-a' })
  for (const excerpt of [cancellation, 'Please move my tour, detail 1']) {
    assert.deepEqual(await recordTourChangeRequest(store, { ...input, excerpt }), secondReview,
      'replay of current or evicted evidence must not reopen completed staff review')
  }
})

test('exhausted evidence identity capacity refuses new evidence explicitly and preserves exact retries', async () => {
  const store = new MemoryDocumentStore(), input = { callId: 'bounded-evidence', at: new Date('2032-06-01T10:00:00Z'), reason: 'caller_requested' as const }
  for (let i = 0; i < 256; i++) await recordTourChangeRequest(store, { ...input, excerpt: `Request detail ${i}` })
  const before = (await listTourChangeRequests(store))[0]!
  await assert.rejects(recordTourChangeRequest(store, { ...input, excerpt: 'New instructions beyond the identity limit' }), { code: 'tour_change_conflict' })
  assert.deepEqual((await listTourChangeRequests(store))[0], before)
  assert.deepEqual(await recordTourChangeRequest(store, { ...input, excerpt: 'Request detail 1' }), before)
})
