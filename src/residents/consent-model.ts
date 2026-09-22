import type { AuthenticatedUser, AuthorizedScope } from '../auth/model.ts'
import type { MfaFactor } from '../auth/mfa-model.ts'
import type { VerifiedConsentWebAuthn, ConsentWebAuthnClaim } from '../auth/consent-webauthn.ts'

/** Consent is for one exact job. It never authorizes a charge or provider effect. */
export type ConsentPurpose = 'work' | 'entry'
export interface ConsentSource { reference: string; version: string; observedAt: string; validUntil: string }
export interface ConsentPolicyDetails {
  enabled: boolean
  funding: 'property_no_resident_charge'
  recipientRule: 'reviewed_complete_roster'
  requireWorkConsent: boolean
  noChargeStatement: string
  recipientProtocol: string
  entryProtocol: string
  maximumResponseMinutes: number
  maximumConsentMinutes: number
  maximumEntryMinutes: number
  helpLabel: string
  helpPhone: string
  helpUrl: string | null
  emergencyInstructions: string
  source: ConsentSource
}
export interface ConsentPolicy extends ConsentPolicyDetails {
  organizationId: string; propertyId: string; version: number; publishedBy: string; publishedAt: string; current: boolean
}
export interface ConsentRosterMember {
  residentId: string
  residentVersion: number
  /** An empty set records a reviewed non-approver; it cannot waive a required purpose. */
  requiredPurposes: ConsentPurpose[]
}
export interface ConsentRosterDetails {
  unitId: string; members: ConsentRosterMember[]; source: ConsentSource; complete: true; protocolCompleted: true
}
export interface ConsentRoster extends ConsentRosterDetails {
  id: string; organizationId: string; propertyId: string; version: number; policyVersion: number
  /** Hash of the complete current property-local resident/source graph for this unit. */
  residencyDigest: string; reviewedBy: string; reviewedAt: string; current: boolean
}
export interface ConsentAuthorityDetails {
  bindingId: string; bindingVersion: number; residentId: string; residentVersion: number
  purpose: ConsentPurpose; source: ConsentSource; protocolCompleted: true
}
export interface ConsentAuthority extends ConsentAuthorityDetails {
  id: string; organizationId: string; propertyId: string; version: number; policyVersion: number
  userId: string; unitId: string; reviewedBy: string; reviewedAt: string; revokedAt: string | null; current: boolean
}
/** Explicit offset local timestamps must round-trip to these UTC instants in this IANA zone. */
export interface ConsentEntryWindow {
  startsAt: string; endsAt: string; startsLocal: string; endsLocal: string; timeZone: string
}
export interface ConsentPublicTerms {
  schemaVersion: 1
  purpose: ConsentPurpose
  propertyName: string
  unitId: string
  publicSummary: string
  /** Exact plan scope, explicitly reviewed for resident publication; no private planning reason. */
  scopeOfWork: string
  party: { kind: 'vendor'; id: string; version: number; name: string } | { kind: 'internal'; name: string }
  funding: 'property_no_resident_charge'
  currency: 'USD'
  propertyMaximumCents: number
  residentChargeCents: 0
  noChargeStatement: string
  accessRequirement: 'no_unit_entry' | 'unit_entry'
  entryWindow: ConsentEntryWindow | null
  conditions: string
}
export type ConsentHold = 'unconfigured' | 'not_required' | 'missing_plan' | 'spending_not_authorized' | 'emergency'
  | 'context_changed' | 'policy_changed' | 'roster_changed' | 'authority_changed' | 'binding_changed'
  | 'account_changed' | 'factor_revoked' | 'terms_changed' | 'request_withdrawn' | 'response_expired'
  | 'consent_expired' | 'entry_expired' | 'missing_entry_window' | 'missing_required_recipient'
  | 'awaiting_decisions' | 'declined' | 'revoked' | 'job_already_committed'
export interface ConsentEffectiveness {
  required: boolean
  effective: boolean
  holds: ConsentHold[]
  evaluatedAt: string
  refreshAt: string | null
  /** This slice never emits execution authority. */
  dispatchStatus: 'not_dispatched'
  notificationStatus: 'not_sent'
}
export interface ConsentRequest {
  id: string; organizationId: string; propertyId: string; caseId: string; purpose: ConsentPurpose; version: number
  caseVersion: number; planId: string; planVersion: number; configurationVersion: number
  maintenancePolicyVersion: number; consentPolicyVersion: number; rosterId: string; rosterVersion: number
  /** Shared across compatible purposes; entry-only timing is deliberately excluded. */
  materialDigest: string
  termsDigest: string
  terms: ConsentPublicTerms
  responseDeadline: string
  consentValidUntil: string
  publishedBy: string; publishedAt: string; createdAt: string; withdrawnAt: string | null
}
export interface ConsentRequiredRecipient {
  residentId: string; residentVersion: number; bindingId: string; bindingVersion: number
  userId: string; authorityId: string; authorityVersion: number; purpose: ConsentPurpose
}
export interface ConsentDecision {
  id: string; requestId: string; requestVersion: number; purpose: ConsentPurpose; version: number
  actorUserId: string; decision: 'grant' | 'decline' | 'revoke'; grantId: string | null
  termsDigest: string; decidedAt: string
}
export interface ConsentStaffPurpose {
  purpose: ConsentPurpose
  request: ConsentRequest | null
  recipients: Array<ConsentRequiredRecipient & { displayName: string; decision: ConsentDecision | null; holds: ConsentHold[] }>
  effectiveness: ConsentEffectiveness
}
export interface ConsentStaffState {
  organizationId: string; propertyId: string; configurationVersion: number; caseId: string; caseVersion: number
  unitId: string | null; timeZone: string
  policy: ConsentPolicy | null; roster: ConsentRoster | null; authorities: ConsentAuthority[]
  /** Only staff receive the candidate roster. No contact or credential fields. */
  residents: Array<{ id: string; version: number; displayName: string; unitId: string; contextState: string; bindingId: string | null; bindingVersion: number | null }>
  plan: { id: string; version: number; scopeOfWork: string; maximumCents: number | null; currency: 'USD'; accessRequirement: 'no_unit_entry' | 'unit_entry'; party: ConsentPublicTerms['party'] } | null
  purposes: [ConsentStaffPurpose, ConsentStaffPurpose]
  canPublishPolicy: boolean; canManageAuthority: boolean; canPublishRequest: boolean
  help: ConsentHelp | null
}
export interface ConsentHelp { label: string; phone: string; url: string | null; emergencyInstructions: string }
/** Does not reveal another recipient, private source evidence, or staff-only case/plan content. */
export interface ResidentConsentDetail {
  requestId: string; requestVersion: number; purpose: ConsentPurpose
  termsDigest: string; materialDigest: string; terms: ConsentPublicTerms
  responseDeadline: string; consentValidUntil: string; publishedAt: string; withdrawnAt: string | null
  ownDecision: ConsentDecision | null
  ownDecisionVersion: number
  effectiveness: ConsentEffectiveness
  canGrant: boolean; canDecline: boolean; canRevoke: boolean
  requiresPasskey: boolean
  /** False prohibits disclosure of a newly revised request, while own saved history remains available. */
  currentTerms: boolean
  help: ConsentHelp | null
}
export interface ResidentConsentSummary {
  requestId: string; requestVersion: number; purpose: ConsentPurpose; propertyName: string; unitId: string
  publicSummary: string; responseDeadline: string; consentValidUntil: string; publishedAt: string
  ownDecision: 'grant' | 'decline' | 'revoke' | null; effective: boolean; holds: ConsentHold[]; currentTerms: boolean
}
export interface ConsentCursor { createdAt: string; id: string }
export interface ConsentListQuery { limit: number; before?: ConsentCursor }
export interface ResidentConsentPage { items: ResidentConsentSummary[]; nextCursor: ConsentCursor | null; evaluatedAt: string; refreshAt: string | null }
export interface ConsentHistoryEntry {
  id: string; requestId: string; requestVersion: number; purpose: ConsentPurpose
  kind: 'published' | 'withdrawn' | 'grant' | 'decline' | 'revoke'; createdAt: string
  /** Resident history contains only the acting resident's decisions and their published terms. */
  decision: ConsentDecision | null; termsDigest: string; terms: ConsentPublicTerms
}
export interface ConsentHistoryPage { items: ConsentHistoryEntry[]; nextCursor: ConsentCursor | null }
export type ConsentStaffCommand =
 | { action: 'publish_policy'; commandId: string; expectedVersion: number; details: ConsentPolicyDetails; reason: string }
 | { action: 'publish_roster'; commandId: string; expectedVersion: number; policyVersion: number; details: ConsentRosterDetails; reason: string }
 | { action: 'save_authority'; commandId: string; id: string | null; expectedVersion: number; policyVersion: number; details: ConsentAuthorityDetails; reason: string }
 | { action: 'revoke_authority'; commandId: string; id: string; expectedVersion: number; reason: string }
 | { action: 'publish_request'; commandId: string; caseId: string; expectedCaseVersion: number; planId: string; planVersion: number; purpose: ConsentPurpose;
     expectedVersion: number; consentPolicyVersion: number; rosterId: string; rosterVersion: number;
     publicSummary: string; conditions: string; funding: 'property_no_resident_charge'; reviewedAgainstPlan: true;
     responseDeadline: string; consentValidUntil: string; entryWindow: ConsentEntryWindow | null; reason: string }
 | { action: 'withdraw_request'; commandId: string; requestId: string; expectedVersion: number; reason: string }
export interface ConsentGrantCommand {
  action: 'grant'; commandId: string; requestId: string; requestVersion: number; expectedDecisionVersion: number
  purpose: ConsentPurpose; termsDigest: string; materialDigest: string
}
export type ConsentOwnCommand =
 | { action: 'decline'; commandId: string; requestId: string; requestVersion: number; expectedDecisionVersion: number; purpose: ConsentPurpose; termsDigest: string }
 | { action: 'revoke'; commandId: string; requestId: string; requestVersion: number; expectedDecisionVersion: number; purpose: ConsentPurpose; grantId: string }
export interface ConsentReceipt {
  commandId: string
  action: ConsentStaffCommand['action'] | ConsentGrantCommand['action'] | ConsentOwnCommand['action']
  resource: 'policy' | 'roster' | 'authority' | 'request' | 'decision'
  id: string; version: number; requestId: string | null; requestVersion: number | null; purpose: ConsentPurpose | null
  actorUserId: string; committedAt: string; replayed: boolean
  /** Historical commitment only; callers separately reload current effectiveness. */
  outcome: 'saved'
}
export interface ConsentCeremonyStart extends ConsentGrantCommand { challengeId: string; challengeHash: string; expiresAt: number }
export interface ConsentCeremony {
  id: string; userId: string; sessionId: string; credentialVersion: number; securityVersion: number
  origin: string; rpId: string; challengeHash: string; expiresAt: number; userHandle: string
  organizationId: string; propertyId: string
  command: ConsentGrantCommand
  factors: MfaFactor[]
}
/** Exact crypto input belongs to the independently branded verifier contract. */
export type ConsentCeremonyClaim = ConsentWebAuthnClaim
export interface ResidentConsentRepository {
  staffState(scope: AuthorizedScope, configurationVersion: number, caseId: string): Promise<ConsentStaffState>
  staffHistory(scope: AuthorizedScope, configurationVersion: number, expectedCaseId: string, requestId: string, query: ConsentListQuery): Promise<ConsentHistoryPage>
  executeStaff(scope: AuthorizedScope, configurationVersion: number, expectedCaseId: string, proofId: string | null, command: ConsentStaffCommand): Promise<ConsentReceipt>
  staffReceipt(scope: AuthorizedScope, configurationVersion: number, expectedCaseId: string, commandId: string): Promise<ConsentReceipt | null>
  listOwn(principal: AuthenticatedUser, query: ConsentListQuery): Promise<ResidentConsentPage>
  getOwn(principal: AuthenticatedUser, requestId: string): Promise<ResidentConsentDetail | null>
  ownHistory(principal: AuthenticatedUser, requestId: string, query: ConsentListQuery): Promise<ConsentHistoryPage>
  ownReceipt(principal: AuthenticatedUser, commandId: string): Promise<ConsentReceipt | null>
  beginGrant(principal: AuthenticatedUser, input: ConsentCeremonyStart): Promise<ConsentCeremony>
  claimGrant(principal: AuthenticatedUser, input: { challengeId: string; attemptId: string; responseDigest: string; credentialId: string }): Promise<ConsentCeremonyClaim>
  finishGrant(principal: AuthenticatedUser, verified: VerifiedConsentWebAuthn): Promise<ConsentReceipt>
  rejectGrant(principal: AuthenticatedUser, claim: ConsentCeremonyClaim): Promise<void>
  decideOwn(principal: AuthenticatedUser, command: ConsentOwnCommand): Promise<ConsentReceipt>
}
export type ConsentErrorCode = 'consent_invalid_input' | 'consent_unauthenticated' | 'consent_forbidden' | 'consent_not_found'
 | 'consent_changed' | 'consent_request_conflict' | 'consent_held' | 'consent_passkey_required' | 'consent_ceremony_used'
 | 'consent_rate_limited' | 'consent_unavailable'
export class ConsentError extends Error {
  readonly code: ConsentErrorCode
  readonly status: number
  constructor(code: ConsentErrorCode) {
    const messages: Record<ConsentErrorCode,string> = {
      consent_invalid_input:'Review the consent details and try again.', consent_unauthenticated:'Sign in again to continue.',
      consent_forbidden:'Your current access does not permit this operation.', consent_not_found:'This consent request is unavailable.',
      consent_changed:'The consent or authority changed. Reload and review the current details.',
      consent_request_conflict:'This operation was saved with different details. Check its receipt.',
      consent_held:'Current authority or terms do not permit this consent.', consent_passkey_required:'Verify this exact decision with your passkey.',
      consent_ceremony_used:'This verification is no longer available. Check the saved result before starting again.',
      consent_rate_limited:'Too many verification attempts. Wait before trying again.',
      consent_unavailable:'The result could not be confirmed. Reload and check its receipt before trying again.',
    }
    super(messages[code]); this.code=code
    this.status=code==='consent_invalid_input'?400:code==='consent_unauthenticated'?401:code==='consent_forbidden'?403
      :code==='consent_not_found'?404:code==='consent_rate_limited'?429:code==='consent_unavailable'?503:409
  }
}
