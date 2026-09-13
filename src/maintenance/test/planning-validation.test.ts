import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../../auth/identity.ts'
import { mintServiceFormToken } from '../request.ts'
import { mintPlanningFormToken, verifyPlanningFormToken } from '../planning-request.ts'
import { parsePlanningCommand, parsePolicyDetails, parsePlanDetails, parseVendorDetails } from '../planning-validation.ts'

const source = { sourceReference: 'Synthetic approved maintenance policy', observedAt: '2026-09-13T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z' }
const policy = () => ({ currency: 'USD', automaticLimitCents: 10_000, managerLimitCents: 50_000, ownerLimitCents: 100_000,
  automaticCategories: ['plumbing'], excludedCategories: ['access'], requireResidentApproval: true, requireIndependentApprover: true, ...source })
const plan = () => ({ route: 'internal', vendorId: null, vendorVersion: null, internalTeam: 'Maintenance staff',
  scopeOfWork: 'Replace washer', currency: 'USD', maximumCents: null, includesAllCharges: false, accessRequirement: 'no_unit_entry',
  restrictions: [], reason: 'Record scope before obtaining a fixed quote' })
const vendor = () => ({ name: 'Synthetic plumbing company', categories: ['plumbing'], status: 'approved', phone: '+15555550101', email: null,
  serviceArea: 'Selected property', hours: 'Weekday business hours', emergencyCoverage: false, availability: 'unknown',
  availabilityObservedAt: null, availabilityValidUntil: null, expectedPricing: '', responseTargetMinutes: null, preference: 0, restrictions: '', ...source })
const denied = (fn: () => unknown) => assert.throws(fn, { code: 'planning_invalid_input' })

test('money and disabled limits retain null, zero and integer semantics', () => {
  assert.equal(parsePlanDetails(plan()).maximumCents, null)
  assert.equal(parsePlanDetails({ ...plan(), maximumCents: 0 }).maximumCents, 0)
  for (const maximumCents of ['', '100', 1.2, -1, Infinity, NaN, 1_000_000_001]) denied(() => parsePlanDetails({ ...plan(), maximumCents }))
  const disabled = parsePolicyDetails({ ...policy(), automaticLimitCents: null, automaticCategories: [], managerLimitCents: null })
  assert.equal(disabled.automaticLimitCents, null); assert.equal(disabled.managerLimitCents, null)
  denied(() => parsePolicyDetails({ ...policy(), ownerLimitCents: null }))
})
test('delegated ceilings cannot exceed the owner ceiling or create conflicting category rules', () => {
  for (const changes of [{ automaticLimitCents: 100_001 }, { managerLimitCents: 100_001 },
    { automaticLimitCents: 50_001 }, { automaticLimitCents: null }, { excludedCategories: ['plumbing'] },
    { automaticCategories: ['plumbing', 'plumbing'] }, { requireIndependentApprover: 'false' }, { currency: 'EUR' }]) {
    denied(() => parsePolicyDetails({ ...policy(), ...changes }))
  }
})
test('canonical source review dates are bounded but original valid retries remain parseable', () => {
  assert.equal(parsePolicyDetails({ ...policy(), observedAt: '2020-01-01T00:00:00.000Z', validUntil: '2020-01-02T00:00:00.000Z' }).observedAt, '2020-01-01T00:00:00.000Z')
  denied(() => parsePolicyDetails({ ...policy(), validUntil: source.observedAt }))
  denied(() => parsePolicyDetails({ ...policy(), validUntil: '2028-01-01T00:00:00.000Z' }))
  denied(() => parsePolicyDetails({ ...policy(), observedAt: '2026-09-13' }))
  denied(() => parseVendorDetails({ ...vendor(), validUntil: '2027-01-01T00:00:00.000Z' }))
})
test('vendor approval needs a contact and availability never defaults to available', () => {
  assert.equal(parseVendorDetails(vendor()).availability, 'unknown')
  denied(() => parseVendorDetails({ ...vendor(), phone: null }))
  assert.equal(parseVendorDetails({ ...vendor(), status: 'suspended', phone: null }).phone, null)
  denied(() => parseVendorDetails({ ...vendor(), availability: 'available' }))
  denied(() => parseVendorDetails({ ...vendor(), availabilityObservedAt: source.observedAt, availabilityValidUntil: source.validUntil }))
  denied(() => parseVendorDetails({ ...vendor(), availability: 'available', availabilityObservedAt: source.observedAt, availabilityValidUntil: source.validUntil }))
  assert.equal(parseVendorDetails({ ...vendor(), availability: 'available', availabilityObservedAt: source.observedAt,
    availabilityValidUntil: '2026-09-14T00:00:00.000Z' }).availability, 'available')
})
test('an internal team and a versioned vendor are mutually exclusive routes', () => {
  assert.equal(parsePlanDetails(plan()).route, 'internal')
  denied(() => parsePlanDetails({ ...plan(), vendorId: 'vendor-one', vendorVersion: 1 }))
  denied(() => parsePlanDetails({ ...plan(), route: 'vendor', internalTeam: null, vendorId: 'vendor-one' }))
  assert.equal(parsePlanDetails({ ...plan(), route: 'vendor', internalTeam: null, vendorId: 'vendor-one', vendorVersion: 1 }).vendorVersion, 1)
})
test('finite commands refuse browser approval flags, invalid revisions and different creation identities', () => {
  const command = { action: 'prepare_plan', requestId: randomUUID(), caseId: 'case-one', expectedCaseVersion: 2, expectedPlanVersion: 0, policyVersion: 1, details: plan() }
  assert.equal(parsePlanningCommand(command).action, 'prepare_plan')
  for (const extra of [{ tier: 'automatic' }, { spendingAuthorized: true }, { proofId: randomUUID() }]) denied(() => parsePlanningCommand({ ...command, ...extra }))
  denied(() => parsePlanningCommand({ ...command, expectedCaseVersion: 0 }))
  denied(() => parsePlanningCommand({ ...command, expectedPlanVersion: -1 }))
  denied(() => parsePlanningCommand({ action: 'save_vendor', requestId: randomUUID(), id: 'vendor-one', expectedVersion: 0, details: vendor(), reason: 'Reviewed vendor' }))
  denied(() => parsePlanningCommand({ action: 'save_vendor', requestId: randomUUID(), id: null, expectedVersion: 1, details: vendor(), reason: 'Reviewed vendor' }))
})
test('planning forms reject copied service forms, scope changes, replacement sessions and expiry', () => {
  const now = new Date('2026-09-13T00:00:00.000Z'), secret = 'synthetic-maintenance-planning-token-secret-long-enough'
  const user = { id: 'owner-one', username: 'owner-one', displayName: 'Synthetic owner', status: 'active' as const, credentialVersion: 1 }
  const actor = issueAuthenticatedUser(user, { id: randomUUID(), expiresAt: now.getTime() + 3600_000 })
  const scope = { organizationId: 'org-one', propertyId: 'property-one', configurationVersion: 1, permissionVersion: 'current-version' }
  const token = mintPlanningFormToken(actor, scope, now, secret)
  assert.equal(verifyPlanningFormToken(token, actor, scope, now, secret), true)
  assert.equal(verifyPlanningFormToken(mintServiceFormToken(actor, scope, now, secret), actor, scope, now, secret), false)
  for (const change of [{ propertyId: 'other' }, { organizationId: 'other' }, { configurationVersion: 2 }, { permissionVersion: 'revoked' }]) {
    assert.equal(verifyPlanningFormToken(token, actor, { ...scope, ...change }, now, secret), false)
  }
  assert.equal(verifyPlanningFormToken(token, issueAuthenticatedUser(user, { id: randomUUID(), expiresAt: actor.sessionExpiresAt! }), scope, now, secret), false)
  assert.equal(verifyPlanningFormToken(token, actor, scope, new Date(now.getTime() + 3600_000), secret), false)
  for (const bad of [null, '', token + 'extra', token.replace('~', '~x'), 'x'.repeat(1201)]) assert.equal(verifyPlanningFormToken(bad, actor, scope, now, secret), false)
})
