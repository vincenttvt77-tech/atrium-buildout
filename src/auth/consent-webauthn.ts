import { MfaError } from './mfa-model.ts'
import { validId, validVersion } from './validation.ts'
import { validSessionId } from './session.ts'
import { verifyAuthenticationAssertion } from './webauthn.ts'
import type { AuthenticationAssertionClaim } from './webauthn.ts'

/** Server-owned, already reserved attempt. All fields must match its stored manifest. */
export interface ConsentWebAuthnClaim extends AuthenticationAssertionClaim {
  audience: 'resident'
  organizationId: string
  propertyId: string
  requestId: string
  requestVersion: number
  purpose: 'work' | 'entry'
  termsDigest: string
  materialDigest: string
  commandId: string
  expectedDecisionVersion: number
}
export interface VerifiedConsentWebAuthn {
  readonly kind: 'resident_consent'
  readonly claim: Readonly<ConsentWebAuthnClaim>
  readonly newCounter: number
  readonly backedUp: boolean
}

const brands = new WeakSet<object>()
const keys = new Set(['id','attemptId','responseDigest','challengeHash','userId','sessionId','credentialVersion','securityVersion',
  'origin','rpId','userHandle','expiresAt','factor','audience','organizationId','propertyId','requestId','requestVersion',
  'purpose','termsDigest','materialDigest','commandId','expectedDecisionVersion'])

export function assertVerifiedConsentWebAuthn(value: unknown): asserts value is VerifiedConsentWebAuthn {
  if (!value || typeof value !== 'object' || !brands.has(value)) throw new MfaError('verification_failed')
}

/**
 * Does not issue login assurance, activate a factor or save a decision. The finite
 * consent repository must atomically CAS the shared factor counter revision and
 * consume the exact stored attempt with the decision and its recovery receipt.
 */
export async function verifyConsentWebAuthn(rawClaim: ConsentWebAuthnClaim, response: unknown): Promise<VerifiedConsentWebAuthn> {
  const verified = await verifyAuthenticationAssertion(rawClaim, response)
  const claim = verified.claim
  if (Object.keys(claim).some(key => !keys.has(key)) || claim.audience !== 'resident'
    || !validId(claim.organizationId) || !validId(claim.propertyId) || !validSessionId(claim.requestId)
    || !validSessionId(claim.id) || !validSessionId(claim.attemptId) || !validSessionId(claim.commandId)
    || !validVersion(claim.requestVersion) || !['work','entry'].includes(claim.purpose)
    || typeof claim.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(claim.termsDigest)
    || typeof claim.materialDigest !== 'string' || !/^[a-f0-9]{64}$/.test(claim.materialDigest)
    || !Number.isSafeInteger(claim.expectedDecisionVersion) || claim.expectedDecisionVersion < 0
    || claim.factor.status !== 'active' || !validSessionId(claim.factor.id)) throw new MfaError('verification_failed')
  const proof: VerifiedConsentWebAuthn = Object.freeze({ kind: 'resident_consent', ...verified })
  brands.add(proof)
  return proof
}
