import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSlots, slotDate } from '../slots.ts'
import { nyWall } from '../../time/ny.ts'
import { MemoryCalendarStore } from '../store.ts'
import { storeBackedCalendar } from '../port.ts'
import type { BookingIntent } from '../../booking/types.ts'

test('late-night spring transition does not skip the next calendar day', () => {
  const slots = generateSlots(new Date('2026-03-08T04:30:00Z'), { days: 2 })
  assert.deepEqual([...new Set(slots.map((s) => slotDate(s.startsAt)))], ['2026-03-08', '2026-03-09'])
})

test('early-morning fall transition does not repeat a calendar day', () => {
  const slots = generateSlots(new Date('2026-11-01T04:30:00Z'), { days: 2 })
  assert.deepEqual([...new Set(slots.map((s) => slotDate(s.startsAt)))], ['2026-11-01', '2026-11-02', '2026-11-03'])
  assert.equal(new Set(slots.map((s) => s.slotId)).size, slots.length)
})

test('45 minute tours do not overlap or run past closing time', () => {
  const slots = generateSlots(new Date('2026-09-07T10:00:00Z'), { days: 0, slotMinutes: 45, hours: { 1: { openHour: 10, closeHour: 12 } } })
  assert.equal(slots.length, 2)
  assert.ok(slots[0]!.endsAt <= slots[1]!.startsAt)
  assert.equal(nyWall(slots[1]!.endsAt).hour, 11)
  assert.equal(nyWall(slots[1]!.endsAt).minute, 30)
  assert.throws(() => generateSlots(new Date(), { slotMinutes: 0 }), /slotMinutes/)
})

test('a fabricated or expired slot cannot be written to the calendar', async () => {
  const now = new Date('2026-09-09T14:00:00Z')
  const store = new MemoryCalendarStore()
  const cal = storeBackedCalendar(store, () => now)
  const intent = { idempotencyKey: 'made-up', request: { slot: { slotId: 'slot-2026-09-08T04:00', startsAt: new Date('2026-09-08T04:00:00Z'), endsAt: new Date('2026-09-08T04:30:00Z') }, unitId: null } } as BookingIntent
  await assert.rejects(cal.createBooking(intent), /already booked or blocked/)
  assert.equal((await store.read()).bookings.length, 0)
})
