import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, type DocumentStore } from '../../store/documents.ts'
import { receiveFinishedCall, replayFinishedCall, receiptKey, type CallReceipt } from '../inbox.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { listProfiles, listFollowUps, type CallOutcome } from '../consolidate.ts'

const at = new Date('2026-09-09T15:00:00Z')
const outcome = (): CallOutcome => ({
  callId: 'inbox-call', phone: '+17185550111', at, durationSeconds: 100,
  qualification: emptyQualification(), name: 'Example Visitor', email: null, unitsDiscussed: [],
  booking: null, lossReason: null,
  escalation: { trigger: 'requested_human', detail: 'Asked for leasing assistance' }, toolsCalled: [],
})

test('a failed follow-up projection stays replayable after the profile was written', async () => {
  const base = new MemoryDocumentStore()
  let fail = true
  const store: DocumentStore = {
    get: base.get.bind(base), set: base.set.bind(base), list: base.list.bind(base), delete: base.delete.bind(base), describe: base.describe.bind(base),
    update: async (key, initial, fn) => {
      if (fail && key.startsWith('followup:')) throw new Error('temporary outage')
      return base.update(key, initial, fn)
    },
  }
  await assert.rejects(receiveFinishedCall(store, outcome(), at), /temporary outage/)
  const pending = await store.get<CallReceipt>(receiptKey('inbox-call'))
  assert.equal(pending?.status, 'pending')
  assert.equal(pending?.lastErrorCode, 'consolidation_failed')
  assert.equal(pending?.attempts, 1)
  assert.equal((await listProfiles(store))[0]!.calls.length, 1)
  fail = false
  const completed = await replayFinishedCall(store, 'inbox-call', new Date('2026-09-12T15:00:00Z'))
  assert.equal(completed.status, 'complete')
  assert.equal(completed.attempts, 2)
  assert.equal(completed.outcome, null, 'completed receipt should not duplicate prospect details')
  assert.equal((await listProfiles(store))[0]!.calls.length, 1)
  const followups = await listFollowUps(store)
  assert.ok(followups.length > 0)
  assert.ok(followups.every(f => f.dueAt < '2026-09-12'), 'replay keeps original event deadlines')
  await receiveFinishedCall(store, outcome(), new Date('2026-09-13T15:00:00Z'))
  assert.equal((await listFollowUps(store)).length, followups.length)
  assert.equal((await store.get<CallReceipt>(receiptKey('inbox-call')))?.attempts, 2)
})

test('inbox retains the original received payload if a redelivery omits contact details', async () => {
  const store = new MemoryDocumentStore()
  const initial = outcome()
  await store.set<CallReceipt>(receiptKey(initial.callId), { version: 1, callId: initial.callId, status: 'pending', attempts: 0,
    receivedAt: at.toISOString(), updatedAt: at.toISOString(), completedAt: null, lastErrorCode: null,
    outcome: { ...initial, at: at.toISOString() } })
  await receiveFinishedCall(store, { ...initial, phone: 'unknown', name: null }, at)
  const profiles = await listProfiles(store)
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0]!.phone, initial.phone)
  assert.equal(profiles[0]!.name, initial.name)
})
