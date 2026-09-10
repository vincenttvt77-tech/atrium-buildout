import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse,
  verifyAuthenticationResponse } from '@simplewebauthn/server'
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server'
import { decodeCredentialPublicKey, decodeAttestationObject } from '@simplewebauthn/server/helpers'
import { MfaError } from './mfa-model.ts'
import type { MfaConfiguration, MfaChallengeClaim, MfaFactor, VerifiedWebAuthn } from './mfa-model.ts'
import { validId, validVersion } from './validation.ts'
import { validSessionId } from './session.ts'

const brands = new WeakSet<object>()
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const failure = (): never => { throw new MfaError('verification_failed') }
const check = (condition: unknown): void => { if (!condition) failure() }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uint32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000
function base64(value: unknown, maxBytes: number, minBytes = 1): Buffer {
  check(typeof value === 'string' && value.length <= Math.ceil(maxBytes * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(value))
  const bytes = Buffer.from(value as string, 'base64url')
  check(bytes.length >= minBytes && bytes.length <= maxBytes && bytes.toString('base64url') === value)
  return bytes
}
function transports(value: unknown): string[] {
  if (value === undefined) return []
  check(Array.isArray(value) && value.length <= TRANSPORTS.size && value.every(item => typeof item === 'string' && TRANSPORTS.has(item)))
  const result = value as string[]
  check(new Set(result).size === result.length)
  return [...result]
}
function trustedLocation(origin: unknown, rpId: unknown): void {
  check(typeof origin === 'string' && origin.length <= 2048 && typeof rpId === 'string' && rpId.length <= 253)
  const url = new URL(origin as string), rp = rpId as string
  check(url.origin === origin && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
  check(rp === rp.toLowerCase() && !isIP(rp) && /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/.test(rp)
    && rp.split('.').every(label => label.length <= 63))
  check(url.hostname === rp || url.hostname.endsWith(`.${rp}`))
  check(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost' && rp === 'localhost'))
}
function ids(value: unknown): string[] {
  check(Array.isArray(value) && value.length <= 20)
  const result = value as string[]
  for (const id of result) base64(id, 1023)
  check(new Set(result).size === result.length)
  return [...result]
}
/** Only bounded JSON data enters asynchronous verification; getters/toJSON are not authority. */
function jsonSnapshot(value: unknown): { text: string; data: Record<string, unknown> } {
  let nodes = 0
  function visit(item: unknown, depth: number): void {
    check(++nodes <= 512 && depth <= 8)
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') { check(Number.isFinite(item)); return }
    if (typeof item === 'string') { check(item.length <= 32_768); return }
    check(typeof item === 'object' && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null))
    const descriptors = Object.getOwnPropertyDescriptors(item)
    check(Object.getOwnPropertySymbols(item).length === 0 && Object.keys(descriptors).length <= 64)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue
      check(key.length <= 128 && !['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key) && descriptor.enumerable && 'value' in descriptor)
      visit(descriptor.value, depth + 1)
    }
  }
  check(isRecord(value)); visit(value, 0)
  const text = JSON.stringify(value)
  check(Buffer.byteLength(text) <= 65_536)
  return { text, data: JSON.parse(text) as Record<string, unknown> }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function keyBytes(value: unknown): Buffer {
  const bytes = base64(value, 2048)
  const decoded = decodeCredentialPublicKey(new Uint8Array(bytes))
  check(decoded instanceof Map)
  const key = decoded as unknown as Map<number, unknown>
  check(key.get(1) === 2 && key.get(3) === -7 && key.get(-1) === 1 && !key.has(-4))
  const x = key.get(-2), y = key.get(-3)
  check(x instanceof Uint8Array && x.length === 32 && y instanceof Uint8Array && y.length === 32)
  // None attestation doesn't validate a signature. Reject malformed/off-curve
  // public points now rather than persisting an unusable pending credential.
  createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(x as Uint8Array).toString('base64url'),
    y: Buffer.from(y as Uint8Array).toString('base64url') }, format: 'jwk' })
  return bytes
}
function factor(value: MfaFactor): void {
  check(isRecord(value) && validId(value.id) && typeof value.label === 'string' && value.label.length <= 100
    && !/[\u0000-\u001f\u007f]/.test(value.label) && uint32(value.counter)
    && Number.isSafeInteger(value.counterRevision) && value.counterRevision >= 0
    && ['pending', 'active'].includes(value.status) && typeof value.backupEligible === 'boolean' && typeof value.backedUp === 'boolean'
    && (!value.backedUp || value.backupEligible) && finiteTime(value.createdAt)
    && (value.lastUsedAt === null || finiteTime(value.lastUsedAt)))
  base64(value.credentialId, 1023); keyBytes(value.publicKey); transports(value.transports)
}
function validatedClaim(raw: MfaChallengeClaim): MfaChallengeClaim {
  const claim = jsonSnapshot(raw).data as unknown as MfaChallengeClaim
  check(validId(claim.id) && validId(claim.attemptId) && /^[a-f0-9]{64}$/.test(claim.responseDigest)
    && /^[a-f0-9]{64}$/.test(claim.challengeHash) && validId(claim.userId) && validSessionId(claim.sessionId)
    && validVersion(claim.credentialVersion) && validVersion(claim.securityVersion)
    && ['registration', 'authentication'].includes(claim.kind)
    && ['bootstrap', 'add_factor', 'recover_factor', 'verify'].includes(claim.intent)
    && ['session_login', 'organization_administration', 'manage_factors'].includes(claim.purpose) && finiteTime(claim.expiresAt))
  if (claim.expiresAt <= Date.now()) throw new MfaError('challenge_expired')
  trustedLocation(claim.origin, claim.rpId); base64(claim.userHandle, 64)
  if (claim.kind === 'registration') check(claim.factor === null && claim.intent !== 'verify')
  else { check(claim.factor !== null); factor(claim.factor!) }
  return freeze(claim)
}
function validatedResponse(claim: MfaChallengeClaim, raw: unknown): RegistrationResponseJSON | AuthenticationResponseJSON {
  const { text, data } = jsonSnapshot(raw)
  check(timingSafeEqual(Buffer.from(hash(text), 'hex'), Buffer.from(claim.responseDigest, 'hex')))
  check(Object.keys(data).every(key => ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'].includes(key)))
  base64(data.id, 1023); check(data.rawId === data.id && data.type === 'public-key' && isRecord(data.response) && isRecord(data.clientExtensionResults))
  check(data.authenticatorAttachment === undefined || ['platform', 'cross-platform'].includes(String(data.authenticatorAttachment)))
  check(Buffer.byteLength(JSON.stringify(data.clientExtensionResults)) <= 4096)
  const response = data.response as Record<string, unknown>
  const clientBytes = base64(response.clientDataJSON, 4096), clientText = clientBytes.toString('utf8')
  check(Buffer.from(clientText).equals(clientBytes))
  const client = JSON.parse(clientText) as Record<string, unknown>
  check(isRecord(client) && (client.crossOrigin === undefined || client.crossOrigin === false) && client.topOrigin === undefined)
  base64(client.challenge, 128, 16)
  if (claim.kind === 'registration') {
    check(Object.keys(response).every(key => ['clientDataJSON', 'attestationObject', 'transports', 'authenticatorData', 'publicKeyAlgorithm', 'publicKey'].includes(key)))
    const attestation = decodeAttestationObject(new Uint8Array(base64(response.attestationObject, 24_576)))
    // Only the advertised unsigned format is accepted. Other attestation formats
    // may invoke certificate trust paths and are outside this enrollment policy.
    check(attestation.get('fmt') === 'none' && attestation.get('attStmt') instanceof Map
      && (attestation.get('attStmt') as unknown as Map<unknown, unknown>).size === 0)
    transports(response.transports)
    if (response.authenticatorData !== undefined) base64(response.authenticatorData, 8192, 37)
    if (response.publicKey !== undefined) base64(response.publicKey, 2048)
    if (response.publicKeyAlgorithm !== undefined) check(response.publicKeyAlgorithm === -7)
  } else {
    check(data.id === claim.factor!.credentialId && Object.keys(response).every(key => ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'].includes(key)))
    base64(response.authenticatorData, 8192, 37); base64(response.signature, 80, 8)
    if (response.userHandle !== undefined) { base64(response.userHandle, 64); check(response.userHandle === claim.userHandle) }
  }
  return data as unknown as RegistrationResponseJSON | AuthenticationResponseJSON
}

export function assertVerifiedWebAuthn(value: unknown): asserts value is VerifiedWebAuthn {
  if (!value || typeof value !== 'object' || !brands.has(value)) throw new MfaError('verification_failed')
}
/** Actual library options; no browser-selected origin, RP or verification policy. */
export function createWebAuthn(configuration: MfaConfiguration) {
  try {
    trustedLocation(configuration.origin, configuration.rpId)
    check(typeof configuration.rpName === 'string' && configuration.rpName.trim().length > 0
      && configuration.rpName.length <= 200 && !/[\u0000-\u001f\u007f]/.test(configuration.rpName))
  } catch { throw new MfaError('mfa_unavailable') }
  const config = Object.freeze({ ...configuration })
  return Object.freeze({
    async registrationOptions(input: { userId: string; username: string; excludeCredentialIds: string[] }) {
      try {
        const userID = new Uint8Array(base64(input.userId, 64)), excludeCredentials = ids(input.excludeCredentialIds).map(id => ({ id }))
        check(typeof input.username === 'string' && input.username.trim().length > 0 && input.username.length <= 128
          && !/[\u0000-\u001f\u007f]/.test(input.username))
        return await generateRegistrationOptions({ rpID: config.rpId, rpName: config.rpName, userID, userName: input.username,
          userDisplayName: input.username, attestationType: 'none', supportedAlgorithmIDs: [-7], excludeCredentials,
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } })
      } catch { throw new MfaError('invalid_input') }
    },
    async authenticationOptions(input: { credentialIds: string[] }) {
      try {
        const allowCredentials = ids(input.credentialIds).map(id => ({ id }))
        check(allowCredentials.length > 0)
        return await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', allowCredentials })
      } catch { throw new MfaError('invalid_input') }
    },
  })
}
/** Crypto outside SQL; only the repository may finish the already-claimed attempt. */
export async function verifyWebAuthn(rawClaim: MfaChallengeClaim, response: unknown): Promise<VerifiedWebAuthn> {
  try {
    const claim = validatedClaim(rawClaim), wire = validatedResponse(claim, response)
    const expectedChallenge = (challenge: string): boolean => {
      try { base64(challenge, 128, 16); return hash(challenge) === claim.challengeHash } catch { return false }
    }
    let result: VerifiedWebAuthn
    if (claim.kind === 'registration') {
      const verified = await verifyRegistrationResponse({ response: wire as RegistrationResponseJSON,
        expectedChallenge, expectedOrigin: claim.origin, expectedRPID: claim.rpId, expectedType: 'webauthn.create',
        requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7] })
      check(verified.verified && verified.registrationInfo)
      const info = verified.registrationInfo!
      check(info.credential.id === wire.id && uint32(info.credential.counter) && info.userVerified)
      const publicKey = Buffer.from(info.credential.publicKey).toString('base64url'); keyBytes(publicKey)
      result = { kind: 'registration', claim, credential: { id: info.credential.id, publicKey, counter: info.credential.counter,
        backupEligible: info.credentialDeviceType === 'multiDevice', backedUp: info.credentialBackedUp,
        transports: transports(info.credential.transports) } }
    } else {
      const current = claim.factor!
      const verified = await verifyAuthenticationResponse({ response: wire as AuthenticationResponseJSON,
        expectedChallenge, expectedOrigin: claim.origin, expectedRPID: claim.rpId, expectedType: 'webauthn.get', requireUserVerification: true,
        credential: { id: current.credentialId, publicKey: new Uint8Array(keyBytes(current.publicKey)), counter: current.counter } })
      const info = verified.authenticationInfo
      check(verified.verified && info.userVerified && info.credentialID === current.credentialId && uint32(info.newCounter)
        && (info.credentialDeviceType === 'multiDevice') === current.backupEligible)
      result = { kind: 'authentication', claim, newCounter: info.newCounter, backedUp: info.credentialBackedUp }
    }
    if (claim.expiresAt <= Date.now()) throw new MfaError('challenge_expired')
    freeze(result); brands.add(result)
    return result
  } catch (error) {
    if (error instanceof MfaError) throw error
    throw new MfaError('verification_failed')
  }
}
