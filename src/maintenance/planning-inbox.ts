import type { MaintenanceAuthorityInput } from './authority.ts'
import { evaluateMaintenancePlan } from './authority.ts'
import type { MaintenanceAssessment, MaintenanceInboxItem, MaintenanceInboxNextStep, MaintenanceInboxQuery } from './planning-model.ts'
import { MaintenancePlanningError } from './planning-model.ts'
import { validateServiceListQuery } from './validation.ts'

export interface MaintenanceInboxActor { userId: string; role: 'owner' | 'admin' | 'staff'; configure: boolean }
export const maintenanceInboxScanLimit = 200

export function validateMaintenanceInboxQuery(value: unknown): MaintenanceInboxQuery {
  const invalid = (): never => { throw new MaintenancePlanningError('planning_invalid_input', 'Review the planning inbox filters and refresh the list.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['limit', 'filter', 'unitId', 'before'].includes(k))
    || !['attention', 'waiting', 'all'].includes(v.filter as string)
    || !Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 50) return invalid()
  try {
    const page = validateServiceListQuery({ limit: v.limit, ...(v.before !== undefined ? { before: v.before } : {}),
      ...(v.unitId !== undefined ? { unitId: v.unitId } : {}) }, 'cases')
    if (page.before && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(page.before.id)) return invalid()
    return { limit: page.limit, filter: v.filter as MaintenanceInboxQuery['filter'],
      ...(page.before ? { before: page.before } : {}), ...(page.unitId ? { unitId: page.unitId } : {}) }
  } catch { return invalid() }
}

/** Keep list and detail affordances tied to the same current exact-plan authority. */
export function canDecideMaintenancePlan(input: MaintenanceAuthorityInput, assessment: MaintenanceAssessment, actor: MaintenanceInboxActor): boolean {
  const { plan, decision, policy } = input
  return Boolean(plan && !plan.withdrawnAt && !decision && actor.configure && ['owner', 'admin'].includes(actor.role)
    && ['awaiting_owner', 'awaiting_manager'].includes(assessment.readiness)
    && (assessment.requiredApprover !== 'owner' || actor.role === 'owner')
    && (!policy?.requireIndependentApprover || plan.preparedBy !== actor.userId))
}

function nextStep(input: MaintenanceAuthorityInput, assessment: MaintenanceAssessment, actor: MaintenanceInboxActor, canDecide: boolean, now: Date): MaintenanceInboxNextStep {
  const step = (kind: MaintenanceInboxNextStep['kind'], label: string,
    responsible: MaintenanceInboxNextStep['responsible'] = 'property_team', availableInPortal = true): MaintenanceInboxNextStep =>
    ({ kind, label, responsible, availableInPortal })
  const { request, resident, plan } = input
  if (assessment.readiness === 'emergency_review') return step('review_emergency', 'Review emergency instructions and contact the property response team')
  // Financial readiness checks policy/plan first. Operational triage must still be the first achievable step.
  if (request.state !== 'ready_for_planning' || request.contextNeedsReview || request.location.kind === 'unknown'
    || request.location.kind === 'unit' && request.requestOrigin !== 'staff_observation'
      && (resident.state !== 'current' || resident.unitId !== request.location.unitId || resident.residentId !== request.residentId)) {
    return step('review_context', 'Review request context and triage')
  }
  if (!input.policy || !(Date.parse(input.policy.observedAt) <= now.getTime() && now.getTime() < Date.parse(input.policy.validUntil))) {
    return step('publish_policy', 'Owner review of maintenance rules', 'owner', actor.role === 'owner' && actor.configure)
  }
  switch (assessment.readiness) {
    case 'needs_policy': return step('publish_policy', 'Owner review of maintenance rules', 'owner', actor.role === 'owner' && actor.configure)
    case 'needs_plan': return step('prepare_plan', 'Prepare the work scope and total cost')
    case 'stale_plan': case 'rejected': case 'withdrawn': return step('revise_plan', 'Review and prepare a new plan version')
    case 'needs_context': return step('review_context', 'Review request context and triage')
    case 'awaiting_manager': case 'awaiting_owner': return step('review_decision', canDecide ? 'Review the exact plan for a decision' :
      input.policy?.requireIndependentApprover && plan?.preparedBy === actor.userId ? 'Request a decision from another authorized approver' :
      assessment.requiredApprover === 'owner' ? 'Request an owner decision' : 'Request a manager or owner decision',
      assessment.requiredApprover === 'owner' ? 'owner' : 'manager_or_owner', canDecide)
    case 'management_review': return step('management_review', 'Review the restriction, vendor or total cost with management', 'manager_or_owner', actor.configure)
    case 'awaiting_resident': return step('verify_resident', 'Establish verified resident approval or entry authority', 'verified_resident', false)
    case 'awaiting_vendor': return step('confirm_vendor_availability', 'Review current vendor availability', 'manager_or_owner', actor.configure)
    case 'authorized_plan': return step('arrange_work', 'Arrange and verify the work appointment', 'property_team', false)
  }
}

export function projectMaintenanceInboxItem(input: MaintenanceAuthorityInput, actor: MaintenanceInboxActor, now: Date): MaintenanceInboxItem {
  const assessment = evaluateMaintenancePlan(input, now), canDecide = canDecideMaintenancePlan(input, assessment, actor)
  const next = nextStep(input, assessment, actor, canDecide, now), { request, plan } = input
  const waiting = ['awaiting_resident', 'awaiting_vendor', 'authorized_plan'].includes(assessment.readiness)
    && !['review_emergency', 'review_context'].includes(next.kind)
  return { id: request.id, caseVersion: request.version, summary: request.summary, location: { ...request.location },
    category: request.category, priority: request.priority, createdAt: request.createdAt, updatedAt: request.updatedAt,
    planId: plan?.id ?? null, planVersion: plan?.version ?? null, planPreparedAt: plan?.preparedAt ?? null,
    maximumCents: plan?.maximumCents ?? null, includesAllCharges: plan?.includesAllCharges ?? null, currency: 'USD',
    assessment, canDecide, group: waiting ? 'waiting' : 'attention', nextStep: next }
}
