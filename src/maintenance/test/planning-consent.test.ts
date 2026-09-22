import assert from 'node:assert/strict'
import test from 'node:test'
import { projectPlanConsent, readMaintenanceConsentGraph } from '../planning-consent.ts'
import type { MaintenanceConsentEvidence, MaintenanceConsentRequirements } from '../planning-consent.ts'

const now = new Date('2026-09-13T18:00:00.000Z'), later = '2026-09-13T19:00:00.000Z'
const material = 'a'.repeat(64)
const required: MaintenanceConsentRequirements = { caseId: 'case-one', caseVersion: 2, planId: 'plan-one', planVersion: 1,
  configurationVersion: 1, workRequired: true, entryRequired: true }
function evidence(): MaintenanceConsentEvidence {
  return { caseId: required.caseId, caseVersion: 2, planId: required.planId, planVersion: 1, configurationVersion: 1,
    materialDigest: material, revision: 'b'.repeat(64), refreshAt: later,
    purposes: [{ purpose: 'work', requestId: 'work-one', requestVersion: 1, materialDigest: material, required: true, effective: true, holds: [], refreshAt: later },
      { purpose: 'entry', requestId: 'entry-one', requestVersion: 1, materialDigest: material, required: true, effective: true, holds: [], refreshAt: later }] }
}
test('each required permission is composed against the current exact case and plan', () => {
  const result = projectPlanConsent(required, evidence(), now)
  assert.deepEqual(result, { residentApprovalRequired: true, residentApprovalVerified: true,
    entryPermissionRequired: true, entryAuthorized: true, needsReview: false })
  for (const patch of [{ caseId: 'another-case' }, { caseVersion: 3 }, { planId: 'another-plan' }, { planVersion: 2 }, { configurationVersion: 2 }]) {
    const changed = projectPlanConsent(required, { ...evidence(), ...patch }, now)
    assert.equal(changed.needsReview, true); assert.equal(changed.residentApprovalVerified, false); assert.equal(changed.entryAuthorized, false)
  }
})
test('individually effective work and entry for different material versions cannot combine', () => {
  const value = evidence(); value.purposes[1].materialDigest = 'c'.repeat(64)
  const result = projectPlanConsent(required, value, now)
  assert.equal(result.residentApprovalVerified, true)
  assert.equal(result.entryAuthorized, false); assert.equal(result.needsReview, true)
  value.materialDigest = 'c'.repeat(64)
  const next = projectPlanConsent(required, value, now)
  assert.equal(next.residentApprovalVerified, false); assert.equal(next.entryAuthorized, true); assert.equal(next.needsReview, true)
})
test('entry-only revision does not invalidate unchanged current work permission', () => {
  const value = evidence(); value.purposes[1] = { ...value.purposes[1], requestVersion: 2, effective: false, holds: ['awaiting_decisions'] }
  const result = projectPlanConsent(required, value, now)
  assert.equal(result.residentApprovalVerified, true); assert.equal(result.entryAuthorized, false)
})
test('work and entry requirements are independent, including explicit not-required purposes', () => {
  for (const work of [false,true]) for (const entry of [false,true]) {
    const value = evidence()
    value.purposes[0] = { ...value.purposes[0], required: work, effective: work, holds: work ? [] : ['not_required'] }
    value.purposes[1] = { ...value.purposes[1], required: entry, effective: entry, holds: entry ? [] : ['not_required'] }
    const result = projectPlanConsent({ ...required, workRequired: work, entryRequired: entry }, value, now)
    assert.equal(result.residentApprovalRequired, work); assert.equal(result.residentApprovalVerified, work)
    assert.equal(result.entryPermissionRequired, entry); assert.equal(result.entryAuthorized, entry); assert.equal(result.needsReview, false)
  }
})
test('a new consent policy cannot waive an existing maintenance work requirement', () => {
  const value = evidence(); value.purposes[0] = { ...value.purposes[0], required: false, effective: false, holds: ['not_required'] }
  const result = projectPlanConsent(required, value, now)
  assert.equal(result.residentApprovalRequired, true); assert.equal(result.residentApprovalVerified, false); assert.equal(result.needsReview, true)
})
test('missing consent, current graph expiry and any required-purpose hold prevent readiness', () => {
  assert.equal(projectPlanConsent(required, undefined, now).needsReview, true)
  for (const mutate of [
    (value: MaintenanceConsentEvidence) => { value.refreshAt = now.toISOString() },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].refreshAt = now.toISOString() },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].holds = ['revoked'] },
    (value: MaintenanceConsentEvidence) => { value.materialDigest = null },
  ]) {
    const value = evidence(); mutate(value)
    assert.equal(projectPlanConsent(required, value, now).needsReview, true)
  }
})
test('the scoped graph parser refuses omitted, duplicate or unexpected cases and leaked fields', () => {
  assert.equal(readMaintenanceConsentGraph([evidence()], ['case-one'], 1).size, 1)
  for (const raw of [[], [evidence(),evidence()], [{ ...evidence(), caseId: 'another-case' }],
    [{ ...evidence(), recipients: ['private household data'] }]]) {
    assert.throws(() => readMaintenanceConsentGraph(raw, ['case-one'], 1))
  }
  assert.throws(() => readMaintenanceConsentGraph([evidence()], ['case-one'], 2))
  assert.throws(() => readMaintenanceConsentGraph([], Array.from({length:202}, (_,i)=>`case-${i}`), 1))
})
test('the graph parser refuses fabricated effective flags and malformed authority metadata', () => {
  for (const mutate of [
    (value: MaintenanceConsentEvidence) => { value.purposes[0].required = false },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].holds = ['declined'] },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].requestId = null },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].refreshAt = null },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].materialDigest = 'invalid' },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].requestVersion = 0 },
    (value: MaintenanceConsentEvidence) => { value.purposes[0].purpose = 'entry' },
    (value: MaintenanceConsentEvidence) => { value.revision = '' },
    (value: MaintenanceConsentEvidence) => { value.refreshAt = '2026-09-13T20:00:00.000Z' },
  ]) {
    const value = evidence(); mutate(value)
    assert.throws(() => readMaintenanceConsentGraph([value], ['case-one'], 1))
  }
})
test('an absent plan is represented explicitly without manufacturing required recipients', () => {
  const value = evidence(); value.planId = null; value.planVersion = null; value.materialDigest = null
  for (const purpose of value.purposes) { purpose.requestId = null; purpose.requestVersion = null; purpose.materialDigest = null;
    purpose.effective = false; purpose.holds = ['missing_plan']; purpose.refreshAt = null }
  value.refreshAt = null
  assert.equal(readMaintenanceConsentGraph([value], ['case-one'], 1).get('case-one')!.planId, null)
})
