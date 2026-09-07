import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { findMatches } from '../match.ts'
import { loadInventory } from '../load.ts'
import type { Unit, FloorPlan, InventorySnapshot } from '../types.ts'
import { emptyQualification, captureCore } from '../../leasing/qualification.ts'
import { extracted } from '../../leasing/captured.ts'
import { interactionId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const CALL = interactionId('int-1')

const plan = (id: string, beds: number, sqft: number): FloorPlan => ({
  id, name: id, bedrooms: beds, bathrooms: 1, sqft, description: '', features: [],
})

const unit = (o: Partial<Unit> & { unitId: string; floorPlanId: string; monthlyRent: number }): Unit => ({
  floor: 10, bedrooms: 1, bathrooms: 1, sqft: 700,
  availableFrom: '2026-10-01', status: 'available', ...o,
})

const snap = (units: Unit[], plans: FloorPlan[], readAt = NOW): InventorySnapshot => ({
  units, floorPlans: plans, readAt, source: 'test',
})

const withBudget = (max: number) => captureCore(
  emptyQualification(), 'budget',
  extracted({ maxMonthly: max, stated: true }, 0.9, CALL, `about $${max}`, NOW))

const withBeds = (min: number, max: number) => (q: ReturnType<typeof emptyQualification>) =>
  captureCore(q, 'bedrooms', extracted({ min, max }, 0.95, CALL, 'one bedroom', NOW))

describe('the agent only offers what it can verify', () => {
  test('a stale snapshot blocks quoting entirely', () => {
    const s = snap([unit({ unitId: '10A', floorPlanId: 'A1', monthlyRent: 3000 })], [plan('A1', 1, 700)],
      new Date('2026-09-07T11:00:00Z'))
    const out = findMatches(s, emptyQualification(), { now: NOW, maxSnapshotAgeMs: 60_000 })
    assert.equal(out.kind, 'stale', 'an hour-old snapshot must not be quoted from')
  })

  test('pending and leased units are never offered', () => {
    const s = snap([
      unit({ unitId: '10A', floorPlanId: 'A1', monthlyRent: 3000, status: 'pending' }),
      unit({ unitId: '11A', floorPlanId: 'A1', monthlyRent: 3100, status: 'leased' }),
    ], [plan('A1', 1, 700)])
    const out = findMatches(s, emptyQualification(), { now: NOW })
    assert.equal(out.kind, 'no_match')
  })
})

describe('priced out is captured, not papered over', () => {
  const s = snap([
    unit({ unitId: '10A', floorPlanId: 'A1', monthlyRent: 3200 }),
    unit({ unitId: '22B', floorPlanId: 'A1', monthlyRent: 3800 }),
  ], [plan('A1', 1, 700)])

  test('a prospect under every rent gets priced_out, not a dearer unit', () => {
    const out = findMatches(s, withBudget(2400), { now: NOW })
    assert.equal(out.kind, 'priced_out')
    if (out.kind !== 'priced_out') return
    assert.equal(out.budgetMax, 2400)
    assert.equal(out.cheapestAvailable, 3200)
    assert.equal(out.gap, 800, 'the gap is the number that explains the lost lease')
  })

  test('priced_out still surfaces the nearest units for the human to see', () => {
    const out = findMatches(s, withBudget(2400), { now: NOW })
    assert.equal(out.kind === 'priced_out' && out.nearest[0]?.unit.unitId, '10A')
  })

  test('a small stretch above budget is offered separately, not silently mixed in', () => {
    const out = findMatches(s, withBudget(3100), { now: NOW })
    assert.equal(out.kind, 'matches')
    if (out.kind !== 'matches') return
    assert.equal(out.units.length, 0, 'nothing is within budget')
    assert.equal(out.stretch[0]?.unit.unitId, '10A', '$3200 is within 8% of $3100')
    assert.ok(!out.stretch.some((u) => u.unit.monthlyRent === 3800), '$3800 is not a stretch, it is a different tier')
  })
})

describe('matching respects what the prospect asked for', () => {
  const s = snap([
    unit({ unitId: '05S', floorPlanId: 'S1', monthlyRent: 2600, bedrooms: 0, sqft: 480 }),
    unit({ unitId: '12A', floorPlanId: 'A1', monthlyRent: 3400, bedrooms: 1 }),
    unit({ unitId: '30B', floorPlanId: 'B1', monthlyRent: 5200, bedrooms: 2, floor: 30 }),
  ], [plan('S1', 0, 480), plan('A1', 1, 700), plan('B1', 2, 1050)])

  test('bedroom need filters the pool', () => {
    const q = withBeds(1, 1)(withBudget(4000))
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'matches')
    assert.equal(out.kind === 'matches' && out.units[0]?.unit.unitId, '12A')
  })

  test('an unavailable bedroom count reports the mismatch specifically', () => {
    const q = withBeds(4, 4)(withBudget(9000))
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'no_match')
    assert.equal(out.kind === 'no_match' && out.reason, 'bedroom_mismatch')
  })

  test('concessions and high floors surface as sayable reasons', () => {
    const withConcession = snap([
      unit({ unitId: '30B', floorPlanId: 'B1', monthlyRent: 5200, bedrooms: 2, floor: 30,
             concession: 'One month free on a 14-month lease', view: 'Manhattan skyline' }),
    ], [plan('B1', 2, 1050)])
    const out = findMatches(withConcession, withBudget(6000), { now: NOW })
    assert.equal(out.kind, 'matches')
    if (out.kind !== 'matches') return
    assert.ok(out.units[0]!.reasons.includes('One month free on a 14-month lease'))
    assert.ok(out.units[0]!.reasons.some((r) => r.includes('high floor')))
  })
})

describe('the loader refuses to invent data', () => {
  test('a unit pointing at a nonexistent floor plan is excluded and reported', () => {
    const r = loadInventory(
      [{ unitId: '9Z', floorPlanId: 'GHOST', monthlyRent: 3000, availableFrom: '2026-10-01' }],
      [{ id: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700 }], NOW, 'test')
    assert.equal(r.snapshot.units.length, 0)
    assert.match(r.problems[0]!.problem, /GHOST/)
  })

  test('an unparseable availability date excludes the unit rather than guessing', () => {
    const r = loadInventory(
      [{ unitId: '9A', floorPlanId: 'A1', monthlyRent: 3000, availableFrom: 'soon' }],
      [{ id: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700 }], NOW, 'test')
    assert.equal(r.snapshot.units.length, 0)
    assert.match(r.problems[0]!.problem, /ISO date/)
  })

  test('a unit disagreeing with its floor plan is surfaced, not silently reconciled', () => {
    const r = loadInventory(
      [{ unitId: '9A', floorPlanId: 'A1', bedrooms: 3, monthlyRent: 3000, availableFrom: '2026-10-01' }],
      [{ id: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700 }], NOW, 'test')
    assert.match(r.problems[0]!.problem, /disagrees with plan/)
  })

  test('valid records load cleanly with no problems', () => {
    const r = loadInventory(
      [{ unitId: '9A', floorPlanId: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700, monthlyRent: 3000, availableFrom: '2026-10-01' }],
      [{ id: 'A1', name: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700 }], NOW, 'test')
    assert.equal(r.problems.length, 0)
    assert.equal(r.snapshot.units.length, 1)
  })
})

describe('a unit available after the move-in window is offered as later, not hidden', () => {
  // The real call: caller said "2 months" (November 7), asked about 19A, which frees up
  // December 1. The old 21-day filter dropped it and the agent said "not available" while
  // the website showed it. Under the six-week window 19A is simply in time.
  const s = snap([
    unit({ unitId: '12A', floorPlanId: 'C1', monthlyRent: 7150, bedrooms: 3, availableFrom: '2026-11-03' }),
    unit({ unitId: '19A', floorPlanId: 'C1', monthlyRent: 7615, bedrooms: 3, availableFrom: '2026-12-01' }),
    unit({ unitId: '22C', floorPlanId: 'C1', monthlyRent: 7400, bedrooms: 3, availableFrom: '2027-01-15' }),
    unit({ unitId: '40Z', floorPlanId: 'C1', monthlyRent: 7000, bedrooms: 3, availableFrom: '2027-06-01' }),
  ], [plan('C1', 3, 1332)])

  const q = captureCore(withBeds(3, 3)(withBudget(9000)), 'moveInTiming',
    extracted({ earliest: new Date('2026-11-07'), latest: null }, 0.9, CALL, '2 months', NOW))

  test('19A, free 24 days after the target, is in time — the old filter hid it', () => {
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'matches')
    if (out.kind !== 'matches') return
    const shown = [...out.units.map((m) => m.unit.unitId), ...out.moreInTime]
    assert.ok(shown.includes('19A'), '19A must be offered as available')
  })

  test('a January unit is offered as later, with its date, never dropped', () => {
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'matches')
    if (out.kind !== 'matches') return
    assert.ok(!out.units.some((m) => m.unit.unitId === '22C'))
    assert.ok(out.later.some((m) => m.unit.unitId === '22C'), 'January is "a bit later" than November')
  })

  test('a unit seven months out is past the horizon and not listed', () => {
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'matches')
    if (out.kind !== 'matches') return
    assert.ok(!out.later.some((m) => m.unit.unitId === '40Z'), 'June is a different search, not "a bit later"')
  })

  test('nothing in time but something later is a timing conversation, not a refusal', () => {
    const onlyLater = snap([
      unit({ unitId: '22C', floorPlanId: 'C1', monthlyRent: 7400, bedrooms: 3, availableFrom: '2027-01-15' }),
    ], [plan('C1', 3, 1332)])
    const out = findMatches(onlyLater, q, { now: NOW })
    assert.equal(out.kind, 'matches')
    assert.equal(out.kind === 'matches' && out.later[0]?.unit.unitId, '22C')
  })

  test('in-time units cut by the limit are named so a caller is never contradicted', () => {
    const many = snap(
      ['A', 'B', 'C', 'D', 'E'].map((l, i) => unit({ unitId: `1${i}${l}`, floorPlanId: 'C1', monthlyRent: 7000 + i * 100, bedrooms: 3, availableFrom: '2026-11-10' })),
      [plan('C1', 3, 1332)])
    const out = findMatches(many, q, { now: NOW, limit: 3 })
    assert.equal(out.kind, 'matches')
    if (out.kind !== 'matches') return
    assert.equal(out.units.length, 3)
    assert.equal(out.moreInTime.length, 2, 'the two not shown must still be named')
  })
})

describe('priced out still says what the money buys', () => {
  test('a smaller layout in budget and in time is offered as an alternative', () => {
    const s = snap([
      unit({ unitId: '13L', floorPlanId: 'B1', bedrooms: 2, monthlyRent: 5875 }),
      unit({ unitId: '08E', floorPlanId: 'A1', bedrooms: 1, monthlyRent: 3900 }),
      unit({ unitId: '06F', floorPlanId: 'S1', bedrooms: 0, monthlyRent: 3255 }),
      unit({ unitId: '30F', floorPlanId: 'S1', bedrooms: 0, monthlyRent: 3255, availableFrom: '2027-06-01' }),
    ], [plan('B1', 2, 1000), plan('A1', 1, 700), plan('S1', 0, 500)])
    const q = captureCore(withBeds(2, 2)(withBudget(4000)), 'moveInTiming',
      extracted({ earliest: new Date('2026-10-01T00:00:00Z'), latest: null }, 0.9, CALL, 'october', NOW))
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'priced_out')
    if (out.kind === 'priced_out') assert.deepEqual(out.alternatives.map((a) => a.unit.unitId), ['08E', '06F'], 'largest first, in time only')
    if (out.kind !== 'priced_out') return
    assert.ok(out.alternatives.length > 0, 'an alternative is offered')
    for (const a of out.alternatives) {
      assert.ok(a.unit.bedrooms < 2)
      assert.ok(a.unit.monthlyRent <= 4000)
    }
  })
})

describe('a window is measured from its far edge', () => {
  test('"within the next two months" includes a residence free seven weeks out', () => {
    const s = snap([
      unit({ unitId: '21B', floorPlanId: 'B1', bedrooms: 2, monthlyRent: 6925, availableFrom: '2026-09-26' }),
      unit({ unitId: '13L', floorPlanId: 'B1', bedrooms: 2, monthlyRent: 5875, availableFrom: '2026-10-22' }),
    ], [plan('B1', 2, 1000)])
    const q = captureCore(withBeds(2, 2)(withBudget(4000)), 'moveInTiming',
      extracted({ earliest: NOW, latest: new Date('2026-11-07T12:00:00Z') }, 0.9, CALL, 'within the next 2 months', NOW))
    const out = findMatches(s, q, { now: NOW })
    assert.equal(out.kind, 'priced_out')
    if (out.kind !== 'priced_out') return
    assert.equal(out.nearest[0]?.unit.unitId, '13L', 'the cheaper residence inside the window is the closest match')
    assert.equal(out.cheapestAvailable, 5875)
    assert.equal(out.gap, 1875)
  })
})
