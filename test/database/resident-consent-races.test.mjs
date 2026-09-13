import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { createConsentFixture } from '../helpers/resident-consent.mjs'
import { PostgresResidentConsentRepository } from '../../src/database/resident-consent.ts'
import { verifyConsentWebAuthn } from '../../src/auth/consent-webauthn.ts'

let f, repo, actor
before(async () => {
  f = await createConsentFixture()
  repo = new PostgresResidentConsentRepository(f.db.app, f.db.auth, { origin: f.origin, rpId: 'localhost', rpName: 'Synthetic' })
  actor = await f.consent.enroll(0)
  const job = await f.consent.createJob()
  await f.consent.configure(job.caseId, [actor])
})
after(async () => { await f?.close() })
async function publish(purpose = 'work') {
  const job = await f.consent.createJob()
  const published = await f.consent.publishRequest(job.caseId, purpose)
  return { ...job, ...published }
}
async function prepare(requestId, { command, expiresAt = Date.now() + 300000 } = {}) {
  const detail = await repo.getOwn(actor.principal, requestId)
  command ??= { action: 'grant', commandId: randomUUID(), requestId, requestVersion: detail.requestVersion,
    expectedDecisionVersion: detail.ownDecisionVersion, purpose: detail.purpose, termsDigest: detail.termsDigest, materialDigest: detail.materialDigest }
  const challenge = randomBytes(32).toString('base64url'), challengeId = randomUUID()
  await repo.beginGrant(actor.principal, { ...command, challengeId,
    challengeHash: createHash('sha256').update(challenge).digest('hex'), expiresAt })
  const response = actor.device.authenticationResponse({ challenge, origin: f.origin, rpId: 'localhost', userHandle: actor.userHandle })
  const claim = await repo.claimGrant(actor.principal, { challengeId, attemptId: randomUUID(),
    responseDigest: createHash('sha256').update(JSON.stringify(response)).digest('hex'), credentialId: response.id })
  return { command, claim, verified: await verifyConsentWebAuthn(claim, response) }
}
async function snapshot(requestId) {
  const decisions = await f.db.admin.query('SELECT count(*)::integer n FROM atrium.consent_decisions WHERE request_id=$1', [requestId])
  const factor = await f.db.admin.query('SELECT counter,counter_revision FROM atrium.mfa_factors WHERE id=$1', [actor.factorId])
  return { count: decisions.rows[0].n, ...factor.rows[0] }
}
async function waitBlocked() {
  for (let i = 0; i < 200; i++) {
    const result = await f.db.admin.query("SELECT count(*)::integer n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%atrium.consent_resident%' AND pid<>pg_backend_pid()")
    if (result.rows[0].n > 0) return
    await pause(10)
  }
  assert.fail('The expected consent operation did not reach the real lock barrier')
}
async function lockedProperty(work) {
  const blocker = await f.db.admin.connect()
  try { await blocker.query('BEGIN'); await blocker.query("SELECT id FROM atrium.properties WHERE id='property-a1' FOR UPDATE"); await work(blocker) }
  finally { await blocker.query('ROLLBACK'); blocker.release() }
}

test('two real zero-counter assertions for the same expected decision produce only one decision and counter revision', async () => {
  const job = await publish(), a = await prepare(job.receipt.id), b = await prepare(job.receipt.id, { command: a.command })
  assert.equal(a.claim.factor.counter, 0); assert.equal(b.claim.factor.counter, 0)
  const before = await snapshot(job.receipt.id)
  const results = await Promise.allSettled([repo.finishGrant(actor.principal, a.verified), repo.finishGrant(actor.principal, b.verified)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  const after = await snapshot(job.receipt.id)
  assert.equal(after.count, before.count + 1); assert.equal(BigInt(after.counter_revision), BigInt(before.counter_revision) + 1n)
  assert.equal((await repo.ownReceipt(actor.principal, a.command.commandId)).id, results.find(r => r.status === 'fulfilled').value.id)
})

test('an ordinary MFA assertion changes the same zero-counter revision and fences a pending consent assertion', async () => {
  const job = await publish(), prepared = await prepare(job.receipt.id)
  await f.consent.verifyLogin(actor)
  await assert.rejects(repo.finishGrant(actor.principal, prepared.verified), { code: 'consent_changed' })
  assert.equal((await snapshot(job.receipt.id)).count, 0)
  await assert.rejects(repo.finishGrant(actor.principal, structuredClone(prepared.verified)))
})

test('a ceremony expiring while blocked on the actual property fence commits neither decision nor factor update', async () => {
  const job = await publish(), deadline = Date.now() + 1500, prepared = await prepare(job.receipt.id, { expiresAt: deadline }), before = await snapshot(job.receipt.id)
  await lockedProperty(async blocker => {
    const result = repo.finishGrant(actor.principal, prepared.verified).then(value => ({ value }), error => ({ error }))
    await waitBlocked(); await pause(Math.max(0, deadline - Date.now()) + 40); await blocker.query('COMMIT')
    assert.equal((await result).error.code, 'consent_ceremony_used')
  })
  assert.deepEqual(await snapshot(job.receipt.id), before)
})

test('audit failure rolls back decision, shared passkey counter and challenge consumption atomically', async () => {
  const job = await publish(), prepared = await prepare(job.receipt.id), before = await snapshot(job.receipt.id)
  await f.db.admin.query('REVOKE INSERT ON atrium.consent_commands FROM atrium_consent_executor')
  try { await assert.rejects(repo.finishGrant(actor.principal, prepared.verified), { code: 'consent_unavailable' }) }
  finally { await f.db.admin.query('GRANT INSERT ON atrium.consent_commands TO atrium_consent_executor') }
  assert.deepEqual(await snapshot(job.receipt.id), before)
  const pending = await f.db.admin.query('SELECT consumed_at FROM atrium.consent_ceremonies WHERE id=$1', [prepared.claim.id])
  assert.equal(pending.rows[0].consumed_at, null)
  assert.equal((await repo.finishGrant(actor.principal, prepared.verified)).version, 1)
})

test('withdrawal preserves the earlier own grant for historical detail, paging and exact reduction', async () => {
  const job = await publish(), prepared = await prepare(job.receipt.id)
  await repo.finishGrant(actor.principal, prepared.verified)
  const prior = await repo.getOwn(actor.principal, job.receipt.id)
  await f.consent.staffSave(job.caseId, { action: 'withdraw_request', commandId: randomUUID(), requestId: prior.requestId, expectedVersion: prior.requestVersion, reason: 'Staff withdrew this proposed job request' })
  const current = await repo.getOwn(actor.principal, job.receipt.id)
  assert.equal(current.requestVersion, prior.requestVersion); assert.equal(current.currentTerms, false); assert.equal(current.canGrant, false); assert.equal(current.canRevoke, true)
  assert.equal(current.ownDecision.id, prior.ownDecision.id)
  const page = await repo.listOwn(actor.principal, { limit: 50 })
  assert.ok(page.items.some(item => item.requestId === prior.requestId && !item.currentTerms))
  const receipt = await repo.decideOwn(actor.principal, { action: 'revoke', commandId: randomUUID(), requestId: prior.requestId, requestVersion: prior.requestVersion,
    expectedDecisionVersion: prior.ownDecisionVersion, purpose: 'work', grantId: prior.ownDecision.grantId })
  assert.equal(receipt.version, prior.ownDecisionVersion + 1)
})

test('same-property different-unit roster manifests are refused without changing current authority', async () => {
  const job = await publish(), state = (await f.consent.staffState(job.caseId)).state
  const attempted = await f.consent.staffPost(job.caseId, { action: 'publish_roster', commandId: randomUUID(), expectedVersion: 0, policyVersion: state.policy.version,
    details: { unitId: 'different-unit', members: [], complete: true, protocolCompleted: true, source: f.consent.source() }, reason: 'This form belongs to another unit' })
  assert.equal(attempted.status, 409)
  const after = (await f.consent.staffState(job.caseId)).state
  assert.equal(after.roster.version, state.roster.version); assert.deepEqual(after.authorities, state.authorities)
})

test('source expiry during the final receipt insert wait rolls back a real signed decision and counter update', async () => {
  const job = await publish(), state = (await f.consent.staffState(job.caseId)).state
  const authority = state.authorities.find(a => a.userId === actor.principal.userId && a.purpose === 'work')
  const until = Date.now() + 2500
  await f.consent.staffSave(job.caseId, { action: 'save_authority', commandId: randomUUID(), id: authority.id, expectedVersion: authority.version, policyVersion: state.policy.version,
    details: { bindingId: authority.bindingId, bindingVersion: authority.bindingVersion, residentId: authority.residentId, residentVersion: authority.residentVersion, purpose: 'work', protocolCompleted: true,
      source: { ...f.consent.source(), validUntil: new Date(until).toISOString() } }, reason: 'Synthetic short current evidence tests expiry after waiting' })
  const currentRequest = await f.consent.publishRequest(job.caseId, 'work'), prepared = await prepare(currentRequest.receipt.id), before = await snapshot(currentRequest.receipt.id)
  const blocker = await f.db.admin.connect()
  try {
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE atrium.consent_commands IN ACCESS EXCLUSIVE MODE')
    const pending = repo.finishGrant(actor.principal, prepared.verified).then(value => ({ value }), error => ({ error }))
    await waitBlocked(); await pause(Math.max(0, until - Date.now()) + 40); await blocker.query('COMMIT')
    assert.equal((await pending).error.code, 'consent_changed')
  } finally { await blocker.query('ROLLBACK'); blocker.release() }
  assert.deepEqual(await snapshot(currentRequest.receipt.id), before)
})
