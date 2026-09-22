import type { InventorySnapshot, Unit } from './types.ts'
import type { QualificationState } from '../leasing/qualification.ts'
import { inventoryIsQuotable } from './source.ts'
export { inventoryIsFresh } from './source.ts'

export interface MatchOptions {
  now: Date
  /** How stale a snapshot may be before the agent must re-read rather than quote it. */
  maxSnapshotAgeMs?: number
  /** Units priced within this fraction above budget are "just over" rather than excluded. */
  stretchFraction?: number
  limit?: number
  sortBy?: 'price_desc'
}

export interface ScoredUnit {
  unit: Unit
  score: number
  /** Why this unit was surfaced, in words the agent can actually say. */
  reasons: string[]
}

export type MatchOutcome =
  /**
   * Verified units the agent may name, price and offer. `later` are units that fit
   * everything except the move-in date — available after the caller's window. They are
   * returned separately, not dropped: a caller who said "two months" and is told a unit
   * "isn't available" when the website shows it free on December 1 hears a contradiction,
   * not a filter. The right sentence is "there's one on 19 but not until December 1 —
   * would that work?"
   */
  | { kind: 'matches'; units: ScoredUnit[]; stretch: ScoredUnit[]; later: ScoredUnit[];
      /** In-time, in-budget units not shown because of the limit. Named so a caller who
       *  asks about one is never contradicted. */
      moreInTime: string[] }
  /**
   * Inventory has units but none the prospect can afford. This is not a failure — it is
   * the single most valuable signal the system captures, and it must be recorded as a
   * priced-out event rather than papered over by offering something dearer.
   */
  | {
      kind: 'priced_out'; budgetMax: number; cheapestAvailable: number; gap: number; nearest: ScoredUnit[]
      /** In budget and in time, one size down — what a good agent offers instead of "no". */
      alternatives: ScoredUnit[]
    }
  /** Nothing matches the stated need at all. */
  | { kind: 'no_match'; reason: 'no_availability' | 'bedroom_mismatch' | 'timing_mismatch' | 'below_minimum_budget' }
  /** The snapshot is too old to quote from. The agent must re-read before saying anything. */
  | { kind: 'stale'; readAt: Date; ageMs: number }

const DAY = 86_400_000

/** Available at all: on the market and not pending. Timing is judged separately. */
function onMarket(u: Unit): boolean {
  return u.status === 'available'
}

/**
 * A stated window ends at its actual boundary. Later residences are identified
 * separately; only an explicit broader search may remove the timing constraint.
 */
function inTime(u: Unit, until: Date | null): boolean {
  if (until === null) return true
  return Date.parse(u.availableFrom) <= until.getTime()
}

/**
 * "A bit later than you wanted" has an edge. A unit three months past the target is worth
 * a sentence; one six months out is a different search, and listing it makes the agent
 * sound like it is reading the whole building.
 */
function withinLaterHorizon(u: Unit, until: Date | null): boolean {
  if (until === null) return false
  return Date.parse(u.availableFrom) <= until.getTime() + 120 * DAY
}

/**
 * Finds units the agent may actually offer.
 *
 * Everything returned here is verified against the snapshot. The agent may not name a unit,
 * a rent or an availability date that did not come through this function — SOW 6.2 requires
 * it never claim an option it cannot verify.
 */
export function findMatches(
  snapshot: InventorySnapshot,
  qual: QualificationState,
  opts: MatchOptions,
): MatchOutcome {
  const age = opts.now.getTime() - snapshot.readAt.getTime()
  if (!inventoryIsQuotable(snapshot, opts.now, opts.maxSnapshotAgeMs)) return { kind: 'stale', readAt: snapshot.readAt, ageMs: age }

  const window = qual.moveInTiming?.value ?? null
  const from = window?.earliest ?? null
  // The far edge of what they said, or the one date they gave.
  const moveIn = window ? (window.latest ?? window.earliest) : null
  const beds = qual.bedrooms?.value
  const budgetMax = qual.budget?.value.maxMonthly ?? null
  const budgetMin = qual.budget?.value.minMonthly ?? null

  let market = snapshot.units.filter(onMarket)
  if (market.length === 0) return { kind: 'no_match', reason: 'no_availability' }

  if (beds) {
    const byBeds = market.filter((u) => u.bedrooms >= beds.min && u.bedrooms <= beds.max)
    if (byBeds.length === 0) return { kind: 'no_match', reason: 'bedroom_mismatch' }
    market = byBeds
  }
  if (budgetMin !== null) {
    market = market.filter(unit => unit.monthlyRent >= budgetMin)
    if (market.length === 0) return { kind: 'no_match', reason: 'below_minimum_budget' }
  }

  // Split on timing rather than filtering on it, so the later ones can still be offered.
  const pool = market.filter((u) => inTime(u, moveIn))
  const laterPool = market.filter((u) => !inTime(u, moveIn) && withinLaterHorizon(u, moveIn))
  if (pool.length === 0 && laterPool.length === 0) return { kind: 'no_match', reason: 'no_availability' }

  const score = (u: Unit): ScoredUnit => {
    const reasons: string[] = []
    let s = 0
    if (budgetMax !== null) {
      const headroom = budgetMax - u.monthlyRent
      if (headroom >= 0) { s += 40; if (headroom < 200) reasons.push('right at the top of their range') }
    }
    if (beds) { s += 25; reasons.push(`${u.bedrooms} bedroom`) }
    if (u.concession) { s += 15; reasons.push(u.concession) }
    if (u.view) { s += 5; reasons.push(u.view) }
    if (u.floor >= 20) { s += 5; reasons.push(`high floor — ${u.floor}`) }
    if (from && moveIn) {
      const t = Date.parse(u.availableFrom)
      if (t >= from.getTime() && t <= moveIn.getTime()) {
        s += 15; reasons.push('available right when they need it')
      }
    }
    return { unit: u, score: s, reasons }
  }

  const limit = opts.limit ?? 3
  const rank = (a: ScoredUnit, b: ScoredUnit) => opts.sortBy === 'price_desc'
    ? b.unit.monthlyRent - a.unit.monthlyRent || b.score - a.score : b.score - a.score

  const later = laterPool
    .filter((u) => budgetMax === null || u.monthlyRent <= budgetMax * (1 + (opts.stretchFraction ?? 0.08)))
    .map(score)
    .sort((a, b) => Date.parse(a.unit.availableFrom) - Date.parse(b.unit.availableFrom))
    .slice(0, 2)

  if (budgetMax === null) {
    const all = pool.map(score).sort(rank)
    return {
      kind: 'matches', units: all.slice(0, limit), stretch: [], later,
      moreInTime: all.slice(limit).map((m) => m.unit.unitId),
    }
  }

  const stretchTo = budgetMax * (1 + (opts.stretchFraction ?? 0.08))
  const within = pool.filter((u) => u.monthlyRent <= budgetMax).map(score)
  const stretch = pool
    .filter((u) => u.monthlyRent > budgetMax && u.monthlyRent <= stretchTo)
    .map(score)

  if (within.length === 0 && stretch.length === 0 && later.length > 0) {
    // Nothing in time, but something in budget later. That is a timing conversation,
    // not a price one.
    return { kind: 'matches', units: [], stretch: [], later, moreInTime: [] }
  }

  if (within.length === 0 && stretch.length === 0) {
    if (pool.length === 0) return { kind: 'no_match', reason: 'timing_mismatch' }
    const cheapest = Math.min(...pool.map((u) => u.monthlyRent))
    const nearest = pool
      .slice()
      .sort((a, b) => a.monthlyRent - b.monthlyRent)
      .slice(0, limit)
      .map(score)
    /*
     * "Nothing in your budget" ends the call; "nothing in that size, but here is what your
     * budget does buy" keeps it going. Smaller layouts that fit the money and the timing,
     * largest first, so the agent can offer a real alternative instead of an apology.
     */
    const alternatives = beds
      ? snapshot.units
          .filter(onMarket)
          .filter((u) => budgetMin === null || u.monthlyRent >= budgetMin)
          .filter((u) => u.bedrooms < beds.min && u.monthlyRent <= budgetMax && inTime(u, moveIn))
          .sort((a, b) => b.bedrooms - a.bedrooms || b.monthlyRent - a.monthlyRent)
          .slice(0, limit)
          .map(score)
      : []
    return {
      kind: 'priced_out',
      budgetMax,
      cheapestAvailable: cheapest,
      gap: cheapest - budgetMax,
      nearest,
      alternatives,
    }
  }

  const rankedWithin = within.sort(rank)
  return {
    kind: 'matches',
    units: rankedWithin.slice(0, limit),
    stretch: stretch.sort((a, b) => a.unit.monthlyRent - b.unit.monthlyRent).slice(0, 2),
    later,
    moreInTime: rankedWithin.slice(limit).map((m) => m.unit.unitId),
  }
}
