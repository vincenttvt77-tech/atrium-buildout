import test from 'node:test'
import assert from 'node:assert/strict'
import type { MaintenanceAuthorityInput } from '../authority.ts'
import { projectMaintenanceInboxItem, validateMaintenanceInboxQuery } from '../planning-inbox.ts'
import type { MaintenanceInboxActor } from '../planning-inbox.ts'

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

const owner: MaintenanceInboxActor = { userId: 'owner-one', role: 'owner', configure: true }
const staff: MaintenanceInboxActor = { userId: 'staff-one', role: 'staff', configure: false }
const row = (f: MaintenanceAuthorityInput, actor = owner) => projectMaintenanceInboxItem(f, actor, now)

test('untriaged and incomplete requests lead to context review before missing financial policy or plan', () => {
  const f = fixture(); f.plan = null; f.policy = null; f.request.state = 'needs_triage'
  assert.equal(row(f).assessment.readiness, 'needs_policy')
  assert.equal(row(f).nextStep.kind, 'review_context'); assert.equal(row(f).group, 'attention')
  f.request.state = 'ready_for_planning'; f.request.location = { kind: 'unknown', label: 'Not established' }
  assert.equal(row(f).nextStep.kind, 'review_context')
  f.request.location = { kind: 'unit', unitId: '19A' }; f.request.requestOrigin = 'resident_report'
  assert.equal(row(f).nextStep.kind, 'review_context')
  f.request.requestOrigin = 'staff_observation'
  assert.equal(row(f).nextStep.kind, 'publish_policy')
})
test('emergency evidence outranks withdrawal and every other operational next step', () => {
  const f = fixture(); f.plan!.withdrawnAt = now.toISOString(); f.plan!.emergencyKinds = ['gas']; f.request.state = 'needs_triage'; f.policy = null
  assert.equal(row(f).assessment.readiness, 'emergency_review')
  assert.equal(row(f).nextStep.kind, 'review_emergency'); assert.equal(row(f).group, 'attention')
  assert.equal(row(f).canDecide, false)
})
test('withdrawal does not offer a new proposal before the required owner policy renewal', () => {
  const f = fixture(); f.plan!.withdrawnAt = now.toISOString(); f.policy!.validUntil = now.toISOString()
  assert.equal(row(f).assessment.readiness, 'withdrawn')
  assert.equal(row(f).nextStep.kind, 'publish_policy'); assert.equal(row(f).nextStep.availableInPortal, true)
  assert.equal(row(f, staff).nextStep.availableInPortal, false)
  f.policy = null
  assert.equal(row(f, staff).nextStep.kind, 'publish_policy')
})
test('policy publishing and independent exact decisions match the current operator capability', () => {
  const f = fixture(); f.policy = null; f.plan = null
  assert.equal(row(f, staff).nextStep.availableInPortal, false)
  assert.equal(row(f, owner).nextStep.availableInPortal, true)
  assert.equal(row(f, { ...owner, role: 'admin' }).nextStep.availableInPortal, false)
  const p = fixture(); p.plan!.maximumCents = 20_000
  assert.equal(row(p, owner).canDecide, true)
  assert.equal(row(p, { ...owner, configure: false }).canDecide, false)
  p.plan!.preparedBy = owner.userId
  assert.equal(row(p, owner).canDecide, false)
  assert.match(row(p, owner).nextStep.label, /another authorized/)
  p.plan!.preparedBy = staff.userId; p.plan!.maximumCents = 75_000
  assert.equal(row(p, { ...owner, role: 'admin' }).canDecide, false)
  assert.equal(row(p, owner).nextStep.responsible, 'owner')
})
test('a revoked historical approval requires revision instead of another vote', () => {
  const f = fixture(); f.plan!.maximumCents = 20_000
  f.decision = { id: 'decision-one', planId: f.plan!.id, planVersion: 1, decision: 'approve', actorUserId: 'former-manager',
    actorRole: 'admin', currentRole: null, authorityCurrent: false, reason: 'Recorded approval', decidedAt: now.toISOString() }
  assert.equal(row(f).assessment.readiness, 'stale_plan'); assert.equal(row(f).nextStep.kind, 'revise_plan')
  assert.equal(row(f).canDecide, false); assert.equal(row(f).group, 'attention')
})
test('all-in financial authorization remains waiting for actual fulfillment; unknown cost remains unknown', () => {
  const f = fixture()
  assert.equal(row(f).group, 'waiting'); assert.equal(row(f).nextStep.kind, 'arrange_work')
  assert.equal(row(f).nextStep.availableInPortal, false); assert.equal(row(f).assessment.dispatchStatus, 'not_dispatched')
  f.plan!.maximumCents = null
  assert.equal(row(f).maximumCents, null); assert.equal(row(f).group, 'attention')
  f.plan!.maximumCents = 0
  assert.equal(row(f).maximumCents, 0); assert.equal(row(f).assessment.spendingAuthorized, true)
  f.plan!.accessRequirement = 'unit_entry'
  assert.equal(row(f).nextStep.kind, 'verify_resident'); assert.equal(row(f).nextStep.availableInPortal, false)
})
test('minimal inbox rows never project reporter, access, resident or full plan prose', () => {
  const f = fixture(); f.request.reporterName = 'PRIVATE_REPORTER'; f.request.reporterPhone = '+15555550101'
  f.request.reporterEmail = 'private@example.invalid'; f.request.description = 'PRIVATE_DESCRIPTION'; f.request.accessNotes = 'PRIVATE_ACCESS'
  f.resident.displayName = 'PRIVATE_RESIDENT'; f.plan!.scopeOfWork = 'PRIVATE_SCOPE'; f.plan!.reason = 'PRIVATE_REASON'
  const text = JSON.stringify(row(f))
  for (const sensitive of ['PRIVATE_', '+15555550101', 'private@example.invalid', 'reporterName', 'accessNotes', 'scopeOfWork']) assert.equal(text.includes(sensitive), false)
  assert.equal(row(f).id, f.request.id); assert.equal(row(f).caseVersion, 2)
})
test('inbox query accepts only bounded filters and an exact immutable scan cursor', () => {
  const before = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: now.toISOString() }
  assert.deepEqual(validateMaintenanceInboxQuery({ limit: 50, filter: 'waiting', unitId: '19A', before }), { limit: 50, filter: 'waiting', unitId: '19A', before })
  for (const extra of [{ limit: 0 }, { limit: 51 }, { filter: 'done' }, { states: ['ready_for_planning'] }, { before: { ...before, role: 'owner' } }, { before: { ...before, id: 'not-a-uuid' } }]) {
    assert.throws(() => validateMaintenanceInboxQuery({ limit: 25, filter: 'attention', ...extra }), { code: 'planning_invalid_input' })
  }
})
