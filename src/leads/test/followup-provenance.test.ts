import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consolidateCall, followUpKey, listFollowUps } from '../consolidate.ts'
import type { CallOutcome } from '../consolidate.ts'
import { legacyFollowUpId } from '../followups.ts'
import type { FollowUp } from '../followups.ts'
import { emptyProfile } from '../profile.ts'
import { MemoryDocumentStore } from '../../store/documents.ts'
import type { DocumentStore } from '../../store/documents.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { extracted } from '../../leasing/captured.ts'
import { interactionId } from '../../domain/ids.ts'

const AT = new Date('2026-09-09T14:00:00Z')
const call = (overrides: Partial<CallOutcome> = {}): CallOutcome => ({
  callId: 'first', phone: '+15165551234', at: AT, durationSeconds: 60,
  qualification: emptyQualification(), name: 'Dana', email: null, unitsDiscussed: [],
  booking: null, lossReason: null, escalation: null, toolsCalled: [], ...overrides,
})
const booking = (slotId = 'tour-one', startsAt = '2026-09-12T21:00:00Z', unitId = '4A') =>
  ({ slotId, startsAt, unitId, status: 'confirmed' as const })

function asLegacy(profile: ReturnType<typeof emptyProfile>, followUp: FollowUp): FollowUp {
  const { source: _source, ...legacy } = followUp
  return { ...legacy, id: legacyFollowUpId(profile, followUp) }
}

test('two tours in the same due hour have distinct booking identities and stable original collection deadlines', async () => {
  const store = new MemoryDocumentStore()
  const first = await consolidateCall(store, call({ booking: booking() }))
  const firstCollection = first.followUps.find(f => f.kind === 'collect_email')!
  await consolidateCall(store, call({ callId: 'second', at: new Date('2026-09-09T14:10:00Z'),
    booking: booking('tour-two', '2026-09-12T21:30:00Z', '7B') }))
  const rows = await listFollowUps(store)
  for (const kind of ['confirm_tour', 'remind_tour', 'collect_email']) {
    const items = rows.filter(f => f.kind === kind)
    assert.equal(items.length, 2, kind)
    assert.equal(new Set(items.map(f => f.id)).size, 2)
    assert.deepEqual(new Set(items.map(f => f.source?.booking?.unitId)), new Set(['4A', '7B']))
  }
  assert.equal(rows.find(f => f.id === firstCollection.id)!.dueAt, firstCollection.dueAt)
  assert.equal(rows.find(f => f.id === firstCollection.id)!.createdFromCall, 'first')
})

test('scheduled staff edits, done and skipped work survive later calls and delayed retries unchanged', async () => {
  const store = new MemoryDocumentStore(), original = call({ booking: booking() })
  const first = await consolidateCall(store, original)
  const edited = first.followUps.map((f, index): FollowUp => ({ ...f,
    status: (['scheduled', 'done', 'skipped'] as const)[index]!,
    reason: `Staff decision ${index}`, channel: 'sms', dueAt: '2026-09-11T15:17:00.000Z',
  }))
  for (const f of edited) await store.set(followUpKey(f.id), f)
  await consolidateCall(store, call({ callId: 'new-contact', at: new Date('2026-09-10T14:00:00Z'), name: 'Updated contact' }))
  await consolidateCall(store, { ...original, at: new Date('2026-09-11T14:00:00Z') })
  for (const f of edited) assert.deepEqual(await store.get(followUpKey(f.id)), f)
  assert.equal((await listFollowUps(store)).length, edited.length)
})

test('unrelated later calls never recreate historical callbacks or priced-out watches', async () => {
  for (const outcome of [
    call({ escalation: { trigger: 'human_requested', detail: 'Review my question' } }),
    call({ lossReason: { kind: 'priced_out', detail: 'Above stated ceiling', evidence: 'too much', confidence: 1, at: AT } }),
  ]) {
    const store = new MemoryDocumentStore()
    const first = await consolidateCall(store, outcome)
    assert.equal(first.followUps.length, 1)
    await store.update<FollowUp>(followUpKey(first.followUps[0]!.id), first.followUps[0]!, f => ({ ...f, status: 'done' }))
    const later = await consolidateCall(store, call({ callId: 'later', at: new Date('2026-10-09T14:00:00Z') }))
    assert.deepEqual(later.followUps, [])
    const rows = await listFollowUps(store)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, 'done')
  }
})

test('inherited qualification without evidence from the current call cannot schedule another nurture', async () => {
  const store = new MemoryDocumentStore()
  const qualification = { ...emptyQualification(),
    budget: extracted({ maxMonthly: 4000, stated: true }, 1, interactionId('first'), 'four thousand', AT),
    bedrooms: extracted({ min: 1, max: 1 }, 1, interactionId('first'), 'one bedroom', AT),
  }
  const first = await consolidateCall(store, call({ qualification }))
  assert.equal(first.followUps.filter(f => f.kind === 'nurture').length, 1)
  const later = await consolidateCall(store, call({ callId: 'later', at: new Date('2026-09-10T14:00:00Z') }))
  assert.deepEqual(later.followUps, [])
  assert.equal((await listFollowUps(store)).length, 1)
})

test('separate current-call escalations in the same hour retain each event and neither overwrites newer work', async () => {
  const store = new MemoryDocumentStore()
  const newer = await consolidateCall(store, call({ callId: 'newer', at: new Date('2026-09-09T14:30:00Z'),
    escalation: { trigger: 'human_requested', detail: 'Newer question' } }))
  const saved = newer.followUps[0]!
  await consolidateCall(store, call({ callId: 'older', escalation: { trigger: 'human_requested', detail: 'Original question' } }))
  assert.deepEqual(await store.get(followUpKey(saved.id)), saved)
  const rows = await listFollowUps(store)
  assert.equal(rows.length, 2)
  assert.deepEqual(new Set(rows.map(f => f.source?.callId)), new Set(['older', 'newer']))
})

test('late booking delivery preserves confirmed attribution and distinguishes different units or actual instants', async () => {
  const store = new MemoryDocumentStore()
  const first = await consolidateCall(store, call({ callId: 'newer', booking: booking() }))
  const acceptedBooking = first.profile.bookings[0]!
  const older = await consolidateCall(store, call({ callId: 'older', at: new Date('2026-09-08T14:00:00Z'),
    booking: { ...booking(), startsAt: '2026-09-12T17:00:00-04:00', unitId: ' 4a ' } }))
  assert.deepEqual(older.profile.bookings, [acceptedBooking])
  assert.deepEqual(older.followUps, [], 'older projection cannot create work for a newer booking')
  const failed = await consolidateCall(store, call({ callId: 'failed-later', at: new Date('2026-09-10T14:00:00Z'),
    booking: { ...booking(), status: 'failed' } }))
  assert.deepEqual(failed.profile.bookings, [acceptedBooking])
  const anotherUnit = await consolidateCall(store, call({ callId: 'other-unit', booking: booking('tour-one', '2026-09-12T21:00:00Z', '7B') }))
  assert.equal(anotherUnit.profile.bookings.length, 2)
  const anotherTime = await consolidateCall(store, call({ callId: 'other-time', booking: booking('tour-one', '2026-09-12T21:30:00Z', '4A') }))
  assert.equal(anotherTime.profile.bookings.length, 3)
})

test('an unambiguous legacy row retains its original ID, due time and staff decision while gaining source identity', async () => {
  const store = new MemoryDocumentStore()
  const original = call({ escalation: { trigger: 'human_requested', detail: 'Original question' } })
  const first = await consolidateCall(store, original), generated = first.followUps[0]!
  await store.delete(followUpKey(generated.id))
  const legacy = { ...asLegacy(first.profile, generated), status: 'skipped' as const,
    dueAt: '2026-09-20T16:23:00.000Z', reason: 'Staff resolved directly' }
  await store.set(followUpKey(legacy.id), legacy)
  const replay = await consolidateCall(store, original)
  assert.equal(replay.followUps.length, 1)
  assert.deepEqual(replay.followUps[0], { ...legacy, source: generated.source })
  assert.deepEqual((await listFollowUps(store)).map(f => f.id), [legacy.id])
  await consolidateCall(store, original)
  assert.equal((await listFollowUps(store)).length, 1)
})

test('ambiguous legacy hour collisions are retained with visible review provenance instead of guessed mappings or duplicate queue entries', async () => {
  const store = new MemoryDocumentStore()
  const first = await consolidateCall(store, call({ booking: booking() }))
  const secondCall = call({ callId: 'second', at: new Date('2026-09-09T14:10:00Z'),
    booking: booking('tour-two', '2026-09-12T21:30:00Z', '7B') })
  const second = await consolidateCall(store, secondCall)
  for (const f of await listFollowUps(store)) await store.delete(followUpKey(f.id))
  const legacyRows = first.followUps.map(f => asLegacy(first.profile, f))
  for (const row of legacyRows) await store.set(followUpKey(row.id), row)
  const replay = await consolidateCall(store, secondCall)
  assert.equal(replay.followUps.length, legacyRows.length)
  const rows = await listFollowUps(store)
  assert.equal(rows.length, legacyRows.length)
  for (const row of rows) {
    const original = legacyRows.find(f => f.id === row.id)!
    assert.equal(row.dueAt, original.dueAt)
    assert.equal(row.status, original.status)
    assert.equal(row.reason, original.reason)
    assert.equal(row.source, undefined)
    assert.equal(row.reconciliation?.status, 'needs_review')
    assert.equal(row.reconciliation?.candidateIds.length, 2)
  }
  assert.equal(new Set(second.profile.bookings.map(b => b.slotId)).size, 2)
  await consolidateCall(store, secondCall)
  assert.equal((await listFollowUps(store)).length, legacyRows.length)
  // Processing the older event alone cannot make an ambiguous legacy bucket look
  // unique by temporarily excluding the newer booking from newly derived work.
  for (const row of legacyRows) await store.set(followUpKey(row.id), row)
  await consolidateCall(store, call({ booking: booking() }))
  assert.ok((await listFollowUps(store)).every(row => row.reconciliation?.candidateIds.length === 2))
})

test('partial projection replay retains original booking time and recovers only missing work after a newer contact call', async () => {
  const base = new MemoryDocumentStore()
  let writes = 0, fail = true
  const store: DocumentStore = { ...base, get: base.get.bind(base), set: base.set.bind(base),
    list: base.list.bind(base), delete: base.delete.bind(base), describe: base.describe.bind(base),
    update: async (key, initial, fn) => {
      if (key.startsWith('followup:') && fail && ++writes === 2) throw new Error('projection stopped')
      return base.update(key, initial, fn)
    } }
  const original = call({ booking: booking() })
  await assert.rejects(consolidateCall(store, original), /projection stopped/)
  fail = false
  await consolidateCall(store, call({ callId: 'later', at: new Date('2026-09-10T14:00:00Z') }))
  await consolidateCall(store, { ...original, at: new Date('2026-09-11T14:00:00Z') })
  const rows = await listFollowUps(store)
  assert.equal(rows.length, 3)
  const collection = rows.find(f => f.kind === 'collect_email')!
  assert.equal(collection.dueAt, '2026-09-09T16:00:00.000Z')
  assert.equal(collection.createdFromCall, 'first')
  assert.ok(rows.every(f => f.executable === false))
})
