import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TIME_ZONE, localDate, localInstant, validateTimeZone, wallTime } from '../time.ts'
import { calendarRange, parseCalendarDate } from '../range.ts'
import { blockFor, generateSlots, slotDate, slotIdFor } from '../slots.ts'
import { defaultSettings, effectiveOptions } from '../settings.ts'
import { emptyCalendar } from '../types.ts'
import { storeBackedCalendar } from '../port.ts'
import { MemoryCalendarStore } from '../store.ts'
import type { BookingIntent, TourSlot } from '../../booking/types.ts'
import { interactionId, propertyId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const ZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles']
const tour = (start: string, end: string): TourSlot => ({
  slotId: slotIdFor(new Date(start)), startsAt: new Date(start), endsAt: new Date(end),
})

test('IANA timezone validation rejects invalid identities and keeps the legacy default explicit', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'America/New_York')
  assert.equal(validateTimeZone('America/New_York'), 'America/New_York')
  assert.equal(validateTimeZone('America/Chicago'), 'America/Chicago')
  assert.equal(validateTimeZone('UTC'), 'UTC')
  for (const value of [undefined, null, '', 'EST', '+05:30', 'America/Miami', 'Mars/Olympus', ' America/Chicago', {}]) {
    assert.throws(() => validateTimeZone(value), /valid IANA timezone/)
  }
  assert.throws(() => generateSlots(NOW, { timeZone: 'America/Miami' }), /valid IANA timezone/)
  assert.throws(() => calendarRange('2026-09-09', '2026-09-09', NOW, 'bad-zone'), /valid IANA timezone/)
  assert.throws(() => parseCalendarDate('2026-09-09', 'bad-zone'), /valid IANA timezone/)
})

test('NYC, Miami, Chicago and Los Angeles opening hours produce their own summer and winter instants', () => {
  for (const [city, timeZone, summerHour, winterHour] of [
    ['NYC', 'America/New_York', 14, 15],
    ['Miami', 'America/New_York', 14, 15],
    ['Chicago', 'America/Chicago', 15, 16],
    ['Los Angeles', 'America/Los_Angeles', 17, 18],
  ] as const) {
    for (const [date, expectedHour] of [['2026-09-09', summerHour], ['2027-01-13', winterHour]] as const) {
      const range = calendarRange(date, date, NOW, timeZone)
      const slots = generateSlots(NOW, { timeZone, from: range.start, to: range.end,
        minimumNoticeMinutes: 0, hours: { 3: { openHour: 10, closeHour: 11 } } })
      assert.equal(slots.length, 2, `${city} ${date}`)
      assert.equal(slots[0]!.startsAt.toISOString(), `${date}T${expectedHour}:00:00.000Z`, city)
      assert.equal(slotDate(slots[0]!.startsAt, timeZone), date)
      assert.equal(wallTime(slots[0]!.startsAt, timeZone).hour, 10)
    }
  }
  assert.equal(localInstant(2026, 9, 9, 10, 0, 'Asia/Kathmandu').toISOString(), '2026-09-09T04:15:00.000Z')
})

test('default dates and advance-booking days are based on the building day, not UTC or New York', () => {
  const instant = new Date('2026-09-09T04:30:00Z')
  assert.equal(calendarRange(undefined, undefined, instant).from, '2026-09-09')
  assert.equal(calendarRange(undefined, undefined, instant, 'America/Chicago').from, '2026-09-08')
  assert.equal(calendarRange(undefined, undefined, instant, 'America/Los_Angeles').from, '2026-09-08')
  for (const timeZone of ZONES) {
    const range = calendarRange('2026-09-08', '2026-09-11', instant, timeZone)
    const slots = generateSlots(instant, { timeZone, from: range.start, to: range.end, bookingWindowDays: 1, minimumNoticeMinutes: 0 })
    const lastDate = localDate(slots.at(-1)!.startsAt, timeZone)
    assert.equal(lastDate, timeZone === 'America/New_York' ? '2026-09-10' : '2026-09-09')
  }
})

test('minimum notice remains an elapsed-time rule while the earliest tour follows local office hours', () => {
  const instant = new Date('2026-09-09T14:30:00Z')
  for (const timeZone of ZONES) {
    const range = calendarRange('2026-09-09', '2026-09-09', instant, timeZone)
    const slots = generateSlots(instant, { timeZone, from: range.start, to: range.end,
      minimumNoticeMinutes: 120, hours: { 3: { openHour: 10, closeHour: 13 } } })
    assert.ok(slots.every(slot => slot.startsAt.getTime() >= instant.getTime() + 120 * 60000))
    assert.equal(slots[0]!.startsAt.toISOString(), timeZone === 'America/Los_Angeles'
      ? '2026-09-09T17:00:00.000Z' : '2026-09-09T16:30:00.000Z')
  }
})

test('each US building timezone skips missing spring starts and uses its actual 23-hour date', () => {
  for (const timeZone of ZONES) {
    const range = calendarRange('2026-03-08', '2026-03-08', NOW, timeZone)
    assert.equal(range.end.getTime() - range.start.getTime(), 23 * 3600000)
    const slots = generateSlots(NOW, { timeZone, from: range.start, to: range.end, enforceBookingRules: false,
      hours: { 0: { openHour: 0, closeHour: 4 } }, slotMinutes: 30, startIntervalMinutes: 30 })
    assert.equal(slots.length, 6, timeZone)
    assert.ok(slots.every(slot => wallTime(slot.startsAt, timeZone).hour !== 2))
    assert.equal(new Set(slots.map(slot => slot.slotId)).size, slots.length)
    const oneHour = generateSlots(NOW, { timeZone, from: range.start, to: range.end, enforceBookingRules: false,
      hours: { 0: { openHour: 0, closeHour: 3 } }, slotMinutes: 60, startIntervalMinutes: 30 })
    assert.equal(oneHour.length, 3)
    assert.ok(oneHour.every(slot => slot.endsAt <= localInstant(2026, 3, 8, 3, 0, timeZone)))
  }
})

test('fall repeated labels select one earlier instant per timezone and span the full 25-hour day', () => {
  for (const [timeZone, expected] of [
    ['America/New_York', '2026-11-01T05:30:00.000Z'],
    ['America/Chicago', '2026-11-01T06:30:00.000Z'],
    ['America/Los_Angeles', '2026-11-01T08:30:00.000Z'],
  ] as const) {
    const range = calendarRange('2026-11-01', '2026-11-01', NOW, timeZone)
    assert.equal(range.end.getTime() - range.start.getTime(), 25 * 3600000)
    assert.equal(localInstant(2026, 11, 1, 1, 30, timeZone).toISOString(), expected)
    const slots = generateSlots(NOW, { timeZone, from: range.start, to: range.end, enforceBookingRules: false,
      hours: { 0: { openHour: 0, closeHour: 3 } }, slotMinutes: 30 })
    assert.equal(slots.length, 6)
    assert.equal(new Set(slots.map(slot => slot.slotId)).size, 6)
  }
})

test('legacy all-day blocks follow the supplied building timezone including buffer overlap', () => {
  const block = { target: '2026-09-09', reason: 'Office closed', blockedAt: NOW.toISOString() }
  const state = { blocks: [block], bookings: [] }
  const atNyMidnight = tour('2026-09-09T04:00:00Z', '2026-09-09T04:30:00Z')
  assert.equal(blockFor(atNyMidnight, state), block)
  assert.equal(blockFor(atNyMidnight, state, { timeZone: 'America/Chicago' }), undefined)
  assert.equal(blockFor(atNyMidnight, state, { timeZone: 'America/Chicago', bufferMinutes: 45 }), block)
  const atChicagoMidnight = tour('2026-09-09T05:00:00Z', '2026-09-09T05:30:00Z')
  assert.equal(blockFor(atChicagoMidnight, state, { timeZone: 'America/Chicago' }), block)
})

test('IANA conversion handles midnight clock gaps and half-hour DST changes', () => {
  const midnightGap = calendarRange('2026-09-06', '2026-09-06', NOW, 'America/Santiago')
  assert.equal(midnightGap.start.toISOString(), '2026-09-06T04:00:00.000Z')
  assert.equal(wallTime(midnightGap.start, 'America/Santiago').hour, 1)
  assert.equal(midnightGap.end.getTime() - midnightGap.start.getTime(), 23 * 3600000)

  const timeZone = 'Australia/Lord_Howe'
  const spring = calendarRange('2026-10-04', '2026-10-04', NOW, timeZone)
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23.5 * 3600000)
  const slots = generateSlots(NOW, { timeZone, from: spring.start, to: spring.end,
    enforceBookingRules: false, hours: { 0: { openHour: 1, closeHour: 4 } },
    slotMinutes: 30, startIntervalMinutes: 30 })
  assert.deepEqual(slots.map(slot => {
    const wall = wallTime(slot.startsAt, timeZone)
    return [wall.hour, wall.minute]
  }), [[1, 0], [1, 30], [2, 30], [3, 0], [3, 30]])
  const fall = calendarRange('2026-04-05', '2026-04-05', NOW, timeZone)
  assert.equal(fall.end.getTime() - fall.start.getTime(), 24.5 * 3600000)
})

test('persisted all-day block instants survive later building timezone changes', () => {
  const range = calendarRange('2026-09-09', '2026-09-09', NOW, 'America/Chicago')
  const block = { target: '2026-09-09', reason: 'Office closed', blockedAt: NOW.toISOString(),
    startsAt: range.start.toISOString(), endsAt: range.end.toISOString() }
  const state = { blocks: [block], bookings: [] }
  const originalStart = tour('2026-09-09T05:00:00Z', '2026-09-09T05:30:00Z')
  const originalEnd = tour('2026-09-10T05:00:00Z', '2026-09-10T05:30:00Z')
  assert.equal(blockFor(originalStart, state, { timeZone: 'America/Los_Angeles' }), block)
  assert.equal(blockFor(originalEnd, state, { timeZone: 'America/Los_Angeles' }), undefined)
  assert.throws(() => blockFor(originalStart, { ...state, blocks: [{ ...block, endsAt: 'invalid' }] }, { timeZone: 'America/Chicago' }), /invalid times/)
})

test('showing settings cannot override the property timezone supplied by the server', () => {
  const settings = { ...defaultSettings(), timeZone: 'America/Chicago' }
  const resolved = effectiveOptions({ ...emptyCalendar(), settings }, { timeZone: 'America/Los_Angeles' })
  assert.equal(resolved.timeZone, 'America/Los_Angeles')
  assert.equal(effectiveOptions(emptyCalendar()).timeZone, DEFAULT_TIME_ZONE)
  assert.throws(() => effectiveOptions(emptyCalendar(), { timeZone: 'invalid' }), /valid IANA timezone/)
})

test('booking validates local business hours but persisted read-back keeps its original UTC interval', async () => {
  const store = new MemoryCalendarStore()
  const options = { timeZone: 'America/Chicago', hours: { 3: { openHour: 10, closeHour: 11 } }, minimumNoticeMinutes: 0, unitIds: ['12A'] }
  const calendar = storeBackedCalendar(store, () => NOW, options)
  const range = calendarRange('2026-09-09', '2026-09-09', NOW, options.timeZone)
  const slots = await calendar.listSlots(propertyId('building-chicago'), range.start, range.end, '12A')
  assert.equal(slots[0]!.startsAt.toISOString(), '2026-09-09T15:00:00.000Z')
  const intent = (slot: TourSlot, key: string): BookingIntent => ({
    intentId: key, idempotencyKey: key, createdAt: NOW, request: {
      propertyId: propertyId('building-chicago'), interactionId: interactionId('timezone-call'),
      personId: null, prospectName: 'Local test', prospectPhone: '+15555550100', prospectEmail: null,
      unitId: '12A', floorPlanId: null, slot,
    },
  })
  await assert.rejects(calendar.createBooking(intent(tour('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z'), 'wrong-city-time')), /already booked or blocked/)
  await calendar.createBooking(intent(slots[0]!, 'chicago-tour'))
  const afterZoneCorrection = storeBackedCalendar(store, () => new Date('2032-01-01T00:00:00Z'), { ...options, timeZone: 'America/New_York' })
  assert.deepEqual((await afterZoneCorrection.readBooking('chicago-tour'))?.slot, slots[0])
  assert.equal((await store.read()).bookings.length, 1)
})
