/**
 * New York wall-clock arithmetic that survives the clocks changing.
 *
 * The first calendar hardcoded UTC-4. That is daylight time; from early November to mid
 * March New York is UTC-5, and every tour slot would have rendered an hour early all
 * winter — a building whose 10am tours appear at 9am on the dashboard and whose agent
 * offers times the office is not yet open for. Offsets are looked up per instant via Intl,
 * which carries the tz database, so no rule about when the clocks change lives in this
 * repository.
 */

const ZONE = 'America/New_York'

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
})

interface Wall {
  year: number; month: number; day: number
  hour: number; minute: number; second: number
  /** 0 = Sunday */
  dayOfWeek: number
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** The New York wall clock at a given instant. */
export function nyWall(at: Date): Wall {
  const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]))
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    dayOfWeek: DOW[p.weekday!] ?? 0,
  }
}

/** New York's UTC offset in minutes at a given instant (−240 in summer, −300 in winter). */
export function nyOffsetMinutes(at: Date): number {
  const w = nyWall(at)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return Math.round((asUtc - at.getTime()) / 60_000)
}

/**
 * The instant at a given New York wall-clock time. Resolves the offset at that date, not
 * today's, so a slot built in September for a day in December lands on the right hour.
 */
export function nyInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // First guess using a nearby offset, then correct once — enough for both sides of a
  // transition, since the offset only changes by an hour.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const off1 = nyOffsetMinutes(guess)
  const first = new Date(guess.getTime() - off1 * 60_000)
  const off2 = nyOffsetMinutes(first)
  return off2 === off1 ? first : new Date(guess.getTime() - off2 * 60_000)
}

/** YYYY-MM-DD of an instant in New York. */
export function nyDate(at: Date): string {
  const w = nyWall(at)
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`
}
