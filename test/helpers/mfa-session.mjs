import assert from 'node:assert/strict'
import { SoftwareAuthenticator } from './software-authenticator.mjs'

// Reserved, non-routable test origin; service-level fixtures perform no HTTP here.
export const TEST_AUTH_ORIGIN = 'https://atrium-fixture.example.test'
const devices = new Map()

/** Real service/crypto/SQL enrollment for prior privileged-session fixtures. */
export async function verifyMfaSession(runtime, principal, password, { force = false } = {}) {
  assert.ok(principal?.sessionId, 'MFA fixture requires an actual registered session')
  let state = await runtime.mfa.state(principal)
  if ((!state.required && !state.everEnabled && !force) || state.assurances.some(proof => proof.purpose === 'session_login')) return principal
  let factor = state.factors.find(factor => devices.has(factor.id))
  let device = factor && devices.get(factor.id)
  if (!factor) {
    assert.equal(state.factors.length, 0, 'Fixture cannot bypass an existing unknown passkey')
    const reauth = await runtime.mfa.password(principal, password)
    const options = await runtime.mfa.registrationOptions(principal, {
      label: 'Synthetic signed software fixture', reauthenticationId: reauth.id, recoveryGrantId: null,
    })
    device = new SoftwareAuthenticator()
    const receipt = await runtime.mfa.finish(principal, { kind: 'registration', challengeId: options.challengeId,
      response: device.registrationResponse({ challenge: options.optionsJSON.challenge, origin: runtime.authenticationOrigin, rpId: options.optionsJSON.rp.id }) })
    assert.equal(receipt.outcome, 'factor_pending')
    assert.equal(receipt.assurance, null)
    devices.set(receipt.factorId, device)
    state = await runtime.mfa.state(principal)
    factor = state.factors.find(factor => factor.id === receipt.factorId)
    assert.ok(factor)
  }
  const options = await runtime.mfa.authenticationOptions(principal, { purpose: 'session_login', factorId: factor.id })
  const receipt = await runtime.mfa.finish(principal, { kind: 'authentication', challengeId: options.challengeId,
    response: device.authenticationResponse({ challenge: options.optionsJSON.challenge, origin: runtime.authenticationOrigin,
      rpId: options.optionsJSON.rpId, userHandle: state.userHandle }) })
  assert.equal(receipt.outcome, 'verified')
  assert.equal(receipt.assurance?.sessionId, principal.sessionId)
  assert.equal(receipt.assurance?.purpose, 'session_login')
  await runtime.mfa.requireLogin(principal)
  return principal
}

export async function verifyMfaCookie(runtime, cookie, password) {
  const principal = await runtime.authenticate({ cookie }, new Date())
  assert.ok(principal, 'Fixture cookie must authenticate through the real session registry')
  return verifyMfaSession(runtime, principal, password)
}
