/** Building-local calendar arithmetic; instants remain UTC in every stored record. */
export const DEFAULT_TIME_ZONE = 'America/New_York'

export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday. */
  dayOfWeek: number
}

const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map<string, { zone: string; formatter: Intl.DateTimeFormat }>()

function zoneFormatter(value: unknown): { zone: string; formatter: Intl.DateTimeFormat } {
  // Offset strings and ambiguous abbreviations are not building timezone identities.
  if (typeof value !== 'string' || !value || value.length > 100 || value.trim() !== value
    || !/^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)) {
    throw new Error('timeZone must be a valid IANA timezone')
  }
  const cached = formatters.get(value)
  if (cached) return cached
  try {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone: value, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    })
    const result = { zone: formatter.resolvedOptions().timeZone, formatter }
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!)
    formatters.set(value, result)
    return result
  } catch {
    throw new Error('timeZone must be a valid IANA timezone')
  }
}

/** Reject invalid configuration instead of silently using the machine's local timezone. */
export function validateTimeZone(value: unknown): string {
  return zoneFormatter(value).zone
}

export function wallTime(at: Date, timeZone = DEFAULT_TIME_ZONE): WallTime {
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid calendar instant')
  const values = Object.fromEntries(zoneFormatter(timeZone).formatter.formatToParts(at).map(part => [part.type, part.value]))
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    dayOfWeek: DAYS[values.weekday!] ?? 0,
  }
}

const wallTimestamp = (wall: Pick<WallTime, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>): number =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)

/**
 * Resolve a local label using the zone's offsets near that date. Repeated labels choose
 * their earlier instant. Missing labels move forward by the clock gap; slot generation
 * checks the returned wall label and skips missing starts. Midnight boundaries can thus
 * use the first real instant of a date even in zones whose clocks jump at midnight.
 */
export function localInstant(
  year: number, month: number, day: number, hour: number, minute = 0, timeZone = DEFAULT_TIME_ZONE,
): Date {
  const zone = validateTimeZone(timeZone)
  if (![year, month, day, hour, minute].every(Number.isInteger) || year < 1900 || year > 9999) {
    throw new Error('Invalid local calendar time')
  }
  // Calendar arithmetic intentionally permits day overflow and hour 24.
  const target = Date.UTC(year, month - 1, day, hour, minute)
  if (!Number.isFinite(target)) throw new Error('Invalid local calendar time')
  const offsets = new Set<number>()
  for (const hours of [-48, -24, 0, 24, 48]) {
    const probe = target + hours * 3600000
    offsets.add(wallTimestamp(wallTime(new Date(probe), zone)) - probe)
  }
  const candidates = [...offsets].map(offset => {
    const instant = target - offset
    return { instant, observed: wallTimestamp(wallTime(new Date(instant), zone)) }
  })
  const exact = candidates.filter(candidate => candidate.observed === target)
    .sort((a, b) => a.instant - b.instant)
  if (exact[0]) return new Date(exact[0].instant)
  const afterGap = candidates.filter(candidate => candidate.observed > target)
    .sort((a, b) => a.observed - b.observed || a.instant - b.instant)
  if (afterGap[0]) return new Date(afterGap[0].instant)
  throw new Error('Local calendar time cannot be resolved')
}

export function localDate(at: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const wall = wallTime(at, timeZone)
  return `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`
}
