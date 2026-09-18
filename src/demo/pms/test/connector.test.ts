import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockPropertyConnector, MOCK_CONNECTOR_ID } from '../connector.ts'
import { memoryMockStore } from '../memory-store.ts'
import { hashJson } from '../../../workflows/validation.ts'
import type { MockBehavior } from '../store.ts'
import type { JsonObject, WorkflowAction } from '../../../workflows/model.ts'

const input: JsonObject = { unit: '4B', scheduled_for: '2026-09-18T15:00:00Z' }

function action(overrides: Partial<WorkflowAction> = {}): WorkflowAction {
  const now = '2026-09-17T12:00:00.000Z'
  return {
    id: 'a1f0c3c6-0000-4000-8000-000000000001',
    receiptId: 'a1f0c3c6-0000-4000-8000-0000000000ff',
    organizationId: 'org-demo-larkin',
    propertyId: 'prop-demo',
    configurationVersion: 1,
    requestId: 'request-1',
    origin: { kind: 'user', userId: 'user-demo-larkin', credentialVersion: 1 },
    kind: 'book_tour',
    connector: MOCK_CONNECTOR_ID,
    operationKey: 'prop-demo:book_tour:lead-7',
    input,
    inputSha256: hashJson(input),
    state: 'running',
    phase: 'dispatch',
    dispatchAttempts: 1,
    verificationAttempts: 0,
    verificationAttemptsAtReplay: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastErrorCode: null,
    dispatchStarted: true,
    providerReference: null,
    evidence: null,
    ...overrides,
  }
}

async function armed(behavior: MockBehavior) {
  const store = memoryMockStore()
  await store.armBehavior({ organizationId: 'org-demo-larkin', propertyId: 'prop-demo' }, behavior)
  return { store, connector: mockPropertyConnector(store) }
}

test('a cooperative write is accepted and then verifies with the identity the engine demands', async () => {
  const { store, connector } = await armed('accept')
  const dispatched = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  assert.equal(dispatched.status, 'accepted')

  const verified = await connector.verify(action({ phase: 'verify' }), AbortSignal.timeout(1_000))
  assert.equal(verified.status, 'matched')
  if (verified.status !== 'matched') return
  // The engine rejects a verification whose key or digest does not match the action it holds.
  assert.equal(verified.operationKey, action().operationKey)
  assert.equal(verified.inputSha256, action().inputSha256)
  assert.ok(verified.providerReference.length > 0)
  assert.deepEqual(verified.evidence, input)
  assert.equal(store.size, 1)
})

test('a lost response after the write landed still verifies, and files nothing twice', async () => {
  const { store, connector } = await armed('timeout_after_write')
  await assert.rejects(() => connector.dispatch(action(), AbortSignal.timeout(1_000)))
  // The record is there. Sending again is what would book the resident twice.
  const verified = await connector.verify(action({ phase: 'verify' }), AbortSignal.timeout(1_000))
  assert.equal(verified.status, 'matched')
  assert.equal(store.size, 1)
})

test('silence with no write is an authoritative absence, which is what earns a safe retry', async () => {
  const { store, connector } = await armed('timeout')
  const dispatched = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  assert.equal(dispatched.status, 'unknown')
  const verified = await connector.verify(action({ phase: 'verify' }), AbortSignal.timeout(1_000))
  assert.equal(verified.status, 'not_found')
  if (verified.status !== 'not_found') return
  assert.equal(verified.authoritative, true)
  assert.equal(store.size, 0)
  // The engine only acts on that absence because this connector enforces the key itself.
  assert.equal(connector.idempotentWrites, true)
})

test('a record accepted but not yet readable answers maybe, never definitely absent', async () => {
  const { connector } = await armed('invisible_once')
  const dispatched = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  assert.equal(dispatched.status, 'accepted')

  const first = await connector.verify(action({ phase: 'verify' }), AbortSignal.timeout(1_000))
  assert.equal(first.status, 'not_found')
  if (first.status !== 'not_found') return
  assert.equal(first.authoritative, false)

  const second = await connector.verify(action({ phase: 'verify' }), AbortSignal.timeout(1_000))
  assert.equal(second.status, 'matched')
})

test('a target that filed something else is caught by read-back rather than trusted', async () => {
  const { connector } = await armed('drift')
  const dispatched = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  assert.equal(dispatched.status, 'accepted')
  const verified = await connector.verify(action({ phase: 'verify' }), AbortSignal.timeout(1_000))
  assert.equal(verified.status, 'mismatch')
})

test('a refusal is reported as final, not as something to try again', async () => {
  const { store, connector } = await armed('reject')
  const dispatched = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  assert.equal(dispatched.status, 'rejected')
  if (dispatched.status !== 'rejected') return
  assert.equal(dispatched.retryable, false)
  assert.equal(store.size, 0)
})

test('a second dispatch under the same key answers from the record instead of writing again', async () => {
  const { store, connector } = await armed('accept')
  const first = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  const second = await connector.dispatch(action({ dispatchAttempts: 2 }), AbortSignal.timeout(1_000))
  assert.equal(first.status, 'accepted')
  assert.equal(second.status, 'accepted')
  if (first.status !== 'accepted' || second.status !== 'accepted') return
  assert.equal(second.providerReference, first.providerReference)
  assert.equal(store.size, 1)
})

test('an armed fault applies to one write and then the target behaves again', async () => {
  const { store, connector } = await armed('reject')
  const refused = await connector.dispatch(action(), AbortSignal.timeout(1_000))
  assert.equal(refused.status, 'rejected')
  const next = await connector.dispatch(action({ operationKey: 'prop-demo:book_tour:lead-8' }), AbortSignal.timeout(1_000))
  assert.equal(next.status, 'accepted')
  assert.equal(store.size, 1)
})

test('work for another property is not visible to this one', async () => {
  const { store, connector } = await armed('accept')
  await connector.dispatch(action(), AbortSignal.timeout(1_000))
  const elsewhere = await connector.verify(
    action({ phase: 'verify', organizationId: 'org-other', propertyId: 'prop-other' }),
    AbortSignal.timeout(1_000),
  )
  assert.equal(elsewhere.status, 'not_found')
  assert.equal(store.size, 1)
})
