import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseMoveIn } from '../when.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

describe('move-in timing as people actually say it', () => {
  // Every one of these hung the call before the parser existed: Date.parse returned NaN,
  // nothing was captured, and the agent asked the same question until Vapi gave up.
  const cases: [string, string][] = [
    ['2 months', '2026-11-07'],
    ["I don't know, 2 months", '2026-11-07'],
    ['in about 2 months', '2026-11-07'],
    ['60 days', '2026-11-06'],
    ['a couple weeks', '2026-09-21'],
    ['next month', '2026-10-07'],
    ['asap', '2026-09-07'],
    ['October', '2026-10-01'],
    ['spring', '2027-03-01'],
    ['end of the year', '2026-12-01'],
    ['2026-11-01', '2026-11-01'],
  ]
  for (const [said, expected] of cases) {
    test(`"${said}" → ${expected}`, () => {
      const r = parseMoveIn(said, NOW)
      assert.ok(r, `"${said}" must parse — an unparsed answer hangs the call`)
      assert.equal(iso(r!.earliest), expected)
    })
  }
})

describe('windows, not points', () => {
  test('a range keeps both ends', () => {
    const r = parseMoveIn('2-3 months', NOW)!
    assert.equal(iso(r.earliest), '2026-11-07')
    assert.ok(r.latest, 'a range must keep its far end')
  })

  test('flexible is a real answer, just a wide one', () => {
    const r = parseMoveIn('flexible', NOW)!
    assert.equal(iso(r.earliest), '2026-09-07')
    assert.equal(iso(r.latest), '2027-03-07')
  })

  test('a bare month already past resolves to next year', () => {
    // March 2026 is behind us; a caller saying "March" means 2027.
    assert.equal(iso(parseMoveIn('March', NOW)!.earliest), '2027-03-01')
  })

  test('an explicit year is respected', () => {
    assert.equal(iso(parseMoveIn('March 2026', NOW)!.earliest), '2026-03-01')
  })

  test('the caller\'s own words are kept', () => {
    assert.equal(parseMoveIn("I don't know, 2 months", NOW)!.said, "I don't know, 2 months")
  })
})

describe('genuinely no timing returns null so the agent asks once more', () => {
  for (const s of ['no idea', '', '   ', 'hello']) {
    test(`${JSON.stringify(s)} → null`, () => {
      assert.equal(parseMoveIn(s, NOW), null)
    })
  }
})
