import rawProperty from '../../data/property.json' with { type: 'json' }
import { DEFAULT_HOURS, type BusinessHours, type SlotOptions } from './slots.ts'
import type { CalendarState } from './types.ts'
import { DEFAULT_TIME_ZONE, validateTimeZone } from './time.ts'

export interface TourSettings {
  capacity: number
  slotMinutes: number
  startIntervalMinutes: number
  bufferMinutes: number
  minimumNoticeMinutes: number
  /** Null means no advance booking limit. Calendar navigation is always independent. */
  bookingWindowDays: number | null
  hours: BusinessHours
  sameUnitPolicy: 'exclusive' | 'shared'
}

export function defaultSettings(): TourSettings {
  const capacity = Number(rawProperty.tourCapacityPerSlot)
  return {
    capacity: Number.isInteger(capacity) && capacity >= 1 && capacity <= 50 ? capacity : 1,
    slotMinutes: 30, startIntervalMinutes: 30, bufferMinutes: 0,
    minimumNoticeMinutes: 120, bookingWindowDays: null,
    hours: structuredClone(DEFAULT_HOURS), sameUnitPolicy: 'exclusive',
  }
}

export function validateSettings(value: unknown): TourSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be an object')
  const v = value as Record<string, unknown>
  const integer = (key: string, min: number, max: number) => {
    const n = v[key]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`)
    return n
  }
  const capacity = integer('capacity', 1, 50)
  const slotMinutes = integer('slotMinutes', 5, 240)
  const startIntervalMinutes = integer('startIntervalMinutes', 5, 120)
  const bufferMinutes = integer('bufferMinutes', 0, 120)
  const minimumNoticeMinutes = integer('minimumNoticeMinutes', 0, 10080)
  const bookingWindowDays = v.bookingWindowDays === null ? null : integer('bookingWindowDays', 1, 730)
  if (v.sameUnitPolicy !== 'exclusive' && v.sameUnitPolicy !== 'shared') throw new Error('sameUnitPolicy must be exclusive or shared')
  if (!v.hours || typeof v.hours !== 'object' || Array.isArray(v.hours)) throw new Error('hours must list days 0 through 6')
  const hours: BusinessHours = {}
  for (const [day, raw] of Object.entries(v.hours)) {
    if (!/^[0-6]$/.test(day) || !raw || typeof raw !== 'object') throw new Error('hours must list valid days 0 through 6')
    const { openHour, closeHour } = raw as { openHour: number; closeHour: number }
    if (![openHour, closeHour].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 24 && Math.abs(n * 60 - Math.round(n * 60)) < 0.000001) || closeHour <= openHour) throw new Error(`Invalid opening hours for day ${day}`)
    if ((closeHour - openHour) * 60 + 0.000001 < slotMinutes) throw new Error(`Opening hours for day ${day} must fit a complete tour`)
    hours[Number(day)] = { openHour, closeHour }
  }
  return { capacity, slotMinutes, startIntervalMinutes, bufferMinutes, minimumNoticeMinutes, bookingWindowDays, hours, sameUnitPolicy: v.sameUnitPolicy }
}

/** Resolve inside the same atomic mutation as booking so settings cannot race capacity. */
export function effectiveOptions(state: CalendarState, fallback: SlotOptions = {}): SlotOptions {
  return {
    ...defaultSettings(), ...fallback,
    // Before configurable settings, a custom tour duration also set its start grid.
    ...(fallback.slotMinutes !== undefined && fallback.startIntervalMinutes === undefined ? { startIntervalMinutes: fallback.slotMinutes } : {}),
    ...(state.settings ? validateSettings(state.settings) : {}),
    // Timezone is property identity, not a showing-rule override from a settings form.
    timeZone: validateTimeZone(fallback.timeZone ?? DEFAULT_TIME_ZONE),
  }
}
