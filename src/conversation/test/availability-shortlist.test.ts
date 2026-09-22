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

function linkedContext(units: Unit[]): ToolContext {
  const ctx = context(units)
  return { ...ctx, organizationId: 'org-shortlist', publicShortlistWebsite: {
    format: 'atrium-shortlist-v1', organizationId: 'org-shortlist', propertyId: ctx.propertyId,
    inventorySource: ctx.inventory.source, baseUrl: 'https://shortlist.example/',
    reviewedAt: '2026-09-22T11:00:00Z', reviewExpiresAt: '2026-09-23T11:00:00Z',
  } }
}
test('known-unit inquiry prepares only its public ID and explicitly disclaims sending', () => {
  const result = checkAvailability(linkedContext([unit('19A'), unit('20A')]), { unitId: '19A' })
  const link = result.record.publicShortlist as Record<string, unknown>
  assert.equal(link.url, 'https://shortlist.example/#availability?units=19A')
  assert.equal(link.delivery, 'not_sent')
  assert.deepEqual(link.unitIds, ['19A'])
  assert.match(result.say, /No message was sent/)
  assert.match(result.say, /do not offer to text or email/)
  assert.doesNotMatch(result.say, /Unit 20A/)
})
test('search link carries exactly the presented matches and qualified alternatives, never all inventory', () => {
  const ctx = linkedContext([unit('M1'), unit('M2'), unit('M3'), unit('M4'), unit('S1', { monthlyRent: 3100 }),
    unit('L1', { availableFrom: '2026-11-01' })])
  const result = checkAvailability(ctx, search)
  const link = result.record.publicShortlist as Record<string, unknown>
  assert.deepEqual(link.unitIds, ['M1', 'M2', 'M3', 'S1', 'L1'])
  assert.deepEqual(result.record.unitsOffered, ['M1', 'M2', 'M3'], 'existing lead semantics retained')
  assert.equal(result.say.match(/Public review link prepared:/g)?.length, 1, 'inline qualification does not duplicate link')
  assert.match(result.say, /above their range/)
  assert.match(result.say, /after the requested date/)
})
test('missing or expired binding, wrong scope, stale inventory and nonavailable units never emit links', () => {
  const base = linkedContext([unit('19A')])
  const cases: ToolContext[] = [context([unit('19A')]), { ...base, organizationId: 'other-org' },
    { ...base, publicShortlistWebsite: { ...base.publicShortlistWebsite!, propertyId: 'other-property' } },
    { ...base, publicShortlistWebsite: { ...base.publicShortlistWebsite!, inventorySource: 'other-source' } },
    { ...base, publicShortlistWebsite: { ...base.publicShortlistWebsite!, reviewExpiresAt: now.toISOString() } },
    { ...base, inventory: { ...base.inventory, readAt: new Date(now.getTime() - 3600000) } },
    linkedContext([unit('19A', { status: 'pending' })]), linkedContext([unit('19A', { status: 'leased' })]),
  ]
  for (const ctx of cases) {
    const result = checkAvailability(ctx, { unitId: '19A' })
    assert.equal(result.record.publicShortlist, undefined)
    assert.doesNotMatch(result.say, /https:\/\//)
  }
})
test('qualification gates, unknown units and zero-result searches do not prepare a link', () => {
  const ctx = linkedContext([unit('19A')])
  for (const args of [{}, { unitId: '99Z' }, { ...search, bedrooms: '4' }]) {
    assert.equal(checkAvailability(ctx, args).record.publicShortlist, undefined)
  }
})

test('plan and priced-out results link only the units actually presented', () => {
  const ctx = linkedContext([
    ...Array.from({ length: 6 }, (_, i) => unit(`B${i}`, { bedrooms: 2, monthlyRent: 4500 })),
    unit('A1', { monthlyRent: 2800 }), unit('A2', { monthlyRent: 2900 }),
  ])
  for (const args of [{ unitId: 'One bedroom' }, { ...search, bedrooms: '2' }]) {
    const result = checkAvailability(ctx, args)
    const prepared = result.record.publicShortlist as Record<string, unknown>
    assert.ok(prepared)
    assert.deepEqual(prepared.unitIds, result.record.unitsOffered)
    assert.ok((prepared.unitIds as string[]).length <= 5)
  }
})
test('fictional catalogue links retain the demo disclosure instead of implying live availability', () => {
  const ctx = linkedContext([unit('19A')])
  const asOf = '2026-09-01T12:00:00Z'
  ctx.inventory = { ...ctx.inventory, readAt: new Date(asOf), provenance: {
    sourceMode: 'demo', fictional: true, catalogAsOf: asOf, catalogVersion: 'fixture-v1',
  } }
  const result = checkAvailability(ctx, { unitId: '19A' })
  assert.ok(result.record.publicShortlist)
  assert.match(result.say, /fictional demo catalogue/)
  assert.match(result.say, /never live\/PMS data/)
})
