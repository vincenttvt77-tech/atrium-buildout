import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveFollowUps } from '../followups.ts'
import { emptyProfile } from '../profile.ts'
import { consolidateCall, followUpKey, listFollowUps } from '../consolidate.ts'
import type { CallOutcome } from '../consolidate.ts'
import type { FollowUp } from '../followups.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { MemoryDocumentStore } from '../../store/documents.ts'

const AT = new Date('2026-09-07T18:00:00.000Z')
function profile(startsAt: string, now = AT) {
  const p = emptyProfile('+12125550123', now)
  p.name = 'Synthetic visitor'; p.email = 'visitor@example.test'
  p.calls.push({ callId: 'booking-call', at: now.toISOString(), durationSeconds: 60, outcome: 'Booked', toolsCalled: ['book_tour'] })
  p.bookings.push({ slotId: `slot-${startsAt}`, startsAt, unitId: '12A', status: 'confirmed', callId: 'booking-call' })
  return p
}

test('a contact-window adjustment at or after the tour never becomes a confirmation', () => {
  for (const [zone, start, now] of [
    ['America/New_York', '2026-09-09T13:00:00.000Z', AT], // 9am -> 10am is too late.
    ['America/New_York', '2026-09-09T14:00:00.000Z', AT], // 10am confirmation equals tour.
    ['America/New_York', '2026-09-10T02:00:00.000Z', AT], // 10pm -> next morning is too late.
    ['America/Chicago', '2026-11-01T15:00:00.000Z', AT], // 9am after DST fall-back.
    ['America/Chicago', '2026-03-08T14:00:00.000Z', new Date('2026-03-06T18:00:00Z')],
    ['Asia/Kathmandu', '2026-09-09T03:15:00.000Z', AT], // 9am at a quarter-hour offset.
  ] as const) {
    const rows = deriveFollowUps(profile(start, now), now, 'booking-call', zone)
    assert.equal(rows.some(row => row.kind === 'confirm_tour'), false, `${zone} ${start}`)
    assert.ok(rows.some(row => row.kind === 'post_tour'), 'unsafe confirmation suppression must not lose attendance work')
    for (const row of rows.filter(row => row.kind === 'remind_tour')) assert.ok(Date.parse(row.dueAt) < Date.parse(start))
  }
})

test('a valid adjusted morning confirmation remains before the tour and after its eligibility boundary', () => {
  const start = '2026-09-09T14:30:00.000Z' // 10:30am New York.
  const confirmation = deriveFollowUps(profile(start), AT, 'booking-call').find(row => row.kind === 'confirm_tour')!
  assert.equal(confirmation.dueAt, '2026-09-09T14:00:00.000Z')
  assert.ok(Date.parse(confirmation.dueAt) < Date.parse(start))
  const tooLate = new Date('2026-09-09T13:00:00.000Z')
  assert.equal(deriveFollowUps(profile(start), tooLate, 'booking-call').some(row => row.kind === 'confirm_tour'), false,
    'exactly one hour before the adjusted reminder is outside the existing strict eligibility boundary')
})

test('a future confirmed tour has one stable attendance-check identity before and after its scheduled time', () => {
  const p = profile('2026-09-09T21:00:00.000Z')
  const before = deriveFollowUps(p, AT, 'booking-call').filter(row => row.kind === 'post_tour')
  const after = deriveFollowUps(p, new Date('2026-09-11T18:00:00Z'), 'booking-call').filter(row => row.kind === 'post_tour')
  assert.equal(before.length, 1); assert.equal(after.length, 1)
  assert.equal(before[0]!.dueAt, '2026-09-10T15:00:00.000Z')
  assert.equal(before[0]!.id, after[0]!.id); assert.equal(before[0]!.dueAt, after[0]!.dueAt)
  assert.deepEqual(before[0]!.source, after[0]!.source)
  assert.equal(before[0]!.source!.at, AT.toISOString())
  assert.equal(before[0]!.createdFromCall, 'booking-call')
  assert.equal(before[0]!.executable, false)
  assert.match(before[0]!.reason, /confirm whether they attended/)
  assert.doesNotMatch(before[0]!.reason, /visitor toured|attendance confirmed/i)
})

test('finished-call projection saves the future attendance task immediately and retries preserve staff completion', async () => {
  const p = profile('2026-09-09T21:00:00.000Z'), store = new MemoryDocumentStore()
  const call: CallOutcome = { callId: 'booking-call', phone: p.phone, at: AT, durationSeconds: 60, qualification: emptyQualification(),
    name: p.name, email: p.email, unitsDiscussed: ['12A'], booking: p.bookings[0]!, lossReason: null, escalation: null, toolsCalled: ['book_tour'] }
  await consolidateCall(store, call)
  const saved = (await listFollowUps(store)).find(row => row.kind === 'post_tour')!
  assert.ok(saved, 'no later clock tick or another call should be needed to create this task')
  assert.ok(Date.parse(saved.dueAt) > Date.parse(p.bookings[0]!.startsAt))
  const completed: FollowUp = { ...saved, status: 'done', reason: 'Staff checked actual attendance.' }
  await store.set(followUpKey(saved.id), completed)
  await consolidateCall(store, { ...call, at: new Date('2026-09-12T18:00:00Z') })
  const after = (await listFollowUps(store)).filter(row => row.kind === 'post_tour')
  assert.deepEqual(after, [completed])
})

test('failed, arranging and newer unknown bookings do not gain attendance tasks from an older event', () => {
  const p = profile('2026-09-09T21:00:00.000Z')
  for (const status of ['failed', 'arranging'] as const) {
    p.bookings[0]!.status = status
    assert.equal(deriveFollowUps(p, AT, 'booking-call').some(row => row.kind === 'post_tour'), false)
  }
  p.bookings[0]!.status = 'confirmed'
  p.calls.push({ callId: 'older-call', at: '2026-09-06T18:00:00.000Z', durationSeconds: 30, outcome: 'Contact', toolsCalled: [] })
  assert.deepEqual(deriveFollowUps(p, new Date('2026-09-06T18:00:00Z'), 'older-call'), [])
})
