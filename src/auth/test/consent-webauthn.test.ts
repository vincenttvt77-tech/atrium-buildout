import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { verifyConsentWebAuthn, assertVerifiedConsentWebAuthn } from '../consent-webauthn.ts'
import type { ConsentWebAuthnClaim } from '../consent-webauthn.ts'
import { verifyWebAuthn, assertVerifiedWebAuthn, verifyAuthenticationAssertion } from '../webauthn.ts'
import type { MfaChallengeClaim, MfaFactor } from '../mfa-model.ts'
import { MfaError } from '../mfa-model.ts'
// @ts-expect-error Shared JavaScript test fixture; genuine signatures, not a physical device.
import { SoftwareAuthenticator } from '../../../test/helpers/software-authenticator.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const config = { origin: 'https://resident.example.test', rpId: 'example.test' }
const rejected = (code = 'verification_failed') => (error: unknown) => error instanceof MfaError && error.code === code
function fixture(options: Record<string, unknown> = {}, changes: Partial<ConsentWebAuthnClaim> = {}, factorChanges: Partial<MfaFactor> = {}) {
  const device = new SoftwareAuthenticator(), challenge = randomBytes(32).toString('base64url')
  const userHandle = randomBytes(32).toString('base64url')
  const response = device.authenticationResponse({ ...config, challenge, userHandle, ...options })
  const factor: MfaFactor = { id: randomUUID(), label: 'Synthetic resident passkey', credentialId: device.credentialId,
    publicKey: device.publicKey, counter: 0, counterRevision: 2, status: 'active', backupEligible: false,
    backedUp: false, transports: ['usb'], createdAt: Date.now(), lastUsedAt: null, ...factorChanges }
  const claim: ConsentWebAuthnClaim = { id: randomUUID(), attemptId: randomUUID(), responseDigest: hash(JSON.stringify(response)),
    challengeHash: hash(challenge), userId: 'resident-user', sessionId: randomUUID(), credentialVersion: 1, securityVersion: 3,
    ...config, userHandle, expiresAt: Date.now() + 60000, factor, audience: 'resident', organizationId: 'organization-a',
    propertyId: 'property-a', requestId: randomUUID(), requestVersion: 2, purpose: 'work', termsDigest: hash('exact reviewed terms'),
    materialDigest: hash('exact job dependencies'), commandId: randomUUID(), expectedDecisionVersion: 0, ...changes }
  return { device, challenge, response, claim }
}

test('a real resident assertion produces a distinct immutable exact-context proof', async () => {
  for (const purpose of ['work', 'entry'] as const) {
    const { claim, response } = fixture({ counter: 1 }, { purpose })
    const proof = await verifyConsentWebAuthn(claim, response)
    assertVerifiedConsentWebAuthn(proof)
    assert.equal(proof.kind, 'resident_consent')
    assert.equal(proof.newCounter, 1)
    assert.deepEqual(proof.claim, claim)
    assert.equal(proof.claim.factor.counterRevision, 2)
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.claim) && Object.isFrozen(proof.claim.factor.transports))
    for (const fake of [null, { ...proof }, structuredClone(proof), JSON.parse(JSON.stringify(proof))]) {
      assert.throws(() => assertVerifiedConsentWebAuthn(fake), rejected())
    }
    assert.throws(() => assertVerifiedWebAuthn(proof), rejected())
  }
})

test('generic MFA proofs and bare cryptographic results cannot authorize consent', async () => {
  const { claim, response } = fixture()
  const generic: MfaChallengeClaim = { id: claim.id, attemptId: claim.attemptId, responseDigest: claim.responseDigest,
    challengeHash: claim.challengeHash, userId: claim.userId, sessionId: claim.sessionId,
    credentialVersion: claim.credentialVersion, securityVersion: claim.securityVersion, ...config,
    userHandle: claim.userHandle, expiresAt: claim.expiresAt, factor: claim.factor,
    kind: 'authentication', intent: 'verify', purpose: 'session_login' }
  const proof = await verifyWebAuthn(generic, response)
  assertVerifiedWebAuthn(proof)
  assert.throws(() => assertVerifiedConsentWebAuthn(proof), rejected())
  await assert.rejects(verifyConsentWebAuthn(generic as unknown as ConsentWebAuthnClaim, response), rejected())
  await assert.rejects(verifyWebAuthn(claim as unknown as MfaChallengeClaim, response), rejected())
  const bare = await verifyAuthenticationAssertion(claim, response)
  assert.throws(() => assertVerifiedConsentWebAuthn(bare), rejected())
  assert.throws(() => assertVerifiedWebAuthn(bare), rejected())
})

test('consent rejects pending factors without changing ordinary MFA bootstrap behavior', async () => {
  const { claim, response } = fixture({}, {}, { status: 'pending' })
  await assert.rejects(verifyConsentWebAuthn(claim, response), rejected())
})

test('wrong audience, purpose, manifest selectors and malformed decision versions cannot mint proof', async () => {
  const bad: Record<string, unknown>[] = [
    { audience: 'staff' }, { purpose: 'session_login' }, { purpose: 'entry_and_work' },
    { organizationId: '' }, { propertyId: '../other' }, { requestId: 'request' },
    { commandId: 'operation' }, { id: 'ceremony' }, { attemptId: 'attempt' },
    { requestVersion: 0 }, { requestVersion: 1.5 }, { expectedDecisionVersion: -1 },
    { expectedDecisionVersion: '0' }, { expectedDecisionVersion: Number.MAX_SAFE_INTEGER + 1 },
    { termsDigest: 'a'.repeat(63) }, { termsDigest: 'A'.repeat(64) }, { materialDigest: null },
    { credentials: 'must not become claim data' }, { kind: 'authentication' },
  ]
  for (const change of bad) {
    const { claim, response } = fixture()
    await assert.rejects(verifyConsentWebAuthn({ ...claim, ...change } as ConsentWebAuthnClaim, response), rejected())
  }
})

test('real signatures still require exact origin, RP, challenge, user handle and assertion type', async () => {
  for (const options of [{ origin: 'https://attacker.example.test' }, { rpId: 'other.test' },
    { challenge: randomBytes(32).toString('base64url') }, { userHandle: randomBytes(32).toString('base64url') },
    { type: 'webauthn.create' }, { crossOrigin: true }, { topOrigin: 'https://other.test' }]) {
    const { claim, response } = fixture(options)
    await assert.rejects(verifyConsentWebAuthn(claim, response), rejected())
  }
})

test('correctly signed assertions require user presence and verification', async () => {
  for (const options of [{ uv: false }, { up: false }, { uv: false, up: false }]) {
    const { claim, response } = fixture(options)
    await assert.rejects(verifyConsentWebAuthn(claim, response), rejected())
  }
})

test('forged signatures and tampered response bytes are rejected', async () => {
  const wrongKey = fixture({ signer: new SoftwareAuthenticator() })
  await assert.rejects(verifyConsentWebAuthn(wrongKey.claim, wrongKey.response), rejected())
  for (const key of ['signature', 'authenticatorData']) {
    const { claim, response } = fixture()
    const bytes = Buffer.from(response.response[key], 'base64url')
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    response.response[key] = bytes.toString('base64url')
    claim.responseDigest = hash(JSON.stringify(response))
    await assert.rejects(verifyConsentWebAuthn(claim, response), rejected())
  }
  const mismatch = fixture()
  mismatch.claim.responseDigest = '0'.repeat(64)
  await assert.rejects(verifyConsentWebAuthn(mismatch.claim, mismatch.response), rejected())
})

test('factor counter and backup state are verified while SQL owns the shared revision race', async () => {
  for (const [counter, next] of [[0, 0], [0, 1], [5, 6]] as const) {
    const { claim, response } = fixture({ counter: next }, {}, { counter })
    const proof = await verifyConsentWebAuthn(claim, response)
    assert.equal(proof.newCounter, next)
    assert.equal(proof.claim.factor.counterRevision, 2)
  }
  for (const [counter, next] of [[2, 2], [2, 0], [5, 4]] as const) {
    const { claim, response } = fixture({ counter: next }, {}, { counter })
    await assert.rejects(verifyConsentWebAuthn(claim, response), rejected())
  }
  const changed = fixture({ backupEligible: true })
  await assert.rejects(verifyConsentWebAuthn(changed.claim, changed.response), rejected())
  const backedUp = fixture({ backupEligible: true, backedUp: true }, {}, { backupEligible: true })
  assert.equal((await verifyConsentWebAuthn(backedUp.claim, backedUp.response)).backedUp, true)
})

test('the complete claim and response detach before asynchronous verification', async () => {
  const { claim, response } = fixture()
  const original = structuredClone(claim), pending = verifyConsentWebAuthn(claim, response)
  claim.requestId = randomUUID(); claim.purpose = 'entry'; claim.termsDigest = '1'.repeat(64)
  claim.expectedDecisionVersion = 99; claim.factor.publicKey = 'changed'; response.id = 'changed'
  const proof = await pending
  assert.deepEqual(proof.claim, original)
})

test('expired attempts fail both before and after actual asynchronous verification', async t => {
  const expired = fixture({}, { expiresAt: Date.now() - 1 })
  await assert.rejects(verifyConsentWebAuthn(expired.claim, expired.response), rejected('challenge_expired'))
  const { claim, response } = fixture(), now = Date.now()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  claim.expiresAt = now + 1000
  const pending = verifyConsentWebAuthn(claim, response)
  clock += 1000
  await assert.rejects(pending, rejected('challenge_expired'))
})

test('accessors and unbounded nested wire data are refused without invoking application code', async () => {
  const { claim, response } = fixture()
  let called = false
  const accessor = { ...claim }
  Object.defineProperty(accessor, 'termsDigest', { enumerable: true, get() { called = true; return claim.termsDigest } })
  await assert.rejects(verifyConsentWebAuthn(accessor, response), rejected())
  assert.equal(called, false)
  const oversized = structuredClone(response)
  oversized.clientExtensionResults.extra = 'a'.repeat(40000)
  await assert.rejects(verifyConsentWebAuthn(claim, oversized), rejected())
})
