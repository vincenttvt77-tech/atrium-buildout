import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVoiceEvaluations, VoiceComparisonInputError } from '../compare.ts'

const sample = (over: Record<string, unknown> = {}) => ({ id: 'case-1', workflow: 'known_unit', outcome: 'success',
  eligibleForContainment: true, containment: 'contained', criticalFailures: [], costUsd: 0.2,
  turns: [{ responseMs: 100 }, { responseMs: 900 }], ...over })
const cohort = (cases: unknown[] = [sample()], over = {}) => ({ schemaVersion: 1, timingUnit: 'milliseconds',
  evidence: 'synthetic', split: 'development', configurationSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64),
  measurement: 'audio_annotation', cases, ...over })
const compare = (a: unknown[], b: unknown[]) => compareVoiceEvaluations(cohort(a), cohort(b, { configurationSha256: 'c'.repeat(64) }))

test('case matching uses identity, not array order, and reports regressions hidden by net success', () => {
  const a = [sample(), sample({ id: 'case-2', outcome: 'failure' })]
  const b = [sample({ id: 'case-2' }), sample({ outcome: 'failure' })]
  const r = compare(a, b)
  assert.equal(r.deltas.successRateOfAllCases, 0)
  assert.equal(r.paired.reviewedSuccessRegressions, 1)
  assert.equal(r.paired.reviewedSuccessImprovements, 1)
  assert.equal(r.matching.sameConfiguration, false)
  assert.deepEqual(r.paired.outcomes, { success: { success: 0, failure: 1, unreviewed: 0 },
    failure: { success: 1, failure: 0, unreviewed: 0 }, unreviewed: { success: 0, failure: 0, unreviewed: 0 } })
  assert.doesNotMatch(JSON.stringify(r), /case-[12]/)
})

test('dropping, adding or replacing cases fails even when the declared dataset hash matches', () => {
  const a = [sample(), sample({ id: 'case-2', outcome: 'failure' })]
  for (const b of [[sample()], [...a, sample({ id: 'case-3' })], [sample(), sample({ id: 'case-3' })]]) {
    assert.throws(() => compare(a, b), VoiceComparisonInputError)
  }
})

test('changed workflow or containment eligibility cannot make a candidate look better', () => {
  assert.throws(() => compare([sample()], [sample({ workflow: 'property_question' })]), VoiceComparisonInputError)
  assert.throws(() => compare([sample()], [sample({ eligibleForContainment: false, containment: 'handoff' })]), VoiceComparisonInputError)
})

test('dataset, provenance, split and measurement labels must match', () => {
  for (const change of [{ datasetSha256: 'd'.repeat(64) }, { evidence: 'real_call' }, { split: 'held_out' }, { measurement: 'instrumentation' }]) {
    assert.throws(() => compareVoiceEvaluations(cohort(), cohort(undefined, change)), VoiceComparisonInputError)
  }
})

test('outcome and containment denominators keep failures and unreviewed cases', () => {
  const a = [sample(), sample({ id: 'case-2' }), sample({ id: 'case-3', eligibleForContainment: false, containment: 'handoff' })]
  const b = [sample({ outcome: 'failure' }), sample({ id: 'case-2', outcome: 'unreviewed', containment: 'unreviewed' }), a[2]!]
  const r = compare(a, b)
  assert.equal(r.candidate.successRateOfAllCases, 1 / 3)
  assert.equal(r.candidate.containment.eligibleCases, 2)
  assert.equal(r.candidate.containment.rateOfEligible, 0)
  assert.equal(r.deltas.containmentRateOfEligible, -1)
  assert.equal(r.paired.newlyUnreviewedCases, 1)
  assert.equal(r.assessment.bothFullyReviewed, false)
  assert.equal(r.deltas.cost.totalCost, null)
})

test('a faster failed call remains a recorded critical regression', () => {
  const r = compare([sample()], [sample({ outcome: 'failure', criticalFailures: ['false_confirmation'], turns: [{ responseMs: 1 }] })])
  assert.equal(r.deltas.latency.metrics.responseMs!.p95DeltaMs, -899)
  assert.equal(r.paired.reviewedSuccessRegressions, 1)
  assert.equal(r.paired.criticalFailures.false_confirmation!.newlyRecordedOnPreviouslyReviewedCases, 1)
  assert.equal(r.assessment.candidateHasRecordedCriticalFailures, true)
  assert.equal(r.candidate.assessment.observedTargetMet, false)
  assert.equal(r.assessment.productionReadiness, 'not_established')
})

test('critical labels changing within failed cases are compared by case and category', () => {
  const r = compare([sample({ outcome: 'failure', criticalFailures: ['data_loss'] })],
    [sample({ outcome: 'failure', criticalFailures: ['duplicate_action'] })])
  assert.equal(r.paired.criticalFailures.data_loss!.noLongerRecordedOnReviewedCases, 1)
  assert.equal(r.paired.criticalFailures.duplicate_action!.newlyRecordedOnPreviouslyReviewedCases, 1)
  assert.equal(r.paired.reviewedSuccessRegressions, 0)
  assert.equal(r.assessment.candidateHasRecordedCriticalFailures, true)
})

test('unreviewed critical outcomes are not described as resolved or previously verified', () => {
  const r = compare([sample({ outcome: 'failure', criticalFailures: ['tenant_isolation'] }),
    sample({ id: 'case-2', outcome: 'unreviewed' })],
  [sample({ outcome: 'unreviewed' }), sample({ id: 'case-2', outcome: 'failure', criticalFailures: ['data_loss'] })])
  assert.equal(r.paired.criticalFailures.tenant_isolation!.noLongerRecordedOnReviewedCases, 0)
  assert.equal(r.paired.criticalFailures.tenant_isolation!.notReconfirmedOnUnreviewedCases, 1)
  assert.equal(r.paired.criticalFailures.data_loss!.newlyRecordedOnPreviouslyReviewedCases, 0)
  assert.equal(r.paired.criticalFailures.data_loss!.newlyRecordedOnPreviouslyUnreviewedCases, 1)
})

test('latency deltas use nearest-rank distributions without inventing paired turns', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ responseMs: (20 - i) * 100 }))
  const r = compare([sample({ turns })], [sample({ turns: [{ responseMs: 200 }, { responseMs: 500 }] })])
  assert.equal(r.deltas.latency.metrics.responseMs!.p50DeltaMs, -800)
  assert.equal(r.deltas.latency.metrics.responseMs!.p95DeltaMs, -1400)
  assert.equal(r.matching.casesWithDifferentTurnCounts, 1)
  assert.equal(r.deltas.latency.pairedTurns, false)
  assert.equal(r.deltas.latency.weighting, 'turn')
})

test('missing metrics or whole cases without turns prevent latency deltas in either direction', () => {
  for (const turns of [[], [{}], [{ responseMs: 10 }, {}], [{ responseMs: null }]]) {
    for (const [a, b] of [[sample(), sample({ turns })], [sample({ turns }), sample()]]) {
      const r = compare([a!], [b!])
      assert.equal(r.deltas.latency.metrics.responseMs!.completeRecordedCoverage, false)
      assert.equal(r.deltas.latency.metrics.responseMs!.p95DeltaMs, null)
    }
  }
  const r = compare([sample(), sample({ id: 'case-2' })], [sample(), sample({ id: 'case-2', outcome: 'failure', turns: [] })])
  assert.equal(r.deltas.latency.metrics.responseMs!.candidateCoverage.casesWithoutTurns, 1)
  assert.equal(r.deltas.latency.metrics.responseMs!.p95DeltaMs, null)
  assert.equal(r.candidate.latency.metrics.responseMs.samples, 2)
})

test('component measurements cannot manufacture response time and real zero is retained', () => {
  const r = compare([sample({ turns: [{ toolMs: 12 }], costUsd: 0 })], [sample({ turns: [{ toolMs: 0 }], costUsd: 0 })])
  assert.equal(r.deltas.latency.metrics.toolMs!.p95DeltaMs, -12)
  assert.equal(r.deltas.latency.metrics.responseMs!.p95DeltaMs, null)
  assert.equal(r.candidate.latency.metrics.toolMs.p95Ms, 0)
  assert.equal(r.deltas.cost.costPerSuccessfulCase, 0)
})

test('cost includes failed calls and becomes unknown with missing costs or no successes', () => {
  const a = [sample({ costUsd: 1 }), sample({ id: 'case-2', outcome: 'failure', costUsd: 3 })]
  const b = [sample({ costUsd: 1 }), sample({ id: 'case-2', outcome: 'failure', costUsd: 5 })]
  const r = compare(a, b)
  assert.equal(r.candidate.cost.costPerSuccessfulCase, 6)
  assert.equal(r.deltas.cost.costPerSuccessfulCase, 2)
  for (const costUsd of [null, undefined]) {
    assert.equal(compare(a, [sample({ costUsd }), b[1]!]).deltas.cost.totalCost, null)
  }
  assert.equal(compare(a, [sample({ outcome: 'failure' }), b[1]!]).deltas.cost.costPerSuccessfulCase, null)
})

test('empty trials have no perfect score, cost delta, latency delta or reviewed evidence', () => {
  const r = compare([], [])
  assert.equal(r.matching.cases, 0)
  assert.equal(r.deltas.successRateOfAllCases, null)
  assert.equal(r.deltas.containmentRateOfEligible, null)
  assert.equal(r.deltas.latency.metrics.responseMs!.p50DeltaMs, null)
  assert.equal(r.deltas.cost.totalCost, null)
  assert.equal(r.assessment.bothFullyReviewed, false)
})

test('same-configuration repeats and real held-out labels still do not establish readiness', () => {
  const input = cohort(undefined, { evidence: 'real_call', split: 'held_out' })
  const r = compareVoiceEvaluations(input, input)
  assert.equal(r.matching.sameConfiguration, true)
  assert.equal(r.baseline.assessment.realHeldOutEvidence, true)
  assert.equal(r.matching.declaredProvenanceVerified, false)
  assert.equal(r.assessment.productionReadiness, 'not_established')
})

test('both inputs undergo the original strict validation without raw input echo', () => {
  for (const input of [cohort([sample(), sample()]), cohort([sample({ transcript: 'PRIVATE_TEXT' })]),
    cohort([sample({ turns: [{ responseMs: -1 }] })]), cohort([], { timingUnit: 'seconds' })]) {
    for (const [a, b] of [[input, cohort()], [cohort(), input]]) {
      assert.throws(() => compareVoiceEvaluations(a, b), error => error instanceof Error && !error.message.includes('PRIVATE_TEXT'))
    }
  }
})
