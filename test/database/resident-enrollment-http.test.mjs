import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createEnrollmentFixture } from '../helpers/resident-enrollment.mjs'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { PostgresResidentEnrollmentRepository } from '../../src/database/resident-enrollment.ts'
let f
before(async () => { f = await createEnrollmentFixture() }, { timeout: 120_000 })
after(async () => { await f?.close() })

test('staff enrollment pages fence actor/property and never render contact or verification evidence to residents', async () => {
  const residentId = f.residents['property-a1'][0], owner = f.actors['owner-a']
  const page = await f.request(`/api/resident-access?organizationId=organization-a&propertyId=property-a1&residentId=${residentId}`, { jar: owner.jar })
  assert.equal(page.status, 200); assert.match(page.text, /ATRIUM_RESIDENT_ACCESS/)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal((await f.request(`/api/resident-access?format=json&resource=state&residentId=${residentId}`, { jar: owner.jar, headers: f.staffHeaders(owner, 'property-a2') })).status, 409)
  assert.equal((await f.request(`/api/resident-access?format=json&resource=state&residentId=${residentId}`, { jar: f.actors['viewer-a'].jar, headers: f.staffHeaders(f.actors['viewer-a']) })).status, 403)
  const invite = await f.issue(residentId), { jar, state } = await f.exchange(invite.token)
  assert.deepEqual(Object.keys(state.invitation).sort(), ['expiresAt','invitationId','invitationVersion','propertyName','recipientHint','unitId'].sort())
  for (const value of [residentId, 'Synthetic completed in-person', 'Synthetic verified occupancy']) assert.ok(!JSON.stringify(state).includes(value))
  const preview = await f.request('/api/resident?format=json&resource=state&format=json', { jar })
  assert.equal(preview.status, 400)
})
test('invitation creation replay returns the saved receipt without manufacturing another handoff URL', async () => {
  const residentId = f.residents['property-a1'][1], invite = await f.issue(residentId)
  const replay = await f.staffSave(residentId, invite.command)
  assert.equal(replay.status, 200, replay.text)
  assert.equal(replay.json.receipt.id, invite.receipt.id); assert.equal(replay.json.receipt.replayed, true)
  assert.equal(replay.json.invitationUrl, undefined)
  const receipt = await f.request(`/api/resident-access?format=json&resource=receipt&residentId=${residentId}&requestId=${invite.command.requestId}`, {
    jar: f.actors['owner-a'].jar, headers: f.staffHeaders(),
  })
  assert.equal(receipt.status, 200); assert.equal(receipt.json.receipt.id, invite.receipt.id)
})
test('activation and sign-in require exact origin, browser form, action fields and reviewed invitation', async () => {
  const invite = await f.issue(f.residents['property-a1'][2]), { jar, state } = await f.exchange(invite.token)
  const command = { action: 'activate_new', requestId: randomUUID(), invitationVersion: state.invitation.invitationVersion, reviewToken: state.reviewToken,
    username: 'synthetic-http-new', displayName: 'Synthetic HTTP New', password: 'synthetic-new-resident-password' }
  for (const headers of [{ origin: 'https://other.example' }, { 'x-atrium-resident-form': 'bad' }, { 'x-atrium-user-id': 'owner-a' }, { 'content-type': 'application/x-www-form-urlencoded' }]) {
    const result = await f.request('/api/resident', { jar, body: command, headers: { ...f.residentHeaders(state), ...headers } })
    assert.ok([403,409].includes(result.status), result.text)
  }
  const extra = await f.residentPost(jar, { ...command, organizationId: 'organization-a' }, state)
  assert.equal(extra.status, 400)
  const review = await f.residentPost(jar, { ...command, reviewToken: 'invalid-review' }, state)
  assert.equal(review.status, 410)
  const accepted = await f.residentPost(jar, command, state)
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.json.signInRequired, true)
  assert.equal(accepted.headers.get('set-cookie'), null, 'Activation does not grant a session')
  assert.equal((await f.residentState(jar)).userId, null)
  const signed = await f.residentPost(jar, { action: 'sign_in', username: command.username, password: command.password })
  assert.equal(signed.status, 200, signed.text)
  assert.match(jar.get('atrium_resident_session'), /^r1\./); assert.equal(jar.has('atrium_ops'), false)
  const own = await f.residentState(jar)
  assert.equal(own.bindings.items.length, 1); assert.equal(own.bindings.items[0].residentId, f.residents['property-a1'][2])
  assert.equal((await f.residentPost(jar, { action: 'logout' }, state)).status, 403, 'Anonymous form cannot authorize a new signed-in account')
  const receipt = await f.request(`/api/resident?format=json&resource=receipt&requestId=${command.requestId}`, { jar })
  assert.equal(receipt.status, 200); assert.equal(receipt.json.receipt.bindingId, accepted.json.receipt.bindingId)
  assert.equal((await f.request('/api/properties', { jar })).status, 401)
  assert.equal((await f.residentPost(jar, { action: 'logout' })).status, 200)
  assert.equal((await f.residentState(jar)).userId, null)
})
test('existing dual-role account needs resident MFA and password; activation preserves credentials and memberships', async () => {
  const invite = await f.issue(f.residents['property-a1'][3]), { jar, state } = await f.exchange(invite.token)
  const before = (await f.db.admin.query(`SELECT (SELECT to_jsonb(c) FROM atrium.user_credentials c WHERE user_id='owner-a') AS credentials,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM atrium.memberships m WHERE user_id='owner-a') AS memberships`)).rows[0]
  const signed = await f.residentPost(jar, { action: 'sign_in', username: 'owner-a', password: f.password }, state)
  assert.equal(signed.status, 200)
  let current = await f.residentState(jar)
  assert.equal(current.mfaRequired, true); assert.equal(current.bindings, null)
  const mfa = await f.request('/api/resident?resource=mfa', { jar })
  assert.equal(mfa.status, 200); assert.ok(mfa.text.includes('/api/resident?resource=mfa')); assert.ok(!mfa.text.includes('Verify organization administration'))
  const principal = await f.runtime.authenticateResident({ cookie: `atrium_resident_session=${jar.get('atrium_resident_session')}` }, new Date())
  await verifyOrganizationSession(f.runtime, principal, f.password, { purpose: 'session_login' })
  current = await f.residentState(jar)
  const command = { action: 'activate_existing', requestId: randomUUID(), invitationVersion: current.invitation.invitationVersion, reviewToken: current.reviewToken, password: 'incorrect-password' }
  assert.equal((await f.residentPost(jar, command, current)).status, 400)
  const result = await f.residentPost(jar, { ...command, password: f.password }, current)
  assert.equal(result.status, 200, result.text)
  const after = (await f.db.admin.query(`SELECT (SELECT to_jsonb(c) FROM atrium.user_credentials c WHERE user_id='owner-a') AS credentials,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM atrium.memberships m WHERE user_id='owner-a') AS memberships`)).rows[0]
  assert.deepEqual(after, before)
  assert.equal((await f.request('/api/properties', { jar })).status, 401)
  const ownerCookie = new Map([...jar, ...f.actors['owner-a'].jar])
  const mixed = await f.residentState(ownerCookie)
  assert.equal(mixed.sessionId, principal.sessionId, 'Staff cookie must not select the resident identity')
})
test('revoked or browser-transferred invitations cannot activate, and no external operation is claimed or attempted', async () => {
  const residentId = f.residents['property-a1'][4], invite = await f.issue(residentId), { jar, state } = await f.exchange(invite.token)
  const transferred = new Map([['atrium_resident_invitation', jar.get('atrium_resident_invitation')]])
  assert.equal((await f.residentState(transferred)).invitation, null)
  const revoke = await f.staffSave(residentId, { action: 'revoke_invitation', requestId: randomUUID(), id: invite.receipt.id, expectedVersion: 1, reason: 'Recipient requested a new invitation' })
  assert.equal(revoke.status, 200, revoke.text)
  const result = await f.residentPost(jar, { action: 'activate_new', requestId: randomUUID(), invitationVersion: 1, reviewToken: state.reviewToken,
    username: 'must-not-be-created', displayName: 'Synthetic Revoked Recipient', password: 'synthetic-revoked-password' }, state)
  assert.equal(result.status, 410)
  assert.equal((await f.db.admin.query("SELECT 1 FROM atrium.users WHERE username='must-not-be-created'")).rowCount, 0)
  assert.deepEqual(f.errors, []); assert.deepEqual(f.remoteRequests, [])
})
test('MFA-held state and invitation exchange still reject a session revoked while the preview is loading', async () => {
  const invite = await f.issue(f.residents['property-a1'][5])
  for (const operation of ['state','exchange']) {
    const { jar } = await f.exchange(invite.token)
    assert.equal((await f.residentPost(jar, { action: 'sign_in', username: 'owner-a', password: f.password })).status, 200)
    const state = await f.residentState(jar)
    assert.equal(state.mfaRequired, true)
    const principal = await f.runtime.authenticateResident({ cookie: `atrium_resident_session=${jar.get('atrium_resident_session')}` }, new Date())
    const original = PostgresResidentEnrollmentRepository.prototype.preview
    let invalidated = false
    PostgresResidentEnrollmentRepository.prototype.preview = async function (...args) {
      const result = await original.apply(this, args)
      if (!invalidated) { invalidated = true; await f.runtime.sessions.revoke(principal, principal.sessionId) }
      return result
    }
    try {
      const result = operation === 'state' ? await f.request('/api/resident?format=json&resource=state', { jar })
        : await f.residentPost(jar, { action: 'exchange', token: invite.token }, state)
      assert.equal(result.status, 409, result.text)
      assert.equal(result.json.code, 'enrollment_changed')
      assert.equal(result.json.userId, undefined); assert.equal(result.json.invitation, undefined)
      assert.equal(result.headers.get('set-cookie'), null, 'A failed exchange must not install a new invitation context')
    } finally { PostgresResidentEnrollmentRepository.prototype.preview = original }
  }
})
