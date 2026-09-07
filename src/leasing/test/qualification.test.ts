import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { emptyQualification, mayQuote, nextSignalToAsk, captureCore } from '../qualification.ts'
import { extracted, corrected, reconcile } from '../captured.ts'
import { interactionId } from '../../domain/ids.ts'

const CALL = interactionId('int-call-1')
const LATER = interactionId('int-call-2')
const T0 = new Date('2026-09-07T10:00:00Z')
const T1 = new Date('2026-09-07T10:05:00Z')

const timing = (at = T0) => extracted(
  { earliest: new Date('2026-11-01'), latest: null }, 0.9, CALL, 'moving in November', at)
const budget = (max = 2400, at = T0) => extracted(
  { maxMonthly: max, stated: true }, 0.85, CALL, `up to about $${max}`, at)
const beds = (at = T0) => extracted({ min: 1, max: 1 }, 0.95, CALL, 'a one bedroom', at)

describe('quoting is gated on qualification', () => {
  test('refuses to quote with nothing captured', () => {
    const gate = mayQuote(emptyQualification())
    assert.equal(gate.allowed, false)
    assert.equal(gate.allowed === false && gate.needed, 2)
  })

  test('refuses to quote on one signal alone', () => {
    const s = captureCore(emptyQualification(), 'bedrooms', beds())
    const gate = mayQuote(s)
    assert.equal(gate.allowed, false)
    assert.deepEqual(gate.allowed === false && gate.missing, ['moveInTiming', 'budget'])
  })

  test('allows quoting on any two of the three', () => {
    let s = captureCore(emptyQualification(), 'bedrooms', beds())
    s = captureCore(s, 'budget', budget())
    assert.equal(mayQuote(s).allowed, true)

    let t = captureCore(emptyQualification(), 'moveInTiming', timing())
    t = captureCore(t, 'budget', budget())
    assert.equal(mayQuote(t).allowed, true)
  })

  test('a property can require all three', () => {
    let s = captureCore(emptyQualification(), 'bedrooms', beds())
    s = captureCore(s, 'budget', budget())
    assert.equal(mayQuote(s, 3).allowed, false)
  })
})

describe('the agent asks in a sensible order', () => {
  test('asks timing first, budget last', () => {
    let s = emptyQualification()
    assert.equal(nextSignalToAsk(s), 'moveInTiming')
    s = captureCore(s, 'moveInTiming', timing())
    assert.equal(nextSignalToAsk(s), 'bedrooms')
    s = captureCore(s, 'bedrooms', beds())
    assert.equal(nextSignalToAsk(s), 'budget')
    s = captureCore(s, 'budget', budget())
    assert.equal(nextSignalToAsk(s), null)
  })
})

describe('every captured field carries its evidence', () => {
  test('an extraction records the words that justified it', () => {
    const s = captureCore(emptyQualification(), 'budget', budget(2400))
    assert.equal(s.budget?.excerpt, 'up to about $2400')
    assert.equal(s.budget?.interactionId, CALL)
    assert.equal(s.budget?.provenance, 'ai_extracted')
  })
})

describe('human corrections outrank the model', () => {
  test('a correction beats a later, more confident extraction', () => {
    const human = corrected({ maxMonthly: 2000, stated: true }, LATER, 'manager: they said 2000', T0)
    const machine = extracted({ maxMonthly: 3000, stated: true }, 0.99, LATER, 'maybe three thousand', T1)
    const out = reconcile(human, machine)
    assert.equal(out.value.maxMonthly, 2000, 'the model must not overwrite a human')
    assert.equal(out.provenance, 'human_corrected')
  })

  test('a correction replaces an earlier extraction', () => {
    const machine = extracted({ maxMonthly: 3000, stated: true }, 0.99, CALL, 'three thousand', T0)
    const human = corrected({ maxMonthly: 2000, stated: true }, LATER, 'manager corrected', T1)
    assert.equal(reconcile(machine, human).value.maxMonthly, 2000)
  })

  test('between two extractions the later one wins — people revise mid-call', () => {
    const first = extracted({ maxMonthly: 3000, stated: true }, 0.9, CALL, 'about three', T0)
    const second = extracted({ maxMonthly: 2600, stated: true }, 0.8, CALL, 'actually 2600 tops', T1)
    assert.equal(reconcile(first, second).value.maxMonthly, 2600)
  })
})
