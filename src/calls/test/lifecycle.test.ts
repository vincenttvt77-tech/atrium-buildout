import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initializeCallLifecycle, admitToolBatch, markToolDispatch, completeToolBatch, requestCallEnd, freezeCall, completeCall,
  hashCallToolArgs, CallLifecycleError, CALL_WORK_LIMITS,
  type CallLifecycle, type CallProvenance, type CallToolIdentity, type CallToolResult,
} from '../lifecycle.ts'

const NOW = '2026-09-09T12:00:00.000Z', LATER = '2026-09-09T12:01:00.000Z'
const source: CallProvenance = { organizationId: 'org-a', propertyId: 'building-a', channelBindingId: 'binding-a',
  channelBindingVersion: 3, configurationVersion: 7, timeZone: 'America/Chicago' }
const fresh = () => initializeCallLifecycle({ now: NOW, provenance: source })
const identity = (id = 'tool-one', args: unknown = { unitId: '33A' }): CallToolIdentity => ({ id, name: 'book_tour', argsHash: hashCallToolArgs(args) })
const admit = (work = fresh(), tools = [identity()], token = 'request-one') => admitToolBatch(work, { tools, token, now: NOW, provenance: source })
const result = (toolId = 'tool-one', outcome: CallToolResult['outcome'] = 'complete'): CallToolResult => ({ toolId, result: 'Synthetic verified result.', outcome })
const finish = (work: CallLifecycle, results = [result()], token = 'request-one') => completeToolBatch(work, { results, token, now: LATER })
const end = (work: CallLifecycle) => requestCallEnd(work, { now: LATER, provenance: source,
  metadata: { eventKey: 'provider-call:end', endedAt: NOW, reportedPhone: '+15555550101' } })
const error = (code: string) => ({ name: 'CallLifecycleError', code, message: code })

test('initialization is detached JSON and preserves explicit property or legacy provenance', () => {
  const input = structuredClone(source)
  const work = initializeCallLifecycle({ now: NOW, provenance: input })
  assert.deepEqual(JSON.parse(JSON.stringify(work)), work)
  assert.equal(work.phase, 'open'); assert.equal(work.revision, 0)
  input.timeZone = 'America/New_York'
  assert.equal(work.provenance?.timeZone, 'America/Chicago')
  assert.deepEqual(initializeCallLifecycle({ now: NOW }).provenance, null)
  const legacy = initializeCallLifecycle({ now: NOW, provenance: { tenantId: 'larkin', timeZone: 'America/New_York' } })
  assert.equal(legacy.provenance?.timeZone, 'America/New_York')
})

test('argument hashes are canonical, bounded, strict JSON and do not execute getters', () => {
  assert.equal(hashCallToolArgs({ b: 2, a: 1 }), hashCallToolArgs({ a: 1, b: 2 }))
  assert.notEqual(hashCallToolArgs({ a: 1 }), hashCallToolArgs({ a: '1' }))
  let invoked = false
  const args = Object.defineProperty({}, 'hidden', { enumerable: true, get() { invoked = true; return 1 } })
  for (const value of [args, [], null, new Date(), { a: undefined }, { secret: '\u0000' }]) assert.throws(() => hashCallToolArgs(value), CallLifecycleError)
  assert.equal(invoked, false)
  assert.throws(() => hashCallToolArgs({ value: 'x'.repeat(CALL_WORK_LIMITS.argsBytes) }), error('call_work_limit'))
})

test('admission stores immutable identity and its request token before any dispatch', () => {
  const initial = fresh(), tool = identity()
  const accepted = admit(initial, [tool])
  assert.equal(initial.intents.length, 0)
  assert.equal(accepted.status, 'admitted')
  assert.deepEqual(accepted.admission, { token: 'request-one', toolIds: ['tool-one'] })
  tool.argsHash = '0'.repeat(64)
  assert.notEqual(accepted.work.intents[0]?.argsHash, tool.argsHash)
  assert.equal(accepted.work.intents[0]?.status, 'admitted')
  assert.equal(accepted.work.intents[0]?.dispatchStartedAt, null)
  assert.equal(accepted.work.revision, 1)
})

test('an in-flight duplicate is busy even with the same token and admits no other new work', () => {
  const work = admit().work
  for (const token of ['request-one', 'request-two']) {
    assert.throws(() => admit(work, [identity(), identity('new-tool')], token), error('call_work_busy'))
  }
  assert.equal(work.intents.length, 1)
})

test('reusing a tool ID with different arguments or function name gives a meaningful conflict', () => {
  const work = admit().work
  assert.throws(() => admit(work, [identity('tool-one', { unitId: '29E' })], 'other-request'), error('call_tool_identity_conflict'))
  assert.throws(() => admit(work, [{ ...identity(), name: 'capture_contact' }], 'other-request'), error('call_tool_identity_conflict'))
  assert.throws(() => admit(fresh(), [identity(), identity()]), error('call_tool_identity_conflict'))
  const batch = admit(fresh(), [identity(), identity('second')]).work
  assert.throws(() => admit(batch, [identity(), identity('second', { unitId: '29E' })], 'retry'), error('call_tool_identity_conflict'),
    'a busy first ID must not mask contradictory content later in the batch')
})

test('completed duplicates return cached results after freezing and never reopen a call', () => {
  const work = freezeCall(end(finish(admit().work)), { now: LATER })
  const duplicate = admit(work, [identity()], 'redelivery-request')
  assert.equal(duplicate.status, 'cached'); assert.equal(duplicate.admission, null)
  assert.deepEqual(duplicate.results, [result()])
  assert.deepEqual(duplicate.work, work)
  assert.throws(() => admit(work, [identity('new-tool')], 'new-request'), error('call_closed'))
})

test('a mixed duplicate and new batch executes only new IDs and cannot reuse another request token', () => {
  const work = finish(admit().work)
  const accepted = admit(work, [identity(), identity('new-tool')], 'request-two')
  assert.deepEqual(accepted.admission?.toolIds, ['new-tool'])
  assert.deepEqual(accepted.results, [result()])
  assert.throws(() => admit(work, [identity('different-tool')], 'request-one'), error('call_tool_identity_conflict'))
})

test('end admission waits for unfinished capture work; its later completion is retained', () => {
  const open = admit().work
  const ending = end(open)
  assert.equal(ending.phase, 'ending')
  assert.throws(() => freezeCall(ending, { now: LATER }), error('call_work_unresolved'))
  assert.throws(() => admit(ending, [identity('late-unadmitted')], 'late-request'), error('call_closed'))
  const completed = finish(ending)
  assert.equal(completed.phase, 'ending')
  assert.equal(completed.intents[0]?.result, result().result)
  assert.equal(freezeCall(completed, { now: LATER }).phase, 'frozen')
})

test('booking dispatch marker commits to lifecycle before execution and completion is fenced by token', () => {
  const work = end(admit().work)
  assert.throws(() => markToolDispatch(work, { toolId: 'tool-one', token: 'stolen-request', now: LATER }), error('call_admission_stale'))
  const dispatched = markToolDispatch(work, { toolId: 'tool-one', token: 'request-one', now: LATER })
  assert.equal(dispatched.intents[0]?.dispatchStartedAt, LATER)
  assert.throws(() => markToolDispatch(dispatched, { toolId: 'tool-one', token: 'request-one', now: LATER }), error('call_admission_stale'))
  assert.throws(() => finish(dispatched, [result()], 'stale-token'), error('call_admission_stale'))
  const completed = finish(dispatched)
  assert.equal(completed.intents[0]?.dispatchStartedAt, LATER)
  assert.equal(completed.intents[0]?.status, 'complete')
})

test('an abandoned dispatched operation never expires into a finalizable or cancellable call', () => {
  const dispatched = markToolDispatch(end(admit().work), { token: 'request-one', toolId: 'tool-one', now: NOW })
  assert.throws(() => freezeCall(dispatched, { now: '2036-09-09T12:00:00.000Z' }), error('call_work_unresolved'))
  assert.throws(() => finish(dispatched, [result('tool-one', 'blocked')]), error('call_work_unresolved'))
  const held = finish(dispatched, [result('tool-one', 'needs_review')])
  assert.equal(held.phase, 'needs_review')
  assert.equal(held.intents[0]?.completedAt, null)
  assert.throws(() => freezeCall(held, { now: LATER }), error('call_work_unresolved'))
  assert.throws(() => admit(held, [identity()], 'other-request'), error('call_work_busy'))
  const verified = finish(held)
  assert.equal(verified.phase, 'ending')
  assert.equal(verified.intents[0]?.argsHash, dispatched.intents[0]?.argsHash)
  assert.equal(freezeCall(verified, { now: LATER }).phase, 'frozen')
})

test('a known pre-dispatch block is terminal, while review prevents other admitted dispatches', () => {
  const work = admit(fresh(), [identity(), identity('second-tool')]).work
  const held = finish(work, [result('tool-one', 'needs_review')])
  assert.throws(() => markToolDispatch(held, { token: 'request-one', toolId: 'second-tool', now: LATER }), error('call_work_unresolved'))
  const blocked = finish(end(work), [result('tool-one', 'blocked'), result('second-tool', 'blocked')])
  assert.equal(freezeCall(blocked, { now: LATER }).phase, 'frozen')
})

test('partial completion cannot hide other admitted work or mutate previously completed results', () => {
  const work = end(admit(fresh(), [identity(), identity('second-tool')]).work)
  const partial = finish(work)
  assert.throws(() => freezeCall(partial, { now: LATER }), error('call_work_unresolved'))
  assert.throws(() => finish(partial), error('call_admission_stale'))
  const completed = finish(partial, [result('second-tool')])
  assert.equal(freezeCall(completed, { now: LATER }).phase, 'frozen')
})

test('failed completion validates the entire batch before any returned state can change', () => {
  const work = admit(fresh(), [identity(), identity('second-tool')]).work
  const original = structuredClone(work)
  assert.throws(() => finish(work, [result(), result('unknown-tool')]), error('call_admission_stale'))
  assert.deepEqual(work, original)
  assert.throws(() => finish(work, [result(), result()]), error('call_work_invalid'))
  assert.deepEqual(work, original)
})

test('accepted event timestamp and phone remain original across missing-field redelivery', () => {
  const accepted = requestCallEnd(fresh(), { now: NOW, provenance: source, metadata: {
    eventKey: 'call:end', startedAt: '2026-09-09T11:59:00Z', endedAt: NOW, reportedPhone: '+15555550101', durationSeconds: 60,
  } })
  const duplicate = requestCallEnd(accepted, { now: LATER, provenance: source, metadata: { eventKey: 'call:end' } })
  assert.deepEqual(duplicate, accepted)
  assert.equal(duplicate.end?.receivedAt, NOW)
  assert.equal(duplicate.end?.startedAt, '2026-09-09T11:59:00.000Z')
  assert.equal(duplicate.end?.reportedPhone, '+15555550101')
})

test('contradictory nonmissing report identities conflict without changing accepted metadata', () => {
  const metadata = { eventKey: 'call:end', startedAt: '2026-09-09T11:59:00Z', endedAt: NOW, reportedPhone: '+15555550101', durationSeconds: 60 }
  const accepted = requestCallEnd(fresh(), { now: NOW, provenance: source, metadata })
  for (const changed of [{ eventKey: 'different:end' }, { startedAt: '2026-09-09T11:58:00Z' }, { endedAt: LATER },
    { reportedPhone: '+15555550999' }, { durationSeconds: 61 }]) {
    assert.throws(() => requestCallEnd(accepted, { now: LATER, provenance: source, metadata: { ...metadata, ...changed } }), error('call_event_identity_conflict'))
  }
  assert.equal(accepted.end?.reportedPhone, metadata.reportedPhone)
})

test('missing first-report end time falls back once; later arrival cannot freshen it', () => {
  const accepted = requestCallEnd(fresh(), { now: NOW, provenance: source, metadata: { eventKey: 'call:end' } })
  const duplicate = requestCallEnd(accepted, { now: LATER, provenance: source, metadata: { eventKey: 'call:end' } })
  assert.equal(duplicate.end?.endedAt, NOW)
  assert.equal(duplicate.end?.receivedAt, NOW)
  assert.throws(() => requestCallEnd(accepted, { now: LATER, provenance: source, metadata: { eventKey: 'call:end', endedAt: LATER } }), error('call_event_identity_conflict'))
})

test('routing, binding version, configuration and timezone cannot change during a call or be omitted', () => {
  const work = admit().work
  for (const patch of [{ organizationId: 'org-b' }, { propertyId: 'building-b' }, { channelBindingId: 'binding-b' },
    { channelBindingVersion: 4 }, { configurationVersion: 8 }, { timeZone: 'America/New_York' }]) {
    const incoming = { ...source, ...patch } as CallProvenance
    assert.throws(() => admitToolBatch(work, { token: 'second', tools: [identity('second')], now: NOW, provenance: incoming }), error('call_provenance_conflict'))
    assert.throws(() => requestCallEnd(work, { now: NOW, metadata: { eventKey: 'call:end' }, provenance: incoming }), error('call_provenance_conflict'))
  }
  assert.throws(() => requestCallEnd(work, { now: NOW, metadata: { eventKey: 'call:end' } }), error('call_provenance_conflict'))
})

test('freeze is idempotent and projection completion requires its exact frozen revision', () => {
  const frozen = freezeCall(end(finish(admit().work)), { now: LATER })
  assert.equal(frozen.frozenRevision, frozen.revision)
  assert.deepEqual(freezeCall(frozen, { now: NOW }), frozen)
  assert.throws(() => completeCall(frozen, { now: LATER, frozenRevision: frozen.revision - 1 }), error('call_revision_conflict'))
  const completed = completeCall(frozen, { now: LATER, frozenRevision: frozen.frozenRevision! })
  assert.equal(completed.phase, 'complete')
  assert.equal(completed.completedAt, LATER)
  assert.deepEqual(completeCall(completed, { now: NOW, frozenRevision: frozen.frozenRevision! }), completed)
  assert.throws(() => finish(frozen), error('call_admission_stale'))
})

test('an empty ended call can freeze, while an open call cannot', () => {
  assert.throws(() => freezeCall(fresh(), { now: NOW }), error('call_work_unresolved'))
  assert.equal(freezeCall(end(fresh()), { now: LATER }).phase, 'frozen')
})

test('batch, per-call identity, result and revision growth are bounded', () => {
  assert.throws(() => admit(fresh(), Array.from({ length: 21 }, (_, i) => identity(`tool-${i}`))), error('call_work_limit'))
  let work = fresh()
  for (let i = 0; i < CALL_WORK_LIMITS.intents; i++) {
    const accepted = admit(work, [identity(`tool-${i}`)], `request-${i}`)
    work = finish(accepted.work, [result(`tool-${i}`)], `request-${i}`)
  }
  assert.equal(work.intents.length, CALL_WORK_LIMITS.intents)
  assert.throws(() => admit(work, [identity('one-too-many')], 'extra-request'), error('call_work_limit'))
  assert.throws(() => finish(admit().work, [{ ...result(), result: 'x'.repeat(CALL_WORK_LIMITS.resultBytes + 1) }]), error('call_work_limit'))
  assert.throws(() => admit({ ...fresh(), revision: Number.MAX_SAFE_INTEGER }), error('call_work_limit'))
})

test('corrupt persisted state fails closed instead of treating unknown work as complete', () => {
  const work = admit().work
  for (const corrupt of [
    { ...work, phase: 'frozen', frozenRevision: work.revision },
    { ...work, phase: 'complete', completedAt: NOW },
    { ...work, intents: [{ ...work.intents[0], status: 'complete', result: null, completedAt: NOW }] },
    { ...work, intents: [{ ...work.intents[0], status: 'dispatch_started', dispatchStartedAt: null }] },
    { ...work, intents: [{ ...work.intents[0], status: 'blocked', dispatchStartedAt: NOW, completedAt: NOW, result: 'Discarded' }] },
    { ...work, end: null, phase: 'ending' },
    { ...work, intents: [work.intents[0], work.intents[0]] },
    { ...work, version: 2 },
  ]) assert.throws(() => freezeCall(corrupt as CallLifecycle, { now: NOW }), CallLifecycleError)
})

test('malformed timestamps, provenance, identities and report fields have stable errors', () => {
  for (const at of ['2026-02-30T12:00:00Z', 'tomorrow', '2026-09-09', '2026-09-09T12:00:00+00:00']) {
    assert.throws(() => initializeCallLifecycle({ now: at }), error('call_work_invalid'))
  }
  for (const invalid of [{ tenantId: 'legacy', timeZone: 'nonsense' }, { ...source, channelBindingVersion: 0 }]) {
    assert.throws(() => initializeCallLifecycle({ now: NOW, provenance: invalid as CallProvenance }), error('call_work_invalid'))
  }
  for (const invalid of [{ ...identity(), id: '' }, { ...identity(), argsHash: 'not-a-hash' }, { ...identity(), name: 'has spaces' }]) {
    assert.throws(() => admit(fresh(), [invalid]), error('call_work_invalid'))
  }
  for (const metadata of [{ eventKey: 'event', reportedPhone: 'bad-phone' }, { eventKey: 'event', durationSeconds: -1 },
    { eventKey: 'event', startedAt: LATER, endedAt: NOW }]) {
    assert.throws(() => requestCallEnd(fresh(), { now: NOW, provenance: source, metadata }), error('call_work_invalid'))
  }
})

test('public commands reject malformed objects and do not execute getters or conversion hooks', () => {
  let executed = 0
  const command = Object.defineProperty({}, 'now', { enumerable: true, get() { executed++; return NOW } })
  assert.throws(() => initializeCallLifecycle(command as never), error('call_work_invalid'))
  for (const invalid of [null, undefined, [], { now: NOW, extra: true }]) {
    assert.throws(() => initializeCallLifecycle(invalid as never), error('call_work_invalid'))
    assert.throws(() => freezeCall(fresh(), invalid as never), error('call_work_invalid'))
  }
  assert.equal(executed, 0)
})
