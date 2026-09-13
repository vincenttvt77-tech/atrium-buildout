import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { recordCallSafetyEvent, listCallSafetyEvents, safetyEventForOps, type CallSafetyEvent } from '../safety-events.ts'
import type { EmergencySignal } from '../../escalation/emergency.ts'

const first = new Date('2026-09-09T12:00:00.000Z'), later = new Date('2026-09-10T12:00:00.000Z')
const gas: EmergencySignal = { kind: 'gas', matched: 'smell gas', callEmergencyServices: true }
const heat: EmergencySignal = { kind: 'no_heat', matched: 'no heat', callEmergencyServices: false }

test('late anonymous safety evidence survives a completed call without creating a profile or rewriting it', async () => {
  const store = new MemoryDocumentStore()
  const finished = { completedAt: first.toISOString(), work: { phase: 'complete' }, summary: 'Original snapshot' }
  await store.set('call:original', finished)
  const event = await recordCallSafetyEvent(store, { callId: 'original', signal: gas, at: later })
  assert.deepEqual(await store.get('call:original'), finished)
  assert.deepEqual(await store.list('profile:'), [])
  assert.deepEqual(await store.list('followup:'), [])
  assert.deepEqual(await listCallSafetyEvents(store), [event])
  assert.deepEqual(safetyEventForOps(event), { id: 'call-safety:original', kind: 'emergency', durable: true,
    callId: 'original', at: later.toISOString(), emergencyKind: 'gas', matched: 'smell gas',
    notificationStatus: 'not_sent', needsReview: true, phone: null, name: null })
})

test('duplicates and weaker or out-of-order reports keep original time, strongest signal and known contact', async () => {
  const store = new MemoryDocumentStore()
  const initial = await recordCallSafetyEvent(store, { callId: 'stable', signal: heat, at: first })
  const promoted = await recordCallSafetyEvent(store, { callId: 'stable', signal: gas, at: later, phone: '+13125550101', name: 'Caller' })
  assert.equal(promoted.firstReportedAt, initial.firstReportedAt)
  assert.deepEqual(promoted.signal, gas)
  await Promise.all(Array.from({ length: 10 }, (_, i) => recordCallSafetyEvent(store, { callId: 'stable',
    signal: i % 2 ? gas : heat, at: new Date(i % 2 ? '2025-01-01Z' : '2030-01-01Z'), phone: '+13125550999', name: 'Changed' })))
  assert.deepEqual(await listCallSafetyEvents(store), [promoted])
  assert.equal((await store.list('call-safety:')).length, 1)
})

test('records detach mutable inputs and bound provider text without blocking oversized optional contact', async () => {
  const store = new MemoryDocumentStore(), signal = { ...gas, matched: '<img onerror=alert(1)>\n' + '😀'.repeat(1100) }
  const event = await recordCallSafetyEvent(store, { callId: 'bounded', signal, at: first, name: 'N'.repeat(500), phone: '1'.repeat(500) })
  signal.kind = 'no_heat'; signal.matched = 'changed'; event.signal.matched = 'mutated'
  const [saved] = await listCallSafetyEvents(store)
  assert.equal(saved?.signal.kind, 'gas')
  assert.equal([...saved!.signal.matched].length, 1000)
  assert.ok(saved!.signal.matched.startsWith('<img onerror=alert(1)> '))
  assert.equal(saved?.name?.length, 120); assert.equal(saved?.phone?.length, 64)
})

test('invalid identities, impossible severity, dates and stored corruption fail before claiming persistence', async () => {
  const store = new MemoryDocumentStore()
  for (const callId of ['', ' ', 'x'.repeat(257), 'call\u0000id', '\ud800'])
    await assert.rejects(recordCallSafetyEvent(store, { callId, signal: gas, at: first }))
  await assert.rejects(recordCallSafetyEvent(store, { callId: 'bad-signal', signal: { ...gas, callEmergencyServices: false }, at: first }))
  await assert.rejects(recordCallSafetyEvent(store, { callId: 'bad-date', signal: gas, at: new Date('invalid') }))
  assert.deepEqual(await store.list('call-safety:'), [])
  const event = await recordCallSafetyEvent(store, { callId: 'corrupt', signal: gas, at: first })
  await store.set(event.id, { ...event, callId: 'another-call' })
  await assert.rejects(recordCallSafetyEvent(store, { callId: 'corrupt', signal: heat, at: later }))
  await assert.rejects(listCallSafetyEvents(store))
  assert.equal((await store.get<CallSafetyEvent>(event.id))?.callId, 'another-call')
})

test('scoped stores isolate the same provider call identity and storage errors propagate', async () => {
  const one = new MemoryDocumentStore(), two = new MemoryDocumentStore()
  await recordCallSafetyEvent(one, { callId: 'same-call', signal: gas, at: first })
  await recordCallSafetyEvent(two, { callId: 'same-call', signal: heat, at: later })
  assert.equal((await listCallSafetyEvents(one))[0]?.signal.kind, 'gas')
  assert.equal((await listCallSafetyEvents(two))[0]?.signal.kind, 'no_heat')
  const broken = new MemoryDocumentStore()
  broken.update = async () => { throw new Error('storage unavailable') }
  await assert.rejects(recordCallSafetyEvent(broken, { callId: 'failed', signal: gas, at: first }), /storage unavailable/)
  broken.list = async () => { throw new Error('read unavailable') }
  await assert.rejects(listCallSafetyEvents(broken), /read unavailable/)
})
