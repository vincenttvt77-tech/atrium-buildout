import { MaintenancePlanningError } from './planning-model.ts'
import type { ConsentHold, ConsentPurpose } from '../residents/consent-model.ts'
import { recordId, isoTimestamp } from '../residents/validation.ts'

export interface MaintenanceConsentPurpose {
  purpose: ConsentPurpose
  requestId: string | null
  requestVersion: number | null
  materialDigest: string | null
  required: boolean
  effective: boolean
  holds: ConsentHold[]
  refreshAt: string | null
}
/** Minimal scoped read projection. It contains no recipient or credential directory. */
export interface MaintenanceConsentEvidence {
  caseId: string
  caseVersion: number
  planId: string | null
  planVersion: number | null
  configurationVersion: number
  materialDigest: string | null
  revision: string
  purposes: [MaintenanceConsentPurpose, MaintenanceConsentPurpose]
  refreshAt: string | null
}
const holds: readonly ConsentHold[] = ['unconfigured','not_required','missing_plan','spending_not_authorized','emergency',
  'context_changed','policy_changed','roster_changed','authority_changed','binding_changed','account_changed','factor_revoked',
  'terms_changed','request_withdrawn','response_expired','consent_expired','entry_expired','missing_entry_window',
  'missing_required_recipient','awaiting_decisions','declined','revoked','job_already_committed']
const bad = (): never => { throw new MaintenancePlanningError('planning_unavailable', 'The current resident permission evidence could not be verified.') }
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const version = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const object = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== keys.sort().join(',')) return bad()
  return v as Record<string, unknown>
}
const timestamp = (v: unknown): string | null => {
  if (v === null) return null
  try { return isoTimestamp(v) } catch { return bad() }
}
function readPurpose(value: unknown): MaintenanceConsentPurpose {
  const v = object(value, ['purpose','requestId','requestVersion','materialDigest','required','effective','holds','refreshAt'])
  if (!['work','entry'].includes(String(v.purpose)) || typeof v.required !== 'boolean' || typeof v.effective !== 'boolean'
    || !Array.isArray(v.holds) || v.holds.length > holds.length || v.holds.some(item => !holds.includes(item))
    || new Set(v.holds).size !== v.holds.length) return bad()
  if (v.requestId === null ? v.requestVersion !== null || v.materialDigest !== null
    : !recordId(v.requestId) || !version(v.requestVersion) || !digest(v.materialDigest)) return bad()
  const refreshAt = timestamp(v.refreshAt)
  if (v.effective && (!v.required || v.holds.length || v.requestId === null || refreshAt === null)) return bad()
  return { purpose: v.purpose as ConsentPurpose, requestId: v.requestId as string | null,
    requestVersion: v.requestVersion as number | null, materialDigest: v.materialDigest as string | null,
    required: v.required, effective: v.effective, holds: [...v.holds] as ConsentHold[], refreshAt }
}
export function readMaintenanceConsentGraph(value: unknown, caseIds: string[], configurationVersion: number): Map<string, MaintenanceConsentEvidence> {
  if (!Array.isArray(value) || caseIds.length > 201 || new Set(caseIds).size !== caseIds.length
    || value.length !== caseIds.length || !version(configurationVersion)) return bad()
  const result = new Map<string, MaintenanceConsentEvidence>()
  for (const raw of value) {
    const v = object(raw, ['caseId','caseVersion','planId','planVersion','configurationVersion','materialDigest','revision','purposes','refreshAt'])
    if (!recordId(v.caseId) || !caseIds.includes(v.caseId) || result.has(v.caseId) || !version(v.caseVersion)
      || v.configurationVersion !== configurationVersion || !digest(v.revision)
      || !(v.materialDigest === null || digest(v.materialDigest))
      || (v.planId === null ? v.planVersion !== null || v.materialDigest !== null : !recordId(v.planId) || !version(v.planVersion))
      || !Array.isArray(v.purposes) || v.purposes.length !== 2) return bad()
    const purposes = v.purposes.map(readPurpose).sort((a,b) => a.purpose === b.purpose ? 0 : a.purpose === 'work' ? -1 : 1)
    if (purposes[0]!.purpose !== 'work' || purposes[1]!.purpose !== 'entry') return bad()
    const refreshAt = timestamp(v.refreshAt)
    const boundaries = purposes.flatMap(p => p.refreshAt === null ? [] : [p.refreshAt])
    if (boundaries.length && (refreshAt === null || refreshAt > boundaries.sort()[0]!)) return bad()
    result.set(v.caseId, { caseId: v.caseId, caseVersion: v.caseVersion, planId: v.planId as string | null,
      planVersion: v.planVersion as number | null, configurationVersion, materialDigest: v.materialDigest as string | null,
      revision: v.revision, purposes: purposes as [MaintenanceConsentPurpose, MaintenanceConsentPurpose], refreshAt })
  }
  return result
}

export interface MaintenanceConsentRequirements {
  caseId: string; caseVersion: number; planId: string; planVersion: number; configurationVersion: number
  workRequired: boolean; entryRequired: boolean
}
export function projectPlanConsent(required: MaintenanceConsentRequirements, evidence: MaintenanceConsentEvidence | undefined, now: Date) {
  const work = evidence?.purposes.find(value => value.purpose === 'work'), entry = evidence?.purposes.find(value => value.purpose === 'entry')
  const residentApprovalRequired = required.workRequired || work?.required === true
  const entryPermissionRequired = required.entryRequired
  const current = !!evidence && evidence.caseId === required.caseId && evidence.caseVersion === required.caseVersion
    && evidence.planId === required.planId && evidence.planVersion === required.planVersion
    && evidence.configurationVersion === required.configurationVersion && digest(evidence.revision)
    && (evidence.refreshAt === null || Date.parse(evidence.refreshAt) > now.getTime())
  const effective = (purpose: MaintenanceConsentPurpose | undefined) => current && !!purpose && purpose.required
    && purpose.effective && purpose.holds.length === 0 && recordId(purpose.requestId) && version(purpose.requestVersion)
    && digest(evidence!.materialDigest) && purpose.materialDigest === evidence!.materialDigest
    && purpose.refreshAt !== null && Date.parse(purpose.refreshAt) > now.getTime()
  const residentApprovalVerified = residentApprovalRequired && effective(work)
  const entryAuthorized = entryPermissionRequired && effective(entry)
  return { residentApprovalRequired, residentApprovalVerified, entryPermissionRequired, entryAuthorized,
    needsReview: residentApprovalRequired && !residentApprovalVerified || entryPermissionRequired && !entryAuthorized
      || !!evidence && (!current || entry?.required !== entryPermissionRequired) }
}
