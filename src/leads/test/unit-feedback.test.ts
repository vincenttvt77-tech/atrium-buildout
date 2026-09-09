import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { addUnitFeedback, editUnitFeedback, listUnitFeedback, feedbackInventory, type FeedbackContext } from '../unit-feedback.ts'
import { emptyProfile } from '../profile.ts'
import { profileKey } from '../consolidate.ts'

const now = new Date('2026-09-10T00:30:00Z')
const context: FeedbackContext = { scopeKey: 'property-a', actor: { id: 'staff-1', label: 'Leasing team member' }, now, timeZone: 'America/New_York',
  inventory: { units: [{ unitId: '12A', floorPlanId: 'one', floor: 12, bedrooms: 1, bathrooms: 1, sqft: 700, monthlyRent: 4000, availableFrom: '2026-10-01', status: 'leased' }],
    floorPlans: [{ id: 'one', name: 'One bedroom', bedrooms: 1, bathrooms: 1, sqft: 700, description: '', features: [] }],
    readAt: new Date('2026-09-01T00:00:00Z'), source: 'Synthetic catalogue', provenance: { sourceMode: 'demo', catalogAsOf: '2026-09-01T00:00:00Z', catalogVersion: 'test-v1', fictional: true } } }
const entry = (extra = {}) => ({ unitId: '12A', sentiment: 'negative', category: 'light', note: 'The living room felt dark.', observedDate: '2026-09-09', idempotencyKey: 'creation-request-0001', ...extra })

test('unit observations are separate from inventory and retry exactly once across concurrent saves', async () => {
  const store = new MemoryDocumentStore(), before = structuredClone(context.inventory)
  const responses = await Promise.all(Array.from({ length: 20 }, () => addUnitFeedback(store, entry(), context)))
  assert.ok(responses.every(record => record.id === responses[0]!.id && record.revision === 1))
  assert.equal((await listUnitFeedback(store, context.scopeKey)).unitFeedback.length, 1)
  assert.deepEqual(context.inventory, before)
  assert.equal(responses[0]!.createdAt, now.toISOString())
  assert.deepEqual(responses[0]!.createdBy, context.actor)
  assert.equal(responses[0]!.leadPhone, null)
  assert.equal(JSON.stringify(responses[0]).includes('inputJson'), false)
  await assert.rejects(addUnitFeedback(store, entry({ note: 'Different observation' }), context), { code: 'unit_feedback_conflict' })
})

test('references must belong to the supplied property and an existing prospect', async () => {
  const store = new MemoryDocumentStore()
  await assert.rejects(addUnitFeedback(store, entry({ unitId: 'foreign-unit' }), context), { code: 'unit_feedback_unit_missing' })
  await assert.rejects(addUnitFeedback(store, entry({ leadPhone: '+12125550123' }), context), { code: 'unit_feedback_lead_missing' })
  assert.deepEqual(await store.list('unit-feedback:'), [])
  await store.set(profileKey('+12125550123'), emptyProfile('+12125550123', now))
  const saved = await addUnitFeedback(store, entry({ leadPhone: '(212) 555-0123' }), context)
  assert.equal(saved.leadPhone, '+12125550123')
  // A leased unit remains a legitimate subject of staff feedback.
  assert.equal(saved.unitId, '12A')
})

test('strict fields, text, retry tokens and actual property-local dates are bounded', async () => {
  for (const invalid of [
    { sentiment: 'mixed' }, { category: 'made-up' }, { note: 'x'.repeat(1001) }, { note: '\u0000' }, { note: '\ud800' },
    { observedDate: '2026-02-30' }, { observedDate: '2026-09-10' }, { observedDate: '1899-12-31' },
    { observedDate: 'https://example.test' }, { idempotencyKey: 'short' }, { leadPhone: 2125550123 },
    { createdBy: { id: 'owner', label: 'Owner' } }, { organizationId: 'other' },
  ]) await assert.rejects(addUnitFeedback(new MemoryDocumentStore(), entry(invalid), context), { code: 'unit_feedback_invalid' })
  const saved = await addUnitFeedback(new MemoryDocumentStore(), entry({ note: '  Nice light ☀️\nSecond line.  ' }), context)
  assert.equal(saved.note, 'Nice light ☀️\nSecond line.')
})

test('edits preserve origin and unit identity, retry safely, and reject stale concurrent writers', async () => {
  const store = new MemoryDocumentStore()
  const original = await addUnitFeedback(store, entry(), context)
  const changedContext = { ...context, actor: { id: 'staff-2', label: 'Second staff member' }, now: new Date('2026-09-10T01:00:00Z') }
  const edit = { id: original.id, expectedRevision: 1, idempotencyKey: 'edit-request-000001', sentiment: 'neutral', category: 'light', note: 'Follow-up after second visit.', observedDate: '2026-09-09' }
  const result = await editUnitFeedback(store, edit, changedContext)
  assert.equal(result.revision, 2); assert.equal(result.unitId, original.unitId)
  assert.deepEqual(result.createdBy, context.actor); assert.deepEqual(result.updatedBy, changedContext.actor)
  assert.equal(result.createdAt, original.createdAt); assert.equal(result.updatedAt, changedContext.now.toISOString())
  assert.deepEqual(await editUnitFeedback(store, edit, changedContext), result)
  assert.deepEqual(await addUnitFeedback(store, entry(), context), result)
  await assert.rejects(editUnitFeedback(store, { ...edit, unitId: 'another' }, changedContext), { code: 'unit_feedback_invalid' })
  const outcomes = await Promise.allSettled(['one', 'two'].map(suffix => editUnitFeedback(store, { ...edit, expectedRevision: 2, idempotencyKey: `competing-edit-${suffix}`, note: suffix }, changedContext)))
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.code === 'unit_feedback_conflict').length, 1)
  assert.equal((await listUnitFeedback(store, context.scopeKey)).unitFeedback[0]!.revision, 3)
})

test('server scope contributes to identity and mismatched persisted ownership fails visibly', async () => {
  const a = new MemoryDocumentStore(), b = new MemoryDocumentStore()
  const first = await addUnitFeedback(a, entry(), context)
  const second = await addUnitFeedback(b, entry(), { ...context, scopeKey: 'property-b' })
  assert.notEqual(first.id, second.id)
  await assert.rejects(editUnitFeedback(b, { id: first.id, expectedRevision: 1, idempotencyKey: 'foreign-edit-00001', sentiment: 'positive', category: 'other', observedDate: '2026-09-09' }, { ...context, scopeKey: 'property-b' }), { code: 'unit_feedback_missing' })
  await assert.rejects(listUnitFeedback(a, 'property-b'), /Stored unit feedback is invalid/)
})

test('historical feedback remains editable after a unit leaves inventory without allowing new entries or reassignment', async () => {
  const store = new MemoryDocumentStore(), original = await addUnitFeedback(store, entry(), context)
  const retired = { ...context, inventory: { ...context.inventory, units: [] } }
  const edit = { id: original.id, expectedRevision: 1, idempotencyKey: 'historical-edit-0001', sentiment: 'neutral', category: 'light', note: 'Corrected after review.', observedDate: '2026-09-09' }
  const corrected = await editUnitFeedback(store, edit, retired)
  assert.equal(corrected.unitId, '12A'); assert.equal(corrected.note, edit.note)
  await assert.rejects(addUnitFeedback(store, entry({ idempotencyKey: 'retired-new-entry-0001' }), retired), { code: 'unit_feedback_unit_missing' })
  await assert.rejects(editUnitFeedback(store, { ...edit, unitId: 'another-unit' }, retired), { code: 'unit_feedback_invalid' })
})

test('read-only unit descriptors retain original sample provenance and no feedback invents demand counts', () => {
  const dto = feedbackInventory(context.inventory)
  assert.equal(dto.feedbackUnits[0]!.floorPlanName, 'One bedroom')
  assert.equal(dto.feedbackUnits[0]!.status, 'leased')
  assert.deepEqual(dto.feedbackInventory, { sourceMode: 'demo', readAt: '2026-09-01T00:00:00.000Z', source: 'Synthetic catalogue', fictional: true })
  assert.equal('positiveCount' in dto.feedbackUnits[0]!, false)
})

test('listing caps responses explicitly without deleting older observations', async () => {
  const store = new MemoryDocumentStore()
  for (let index = 0; index < 501; index++) await addUnitFeedback(store, entry({ idempotencyKey: `observation-number-${String(index).padStart(4, '0')}` }), context)
  const result = await listUnitFeedback(store, context.scopeKey)
  assert.equal(result.unitFeedback.length, 500); assert.equal(result.unitFeedbackTruncated, true)
  assert.equal((await store.list('unit-feedback:')).length, 501)
})
