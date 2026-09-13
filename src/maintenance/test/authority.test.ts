import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMaintenancePlan } from '../authority.ts'
import type { MaintenanceAuthorityInput } from '../authority.ts'

const now = new Date('2026-09-13T12:00:00.000Z')
function fixture(): MaintenanceAuthorityInput {
  return {
    configurationVersion: 1,
    request: { id: 'case-one', organizationId: 'org-one', propertyId: 'property-one', version: 2,
      requestOrigin: 'staff_observation', location: { kind: 'common_area', label: 'Lobby' }, residentId: null,
      summary: 'Replace a worn washer', description: 'Staff inspection found a slow tap drip.', category: 'plumbing', reportedPriority: 'routine',
      reporterName: null, reporterPhone: null, reporterEmail: null, accessNotes: '', state: 'ready_for_planning', priority: 'routine', emergencyKinds: [],
      createdAt: now.toISOString(), updatedAt: now.toISOString(), createdBy: 'staff-one', intakeLocation: { kind: 'common_area', label: 'Lobby' },
      residentIdAtIntake: null, residentVersionAtIntake: null, residentNameAtIntake: null, contextNeedsReview: false,
      dispatchStatus: 'not_dispatched', notificationStatus: 'not_sent', callerIdentityVerified: false, entryAuthorized: false },
    resident: { state: 'not_established', residentId: null, residentVersion: null, displayName: null, unitId: null, callerIdentityVerified: false, entryAuthorized: false },
    policy: { organizationId: 'org-one', propertyId: 'property-one', version: 1, currency: 'USD', automaticLimitCents: 10_000,
      managerLimitCents: 50_000, ownerLimitCents: 100_000, automaticCategories: ['plumbing'], excludedCategories: ['access'],
      requireResidentApproval: false, requireIndependentApprover: true, sourceReference: 'Synthetic owner-approved property authority',
      observedAt: '2026-09-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z', publishedBy: 'owner-one', publishedAt: now.toISOString() },
    plan: { id: 'plan-one', caseId: 'case-one', organizationId: 'org-one', propertyId: 'property-one', version: 1, caseVersion: 2,
      configurationVersion: 1, residentId: null, residentVersion: null, policyVersion: 1, preparedBy: 'staff-one', preparedAt: now.toISOString(),
      createdAt: now.toISOString(), withdrawnAt: null, emergencyKinds: [], route: 'internal', vendorId: null, vendorVersion: null,
      internalTeam: 'Building maintenance', scopeOfWork: 'Replace the lobby tap washer', currency: 'USD', maximumCents: 10_000,
      includesAllCharges: true, accessRequirement: 'no_unit_entry', restrictions: [], reason: 'Staff reviewed the complete repair scope' },
    vendor: null, decision: null,
  }
}
function approval(input: MaintenanceAuthorityInput, role: 'owner' | 'admin' = 'admin') {
  input.decision = { id: 'decision-one', planId: input.plan!.id, planVersion: input.plan!.version, decision: 'approve',
    actorUserId: 'approver-one', actorRole: role, currentRole: role, reason: 'Reviewed the exact scope and complete ceiling',
    decidedAt: now.toISOString(), authorityCurrent: true }
}
test('routine authority includes the exact ceiling and never claims execution or entry', () => {
  const f = fixture(), at = evaluateMaintenancePlan(f, now)
  assert.equal(at.tier, 'automatic'); assert.equal(at.readiness, 'authorized_plan'); assert.equal(at.spendingAuthorized, true)
  assert.equal(at.dispatchStatus, 'not_dispatched'); assert.equal(at.notificationStatus, 'not_sent'); assert.equal(at.entryAuthorized, false)
  f.plan!.maximumCents = 10_001
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'awaiting_manager')
  f.plan!.maximumCents = 0
  assert.equal(evaluateMaintenancePlan(f, now).tier, 'automatic')
})
test('unknown or partial costs and costs above the owner ceiling cannot be ordinary approval', () => {
  for (const change of [{ maximumCents: null }, { includesAllCharges: false }, { maximumCents: 100_001 }]) {
    const f = fixture(); Object.assign(f.plan!, change); approval(f, 'owner')
    assert.equal(evaluateMaintenancePlan(f, now).readiness, 'management_review')
    assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
  }
})
test('urgent routine-looking work requires approval and owner boundaries are inclusive', () => {
  const f = fixture(); f.request.priority = 'urgent'
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'awaiting_manager')
  f.plan!.maximumCents = 50_000; approval(f)
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, true)
  f.plan!.maximumCents = 50_001
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'stale_plan')
  approval(f, 'owner'); f.plan!.maximumCents = 100_000
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, true)
})
test('a preparer or former owner cannot satisfy an independent current owner decision', () => {
  const f = fixture(); f.plan!.maximumCents = 75_000; approval(f, 'owner')
  f.decision!.actorUserId = f.plan!.preparedBy
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'stale_plan')
  f.decision!.actorUserId = 'owner-two'; f.decision!.currentRole = 'admin'
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'stale_plan')
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
  f.decision!.currentRole = 'owner'; f.decision!.authorityCurrent = false
  assert.match(evaluateMaintenancePlan(f, now).reasons.join(' '), /Revise the plan/)
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
  f.decision!.authorityCurrent = true
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, true)
})
test('a current manager retains delegated approval and automatic authority is independent of an optional former approver', () => {
  const f = fixture(); f.plan!.maximumCents = 20_000; approval(f)
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'authorized_plan')
  f.decision!.authorityCurrent = false; f.decision!.currentRole = null
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'stale_plan')
  f.plan!.maximumCents = 10_000
  const result = evaluateMaintenancePlan(f, now)
  assert.equal(result.tier, 'automatic'); assert.equal(result.spendingAuthorized, true)
})
test('material request, configuration, policy and resident changes invalidate old approvals', () => {
  for (const change of [(f: MaintenanceAuthorityInput) => f.request.version++, (f: MaintenanceAuthorityInput) => f.configurationVersion++,
    (f: MaintenanceAuthorityInput) => f.policy!.version++, (f: MaintenanceAuthorityInput) => { f.resident.residentId = 'resident-new'; f.resident.residentVersion = 1 },
    (f: MaintenanceAuthorityInput) => { f.policy!.propertyId = 'other-property' }]) {
    const f = fixture(); f.plan!.maximumCents = 75_000; approval(f, 'owner'); change(f)
    assert.equal(evaluateMaintenancePlan(f, now).readiness, 'stale_plan')
    assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
  }
})
test('policy expiry and lost triage context block old automatic eligibility', () => {
  const f = fixture(); f.policy!.validUntil = now.toISOString()
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'needs_policy')
  f.policy = fixture().policy; f.request.contextNeedsReview = true
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'needs_context')
  f.request.contextNeedsReview = false; f.request.state = 'needs_triage'
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
})
test('new prose or retained safety evidence outranks an inexpensive plan and owner approval', () => {
  for (const change of [(f: MaintenanceAuthorityInput) => { f.plan!.scopeOfWork = 'Repair the gas leak' },
    (f: MaintenanceAuthorityInput) => { f.plan!.emergencyKinds = ['gas'] }, (f: MaintenanceAuthorityInput) => { f.decision!.reason = 'There is smoke and fire in the hallway' }]) {
    const f = fixture(); approval(f, 'owner'); change(f)
    assert.equal(evaluateMaintenancePlan(f, now).readiness, 'emergency_review')
    assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
  }
})
test('restricted work cannot bypass management by omitting a restriction checkbox', () => {
  const f = fixture(); f.plan!.scopeOfWork = 'Remove asbestos from the ceiling'; approval(f, 'owner')
  assert.equal(evaluateMaintenancePlan(f, now).tier, 'management_escalation')
  f.plan!.scopeOfWork = 'Replace lock'; f.request.category = 'access'
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
})
test('resident approval and entry remain unmet after financial approval', () => {
  const f = fixture(); f.policy!.requireResidentApproval = true
  let result = evaluateMaintenancePlan(f, now)
  assert.equal(result.spendingAuthorized, true); assert.equal(result.readiness, 'awaiting_resident')
  f.policy!.requireResidentApproval = false; f.plan!.accessRequirement = 'unit_entry'
  result = evaluateMaintenancePlan(f, now)
  assert.equal(result.readiness, 'awaiting_resident'); assert.equal(result.entryAuthorized, false)
})
test('vendor changes and coverage are distinct from availability confirmation', () => {
  const f = fixture(); f.plan!.route = 'vendor'; f.plan!.internalTeam = null; f.plan!.vendorId = 'vendor-one'; f.plan!.vendorVersion = 1
  f.vendor = { id: 'vendor-one', organizationId: 'org-one', propertyId: 'property-one', version: 1, name: 'Synthetic plumbing provider',
    categories: ['plumbing'], status: 'approved', phone: '+15555550101', email: null, serviceArea: 'Selected property', hours: 'Weekday business hours',
    emergencyCoverage: false, availability: 'unknown', availabilityObservedAt: null, availabilityValidUntil: null, expectedPricing: 'Per quote',
    responseTargetMinutes: 60, preference: 1, restrictions: '', sourceReference: 'Synthetic reviewed directory', observedAt: '2026-09-01T00:00:00.000Z',
    validUntil: '2026-10-01T00:00:00.000Z', reviewedBy: 'owner-one', reviewedAt: now.toISOString(), createdAt: now.toISOString() }
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'awaiting_vendor')
  f.vendor.availability = 'available'; f.vendor.availabilityObservedAt = '2026-09-12T00:00:00.000Z'; f.vendor.availabilityValidUntil = '2026-09-14T00:00:00.000Z'
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'authorized_plan')
  f.vendor.availabilityValidUntil = now.toISOString()
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'awaiting_vendor')
  f.vendor.categories = ['electrical']
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'management_review')
  f.vendor.version = 2
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'stale_plan')
})
test('rejection and withdrawal cannot retain spending approval', () => {
  const f = fixture(); f.plan!.maximumCents = 20_000; approval(f); f.decision!.decision = 'reject'
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'rejected')
  f.plan!.withdrawnAt = now.toISOString()
  assert.equal(evaluateMaintenancePlan(f, now).readiness, 'withdrawn')
  assert.equal(evaluateMaintenancePlan(f, now).spendingAuthorized, false)
})
