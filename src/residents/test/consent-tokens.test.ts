import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../../auth/identity.ts'
import type { User } from '../../auth/model.ts'
import { mintAccountFormToken } from '../../auth/account-request.ts'
import { mintConsentForm, verifyConsentForm } from '../consent-tokens.ts'
import { mintEnrollmentStaffForm } from '../enrollment-tokens.ts'

const secret = 'synthetic-consent-transport-secret-not-for-deployment'
const now = new Date()
const user: User = { id: 'synthetic-consent-user', username: 'consent-user', displayName: 'Synthetic Person', status: 'active', credentialVersion: 1 }
const session = { id: randomUUID(), expiresAt: now.getTime() + 8 * 60 * 60 * 1000 }
const staff = issueAuthenticatedUser(user, session, 'staff'), resident = issueAuthenticatedUser(user, session, 'resident')
const scope = { organizationId: 'organization-a', propertyId: 'property-a', configurationVersion: 2, permissionVersion: 'permission-v1' }
const caseId = randomUUID()

test('resident and staff consent forms cannot cross audiences even for the same user and SID', () => {
  const own = mintConsentForm(resident, null, null, now, secret), team = mintConsentForm(staff, scope, caseId, now, secret)
  assert.equal(verifyConsentForm(own, resident, null, null, now, secret), true)
  assert.equal(verifyConsentForm(team, staff, scope, caseId, now, secret), true)
  assert.equal(verifyConsentForm(own, staff, scope, caseId, now, secret), false)
  assert.equal(verifyConsentForm(team, resident, null, null, now, secret), false)
  assert.throws(() => mintConsentForm(resident, scope, caseId, now, secret))
  assert.throws(() => mintConsentForm(staff, null, null, now, secret))
})

test('staff forms bind the current property, configuration, grant revision and exact case', () => {
  const token = mintConsentForm(staff, scope, caseId, now, secret)
  for (const changed of [{ organizationId: 'organization-b' }, { propertyId: 'property-b' },
    { configurationVersion: 3 }, { permissionVersion: 'permission-v2' }]) {
    assert.equal(verifyConsentForm(token, staff, { ...scope, ...changed }, caseId, now, secret), false)
  }
  assert.equal(verifyConsentForm(token, staff, scope, randomUUID(), now, secret), false)
})

test('new identities, credential rotations and different registered sessions reject old forms', () => {
  for (const principal of [staff, resident]) {
    const selected = principal.audience === 'staff' ? scope : null, target = selected ? caseId : null
    const token = mintConsentForm(principal, selected, target, now, secret)
    const candidates = [issueAuthenticatedUser({ ...user, id: 'different-person' }, session, principal.audience),
      issueAuthenticatedUser({ ...user, credentialVersion: 2 }, session, principal.audience),
      issueAuthenticatedUser(user, { ...session, id: randomUUID() }, principal.audience)]
    for (const candidate of candidates) assert.equal(verifyConsentForm(token, candidate, selected, target, now, secret), false)
    assert.equal(verifyConsentForm(token, { ...principal }, selected, target, now, secret), false)
  }
})

test('form expiry is bounded by both a short form lifetime and the current session', () => {
  const token = mintConsentForm(resident, null, null, now, secret)
  assert.equal(verifyConsentForm(token, resident, null, null, new Date(now.getTime() + 30 * 60 * 1000 - 1), secret), true)
  assert.equal(verifyConsentForm(token, resident, null, null, new Date(now.getTime() + 30 * 60 * 1000), secret), false)
  const short = issueAuthenticatedUser(user, { ...session, expiresAt: now.getTime() + 1000 }, 'resident')
  const shortToken = mintConsentForm(short, null, null, now, secret)
  assert.equal(verifyConsentForm(shortToken, short, null, null, new Date(now.getTime() + 1000), secret), false)
  assert.throws(() => mintConsentForm(short, null, null, new Date(now.getTime() + 1000), secret))
  assert.equal(verifyConsentForm(token, resident, null, null, new Date(NaN), secret), false)
})

test('other form purposes, altered payload/signature and noncanonical encodings are refused', () => {
  const token = mintConsentForm(staff, scope, caseId, now, secret), [payload, signature] = token.split('.')
  const variants = [null, [token], '', 'x'.repeat(4097), `${payload}=.${signature}`, `${payload}.${signature}=`,
    `${payload}.${signature!.slice(0, 42)}${signature!.endsWith('A') ? 'B' : 'A'}`,
    mintAccountFormToken(staff, now, secret), mintEnrollmentStaffForm(staff, scope, caseId, now, secret)]
  const fields = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
  fields[5] = 'another-property'
  variants.push(`${Buffer.from(JSON.stringify(fields)).toString('base64url')}.${signature}`)
  for (const value of variants) assert.equal(verifyConsentForm(value, staff, scope, caseId, now, secret), false)
  assert.equal(verifyConsentForm(token, staff, scope, caseId, now, secret + 'changed'), false)
})
