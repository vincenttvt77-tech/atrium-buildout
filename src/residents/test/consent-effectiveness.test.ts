import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateConsent } from '../consent.ts'
import type { ConsentEvaluationInput } from '../consent.ts'
import type { ConsentDecision, ConsentHold, ConsentPurpose, ConsentRequest } from '../consent-model.ts'

const clock = new Date('2026-09-13T18:00:00.000Z')
const iso = (minutes: number) => new Date(clock.getTime() + minutes * 60000).toISOString()
function request(purpose: ConsentPurpose = 'work'): ConsentRequest {
  return {
    id: 'request-1', organizationId: 'org-a', propertyId: 'property-a', caseId: 'case-a', purpose, version: 1,
    caseVersion: 2, planId: 'plan-a', planVersion: 1, configurationVersion: 1, maintenancePolicyVersion: 1,
    consentPolicyVersion: 1, rosterId: 'roster-a', rosterVersion: 1, materialDigest: 'a'.repeat(64), termsDigest: 'b'.repeat(64),
    terms: { schemaVersion: 1, purpose, propertyName: 'Synthetic building', unitId: '19A', publicSummary: 'Fix dripping tap',
      scopeOfWork: 'Replace the kitchen tap washer', party: { kind: 'internal', name: 'Building maintenance' },
      funding: 'property_no_resident_charge', currency: 'USD', propertyMaximumCents: 10000, residentChargeCents: 0,
      noChargeStatement: 'The property pays; no resident charge.', accessRequirement: 'unit_entry',
      entryWindow: purpose === 'entry' ? { startsAt: iso(60), endsAt: iso(120), startsLocal: '2026-09-13T15:00:00.000-04:00',
        endsLocal: '2026-09-13T16:00:00.000-04:00', timeZone: 'America/New_York' } : null, conditions: 'Only the reviewed work.' },
    responseDeadline: iso(30), consentValidUntil: iso(180), publishedBy: 'owner-a', publishedAt: iso(-30), createdAt: iso(-30), withdrawnAt: null,
  }
}
function decision(value: ConsentRequest, kind: ConsentDecision['decision'] = 'grant'): ConsentDecision {
  return { id: 'decision-1', requestId: value.id, requestVersion: value.version, purpose: value.purpose, version: 1,
    actorUserId: 'resident-a', decision: kind, grantId: kind === 'grant' ? 'decision-1' : null, termsDigest: value.termsDigest, decidedAt: iso(-5) }
}
function input(purpose: ConsentPurpose = 'work'): ConsentEvaluationInput {
  const value = request(purpose)
  return { required: true, request: value, holds: [], recipients: [{ userId: 'resident-a', decision: decision(value), holds: [] }], deadlines: [iso(240)] }
}

test('a fully reviewed exact grant projects permission without claiming execution or delivery', () => {
  const state = evaluateConsent(input(), clock)
  assert.equal(state.effective, true)
  assert.deepEqual(state.holds, [])
  assert.equal(state.refreshAt, iso(30))
  assert.equal(state.dispatchStatus, 'not_dispatched')
  assert.equal(state.notificationStatus, 'not_sent')
})
test('a purpose that is not required needs no request, roster or irrelevant signer', () => {
  const state = evaluateConsent({ required: false, request: null, holds: ['roster_changed'], recipients: [], deadlines: [] }, clock)
  assert.equal(state.required, false); assert.equal(state.effective, false)
  assert.deepEqual(state.holds, ['not_required'])
})
test('an empty required recipient set cannot become consent by vacuous truth', () => {
  const value = input(); value.recipients = []
  assert.equal(evaluateConsent(value, clock).effective, false)
  assert.ok(evaluateConsent(value, clock).holds.includes('missing_required_recipient'))
})
test('a missing published request is held even if a stale decision remains', () => {
  const value = input(); value.request = null
  assert.ok(evaluateConsent(value, clock).holds.includes('awaiting_decisions'))
})
test('every required household recipient must independently grant the purpose', () => {
  for (const kind of [null, 'decline', 'revoke'] as const) {
    const value = input(), second = kind === null ? null : { ...decision(value.request!, kind), actorUserId: 'resident-b' }
    value.recipients.push({ userId: 'resident-b', decision: second, holds: [] })
    const state = evaluateConsent(value, clock)
    assert.equal(state.effective, false)
    assert.ok(state.holds.includes(kind === null ? 'awaiting_decisions' : kind === 'decline' ? 'declined' : 'revoked'))
  }
})
test('one resident reconsidering never clears another resident decline', () => {
  const value = input()
  value.recipients.push({ userId: 'resident-b', decision: { ...decision(value.request!, 'decline'), actorUserId: 'resident-b' }, holds: [] })
  value.recipients[0]!.decision = { ...decision(value.request!), version: 3 }
  assert.deepEqual(evaluateConsent(value, clock).holds, ['declined'])
})
test('work and entry decisions cannot substitute for each other or another request revision', () => {
  const cases: Array<Partial<ConsentDecision>> = [{ purpose: 'entry' }, { requestId: 'request-other' }, { requestVersion: 2 }, { termsDigest: 'c'.repeat(64) }]
  for (const patch of cases) {
    const value = input(); Object.assign(value.recipients[0]!.decision!, patch)
    assert.ok(evaluateConsent(value, clock).holds.includes('terms_changed'))
  }
})
test('completed grants survive the response deadline; pending or declined requests cannot gain approval afterwards', () => {
  assert.equal(evaluateConsent(input(), new Date(iso(31))).effective, true)
  for (const kind of [null, 'decline'] as const) {
    const value = input(); value.recipients[0]!.decision = kind ? decision(value.request!, kind) : null
    assert.ok(evaluateConsent(value, new Date(iso(31))).holds.includes('response_expired'))
  }
})
test('consent validity expires independently of the response window', () => {
  const state = evaluateConsent(input(), new Date(iso(180)))
  assert.equal(state.effective, false); assert.ok(state.holds.includes('consent_expired'))
  assert.ok(!state.holds.includes('response_expired'))
})
test('entry timing expires only entry and leaves an unchanged work request valid', () => {
  const later = new Date(iso(121))
  assert.ok(evaluateConsent(input('entry'), later).holds.includes('entry_expired'))
  assert.equal(evaluateConsent(input('work'), later).effective, true)
  const value = input('entry'); value.request!.terms.entryWindow = null
  assert.ok(evaluateConsent(value, clock).holds.includes('missing_entry_window'))
})
test('source, authority, account and signing-factor changes hold saved grants', () => {
  const changes: ConsentHold[] = ['context_changed','policy_changed','roster_changed','authority_changed','binding_changed','account_changed','factor_revoked','terms_changed','emergency','spending_not_authorized','job_already_committed']
  for (const hold of changes) {
    const value = input(); value.recipients[0]!.holds = [hold]
    const state = evaluateConsent(value, clock)
    assert.equal(state.effective, false); assert.ok(state.holds.includes(hold))
  }
})
test('withdrawal retains historical decisions but removes present permission', () => {
  const value = input(); value.request!.withdrawnAt = iso(-1)
  const snapshot = structuredClone(value)
  assert.ok(evaluateConsent(value, clock).holds.includes('request_withdrawn'))
  assert.deepEqual(value, snapshot)
})
test('projection expires at relevant authority deadlines and fails closed on malformed evidence', () => {
  const value = input(); value.deadlines = [iso(10)]
  assert.equal(evaluateConsent(value, clock).refreshAt, iso(10))
  assert.ok(evaluateConsent(value, new Date(iso(10))).holds.includes('context_changed'))
  value.deadlines = ['invalid']
  assert.equal(evaluateConsent(value, clock).effective, false)
  for (const field of ['responseDeadline','consentValidUntil','publishedAt'] as const) {
    const broken = input(); broken.request![field] = 'invalid'
    assert.ok(evaluateConsent(broken, clock).holds.includes('terms_changed'))
  }
})
test('future, prepublication or late grant timestamps cannot project valid consent', () => {
  for (const timestamp of [iso(-31), iso(1), iso(30), 'invalid']) {
    const value = input(); value.recipients[0]!.decision!.decidedAt = timestamp
    assert.ok(evaluateConsent(value, clock).holds.includes('terms_changed'))
  }
})
test('malformed decision kinds never default to granting authority', () => {
  for (const kind of ['approve', '', null, undefined, true]) {
    const value = input()
    Object.assign(value.recipients[0]!.decision!, { decision: kind })
    const state = evaluateConsent(value, clock)
    assert.equal(state.effective, false)
    assert.ok(state.holds.includes('terms_changed'))
  }
})
test('entry deadlines cover the complete window and preserve its explicit local timezone', () => {
  assert.equal(evaluateConsent(input('entry'), clock).effective, true)
  for (const mutate of [
    (value: ConsentRequest) => { value.consentValidUntil = iso(90) },
    (value: ConsentRequest) => { value.responseDeadline = iso(70) },
    (value: ConsentRequest) => { value.terms.entryWindow!.timeZone = 'America/Chicago' },
    (value: ConsentRequest) => { value.terms.entryWindow!.startsLocal = '2026-09-13T15:00:00.000-05:00' },
  ]) {
    const value = input('entry'); mutate(value.request!)
    assert.ok(evaluateConsent(value, clock).holds.includes('terms_changed'))
  }
})
test('a grant must identify its own saved evidence, and purpose enums fail closed', () => {
  const value = input(); value.recipients[0]!.decision!.grantId = null
  assert.equal(evaluateConsent(value, clock).effective, false)
  const malformed = input()
  Object.assign(malformed.request!, { purpose: 'payment' })
  Object.assign(malformed.request!.terms, { purpose: 'payment' })
  Object.assign(malformed.recipients[0]!.decision!, { purpose: 'payment' })
  assert.equal(evaluateConsent(malformed, clock).effective, false)
  Object.assign(malformed, { required: 'false' })
  assert.throws(() => evaluateConsent(malformed, clock))
})
test('copied grants cannot satisfy a different required resident or a duplicate roster slot', () => {
  const wrongActor = input()
  wrongActor.recipients.push({ userId: 'resident-b', decision: structuredClone(wrongActor.recipients[0]!.decision), holds: [] })
  assert.equal(evaluateConsent(wrongActor, clock).effective, false)
  const duplicate = input(); duplicate.recipients.push(structuredClone(duplicate.recipients[0]!))
  assert.ok(evaluateConsent(duplicate, clock).holds.includes('missing_required_recipient'))
  const correct = input()
  correct.recipients.push({ userId: 'resident-b', decision: { ...decision(correct.request!), id: 'decision-2', grantId: 'decision-2', actorUserId: 'resident-b' }, holds: [] })
  assert.equal(evaluateConsent(correct, clock).effective, true)
})
test('unsupported cost terms never project resident permission in the property-funded slice', () => {
  for (const patch of [{ funding: 'resident_pays' }, { currency: 'EUR' }, { residentChargeCents: 100 },
    { propertyMaximumCents: null }, { propertyMaximumCents: -1 }, { propertyMaximumCents: Number.NaN },
    { propertyMaximumCents: Number.POSITIVE_INFINITY }, { propertyMaximumCents: 1.5 }]) {
    const value = input(); Object.assign(value.request!.terms, patch)
    assert.ok(evaluateConsent(value, clock).holds.includes('terms_changed'))
  }
})
test('equal missing identifiers, malformed digests and invalid revisions are never valid evidence', () => {
  for (const id of ['', null, undefined]) {
    const value = input(); Object.assign(value.request!, { id })
    Object.assign(value.recipients[0]!.decision!, { id, grantId: id, requestId: id })
    assert.equal(evaluateConsent(value, clock).effective, false)
  }
  for (const termsDigest of ['', undefined, 'NOT-A-DIGEST']) {
    const value = input(); Object.assign(value.request!, { termsDigest }); Object.assign(value.recipients[0]!.decision!, { termsDigest })
    assert.equal(evaluateConsent(value, clock).effective, false)
  }
  for (const version of [0, -1, 1.5, Number.NaN, undefined]) {
    const value = input(); Object.assign(value.recipients[0]!.decision!, { version })
    assert.equal(evaluateConsent(value, clock).effective, false)
  }
})
