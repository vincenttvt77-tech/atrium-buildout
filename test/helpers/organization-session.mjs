import assert from 'node:assert/strict'
import { SoftwareAuthenticator } from './software-authenticator.mjs'
const devices = new WeakMap()
/** Real passkey verification against the real runtime. Synthetic keys never leave this fixture. */
export async function verifyOrganizationSession(runtime, principal, password, { purpose = 'organization_administration' } = {}) {
  let known = devices.get(runtime)
  if (!known) { known = new Map(); devices.set(runtime, known) }
  let state = await runtime.mfa.state(principal)
  let factor = state.factors.find(value => known.has(value.id)), device = factor && known.get(factor.id)
  if (!factor) {
    assert.equal(state.factors.length, 0)
    const reauth = await runtime.mfa.password(principal, password)
    const options = await runtime.mfa.registrationOptions(principal, { label: 'Synthetic Team test passkey', reauthenticationId: reauth.id, recoveryGrantId: null })
    device = new SoftwareAuthenticator()
    const receipt = await runtime.mfa.finish(principal, { kind: 'registration', challengeId: options.challengeId,
      response: device.registrationResponse({ challenge: options.optionsJSON.challenge, origin: runtime.authenticationOrigin, rpId: options.optionsJSON.rp.id }) })
    assert.equal(receipt.outcome, 'factor_pending')
    known.set(receipt.factorId, device)
    state = await runtime.mfa.state(principal)
    factor = state.factors.find(value => value.id === receipt.factorId)
  }
  for (const currentPurpose of [...new Set(['session_login', purpose])]) {
    const options = await runtime.mfa.authenticationOptions(principal, { purpose: currentPurpose, factorId: factor.id })
    const receipt = await runtime.mfa.finish(principal, { kind: 'authentication', challengeId: options.challengeId,
      response: device.authenticationResponse({ challenge: options.optionsJSON.challenge, origin: runtime.authenticationOrigin,
        rpId: options.optionsJSON.rpId, userHandle: state.userHandle }) })
    assert.equal(receipt.outcome, 'verified')
    assert.equal(receipt.assurance.purpose, currentPurpose)
  }
  return principal
}
