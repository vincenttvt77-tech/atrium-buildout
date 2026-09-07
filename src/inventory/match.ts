import type { InventorySnapshot, Unit } from './types.ts'
import type { QualificationState } from '../leasing/qualification.ts'

export interface MatchOptions {
  now: Date
  /** How stale a snapshot may be before the agent must re-read rather than quote it. */
  maxSnapshotAgeMs?: number
  /** Units priced within this fraction above budget are "just over" rather than excluded. */
  stretchFraction?: number
  limit?: number
}

export interface ScoredUnit {
  unit: Unit
  score: number
  /** Why this unit was surfaced, in words the agent can actually say. */
  reasons: string[]
}

export type MatchOutcome =
  /** Verified units the agent may name, price and offer. */
  | { kind: 'matches'; units: ScoredUnit[]; stretch: ScoredUnit[] }
  /**
   * Inventory has units but none the prospect can afford. This is not a failure — it is
   * the single most valuable signal the system captures, and it must be recorded as a
   * priced-out event rather than papered over by offering something dearer.
   */
  | { kind: 'priced_out'; budgetMax: number; cheapestAvailable: number; gap: number; nearest: ScoredUnit[] }
  /** Nothing matches the stated need at all. */
  | { kind: 'no_match'; reason: 'no_availability' | 'bedroom_mismatch' | 'timing_mismatch' }
  /** The snapshot is too old to quote from. The agent must re-read before saying anything. */
  | { kind: 'stale'; readAt: Date; ageMs: number }

const DAY = 86_400_000

function offerable(u: Unit, now: Date, moveIn: Date | null): boolean {
  if (u.status !== 'available') return false
  const from = Date.parse(u.availableFrom)
  // A unit available in the past is available now.
  if (moveIn === null) return true
  // Allow a unit that frees up within three weeks of the desired date — real prospects flex.
  return from <= moveIn.getTime() + 21 * DAY
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
  const maxAge = opts.maxSnapshotAgeMs ?? 15 * 60_000
  const age = opts.now.getTime() - snapshot.readAt.getTime()
  if (age > maxAge) return { kind: 'stale', readAt: snapshot.readAt, ageMs: age }

  const moveIn = qual.moveInTiming?.value.earliest ?? null
  const beds = qual.bedrooms?.value
  const budgetMax = qual.budget?.value.maxMonthly ?? null

  let pool = snapshot.units.filter((u) => offerable(u, opts.now, moveIn))
  if (pool.length === 0) return { kind: 'no_match', reason: 'no_availability' }

  if (beds) {
    const byBeds = pool.filter((u) => u.bedrooms >= beds.min && u.bedrooms <= beds.max)
    if (byBeds.length === 0) return { kind: 'no_match', reason: 'bedroom_mismatch' }
    pool = byBeds
  }

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
    if (moveIn) {
      const diff = Math.abs(Date.parse(u.availableFrom) - moveIn.getTime())
      if (diff < 14 * DAY) { s += 15; reasons.push('available right when they need it') }
    }
    return { unit: u, score: s, reasons }
  }

  const limit = opts.limit ?? 3

  if (budgetMax === null) {
    const all = pool.map(score).sort((a, b) => b.score - a.score)
    return { kind: 'matches', units: all.slice(0, limit), stretch: [] }
  }

  const stretchTo = budgetMax * (1 + (opts.stretchFraction ?? 0.08))
  const within = pool.filter((u) => u.monthlyRent <= budgetMax).map(score)
  const stretch = pool
    .filter((u) => u.monthlyRent > budgetMax && u.monthlyRent <= stretchTo)
    .map(score)

  if (within.length === 0 && stretch.length === 0) {
    const cheapest = Math.min(...pool.map((u) => u.monthlyRent))
    const nearest = pool
      .slice()
      .sort((a, b) => a.monthlyRent - b.monthlyRent)
      .slice(0, limit)
      .map(score)
    return {
      kind: 'priced_out',
      budgetMax,
      cheapestAvailable: cheapest,
      gap: cheapest - budgetMax,
      nearest,
    }
  }

  return {
    kind: 'matches',
    units: within.sort((a, b) => b.score - a.score).slice(0, limit),
    stretch: stretch.sort((a, b) => a.unit.monthlyRent - b.unit.monthlyRent).slice(0, 2),
  }
}
