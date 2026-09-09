import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import property from '../../../data/property.json' with { type: 'json' }
import { emptyProfile } from '../profile.ts'
import { deriveFollowUps } from '../followups.ts'
import { consolidateCall, listFollowUps, type CallOutcome } from '../consolidate.ts'
import { receiveFinishedCall, replayFinishedCall, receiptKey, type CallReceipt } from '../inbox.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { MemoryDocumentStore, type DocumentStore } from '../../store/documents.ts'

const config = property as Record<string, unknown>
const originalZone = config.timeZone
const hadZone = Object.hasOwn(config, 'timeZone')
afterEach(() => { if (hadZone) config.timeZone = originalZone; else delete config.timeZone })
const NOW = new Date('2026-09-07T18:00:00Z')
function booked(startsAt = '2026-09-08T22:00:00Z') {
  const p = emptyProfile('+15165550123', NOW)
  p.name = 'Visitor'
  p.email = 'visitor@example.com'
  p.bookings.push({ slotId: `slot-${startsAt.slice(0, 16)}`, startsAt, unitId: '08E', status: 'confirmed', callId: 'zone-call' })
  return p
}
const outcome = (): CallOutcome => ({
  callId: 'zone-call', phone: '+15165550123', at: NOW, durationSeconds: 60,
  qualification: emptyQualification(), name: 'Visitor', email: 'visitor@example.com', unitsDiscussed: ['08E'],
  booking: booked().bookings[0]!, lossReason: null, escalation: null, toolsCalled: [],
})

test('Chicago follow-up times and staff reasons agree in summer and winter; legacy default stays New York', () => {
  for (const [startsAt, dueAt] of [
    ['2026-09-08T22:00:00Z', '2026-09-08T19:00:00.000Z'],
    ['2026-12-08T23:00:00Z', '2026-12-08T20:00:00.000Z'],
  ]) {
    const p = booked(startsAt)
    const followup = deriveFollowUps(p, NOW, 'zone-call', 'America/Chicago').find(f => f.kind === 'confirm_tour')!
    assert.equal(followup.dueAt, dueAt)
    assert.match(followup.reason, /5:00 PM/)
    assert.equal(followup.executable, false)
    assert.match(deriveFollowUps(p, NOW, 'zone-call').find(f => f.kind === 'confirm_tour')!.reason, /6:00 PM/)
  }
})

test('contact-hour clamp uses Chicago local morning, including DST changes on the next local date', () => {
  for (const [at, expected] of [
    ['2026-09-07T11:30:00Z', '2026-09-07T15:00:00.000Z'],
    ['2026-10-31T22:30:00Z', '2026-11-01T16:00:00.000Z'],
    ['2026-03-07T23:30:00Z', '2026-03-08T15:00:00.000Z'],
  ] as const) {
    const now = new Date(at)
    const p = emptyProfile('+15165550123', now)
    p.escalations.push({ trigger: 'restricted:reasonable_accommodation', detail: 'Needs staff review', callId: 'c', at })
    const callback = deriveFollowUps(p, now, 'c', 'America/Chicago').find(f => f.kind === 'callback')!
    assert.equal(callback.dueAt, expected)
  }
})

test('an after-hours emergency creates immediate staff review without claiming notification or waiting until morning', () => {
  const now = new Date('2026-09-08T04:30:00Z') // 11:30pm Chicago
  const p = emptyProfile('+15165550123', now)
  p.name = 'Visitor'
  p.escalations.push({ trigger: 'emergency', detail: 'gas: smell gas', callId: 'current', at: now.toISOString() })
  p.escalations.push({ trigger: 'restricted:reasonable_accommodation', detail: 'Separate staff question', callId: 'current', at: now.toISOString() })
  const callback = deriveFollowUps(p, now, 'current', 'America/Chicago').find(f => f.kind === 'callback')!
  assert.equal(callback.dueAt, now.toISOString())
  assert.match(callback.reason, /Immediate staff review is required/)
  assert.match(callback.reason, /No automatic notification has been sent/)
  assert.equal(callback.executable, false)
  const ordinary = { ...p, escalations: [p.escalations[1]!] }
  assert.equal(deriveFollowUps(ordinary, now, 'current', 'America/Chicago').find(f => f.kind === 'callback')!.dueAt,
    '2026-09-08T15:00:00.000Z', 'non-emergency contact windows are unchanged')
})

test('a past emergency does not generate a new immediate review for an unrelated call', () => {
  const p = emptyProfile('+15165550123', NOW)
  p.escalations.push({ trigger: 'emergency', detail: 'Historical issue', callId: 'old-call', at: '2024-01-01T00:00:00Z' })
  assert.ok(!deriveFollowUps(p, NOW, 'new-call', 'America/Chicago').some(f => f.kind === 'callback'))
  const original = new Date('2024-01-01T00:00:00Z')
  const replay = deriveFollowUps(p, original, 'old-call', 'America/Chicago').find(f => f.kind === 'callback')!
  assert.equal(replay.dueAt, original.toISOString(), 'replay preserves the original urgent deadline')
})

test('timezone support retains attendance-unknown wording and rejects invalid configuration before profile writes', async () => {
  const p = booked('2026-09-06T22:00:00Z')
  const followup = deriveFollowUps(p, NOW, 'zone-call', 'America/Chicago').find(f => f.kind === 'post_tour')!
  assert.match(followup.reason, /confirm whether they attended/)
  assert.doesNotMatch(followup.reason, /Visitor toured/)
  const store = new MemoryDocumentStore()
  assert.throws(() => deriveFollowUps(p, NOW, 'zone-call', 'America/Miami'), /valid IANA timezone/)
  await assert.rejects(consolidateCall(store, outcome(), 'invalid'), /valid IANA timezone/)
  assert.deepEqual(await store.list(''), [])
})

test('finished-call workflow resolves server property timezone instead of a provider payload field', async () => {
  config.timeZone = 'America/Chicago'
  const store = new MemoryDocumentStore()
  const untrusted = { ...outcome(), timeZone: 'America/Los_Angeles' }
  const receipt = await receiveFinishedCall(store, untrusted, NOW)
  assert.equal(receipt.timeZone, 'America/Chicago')
  assert.match((await listFollowUps(store)).find(f => f.kind === 'confirm_tour')!.reason, /5:00 PM/)
})

test('retry keeps the persisted scheduling timezone after property configuration changes', async () => {
  config.timeZone = 'America/Chicago'
  const base = new MemoryDocumentStore()
  let fail = true
  const store: DocumentStore = { get: base.get.bind(base), set: base.set.bind(base), list: base.list.bind(base),
    delete: base.delete.bind(base), describe: base.describe.bind(base), update: async (key, initial, fn) => {
      if (fail && key.startsWith('followup:')) throw new Error('projection unavailable')
      return base.update(key, initial, fn)
    } }
  await assert.rejects(receiveFinishedCall(store, outcome(), NOW), /projection unavailable/)
  assert.equal((await store.get<CallReceipt>(receiptKey('zone-call')))?.timeZone, 'America/Chicago')
  config.timeZone = 'America/Los_Angeles'
  fail = false
  const receipt = await replayFinishedCall(store, 'zone-call', new Date('2026-09-10T18:00:00Z'))
  assert.equal(receipt.status, 'complete')
  assert.equal(receipt.timeZone, 'America/Chicago')
  const followup = (await listFollowUps(store)).find(f => f.kind === 'confirm_tour')!
  assert.equal(followup.dueAt, '2026-09-08T19:00:00.000Z')
  assert.match(followup.reason, /5:00 PM/)
})

test('bad property timezone preserves a replayable receipt and never creates incorrectly scheduled follow-ups', async () => {
  config.timeZone = null
  const store = new MemoryDocumentStore()
  await assert.rejects(receiveFinishedCall(store, outcome(), NOW), /valid IANA timezone/)
  const pending = await store.get<CallReceipt>(receiptKey('zone-call'))
  assert.equal(pending?.status, 'pending')
  assert.equal(pending?.lastErrorCode, 'consolidation_failed')
  assert.equal(pending?.timeZone, undefined)
  assert.equal((await store.list('lead:')).length, 0)
  assert.deepEqual(await listFollowUps(store), [])
  config.timeZone = 'America/Chicago'
  const complete = await replayFinishedCall(store, 'zone-call', NOW)
  assert.equal(complete.timeZone, 'America/Chicago')
  assert.equal(complete.status, 'complete')
})
