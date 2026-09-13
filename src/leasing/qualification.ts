import type { Captured } from './captured.ts'
import { reconcile } from './captured.ts'

export interface MoveInTiming {
  /** Earliest date the prospect could move. */
  earliest: Date
  /** Null when they said something open-ended like "sometime this spring". */
  latest: Date | null
}

export interface BudgetSignal {
  /** Monthly rent ceiling as stated. Never inferred from what they were shown. */
  maxMonthly: number | null
  /** A stated spending floor, distinct from a ceiling. Null ceiling means none stated. */
  minMonthly?: number
  /** True when they volunteered a hard limit rather than reacting to a quote. */
  stated: boolean
}

export interface BedroomNeed {
  min: number
  max: number
}

export type ObjectionKind =
  | 'price' | 'timing' | 'unit_mismatch' | 'floor_plan' | 'pets' | 'parking'
  | 'policy' | 'location' | 'competitor' | 'application_friction' | 'feature_missing'

export interface Objection {
  kind: ObjectionKind
  detail: string
}

export interface QualificationState {
  moveInTiming?: Captured<MoveInTiming>
  budget?: Captured<BudgetSignal>
  bedrooms?: Captured<BedroomNeed>
  pets?: Captured<{ hasPets: boolean; description: string }>
  parking?: Captured<{ needed: boolean }>
  amenityPriorities: Captured<string>[]
  desiredFeatures: Captured<string>[]
  objections: Captured<Objection>[]
  source?: Captured<string>
}

export const emptyQualification = (): QualificationState => ({
  amenityPriorities: [], desiredFeatures: [], objections: [],
})

/** The three signals that gate quoting, per SOW 5.2(4). */
export type CoreSignal = 'moveInTiming' | 'budget' | 'bedrooms'

export const CORE_SIGNALS: readonly CoreSignal[] = ['moveInTiming', 'budget', 'bedrooms']

export type QuoteGate =
  | { allowed: true; captured: CoreSignal[] }
  | { allowed: false; captured: CoreSignal[]; missing: CoreSignal[]; needed: number }

/**
 * "Qualify before quoting where practical by obtaining at least two of move-in timing,
 * bedroom/unit need, and budget" — SOW 5.2(4).
 *
 * Quoting a price to someone who has told you nothing is how you end up showing a
 * $3,200 unit to somebody with a $2,000 ceiling, and then recording "went quiet" as the
 * loss reason instead of the truth.
 */
export function mayQuote(state: QualificationState, minimumSignals = 2): QuoteGate {
  const captured = CORE_SIGNALS.filter((s) => state[s] !== undefined)
  if (captured.length >= minimumSignals) return { allowed: true, captured }
  return {
    allowed: false,
    captured,
    missing: CORE_SIGNALS.filter((s) => state[s] === undefined),
    needed: minimumSignals - captured.length,
  }
}

/** Which core signal to ask for next. Budget last — it is the one people resist. */
export function nextSignalToAsk(state: QualificationState): CoreSignal | null {
  const order: CoreSignal[] = ['moveInTiming', 'bedrooms', 'budget']
  return order.find((s) => state[s] === undefined) ?? null
}

export function captureCore<K extends CoreSignal>(
  state: QualificationState,
  key: K,
  incoming: NonNullable<QualificationState[K]>,
): QualificationState {
  return { ...state, [key]: reconcile(state[key] as never, incoming as never) }
}
