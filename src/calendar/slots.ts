import type { TourSlot } from '../booking/types.ts'
import type { CalendarState, SlotBooking, SlotBlock } from './types.ts'
import { DEFAULT_TIME_ZONE, localDate, localInstant, validateTimeZone, wallTime } from './time.ts'
import { activeUnitBlocks } from './unit-blocks.ts'

export interface BusinessHours {
  /** 0 = Sunday. Missing day means closed. */
  [dayOfWeek: number]: { openHour: number; closeHour: number } | undefined
}

/** Legacy default hours; evaluated in the supplied building timezone. */
export const DEFAULT_HOURS: BusinessHours = {
  0: { openHour: 11, closeHour: 16 },
  1: { openHour: 10, closeHour: 18 },
  2: { openHour: 10, closeHour: 18 },
  3: { openHour: 10, closeHour: 19 },
  4: { openHour: 10, closeHour: 19 },
  5: { openHour: 10, closeHour: 18 },
  6: { openHour: 10, closeHour: 17 },
}


/**
 * Minutes are part of the id. Truncating at the hour gave 2:00 and 2:30 the same id, so a
 * block on one silently blocked the other and a booking on one showed on both.
 */
export const slotIdFor = (startsAt: Date) => `slot-${startsAt.toISOString().slice(0, 16)}`

/** The ISO date a slot falls on in building time — what a day block matches against. */
export function slotDate(startsAt: Date, timeZone = DEFAULT_TIME_ZONE): string {
  return localDate(startsAt, timeZone)
}

export interface SlotOptions {
  /** Validated building timezone, independent of the host machine's timezone. */
  timeZone?: string
  days?: number
  slotMinutes?: number
  hours?: BusinessHours
  /** Tours cannot be booked closer than this — staff need warning. */
  minimumNoticeMinutes?: number
  /**
   * How many tours one time can hold. Two model residences and two agents means two
   * callers can tour at 2:00 as long as they are not being shown the same apartment;
   * a slot is "booked" only when it is full.
   */
  capacity?: number
  startIntervalMinutes?: number
  bufferMinutes?: number
  bookingWindowDays?: number | null
  sameUnitPolicy?: 'exclusive' | 'shared'
  unitIds?: string[]
  from?: Date
  to?: Date
  /** Staff can browse every date; only booking endpoints apply notice and booking horizon. */
  enforceBookingRules?: boolean
}

/** Every slot the calendar could offer, before blocks and bookings are applied. */
export function generateSlots(now: Date, opts: SlotOptions = {}): TourSlot[] {
  const timeZone = validateTimeZone(opts.timeZone ?? DEFAULT_TIME_ZONE)
  const days = opts.days ?? 14
  const minutes = opts.slotMinutes ?? 30
  const hours = opts.hours ?? DEFAULT_HOURS
  const notice = (opts.minimumNoticeMinutes ?? 120) * 60_000
  const interval = opts.startIntervalMinutes ?? minutes
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) throw new Error('slotMinutes must be a positive number of minutes')
  if (!Number.isInteger(interval) || interval <= 0 || interval > 1440) throw new Error('startIntervalMinutes must be positive')
  if (!Number.isFinite(notice) || notice < 0) throw new Error('minimumNoticeMinutes must be nonnegative')
  if (opts.capacity !== undefined && (!Number.isInteger(opts.capacity) || opts.capacity < 1)) throw new Error('capacity must be a positive integer')

  if (opts.bookingWindowDays != null && (!Number.isInteger(opts.bookingWindowDays) || opts.bookingWindowDays < 1 || opts.bookingWindowDays > 730)) throw new Error('bookingWindowDays must be null or a whole number from 1 to 730')
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid current date')
  if (!Number.isInteger(days) || days < 0 || days > 366) throw new Error('days must be between 0 and 366')
  const slots: TourSlot[] = []
  const from = opts.from ?? now
  const to = opts.to
  if (!Number.isFinite(from.getTime()) || (to && (!Number.isFinite(to.getTime()) || to < from))) throw new Error('Invalid calendar date range')
  if (to && to.getTime() - from.getTime() > 366 * 86400000) throw new Error('Calendar range must be at most 366 days')
  const start = wallTime(from, timeZone)
  const count = to ? Math.ceil((to.getTime() - from.getTime()) / 86400000) + 1 : days
  const horizon = opts.bookingWindowDays == null ? null : (() => {
    const w = wallTime(now, timeZone)
    return localInstant(w.year, w.month, w.day + opts.bookingWindowDays + 1, 0, 0, timeZone).getTime()
  })()
  for (let d = 0; d <= count; d++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + d))
    const window = hours[date.getUTCDay()]
    if (!window) continue
    if (![window.openHour, window.closeHour].every(value => Number.isFinite(value) && Math.abs(value * 60 - Math.round(value * 60)) < 0.000001) || window.openHour < 0 || window.closeHour > 24 || window.closeHour <= window.openHour) throw new Error('Invalid business hours')
    const closingMinute = Math.round(window.closeHour * 60)
    const closesAt = localInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(closingMinute / 60), closingMinute % 60, timeZone)
    for (let minute = Math.round(window.openHour * 60); minute + minutes <= Math.round(window.closeHour * 60); minute += interval) {
      const startsAt = localInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(minute / 60), minute % 60, timeZone)
      // A skipped wall time on the spring DST transition must not normalize into a duplicate.
      const actual = wallTime(startsAt, timeZone)
      if (actual.hour * 60 + actual.minute !== minute || actual.day !== date.getUTCDate()) continue
      const endsAt = new Date(startsAt.getTime() + minutes * 60_000)
      // An elapsed-hour tour can cross the spring clock jump. Its real end must
      // still fit the office's local closing time, rather than the nominal grid.
      if (endsAt > closesAt) continue
      if (opts.from && startsAt < from) continue
      if (to && startsAt >= to) continue
      if (opts.enforceBookingRules !== false && (startsAt.getTime() < now.getTime() + notice || (horizon !== null && startsAt.getTime() >= horizon))) continue
      slots.push({ slotId: slotIdFor(startsAt), startsAt, endsAt })
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

export type SlotStatus = 'open' | 'blocked' | 'booked'

/** Legacy records predate settings and were always thirty-minute tours. */
export function bookingSlot(booking: SlotBooking): TourSlot | null {
  const startsAt = new Date(booking.startsAt ?? `${booking.slotId.replace(/^slot-/, '')}:00.000Z`)
  const endsAt = new Date(booking.endsAt ?? startsAt.getTime() + 30 * 60000)
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) return null
  return { slotId: booking.slotId, startsAt, endsAt }
}

export function occupied(booking: SlotBooking): [number, number] | null {
  const slot = bookingSlot(booking)
  if (!slot) return null
  const start = booking.occupiedStartsAt ? Date.parse(booking.occupiedStartsAt) : slot.startsAt.getTime()
  const end = booking.occupiedEndsAt ? Date.parse(booking.occupiedEndsAt) : slot.endsAt.getTime()
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null
}

export const bookingsFor = (slot: TourSlot, state: CalendarState) => state.bookings.filter(b => {
  const booked = bookingSlot(b)
  return booked && booked.startsAt < slot.endsAt && booked.endsAt > slot.startsAt
})

const candidateInterval = (slot: TourSlot, opts: SlotOptions): [number, number] => {
  const buffer = opts.bufferMinutes ?? 0
  if (!Number.isFinite(buffer) || buffer < 0) throw new Error('Invalid tour buffer')
  return [slot.startsAt.getTime() - buffer * 60000, slot.endsAt.getTime() + buffer * 60000]
}

/** Peak occupancy, not number of tours encountered over a long interval. Endpoints are exclusive. */
export function occupancyPeak(slot: TourSlot, state: CalendarState, opts: SlotOptions = {}): number {
  const [start, end] = candidateInterval(slot, opts)
  const events: [number, number][] = []
  for (const booking of state.bookings) {
    const interval = occupied(booking)
    if (!interval) throw new Error('Stored booking has invalid times; availability cannot be verified')
    if (interval[0] < end && interval[1] > start) {
      events.push([Math.max(start, interval[0]), 1], [Math.min(end, interval[1]), -1])
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let active = 0, peak = 0
  for (const [, delta] of events) { active += delta; peak = Math.max(peak, active) }
  return peak
}

export function canBook(slot: TourSlot, state: CalendarState, opts: SlotOptions = {}, unitId?: string | null): boolean {
  const capacity = opts.capacity ?? 1
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer')
  if (blockFor(slot, state, opts) || occupancyPeak(slot, state, opts) >= capacity) return false
  const unit = unitId?.trim().toUpperCase()
  if (unit && opts.unitIds && !opts.unitIds.some(id => id.trim().toUpperCase() === unit)) return false
  if (unit && unitBlocksFor(slot, state, opts, unit).length) return false
  // General staff openings must not imply an apartment can be shown when every
  // known apartment is unavailable. Never infer inventory from block contents.
  if (!unit && activeUnitBlocks(state).length) {
    if (!opts.unitIds?.length || !opts.unitIds.some(id => canBook(slot, state, opts, id))) return false
  }
  if (unit && opts.sameUnitPolicy !== 'shared') {
    const [start, end] = candidateInterval(slot, opts)
    if (state.bookings.some(b => {
      const interval = occupied(b)
      return b.unitId?.trim().toUpperCase() === unit && interval && interval[0] < end && interval[1] > start
    })) return false
  }
  return true
}

export function unitBlocksFor(slot: TourSlot, state: CalendarState, opts: SlotOptions = {}, unitId?: string | null) {
  const unit = unitId?.trim().toUpperCase()
  const [start, end] = candidateInterval(slot, opts)
  return activeUnitBlocks(state).filter(block => {
    const from = Date.parse(block.startsAt), to = Date.parse(block.endsAt)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !block.unitId) {
      throw new Error('Stored apartment unavailability has invalid times or identity.')
    }
    return (!unit || block.unitId.toUpperCase() === unit) && from < end && to > start
  })
}

export function statusOf(slot: TourSlot, state: CalendarState, capacity = 1, opts: SlotOptions = {}): SlotStatus {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer')
  if (blockFor(slot, state, opts)) return 'blocked'
  return occupancyPeak(slot, state, opts) >= capacity ? 'booked' : 'open'
}

/**
 * The block that applies to a slot. A slot-level block outranks a whole-day block so the
 * dashboard shows the more specific reason, rather than whichever happened to be added
 * first.
 */
function blockInterval(block: SlotBlock, timeZone: string): [number, number] {
  // Newly saved all-day blocks can preserve their real boundaries even if the
  // property's configured timezone is later corrected. Legacy dates use its zone.
  if (!block.target.startsWith('slot-') && (block.startsAt !== undefined || block.endsAt !== undefined)) {
    const start = typeof block.startsAt === 'string' ? Date.parse(block.startsAt) : NaN
    const end = typeof block.endsAt === 'string' ? Date.parse(block.endsAt) : NaN
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Stored block has invalid times; availability cannot be verified')
    return [start, end]
  }
  if (block.target.startsWith('slot-')) {
    const start = Date.parse(block.startsAt ?? `${block.target.slice(5)}:00.000Z`)
    // Legacy blocks predate configurable durations and reserved thirty minutes.
    const end = block.endsAt === undefined ? start + 30 * 60000 : Date.parse(block.endsAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Stored block has invalid times; availability cannot be verified')
    return [start, end]
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(block.target)) throw new Error('Stored block has an invalid date; availability cannot be verified')
  const [year, month, day] = block.target.split('-').map(Number) as [number, number, number]
  const start = localInstant(year, month, day, 0, 0, timeZone)
  if (slotDate(start, timeZone).padStart(10, '0') !== block.target) throw new Error('Stored block has an invalid date; availability cannot be verified')
  // Local midnight boundaries make all-day reservations 23 or 25 real hours at DST.
  return [start.getTime(), localInstant(year, month, day + 1, 0, 0, timeZone).getTime()]
}

export function blockFor(slot: TourSlot, state: CalendarState, opts: SlotOptions = {}) {
  const timeZone = validateTimeZone(opts.timeZone ?? DEFAULT_TIME_ZONE)
  const [start, end] = candidateInterval(slot, opts)
  const overlapping = state.blocks.filter(block => {
    const interval = blockInterval(block, timeZone)
    return interval[0] < end && interval[1] > start
  })
  return overlapping.find(block => block.target === slot.slotId)
    ?? overlapping.find(block => !block.target.startsWith('slot-'))
    ?? overlapping[0]
}

/** Only these may be offered to a caller. */
export function openSlots(now: Date, state: CalendarState, opts: SlotOptions = {}, range?: { from: Date; to: Date }, unitId?: string | null): TourSlot[] {
  return generateSlots(now, { ...opts, ...(range ?? {}), enforceBookingRules: true }).filter(s => canBook(s, state, opts, unitId))
}
