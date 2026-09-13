import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../../auth/identity.ts'
import { createResidentEnrollmentService } from '../enrollment-service.ts'
import { parseEnrollmentStaffCommand, parseEnrollmentPolicy, validateResidentPassword } from '../enrollment-validation.ts'
import type { ResidentEnrollmentRepository, EnrollmentReservation, EnrollmentAcceptanceReceipt } from '../enrollment-model.ts'
import { createResidentBrowser, mintResidentBrowser, readResidentBrowser, mintResidentForm, verifyResidentForm,
  newEnrollmentToken, hashEnrollmentToken, mintResidentInvitation, readResidentInvitation, mintEnrollmentReview,
  verifyEnrollmentReview, mintEnrollmentStaffForm, verifyEnrollmentStaffForm, residentCookie } from '../enrollment-tokens.ts'

const now = new Date(), secret = 'synthetic-resident-enrollment-test-secret-only'
const user = { id: 'resident-one', username: 'resident-one', displayName: 'Synthetic Resident', credentialVersion: 1, status: 'active' as const }
const session = { id: randomUUID(), expiresAt: now.getTime() + 3_600_000 }
const resident = issueAuthenticatedUser(user, session, 'resident'), staff = issueAuthenticatedUser(user, session, 'staff')
const scope = { organizationId: 'org-one', propertyId: 'property-one', configurationVersion: 1, permissionVersion: 'current-version' }
const policy = { enabled: true, method: 'in_person_staff_check', protocol: 'Verify the recipient in person using the approved property protocol.',
  invitationLifetimeMinutes: 60, sourceReference: 'Synthetic policy reference', observedAt: now.toISOString(), validUntil: new Date(now.getTime() + 86_400_000).toISOString() }
const invitation = { invitationId: randomUUID(), invitationVersion: 1, propertyName: 'Synthetic Property', unitId: '19A',
  recipientHint: 'S••• R•••', expiresAt: new Date(now.getTime() + 1_800_000).toISOString() }
const passwordHash = 'scrypt$65536$8$1$sJl4quDnOuWgpsgheoICHw$N41jo_SyTN1lydYshkm-5kizyPqsHyK_YkIPEHOnMvc'

test('resident browser, form, invitation and review signatures cannot substitute for one another', () => {
  const browser = createResidentBrowser(now), cookie = mintResidentBrowser(browser, secret)
  assert.deepEqual(readResidentBrowser(cookie, now, secret), browser)
  const form = mintResidentForm(browser, resident, secret), raw = newEnrollmentToken()
  const context = { browserId: browser.id, tokenHash: hashEnrollmentToken(raw), expiresAt: browser.expiresAt }
  const invite = mintResidentInvitation(context, secret), review = mintEnrollmentReview(invitation, context, secret)
  assert.deepEqual(readResidentInvitation(invite, browser, now, secret), context)
  assert.equal(verifyResidentForm(form, browser, resident, now, secret), true)
  assert.equal(verifyEnrollmentReview(review, invitation, context, now, secret), true)
  for (const other of [form, invite, review]) assert.equal(readResidentBrowser(other, now, secret), null)
  for (const other of [cookie, invite, review]) assert.equal(verifyResidentForm(other, browser, resident, now, secret), false)
  for (const other of [cookie, form, review]) assert.equal(readResidentInvitation(other, browser, now, secret), null)
  assert.ok(!invite.includes(raw))
})
test('resident forms are rejected after browser, sign-in, user or session change', () => {
  const browser = createResidentBrowser(now), token = mintResidentForm(browser, resident, secret)
  assert.equal(verifyResidentForm(token, createResidentBrowser(now), resident, now, secret), false)
  assert.equal(verifyResidentForm(token, browser, null, now, secret), false)
  for (const changed of [issueAuthenticatedUser({ ...user, id: 'other-user' }, session, 'resident'),
    issueAuthenticatedUser(user, { ...session, id: randomUUID() }, 'resident')]) {
    assert.equal(verifyResidentForm(token, browser, changed, now, secret), false)
  }
  const anonymous = mintResidentForm(browser, null, secret)
  assert.equal(verifyResidentForm(anonymous, browser, resident, now, secret), false)
  assert.throws(() => mintResidentForm(browser, staff, secret), { code: 'enrollment_forbidden' })
})
test('invitation review binds exact visible facts and finite browser/invitation lifetime', () => {
  const browser = createResidentBrowser(now), context = { browserId: browser.id, tokenHash: hashEnrollmentToken(newEnrollmentToken()), expiresAt: browser.expiresAt }
  const cookie = mintResidentInvitation(context, secret), review = mintEnrollmentReview(invitation, context, secret)
  for (const patch of [{ invitationVersion: 2 }, { invitationId: randomUUID() }, { unitId: '20B' }, { propertyName: 'Other Property' },
    { recipientHint: 'Another person' }, { expiresAt: new Date(now.getTime() + 600_000).toISOString() }]) {
    assert.equal(verifyEnrollmentReview(review, { ...invitation, ...patch }, context, now, secret), false)
  }
  assert.equal(readResidentInvitation(cookie, createResidentBrowser(now), now, secret), null)
  assert.equal(readResidentInvitation(cookie, browser, new Date(browser.expiresAt), secret), null)
  assert.equal(verifyEnrollmentReview(review, invitation, context, new Date(browser.expiresAt), secret), false)
  assert.equal(verifyEnrollmentReview(review, invitation, { ...context, tokenHash: 'b'.repeat(64) }, now, secret), false)
})
test('staff enrollment form binds property, policy permission, resident, session and credential version', () => {
  const id = randomUUID(), token = mintEnrollmentStaffForm(staff, scope, id, now, secret)
  assert.equal(verifyEnrollmentStaffForm(token, staff, scope, id, now, secret), true)
  for (const changed of [{ ...scope, propertyId: 'other' }, { ...scope, organizationId: 'other' }, { ...scope, configurationVersion: 2 }, { ...scope, permissionVersion: 'changed' }]) {
    assert.equal(verifyEnrollmentStaffForm(token, staff, changed, id, now, secret), false)
  }
  assert.equal(verifyEnrollmentStaffForm(token, staff, scope, randomUUID(), now, secret), false)
  assert.equal(verifyEnrollmentStaffForm(token, issueAuthenticatedUser({ ...user, credentialVersion: 2 }, session), scope, id, now, secret), false)
  assert.throws(() => verifyEnrollmentStaffForm(token, resident, scope, id, now, secret), { code: 'forbidden' })
})
test('malformed, noncanonical, tampered and expired browser tokens are rejected', () => {
  const browser = createResidentBrowser(now), token = mintResidentBrowser(browser, secret)
  for (const value of ['', token + '=', token.slice(0, -2), token + '.extra', 'x'.repeat(4097), token.replace(/^./, 'z')]) {
    assert.equal(readResidentBrowser(value, now, secret), null)
  }
  assert.equal(readResidentBrowser(token, new Date(browser.expiresAt), secret), null)
  assert.equal(readResidentBrowser(token, new Date(now.getTime() - 1), secret), null)
  assert.equal(readResidentBrowser(token, now, 'wrong-signature-secret-long-enough'), null)
  for (const value of ['', 'a'.repeat(42), 'a'.repeat(43) + '=', 'a'.repeat(42) + 'b']) assert.throws(() => hashEnrollmentToken(value))
  assert.match(residentCookie('atrium_resident_session', 'r1.test.token', true, 60), /HttpOnly; SameSite=Strict; Max-Age=60; Secure$/)
  assert.throws(() => residentCookie('atrium_ops', 'anything', true, 60))
  assert.throws(() => residentCookie('atrium_resident_session', 'token; Path=/', true, 60))
})
test('policy and invitation validation rejects missing verification, unsupported methods, excess fields and unbounded lifetime', () => {
  assert.deepEqual(parseEnrollmentPolicy(policy), policy)
  for (const patch of [{ method: 'phone_match' }, { invitationLifetimeMinutes: 0 }, { invitationLifetimeMinutes: 1441 },
    { protocol: 'check' }, { sourceReference: '' }, { admin: true }, { validUntil: new Date(now.getTime() + 91 * 86_400_000).toISOString() }]) {
    assert.throws(() => parseEnrollmentPolicy({ ...policy, ...patch }), { code: 'enrollment_invalid_input' })
  }
  const command = { action: 'issue_invitation', requestId: randomUUID(), residentId: randomUUID(), expectedResidentVersion: 1,
    expectedPolicyVersion: 1, replaces: null, checkedAt: now.toISOString(), evidenceReference: 'Synthetic verification reference', protocolCompleted: true, reason: 'Recipient requested access' }
  assert.deepEqual(parseEnrollmentStaffCommand(command), command)
  for (const patch of [{ protocolCompleted: false }, { expectedResidentVersion: 0 }, { residentId: '19A' }, { password: 'staff-owned' }, { replaces: { id: randomUUID(), version: 0 } }]) {
    assert.throws(() => parseEnrollmentStaffCommand({ ...command, ...patch }), { code: 'enrollment_invalid_input' })
  }
  assert.equal(validateResidentPassword('😀'.repeat(15), true), '😀'.repeat(15))
  for (const value of ['😀'.repeat(14), 'x'.repeat(257), '\ud800'.repeat(20)]) assert.throws(() => validateResidentPassword(value, true))
})

function acceptance(options: { existing?: boolean; completed?: boolean; wrongPassword?: boolean; patch?: Partial<EnrollmentReservation>; rateLimited?: boolean; failFinalize?: boolean } = {}) {
  const calls: string[] = [], requestId = randomUUID(), invitationId = randomUUID(), userId = options.existing ? user.id : randomUUID()
  const input = { mode: options.existing ? 'existing' as const : 'new' as const, requestId, tokenHash: 'a'.repeat(64), browserHash: 'b'.repeat(64),
    clientKey: 'c'.repeat(64), clientAddress: '127.0.0.1', invitationVersion: 1, username: 'new-resident', displayName: 'Synthetic New Resident', password: 'synthetic-long-password' }
  const saved: EnrollmentAcceptanceReceipt = { requestId, invitationId, bindingId: randomUUID(), bindingVersion: 1,
    organizationId: scope.organizationId, propertyId: scope.propertyId, residentId: randomUUID(), userId, activatedAt: new Date().toISOString(), replayed: !!options.completed }
  const reservation: EnrollmentReservation = { id: randomUUID(), requestId, invitationId, userId, mode: input.mode,
    tokenHash: input.tokenHash, browserHash: input.browserHash, invitationVersion: 1,
    username: options.existing ? user.username : input.username, displayName: options.existing ? user.displayName : input.displayName,
    credentialVersion: 1, sessionId: options.existing ? session.id : null,
    passwordHash: options.existing || options.completed ? passwordHash : null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), completedReceipt: options.completed ? saved : null, ...options.patch }
  const repository = { async reserveAcceptance() { calls.push('reserve'); return reservation },
    async acceptNew(_r: EnrollmentReservation, credentials: { passwordHash: string }) { calls.push('accept-new'); assert.equal(credentials.passwordHash, passwordHash); if (options.failFinalize) throw new Error('Authority changed during password work'); return saved },
    async acceptExisting() { calls.push('accept-existing'); if (options.failFinalize) throw new Error('Authority changed during password work'); return saved },
  } as unknown as ResidentEnrollmentRepository
  const service = createResidentEnrollmentService(repository, {
    async reserveLogin() { calls.push('limit'); if (options.rateLimited) throw new Error('Limit reached') },
    async requireResidentLogin() { calls.push('mfa') }, async requireStaffAdministration() { throw new Error('Not staff') },
  }, { async hash() { calls.push('hash'); return passwordHash }, async verify() { calls.push('verify'); return !options.wrongPassword } })
  return { service, input, saved, calls, principal: options.existing ? resident : null }
}
test('new account creation reserves budgets before hashing and delegates one atomic acceptance without leaking credentials', async () => {
  const value = acceptance(), result = await value.service.accept(null, value.input)
  assert.deepEqual(value.calls, ['limit','reserve','hash','accept-new'])
  assert.deepEqual(result, value.saved)
  assert.ok(!JSON.stringify(result).includes(passwordHash))
})
test('rate limits stop account and password work before a reservation or expensive cryptography', async () => {
  const value = acceptance({ rateLimited: true })
  await assert.rejects(value.service.accept(null, value.input), /Limit reached/)
  assert.deepEqual(value.calls, ['limit'])
})
test('existing-account activation uses current resident identity and verifies its password without overwriting it', async () => {
  const value = acceptance({ existing: true })
  assert.deepEqual(await value.service.accept(value.principal, value.input), value.saved)
  assert.deepEqual(value.calls, ['mfa','limit','reserve','verify','accept-existing'])
  const wrong = acceptance({ existing: true, wrongPassword: true })
  await assert.rejects(wrong.service.accept(wrong.principal, wrong.input), { code: 'enrollment_password_incorrect' })
  assert.deepEqual(wrong.calls, ['mfa','limit','reserve','verify'])
})
test('completed new-account retry verifies the established password then rechecks authority after crypto', async () => {
  const value = acceptance({ completed: true })
  assert.deepEqual(await value.service.accept(null, value.input), value.saved)
  assert.deepEqual(value.calls, ['limit','reserve','verify','accept-new'])
  const wrong = acceptance({ completed: true, wrongPassword: true })
  await assert.rejects(wrong.service.accept(null, wrong.input), { code: 'enrollment_reconcile_required' })
  assert.deepEqual(wrong.calls, ['limit','reserve','verify'])
  for (const existing of [true, false]) {
    const changed = acceptance({ existing, completed: true, failFinalize: true })
    await assert.rejects(changed.service.accept(changed.principal, changed.input), /Authority changed/)
  }
})
test('substituted or expired reservations are refused before passwords can be hashed or verified', async () => {
  for (const patch of [{ tokenHash: 'd'.repeat(64) }, { browserHash: 'd'.repeat(64) }, { requestId: randomUUID() },
    { username: 'other' }, { displayName: 'Another Resident' }, { invitationVersion: 2 }, { expiresAt: new Date(0).toISOString() }, { passwordHash: 'malformed' }]) {
    const value = acceptance({ patch })
    await assert.rejects(value.service.accept(null, value.input))
    assert.deepEqual(value.calls, ['limit','reserve'])
  }
})
test('a staff session cannot be used for existing resident activation and a signed-in resident cannot create another account', async () => {
  const existing = acceptance({ existing: true })
  await assert.rejects(existing.service.accept(staff, existing.input), { code: 'enrollment_forbidden' })
  assert.deepEqual(existing.calls, [])
  const fresh = acceptance()
  await assert.rejects(fresh.service.accept(resident, fresh.input), { code: 'enrollment_invalid_input' })
  assert.deepEqual(fresh.calls, [])
})
