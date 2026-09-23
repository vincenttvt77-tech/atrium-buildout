import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailReconciliationEnabled, emailVerificationCommand } from '../reconciliation.ts'
import type { PropertySnapshot } from '../../properties/model.ts'
const now = new Date('2026-09-22T12:00:00Z')
const enabled = { enabled: true, organizationId: 'org', propertyId: 'prop', runnerId: 'worker', reviewExpiresAt: '2026-09-23T12:00:00Z' }
const snapshot = (raw: unknown) => ({ organizationId: 'org', propertyId: 'prop', property: { emailReconciliation: raw } }) as unknown as PropertySnapshot

test('scheduled reconciliation requires an exact reviewed property worker opt-in', () => {
  assert.equal(emailReconciliationEnabled(snapshot(enabled), 'worker', now), true)
  for (const raw of [null, [], {}, { ...enabled, enabled: false }, { ...enabled, enabled: 'true' },
    { ...enabled, organizationId: 'foreign' }, { ...enabled, propertyId: 'other' }, { ...enabled, runnerId: 'other' },
    { ...enabled, reviewExpiresAt: now.toISOString() }, { ...enabled, reviewExpiresAt: '2027-01-01' },
    { ...enabled, reviewExpiresAt: 'invalid' }, { ...enabled, providerUrl: 'https://untrusted.test' }]) {
    assert.equal(emailReconciliationEnabled(snapshot(raw), 'worker', now), false)
  }
  assert.equal(emailReconciliationEnabled(snapshot(enabled), 'worker', new Date(NaN)), false)
})
test('staff check requires an exact action and displayed revision, no body or recipient override', () => {
  const command = { actionId: 'action-1', expectedRevision: 'a'.repeat(64) }
  assert.deepEqual(emailVerificationCommand(command), command)
  for (const value of [null, [], { ...command, expectedRevision: '' }, { ...command, actionId: '../foreign' },
    { actionId: 'action-1' }, { ...command, to: 'other@example.test' }, { ...command, providerReference: 'arbitrary' }]) {
    assert.throws(() => emailVerificationCommand(value), { code: 'workflow_invalid_input' })
  }
})
