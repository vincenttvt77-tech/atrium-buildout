import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createConsentFixture } from '../helpers/resident-consent.mjs'
import { PostgresResidentConsentRepository } from '../../src/database/resident-consent.ts'

let f, c, first, second, outsider, job, otherJob, work, entry, otherWork
before(async () => {
  f = await createConsentFixture(); c = f.consent
  first = await c.enroll(0); second = await c.enroll(1)
  outsider = await c.enroll(0, { property: 'property-b1', org: 'organization-b', staff: f.actors['owner-b'] })
  job = await c.createJob(); otherJob = await c.createJob()
  await c.configure(job.caseId, [first, second])
  work = (await c.publishRequest(job.caseId, 'work')).receipt
  entry = (await c.publishRequest(job.caseId, 'entry')).receipt
  otherWork = (await c.publishRequest(otherJob.caseId, 'work')).receipt
}, { timeout: 120000 })
after(async () => { await f?.close() })

test('staff and resident HTML require their own audience and expose no private household evidence', async () => {
  const owner = f.actors['owner-a']
  const page = await f.request(`/api/maintenance-consent?organizationId=organization-a&propertyId=property-a1&caseId=${job.caseId}`, { jar: owner.jar })
  assert.equal(page.status, 200, page.text)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(page.headers.get('cache-control'), /no-store/)
  const residentPage = await f.request(`/api/resident-consent?requestId=${work.id}`, { jar: first.jar })
  assert.equal(residentPage.status, 200, residentPage.text)
  for (const value of [second.residentId, second.principal.userId, 'Synthetic reviewed household and purpose authority']) {
    assert.ok(!residentPage.text.includes(value), 'Blank resident shell excludes staff-only evidence')
  }
  assert.equal((await f.request('/api/resident-consent?format=json&resource=list', { jar: owner.jar })).status, 401)
  assert.equal((await c.staffRead(job.caseId, 'state', {}, { actor: { jar: first.jar, principal: first.principal } })).status, 401)
  assert.equal((await c.staffRead(job.caseId, 'state', {}, { actor: f.actors['viewer-a'] })).status, 403)
  assert.equal((await c.staffRead(job.caseId, 'state', {}, { property: 'property-a2' })).status, 404)
})

test('own request reads never accept staff/property selectors as resident authority', async () => {
  const own = await c.residentDetail(first, work.id)
  assert.equal(own.detail.purpose, 'work')
  assert.equal(own.detail.terms.residentChargeCents, 0)
  assert.equal(own.detail.terms.funding, 'property_no_resident_charge')
  const text = JSON.stringify(own)
  for (const value of [second.residentId, second.principal.userId, 'Synthetic reviewed household and purpose authority', 'Staff reviewed exact work and cost']) {
    assert.ok(!text.includes(value), 'Resident response excludes another recipient and private notes/sources')
  }
  const foreign = await c.residentRead(outsider, 'detail', { requestId: work.id }, {
    'x-atrium-organization-id': 'organization-a', 'x-atrium-property-id': 'property-a1',
  })
  assert.ok(foreign.status === 404 || foreign.status === 200 && foreign.json.detail === null, foreign.text)
  const mixed = { ...first, jar: new Map([...first.jar, ...f.actors['owner-a'].jar]) }
  const result = await c.residentRead(mixed)
  assert.equal(result.status, 200, result.text); assert.equal(result.json.userId, first.principal.userId)
})

test('selected-case history, withdrawal and receipt lookup cannot operate on a different case', async () => {
  const foreignHistory = await c.staffRead(job.caseId, 'history', { requestId: otherWork.id })
  assert.ok([404,409].includes(foreignHistory.status), foreignHistory.text)
  const withdrawal = { action: 'withdraw_request', commandId: randomUUID(), requestId: otherWork.id,
    expectedVersion: otherWork.version, reason: 'Synthetic selected-case substitution attempt' }
  const result = await c.staffPost(job.caseId, withdrawal)
  assert.ok([404,409].includes(result.status), result.text)
  const stillCurrent = (await c.staffState(otherJob.caseId)).state.purposes.find(value => value.purpose === 'work').request
  assert.equal(stillCurrent.withdrawnAt, null)
  const receipt = await c.staffRead(job.caseId, 'receipt', { commandId: otherWork.commandId })
  assert.ok([404,409].includes(receipt.status) || receipt.status === 200 && receipt.json.receipt === null, receipt.text)
})

test('forms reject cross-origin, audience, action and selected-case substitution before mutation', async () => {
  const staff = await c.staffState(job.caseId), resident = await c.residentDetail(first, work.id)
  const decline = { action: 'decline', commandId: randomUUID(), requestId: work.id, requestVersion: work.version,
    expectedDecisionVersion: 0, purpose: 'work', termsDigest: resident.detail.termsDigest }
  for (const headers of [{ origin: 'https://foreign.invalid' }, { 'x-atrium-consent-form': staff.formToken },
    { 'x-atrium-consent-action': 'grant_finish' }, { 'x-atrium-session-id': second.principal.sessionId }]) {
    const result = await c.residentPost(first, decline, { formToken: resident.formToken, headers })
    assert.ok([400,403,409].includes(result.status), result.text)
  }
  const body = { action: 'withdraw_request', commandId: randomUUID(), requestId: work.id, expectedVersion: work.version,
    reason: 'Synthetic wrong-case form attempt' }
  const result = await c.staffPost(otherJob.caseId, body, { formToken: staff.formToken })
  assert.equal(result.status, 403, result.text)
  assert.equal((await c.residentDetail(first, work.id)).detail.ownDecision, null)
})

test('real terms-bound grants count each required resident and keep work separate from apartment entry', async () => {
  const waiting = await c.planningRead('inbox', { filter: 'waiting', limit: '50' })
  const waitingItem = waiting.items.find(value => value.id === job.caseId)
  assert.equal(waitingItem.nextStep.responsible, 'verified_resident')
  assert.equal(waitingItem.assessment.residentApprovalVerified, false)
  await c.grant(first, work.id)
  let state = (await c.staffState(job.caseId)).state
  assert.equal(state.purposes.find(value => value.purpose === 'work').effectiveness.effective, false)
  assert.equal(state.purposes.find(value => value.purpose === 'entry').effectiveness.effective, false)
  await c.grant(second, work.id)
  state = (await c.staffState(job.caseId)).state
  const approvedWork = state.purposes.find(value => value.purpose === 'work')
  assert.equal(approvedWork.effectiveness.effective, true)
  assert.equal(approvedWork.effectiveness.dispatchStatus, 'not_dispatched')
  assert.equal(approvedWork.effectiveness.notificationStatus, 'not_sent')
  assert.equal(state.purposes.find(value => value.purpose === 'entry').effectiveness.effective, false)
  const workOnly = (await c.planningRead('plan', { caseId: job.caseId })).detail.assessment
  assert.equal(workOnly.residentApprovalVerified, true)
  assert.equal(workOnly.entryAuthorized, false)
  assert.equal(workOnly.readiness, 'awaiting_resident')
  await c.grant(first, entry.id); await c.grant(second, entry.id)
  assert.equal((await c.residentDetail(first, entry.id)).detail.effectiveness.effective, true)
  const complete = (await c.planningRead('plan', { caseId: job.caseId })).detail.assessment
  assert.equal(complete.residentApprovalVerified, true); assert.equal(complete.entryAuthorized, true)
  assert.equal(complete.readiness, 'authorized_plan'); assert.equal(complete.dispatchStatus, 'not_dispatched')
  const inbox = await c.planningRead('inbox', { filter: 'all', limit: '50' })
  const current = inbox.items.find(value => value.id === job.caseId)
  assert.deepEqual(current.assessment, complete)
  assert.equal(current.nextStep.kind, 'arrange_work')
  const serialized = JSON.stringify(inbox)
  for (const value of [first.principal.userId, second.principal.userId, first.residentId, second.residentId, 'termsDigest', 'publicKey']) {
    assert.ok(!serialized.includes(value), 'Planning list exposes no recipient directory or private consent evidence')
  }
})

test('a forged assertion cannot grant; a successful ceremony cannot be applied again', async () => {
  const failed = await c.grant(first, otherWork.id, { assertion: { uv: false }, allowFailure: true })
  assert.ok([403,409].includes(failed.finish.status), failed.finish.text)
  assert.equal((await c.residentDetail(first, otherWork.id)).detail.ownDecision, null)
  const succeeded = await c.grant(first, otherWork.id)
  const replay = await c.residentPost(first, { action: 'grant_finish', challengeId: succeeded.begin.json.challengeId, response: succeeded.response })
  assert.equal(replay.status, 409, replay.text)
  const receipt = await c.residentRead(first, 'receipt', { commandId: succeeded.command.commandId })
  assert.equal(receipt.status, 200, receipt.text)
  assert.equal(receipt.json.receipt.id, succeeded.finish.json.receipt.id)
  assert.equal((await c.residentDetail(first, otherWork.id)).detail.ownDecisionVersion, 1)
})

test('own decline, reconsideration and exact-grant revocation preserve independent decision histories', async () => {
  const current = (await c.residentDetail(second, work.id)).detail
  const declined = await c.residentPost(second, { action: 'decline', commandId: randomUUID(), requestId: work.id,
    requestVersion: current.requestVersion, expectedDecisionVersion: current.ownDecisionVersion, purpose: 'work', termsDigest: current.termsDigest })
  assert.equal(declined.status, 200, declined.text)
  assert.ok((await c.residentDetail(first, work.id)).detail.effectiveness.holds.includes('declined'))
  const firstHistory = await c.residentRead(first, 'history', { requestId: work.id })
  assert.equal(firstHistory.status, 200, firstHistory.text)
  assert.ok(!JSON.stringify(firstHistory.json).includes(second.principal.userId))
  const previousGrant = current.ownDecision.id
  const renewed = await c.grant(second, work.id)
  const latest = (await c.residentDetail(second, work.id)).detail
  const stale = await c.residentPost(second, { action: 'revoke', commandId: randomUUID(), requestId: work.id,
    requestVersion: latest.requestVersion, expectedDecisionVersion: latest.ownDecisionVersion, purpose: 'work', grantId: previousGrant })
  assert.equal(stale.status, 409, stale.text)
  assert.equal((await c.residentDetail(first, work.id)).detail.effectiveness.effective, true)
  const command = { action: 'revoke', commandId: randomUUID(), requestId: work.id,
    requestVersion: latest.requestVersion, expectedDecisionVersion: latest.ownDecisionVersion, purpose: 'work', grantId: renewed.finish.json.receipt.id }
  const revoked = await c.residentPost(second, command)
  assert.equal(revoked.status, 200, revoked.text)
  const repeated = await c.residentPost(second, command)
  assert.equal(repeated.status, 200, repeated.text); assert.equal(repeated.json.receipt.replayed, true)
  assert.ok((await c.residentDetail(first, work.id)).detail.effectiveness.holds.includes('revoked'))
  assert.equal((await c.residentDetail(first, entry.id)).detail.effectiveness.effective, true)
  const attention = await c.planningRead('inbox', { filter: 'attention', limit: '50' })
  const revokedItem = attention.items.find(value => value.id === job.caseId)
  assert.equal(revokedItem.assessment.residentApprovalVerified, false)
  assert.equal(revokedItem.assessment.entryAuthorized, true)
  assert.equal(revokedItem.nextStep.responsible, 'property_team')
  await c.grant(second, work.id)
})

test('changing only the entry window preserves work and requires decisions for the new entry version', async () => {
  const priorWork = (await c.residentDetail(first, work.id)).detail
  entry = (await c.publishRequest(job.caseId, 'entry', {
    entry: c.entryWindow(new Date(Date.now() + 7200000), new Date(Date.now() + 9000000)),
  })).receipt
  const state = (await c.staffState(job.caseId)).state
  const workState = state.purposes.find(value => value.purpose === 'work'), entryState = state.purposes.find(value => value.purpose === 'entry')
  assert.equal(workState.request.version, priorWork.requestVersion)
  assert.equal(workState.effectiveness.effective, true)
  assert.equal(entryState.effectiveness.effective, false)
  assert.equal(workState.request.materialDigest, entryState.request.materialDigest)
  await c.grant(first, entry.id); await c.grant(second, entry.id)
})

test('ordinary passkey session verification does not erase durable saved consent', async () => {
  const before = (await c.residentDetail(first, work.id)).detail
  await c.verifyLogin(first)
  const after = (await c.residentDetail(first, work.id)).detail
  assert.equal(after.ownDecision.id, before.ownDecision.id)
  assert.equal(after.effectiveness.effective, true)
})

test('list, detail and staff readiness cannot return an expired projection after their final authorization fence', async () => {
  for (const [method, request, expire] of [
    ['listOwn', () => c.residentRead(first), result => { result.refreshAt = new Date(Date.now() - 1).toISOString() }],
    ['getOwn', () => c.residentRead(first, 'detail', { requestId: work.id }), result => { result.effectiveness.refreshAt = new Date(Date.now() - 1).toISOString() }],
    ['staffState', () => c.staffRead(job.caseId), result => { result.purposes[0].effectiveness.refreshAt = new Date(Date.now() - 1).toISOString() }],
  ]) {
    const original = PostgresResidentConsentRepository.prototype[method]
    PostgresResidentConsentRepository.prototype[method] = async function (...args) {
      const result = structuredClone(await original.apply(this, args)); expire(result); return result
    }
    try {
      const result = await request()
      assert.equal(result.status, 409, result.text); assert.equal(result.json.code, 'consent_changed')
      assert.equal(result.json.detail, undefined); assert.equal(result.json.state, undefined); assert.equal(result.json.page, undefined)
    } finally { PostgresResidentConsentRepository.prototype[method] = original }
  }
})

test('a committed decision remains recoverable if the response is lost, without replaying the write', async () => {
  const current = (await c.residentDetail(first, otherWork.id)).detail
  const command = { action: 'decline', commandId: randomUUID(), requestId: otherWork.id, requestVersion: current.requestVersion,
    expectedDecisionVersion: current.ownDecisionVersion, purpose: 'work', termsDigest: current.termsDigest }
  const original = PostgresResidentConsentRepository.prototype.decideOwn
  PostgresResidentConsentRepository.prototype.decideOwn = async function (...args) {
    await original.apply(this, args); throw new Error('Synthetic response lost after commit')
  }
  try {
    const result = await c.residentPost(first, command)
    assert.ok(result.status >= 500, result.text)
  } finally { PostgresResidentConsentRepository.prototype.decideOwn = original }
  const recovered = await c.residentRead(first, 'receipt', { commandId: command.commandId })
  assert.equal(recovered.status, 200, recovered.text); assert.equal(recovered.json.receipt.action, 'decline')
  const history = await c.residentRead(first, 'history', { requestId: otherWork.id })
  assert.equal(history.status, 200, history.text)
  assert.equal(history.json.history.items.filter(value => value.decision?.id === recovered.json.receipt.id).length, 1)
  const foreign = await c.residentRead(second, 'receipt', { commandId: command.commandId })
  assert.ok(foreign.status === 404 || foreign.status === 200 && foreign.json.receipt === null, foreign.text)
})

test('authenticated self history and revocation remain possible after source expiry without enabling a new grant', async () => {
  // Use ordinary versioned publication and actual expiry. Historical evidence is immutable.
  const validUntil = new Date(Date.now() + 15000).toISOString()
  await c.configure(job.caseId, [first, second], { policySource: { ...c.source(), validUntil } })
  const current = (await c.publishRequest(job.caseId, 'work')).receipt
  await c.grant(first, current.id); await c.grant(second, current.id)
  assert.equal((await c.residentDetail(first, current.id)).detail.effectiveness.effective, true)
  await delay(Math.max(0, Date.parse(validUntil) - Date.now() + 25))
  const detail = (await c.residentDetail(first, current.id)).detail
  assert.equal(detail.canGrant, false); assert.equal(detail.effectiveness.effective, false)
  const history = await c.residentRead(first, 'history', { requestId: current.id })
  assert.equal(history.status, 200, history.text)
  const revoked = await c.residentPost(first, { action: 'revoke', commandId: randomUUID(), requestId: current.id,
    requestVersion: detail.requestVersion, expectedDecisionVersion: detail.ownDecisionVersion, purpose: 'work', grantId: detail.ownDecision.id })
  assert.equal(revoked.status, 200, revoked.text)
  assert.deepEqual(f.errors, []); assert.deepEqual(f.remoteRequests, [])
})
