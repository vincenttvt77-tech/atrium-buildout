import { evaluateVoice, METRICS, parseEvaluation } from './metrics.ts'

const OUTCOMES = ['success', 'failure', 'unreviewed'] as const
type Outcome = typeof OUTCOMES[number]

export class VoiceComparisonInputError extends Error {
  constructor() {
    super('Voice trials cannot be compared. Check the documented matching rules; input values are not echoed.')
    this.name = 'VoiceComparisonInputError'
  }
}
const delta = (before: number | null, after: number | null) => before === null || after === null ? null : after - before

/** Matched cases, aggregate output only. Declared evidence is not independently verified. */
export function compareVoiceEvaluations(baselineInput: unknown, candidateInput: unknown) {
  const baseline = parseEvaluation(baselineInput), candidate = parseEvaluation(candidateInput)
  if (baseline.datasetSha256 !== candidate.datasetSha256 || baseline.evidence !== candidate.evidence
    || baseline.split !== candidate.split || baseline.measurement !== candidate.measurement
    || baseline.cases.length !== candidate.cases.length) throw new VoiceComparisonInputError()
  const candidates = new Map(candidate.cases.map(c => [c.id, c]))
  const pairs = baseline.cases.map(before => {
    const after = candidates.get(before.id)
    if (!after || before.workflow !== after.workflow || before.eligibleForContainment !== after.eligibleForContainment) {
      throw new VoiceComparisonInputError()
    }
    return { before, after }
  })
  const before = evaluateVoice(baseline), after = evaluateVoice(candidate)
  const outcomes = Object.fromEntries(OUTCOMES.map(from => [from,
    Object.fromEntries(OUTCOMES.map(to => [to, pairs.filter(p => p.before.outcome === from && p.after.outcome === to).length])),
  ])) as Record<Outcome, Record<Outcome, number>>
  const critical = Object.fromEntries(Object.keys(before.criticalFailures).map(category => [category, {
    baselineCases: before.criticalFailures[category]!, candidateCases: after.criticalFailures[category]!,
    newlyRecordedOnPreviouslyReviewedCases: pairs.filter(p => p.before.outcome !== 'unreviewed'
      && !p.before.criticalFailures.includes(category) && p.after.criticalFailures.includes(category)).length,
    newlyRecordedOnPreviouslyUnreviewedCases: pairs.filter(p => p.before.outcome === 'unreviewed'
      && p.after.criticalFailures.includes(category)).length,
    noLongerRecordedOnReviewedCases: pairs.filter(p => p.before.criticalFailures.includes(category)
      && p.after.outcome !== 'unreviewed' && !p.after.criticalFailures.includes(category)).length,
    notReconfirmedOnUnreviewedCases: pairs.filter(p => p.before.criticalFailures.includes(category)
      && p.after.outcome === 'unreviewed').length,
  }]))
  const latency = Object.fromEntries(METRICS.map(metric => {
    const coverage = (cohort: typeof baseline) => ({
      casesWithoutTurns: cohort.cases.filter(c => c.turns.length === 0).length,
      casesWithMissingMetric: cohort.cases.filter(c => c.turns.some(t => t[metric] == null)).length,
    })
    const baselineCoverage = coverage(baseline), candidateCoverage = coverage(candidate)
    const complete = pairs.length > 0 && baselineCoverage.casesWithoutTurns === 0 && candidateCoverage.casesWithoutTurns === 0
      && baselineCoverage.casesWithMissingMetric === 0 && candidateCoverage.casesWithMissingMetric === 0
    const b = before.latency.metrics[metric], a = after.latency.metrics[metric]
    return [metric, { baselineCoverage, candidateCoverage, completeRecordedCoverage: complete,
      p50DeltaMs: complete ? delta(b.p50Ms, a.p50Ms) : null,
      p95DeltaMs: complete ? delta(b.p95Ms, a.p95Ms) : null }]
  }))
  const bothCostsCompleteAndReviewed = pairs.length > 0 && before.cost.missingCases === 0 && after.cost.missingCases === 0
    && before.unreviewed === 0 && after.unreviewed === 0
  return {
    format: 'atrium-voice-trial-comparison-v1',
    baseline: before, candidate: after,
    matching: { cases: pairs.length, sameConfiguration: baseline.configurationSha256 === candidate.configurationSha256,
      datasetAndMethodLabelsMatch: true, caseMetadataMatches: true,
      casesWithDifferentTurnCounts: pairs.filter(p => p.before.turns.length !== p.after.turns.length).length,
      declaredProvenanceVerified: false },
    paired: { outcomes, criticalFailures: critical,
      reviewedSuccessRegressions: outcomes.success.failure,
      reviewedSuccessImprovements: outcomes.failure.success,
      newlyUnreviewedCases: outcomes.success.unreviewed + outcomes.failure.unreviewed },
    deltas: { direction: 'candidate_minus_baseline', rateUnit: 'fraction',
      successRateOfAllCases: delta(before.successRateOfAllCases, after.successRateOfAllCases),
      containmentRateOfEligible: delta(before.containment.rateOfEligible, after.containment.rateOfEligible),
      latency: { unit: 'milliseconds', weighting: 'turn', pairedTurns: false, metrics: latency },
      cost: { currency: 'USD', bothCostsCompleteAndReviewed,
        totalCost: bothCostsCompleteAndReviewed ? delta(before.cost.totalKnownCost, after.cost.totalKnownCost) : null,
        costPerSuccessfulCase: bothCostsCompleteAndReviewed ? delta(before.cost.costPerSuccessfulCase, after.cost.costPerSuccessfulCase) : null } },
    assessment: { productionReadiness: 'not_established',
      candidateHasRecordedCriticalFailures: Object.values(after.criticalFailures).some(n => n > 0),
      bothFullyReviewed: pairs.length > 0 && before.unreviewed === 0 && after.unreviewed === 0,
      limitations: [
        'Matching uses declared dataset, provenance, method, case IDs, workflows and eligibility; labels do not prove equivalent trials.',
        'Latency deltas compare turn-weighted distributions, not paired turns or causal effects; long calls contribute more samples.',
        'Complete recorded coverage cannot prove every real turn was recorded or that measurement boundaries match.',
        'Failed and unreviewed cases remain in the report. Faster failure is not a quality improvement.',
        'Missing case timings prevent latency deltas; missing costs or unreviewed outcomes prevent cost deltas.',
        'Critical changes describe recorded judgments; unreviewed outcomes cannot establish resolution.',
        'No statistical confidence, voice naturalness, licensing, production readiness or provider recommendation is established.',
      ] },
  }
}
