import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import type { DocumentStore } from '../../store/documents.ts'
import { consolidateCall, followUpKey, listFollowUps, profileKey } from '../consolidate.ts'
import type { CallOutcome } from '../consolidate.ts'
import type { FollowUp } from '../followups.ts'
import { deriveFollowUps, legacyFollowUpId } from '../followups.ts'
import { emptyProfile } from '../profile.ts'
import type { LeadProfile } from '../profile.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { reconcileRescheduledTour, pendingRescheduleVisibility } from '../reschedule.ts'
import type { RescheduleProjectionInput } from '../reschedule.ts'

const phone = '+12125550123', externalId = 'synthetic-reservation-1'
const before = { slotId: 'tour-old', startsAt: '2026-09-12T20:00:00.000Z', endsAt: '2026-09-12T20:30:00.000Z', unitId: '12A' }
const after = { slotId: 'tour-new', startsAt: '2026-09-14T21:00:00.000Z', endsAt: '2026-09-14T21:30:00.000Z', unitId: '12A' }
const original: CallOutcome = { callId: 'original-call', phone, at: new Date('2026-09-09T14:00:00.000Z'), durationSeconds: 60,
  qualification: emptyQualification(), name: 'Synthetic prospect', email: null, unitsDiscussed: ['12A'],
  booking: { ...before, externalId, status: 'confirmed' }, lossReason: null, escalation: null, toolsCalled: ['book_tour'] }
const change: RescheduleProjectionInput['change'] = { requestId: 'reschedule-1', revision: 1, at: '2026-09-10T15:00:00.000Z',
  actorId: 'staff-1', timeZone: 'America/New_York', from: before, to: after, projection: 'pending' }
const input: RescheduleProjectionInput = { change, booking: { ...after, externalId, prospectName: original.name!, prospectEmail: null,
  prospectPhone: phone, bookedAt: original.at.toISOString(), interactionId: original.callId, revision: 1, rescheduleHistory: [change] } }
const reminder = (row: FollowUp) => ['confirm_tour', 'remind_tour', 'post_tour'].includes(row.kind)
function wrapped(base: MemoryDocumentStore, overrides: Partial<DocumentStore>): DocumentStore {
  return { get: base.get.bind(base), set: base.set.bind(base), update: base.update.bind(base), list: base.list.bind(base),
    delete: base.delete.bind(base), describe: base.describe.bind(base), ...overrides }
}

test('reschedule keeps one booking, retires old reminders and preserves staff decisions and contact collection', async () => {
  const store = new MemoryDocumentStore()
  const first = await consolidateCall(store, original)
  const confirm = first.followUps.find(row => row.kind === 'confirm_tour')!
  const remind = first.followUps.find(row => row.kind === 'remind_tour')!
  const collection = first.followUps.find(row => row.kind === 'collect_email')!
  const done = { ...confirm, status: 'done' as const, reason: 'Staff already spoke to the prospect.' }
  const staffNote = { ...remind, reason: 'Staff-edited old reminder.', dueAt: '2026-09-11T17:15:00.000Z' }
  await store.set(followUpKey(done.id), done); await store.set(followUpKey(staffNote.id), staffNote)
  await store.set(followUpKey(collection.id), { ...collection, status: 'skipped' })
  const result = await reconcileRescheduledTour(store, input)
  assert.equal(result.status, 'complete')
  const profile = (await store.get<LeadProfile>(profileKey(phone)))!
  assert.equal(profile.bookings.length, 1); assert.equal(profile.bookings[0]!.startsAt, after.startsAt)
  assert.equal(profile.bookings[0]!.externalId, externalId); assert.equal(profile.bookings[0]!.rescheduleRevision, 1)
  assert.equal(profile.bookings[0]!.callId, original.callId); assert.deepEqual(profile.calls, first.profile.calls)
  assert.deepEqual(await store.get(followUpKey(done.id)), done)
  const retired = (await store.get<FollowUp>(followUpKey(remind.id)))!
  assert.equal(retired.status, 'skipped'); assert.equal(retired.reason, staffNote.reason); assert.equal(retired.dueAt, staffNote.dueAt)
  assert.equal(retired.superseded!.requestId, change.requestId)
  const rows = await listFollowUps(store)
  assert.ok(rows.filter(row => row.status === 'scheduled' && reminder(row)).every(row => row.source?.booking?.revision === 1))
  assert.equal(rows.filter(row => row.kind === 'collect_email').length, 1)
  assert.equal(rows.find(row => row.kind === 'collect_email')!.status, 'skipped')
  assert.equal(rows.find(row => row.kind === 'collect_email')!.dueAt, collection.dueAt)
})

test('exact retries retain human changes and do not add records; operation conflicts cannot rewrite provenance', async () => {
  const store = new MemoryDocumentStore(); await consolidateCall(store, original)
  await reconcileRescheduledTour(store, input)
  const rows = await listFollowUps(store), current = rows.find(row => row.status === 'scheduled' && row.kind === 'remind_tour')!
  const human = { ...current, status: 'done' as const, reason: 'Handled directly.' }
  await store.set(followUpKey(human.id), human)
  await reconcileRescheduledTour(store, input)
  assert.equal((await listFollowUps(store)).length, rows.length)
  assert.deepEqual(await store.get(followUpKey(human.id)), human)
  await assert.rejects(reconcileRescheduledTour(store, { ...input, change: { ...change, actorId: 'other-staff' } }), /conflicts/)
})

test('partial KV projection resumes from retained index without restoring old time or duplicating follow-ups', async () => {
  const base = new MemoryDocumentStore(); await consolidateCall(base, original)
  let writes = 0, fail = true
  const store = wrapped(base, { update: async (key, initial, fn) => {
    if (key.startsWith('followup:') && fail && ++writes === 2) throw new Error('Synthetic projection outage')
    return base.update(key, initial, fn)
  } })
  await assert.rejects(reconcileRescheduledTour(store, input), /Synthetic projection outage/)
  assert.equal((await base.list('tour-reschedule:')).length, 1)
  assert.equal((await base.get<LeadProfile>(profileKey(phone)))!.bookings[0]!.startsAt, after.startsAt)
  const pending = pendingRescheduleVisibility({ blocks: [], bookings: [input.booking] }, await listFollowUps(base))
  assert.equal(pending.rescheduleProjectionPending.length, 1)
  assert.ok(pending.followUps.every(row => !(row.status === 'scheduled' && reminder(row))))
  fail = false; assert.equal((await reconcileRescheduledTour(store, input)).status, 'complete')
  const count = (await listFollowUps(base)).length
  await reconcileRescheduledTour(store, input)
  assert.equal((await listFollowUps(base)).length, count)
})

test('an end report arriving after the calendar move creates only the moved reservation, including legacy calls', async () => {
  for (const legacy of [false, true]) {
    const store = new MemoryDocumentStore()
    assert.equal((await reconcileRescheduledTour(store, input)).status, 'needs_review')
    assert.deepEqual(await store.list('lead:'), [])
    const booking = { ...original.booking! }; if (legacy) delete booking.externalId
    const result = await consolidateCall(store, { ...original, booking })
    assert.equal(result.profile.bookings.length, 1)
    assert.equal(result.profile.bookings[0]!.startsAt, after.startsAt)
    assert.equal(result.profile.bookings[0]!.externalId, externalId)
    assert.equal(result.profile.calls[0]!.at, original.at.toISOString())
    const count = (await listFollowUps(store)).length
    await consolidateCall(store, { ...original, booking })
    assert.equal((await listFollowUps(store)).length, count)
    assert.ok((await listFollowUps(store)).filter(row => reminder(row) && row.status === 'scheduled').every(row => row.source?.booking?.revision === 1))
  }
})

test('a stale call projection already holding the old profile cannot recreate active old reminders', async () => {
  const base = new MemoryDocumentStore(); await consolidateCall(base, original)
  let release!: () => void, reached!: () => void, pause = true
  const barrier = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const store = wrapped(base, { update: async (key, initial, fn) => {
    const result = await base.update(key, initial, fn)
    if (pause && key === profileKey(phone)) { pause = false; reached(); await gate }
    return result
  } })
  const stale = consolidateCall(store, original)
  await barrier; await reconcileRescheduledTour(base, input); release(); await stale
  const profile = (await base.get<LeadProfile>(profileKey(phone)))!
  assert.equal(profile.bookings.length, 1); assert.equal(profile.bookings[0]!.startsAt, after.startsAt)
  assert.ok((await listFollowUps(base)).filter(row => reminder(row) && row.status === 'scheduled').every(row => row.source?.booking?.revision === 1))
})

test('moving back to the original hour creates new revision intents and stale retries cannot undo the later move', async () => {
  const store = new MemoryDocumentStore(); await consolidateCall(store, original); await reconcileRescheduledTour(store, input)
  const second = { ...change, requestId: 'reschedule-2', revision: 2, at: '2026-09-10T16:00:00.000Z', from: after, to: before }
  await reconcileRescheduledTour(store, { change: second, booking: { ...input.booking, ...before, revision: 2, rescheduleHistory: [change, second] } })
  await reconcileRescheduledTour(store, input)
  const profile = (await store.get<LeadProfile>(profileKey(phone)))!
  assert.equal(profile.bookings.length, 1); assert.equal(profile.bookings[0]!.rescheduleRevision, 2)
  assert.equal(profile.bookings[0]!.startsAt, before.startsAt)
  const active = (await listFollowUps(store)).filter(row => reminder(row) && row.status === 'scheduled')
  assert.ok(active.length > 0); assert.ok(active.every(row => row.source?.booking?.revision === 2))
})

test('ambiguous legacy rows remain pending without guessing or creating prospect records', async () => {
  const store = new MemoryDocumentStore()
  const profile = { ...emptyProfile(phone, original.at), bookings: [
    { ...before, status: 'confirmed' as const, callId: 'one' }, { ...before, status: 'confirmed' as const, callId: 'two' },
  ] }
  await store.set(profileKey(phone), profile)
  const result = await reconcileRescheduledTour(store, input)
  assert.equal(result.status, 'needs_review'); assert.equal(result.reason, 'booking_identity_ambiguous')
  assert.deepEqual(await store.get(profileKey(phone)), profile)
  const anonymous = new MemoryDocumentStore()
  const { interactionId: _interaction, ...booking } = input.booking
  assert.equal((await reconcileRescheduledTour(anonymous, { change, booking: { ...booking, prospectPhone: 'unknown' } })).status, 'needs_review')
  assert.deepEqual(await anonymous.list('lead:'), [])
})

test('separate property document stores never share projection indexes or same-phone changes', async () => {
  const a = new MemoryDocumentStore(), b = new MemoryDocumentStore()
  await consolidateCall(a, original); await consolidateCall(b, original)
  await reconcileRescheduledTour(a, input)
  assert.equal((await b.get<LeadProfile>(profileKey(phone)))!.bookings[0]!.startsAt, before.startsAt)
  assert.deepEqual(await b.list('tour-reschedule:'), [])
})

test('rescheduling one tour preserves another same-call legacy reminder and retires only an identified old intent', async () => {
  const store = new MemoryDocumentStore()
  const profile: LeadProfile = { ...emptyProfile(phone, original.at), email: 'synthetic@example.test',
    calls: [{ callId: original.callId, at: original.at.toISOString(), durationSeconds: 60, outcome: 'Booked', toolsCalled: ['book_tour'] }],
    bookings: [{ ...before, externalId, status: 'confirmed', callId: original.callId },
      { ...after, externalId: 'other-reservation', status: 'confirmed', callId: original.callId }] }
  await store.set(profileKey(phone), profile)
  const legacy = deriveFollowUps(profile, original.at, original.callId).filter(row => row.kind === 'remind_tour').map(row => {
    const { source: _source, ...withoutSource } = row
    return { ...withoutSource, id: legacyFollowUpId(profile, row), reason: 'Staff-edited reminder.', dueAt: '2026-09-11T17:15:00.000Z' }
  })
  assert.equal(legacy.length, 2)
  for (const row of legacy) await store.set(followUpKey(row.id), row)
  await reconcileRescheduledTour(store, input)
  assert.equal((await store.get<FollowUp>(followUpKey(legacy[0]!.id)))!.superseded!.bookingExternalId, externalId)
  assert.deepEqual(await store.get(followUpKey(legacy[1]!.id)), legacy[1], 'stable legacy ID, not mutable due time or shared call, identifies the other tour')
})

test('unidentifiable same-call legacy reminder stays intact with explicit review metadata after a move and retry', async () => {
  const store = new MemoryDocumentStore()
  const profile: LeadProfile = { ...emptyProfile(phone, original.at), email: 'synthetic@example.test',
    calls: [{ callId: original.callId, at: original.at.toISOString(), durationSeconds: 60, outcome: 'Booked', toolsCalled: ['book_tour'] }],
    bookings: [{ ...before, externalId, status: 'confirmed', callId: original.callId },
      { ...after, externalId: 'other-reservation', status: 'confirmed', callId: original.callId }] }
  await store.set(profileKey(phone), profile)
  const template = deriveFollowUps(profile, original.at, original.callId).find(row => row.kind === 'remind_tour')!
  const { source: _source, ...withoutSource } = template
  const ambiguous: FollowUp = { ...withoutSource, id: 'legacy-unknown-hour', reason: 'Preserve the staff decision.', dueAt: '2026-09-11T17:15:00.000Z' }
  await store.set(followUpKey(ambiguous.id), ambiguous)
  await reconcileRescheduledTour(store, input)
  const saved = (await store.get<FollowUp>(followUpKey(ambiguous.id)))!
  assert.equal(saved.status, ambiguous.status); assert.equal(saved.reason, ambiguous.reason); assert.equal(saved.dueAt, ambiguous.dueAt)
  assert.equal(saved.superseded, undefined); assert.equal(saved.source, undefined)
  assert.equal(saved.reconciliation!.code, 'legacy_followup_identity_ambiguous')
  assert.equal(saved.reconciliation!.candidateIds.length, 2)
  await reconcileRescheduledTour(store, input)
  assert.deepEqual(await store.get(followUpKey(ambiguous.id)), saved)
})

test('pending projection holds positively identified reminders without hiding source-less same-phone work', () => {
  const profile = { ...emptyProfile(phone, original.at), bookings: [{ ...before, externalId, status: 'confirmed' as const, callId: original.callId }] }
  const known = deriveFollowUps(profile, original.at, original.callId).find(row => row.kind === 'remind_tour')!
  const { source: _source, ...withoutSource } = known
  const sameCall = { ...withoutSource, id: 'legacy-same-call' }
  const otherCall = { ...withoutSource, id: 'legacy-other-call', createdFromCall: 'another-call' }
  const visible = pendingRescheduleVisibility({ blocks: [], bookings: [input.booking] }, [known, sameCall, otherCall])
  assert.deepEqual(visible.heldFollowUps, [known])
  assert.deepEqual(visible.followUps, [sameCall, otherCall])
  assert.equal(visible.rescheduleProjectionPending.length, 1, 'the unresolved calendar move remains explicitly visible')
})

test('a colliding legacy due-hour ID does not select one of two distinct same-call tours', async () => {
  const store = new MemoryDocumentStore()
  const profile: LeadProfile = { ...emptyProfile(phone, original.at), email: 'synthetic@example.test',
    calls: [{ callId: original.callId, at: original.at.toISOString(), durationSeconds: 60, outcome: 'Booked', toolsCalled: ['book_tour'] }],
    bookings: [{ ...before, externalId, status: 'confirmed', callId: original.callId },
      { ...before, slotId: 'another-slot', startsAt: '2026-09-12T20:30:00.000Z', externalId: 'other-reservation', status: 'confirmed', callId: original.callId }] }
  await store.set(profileKey(phone), profile)
  const confirmations = deriveFollowUps(profile, original.at, original.callId).filter(row => row.kind === 'confirm_tour')
  assert.equal(confirmations.length, 2)
  assert.equal(legacyFollowUpId(profile, confirmations[0]!), legacyFollowUpId(profile, confirmations[1]!))
  const { source: _source, ...withoutSource } = confirmations[0]!
  const legacy: FollowUp = { ...withoutSource, id: legacyFollowUpId(profile, confirmations[0]!) }
  await store.set(followUpKey(legacy.id), legacy)
  await reconcileRescheduledTour(store, input)
  const saved = (await store.get<FollowUp>(followUpKey(legacy.id)))!
  assert.equal(saved.status, 'scheduled'); assert.equal(saved.superseded, undefined)
  assert.equal(saved.reconciliation!.candidateIds.length, 2)
})

test('late old call and unrelated old reports do not manufacture overdue pre-tour reminders after a near-term move', async () => {
  const store = new MemoryDocumentStore()
  const near = { ...change, to: { ...after, startsAt: '2026-09-10T16:00:00.000Z', endsAt: '2026-09-10T16:30:00.000Z' } }
  await reconcileRescheduledTour(store, { change: near, booking: { ...input.booking, ...near.to, rescheduleHistory: [near] } })
  await consolidateCall(store, original)
  await consolidateCall(store, { ...original, callId: 'unrelated-old-call', at: new Date('2026-09-09T15:00:00Z'), booking: null })
  const active = (await listFollowUps(store)).filter(row => row.status === 'scheduled' && reminder(row))
  assert.equal(active.length, 1)
  assert.equal(active[0]!.kind, 'post_tour')
  assert.ok(Date.parse(active[0]!.dueAt) > Date.parse(near.to.startsAt))
  const profile = (await store.get<LeadProfile>(profileKey(phone)))!
  assert.equal(profile.calls[0]!.at, original.at.toISOString())
  assert.equal(profile.bookings[0]!.rescheduledAt, change.at)
})
