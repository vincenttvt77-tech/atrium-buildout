import { DEFAULT_TIME_ZONE, localDate, localInstant, validateTimeZone } from './time.ts'

export function parseCalendarDate(value: unknown, timeZone = DEFAULT_TIME_ZONE): Date {
  const zone = validateTimeZone(timeZone)
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use a valid YYYY-MM-DD date')
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  // Keep the public calendar in the supported four-digit tour-calendar year range.
  if (year < 1900 || year > 9998) throw new Error('Use a valid calendar year from 1900 to 9998')
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Use a valid calendar date')
  const result = localInstant(year, month, day, 0, 0, zone)
  if (localDate(result, zone) !== value) throw new Error('Use a valid calendar date')
  return result
}

export function addCalendarDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

/** Inclusive local dates at the API boundary, exclusive ending instant internally. */
export function calendarRange(from: unknown, to: unknown, now: Date, timeZone = DEFAULT_TIME_ZONE) {
  const zone = validateTimeZone(timeZone)
  const fromDate = from ?? localDate(now, zone)
  const start = parseCalendarDate(fromDate, zone)
  const toDate = to ?? addCalendarDays(String(fromDate), 14)
  const endDay = parseCalendarDate(toDate, zone)
  const span = Date.parse(`${toDate}T00:00Z`) - Date.parse(`${fromDate}T00:00Z`)
  if (span < 0 || span > 61 * 86400000) throw new Error('Calendar requests must span 1 to 62 days')
  const [year, month, day] = localDate(endDay, zone).split('-').map(Number) as [number, number, number]
  // The exclusive end can be January 1 of the following year even when the
  // final user-selectable date is December 31 at the upper year boundary.
  return { from: String(fromDate), to: String(toDate), start, end: localInstant(year, month, day + 1, 0, 0, zone) }
}
