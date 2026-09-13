import type { AuthenticatedUser } from './model.ts'

export type MfaPurpose = 'session_login' | 'organization_administration' | 'manage_factors'
export type MfaIntent = 'bootstrap' | 'add_factor' | 'recover_factor' | 'verify'
export interface MfaConfiguration { readonly origin: string; readonly rpId: string; readonly rpName: string }
export interface MfaFactor {
  id: string; label: string; credentialId: string; publicKey: string; counter: number; counterRevision: number
  status: 'pending' | 'active'; backupEligible: boolean; backedUp: boolean
  transports: string[]; createdAt: number; lastUsedAt: number | null
}
export interface MfaAssurance {
  id: string; userId: string; sessionId: string; credentialVersion: number; securityVersion: number
  factorId: string; purpose: MfaPurpose; verifiedAt: number; expiresAt: number
}
export interface MfaState {
  userId: string; sessionId: string; credentialVersion: number; securityVersion: number
  userHandle: string; everEnabled: boolean; required: boolean; factors: MfaFactor[]
  assurances: MfaAssurance[]; recoveryRemaining: number
}
export interface MfaPasswordReservation {
  id: string; userId: string; sessionId: string; credentialVersion: number; securityVersion: number
  passwordHash: string; expiresAt: number
}
/** Runtime-issued only by the actual password verifier; never deserialize from HTTP. */
export interface MfaPasswordVerification { readonly reservation: Readonly<MfaPasswordReservation> }
export interface MfaReauthentication { id: string; securityVersion: number; expiresAt: number }
export interface MfaBeginInput {
  id: string; challengeHash: string; kind: 'registration' | 'authentication'; intent: MfaIntent
  purpose: MfaPurpose; expectedSecurityVersion: number
  label: string | null; reauthenticationId: string | null; factorId: string | null; recoveryGrantId: string | null
}
export interface MfaChallengeReceipt { id: string; expiresAt: number; securityVersion: number }
/** A committed single-attempt claim. Crypto happens after the transaction releases its locks. */
export interface MfaChallengeClaim {
  id: string; attemptId: string; responseDigest: string; challengeHash: string
  userId: string; sessionId: string; credentialVersion: number; securityVersion: number
  kind: 'registration' | 'authentication'; intent: MfaIntent; purpose: MfaPurpose
  origin: string; rpId: string; userHandle: string; expiresAt: number
  factor: MfaFactor | null
}
/** Both variants require the private runtime brand from webauthn.ts. */
export type VerifiedWebAuthn = Readonly<{
  kind: 'registration'; claim: Readonly<MfaChallengeClaim>
  credential: Readonly<{ id: string; publicKey: string; counter: number; backupEligible: boolean; backedUp: boolean; transports: string[] }>
}> | Readonly<{
  kind: 'authentication'; claim: Readonly<MfaChallengeClaim>; newCounter: number; backedUp: boolean
}>
export interface MfaFinishReceipt {
  challengeId: string; securityVersion: number; factorId: string
  outcome: 'factor_pending' | 'verified'; assurance: MfaAssurance | null
}
export interface MfaManageInput {
  requestId: string; expectedSecurityVersion: number; reauthenticationId: string
}
export interface MfaRecoveryGrant { id: string; securityVersion: number; expiresAt: number }
export interface MfaRecoveryHash { id: string; hash: string }

/**
 * Finite self-only database commands. All authority comes from the current opaque
 * registered principal and fresh database reads. IDs select records, never grant access.
 * Repository owns exact configured origin/RP and rechecks them at claim and commit.
 */
export interface MfaRepository {
  readState(principal: AuthenticatedUser): Promise<MfaState>
  reservePassword(principal: AuthenticatedUser, id: string): Promise<MfaPasswordReservation>
  completePassword(principal: AuthenticatedUser, verification: MfaPasswordVerification): Promise<MfaReauthentication>
  beginCeremony(principal: AuthenticatedUser, input: MfaBeginInput): Promise<MfaChallengeReceipt>
  claimCeremony(principal: AuthenticatedUser, input: {
    challengeId: string; attemptId: string; responseDigest: string; credentialId: string | null
  }): Promise<MfaChallengeClaim>
  finishCeremony(principal: AuthenticatedUser, verification: VerifiedWebAuthn): Promise<MfaFinishReceipt>
  rejectCeremony(principal: AuthenticatedUser, claim: MfaChallengeClaim): Promise<void>
  revokeFactor(principal: AuthenticatedUser, input: MfaManageInput & { factorId: string }): Promise<{ securityVersion: number }>
  rotateRecoveryCodes(principal: AuthenticatedUser, input: MfaManageInput & { codes: MfaRecoveryHash[] }): Promise<{ requestId: string; securityVersion: number; count: number }>
  redeemRecoveryCode(principal: AuthenticatedUser, input: MfaManageInput & { codeHash: string }): Promise<MfaRecoveryGrant>
  currentProof(principal: AuthenticatedUser, purpose: MfaPurpose): Promise<MfaAssurance | null>
}

export type MfaCode = 'unauthenticated' | 'invalid_input' | 'incorrect_password' | 'verification_failed'
  | 'challenge_used' | 'challenge_expired' | 'state_changed' | 'mfa_required' | 'reauthentication_required'
  | 'last_factor' | 'factor_limit' | 'rate_limited' | 'recovery_failed' | 'mfa_unavailable'
const messages: Record<MfaCode, string> = {
  unauthenticated: 'Your sign-in changed. Sign in again to continue.',
  invalid_input: 'Check the passkey request and try again.',
  incorrect_password: 'Your current password was not correct.',
  verification_failed: 'The passkey could not be verified. Start a new verification.',
  challenge_used: 'This verification was already attempted. Start a new verification.',
  challenge_expired: 'This verification expired. Start a new verification.',
  state_changed: 'Your security settings changed. Reload before continuing.',
  mfa_required: 'Verify this session with a passkey before continuing.',
  reauthentication_required: 'Enter your current password again before continuing.',
  last_factor: 'Add and verify a replacement passkey before removing your last passkey.',
  factor_limit: 'You have reached the passkey limit. Remove an unused passkey first.',
  rate_limited: 'Too many security attempts. Wait before trying again.',
  recovery_failed: 'The recovery code could not be accepted. Check it and try again.',
  mfa_unavailable: 'The security change could not be confirmed. Reload before trying again.',
}
export class MfaError extends Error {
  readonly code: MfaCode
  readonly status: number
  readonly retryAfterSeconds?: number
  constructor(code: MfaCode, retryAfterSeconds?: number) {
    super(messages[code]); this.code = code
    this.status = code === 'unauthenticated' ? 401 : code === 'rate_limited' ? 429 : code === 'mfa_unavailable' ? 503
      : ['mfa_required', 'reauthentication_required'].includes(code) ? 403
        : ['challenge_used', 'state_changed', 'last_factor', 'factor_limit'].includes(code) ? 409 : 400
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds
  }
}
