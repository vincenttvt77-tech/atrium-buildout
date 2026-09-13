import { ServiceError } from './model.ts'
import type { ServiceCommand, ServiceIntake, ServiceLocation, ServiceListQuery, ServiceState, ResidentListQuery, CaseListQuery } from './model.ts'
import { exactObject, boundedText, recordId, isoTimestamp, contactPhone, contactEmail,
  parseResidentDetails, parseResidentReviewDetails } from '../residents/validation.ts'

const invalid = (): never => { throw new ServiceError('service_invalid_input', 'Review the service request and enter valid, complete details.') }
const safe = <T>(read: () => T): T => { try { return read() } catch { return invalid() } }
const id = (value: unknown): string => recordId(value) ? value : invalid()
const version = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : invalid()
const optionalText = (value: unknown, max: number) => value === null ? null : boundedText(value, 1, max)
export const serviceStates: readonly ServiceState[] = ['needs_triage', 'waiting_information', 'management_review', 'ready_for_planning', 'emergency_review']
export const serviceCategories = ['plumbing', 'electrical', 'heating_cooling', 'appliance', 'pest', 'access', 'other'] as const
function location(input: unknown): ServiceLocation {
  if (!input || typeof input !== 'object') return invalid()
  const kind = (input as Record<string, unknown>).kind
  if (kind === 'unit') {
    const value = exactObject(input, ['kind', 'unitId'])
    return { kind, unitId: id(value.unitId) }
  }
  if (kind !== 'common_area' && kind !== 'unknown') return invalid()
  const value = exactObject(input, ['kind', 'label'])
  return { kind, label: boundedText(value.label, 1, 160) }
}
function intake(input: unknown): ServiceIntake {
  const value = exactObject(input, ['requestOrigin', 'location', 'residentId', 'summary', 'description', 'category', 'reportedPriority',
    'reporterName', 'reporterPhone', 'reporterEmail', 'accessNotes'])
  if (!serviceCategories.includes(value.category as ServiceIntake['category'])
    || !['routine', 'urgent', 'emergency'].includes(value.reportedPriority as string)
    || !['resident_report', 'staff_observation', 'unknown'].includes(value.requestOrigin as string)) return invalid()
  const selected = location(value.location), residentId = value.residentId === null ? null : id(value.residentId)
  if (residentId !== null && selected.kind !== 'unit') return invalid()
  return { requestOrigin: value.requestOrigin as ServiceIntake['requestOrigin'], location: selected, residentId, summary: boundedText(value.summary, 3, 160),
    description: boundedText(value.description, 0, 4000), category: value.category as ServiceIntake['category'],
    reportedPriority: value.reportedPriority as ServiceIntake['reportedPriority'], reporterName: optionalText(value.reporterName, 120),
    reporterPhone: contactPhone(value.reporterPhone), reporterEmail: contactEmail(value.reporterEmail),
    accessNotes: boundedText(value.accessNotes, 0, 1000) }
}

/** Structural validation is replay-stable; database time decides current evidence. */
export function parseServiceCommand(input: unknown): ServiceCommand {
  return safe(() => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
    const action = (input as Record<string, unknown>).action
    if (action === 'add_resident') {
      const value = exactObject(input, ['action', 'requestId', 'details', 'reason'])
      return { action, requestId: id(value.requestId), details: parseResidentDetails(value.details), reason: boundedText(value.reason, 3, 1000) }
    }
    if (action === 'review_resident') {
      const value = exactObject(input, ['action', 'requestId', 'id', 'expectedVersion', 'details', 'reason'])
      return { action, requestId: id(value.requestId), id: id(value.id), expectedVersion: version(value.expectedVersion),
        details: parseResidentReviewDetails(value.details), reason: boundedText(value.reason, 3, 1000) }
    }
    if (action === 'revoke_resident') {
      const value = exactObject(input, ['action', 'requestId', 'id', 'expectedVersion', 'reason'])
      return { action, requestId: id(value.requestId), id: id(value.id), expectedVersion: version(value.expectedVersion), reason: boundedText(value.reason, 3, 1000) }
    }
    if (action === 'create_request') {
      const value = exactObject(input, ['action', 'requestId', 'intake'])
      return { action, requestId: id(value.requestId), intake: intake(value.intake) }
    }
    if (action === 'add_note') {
      const value = exactObject(input, ['action', 'requestId', 'id', 'expectedVersion', 'note'])
      return { action, requestId: id(value.requestId), id: id(value.id), expectedVersion: version(value.expectedVersion), note: boundedText(value.note, 3, 4000) }
    }
    if (action === 'update_context') {
      const value = exactObject(input, ['action', 'requestId', 'id', 'expectedVersion', 'location', 'residentId', 'note'])
      const selected = location(value.location), residentId = value.residentId === null ? null : id(value.residentId)
      if (residentId !== null && selected.kind !== 'unit') return invalid()
      return { action, requestId: id(value.requestId), id: id(value.id), expectedVersion: version(value.expectedVersion),
        location: selected, residentId, note: boundedText(value.note, 3, 4000) }
    }
    if (action === 'triage_request') {
      const value = exactObject(input, ['action', 'requestId', 'id', 'expectedVersion', 'note', 'state', 'priority'])
      if (!['waiting_information', 'management_review', 'ready_for_planning'].includes(value.state as string)
        || !['routine', 'urgent'].includes(value.priority as string)) return invalid()
      return { action, requestId: id(value.requestId), id: id(value.id), expectedVersion: version(value.expectedVersion),
        note: boundedText(value.note, 3, 4000), state: value.state as 'waiting_information' | 'management_review' | 'ready_for_planning',
        priority: value.priority as 'routine' | 'urgent' }
    }
    return invalid()
  })
}

export function validateServiceListQuery(input: unknown, kind: 'residents' | 'cases' | 'events' = 'cases'): ResidentListQuery & CaseListQuery {
  return safe(() => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
    const value = input as Record<string, unknown>
    const allowed = ['limit', 'before', ...(kind === 'events' ? [] : ['unitId', ...(kind === 'residents' ? ['status'] : ['states', 'includeContextReview'])])]
    if (Object.keys(value).some(key => !allowed.includes(key))
      || !Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 101) return invalid()
    const result: ResidentListQuery & CaseListQuery = { limit: Number(value.limit) }
    if (value.before !== undefined) {
      const cursor = exactObject(value.before, ['createdAt', 'id'])
      if (typeof cursor.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(cursor.id)) return invalid()
      result.before = { createdAt: isoTimestamp(cursor.createdAt), id: id(cursor.id) }
    }
    if (value.unitId !== undefined) result.unitId = id(value.unitId)
    if (value.includeContextReview !== undefined) {
      if (typeof value.includeContextReview !== 'boolean') return invalid()
      result.includeContextReview = value.includeContextReview
    }
    if (value.status !== undefined) {
      if (value.status !== 'active' && value.status !== 'revoked') return invalid()
      result.status = value.status
    }
    if (value.states !== undefined) {
      if (!Array.isArray(value.states) || value.states.length < 1 || value.states.length > serviceStates.length
        || value.states.some(state => !serviceStates.includes(state)) || new Set(value.states).size !== value.states.length) return invalid()
      const selected = value.states
      result.states = serviceStates.filter(state => selected.includes(state))
    }
    return result
  })
}
