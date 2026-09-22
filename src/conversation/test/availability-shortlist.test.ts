import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAvailability } from '../tools.ts'
import type { ToolContext } from '../tools.ts'
import type { Unit } from '../../inventory/types.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'
import { emptyQualification } from '../../leasing/qualification.ts'

const now = new Date('2026-09-22T12:00:00Z')
function unit(id: string, overrides: Partial<Unit> = {}): Unit {
  return { unitId: id, floorPlanId: 'A1', floor: 4, bedrooms: 1, bathrooms: 1,
    sqft: 700, monthlyRent: 3000, availableFrom: '2026-10-01', status: 'available', ...overrides }
}
function context(units: Unit[]): ToolContext {
  return { propertyId: propertyId('prop-shortlist'), interactionId: interactionId('call-shortlist'),
    now, inventory: { readAt: now, source: 'synthetic-shortlist', units,
      floorPlans: [{ id: 'A1', name: 'One bedroom', bedrooms: 1, bathrooms: 1,
        sqft: 700, description: '', features: [] }] },
    articles: [], qualification: emptyQualification(), jurisdiction: 'NY', confidenceThreshold: 0.7 }
}
const search = { budget: 'up to 3000', bedrooms: '1', moveIn: 'October 15, 2026' }
const named = (say: string) => [...say.matchAll(/\bUnit (\w+)/g)].map(match => match[1])

test('500 matching residences produce a short response with exact search coverage', () => {
  const ctx = context(Array.from({ length: 500 }, (_, i) => unit(`R${1000 + i}`)))
  const result = checkAvailability(ctx, search)
  assert.equal(result.record.outcome, 'matches')
  assert.deepEqual(result.record.searchSummary, { matchingUnitCount: 500, shownMatchCount: 3, additionalMatchCount: 497 })
  assert.equal(named(result.say).length, 3)
  assert.match(result.say, /497 more/)
  assert.doesNotMatch(result.say, /R1003|R1499/)
  assert.ok(result.say.length < 2200, `response has ${result.say.length} characters`)
  assert.match(result.say, /two or three/)
  // An omitted residence is still individually accessible with no intake loop.
  assert.deepEqual(checkAvailability(ctx, { unitId: 'R1499' }).record.unitsOffered, ['R1499'])
})

test('matched, above-budget and later candidates share a five-residence cap', () => {
  const ctx = context([
    ...Array.from({ length: 4 }, (_, i) => unit(`M${i}`)),
    unit('S1', { monthlyRent: 3100 }), unit('S2', { monthlyRent: 3200 }),
    unit('L1', { availableFrom: '2026-11-01' }), unit('L2', { availableFrom: '2026-11-02' }),
  ])
  const result = checkAvailability(ctx, search)
  assert.equal(named(result.say).length, 5)
  assert.ok(named(result.say).includes('S1'))
  assert.ok(named(result.say).includes('L1'))
  assert.deepEqual(result.record.searchSummary, { matchingUnitCount: 4, shownMatchCount: 3, additionalMatchCount: 1 })
})

test('in-time over-budget apartments do not become a false timing rejection', () => {
  const result = checkAvailability(context([
    unit('S1', { monthlyRent: 3100 }), unit('L1', { availableFrom: '2026-11-01' }),
  ]), search)
  assert.doesNotMatch(result.say, /Nothing frees up by their date/)
  assert.match(result.say, /above their range/)
  assert.match(result.say, /after the requested date/)
})

test('a later apartment also above budget discloses both mismatches', () => {
  const result = checkAvailability(context([
    unit('L1', { availableFrom: '2026-11-01', monthlyRent: 3200 }),
  ]), search)
  assert.match(result.say, /after the requested date/)
  assert.match(result.say, /also above their budget/)
  assert.deepEqual(result.record.searchSummary, { matchingUnitCount: 0, shownMatchCount: 0, additionalMatchCount: 0 })
})

test('priced-out larger units and affordable smaller options share the same cap', () => {
  const result = checkAvailability(context([
    ...Array.from({ length: 5 }, (_, i) => unit(`B${i}`, { bedrooms: 2, monthlyRent: 4500 })),
    ...Array.from({ length: 5 }, (_, i) => unit(`A${i}`)),
  ]), { ...search, bedrooms: '2' })
  assert.equal(result.record.outcome, 'priced_out')
  assert.equal(named(result.say).length, 5)
  assert.equal((result.record.unitsOffered as string[]).length, 5)
  assert.match(result.say, /a size down/)
  assert.match(result.say, /not an exhaustive list/)
})

test('counts exclude pending, wrong-size, over-budget and late units', () => {
  const result = checkAvailability(context([
    unit('A1'), unit('P1', { status: 'pending' }), unit('B1', { bedrooms: 2 }),
    unit('S1', { monthlyRent: 3100 }), unit('L1', { availableFrom: '2026-11-01' }),
  ]), search)
  assert.deepEqual(result.record.searchSummary, { matchingUnitCount: 1, shownMatchCount: 1, additionalMatchCount: 0 })
})

test('stale inventory returns no shortlist or purported fresh counts', () => {
  const ctx = context([unit('A1')])
  ctx.inventory.readAt = new Date(now.getTime() - 60 * 60_000)
  const result = checkAvailability(ctx, search)
  assert.equal(result.record.outcome, 'stale')
  assert.deepEqual(result.record.unitsOffered, [])
  assert.equal(result.record.searchSummary, undefined)
})

test('unqualified broad searches still cannot bypass the quote gate', () => {
  const result = checkAvailability(context([unit('A1')]))
  assert.equal(result.record.kind, 'quote_gate')
  assert.equal(result.record.searchSummary, undefined)
})

test('explicitly removing a budget counts the broader search and does not reuse the old ceiling', () => {
  const result = checkAvailability(context([
    unit('A1'), unit('S1', { monthlyRent: 3100 }),
    unit('L1', { monthlyRent: 3200, availableFrom: '2026-11-01' }),
  ]), { ...search, ignoreBudget: true })
  assert.deepEqual(result.record.searchSummary, { matchingUnitCount: 2, shownMatchCount: 2, additionalMatchCount: 0 })
  assert.match(result.say, /caller-requested broader search/)
  assert.doesNotMatch(result.say, /above their budget|above their range/)
  assert.equal(result.qualificationPatch?.budget?.value.maxMonthly, 3000)
})

test('explicitly broadening dates includes later residences without discarding the budget', () => {
  const result = checkAvailability(context([
    unit('A1'), unit('L1', { availableFrom: '2026-11-01' }),
    unit('S1', { monthlyRent: 3100, availableFrom: '2026-11-02' }),
  ]), { ...search, includeOutsideMoveIn: true })
  assert.deepEqual(result.record.searchSummary, { matchingUnitCount: 2, shownMatchCount: 2, additionalMatchCount: 0 })
  assert.match(result.say, /above their range/)
  assert.doesNotMatch(result.say, /These open after the requested date/)
  assert.ok(result.qualificationPatch?.moveInTiming)
})
