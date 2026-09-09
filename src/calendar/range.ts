import { nyDate, nyInstant } from '../time/ny.ts'

export function parseCalendarDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use a valid YYYY-MM-DD date')
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  // The wall-clock helper uses modern standard-time offsets. Historical local
  // mean-time dates are not supported tour-calendar years.
  if (year < 1900 || year > 9998) throw new Error('Use a valid calendar year from 1900 to 9998')
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Use a valid calendar date')
  const result = nyInstant(year, month, day, 0)
  if (nyDate(result) !== value) throw new Error('Use a valid calendar date')
  return result
}

export function addCalendarDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

/** Inclusive local dates at the API boundary, exclusive ending instant internally. */
export function calendarRange(from: unknown, to: unknown, now: Date) {
  const fromDate = from ?? nyDate(now)
  const start = parseCalendarDate(fromDate)
  const toDate = to ?? addCalendarDays(String(fromDate), 14)
  const endDay = parseCalendarDate(toDate)
  const span = Date.parse(`${toDate}T00:00Z`) - Date.parse(`${fromDate}T00:00Z`)
  if (span < 0 || span > 61 * 86400000) throw new Error('Calendar requests must span 1 to 62 days')
  const [year, month, day] = nyDate(endDay).split('-').map(Number) as [number, number, number]
  // The exclusive end can be January 1 of the following year even when the
  // final user-selectable date is December 31 at the upper year boundary.
  return { from: String(fromDate), to: String(toDate), start, end: nyInstant(year, month, day + 1, 0) }
}
