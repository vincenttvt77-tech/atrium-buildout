import type { ServiceCategory } from './model.ts'
import { serviceCategories } from './validation.ts'
import { exactObject, boundedText, recordId, isoTimestamp, contactPhone, contactEmail } from '../residents/validation.ts'
import { MaintenancePlanningError } from './planning-model.ts'
import type { MaintenancePolicyDetails, MaintenanceVendorDetails, MaintenancePlanDetails, MaintenancePlanningCommand, PlanRestriction } from './planning-model.ts'

export const maximumMaintenanceCents = 1_000_000_000
export const policyReviewMaximumMs = 365 * 86_400_000
export const vendorReviewMaximumMs = 90 * 86_400_000
export const vendorAvailabilityMaximumMs = 14 * 86_400_000
export const planRestrictions: readonly PlanRestriction[] = ['legal', 'structural', 'safety_sensitive', 'unusual', 'other_restricted']
const invalid = (): never => { throw new MaintenancePlanningError('planning_invalid_input', 'Review the maintenance plan, authority limits and source dates.') }
const safe = <T>(fn: () => T): T => { try { return fn() } catch { return invalid() } }
const id = (v: unknown): string => recordId(v) ? v : invalid()
const version = (v: unknown, zero = false): number => Number.isSafeInteger(v) && Number(v) >= (zero ? 0 : 1) ? Number(v) : invalid()
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : invalid()
const money = (v: unknown, nullable = true): number | null => v === null && nullable ? null
  : Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= maximumMaintenanceCents ? Number(v) : invalid()
function choices<T extends string>(v: unknown, allowed: readonly T[], empty = true): T[] {
  if (!Array.isArray(v) || v.length > allowed.length || (!empty && !v.length)
    || v.some(x => !allowed.includes(x)) || new Set(v).size !== v.length) return invalid()
  return allowed.filter(x => v.includes(x))
}
function source(v: Record<string, unknown>, maxAge: number) {
  const observedAt = isoTimestamp(v.observedAt), validUntil = isoTimestamp(v.validUntil)
  const age = Date.parse(validUntil) - Date.parse(observedAt)
  if (age <= 0 || age > maxAge) return invalid()
  return { sourceReference: boundedText(v.sourceReference, 3, 240), observedAt, validUntil }
}
export function parsePolicyDetails(input: unknown): MaintenancePolicyDetails {
  return safe(() => {
    const v = exactObject(input, ['currency', 'automaticLimitCents', 'managerLimitCents', 'ownerLimitCents', 'automaticCategories',
      'excludedCategories', 'requireResidentApproval', 'requireIndependentApprover', 'sourceReference', 'observedAt', 'validUntil'])
    if (v.currency !== 'USD') return invalid()
    const automaticLimitCents = money(v.automaticLimitCents), managerLimitCents = money(v.managerLimitCents)
    const ownerLimitCents = money(v.ownerLimitCents, false)!
    if ((automaticLimitCents !== null && automaticLimitCents > ownerLimitCents)
      || (managerLimitCents !== null && managerLimitCents > ownerLimitCents)
      || (automaticLimitCents !== null && managerLimitCents !== null && automaticLimitCents > managerLimitCents)) return invalid()
    const automaticCategories = choices<ServiceCategory>(v.automaticCategories, serviceCategories)
    const excludedCategories = choices<ServiceCategory>(v.excludedCategories, serviceCategories)
    if (automaticCategories.some(c => excludedCategories.includes(c))
      || (automaticLimitCents === null && automaticCategories.length)) return invalid()
    return { currency: 'USD', automaticLimitCents, managerLimitCents, ownerLimitCents, automaticCategories, excludedCategories,
      requireResidentApproval: bool(v.requireResidentApproval), requireIndependentApprover: bool(v.requireIndependentApprover),
      ...source(v, policyReviewMaximumMs) }
  })
}
export function parseVendorDetails(input: unknown): MaintenanceVendorDetails {
  return safe(() => {
    const v = exactObject(input, ['name', 'categories', 'status', 'phone', 'email', 'serviceArea', 'hours', 'emergencyCoverage',
      'availability', 'availabilityObservedAt', 'availabilityValidUntil', 'expectedPricing', 'responseTargetMinutes',
      'preference', 'restrictions', 'sourceReference', 'observedAt', 'validUntil'])
    if (!['approved', 'suspended'].includes(v.status as string) || !['unknown', 'available', 'unavailable'].includes(v.availability as string)
      || !Number.isSafeInteger(v.preference) || Number(v.preference) < 0 || Number(v.preference) > 1000) return invalid()
    const phone = contactPhone(v.phone), email = contactEmail(v.email)
    if (v.status === 'approved' && !phone && !email) return invalid()
    let availabilityObservedAt: string | null = null, availabilityValidUntil: string | null = null
    if (v.availability === 'unknown') {
      if (v.availabilityObservedAt !== null || v.availabilityValidUntil !== null) return invalid()
    } else {
      availabilityObservedAt = isoTimestamp(v.availabilityObservedAt); availabilityValidUntil = isoTimestamp(v.availabilityValidUntil)
      const age = Date.parse(availabilityValidUntil) - Date.parse(availabilityObservedAt)
      if (age <= 0 || age > vendorAvailabilityMaximumMs) return invalid()
    }
    const responseTargetMinutes = v.responseTargetMinutes === null ? null : version(v.responseTargetMinutes)
    if (responseTargetMinutes !== null && responseTargetMinutes > 43_200) return invalid()
    return { name: boundedText(v.name, 1, 160), categories: choices(v.categories, serviceCategories, false),
      status: v.status as MaintenanceVendorDetails['status'], phone, email,
      serviceArea: boundedText(v.serviceArea, 1, 500), hours: boundedText(v.hours, 1, 500), emergencyCoverage: bool(v.emergencyCoverage),
      availability: v.availability as MaintenanceVendorDetails['availability'], availabilityObservedAt, availabilityValidUntil,
      expectedPricing: boundedText(v.expectedPricing, 0, 1000), responseTargetMinutes, preference: Number(v.preference),
      restrictions: boundedText(v.restrictions, 0, 1000), ...source(v, vendorReviewMaximumMs) }
  })
}
export function parsePlanDetails(input: unknown): MaintenancePlanDetails {
  return safe(() => {
    const v = exactObject(input, ['route', 'vendorId', 'vendorVersion', 'internalTeam', 'scopeOfWork', 'currency', 'maximumCents',
      'includesAllCharges', 'accessRequirement', 'restrictions', 'reason'])
    if (!['internal', 'vendor'].includes(v.route as string) || v.currency !== 'USD'
      || !['no_unit_entry', 'unit_entry'].includes(v.accessRequirement as string)) return invalid()
    const vendorId = v.vendorId === null ? null : id(v.vendorId)
    const vendorVersion = v.vendorVersion === null ? null : version(v.vendorVersion)
    const internalTeam = v.internalTeam === null ? null : boundedText(v.internalTeam, 1, 160)
    if (v.route === 'vendor' ? !vendorId || !vendorVersion || internalTeam !== null
      : vendorId !== null || vendorVersion !== null || !internalTeam) return invalid()
    return { route: v.route as MaintenancePlanDetails['route'], vendorId, vendorVersion, internalTeam,
      scopeOfWork: boundedText(v.scopeOfWork, 3, 4000), currency: 'USD', maximumCents: money(v.maximumCents),
      includesAllCharges: bool(v.includesAllCharges), accessRequirement: v.accessRequirement as MaintenancePlanDetails['accessRequirement'],
      restrictions: choices(v.restrictions, planRestrictions), reason: boundedText(v.reason, 3, 1000) }
  })
}
/** Current dates and permissions are deliberately checked under database locks. */
export function parsePlanningCommand(input: unknown): MaintenancePlanningCommand {
  return safe(() => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
    const action = (input as Record<string, unknown>).action
    if (action === 'publish_policy' || action === 'save_vendor') {
      const v = exactObject(input, ['action', 'requestId', 'expectedVersion', 'details', 'reason', ...(action === 'save_vendor' ? ['id'] : [])])
      const common = { requestId: id(v.requestId), expectedVersion: version(v.expectedVersion, true), reason: boundedText(v.reason, 3, 1000) }
      if (action === 'publish_policy') return { action, ...common, details: parsePolicyDetails(v.details) }
      const vendorId = v.id === null ? null : id(v.id)
      if ((vendorId === null) !== (common.expectedVersion === 0)) return invalid()
      return { action, ...common, id: vendorId, details: parseVendorDetails(v.details) }
    }
    if (action === 'prepare_plan') {
      const v = exactObject(input, ['action', 'requestId', 'caseId', 'expectedCaseVersion', 'expectedPlanVersion', 'policyVersion', 'details'])
      return { action, requestId: id(v.requestId), caseId: id(v.caseId), expectedCaseVersion: version(v.expectedCaseVersion),
        expectedPlanVersion: version(v.expectedPlanVersion, true), policyVersion: version(v.policyVersion), details: parsePlanDetails(v.details) }
    }
    if (action === 'decide_plan' || action === 'withdraw_plan') {
      const v = exactObject(input, ['action', 'requestId', 'caseId', 'planId', 'expectedPlanVersion', 'reason', ...(action === 'decide_plan' ? ['decision'] : [])])
      const common = { requestId: id(v.requestId), caseId: id(v.caseId), planId: id(v.planId), expectedPlanVersion: version(v.expectedPlanVersion), reason: boundedText(v.reason, 3, 1000) }
      if (action === 'withdraw_plan') return { action, ...common }
      if (v.decision !== 'approve' && v.decision !== 'reject') return invalid()
      return { action, ...common, decision: v.decision }
    }
    return invalid()
  })
}
