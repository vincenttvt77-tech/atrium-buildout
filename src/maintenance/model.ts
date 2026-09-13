import type { EmergencyKind } from '../escalation/emergency.ts'
import type { ResidentCommand, ResidentContext, ResidentRecord } from '../residents/model.ts'

export type ServiceCategory = 'plumbing' | 'electrical' | 'heating_cooling' | 'appliance' | 'pest' | 'access' | 'other'
export type ServicePriority = 'routine' | 'urgent' | 'emergency'
export type ServiceState = 'needs_triage' | 'waiting_information' | 'management_review' | 'ready_for_planning' | 'emergency_review'
export type ServiceLocation = { kind: 'unit'; unitId: string }
  | { kind: 'common_area'; label: string } | { kind: 'unknown'; label: string }

export interface ServiceIntake {
  requestOrigin: 'resident_report' | 'staff_observation' | 'unknown'
  location: ServiceLocation
  residentId: string | null
  summary: string
  description: string
  category: ServiceCategory
  reportedPriority: ServicePriority
  reporterName: string | null
  reporterPhone: string | null
  reporterEmail: string | null
  /** A reported instruction is not permission to enter a residence. */
  accessNotes: string
}

export interface ServiceCase extends ServiceIntake {
  id: string
  organizationId: string
  propertyId: string
  version: number
  state: ServiceState
  priority: ServicePriority
  emergencyKinds: EmergencyKind[]
  createdAt: string
  updatedAt: string
  createdBy: string
  /** Original intake stays immutable when staff clarifies current location or occupancy. */
  intakeLocation: ServiceLocation
  residentIdAtIntake: string | null
  residentVersionAtIntake: number | null
  /** Original reviewed context is preserved; current authority is read separately. */
  residentNameAtIntake: string | null
  /** Derived at read time; source expiry/revocation does not rewrite historical triage. */
  contextNeedsReview: boolean
  dispatchStatus: 'not_dispatched'
  notificationStatus: 'not_sent'
  callerIdentityVerified: false
  entryAuthorized: false
}

export interface ServiceEvent {
  id: string
  caseId: string
  caseVersion: number
  kind: 'intake' | 'note' | 'triage' | 'context'
  actorUserId: string
  createdAt: string
  note: string
  state: ServiceState
  priority: ServicePriority
  contextLocation: ServiceLocation
  contextResidentId: string | null
  contextResidentVersion: number | null
  contextResidentName: string | null
}

export interface CreateServiceCommand { action: 'create_request'; requestId: string; intake: ServiceIntake }
export interface NoteServiceCommand { action: 'add_note'; requestId: string; id: string; expectedVersion: number; note: string }
export interface UpdateServiceContextCommand {
  action: 'update_context'
  requestId: string
  id: string
  expectedVersion: number
  location: ServiceLocation
  residentId: string | null
  note: string
}
export interface TriageServiceCommand {
  action: 'triage_request'
  requestId: string
  id: string
  expectedVersion: number
  state: 'waiting_information' | 'management_review' | 'ready_for_planning'
  priority: 'routine' | 'urgent'
  note: string
}
export type ServiceCommand = ResidentCommand | CreateServiceCommand | NoteServiceCommand | UpdateServiceContextCommand | TriageServiceCommand

export interface ServiceCursor { createdAt: string; id: string }
export interface ServiceListQuery { limit: number; before?: ServiceCursor; unitId?: string }
export interface ResidentListQuery extends ServiceListQuery { status?: 'active' | 'revoked' }
export interface CaseListQuery extends ServiceListQuery { states?: ServiceState[]; includeContextReview?: boolean }
export interface ServiceCaseDetail {
  request: ServiceCase
  resident: ResidentContext
  events: ServiceEvent[]
  eventsTruncated: boolean
  nextEventsCursor: ServiceCursor | null
  related: Pick<ServiceCase, 'id' | 'summary' | 'state' | 'priority' | 'createdAt'>[]
  relatedTruncated: boolean
}
export interface ServiceReceipt {
  requestId: string
  action: ServiceCommand['action']
  resource: 'resident' | 'request'
  id: string
  version: number
  committedAt: string
  replayed: boolean
}

export interface ResidentServicesRepository {
  listResidents(query: ResidentListQuery): Promise<ResidentRecord[]>
  getResident(id: string): Promise<ResidentRecord | null>
  listCases(query: CaseListQuery): Promise<ServiceCase[]>
  getCase(id: string): Promise<ServiceCaseDetail | null>
  listEvents(id: string, query: ServiceListQuery): Promise<ServiceEvent[]>
  execute(command: ServiceCommand): Promise<ServiceReceipt>
}

export type ServiceErrorCode = 'service_invalid_input' | 'service_not_found' | 'service_version_conflict'
  | 'service_request_conflict' | 'service_context_required' | 'service_emergency_hold' | 'service_unavailable'
export class ServiceError extends Error {
  readonly code: ServiceErrorCode
  constructor(code: ServiceErrorCode, message: string) { super(message); this.code = code }
}
