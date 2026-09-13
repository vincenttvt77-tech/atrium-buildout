import type { AuthenticatedUser, AuthorizedScope } from '../auth/model.ts'

/** A configured human recipient check establishes enrollment; it is not work/entry consent. */
export interface EnrollmentPolicyDetails {
  enabled: boolean
  method: 'in_person_staff_check'
  protocol: string
  invitationLifetimeMinutes: number
  sourceReference: string
  observedAt: string
  validUntil: string
}
export interface EnrollmentPolicy extends EnrollmentPolicyDetails {
  organizationId: string
  propertyId: string
  version: number
  publishedBy: string
  publishedAt: string
  current: boolean
}
export interface EnrollmentInvitation {
  id: string
  version: number
  organizationId: string
  propertyId: string
  residentId: string
  residentVersion: number
  policyVersion: number
  configurationVersion: number
  state: 'pending' | 'expired' | 'revoked' | 'consumed' | 'stale'
  createdAt: string
  expiresAt: string
  checkedAt: string
  checkedBy: string
  evidenceReference: string
  /** The software prepares a handoff link; it does not send a message. */
  deliveryStatus: 'not_sent'
}
export type ResidentBindingState = 'current' | 'revoked' | 'policy_changed' | 'context_changed' | 'account_unavailable'
export interface ResidentAccountBinding {
  id: string
  version: number
  organizationId: string
  propertyId: string
  residentId: string
  residentVersion: number
  policyVersion: number
  userId: string
  invitationId: string
  unitId: string
  activatedAt: string
  revokedAt: string | null
  state: ResidentBindingState
}
export interface EnrollmentStaffState {
  policy: EnrollmentPolicy | null
  resident: { id: string; version: number; displayName: string; unitId: string; contextState: string }
  invitation: EnrollmentInvitation | null
  binding: ResidentAccountBinding | null
  canManage: boolean
}
export type EnrollmentStaffCommand = {
  action: 'publish_policy'
  requestId: string
  expectedVersion: number | null
  details: EnrollmentPolicyDetails
  reason: string
} | {
  action: 'issue_invitation'
  requestId: string
  residentId: string
  expectedResidentVersion: number
  expectedPolicyVersion: number
  /** An explicit replacement revokes this exact prior invitation atomically. */
  replaces: { id: string; version: number } | null
  checkedAt: string
  evidenceReference: string
  protocolCompleted: true
  reason: string
} | {
  action: 'revoke_invitation' | 'revoke_binding'
  requestId: string
  id: string
  expectedVersion: number
  reason: string
}
export interface EnrollmentStaffReceipt {
  action: EnrollmentStaffCommand['action']
  requestId: string
  organizationId: string
  propertyId: string
  actorUserId: string
  id: string
  version: number
  residentId: string | null
  recordedAt: string
  replayed: boolean
}
/** Minimal capability preview; no contact details, staff notes or evidence reference. */
export interface EnrollmentPreview {
  invitationId: string
  invitationVersion: number
  propertyName: string
  unitId: string
  recipientHint: string
  expiresAt: string
}
export interface EnrollmentAcceptanceReceipt {
  requestId: string
  invitationId: string
  bindingId: string
  bindingVersion: number
  organizationId: string
  propertyId: string
  residentId: string
  userId: string
  activatedAt: string
  replayed: boolean
}
export interface OwnResidentBinding extends ResidentAccountBinding { propertyName: string }
export interface OwnResidentBindings {
  items: OwnResidentBinding[]
  nextId: string | null
}
/** Server-only reservation. Never serialize its digest or credential hash into an API response. */
export interface EnrollmentReservation {
  id: string
  requestId: string
  tokenHash: string
  browserHash: string
  mode: 'new' | 'existing'
  invitationId: string
  invitationVersion: number
  userId: string
  username: string
  displayName: string
  credentialVersion: number
  sessionId: string | null
  passwordHash: string | null
  expiresAt: string
  completedReceipt: EnrollmentAcceptanceReceipt | null
}
export interface EnrollmentReservationInput {
  requestId: string
  tokenHash: string
  browserHash: string
  clientKey: string
  mode: 'new' | 'existing'
  expectedInvitationVersion: number
  username: string
  displayName: string
}
export interface ResidentEnrollmentRepository {
  staffState(scope: AuthorizedScope, configurationVersion: number, residentId: string): Promise<EnrollmentStaffState>
  executeStaff(scope: AuthorizedScope, configurationVersion: number, proofId: string, command: EnrollmentStaffCommand,
    material?: { id: string; tokenHash: string }): Promise<EnrollmentStaffReceipt>
  staffReceipt(scope: AuthorizedScope, configurationVersion: number, requestId: string): Promise<EnrollmentStaffReceipt | null>
  preview(tokenHash: string): Promise<EnrollmentPreview | null>
  reserveAcceptance(principal: AuthenticatedUser | null, input: EnrollmentReservationInput): Promise<EnrollmentReservation>
  acceptNew(reservation: EnrollmentReservation, credentials: { passwordHash: string }): Promise<EnrollmentAcceptanceReceipt>
  acceptExisting(principal: AuthenticatedUser, reservation: EnrollmentReservation): Promise<EnrollmentAcceptanceReceipt>
  ownBindings(principal: AuthenticatedUser, query: { limit: number; afterId?: string }): Promise<OwnResidentBindings>
  ownReceipt(principal: AuthenticatedUser, requestId: string): Promise<EnrollmentAcceptanceReceipt | null>
}
export type EnrollmentErrorCode = 'enrollment_invalid_input' | 'enrollment_unavailable' | 'enrollment_unauthenticated'
  | 'enrollment_forbidden' | 'enrollment_changed' | 'enrollment_invitation_unavailable' | 'enrollment_username_unavailable'
  | 'enrollment_request_conflict' | 'enrollment_rate_limited' | 'enrollment_reconcile_required' | 'enrollment_password_incorrect'
export class EnrollmentError extends Error {
  readonly code: EnrollmentErrorCode
  readonly status: number
  constructor(code: EnrollmentErrorCode) {
    const messages: Record<EnrollmentErrorCode, string> = {
      enrollment_invalid_input: 'Review the enrollment details and try again.',
      enrollment_unavailable: 'This operation could not be confirmed. Reload to check before trying again.',
      enrollment_unauthenticated: 'Sign in again before continuing.',
      enrollment_forbidden: 'Your current access does not permit this operation.',
      enrollment_changed: 'The enrollment details changed. Reload and review them again.',
      enrollment_invitation_unavailable: 'This invitation is unavailable. Sign in to check existing access or ask your property team for a new invitation.',
      enrollment_username_unavailable: 'That username is unavailable. Choose another or sign in to your existing account.',
      enrollment_request_conflict: 'This operation has different saved details. Reload to check its result.',
      enrollment_rate_limited: 'Too many attempts. Wait before trying again.',
      enrollment_reconcile_required: 'Your account or access may already be activated. Sign in to check before trying again.',
      enrollment_password_incorrect: 'The password could not be verified. Review it and try again.',
    }
    super(messages[code]); this.code = code
    this.status = code === 'enrollment_unauthenticated' ? 401 : code === 'enrollment_forbidden' ? 403
      : code === 'enrollment_rate_limited' ? 429 : code === 'enrollment_unavailable' ? 503
        : ['enrollment_changed','enrollment_request_conflict','enrollment_username_unavailable','enrollment_reconcile_required'].includes(code) ? 409
          : code === 'enrollment_invitation_unavailable' ? 410 : 400
  }
}
