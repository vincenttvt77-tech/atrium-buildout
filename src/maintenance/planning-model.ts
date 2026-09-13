import type { Role } from '../auth/model.ts'
import type { ServiceCase, ServiceCategory, ServiceCursor } from './model.ts'
import type { ResidentContext } from '../residents/model.ts'
import type { EmergencyKind } from '../escalation/emergency.ts'

/** USD per-job ceilings include taxes, callout fees, materials and contingency. */
export interface MaintenancePolicyDetails {
  currency: 'USD'
  automaticLimitCents: number | null
  managerLimitCents: number | null
  ownerLimitCents: number
  automaticCategories: ServiceCategory[]
  excludedCategories: ServiceCategory[]
  requireResidentApproval: boolean
  requireIndependentApprover: boolean
  sourceReference: string
  observedAt: string
  validUntil: string
}
export interface MaintenancePolicy extends MaintenancePolicyDetails {
  organizationId: string
  propertyId: string
  version: number
  publishedBy: string
  publishedAt: string
}
export interface MaintenanceVendorDetails {
  name: string
  categories: ServiceCategory[]
  status: 'approved' | 'suspended'
  phone: string | null
  email: string | null
  serviceArea: string
  hours: string
  emergencyCoverage: boolean
  availability: 'unknown' | 'available' | 'unavailable'
  availabilityObservedAt: string | null
  availabilityValidUntil: string | null
  expectedPricing: string
  responseTargetMinutes: number | null
  preference: number
  restrictions: string
  sourceReference: string
  observedAt: string
  validUntil: string
}
export interface MaintenanceVendor extends MaintenanceVendorDetails {
  id: string
  organizationId: string
  propertyId: string
  version: number
  reviewedBy: string
  reviewedAt: string
  createdAt: string
}
export type PlanRestriction = 'legal' | 'structural' | 'safety_sensitive' | 'unusual' | 'other_restricted'
export interface MaintenancePlanDetails {
  route: 'internal' | 'vendor'
  vendorId: string | null
  vendorVersion: number | null
  internalTeam: string | null
  scopeOfWork: string
  currency: 'USD'
  maximumCents: number | null
  includesAllCharges: boolean
  accessRequirement: 'no_unit_entry' | 'unit_entry'
  restrictions: PlanRestriction[]
  reason: string
}
export interface MaintenancePlan extends MaintenancePlanDetails {
  id: string
  caseId: string
  organizationId: string
  propertyId: string
  version: number
  caseVersion: number
  configurationVersion: number
  residentId: string | null
  residentVersion: number | null
  policyVersion: number
  preparedBy: string
  preparedAt: string
  createdAt: string
  withdrawnAt: string | null
  /** New safety evidence is retained across later plan revisions. */
  emergencyKinds: EmergencyKind[]
}
export interface MaintenanceDecision {
  id: string
  planId: string
  planVersion: number
  decision: 'approve' | 'reject'
  actorUserId: string
  actorRole: 'owner' | 'admin'
  reason: string
  decidedAt: string
  /** Derived from the person's current membership/grant, never a browser claim. */
  authorityCurrent: boolean
  currentRole: 'owner' | 'admin' | null
}
export interface MaintenancePlanHistoryEntry {
  id: string
  planId: string
  planVersion: number
  kind: 'prepared' | 'approved' | 'rejected' | 'withdrawn' | 'safety_hold'
  actorUserId: string
  createdAt: string
  reason: string
  scopeOfWork: string
  maximumCents: number | null
  currency: 'USD'
  vendorName: string | null
  policyVersion: number
  caseVersion: number
}
export type MaintenanceTier = 'automatic' | 'approval_required' | 'management_escalation' | 'emergency'
export type MaintenanceReadiness = 'needs_plan' | 'needs_policy' | 'stale_plan' | 'needs_context'
  | 'emergency_review' | 'management_review' | 'awaiting_manager' | 'awaiting_owner'
  | 'rejected' | 'withdrawn' | 'awaiting_resident' | 'awaiting_vendor' | 'authorized_plan'
export interface MaintenanceAssessment {
  tier: MaintenanceTier | null
  readiness: MaintenanceReadiness
  reasons: string[]
  requiredApprover: 'owner' | 'admin_or_owner' | null
  spendingAuthorized: boolean
  residentApprovalRequired: boolean
  residentApprovalVerified: false
  entryAuthorized: false
  dispatchStatus: 'not_dispatched'
  notificationStatus: 'not_sent'
}
export interface MaintenancePlanDetail {
  request: ServiceCase
  resident: ResidentContext
  policy: MaintenancePolicy | null
  plan: MaintenancePlan | null
  vendor: MaintenanceVendor | null
  decision: MaintenanceDecision | null
  assessment: MaintenanceAssessment
  canDecide: boolean
  history: MaintenancePlanHistoryEntry[]
  nextHistoryCursor: ServiceCursor | null
}
export interface MaintenancePlanningOverview {
  policy: MaintenancePolicy | null
  canPublishPolicy: boolean
  canManageVendors: boolean
  actorRole: Role
}
export type MaintenancePlanningCommand =
  | { action: 'publish_policy'; requestId: string; expectedVersion: number; details: MaintenancePolicyDetails; reason: string }
  | { action: 'save_vendor'; requestId: string; id: string | null; expectedVersion: number; details: MaintenanceVendorDetails; reason: string }
  | { action: 'prepare_plan'; requestId: string; caseId: string; expectedCaseVersion: number; expectedPlanVersion: number; policyVersion: number; details: MaintenancePlanDetails }
  | { action: 'decide_plan'; requestId: string; caseId: string; planId: string; expectedPlanVersion: number; decision: 'approve' | 'reject'; reason: string }
  | { action: 'withdraw_plan'; requestId: string; caseId: string; planId: string; expectedPlanVersion: number; reason: string }
export interface MaintenancePlanningReceipt {
  requestId: string
  action: MaintenancePlanningCommand['action']
  resource: 'policy' | 'vendor' | 'plan'
  id: string
  version: number
  committedAt: string
  replayed: boolean
  /** A committed safety hold is explicitly not an approval. */
  outcome: 'saved' | 'emergency_held'
}
export interface MaintenancePlanningRepository {
  overview(): Promise<MaintenancePlanningOverview>
  listVendors(query: { limit: number; before?: ServiceCursor; status?: 'approved' | 'suspended' }): Promise<MaintenanceVendor[]>
  getVendor(id: string): Promise<MaintenanceVendor | null>
  getPlan(caseId: string): Promise<MaintenancePlanDetail | null>
  listPlanHistory(caseId: string, query: { limit: number; before?: ServiceCursor }): Promise<MaintenancePlanHistoryEntry[]>
  execute(command: MaintenancePlanningCommand, proofId?: string): Promise<MaintenancePlanningReceipt>
}
export type MaintenancePlanningErrorCode = 'planning_invalid_input' | 'planning_not_found' | 'planning_version_conflict'
  | 'planning_request_conflict' | 'planning_not_ready' | 'planning_mfa_required' | 'planning_unavailable'
export class MaintenancePlanningError extends Error {
  readonly code: MaintenancePlanningErrorCode
  constructor(code: MaintenancePlanningErrorCode, message: string) { super(message); this.code = code }
}
