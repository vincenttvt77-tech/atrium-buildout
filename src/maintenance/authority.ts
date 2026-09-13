import type { ServiceCase } from './model.ts'
import type { ResidentContext } from '../residents/model.ts'
import { detectEmergency } from '../escalation/emergency.ts'
import { MaintenancePlanningError } from './planning-model.ts'
import type { MaintenanceAssessment, MaintenancePolicy, MaintenancePlan, MaintenanceVendor, MaintenanceDecision, MaintenanceReadiness, MaintenanceTier } from './planning-model.ts'

export interface MaintenanceAuthorityInput {
  request: ServiceCase
  resident: ResidentContext
  policy: MaintenancePolicy | null
  plan: MaintenancePlan | null
  vendor: MaintenanceVendor | null
  decision: MaintenanceDecision | null
  configurationVersion: number
}
/** A conservative supplement to explicit human classification, not legal analysis. */
export function hasRestrictedMaintenanceText(text: string): boolean {
  return /\b(?:lawsuit|litigation|eviction|evict|asbestos|load[ -]bearing|structural (?:repair|alteration|damage)|legal (?:dispute|notice|action)|accommodation request)\b/i.test(text)
}
const current = (observed: string | null, until: string | null, now: number): boolean => observed !== null && until !== null
  && Number.isFinite(Date.parse(observed)) && Number.isFinite(Date.parse(until)) && Date.parse(observed) <= now && now < Date.parse(until)

/** An approved internal plan is not a permit for entry or a provider commitment. */
export function evaluateMaintenancePlan(input: MaintenanceAuthorityInput, now: Date): MaintenanceAssessment {
  const time = now.getTime()
  if (!Number.isFinite(time)) throw new MaintenancePlanningError('planning_unavailable', 'The current maintenance authority could not be established.')
  const { request, resident, policy, plan, vendor, decision } = input
  const base: MaintenanceAssessment = { tier: null, readiness: 'needs_plan', reasons: [], requiredApprover: null,
    spendingAuthorized: false, residentApprovalRequired: policy?.requireResidentApproval ?? true,
    residentApprovalVerified: false, entryAuthorized: false, dispatchStatus: 'not_dispatched', notificationStatus: 'not_sent' }
  const hold = (readiness: MaintenanceReadiness, reason: string, tier: MaintenanceTier | null = null): MaintenanceAssessment =>
    ({ ...base, readiness, reasons: [reason], tier })
  const words = [request.summary, request.description, request.accessNotes, plan?.scopeOfWork, plan?.reason, decision?.reason].filter(Boolean).join('\n')
  if (request.priority === 'emergency' || request.state === 'emergency_review' || request.emergencyKinds.length
    || plan?.emergencyKinds.length || detectEmergency(words).length) {
    return hold('emergency_review', 'Follow the property emergency protocol. Ordinary work approval cannot clear this safety hold.', 'emergency')
  }
  if (plan?.withdrawnAt) return hold('withdrawn', 'This work plan was withdrawn. Prepare and review a new version before continuing.')
  if (!policy || !current(policy.observedAt, policy.validUntil, time)) {
    return hold('needs_policy', 'An owner must publish current maintenance authority rules for this property.')
  }
  if (!plan) return hold('needs_plan', 'Prepare the work scope, route and total cost ceiling before reviewing authority.')
  if (policy.organizationId !== request.organizationId || policy.propertyId !== request.propertyId
    || plan.organizationId !== request.organizationId || plan.propertyId !== request.propertyId || plan.caseId !== request.id
    || plan.caseVersion !== request.version || plan.configurationVersion !== input.configurationVersion || plan.policyVersion !== policy.version
    || plan.residentId !== resident.residentId || plan.residentVersion !== resident.residentVersion) {
    return hold('stale_plan', 'The request, resident context or authority rules changed. Prepare a new plan from the current details.')
  }
  if (request.state !== 'ready_for_planning' || request.contextNeedsReview || request.location.kind === 'unknown'
    || (request.location.kind === 'unit' && request.requestOrigin !== 'staff_observation'
      && (resident.state !== 'current' || resident.unitId !== request.location.unitId || resident.residentId !== request.residentId))) {
    return hold('needs_context', 'Complete request triage and current location or resident context before approving work.')
  }
  if (plan.restrictions.length || policy.excludedCategories.includes(request.category) || hasRestrictedMaintenanceText(words)) {
    return hold('management_review', 'This work has a restricted or unusual condition and needs a management handoff.', 'management_escalation')
  }
  if (plan.currency !== policy.currency || plan.maximumCents === null || !plan.includesAllCharges
    || !Number.isSafeInteger(plan.maximumCents) || plan.maximumCents < 0 || plan.maximumCents > policy.ownerLimitCents) {
    return hold('management_review', 'Establish an all-in cost ceiling within the owner-approved limit, or arrange a management exception.', 'management_escalation')
  }
  if (plan.route === 'vendor') {
    if (!vendor || vendor.id !== plan.vendorId || vendor.version !== plan.vendorVersion
      || vendor.organizationId !== request.organizationId || vendor.propertyId !== request.propertyId) {
      return hold('stale_plan', 'The selected vendor record changed. Review the current vendor and prepare a new plan.')
    }
    if (vendor.status !== 'approved' || !current(vendor.observedAt, vendor.validUntil, time) || !vendor.categories.includes(request.category)) {
      return hold('management_review', 'Select a currently approved vendor covering this type of work.', 'management_escalation')
    }
  }
  // Unstructured vendor restrictions require a human decision even for inexpensive work.
  const automatic = request.priority === 'routine' && policy.automaticLimitCents !== null
    && plan.maximumCents <= policy.automaticLimitCents && policy.automaticCategories.includes(request.category)
    && !(plan.route === 'vendor' && vendor?.restrictions)
  base.tier = automatic ? 'automatic' : 'approval_required'
  base.requiredApprover = automatic ? null : policy.managerLimitCents !== null && plan.maximumCents <= policy.managerLimitCents ? 'admin_or_owner' : 'owner'
  const matchingDecision = decision && decision.planId === plan.id && decision.planVersion === plan.version ? decision : null
  if (matchingDecision?.decision === 'reject') return { ...base, readiness: 'rejected', reasons: ['The plan was rejected. Revise the scope and submit a new version.'] }
  if (!automatic) {
    const roleSufficient = matchingDecision?.currentRole === 'owner'
      || (base.requiredApprover === 'admin_or_owner' && matchingDecision?.currentRole === 'admin')
    if (matchingDecision?.decision === 'approve' && (!matchingDecision.authorityCurrent || !roleSufficient
      || (policy.requireIndependentApprover && matchingDecision.actorUserId === plan.preparedBy))) {
      return { ...base, readiness: 'stale_plan', reasons: [
        'The recorded approval no longer has current authority. Revise the plan, then obtain a new approval under the current rules.',
      ] }
    }
    if (!matchingDecision || matchingDecision.decision !== 'approve' || !matchingDecision.authorityCurrent || !roleSufficient
      || (policy.requireIndependentApprover && matchingDecision.actorUserId === plan.preparedBy)) {
      return { ...base, readiness: base.requiredApprover === 'owner' ? 'awaiting_owner' : 'awaiting_manager',
        reasons: [base.requiredApprover === 'owner' ? 'A currently authorized owner must approve this exact plan.' : 'A currently authorized manager or owner must approve this exact plan.',
          ...(policy.requireIndependentApprover ? ['The approver must be different from the person who prepared the plan.'] : [])] }
    }
  }
  base.spendingAuthorized = true
  // Resident approval and unit entry are independent of a manager's spending decision.
  base.residentApprovalRequired = policy.requireResidentApproval || plan.accessRequirement === 'unit_entry'
  if (base.residentApprovalRequired) return { ...base, readiness: 'awaiting_resident',
    reasons: ['The spending decision is recorded, but verified resident approval or unit-entry authority is still required.'] }
  if (plan.route === 'vendor' && (!vendor || vendor.availability !== 'available'
    || !current(vendor.availabilityObservedAt, vendor.availabilityValidUntil, time))) {
    return { ...base, readiness: 'awaiting_vendor', reasons: ['The spending decision is recorded. Confirm current vendor availability before arranging work.'] }
  }
  return { ...base, readiness: 'authorized_plan', reasons: ['This work plan is authorized. No appointment, dispatch or notification has been made.'] }
}
