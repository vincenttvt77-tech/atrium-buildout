import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../../auth/identity.ts'
import { mintAccountFormToken } from '../../auth/account-request.ts'
import { mintServiceFormToken, verifyServiceFormToken } from '../request.ts'

const now = new Date('2026-09-13T00:00:00.000Z'), secret = 'synthetic-resident-service-form-secret-adequate-length'
const user = { id: 'synthetic-staff', username: 'synthetic-staff', displayName: 'Synthetic Staff', status: 'active' as const, credentialVersion: 1 }
const actor = issueAuthenticatedUser(user, { id: randomUUID(), expiresAt: now.getTime() + 3600_000 })
const scope = { organizationId: 'org-one', propertyId: 'property-one', configurationVersion: 1, permissionVersion: 'current-version' }

test('service forms bind the property, organization, configuration, permission, account and exact session', () => {
  const token = mintServiceFormToken(actor, scope, now, secret)
  assert.equal(verifyServiceFormToken(token, actor, scope, now, secret), true)
  for (const changes of [{ organizationId: 'other-org' }, { propertyId: 'other-property' }, { configurationVersion: 2 }, { permissionVersion: 'changed' }]) {
    assert.equal(verifyServiceFormToken(token, actor, { ...scope, ...changes }, now, secret), false)
  }
  for (const other of [issueAuthenticatedUser(user, { id: randomUUID(), expiresAt: actor.sessionExpiresAt! }),
    issueAuthenticatedUser({ ...user, id: 'other' }, { id: actor.sessionId!, expiresAt: actor.sessionExpiresAt! }),
    issueAuthenticatedUser({ ...user, credentialVersion: 2 }, { id: actor.sessionId!, expiresAt: actor.sessionExpiresAt! })]) {
    assert.equal(verifyServiceFormToken(token, other, scope, now, secret), false)
  }
  for (const bad of [null, '', token + 'extra', token.replace('~', '~x'), mintAccountFormToken(actor, now, secret), 'x'.repeat(1201)]) {
    assert.equal(verifyServiceFormToken(bad, actor, scope, now, secret), false)
  }
  assert.equal(verifyServiceFormToken(token, actor, scope, new Date(now.getTime() + 3600_000), secret), false)
})
