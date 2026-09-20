import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consolidateCall, listProfiles, listFollowUps, profileKey } from '../consolidate.ts'
import type { CallOutcome } from '../consolidate.ts'
import type { Evidence, LeadProfile } from '../profile.ts'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { emptyQualification } from '../../leasing/qualification.ts'

const at = '2026-09-20T14:00:00.000Z'
const providerPhone = '+13125550101'
const callbackPhone = '+13125550102'
const evidence = (overrides: Partial<Evidence<string>> = {}): Evidence<string> => ({
  value: callbackPhone, excerpt: 'Please call me back at 312 555 0102.', callId: 'call-one',
  at, confidence: 1, ...overrides,
})
const call = (overrides: Partial<CallOutcome> = {}): CallOutcome => ({
  callId: 'call-one', phone: providerPhone, at: new Date(at), durationSeconds: 60,
  qualification: emptyQualification(), name: 'Dana', email: null, unitsDiscussed: [],
  booking: null, lossReason: null, escalation: null, toolsCalled: [], ...overrides,
})

test('a requested callback retains provenance without replacing provider identity or merging another lead', async () => {
  const store = new MemoryDocumentStore()
  await consolidateCall(store, call({ callId: 'other-person', phone: callbackPhone, name: 'Morgan' }))
  const callback = evidence({ value: '(312) 555-0102' })
  const result = await consolidateCall(store, call({ callbackPhone: callback,
    escalation: { trigger: 'human_requested', detail: 'Please call back' } }))
  assert.equal(result.profile.phone, providerPhone)
  assert.deepEqual(result.profile.callbackPhone, { ...callback, value: callbackPhone })
  assert.equal((await listProfiles(store)).length, 2)
  assert.equal((await store.get<LeadProfile>(profileKey(callbackPhone)))!.name, 'Morgan')
  assert.ok(result.followUps.every(row => row.phone === providerPhone), 'work remains attached to the original lead')
})

test('callback capture chronology survives delayed calls and unrelated calls without contact claims', async () => {
  const store = new MemoryDocumentStore()
  const newer = evidence({ callId: 'newer', at: '2026-09-20T16:00:00.000Z', value: '+13125550103' })
  await consolidateCall(store, call({ callId: 'newer', at: new Date(newer.at), callbackPhone: newer }))
  const delayed = await consolidateCall(store, call({ callbackPhone: evidence() }))
  assert.deepEqual(delayed.profile.callbackPhone, newer)
  const later = await consolidateCall(store, call({ callId: 'no-callback', at: new Date('2026-09-21T14:00:00.000Z') }))
  assert.deepEqual(later.profile.callbackPhone, newer)
})

test('an older delayed call fills a missing callback even after an unrelated later call', async () => {
  const store = new MemoryDocumentStore()
  await consolidateCall(store, call({ callId: 'newer', at: new Date('2026-09-21T14:00:00.000Z') }))
  const result = await consolidateCall(store, call({ callbackPhone: evidence() }))
  assert.deepEqual(result.profile.callbackPhone, evidence())
  assert.equal(result.profile.lastSeenAt, '2026-09-21T14:00:00.000Z')
})

test('duplicate reports cannot rewrite a saved callback or recreate completed work', async () => {
  const store = new MemoryDocumentStore()
  const original = call({ callbackPhone: evidence(), escalation: { trigger: 'human_requested', detail: 'Please call back' } })
  const first = await consolidateCall(store, original)
  const work = first.followUps[0]!
  await store.set(`followup:${work.id}`, { ...work, status: 'done' })
  const result = await consolidateCall(store, { ...original,
    callbackPhone: evidence({ value: '+13125550103', at: '2026-09-22T14:00:00.000Z' }) })
  assert.deepEqual(result.profile.callbackPhone, evidence())
  assert.equal(result.profile.calls.length, 1)
  const followUps = await listFollowUps(store)
  assert.equal(followUps.length, 1)
  assert.equal(followUps[0]!.status, 'done')
})

test('withheld callers sharing a callback retain separate call-specific profiles and work', async () => {
  const store = new MemoryDocumentStore()
  for (const callId of ['anonymous-a', 'anonymous-b']) {
    await consolidateCall(store, call({ callId, phone: 'unknown', callbackPhone: evidence({ callId }),
      escalation: { trigger: 'human_requested', detail: `Call for ${callId}` } }))
  }
  assert.deepEqual(await store.list('lead:'), ['lead:anonymous:anonymous-a', 'lead:anonymous:anonymous-b'])
  const profiles = await listProfiles(store)
  assert.equal(profiles.length, 2)
  assert.ok(profiles.every(p => p.phone === 'unknown' && p.calls.length === 1 && p.callbackPhone?.callId === p.calls[0]!.callId))
  assert.equal((await listFollowUps(store)).length, 2)
})

test('invalid contact or provenance is ignored without dropping the lead or replacing a valid callback', async () => {
  const invalid = [
    { value: 'unknown' }, { value: '+12' }, { value: '+1234567890123456' }, { value: '+0000000000' },
    { value: 'Call 3125550102' }, { value: '1'.repeat(81) }, { excerpt: '' }, { excerpt: ' '.repeat(12) },
    { excerpt: 'x'.repeat(1001) }, { callId: 'another-call' }, { at: 'tomorrow' },
    { at: '2026-02-30T14:00:00.000Z' }, { at: '+999999-01-01T00:00:00.000Z' },
    { confidence: NaN }, { confidence: 1.1 }, { confidence: -0.1 },
  ]
  for (const patch of invalid) {
    const store = new MemoryDocumentStore()
    const result = await consolidateCall(store, call({ callbackPhone: evidence(patch) }))
    assert.equal(result.profile.callbackPhone, undefined, JSON.stringify(patch))
    assert.equal(result.profile.phone, providerPhone)
    assert.equal(result.profile.calls.length, 1)
    await consolidateCall(store, call({ callId: 'valid', callbackPhone: evidence({ callId: 'valid' }) }))
    const after = await consolidateCall(store, call({ callId: 'bad', callbackPhone: evidence({ callId: 'bad', ...patch }) }))
    // A patched callId must remain invalid even when it happens to equal the first call.
    assert.equal(after.profile.callbackPhone?.callId, 'valid')
  }
})

test('legacy profiles without a callback remain compatible and incoming evidence is stored by value', async () => {
  const store = new MemoryDocumentStore()
  const before = await consolidateCall(store, call())
  assert.equal(Object.hasOwn(before.profile, 'callbackPhone'), false)
  const incoming = evidence({ callId: 'later' })
  const result = await consolidateCall(store, call({ callId: 'later', callbackPhone: incoming }))
  incoming.excerpt = 'Edited outside storage'
  assert.equal(result.profile.callbackPhone?.excerpt, 'Please call me back at 312 555 0102.')
  assert.deepEqual((await store.get<LeadProfile>(profileKey(providerPhone)))!.callbackPhone, result.profile.callbackPhone)
})

test('explicit international callback country codes are not rewritten as domestic numbers', async () => {
  const result = await consolidateCall(new MemoryDocumentStore(), call({ callbackPhone: evidence({ value: '+64 9 555 0101' }) }))
  assert.equal(result.profile.callbackPhone?.value, '+6495550101')
})
