import { randomBytes } from 'node:crypto'
import type { AuthenticatedUser } from '../auth/model.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { validSessionId } from '../auth/session.ts'
import { validVersion } from '../auth/validation.ts'
import { mfaConfiguration } from '../auth/mfa-config.ts'
import { assertMfaPasswordVerification } from '../auth/mfa.ts'
import { assertVerifiedWebAuthn } from '../auth/webauthn.ts'
import { MfaError } from '../auth/mfa-model.ts'
import type { MfaCode, MfaRepository, MfaConfiguration, MfaState, MfaAssurance, MfaFactor,
  MfaPasswordReservation, MfaPasswordVerification, MfaReauthentication, MfaBeginInput,
  MfaChallengeReceipt, MfaChallengeClaim, VerifiedWebAuthn, MfaFinishReceipt, MfaManageInput,
  MfaRecoveryHash, MfaRecoveryGrant, MfaPurpose } from '../auth/mfa-model.ts'
import { DatabaseConnection } from './connection.ts'

const commands = ['read_state', 'reserve_password', 'complete_password', 'begin_ceremony', 'claim_ceremony',
  'finish_ceremony', 'reject_ceremony', 'revoke_factor', 'rotate_recovery', 'redeem_recovery', 'current_proof'] as const
type Command = typeof commands[number]
const codes: MfaCode[] = ['unauthenticated', 'invalid_input', 'incorrect_password', 'verification_failed',
  'challenge_used', 'challenge_expired', 'state_changed', 'mfa_required', 'reauthentication_required',
  'last_factor', 'factor_limit', 'rate_limited', 'recovery_failed', 'mfa_unavailable']
const unavailable = () => new MfaError('mfa_unavailable')
function check(condition: unknown): asserts condition { if (!condition) throw unavailable() }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const millis = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const purpose = (value: unknown) => ['session_login', 'manage_factors', 'organization_administration'].includes(String(value))
function binding(value: Record<string, any>, principal: AuthenticatedUser) {
  check(value.userId === principal.userId && value.sessionId === principal.sessionId
    && value.credentialVersion === principal.credentialVersion && validVersion(value.securityVersion))
}
function factor(value: unknown): asserts value is MfaFactor {
  check(object(value) && validSessionId(value.id) && typeof value.label === 'string' && value.label.length >= 1
    && value.label.length <= 80 && ['pending', 'active'].includes(value.status)
    && typeof value.credentialId === 'string' && /^[A-Za-z0-9_-]+$/.test(value.credentialId) && value.credentialId.length <= 1364
    && typeof value.publicKey === 'string' && /^[A-Za-z0-9_-]+$/.test(value.publicKey) && value.publicKey.length <= 22000
    && Number.isInteger(value.counter) && value.counter >= 0 && value.counter <= 4294967295
    && Number.isSafeInteger(value.counterRevision) && value.counterRevision >= 0
    && typeof value.backupEligible === 'boolean' && typeof value.backedUp === 'boolean'
    && (!value.backedUp || value.backupEligible) && Array.isArray(value.transports)
    && value.transports.length <= 8 && value.transports.every((v: unknown) => typeof v === 'string' && v.length <= 32)
    && millis(value.createdAt) && (value.lastUsedAt === null || millis(value.lastUsedAt)))
}
function assurance(value: unknown, principal: AuthenticatedUser): asserts value is MfaAssurance {
  check(object(value)); binding(value, principal)
  check(validSessionId(value.id) && validSessionId(value.factorId) && purpose(value.purpose)
    && millis(value.verifiedAt) && millis(value.expiresAt) && value.expiresAt > value.verifiedAt
    && value.expiresAt <= principal.sessionExpiresAt!
    && (value.purpose === 'session_login' || value.expiresAt - value.verifiedAt <= 600000))
}
function receipt(value: unknown): asserts value is MfaReauthentication {
  check(object(value) && validSessionId(value.id) && validVersion(value.securityVersion) && millis(value.expiresAt))
}
/** Finite self-only commands. Expected refusals commit consumed attempts; malformed
 * results and infrastructure failures roll back, without exposing SQL or credentials. */
export class PostgresMfaRepository implements MfaRepository {
  private readonly connection: DatabaseConnection
  private readonly configuration: MfaConfiguration
  constructor(connection: DatabaseConnection, configuration: MfaConfiguration) {
    if (connection.role !== 'atrium_authenticator') throw unavailable()
    const expected = mfaConfiguration(configuration.origin)
    if (expected.rpId !== configuration.rpId || expected.rpName !== configuration.rpName) throw unavailable()
    this.connection = connection; this.configuration = expected
  }
  private async command<T>(principal: AuthenticatedUser, command: Command, input: unknown,
    validate: (value: unknown) => T): Promise<T> {
    try { assertManagedSession(principal) } catch { throw new MfaError('unauthenticated') }
    let result: { value: T } | { error: MfaCode; retry?: number }
    try {
      result = await this.connection.transaction({ actorUserId: principal.userId, credentialVersion: principal.credentialVersion,
        actorSessionId: principal.sessionId! }, async client => {
        // The function name is a closed compile-time union, never a request selector.
        if (!commands.includes(command)) throw unavailable()
        const rows = (await client.query(`SELECT atrium.mfa_${command}($1::jsonb,$2,$3,$4) AS value`,
          [JSON.stringify(input), this.configuration.origin, this.configuration.rpId, randomBytes(32).toString('base64url')])).rows
        check(rows.length === 1)
        const value: unknown = rows[0].value
        if (object(value) && 'error' in value) {
          check(codes.includes(value.error) && Object.keys(value).every(k => k === 'error' || k === 'retryAfterSeconds'))
          const retry = value.retryAfterSeconds
          check(retry === undefined || (Number.isInteger(retry) && retry > 0 && retry <= 2147483647))
          check(value.error !== 'rate_limited' || retry !== undefined)
          return { error: value.error as MfaCode, retry }
        }
        return { value: validate(value) }
      })
    } catch { throw unavailable() }
    if ('error' in result) throw new MfaError(result.error, result.retry)
    return result.value
  }
  readState(principal: AuthenticatedUser): Promise<MfaState> {
    return this.command(principal, 'read_state', {}, value => {
      check(object(value)); binding(value, principal)
      check(typeof value.userHandle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.userHandle)
        && typeof value.everEnabled === 'boolean' && typeof value.required === 'boolean'
        && Array.isArray(value.factors) && value.factors.length <= 11 && Array.isArray(value.assurances) && value.assurances.length <= 3
        && Number.isInteger(value.recoveryRemaining) && value.recoveryRemaining >= 0 && value.recoveryRemaining <= 10)
      value.factors.forEach(factor); value.assurances.forEach((p: unknown) => assurance(p, principal))
      check(value.factors.filter((f: MfaFactor) => f.status === 'active').length <= 10)
      check(new Set(value.factors.map((f: MfaFactor) => f.id)).size === value.factors.length)
      return value as MfaState
    })
  }
  reservePassword(principal: AuthenticatedUser, id: string): Promise<MfaPasswordReservation> {
    return this.command(principal, 'reserve_password', { id }, value => {
      check(object(value)); binding(value, principal)
      check(value.id === id && typeof value.passwordHash === 'string' && value.passwordHash.length <= 1024)
      receipt(value)
      return value as MfaPasswordReservation
    })
  }
  completePassword(principal: AuthenticatedUser, verification: MfaPasswordVerification): Promise<MfaReauthentication> {
    assertMfaPasswordVerification(verification)
    binding(verification.reservation, principal)
    return this.command(principal, 'complete_password', { id: verification.reservation.id, passwordHash: verification.reservation.passwordHash }, value => {
      receipt(value); check(value.id === verification.reservation.id && value.securityVersion === verification.reservation.securityVersion); return value
    })
  }
  beginCeremony(principal: AuthenticatedUser, input: MfaBeginInput): Promise<MfaChallengeReceipt> {
    return this.command(principal, 'begin_ceremony', input, value => { receipt(value); check(value.id === input.id); return value })
  }
  claimCeremony(principal: AuthenticatedUser, input: { challengeId: string; attemptId: string; responseDigest: string; credentialId: string | null }): Promise<MfaChallengeClaim> {
    return this.command(principal, 'claim_ceremony', input, value => {
      check(object(value)); binding(value, principal)
      check(value.id === input.challengeId && value.attemptId === input.attemptId && value.responseDigest === input.responseDigest
        && /^[a-f0-9]{64}$/.test(value.challengeHash) && ['registration', 'authentication'].includes(value.kind)
        && ['bootstrap', 'add_factor', 'recover_factor', 'verify'].includes(value.intent) && purpose(value.purpose)
        && value.origin === this.configuration.origin && value.rpId === this.configuration.rpId
        && typeof value.userHandle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.userHandle) && millis(value.expiresAt))
      if (value.factor !== null) factor(value.factor)
      check(value.kind === 'registration' ? value.factor === null : value.factor !== null)
      return value as MfaChallengeClaim
    })
  }
  finishCeremony(principal: AuthenticatedUser, verification: VerifiedWebAuthn): Promise<MfaFinishReceipt> {
    assertVerifiedWebAuthn(verification); binding(verification.claim, principal)
    const claim = verification.claim
    check(claim.origin === this.configuration.origin && claim.rpId === this.configuration.rpId)
    return this.command(principal, 'finish_ceremony', { id: claim.id, attemptId: claim.attemptId, responseDigest: claim.responseDigest,
      kind: verification.kind, ...(verification.kind === 'registration' ? { credential: verification.credential }
        : { newCounter: verification.newCounter, backedUp: verification.backedUp }) }, value => {
      check(object(value) && value.challengeId === claim.id && validVersion(value.securityVersion) && validSessionId(value.factorId))
      if (verification.kind === 'registration') check(value.outcome === 'factor_pending' && value.assurance === null)
      else { check(value.outcome === 'verified'); assurance(value.assurance, principal)
        check(value.assurance.factorId === value.factorId && value.assurance.securityVersion === value.securityVersion && value.assurance.purpose === claim.purpose) }
      return value as MfaFinishReceipt
    })
  }
  async rejectCeremony(principal: AuthenticatedUser, claim: MfaChallengeClaim): Promise<void> {
    binding(claim, principal)
    await this.command(principal, 'reject_ceremony', { id: claim.id, attemptId: claim.attemptId, responseDigest: claim.responseDigest }, value => {
      check(object(value) && Object.keys(value).length === 0); return undefined
    })
  }
  revokeFactor(principal: AuthenticatedUser, input: MfaManageInput & { factorId: string }): Promise<{ securityVersion: number }> {
    return this.command(principal, 'revoke_factor', input, value => { check(object(value) && validVersion(value.securityVersion)); return { securityVersion: value.securityVersion } })
  }
  rotateRecoveryCodes(principal: AuthenticatedUser, input: MfaManageInput & { codes: MfaRecoveryHash[] }): Promise<{ requestId: string; securityVersion: number; count: number }> {
    return this.command(principal, 'rotate_recovery', input, value => {
      check(object(value) && value.requestId === input.requestId && validVersion(value.securityVersion) && value.count === 10)
      return { requestId: value.requestId, securityVersion: value.securityVersion, count: value.count }
    })
  }
  redeemRecoveryCode(principal: AuthenticatedUser, input: MfaManageInput & { codeHash: string }): Promise<MfaRecoveryGrant> {
    return this.command(principal, 'redeem_recovery', input, value => { receipt(value); check(value.id === input.requestId); return value })
  }
  currentProof(principal: AuthenticatedUser, requested: MfaPurpose): Promise<MfaAssurance | null> {
    return this.command(principal, 'current_proof', { purpose: requested }, value => {
      if (value === null) return null
      assurance(value, principal); check(value.purpose === requested); return value
    })
  }
}
