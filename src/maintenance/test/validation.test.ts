import test from 'node:test'
import assert from 'node:assert/strict'
import { parseServiceCommand, validateServiceListQuery } from '../validation.ts'
import { residentContext } from '../../residents/validation.ts'

const source = { kind: 'staff_review', reference: 'Reviewed occupancy schedule', version: '2026-09-12',
  observedAt: '2026-09-12T12:00:00.000Z', validUntil: '2026-09-19T12:00:00.000Z' }
const details = { unitId: '19A', displayName: 'Synthetic Resident', relationship: 'occupant',
  startsOn: '2026-09-01', endsOn: null, phone: null, email: null, source }
const add = { action: 'add_resident', requestId: 'synthetic-resident-create', details, reason: 'Reviewed original building record' }
const intake = { requestOrigin: 'resident_report', location: { kind: 'unit', unitId: '19A' }, residentId: null, summary: 'Kitchen tap dripping',
  description: '', category: 'plumbing', reportedPriority: 'routine', reporterName: null, reporterPhone: null,
  reporterEmail: null, accessNotes: '' }
const create = { action: 'create_request', requestId: 'synthetic-intake', intake }
const invalid = (value: unknown) => assert.throws(() => parseServiceCommand(value), { code: 'service_invalid_input' })

test('intake does not require resident identity or contact before recording a reported problem', () => {
  assert.deepEqual(parseServiceCommand(create), create)
  for (const kind of ['common_area', 'unknown']) {
    const request = { ...create, intake: { ...intake, location: { kind, label: 'Reported entrance area' } } }
    assert.deepEqual(parseServiceCommand(request), request)
    invalid({ ...request, intake: { ...request.intake, residentId: 'someone' } })
  }
  invalid({ ...create, intake: { ...intake, callerIdentityVerified: true } })
  invalid({ ...create, intake: { ...intake, entryAuthorized: true } })
  invalid({ ...create, intake: { ...intake, dispatchStatus: 'dispatched' } })
})

test('occupancy source has explicit bounded original timestamps and valid property-local dates', () => {
  assert.deepEqual(parseServiceCommand(add), add)
  for (const changed of [{ kind: 'pms' }, { reference: '' }, { version: '' },
    { observedAt: '2026-02-30T00:00:00.000Z' }, { observedAt: '2026-09-12' },
    { validUntil: source.observedAt }, { validUntil: '2027-09-12T12:00:00.000Z' }, { callerVerified: true }]) {
    invalid({ ...add, details: { ...details, source: { ...source, ...changed } } })
  }
  for (const changed of [{ startsOn: '2026-02-30' }, { endsOn: details.startsOn }, { endsOn: '2026-08-31' },
    { startsOn: '' }, { relationship: 'owner' }, { personId: 'existing-other-property-person' }]) invalid({ ...add, details: { ...details, ...changed } })
  const reviewed = parseServiceCommand(add)
  assert.notEqual(reviewed, add)
  if (reviewed.action === 'add_resident') assert.notEqual(reviewed.details.source, source)
  assert.deepEqual(residentContext(null), { state: 'not_established', residentId: null, residentVersion: null,
    displayName: null, unitId: null, callerIdentityVerified: false, entryAuthorized: false })
})

test('review cannot move ownership or silently link an existing person', () => {
  const { unitId: _unit, ...reviewDetails } = details
  const review = { action: 'review_resident', requestId: 'review-one', id: 'res-one', expectedVersion: 1,
    details: reviewDetails, reason: 'New source reviewed' }
  assert.deepEqual(parseServiceCommand(review), review)
  for (const extra of [{ unitId: '20A' }, { personId: 'another' }, { organizationId: 'org-b' }]) invalid({ ...review, details: { ...reviewDetails, ...extra } })
  for (const v of [0, -1, 1.1, '1', Number.MAX_SAFE_INTEGER + 1]) invalid({ ...review, expectedVersion: v })
  invalid({ ...review, id: 'bad\nidentifier' })
})

test('commands cannot invent completed service states, hidden fields or unsafe text', () => {
  const triage = { action: 'triage_request', requestId: 'triage-one', id: 'request-one', expectedVersion: 1,
    state: 'management_review', priority: 'urgent', note: 'Manager must assess access conditions' }
  assert.deepEqual(parseServiceCommand(triage), triage)
  for (const state of ['dispatched', 'scheduled', 'resolved', 'closed', 'emergency_review']) invalid({ ...triage, state })
  invalid({ ...triage, approvedCost: 100 })
  for (const value of [null, [], {}, { ...create, action: 'send_message' }, { ...create, requestId: '' },
    { ...create, intake: { ...intake, summary: 'x'.repeat(161) } },
    { ...create, intake: { ...intake, description: 'hidden\u0000value' } },
    { ...create, intake: { ...intake, reporterEmail: 'not-an-address' } },
    { ...create, intake: { ...intake, reporterPhone: 'call-me' } }]) invalid(value)
})

test('context clarification preserves original intake and cannot mint identity, origin or planning authority', () => {
  const update = { action: 'update_context', requestId: 'context-one', id: 'request-one', expectedVersion: 2,
    location: { kind: 'unit', unitId: '19A' }, residentId: 'resident-one', note: 'Staff confirmed the reported apartment and selected its occupancy record' }
  assert.deepEqual(parseServiceCommand(update), update)
  for (const extra of [{ requestOrigin: 'staff_observation' }, { state: 'ready_for_planning' },
    { intakeLocation: { kind: 'unit', unitId: '19A' } }, { callerIdentityVerified: true }]) invalid({ ...update, ...extra })
  invalid({ ...update, location: { kind: 'common_area', label: 'Lobby' } })
  invalid({ ...update, expectedVersion: 0 })
  const unknown = { ...update, location: { kind: 'unknown', label: 'Reported near entrance' }, residentId: null }
  assert.deepEqual(parseServiceCommand(unknown), unknown)
  const parsed = parseServiceCommand(update)
  if (parsed.action === 'update_context') assert.notEqual(parsed.location, update.location)
})

test('bounded keyset queries reject ambiguous filters and carry detached canonical states', () => {
  const before = { createdAt: '2026-09-12T12:00:00.123Z', id: '00000000-0000-4000-8000-000000000001' }
  const query = { limit: 26, before, states: ['management_review', 'needs_triage'] }
  const parsed = validateServiceListQuery(query, 'cases')
  assert.deepEqual(parsed.states, ['needs_triage', 'management_review'])
  assert.notEqual(parsed.before, before)
  assert.deepEqual(validateServiceListQuery({ limit: 25, status: 'revoked' }, 'residents'), { limit: 25, status: 'revoked' })
  for (const bad of [{ limit: 0 }, { limit: 102 }, { limit: '25' }, { limit: 25, status: 'active' },
    { limit: 25, states: [] }, { limit: 25, states: ['needs_triage', 'needs_triage'] },
    { limit: 25, states: ['resolved'] }, { limit: 25, before: { ...before, id: 'not-a-uuid' } },
    { limit: 25, before: { ...before, createdAt: '2026-02-30T00:00:00.000Z' } }]) {
    assert.throws(() => validateServiceListQuery(bad, 'cases'), { code: 'service_invalid_input' })
  }
  assert.throws(() => validateServiceListQuery({ limit: 25, unitId: '19A' }, 'events'), { code: 'service_invalid_input' })
})
