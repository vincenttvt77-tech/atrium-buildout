import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { verifyPassword } from '../ops/accounts.ts'
import { assertManagedSession } from './session-management.ts'
import { validVersion } from './validation.ts'
import { validSessionId } from './session.ts'
import type { AuthenticatedUser } from './model.ts'
import type { PrivilegedAuthentication } from './administration.ts'
import { createWebAuthn, verifyWebAuthn } from './webauthn.ts'
import { MfaError } from './mfa-model.ts'
import type { MfaAssurance, MfaConfiguration, MfaPasswordVerification, MfaPurpose, MfaRepository, MfaState } from './mfa-model.ts'

const passwordProofs = new WeakSet<object>()
export function assertMfaPasswordVerification(value: unknown): asserts value is MfaPasswordVerification {
  if (!value || typeof value !== 'object' || !passwordProofs.has(value)) throw new MfaError('reauthentication_required')
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function managed(principal: AuthenticatedUser) {
  try { assertManagedSession(principal) } catch { throw new MfaError('unauthenticated') }
}
function uuid(value: unknown): asserts value is string { if (!validSessionId(value)) throw new MfaError('invalid_input') }
function version(value: unknown): asserts value is number { if (!validVersion(value)) throw new MfaError('invalid_input') }
function purpose(value: unknown): asserts value is MfaPurpose {
  if (typeof value !== 'string' || !['session_login', 'manage_factors', 'organization_administration'].includes(value)) throw new MfaError('invalid_input')
}
function activeProof(proof: MfaAssurance, principal: AuthenticatedUser, securityVersion: number, expected: MfaPurpose): boolean {
  const now = Date.now()
  return validSessionId(proof.id) && proof.userId === principal.userId && proof.sessionId === principal.sessionId
    && proof.credentialVersion === principal.credentialVersion && proof.securityVersion === securityVersion
    && proof.purpose === expected && validSessionId(proof.factorId) && Number.isSafeInteger(proof.verifiedAt)
    && Number.isSafeInteger(proof.expiresAt) && proof.verifiedAt <= now + 5000 && proof.expiresAt > now
    && proof.expiresAt > proof.verifiedAt && proof.expiresAt <= principal.sessionExpiresAt!
    && (expected === 'session_login' || proof.expiresAt - proof.verifiedAt <= 600000)
}
function validateState(state: MfaState, principal: AuthenticatedUser): MfaState {
  if (!state || state.userId !== principal.userId || state.sessionId !== principal.sessionId
    || state.credentialVersion !== principal.credentialVersion || !validVersion(state.securityVersion)
    || typeof state.everEnabled !== 'boolean' || typeof state.required !== 'boolean'
    || typeof state.userHandle !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(state.userHandle)
    || Buffer.from(state.userHandle, 'base64url').toString('base64url') !== state.userHandle
    || !Array.isArray(state.factors) || state.factors.length > 11 || state.factors.filter(f => f.status === 'active').length > 10
    || !Array.isArray(state.assurances)
    || state.assurances.length > 3 || !Number.isInteger(state.recoveryRemaining)
    || state.recoveryRemaining < 0 || state.recoveryRemaining > 10
    || new Set(state.factors.map(f => f.id)).size !== state.factors.length
    || new Set(state.assurances.map(p => p.purpose)).size !== state.assurances.length) throw new MfaError('mfa_unavailable')
  for (const factor of state.factors) {
    if (!validSessionId(factor.id) || typeof factor.label !== 'string' || factor.label.length < 1 || factor.label.length > 80
      || !['pending', 'active'].includes(factor.status) || !Number.isSafeInteger(factor.createdAt)
      || !(factor.lastUsedAt === null || Number.isSafeInteger(factor.lastUsedAt))
      || typeof factor.credentialId !== 'string' || typeof factor.publicKey !== 'string') throw new MfaError('mfa_unavailable')
  }
  for (const proof of state.assurances) {
    if (!activeProof(proof, principal, state.securityVersion, proof.purpose)
      || !state.factors.some(f => f.id === proof.factorId && f.status === 'active')) throw new MfaError('mfa_unavailable')
  }
  return state
}
/** Deliberate public projection. No credential IDs, public-key bytes, hashes or handles. */
export function publicMfaState(state: MfaState) {
  return { securityVersion: state.securityVersion, required: state.required, everEnabled: state.everEnabled,
    sessionVerified: state.assurances.some(p => p.purpose === 'session_login'),
    manageVerified: state.assurances.some(p => p.purpose === 'manage_factors'),
    administratorVerified: state.assurances.some(p => p.purpose === 'organization_administration'),
    recoveryRemaining: state.recoveryRemaining,
    factors: state.factors.map(({ id, label, status, createdAt, lastUsedAt }) => ({ id, label, status, createdAt, lastUsedAt })) }
}
export function createMfaService(repository: MfaRepository, configuration: MfaConfiguration) {
  const webauthn = createWebAuthn(configuration)
  async function state(principal: AuthenticatedUser) {
    managed(principal)
    return validateState(await repository.readState(principal), principal)
  }
  return Object.freeze({
    state,
    async requireLogin(principal: AuthenticatedUser): Promise<void> {
      const current = await state(principal)
      if (current.required && !current.assurances.some(p => p.purpose === 'session_login')) throw new MfaError('mfa_required')
    },
    async password(principal: AuthenticatedUser, password: unknown) {
      managed(principal)
      if (typeof password !== 'string' || password.length < 1 || password.length > 256) throw new MfaError('invalid_input')
      const reservation = await repository.reservePassword(principal, randomUUID())
      if (!reservation || !validSessionId(reservation.id) || reservation.userId !== principal.userId
        || reservation.sessionId !== principal.sessionId || reservation.credentialVersion !== principal.credentialVersion
        || !validVersion(reservation.securityVersion) || !Number.isSafeInteger(reservation.expiresAt)
        || reservation.expiresAt <= Date.now() || reservation.expiresAt > Date.now() + 305000
        || typeof reservation.passwordHash !== 'string') throw new MfaError('mfa_unavailable')
      if (!await verifyPassword(password, reservation.passwordHash)) throw new MfaError('incorrect_password')
      const verified = Object.freeze({ reservation: Object.freeze({ ...reservation }) })
      passwordProofs.add(verified)
      const receipt = await repository.completePassword(principal, verified)
      if (!receipt || receipt.id !== reservation.id || receipt.securityVersion !== reservation.securityVersion
        || receipt.expiresAt <= Date.now() || receipt.expiresAt > Date.now() + 305000) throw new MfaError('mfa_unavailable')
      return receipt
    },
    async registrationOptions(principal: AuthenticatedUser, input: {
      label: unknown; reauthenticationId: unknown; recoveryGrantId: unknown
    }) {
      managed(principal); uuid(input.reauthenticationId)
      if (input.recoveryGrantId !== null) uuid(input.recoveryGrantId)
      if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80
        || /[\u0000-\u001f\u007f]/.test(input.label)) throw new MfaError('invalid_input')
      const current = await state(principal)
      const optionsJSON = await webauthn.registrationOptions({ userId: current.userHandle, username: principal.username,
        excludeCredentialIds: current.factors.map(f => f.credentialId) })
      const receipt = await repository.beginCeremony(principal, { id: randomUUID(), challengeHash: digest(optionsJSON.challenge),
        kind: 'registration', intent: input.recoveryGrantId ? 'recover_factor' : current.everEnabled ? 'add_factor' : 'bootstrap',
        purpose: 'session_login', expectedSecurityVersion: current.securityVersion, label: input.label.trim(),
        reauthenticationId: input.reauthenticationId, recoveryGrantId: input.recoveryGrantId, factorId: null })
      return { challengeId: receipt.id, expiresAt: receipt.expiresAt, optionsJSON }
    },
    async authenticationOptions(principal: AuthenticatedUser, input: { purpose: unknown; factorId: unknown }) {
      managed(principal); purpose(input.purpose)
      if (input.factorId !== null) uuid(input.factorId)
      const current = await state(principal)
      const factors = input.factorId === null ? current.factors.filter(f => f.status === 'active')
        : current.factors.filter(f => f.id === input.factorId)
      if (!factors.length || (factors.some(f => f.status === 'pending') && input.purpose !== 'session_login')) throw new MfaError('invalid_input')
      const optionsJSON = await webauthn.authenticationOptions({ credentialIds: factors.map(f => f.credentialId) })
      const receipt = await repository.beginCeremony(principal, { id: randomUUID(), challengeHash: digest(optionsJSON.challenge),
        kind: 'authentication', intent: 'verify', purpose: input.purpose, expectedSecurityVersion: current.securityVersion,
        label: null, reauthenticationId: null, recoveryGrantId: null, factorId: input.factorId })
      return { challengeId: receipt.id, expiresAt: receipt.expiresAt, optionsJSON }
    },
    async finish(principal: AuthenticatedUser, input: { kind: 'registration' | 'authentication'; challengeId: unknown; response: unknown }) {
      managed(principal); uuid(input.challengeId)
      let serialized: string
      try { serialized = JSON.stringify(input.response) } catch { throw new MfaError('invalid_input') }
      if (!serialized || serialized.length > 65536) throw new MfaError('invalid_input')
      const response = JSON.parse(serialized)
      if (!response || typeof response !== 'object' || Array.isArray(response)
        || typeof response.id !== 'string' || response.id.length < 1 || response.id.length > 1364) throw new MfaError('invalid_input')
      const claim = await repository.claimCeremony(principal, { challengeId: input.challengeId, attemptId: randomUUID(),
        responseDigest: digest(serialized), credentialId: response.id })
      let verified
      try {
        if (claim.kind !== input.kind || claim.userId !== principal.userId || claim.sessionId !== principal.sessionId
          || claim.credentialVersion !== principal.credentialVersion || claim.origin !== configuration.origin
          || claim.rpId !== configuration.rpId) throw new MfaError('verification_failed')
        verified = await verifyWebAuthn(claim, response)
      } catch {
        await repository.rejectCeremony(principal, claim)
        throw new MfaError('verification_failed')
      }
      const receipt = await repository.finishCeremony(principal, verified)
      if (!receipt || receipt.challengeId !== input.challengeId || !validVersion(receipt.securityVersion) || !validSessionId(receipt.factorId)
        || (input.kind === 'registration' ? receipt.outcome !== 'factor_pending' || receipt.assurance !== null
          : receipt.outcome !== 'verified' || !receipt.assurance
            || !activeProof(receipt.assurance, principal, receipt.securityVersion, claim.purpose))) throw new MfaError('mfa_unavailable')
      return receipt
    },
    async removeFactor(principal: AuthenticatedUser, input: { factorId: unknown; requestId: unknown; expectedSecurityVersion: unknown; reauthenticationId: unknown }) {
      managed(principal); uuid(input.factorId); uuid(input.requestId); uuid(input.reauthenticationId); version(input.expectedSecurityVersion)
      return repository.revokeFactor(principal, { factorId: input.factorId, requestId: input.requestId,
        expectedSecurityVersion: input.expectedSecurityVersion, reauthenticationId: input.reauthenticationId })
    },
    async rotateRecovery(principal: AuthenticatedUser, input: { requestId: unknown; expectedSecurityVersion: unknown; reauthenticationId: unknown }) {
      managed(principal); uuid(input.requestId); uuid(input.reauthenticationId); version(input.expectedSecurityVersion)
      const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex').match(/.{8}/g)!.join('-'))
      const receipt = await repository.rotateRecoveryCodes(principal, { requestId: input.requestId,
        expectedSecurityVersion: input.expectedSecurityVersion, reauthenticationId: input.reauthenticationId,
        codes: codes.map(code => ({ id: randomUUID(), hash: recoveryHash(principal.userId, code) })) })
      if (receipt.requestId !== input.requestId || receipt.count !== codes.length || !validVersion(receipt.securityVersion)) throw new MfaError('mfa_unavailable')
      return { requestId: receipt.requestId, codes }
    },
    async recover(principal: AuthenticatedUser, input: { code: unknown; requestId: unknown; expectedSecurityVersion: unknown; reauthenticationId: unknown }) {
      managed(principal); uuid(input.requestId); uuid(input.reauthenticationId); version(input.expectedSecurityVersion)
      if (typeof input.code !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{8}){3})$/i.test(input.code.trim())) throw new MfaError('recovery_failed')
      return repository.redeemRecoveryCode(principal, { requestId: input.requestId, expectedSecurityVersion: input.expectedSecurityVersion,
        reauthenticationId: input.reauthenticationId, codeHash: recoveryHash(principal.userId, input.code.trim()) })
    },
    administrationAuthentication(principal: AuthenticatedUser): PrivilegedAuthentication {
      managed(principal)
      const issuer = `atrium-webauthn:${configuration.rpId}`
      return Object.freeze({ issuer, sessionId: principal.sessionId!, async verifyCurrentSession(candidate: AuthenticatedUser) {
        managed(candidate)
        if (candidate.userId !== principal.userId || candidate.sessionId !== principal.sessionId
          || candidate.credentialVersion !== principal.credentialVersion) throw new MfaError('unauthenticated')
        const proof = await repository.currentProof(candidate, 'organization_administration')
        if (!proof) return null
        if (!activeProof(proof, candidate, proof.securityVersion, 'organization_administration')) throw new MfaError('mfa_unavailable')
        return { issuer, sessionId: proof.sessionId, verificationId: proof.id, subjectId: proof.userId,
          credentialVersion: proof.credentialVersion, purpose: 'organization_administration' as const, method: 'webauthn' as const,
          verifiedAt: new Date(proof.verifiedAt).toISOString(), expiresAt: new Date(proof.expiresAt).toISOString() }
      } })
    },
  })
}
function recoveryHash(userId: string, code: string) {
  return digest(`atrium-recovery-v1:${userId}:${code.replaceAll('-', '').toLowerCase()}`)
}
