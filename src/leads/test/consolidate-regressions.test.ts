import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consolidateCall, listProfiles } from '../consolidate.ts'
import type { CallOutcome } from '../consolidate.ts'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { emptyQualification } from '../../leasing/qualification.ts'

const call = (overrides: Partial<CallOutcome> = {}): CallOutcome => ({
  callId: 'call-1', phone: '+15165551234', at: new Date('2026-09-09T14:00:00Z'),
  durationSeconds: 60, qualification: emptyQualification(), name: 'Dana', email: null,
  unitsDiscussed: [], booking: null, lossReason: null, escalation: null, toolsCalled: [], ...overrides,
})

test('duplicate end-of-call delivery does not duplicate escalation or rewrite the call', async () => {
  const store = new MemoryDocumentStore()
  const original = call({ escalation: { trigger: 'human_requested', detail: 'call me' } })
  await consolidateCall(store, original)
  await consolidateCall(store, original)
  const retry = await consolidateCall(store, call({ name: null }))
  assert.equal(retry.profile.escalations.length, 1)
  assert.equal(retry.profile.calls.length, 1)
  assert.match(retry.profile.calls[0]!.outcome, /Escalated/)
})

test('withheld caller IDs remain separate leads', async () => {
  const store = new MemoryDocumentStore()
  await consolidateCall(store, call({ phone: 'unknown', callId: 'a', name: 'Ana' }))
  await consolidateCall(store, call({ phone: 'unknown', callId: 'b', name: 'Ben' }))
  const profiles = await listProfiles(store)
  assert.equal(profiles.length, 2)
  assert.ok(profiles.every((p) => p.calls.length === 1))
})

test('late delivery of an older call preserves newer contact details', async () => {
  const store = new MemoryDocumentStore()
  await consolidateCall(store, call({ callId: 'newer', name: 'Corrected name' }))
  const result = await consolidateCall(store, call({ callId: 'older', name: 'Old name', at: new Date('2026-09-08T14:00:00Z') }))
  assert.equal(result.profile.name, 'Corrected name')
  assert.equal(result.profile.lastSeenAt, '2026-09-09T14:00:00.000Z')
  assert.equal(result.profile.calls.length, 2)
})

test('a successful retry upgrades a previously failed tour', async () => {
  const store = new MemoryDocumentStore()
  const booking = { slotId: 'slot-1', startsAt: '2026-09-10T14:00:00Z', unitId: null, status: 'failed' as const }
  await consolidateCall(store, call({ booking }))
  const result = await consolidateCall(store, call({ callId: 'retry', booking: { ...booking, status: 'confirmed' } }))
  assert.equal(result.profile.bookings.length, 1)
  assert.equal(result.profile.bookings[0]!.status, 'confirmed')
})
