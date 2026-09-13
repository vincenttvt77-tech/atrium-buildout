import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockFor, canBook, generateSlots, occupancyPeak, slotIdFor } from '../slots.ts'
import { defaultSettings, effectiveOptions, validateSettings } from '../settings.ts'
import { addCalendarDays, calendarRange, parseCalendarDate } from '../range.ts'
import { emptyCalendar } from '../types.ts'
import type { CalendarState, SlotBooking } from '../types.ts'
import type { TourSlot } from '../../booking/types.ts'
import { nyDate, nyWall } from '../../time/ny.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
function slot(start: string, end: string): TourSlot {
  const startsAt = new Date(start), endsAt = new Date(end)
  return { slotId: slotIdFor(startsAt), startsAt, endsAt }
}
function booked(tour: TourSlot, key: string): SlotBooking {
  return { slotId: tour.slotId, startsAt: tour.startsAt.toISOString(), endsAt: tour.endsAt.toISOString(),
    prospectName: 'Calendar test', prospectEmail: null, prospectPhone: '+15555550100', unitId: key,
    externalId: key, bookedAt: NOW.toISOString() }
}

test('capacity counts the peak concurrent tours instead of summing consecutive tours', () => {
  const candidate = slot('2026-09-08T14:00:00Z', '2026-09-08T15:00:00Z')
  const state: CalendarState = { blocks: [], bookings: [
    booked(slot('2026-09-08T14:00:00Z', '2026-09-08T14:30:00Z'), '12A'),
    booked(slot('2026-09-08T14:30:00Z', '2026-09-08T15:00:00Z'), '12B'),
  ] }
  assert.equal(occupancyPeak(candidate, state), 1)
  assert.equal(canBook(candidate, state, { capacity: 2 }, '12C'), true)
  state.bookings.push(booked(slot('2026-09-08T14:29:00Z', '2026-09-08T14:31:00Z'), '12D'))
  assert.equal(occupancyPeak(candidate, state), 2)
  assert.equal(canBook(candidate, state, { capacity: 2 }, '12C'), false)
})

test('staff occupancy and buffers use exclusive end boundaries', () => {
  const tour = booked(slot('2026-09-08T14:00:00Z', '2026-09-08T14:30:00Z'), '12A')
  tour.occupiedStartsAt = '2026-09-08T13:50:00Z'
  tour.occupiedEndsAt = '2026-09-08T14:40:00Z'
  const state = { blocks: [], bookings: [tour] }
  const next = slot('2026-09-08T14:40:00Z', '2026-09-08T15:10:00Z')
  assert.equal(canBook(next, state, { capacity: 1 }), true)
  assert.equal(canBook(next, state, { capacity: 1, bufferMinutes: 1 }), false)
  const before = slot('2026-09-08T13:20:00Z', '2026-09-08T13:50:00Z')
  assert.equal(canBook(before, state, { capacity: 1 }), true)
  assert.equal(canBook(before, state, { capacity: 1, bufferMinutes: 1 }), false)
})

test('slot blocks preserve their reserved duration independently of new tour settings', () => {
  const block = { target: 'slot-2026-09-08T14:00', reason: 'Unit maintenance', blockedAt: NOW.toISOString(),
    startsAt: '2026-09-08T14:00:00Z', endsAt: '2026-09-08T15:30:00Z' }
  const state = { blocks: [block], bookings: [] }
  assert.equal(blockFor(slot('2026-09-08T15:00:00Z', '2026-09-08T15:05:00Z'), state, { slotMinutes: 5 }), block)
  assert.equal(blockFor(slot('2026-09-08T15:30:00Z', '2026-09-08T16:30:00Z'), state, { slotMinutes: 60 }), undefined)
  assert.equal(blockFor(slot('2026-09-08T15:30:00Z', '2026-09-08T16:30:00Z'), state, { bufferMinutes: 1 }), block)
  const legacy = { blocks: [{ target: block.target, reason: block.reason, blockedAt: block.blockedAt }], bookings: [] }
  assert.equal(blockFor(slot('2026-09-08T14:30:00Z', '2026-09-08T15:30:00Z'), legacy, { slotMinutes: 60 }), undefined)
})

test('whole-day blocks include buffers extending into the reserved day from either side', () => {
  const block = { target: '2026-09-09', reason: 'Closed', blockedAt: NOW.toISOString() }
  const state = { blocks: [block], bookings: [] }
  const before = slot('2026-09-09T03:30:00Z', '2026-09-09T04:00:00Z')
  const after = slot('2026-09-10T04:00:00Z', '2026-09-10T04:30:00Z')
  assert.equal(blockFor(before, state), undefined)
  assert.equal(blockFor(after, state), undefined)
  assert.equal(blockFor(before, state, { bufferMinutes: 1 }), block)
  assert.equal(blockFor(after, state, { bufferMinutes: 1 }), block)
})

test('whole-day blocking follows 23-hour spring and 25-hour fall dates', () => {
  for (const [date, first, last, next] of [
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T03:30:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T04:30:00Z', '2026-11-02T05:00:00Z'],
  ]) {
    const block = { target: date!, reason: 'Closed', blockedAt: NOW.toISOString() }
    const state = { blocks: [block], bookings: [] }
    assert.equal(blockFor(slot(first!, new Date(Date.parse(first!) + 1800000).toISOString()), state), block)
    assert.equal(blockFor(slot(last!, next!), state), block)
    assert.equal(blockFor(slot(next!, new Date(Date.parse(next!) + 1800000).toISOString()), state), undefined)
  }
})

test('corrupt persisted block intervals fail closed rather than silently becoming availability', () => {
  const candidate = slot('2026-09-08T14:00:00Z', '2026-09-08T14:30:00Z')
  for (const block of [
    { target: 'slot-2026-09-08T14:00', endsAt: 'not-a-date' },
    { target: 'slot-2026-09-08T14:00', startsAt: '2026-09-08T15:00:00Z', endsAt: '2026-09-08T14:00:00Z' },
    { target: '2026-02-30' },
  ]) assert.throws(() => canBook(candidate, { blocks: [{ ...block, reason: '', blockedAt: '' }], bookings: [] }), /Stored block/)
})

test('spring DST skips nonexistent starts and does not let a real tour end after closing', () => {
  const range = calendarRange('2026-03-08', '2026-03-08', NOW)
  const halfHours = generateSlots(NOW, { from: range.start, to: range.end, enforceBookingRules: false,
    slotMinutes: 30, startIntervalMinutes: 30, hours: { 0: { openHour: 0, closeHour: 4 } } })
  assert.equal(halfHours.length, 6)
  assert.ok(halfHours.every(tour => nyWall(tour.startsAt).hour !== 2))
  assert.equal(new Set(halfHours.map(tour => tour.slotId)).size, halfHours.length)
  const hours = generateSlots(NOW, { from: range.start, to: range.end, enforceBookingRules: false,
    slotMinutes: 60, startIntervalMinutes: 30, hours: { 0: { openHour: 0, closeHour: 3 } } })
  assert.equal(hours.length, 3)
  assert.ok(hours.every(tour => tour.endsAt <= new Date('2026-03-08T07:00:00Z')))
})

test('fall DST produces one distinct selectable start per local clock label', () => {
  const range = calendarRange('2026-11-01', '2026-11-01', NOW)
  const tours = generateSlots(NOW, { from: range.start, to: range.end, enforceBookingRules: false,
    slotMinutes: 30, startIntervalMinutes: 30, hours: { 0: { openHour: 0, closeHour: 3 } } })
  assert.equal(tours.length, 6)
  assert.equal(new Set(tours.map(tour => tour.slotId)).size, tours.length)
  assert.equal(new Set(tours.map(tour => { const local = nyWall(tour.startsAt); return `${local.hour}:${local.minute}` })).size, tours.length)
  assert.ok(tours.every(tour => tour.endsAt.getTime() - tour.startsAt.getTime() === 30 * 60000))
})

test('calendar date ranges retain local midnight through leap days, DST and year transitions', () => {
  assert.equal(addCalendarDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01')
  const spring = calendarRange('2026-03-08', '2026-03-08', NOW)
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 3600000)
  const fall = calendarRange('2026-11-01', '2026-11-01', NOW)
  assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * 3600000)
  const newYear = calendarRange('2026-12-31', '2027-01-01', NOW)
  assert.equal(newYear.end.toISOString(), '2027-01-02T05:00:00.000Z')
  assert.equal(nyDate(parseCalendarDate('1900-01-01')), '1900-01-01')
  assert.equal(calendarRange('9998-12-31', '9998-12-31', NOW).end.toISOString(), '9999-01-01T05:00:00.000Z')
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-01T00:00Z', '0099-01-01', '0100-01-01', '1899-12-31']) {
    assert.throws(() => parseCalendarDate(date), /valid/)
  }
  assert.doesNotThrow(() => calendarRange('2026-10-01', addCalendarDays('2026-10-01', 61), NOW))
  assert.throws(() => calendarRange('2026-10-01', addCalendarDays('2026-10-01', 62), NOW), /1 to 62 days/)
  assert.throws(() => calendarRange('2026-10-02', '2026-10-01', NOW), /1 to 62 days/)
})

test('booking horizon limits bookings but leaves staff date navigation unrestricted', () => {
  const range = calendarRange('2026-09-07', '2026-09-10', NOW)
  const opts = { from: range.start, to: range.end, minimumNoticeMinutes: 0, bookingWindowDays: 1 }
  const allowed = generateSlots(NOW, opts)
  assert.deepEqual([...new Set(allowed.map(tour => nyDate(tour.startsAt)))], ['2026-09-07', '2026-09-08'])
  const visible = generateSlots(NOW, { ...opts, enforceBookingRules: false })
  assert.ok(visible.some(tour => nyDate(tour.startsAt) === '2026-09-10'))
  for (const days of [-1, 0, 0.5, NaN, Infinity, 731]) assert.throws(() => generateSlots(NOW, { bookingWindowDays: days }), /bookingWindowDays/)
})

test('policy validation rejects incomplete, impossible or untyped rules', () => {
  const defaults = defaultSettings()
  assert.deepEqual(validateSettings(defaults), defaults)
  assert.deepEqual(validateSettings({ ...defaults, hours: {} }).hours, {})
  const invalid: Record<string, unknown>[] = [
    { capacity: 0 }, { capacity: 1.5 }, { capacity: '2' }, { capacity: Infinity },
    { slotMinutes: 0 }, { slotMinutes: 241 }, { startIntervalMinutes: 0 },
    { bufferMinutes: -1 }, { minimumNoticeMinutes: -1 }, { bookingWindowDays: 0 },
    { bookingWindowDays: undefined }, { sameUnitPolicy: 'unknown' },
    { hours: { 7: { openHour: 9, closeHour: 17 } } },
    { hours: { 1: { openHour: 9, closeHour: 9 } } },
    { hours: { 1: { openHour: 23, closeHour: 25 } } },
    { hours: { 1: { openHour: 9.001, closeHour: 17 } } },
    { hours: { 1: { openHour: 9, closeHour: 9.25 } } },
  ]
  for (const override of invalid) assert.throws(() => validateSettings({ ...defaults, ...override }))
  assert.throws(() => validateSettings(null))
  assert.throws(() => validateSettings([]))
})

test('explicit saved policy wins while generic duration options retain their previous start grid', () => {
  const legacy = effectiveOptions(emptyCalendar(), { slotMinutes: 45, capacity: 1 })
  assert.equal(legacy.startIntervalMinutes, 45)
  const state = { ...emptyCalendar(), settings: { ...defaultSettings(), slotMinutes: 60, startIntervalMinutes: 15 } }
  const configured = effectiveOptions(state, { slotMinutes: 45, unitIds: ['12A'] })
  assert.equal(configured.slotMinutes, 60)
  assert.equal(configured.startIntervalMinutes, 15)
  assert.deepEqual(configured.unitIds, ['12A'])
})
