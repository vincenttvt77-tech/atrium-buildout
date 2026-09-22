/** Offline, aggregate-only evaluation. No provider calls, credentials or transcripts. */
export const METRICS = ['responseMs', 'endpointingMs', 'transcriberMs', 'modelFirstTokenMs',
  'voiceFirstAudioMs', 'toolMs', 'networkMs'] as const
const WORKFLOWS = ['known_unit', 'unit_search', 'property_question', 'book_tour', 'reschedule', 'cancel', 'handoff'] as const
const CRITICAL = ['tenant_isolation', 'unauthorized_access', 'duplicate_action', 'false_confirmation', 'data_loss'] as const
type Metric = typeof METRICS[number]
type Sample = Partial<Record<Metric, number | null>>
type Case = { id: string; workflow: typeof WORKFLOWS[number]; outcome: 'success' | 'failure' | 'unreviewed';
  eligibleForContainment: boolean; containment: 'contained' | 'handoff' | 'unreviewed';
  criticalFailures: string[]; costUsd: number | null; turns: Sample[] }
type Cohort = { schemaVersion: 1; timingUnit: 'milliseconds'; evidence: 'synthetic' | 'real_call';
  split: 'development' | 'held_out'; configurationSha256: string; datasetSha256: string;
  measurement: 'audio_annotation' | 'instrumentation'; cases: Case[] }

export class EvaluationInputError extends Error {
  constructor() { super('Invalid evaluation input. Check the documented schema; input values are not echoed.'); this.name = 'EvaluationInputError' }
}
const fail = (): never => { throw new EvaluationInputError() }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail()
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail()
  return value as T
}
function number(value: unknown, max: number): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return fail()
  return value
}
/** Strict validation rejects unknown fields so raw calls/contacts cannot pass as evaluation rows. */
export function parseEvaluation(input: unknown): Cohort {
  const root = record(input)
  keys(root, ['schemaVersion', 'timingUnit', 'evidence', 'split', 'configurationSha256', 'datasetSha256', 'measurement', 'cases'])
  if (root.schemaVersion !== 1 || root.timingUnit !== 'milliseconds') return fail()
  for (const key of ['configurationSha256', 'datasetSha256']) {
    if (typeof root[key] !== 'string' || !/^[a-f0-9]{64}$/.test(root[key] as string)) return fail()
  }
  if (!Array.isArray(root.cases) || root.cases.length > 10_000) return fail()
  const seen = new Set<string>()
  let turnCount = 0
  const cases = root.cases.map(raw => {
    const c = record(raw)
    keys(c, ['id', 'workflow', 'outcome', 'eligibleForContainment', 'containment', 'criticalFailures', 'costUsd', 'turns'])
    if (typeof c.id !== 'string' || !/^case-[0-9]{1,8}$/.test(c.id) || seen.has(c.id)) return fail()
    seen.add(c.id)
    const outcome = oneOf(c.outcome, ['success', 'failure', 'unreviewed'])
    const containment = oneOf(c.containment, ['contained', 'handoff', 'unreviewed'])
    if (typeof c.eligibleForContainment !== 'boolean' || !Array.isArray(c.criticalFailures)) return fail()
    const criticalFailures = c.criticalFailures.map(v => oneOf(v, CRITICAL))
    if (new Set(criticalFailures).size !== criticalFailures.length || (criticalFailures.length && outcome !== 'failure')) return fail()
    if (!c.eligibleForContainment && containment === 'contained') return fail()
    if (!Array.isArray(c.turns) || c.turns.length > 1000 || (turnCount += c.turns.length) > 100_000) return fail()
    const turns = c.turns.map(rawTurn => {
      const turn = record(rawTurn)
      keys(turn, METRICS)
      return Object.fromEntries(METRICS.map(metric => [metric, number(turn[metric], 3_600_000)])) as Sample
    })
    return { id: c.id, workflow: oneOf(c.workflow, WORKFLOWS), outcome, containment,
      eligibleForContainment: c.eligibleForContainment, criticalFailures, costUsd: number(c.costUsd, 1_000_000), turns }
  })
  return { schemaVersion: 1, timingUnit: 'milliseconds', evidence: oneOf(root.evidence, ['synthetic', 'real_call']),
    split: oneOf(root.split, ['development', 'held_out']), measurement: oneOf(root.measurement, ['audio_annotation', 'instrumentation']),
    configurationSha256: root.configurationSha256 as string, datasetSha256: root.datasetSha256 as string, cases }
}
function distribution(values: number[], total: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (q: number) => sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]! : null
  return { samples: sorted.length, missing: total - sorted.length,
    p50Ms: quantile(0.5), p95Ms: quantile(0.95), maxMs: sorted.at(-1) ?? null }
}
const rate = (n: number, d: number) => d ? n / d : null
export function evaluateVoice(input: unknown) {
  const cohort = parseEvaluation(input), cases = cohort.cases
  const successful = cases.filter(c => c.outcome === 'success').length
  const failed = cases.filter(c => c.outcome === 'failure').length
  const unreviewed = cases.length - successful - failed
  const eligible = cases.filter(c => c.eligibleForContainment)
  const contained = eligible.filter(c => c.containment === 'contained' && c.outcome === 'success').length
  const turns = cases.flatMap(c => c.turns)
  const critical = Object.fromEntries(CRITICAL.map(key => [key, cases.filter(c => c.criticalFailures.includes(key)).length]))
  const costs = cases.flatMap(c => c.costUsd === null ? [] : [c.costUsd])
  const totalKnownCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null
  return {
    schemaVersion: 1, evidence: cohort.evidence, split: cohort.split, measurement: cohort.measurement,
    configurationSha256: cohort.configurationSha256, datasetSha256: cohort.datasetSha256,
    cases: cases.length, successful, failed, unreviewed,
    successRateOfReviewed: rate(successful, successful + failed),
    successRateOfAllCases: rate(successful, cases.length),
    workflows: Object.fromEntries(WORKFLOWS.map(key => {
      const group = cases.filter(c => c.workflow === key)
      return [key, { cases: group.length, successful: group.filter(c => c.outcome === 'success').length,
        unreviewed: group.filter(c => c.outcome === 'unreviewed').length }]
    })),
    containment: { eligibleCases: eligible.length, successfulContainedCases: contained,
      unreviewedCases: eligible.filter(c => c.containment === 'unreviewed' || c.outcome === 'unreviewed').length,
      rateOfEligible: rate(contained, eligible.length) },
    criticalFailures: critical,
    latency: { unit: 'milliseconds', percentileMethod: 'nearest_rank', turns: turns.length,
      metrics: Object.fromEntries(METRICS.map(metric => [metric,
        distribution(turns.flatMap(t => t[metric] == null ? [] : [t[metric]!]), turns.length)])) as Record<Metric, ReturnType<typeof distribution>> },
    cost: { currency: 'USD', measuredCases: costs.length, missingCases: cases.length - costs.length,
      totalKnownCost, costPerSuccessfulCase: costs.length === cases.length && !unreviewed && successful
        ? totalKnownCost! / successful : null },
    assessment: { routineSuccessTarget: 0.95,
      observedTargetMet: cases.length > 0 && unreviewed === 0 && successful / cases.length >= 0.95
        && Object.values(critical).every(count => count === 0),
      realHeldOutEvidence: cohort.evidence === 'real_call' && cohort.split === 'held_out',
      productionReadiness: 'not_established',
      limitations: ['Declared provenance and reviewer judgments are not independently verified.',
        'This sample does not establish full workflow, safety-suite, audio-quality or production acceptance.',
        'Missing timings are excluded with counts; component timings are never added into a fabricated total.',
        'Response timing must end at first meaningful audible content; filler is not a useful response.'] },
  }
}
