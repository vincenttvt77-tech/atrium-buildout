import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queueQuery, recoveryCommand, workflowSummary } from '../presentation.ts'
import type { WorkflowAction } from '../model.ts'

test('queue query validates bounded complete keyset cursors without rounding precision', () => {
  assert.deepEqual(queueQuery({}), { states: ['needs_review'], limit: 25 })
  const query = queueQuery({ state: 'all', limit: '50', beforeCreatedAt: '2026-09-12T12:00:00.123456Z', beforeId: 'action-1' })
  assert.equal(query.before?.createdAt, '2026-09-12T12:00:00.123456Z')
  assert.equal(query.limit, 50)
  for (const invalid of [{ limit: '51' }, { limit: 25 }, { limit: ['1', '2'] }, { limit: '01' }, { state: '__proto__' },
    { state: ['all', 'active'] }, { beforeId: 'one' }, { beforeCreatedAt: '2026-09-12T12:00:00.123Z' },
    { beforeCreatedAt: '2026-02-30T12:00:00.123Z', beforeId: 'one' }, { beforeCreatedAt: 'today', beforeId: 'one' },
    { beforeCreatedAt: '2026-09-12T12:00:00.123Z', beforeId: '../other' }, { propertyId: 'foreign' }]) {
    assert.throws(() => queueQuery(invalid), { code: 'workflow_invalid_input' })
  }
})

test('recovery accepts only reviewed commands with a row revision and finite reasons', () => {
  const command = { action: 'replay', id: 'action-1', expectedRevision: 'a'.repeat(64), reason: 'provider_recovered' }
  assert.deepEqual(recoveryCommand(command), command)
  for (const invalid of [null, [], { ...command, expectedRevision: undefined }, { ...command, expectedRevision: 'a' },
    { ...command, action: 'dispatch' }, { ...command, reason: 'duplicate_request' }, { ...command, action: 'cancel' },
    { ...command, role: 'owner' }, { ...command, reason: 'private customer narrative' }]) {
    assert.throws(() => recoveryCommand(invalid), { code: 'workflow_invalid_input' })
  }
})

test('queue projection omits provider payloads, actor identities and execution secrets', () => {
  const action = { id: 'action-1', kind: 'maintenance.create', connector: 'selected-pms', state: 'needs_review',
    phase: 'verify', createdAt: '2026-09-12T12:00:00.123456Z', updatedAt: '2026-09-12T12:00:00.123456Z',
    availableAt: '2026-09-12T12:00:00.123456Z', completedAt: null, lastErrorCode: 'verification_unknown',
    dispatchAttempts: 1, verificationAttempts: 2, maxAttempts: 3, dispatchStarted: true, revision: 'f'.repeat(64),
    input: { private: 'caller detail' }, evidence: { provider: 'secret response' }, providerReference: 'sensitive-reference',
    origin: { kind: 'user', userId: 'private-user', credentialVersion: 1 }, leaseToken: 'do-not-publish' } as unknown as WorkflowAction & { revision: string }
  const summary = workflowSummary(action, true)
  assert.equal(summary.canReplay, true)
  assert.equal(summary.canCancel, false)
  assert.equal(summary.createdAt, action.createdAt)
  assert.doesNotMatch(JSON.stringify(summary), /caller detail|secret response|sensitive-reference|private-user|do-not-publish/)
  assert.equal(workflowSummary(action, false).canReplay, false)
  assert.equal(workflowSummary({ ...action, state: 'running' }, true).canReplay, false)
  assert.equal(workflowSummary({ ...action, state: 'succeeded' }, true).canReplay, false)
  assert.equal(workflowSummary({ ...action, state: 'queued', phase: 'dispatch', dispatchStarted: false }, true).canCancel, true)
  assert.throws(() => workflowSummary({ ...action, revision: '' }, true), { code: 'workflow_invalid_record' })
})
