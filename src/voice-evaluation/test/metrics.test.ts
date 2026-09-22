import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateVoice } from '../metrics.ts'

const sample = (over: Record<string, unknown> = {}) => ({ id: 'case-1', workflow: 'known_unit', outcome: 'success',
  eligibleForContainment: true, containment: 'contained', criticalFailures: [], costUsd: 0.2,
  turns: [{ responseMs: 100, modelFirstTokenMs: 40 }, { responseMs: 900 }], ...over })
const cohort = (cases: unknown[] = [sample()], over = {}) => ({ schemaVersion: 1, timingUnit: 'milliseconds',
  evidence: 'synthetic', split: 'development', configurationSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64),
  measurement: 'audio_annotation', cases, ...over })

test('per-turn percentile uses actual values and explicit missing denominators', () => {
  const r = evaluateVoice(cohort())
  assert.deepEqual(r.latency.metrics.responseMs, { samples: 2, missing: 0, p50Ms: 100, p95Ms: 900, maxMs: 900 })
  assert.deepEqual(r.latency.metrics.modelFirstTokenMs, { samples: 1, missing: 1, p50Ms: 40, p95Ms: 40, maxMs: 40 })
  assert.deepEqual(r.latency.metrics.networkMs, { samples: 0, missing: 2, p50Ms: null, p95Ms: null, maxMs: null })
})
test('component timings cannot manufacture caller response timings', () => {
  const r = evaluateVoice(cohort([sample({ turns: [{ modelFirstTokenMs: 80, voiceFirstAudioMs: 20, endpointingMs: 100 }] })]))
  assert.equal(r.latency.metrics.responseMs.samples, 0)
  assert.equal(r.latency.metrics.responseMs.p95Ms, null)
})
test('failed and unreviewed cases remain visible in the success denominator', () => {
  const r = evaluateVoice(cohort([sample(), sample({ id: 'case-2', outcome: 'failure' }),
    sample({ id: 'case-3', outcome: 'unreviewed', containment: 'unreviewed', costUsd: null })]))
  assert.equal(r.successRateOfReviewed, 0.5)
  assert.equal(r.successRateOfAllCases, 1 / 3)
  assert.equal(r.assessment.observedTargetMet, false)
  assert.equal(r.containment.rateOfEligible, 1 / 3)
  assert.equal(r.cost.costPerSuccessfulCase, null)
})
test('successful handoff is a workflow success without inflated containment', () => {
  const r = evaluateVoice(cohort([sample(), sample({ id: 'case-2', workflow: 'handoff',
    eligibleForContainment: false, containment: 'handoff' })]))
  assert.equal(r.successRateOfAllCases, 1)
  assert.equal(r.containment.eligibleCases, 1)
  assert.equal(r.containment.successfulContainedCases, 1)
  assert.equal(r.cost.costPerSuccessfulCase, 0.2)
})
test('no data produces unknown rates and percentiles rather than a perfect score', () => {
  const r = evaluateVoice(cohort([]))
  assert.equal(r.successRateOfAllCases, null)
  assert.equal(r.containment.rateOfEligible, null)
  assert.equal(r.cost.totalKnownCost, null)
  assert.equal(r.assessment.observedTargetMet, false)
})
test('zero measurements remain valid and are distinguished from missing fields', () => {
  const r = evaluateVoice(cohort([sample({ costUsd: 0, turns: [{ responseMs: 0 }, { responseMs: null }, {}] })]))
  assert.equal(r.cost.totalKnownCost, 0)
  assert.equal(r.latency.metrics.responseMs.samples, 1)
  assert.equal(r.latency.metrics.responseMs.missing, 2)
  assert.equal(r.latency.metrics.responseMs.p95Ms, 0)
})
test('duplicates, ambiguous units and malformed numbers cannot silently improve reports', () => {
  assert.throws(() => evaluateVoice(cohort([sample(), sample()])))
  for (const unit of [undefined, 'seconds', 'ms']) assert.throws(() => evaluateVoice(cohort([], { timingUnit: unit })))
  for (const value of [-1, NaN, Infinity, '100', true, 3_600_001]) {
    assert.throws(() => evaluateVoice(cohort([sample({ turns: [{ responseMs: value }] })])))
  }
})
test('critical failures invalidate the observed target even when 95 percent succeed', () => {
  const cases = Array.from({ length: 20 }, (_, i) => sample({ id: `case-${i + 1}` }))
  cases[19] = sample({ id: 'case-20', outcome: 'failure', criticalFailures: ['false_confirmation'] })
  const r = evaluateVoice(cohort(cases))
  assert.equal(r.successRateOfAllCases, 0.95)
  assert.equal(r.criticalFailures.false_confirmation, 1)
  assert.equal(r.assessment.observedTargetMet, false)
})
test('contradictory and duplicate critical labels are rejected', () => {
  assert.throws(() => evaluateVoice(cohort([sample({ criticalFailures: ['false_confirmation'] })])))
  assert.throws(() => evaluateVoice(cohort([sample({ outcome: 'failure', criticalFailures: ['data_loss', 'data_loss'] })])))
})
test('passing synthetic or development data never establishes real held-out evidence', () => {
  assert.equal(evaluateVoice(cohort()).assessment.realHeldOutEvidence, false)
  const r = evaluateVoice(cohort(undefined, { evidence: 'real_call', split: 'held_out' }))
  assert.equal(r.assessment.realHeldOutEvidence, true)
  assert.equal(r.assessment.productionReadiness, 'not_established')
})
test('cost of failures is included in cost per success, absent costs prevent comparison', () => {
  const r = evaluateVoice(cohort([sample(), sample({ id: 'case-2', outcome: 'failure', costUsd: 0.8 })]))
  assert.equal(r.cost.costPerSuccessfulCase, 1)
  const missing = evaluateVoice(cohort([sample({ costUsd: null })]))
  assert.equal(missing.cost.costPerSuccessfulCase, null)
})
test('raw provider payloads, contact fields and unsupported metrics are rejected without echo', () => {
  for (const c of [sample({ transcript: 'PRIVATE_TEXT' }), sample({ id: 'private@example.test' }),
    sample({ turns: [{ responseMs: 3, privateValue: 'PRIVATE_TEXT' }] })]) {
    assert.throws(() => evaluateVoice(cohort([c])), error => error instanceof Error && !error.message.includes('PRIVATE'))
  }
})
test('report omits individual case identifiers and retains reproducible cohort fingerprints', () => {
  const r = evaluateVoice(cohort())
  assert.doesNotMatch(JSON.stringify(r), /case-1/)
  assert.equal(r.configurationSha256, 'a'.repeat(64))
})
test('oversized cohorts and impossible containment claims fail validation', () => {
  assert.throws(() => evaluateVoice(cohort(Array(10_001).fill(sample()))))
  assert.throws(() => evaluateVoice(cohort([sample({ turns: Array(1001).fill({}) })])))
  assert.throws(() => evaluateVoice(cohort([sample({ eligibleForContainment: false })])))
})


test('p95 is the nearest-rank tail observation rather than an average', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ responseMs: (20 - i) * 100 }))
  const r = evaluateVoice(cohort([sample({ turns })]))
  assert.equal(r.latency.metrics.responseMs.p50Ms, 1000)
  assert.equal(r.latency.metrics.responseMs.p95Ms, 1900)
  assert.equal(r.latency.metrics.responseMs.maxMs, 2000)
})
