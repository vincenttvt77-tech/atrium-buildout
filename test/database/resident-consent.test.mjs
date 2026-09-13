import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createConsentFixture } from '../helpers/resident-consent.mjs'
import { PostgresResidentConsentRepository } from '../../src/database/resident-consent.ts'

let f, repository, actor, other, job, work, entry
before(async () => {
  f = await createConsentFixture()
  for (const connection of [f.db.app, f.db.auth]) {
    const transaction = connection.transaction.bind(connection)
    connection.transaction = (context, work) => transaction(context, async client => {
      const query = client.query.bind(client)
      client.query = async (...args) => { try { return await query(...args) } catch (error) {
        console.error('consent native SQL diagnostic', { code: error.code, routine: error.routine, table: error.table, constraint: error.constraint }); throw error
      } }
      try { return await work(client) } finally { client.query = query }
    })
  }
  repository = new PostgresResidentConsentRepository(f.db.app, f.db.auth, { origin: f.origin, rpId: 'localhost', rpName: 'Synthetic Atrium' })
  actor = await f.consent.enroll(0)
  other = await f.consent.enroll(1)
  job = await f.consent.createJob()
  await f.consent.configure(job.caseId, [actor, other])
  work = await f.consent.publishRequest(job.caseId, 'work')
  entry = await f.consent.publishRequest(job.caseId, 'entry')
})
after(async () => { await f?.close() })

test('published work and entry have independent IDs with one material job fingerprint and complete recipients', async () => {
  const state = (await f.consent.staffState(job.caseId)).state
  assert.equal(state.residents.length, 6)
  const [w, e] = state.purposes
  assert.notEqual(w.request.id, e.request.id)
  assert.equal(w.request.materialDigest, e.request.materialDigest)
  assert.notEqual(w.request.termsDigest, e.request.termsDigest)
  assert.equal(w.recipients.length, 2)
  assert.equal(w.effectiveness.effective, false)
  const own = await repository.getOwn(actor.principal, work.receipt.id)
  assert.equal(own.terms.residentChargeCents, 0)
  assert.equal(own.terms.propertyMaximumCents, 10000)
  assert.equal(own.currentTerms, true)
  assert.doesNotMatch(JSON.stringify(own), /reviewed household|Synthetic Recipient property-a1 1|passwordHash|publicKey|source_reference/)
})

test('actual resident passkeys grant exact work; one household decision alone is insufficient', async () => {
  await f.consent.grant(actor, work.receipt.id)
  assert.equal((await repository.getOwn(actor.principal, work.receipt.id)).effectiveness.effective, false)
  await f.consent.grant(other, work.receipt.id)
  const detail = await repository.getOwn(actor.principal, work.receipt.id)
  assert.equal(detail.effectiveness.effective, true)
  assert.equal(detail.ownDecision.grantId, detail.ownDecision.id)
  assert.equal((await repository.getOwn(actor.principal, entry.receipt.id)).effectiveness.effective, false)
})

test('own grant can be declined, reconsidered and revoked only by its exact current grant ID', async () => {
  let d = await repository.getOwn(actor.principal, work.receipt.id)
  const oldGrant = d.ownDecision.grantId
  const decline = { action: 'decline', commandId: randomUUID(), requestId: d.requestId, requestVersion: d.requestVersion,
    expectedDecisionVersion: d.ownDecisionVersion, purpose: d.purpose, termsDigest: d.termsDigest }
  const first = await repository.decideOwn(actor.principal, decline)
  const retry = await repository.decideOwn(actor.principal, decline)
  assert.equal(retry.id, first.id); assert.equal(retry.replayed, true)
  assert.equal((await repository.getOwn(actor.principal, work.receipt.id)).effectiveness.effective, false)
  await f.consent.grant(actor, work.receipt.id)
  d = await repository.getOwn(actor.principal, work.receipt.id)
  const revoke = { action: 'revoke', commandId: randomUUID(), requestId: d.requestId, requestVersion: d.requestVersion,
    expectedDecisionVersion: d.ownDecisionVersion, purpose: d.purpose, grantId: oldGrant }
  await assert.rejects(repository.decideOwn(actor.principal, revoke), { code: 'consent_changed' })
  const saved = await repository.decideOwn(actor.principal, { ...revoke, commandId: randomUUID(), grantId: d.ownDecision.grantId })
  assert.equal(saved.version, d.ownDecisionVersion + 1)
  assert.ok((await repository.getOwn(actor.principal, work.receipt.id)).effectiveness.holds.includes('revoked'))
})

test('changing only entry timing preserves the unchanged work request and its material fingerprint', async () => {
  const before = (await f.consent.staffState(job.caseId)).state
  const next = await f.consent.publishRequest(job.caseId, 'entry', {
    entry: f.consent.entryWindow(new Date(Date.now() + 7200000), new Date(Date.now() + 10800000)),
  })
  const after = (await f.consent.staffState(job.caseId)).state
  assert.equal(after.purposes[0].request.id, before.purposes[0].request.id)
  assert.equal(after.purposes[0].request.version, before.purposes[0].request.version)
  assert.equal(after.purposes[0].request.materialDigest, after.purposes[1].request.materialDigest)
  assert.equal(next.receipt.version, before.purposes[1].request.version + 1)
})

test('staff history and withdrawal enforce the selected case, and foreign resident sessions reveal no terms', async () => {
  const second = await f.consent.createJob()
  const scoped = await f.runtime.loadUserProperty(f.actors['owner-a'].principal, { organizationId: 'organization-a', propertyId: 'property-a1' }, 'operate')
  await assert.rejects(repository.staffHistory(scoped.scope, 1, second.caseId, work.receipt.id, { limit: 25 }), { code: 'consent_not_found' })
  await assert.rejects(repository.executeStaff(scoped.scope, 1, second.caseId, null, { action: 'withdraw_request', commandId: randomUUID(), requestId: work.receipt.id, expectedVersion: 1, reason: 'Wrong case must refuse' }), { code: 'consent_changed' })
  const outsider = await f.consent.enroll(2, { property: 'property-b1', org: 'organization-b', staff: f.actors['owner-b'] })
  assert.equal(await repository.getOwn(outsider.principal, work.receipt.id), null)
  assert.deepEqual((await repository.listOwn(outsider.principal, { limit: 25 })).items, [])
})

test('resident command receipt and history are append-only and never expose another resident decision', async () => {
  const history = await repository.ownHistory(actor.principal, work.receipt.id, { limit: 2 })
  assert.equal(history.items.length, 2); assert.ok(history.nextCursor)
  const next = await repository.ownHistory(actor.principal, work.receipt.id, { limit: 25, before: history.nextCursor })
  assert.ok(next.items.length > 0)
  assert.equal(new Set([...history.items, ...next.items].map(item => item.id)).size, history.items.length + next.items.length)
  for (const item of [...history.items, ...next.items]) if (item.decision) assert.equal(item.decision.actorUserId, actor.principal.userId)
  await assert.rejects(f.db.admin.query('UPDATE atrium.consent_decisions SET version=version+1'), { code: '23514' })
})

test('runtime roles have no raw consent writes, credential access or executor inheritance', async () => {
  for (const connection of [f.db.app, f.db.auth]) {
    await assert.rejects(connection.transaction({}, client => client.query('SELECT * FROM atrium.consent_requests')), { code: '42501' })
    await assert.rejects(connection.transaction({}, client => client.query('SET ROLE atrium_consent_executor')), { code: '42501' })
  }
  const privilege = await f.db.admin.query("SELECT has_table_privilege('atrium_consent_executor','atrium.user_credentials','SELECT') allowed")
  assert.equal(privilege.rows[0].allowed, false)
  const a = actor.principal
  await assert.rejects(f.db.auth.transaction({ actorUserId: a.userId, actorSessionId: a.sessionId, credentialVersion: a.credentialVersion, sessionAudience: 'staff' }, c => c.query("SELECT atrium.consent_resident('list','{\"limit\":25}')")), { message: 'consent_forbidden' })
})
