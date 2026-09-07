import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { nyOffsetMinutes, nyInstant, nyWall, nyDate } from './ny.ts'
import { generateSlots } from '../calendar/slots.ts'

describe('New York time survives the clocks changing', () => {
  test('summer is UTC-4, winter is UTC-5', () => {
    assert.equal(nyOffsetMinutes(new Date('2026-09-07T12:00:00Z')), -240)
    assert.equal(nyOffsetMinutes(new Date('2026-12-07T12:00:00Z')), -300)
  })

  test('10am in December is 15:00Z, not 14:00Z', () => {
    // The hardcoded offset produced 14:00Z — a 9am tour on the dashboard all winter.
    assert.equal(nyInstant(2026, 12, 7, 10).toISOString(), '2026-12-07T15:00:00.000Z')
    assert.equal(nyInstant(2026, 9, 7, 10).toISOString(), '2026-09-07T14:00:00.000Z')
  })

  test('slots generated across the November transition stay at their wall-clock hour', () => {
    const before = new Date('2026-10-28T12:00:00Z')
    const slots = generateSlots(before, { days: 14 })
    const decemberish = slots.filter((s) => s.startsAt.toISOString() >= '2026-11-02')
    assert.ok(decemberish.length > 0)
    for (const s of decemberish) {
      const w = nyWall(s.startsAt)
      assert.ok(w.hour >= 10 && w.hour < 19, `slot at ${s.startsAt.toISOString()} is ${w.hour}:00 NY`)
      assert.equal(s.startsAt.getUTCMinutes() % 30, 0)
    }
  })

  test('the date a slot falls on is the New York date, even late in the evening', () => {
    // 11pm ET on the 7th is 03:00Z on the 8th; the slot belongs to the 7th.
    assert.equal(nyDate(new Date('2026-09-08T03:00:00Z')), '2026-09-07')
  })
})
