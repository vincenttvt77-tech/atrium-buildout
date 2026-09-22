import assert from 'node:assert/strict'
import test from 'node:test'
import { assertConsentFreshness } from '../consent-freshness.ts'
import { ConsentError } from '../consent-model.ts'

const now = Date.parse('2026-09-13T18:00:00.000Z')
const changed = (error: unknown) => error instanceof ConsentError && error.code === 'consent_changed'

test('current consent projections expire at the earliest consumed evidence boundary', () => {
  const deadlines = [new Date(now + 1000).toISOString(), new Date(now + 2000).toISOString(), null]
  assert.doesNotThrow(() => assertConsentFreshness(deadlines, now))
  assert.throws(() => assertConsentFreshness(deadlines, now + 1000), changed)
})

test('an authorization wait cannot preserve expired readiness or an expired ceremony', async () => {
  let clock = now
  const boundaries = [new Date(now + 1).toISOString(), now + 5]
  assertConsentFreshness(boundaries, clock)
  await Promise.resolve().then(() => { clock += 5 })
  assert.throws(() => assertConsentFreshness(boundaries, clock), changed)
  assert.throws(() => assertConsentFreshness([now + 5], clock), changed)
})

test('invalid current evidence deadlines fail closed', () => {
  for (const deadline of ['invalid', '', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => assertConsentFreshness([deadline], now), changed)
  }
  assert.throws(() => assertConsentFreshness([], Number.NaN), changed)
})

test('historical receipts and held states without a future boundary remain readable', () => {
  assert.doesNotThrow(() => assertConsentFreshness([], now + 365 * 86400000))
  assert.doesNotThrow(() => assertConsentFreshness([null], now))
})
