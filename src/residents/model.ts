/** Organizational person IDs do not imply a caller identity or household authority. */
export interface ResidentSource {
  kind: 'staff_review'
  reference: string
  version: string
  observedAt: string
  validUntil: string
}

/** Personal/contact observations belong to this property relationship only. */
export interface ResidentDetails {
  unitId: string
  displayName: string
  relationship: 'leaseholder' | 'occupant'
  /** Property-local dates; end is exclusive, and null means no known end. */
  startsOn: string
  endsOn: string | null
  phone: string | null
  email: string | null
  source: ResidentSource
}

export interface ResidentRecord extends ResidentDetails {
  id: string
  personId: string
  organizationId: string
  propertyId: string
  status: 'active' | 'revoked'
  version: number
  createdAt: string
  updatedAt: string
  reviewedBy: string
  reviewedAt: string
  contextState: Exclude<ResidentContextState, 'not_established'>
}

export type ResidentContextState = 'current' | 'expired' | 'revoked' | 'not_started' | 'ended' | 'not_established'
export interface ResidentContext {
  state: ResidentContextState
  residentId: string | null
  residentVersion: number | null
  displayName: string | null
  unitId: string | null
  /** Occupancy evidence never verifies the person on an incoming channel. */
  callerIdentityVerified: false
  entryAuthorized: false
}

export interface AddResidentCommand {
  action: 'add_resident'
  requestId: string
  details: ResidentDetails
  reason: string
}
export interface ReviewResidentCommand {
  action: 'review_resident'
  requestId: string
  id: string
  expectedVersion: number
  /** Unit and person ownership are immutable. Moving requires a new relationship. */
  details: Omit<ResidentDetails, 'unitId'>
  reason: string
}
export interface RevokeResidentCommand {
  action: 'revoke_resident'
  requestId: string
  id: string
  expectedVersion: number
  reason: string
}
export type ResidentCommand = AddResidentCommand | ReviewResidentCommand | RevokeResidentCommand
