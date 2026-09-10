import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWebAuthn, verifyWebAuthn, assertVerifiedWebAuthn } from '../webauthn.ts'
import { MfaError } from '../mfa-model.ts'
import type { MfaChallengeClaim, MfaFactor } from '../mfa-model.ts'
// @ts-expect-error The shared test-only wire fixture is JavaScript, executed directly by Node.
import { SoftwareAuthenticator } from '../../../test/helpers/software-authenticator.mjs'

// These are genuine P-256 signed software responses. They do not attest a physical
// authenticator, browser acceptance, biometric interaction, or human presence.
const config = { origin: 'https://portal.example.test', rpId: 'example.test', rpName: 'Synthetic Atrium' }
const userHandle = randomBytes(32).toString('base64url')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')
interface Wire {
  id: string; rawId: string; type: string; authenticatorAttachment?: string
  response: { clientDataJSON: string; attestationObject?: string; transports?: string[]; authenticatorData?: string; signature?: string; userHandle?: string }
  clientExtensionResults: Record<string, unknown>
}
const denied = (code = 'verification_failed') => (error: unknown) => error instanceof MfaError && error.code === code
function ceremony(kind: 'registration' | 'authentication', override: Record<string, unknown> = {},
  options: { device?: InstanceType<typeof SoftwareAuthenticator>; factor?: Partial<MfaFactor>; claim?: Partial<MfaChallengeClaim> } = {}) {
  const device = options.device ?? new SoftwareAuthenticator(), challenge = randomBytes(32).toString('base64url')
  const input = { ...config, challenge, userHandle, ...override }
  const response = (kind === 'registration' ? device.registrationResponse(input) : device.authenticationResponse(input)) as Wire
  const factor: MfaFactor = { id: randomUUID(), label: 'Synthetic passkey', credentialId: device.credentialId, publicKey: device.publicKey,
    counter: 0, counterRevision: 0, status: 'active', backupEligible: false, backedUp: false, transports: ['internal'], createdAt: Date.now(), lastUsedAt: null,
    ...options.factor }
  const claim: MfaChallengeClaim = { id: randomUUID(), attemptId: randomUUID(), responseDigest: digest(JSON.stringify(response)), challengeHash: digest(challenge),
    userId: 'synthetic-user', sessionId: randomUUID(), credentialVersion: 1, securityVersion: 1, kind,
    intent: kind === 'registration' ? 'bootstrap' : 'verify', purpose: 'session_login', ...config, userHandle,
    expiresAt: Date.now() + 60_000, factor: kind === 'registration' ? null : factor, ...options.claim }
  return { device, challenge, response, claim }
}
function refresh(claim: MfaChallengeClaim, response: unknown): MfaChallengeClaim { return { ...claim, responseDigest: digest(JSON.stringify(response)) } }

test('actual library options advertise ES256, required UV, opaque user handle and exact configured RP', async () => {
  const source = { ...config }, api = createWebAuthn(source), device = new SoftwareAuthenticator()
  source.rpId = 'attacker.test'
  const registration = await api.registrationOptions({ userId: userHandle, username: 'synthetic.user', excludeCredentialIds: [device.credentialId] })
  assert.deepEqual(registration.rp, { id: config.rpId, name: config.rpName })
  assert.equal(registration.user.id, userHandle)
  assert.deepEqual(registration.pubKeyCredParams, [{ alg: -7, type: 'public-key' }])
  assert.equal(registration.attestation, 'none')
  assert.equal(registration.authenticatorSelection?.residentKey, 'preferred')
  assert.equal(registration.authenticatorSelection?.userVerification, 'required')
  assert.deepEqual(registration.excludeCredentials?.map(item => item.id), [device.credentialId])
  const authentication = await api.authenticationOptions({ credentialIds: [device.credentialId] })
  assert.equal(authentication.rpId, config.rpId)
  assert.equal(authentication.userVerification, 'required')
  assert.deepEqual(authentication.allowCredentials?.map(item => item.id), [device.credentialId])
  assert.notEqual(authentication.challenge, registration.challenge)
  const generated = ceremony('registration', { challenge: registration.challenge }, { device })
  generated.claim.challengeHash = digest(registration.challenge)
  const verified = await verifyWebAuthn(generated.claim, generated.response)
  assert.equal(verified.kind, 'registration')
})

test('configuration and options reject untrusted locations, invalid IDs and unbounded inputs', async () => {
  for (const change of [{ origin: 'https://portal.example.test/path' }, { origin: 'https://elsewhere.test' },
    { origin: 'http://portal.example.test' }, { rpId: 'EXAMPLE.TEST' }, { origin: 'https://127.0.0.1', rpId: '127.0.0.1' }, { rpName: '' }]) {
    assert.throws(() => createWebAuthn({ ...config, ...change }), denied('mfa_unavailable'))
  }
  assert.doesNotThrow(() => createWebAuthn({ origin: 'http://localhost:4300', rpId: 'localhost', rpName: 'Development' }))
  const api = createWebAuthn(config), id = b64(randomBytes(32))
  for (const values of [[], [id, id], [id + '='], Array.from({ length: 21 }, () => b64(randomBytes(32)))]) {
    await assert.rejects(api.authenticationOptions({ credentialIds: values }), denied('invalid_input'))
  }
  await assert.rejects(api.registrationOptions({ userId: b64(randomBytes(65)), username: 'synthetic', excludeCredentialIds: [] }), denied('invalid_input'))
  await assert.rejects(api.registrationOptions({ userId: userHandle, username: 'a'.repeat(129), excludeCredentialIds: [] }), denied('invalid_input'))
})

test('none registration returns a detached branded credential, then an actual signed assertion verifies possession', async () => {
  const { device, claim, response } = ceremony('registration')
  const result = await verifyWebAuthn(claim, response)
  assert.equal(result.kind, 'registration')
  if (result.kind !== 'registration') throw new Error('Wrong fixture result')
  assert.equal(result.credential.publicKey, device.publicKey)
  assert.equal(result.credential.id, device.credentialId)
  assert.equal(result.credential.counter, 0)
  assert.deepEqual(result.credential.transports, ['internal'])
  assertVerifiedWebAuthn(result)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.claim) && Object.isFrozen(result.credential.transports))
  claim.userId = 'mutated-user'; response.response.transports!.push('usb')
  assert.equal(result.claim.userId, 'synthetic-user')
  assert.deepEqual(result.credential.transports, ['internal'])
  for (const fake of [{ ...result }, structuredClone(result), JSON.parse(JSON.stringify(result)), null]) {
    assert.throws(() => assertVerifiedWebAuthn(fake), denied())
  }
  const next = ceremony('authentication', { counter: 1 }, { device, factor: { status: 'pending' } })
  const assertion = await verifyWebAuthn(next.claim, next.response)
  assert.equal(assertion.kind, 'authentication')
  if (assertion.kind === 'authentication') assert.equal(assertion.newCounter, 1)
  assert.ok(Object.isFrozen(assertion.claim.factor))
})

test('correctly signed authentication and registration both require UP and UV', async () => {
  for (const kind of ['registration', 'authentication'] as const) {
    for (const flags of [{ up: false }, { uv: false }, { up: false, uv: false }]) {
      const { claim, response } = ceremony(kind, flags)
      await assert.rejects(verifyWebAuthn(claim, response), denied())
    }
  }
})

test('correctly signed wrong origin, RP, challenge and ceremony type cannot verify', async () => {
  for (const kind of ['registration', 'authentication'] as const) {
    for (const mismatch of [{ origin: 'https://attacker.example.test' }, { rpId: 'attacker.test' },
      { challenge: b64(randomBytes(32)) }, { type: kind === 'registration' ? 'webauthn.get' : 'webauthn.create' }]) {
      const { claim, response } = ceremony(kind, mismatch)
      await assert.rejects(verifyWebAuthn(claim, response), denied())
    }
  }
})

test('cross-origin and top-origin ceremonies fail even with otherwise matching signed data', async () => {
  for (const kind of ['registration', 'authentication'] as const) {
    for (const mismatch of [{ crossOrigin: true }, { topOrigin: 'https://attacker.test' }]) {
      const { claim, response } = ceremony(kind, mismatch)
      await assert.rejects(verifyWebAuthn(claim, response), denied())
    }
  }
})

test('assertion user handles must be absent or the exact opaque account handle', async () => {
  for (const handle of [undefined, userHandle]) {
    const { claim, response } = ceremony('authentication', { userHandle: handle })
    assert.equal((await verifyWebAuthn(claim, response)).kind, 'authentication')
  }
  for (const handle of [b64(randomBytes(32)), '', null, userHandle + '=']) {
    const { claim, response } = ceremony('authentication', { userHandle: handle })
    await assert.rejects(verifyWebAuthn(claim, response), denied())
  }
})

test('a different signing key or tampered signature/data fails real signature verification', async () => {
  const wrongKey = ceremony('authentication', { signer: new SoftwareAuthenticator() })
  await assert.rejects(verifyWebAuthn(wrongKey.claim, wrongKey.response), denied())
  for (const target of ['signature', 'authenticatorData'] as const) {
    const { claim, response } = ceremony('authentication')
    const bytes = Buffer.from(response.response[target]!, 'base64url')
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    response.response[target] = b64(bytes)
    await assert.rejects(verifyWebAuthn(refresh(claim, response), response), denied())
  }
})

test('counterless authenticators are supported while repeated or decreasing nonzero counters fail', async () => {
  for (const [stored, next] of [[0, 0], [0, 1], [8, 9], [0xffff_fffe, 0xffff_ffff]]) {
    const { claim, response } = ceremony('authentication', { counter: next }, { factor: { counter: stored! } })
    const result = await verifyWebAuthn(claim, response)
    assert.equal(result.kind === 'authentication' && result.newCounter, next)
  }
  for (const [stored, next] of [[1, 1], [1, 0], [9, 8]]) {
    const { claim, response } = ceremony('authentication', { counter: next }, { factor: { counter: stored! } })
    await assert.rejects(verifyWebAuthn(claim, response), denied())
  }
  // A zero counter is not a replay fence. The claimed challenge and repository CAS
  // must prevent re-use; this stateless crypto wrapper deliberately does not claim it.
  const zero = ceremony('authentication')
  assert.equal((await verifyWebAuthn(zero.claim, zero.response)).kind, 'authentication')
  assert.equal((await verifyWebAuthn(zero.claim, zero.response)).kind, 'authentication')
})

test('backup flags are coherent and eligibility cannot change after registration', async () => {
  for (const kind of ['registration', 'authentication'] as const) {
    const invalid = ceremony(kind, { backupEligible: false, backedUp: true })
    await assert.rejects(verifyWebAuthn(invalid.claim, invalid.response), denied())
  }
  const registration = ceremony('registration', { backupEligible: true, backedUp: true })
  const registered = await verifyWebAuthn(registration.claim, registration.response)
  assert.equal(registered.kind === 'registration' && registered.credential.backupEligible, true)
  const changed = ceremony('authentication', { backupEligible: true }, { factor: { backupEligible: false } })
  await assert.rejects(verifyWebAuthn(changed.claim, changed.response), denied())
  const valid = ceremony('authentication', { backupEligible: true, backedUp: true }, { factor: { backupEligible: true, backedUp: false } })
  const verified = await verifyWebAuthn(valid.claim, valid.response)
  assert.equal(verified.kind === 'authentication' && verified.backedUp, true)
})

test('none registration refuses unsupported or malformed COSE public keys before storage', async () => {
  for (const [label, value] of [[1, 3], [3, -257], [-1, 2], [-2, Buffer.alloc(31)], [-2, Buffer.alloc(32)], [-4, Buffer.alloc(32)]] as const) {
    const device = new SoftwareAuthenticator(), key = new Map<number, unknown>(device.coseKey)
    key.set(label, value)
    const { claim, response } = ceremony('registration', { publicKey: key }, { device })
    await assert.rejects(verifyWebAuthn(claim, response), denied())
  }
  const changed = ceremony('authentication', {}, { factor: { publicKey: b64(Buffer.from('not a COSE key')) } })
  await assert.rejects(verifyWebAuthn(changed.claim, changed.response), denied())
})

test('credential identity is checked against embedded registration and stored authentication IDs', async () => {
  for (const kind of ['registration', 'authentication'] as const) {
    const { claim, response } = ceremony(kind)
    response.id = response.rawId = b64(randomBytes(32))
    await assert.rejects(verifyWebAuthn(refresh(claim, response), response), denied())
  }
})

test('only none attestation is accepted, without entering certificate-based verification paths', async () => {
  const device = new SoftwareAuthenticator()
  for (const fmt of ['packed', 'fido-u2f', 'android-safetynet']) {
    const { claim, response } = ceremony('registration', { fmt }, { device })
    await assert.rejects(verifyWebAuthn(claim, response), denied())
  }
})

test('attempt response digest must match exact JSON and caller mutation cannot change asynchronous verification', async () => {
  const { claim, response } = ceremony('authentication')
  await assert.rejects(verifyWebAuthn({ ...claim, responseDigest: 'a'.repeat(64) }, response), denied())
  const pending = verifyWebAuthn(claim, response)
  response.id = 'mutated'; claim.factor!.publicKey = 'mutated'; claim.userId = 'different'
  const result = await pending
  assert.equal(result.claim.userId, 'synthetic-user')
  assert.notEqual(result.claim.factor!.publicKey, 'mutated')
})

test('claims expire before verification and again after asynchronous cryptography', async t => {
  const expired = ceremony('authentication', {}, { claim: { expiresAt: Date.now() - 1 } })
  await assert.rejects(verifyWebAuthn(expired.claim, expired.response), denied('challenge_expired'))
  const current = ceremony('authentication'), now = Date.now()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  current.claim.expiresAt = now + 1000
  const pending = verifyWebAuthn(current.claim, current.response)
  clock = now + 1000
  await assert.rejects(pending, denied('challenge_expired'))
})

test('bounded canonical wire input rejects padding, oversized fields, malformed JSON and accessors', async () => {
  const cases: ((response: Wire) => unknown)[] = [
    response => ({ ...response, id: response.id + '=', rawId: response.rawId + '=' }),
    // _x decodes to the same byte as canonical _w; accepting aliases would let
    // credential IDs acquire multiple string identities.
    response => ({ ...response, id: '_x', rawId: '_x' }),
    response => ({ ...response, id: b64(randomBytes(1024)), rawId: b64(randomBytes(1024)) }),
    response => ({ ...response, rawId: b64(randomBytes(32)) }),
    response => ({ ...response, response: { ...response.response, signature: b64(Buffer.alloc(81)) } }),
    response => ({ ...response, response: { ...response.response, clientDataJSON: b64('x'.repeat(4097)) } }),
    response => ({ ...response, response: { ...response.response, clientDataJSON: b64('{') } }),
    response => ({ ...response, response: { ...response.response, userHandle: b64(randomBytes(65)) } }),
    response => ({ ...response, unknown: true }),
    response => ({ ...response, clientExtensionResults: { huge: 'x'.repeat(4097) } }),
    response => ({ ...response, clientExtensionResults: null }),
    response => ({ ...response, clientExtensionResults: { values: Array.from({ length: 65 }, () => 0) } }),
    response => ({ ...response, clientExtensionResults: { a: { b: { c: { d: { e: { f: { g: { h: {} } } } } } } } } }),
    () => null,
  ]
  for (const change of cases) {
    const { claim, response } = ceremony('authentication'), malformed = change(response)
    await assert.rejects(verifyWebAuthn(refresh(claim, malformed), malformed), denied())
  }
  const sample = ceremony('authentication')
  let reads = 0
  Object.defineProperty(sample.response, 'id', { enumerable: true, get: () => { reads++; throw new Error('Should not execute accessor') } })
  await assert.rejects(verifyWebAuthn(sample.claim, sample.response), denied())
  assert.equal(reads, 0)
})

test('malformed registration bounds cannot produce a stored pending credential', async () => {
  for (const change of [
    { attestationObject: b64(Buffer.alloc(24577)) },
    { attestationObject: 'AA' },
    { publicKeyAlgorithm: -257 },
    { publicKey: b64(Buffer.alloc(2049)) },
    { transports: ['internal', 'internal'] },
    { transports: ['unknown-transport'] },
  ]) {
    const { claim, response } = ceremony('registration')
    const malformed = { ...response, response: { ...response.response, ...change } }
    await assert.rejects(verifyWebAuthn(refresh(claim, malformed), malformed), denied())
  }
})

test('untrusted malformed claims and library errors produce only sanitized verification errors', async () => {
  const { claim, response } = ceremony('authentication', { origin: 'https://private-challenge.example.test' })
  for (const change of [{ factor: null }, { sessionId: 'not-session' }, { userHandle: userHandle + '=' }, { credentialVersion: 0 },
    { responseDigest: 'invalid' }, { rpId: 'invalid RP' }]) {
    await assert.rejects(verifyWebAuthn({ ...claim, ...change } as MfaChallengeClaim, response), denied())
  }
  await assert.rejects(verifyWebAuthn(claim, response), (error: unknown) => {
    assert.ok(error instanceof MfaError)
    assert.equal(error.message, 'The passkey could not be verified. Start a new verification.')
    assert.equal(error.message.includes('private-challenge'), false)
    return true
  })
})
