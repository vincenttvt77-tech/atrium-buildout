import { createHash } from 'node:crypto'
import type { CalendarState, UnitBlock } from './types.ts'
import { addCalendarDays, parseCalendarDate } from './range.ts'
import { localDate, localInstant, validateTimeZone, wallTime } from './time.ts'

export class CalendarActionError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status }
}

export function requestIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value)) {
    throw new CalendarActionError('invalid_request_id', 'Use a unique requestId between 8 and 128 characters.')
  }
  return value
}

export function knownUnit(value: unknown, unitIds: string[], allowNull = false): string | null {
  if (allowNull && value === null) return null
  if (typeof value !== 'string' || value.length > 128) throw new CalendarActionError('invalid_unit', 'Choose an apartment from this property inventory.')
  const normalized = value.trim().toUpperCase()
  const found = unitIds.find(unit => unit.trim().toUpperCase() === normalized)
  if (!found) throw new CalendarActionError('invalid_unit', 'Choose an apartment from this property inventory.')
  return found.trim().toUpperCase()
}

function timedInstant(date: string, time: unknown, timeZone: string): Date {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new CalendarActionError('invalid_block_time', 'Use a valid local time in HH:mm format.')
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const result = localInstant(year, month, day, hour, minute, timeZone)
  const actual = wallTime(result, timeZone)
  if (localDate(result, timeZone) !== date || actual.hour !== hour || actual.minute !== minute) {
    throw new CalendarActionError('invalid_block_time', 'That local time does not exist because the clocks change. Choose another time.')
  }
  // Do not guess which occurrence the operator meant during a repeated clock hour.
  for (const offset of [-120, -90, -60, -30, 30, 60, 90, 120]) {
    const other = new Date(result.getTime() + offset * 60000)
    const wall = wallTime(other, timeZone)
    if (localDate(other, timeZone) === date && wall.hour === hour && wall.minute === minute) {
      throw new CalendarActionError('ambiguous_block_time', 'That local time occurs twice because the clocks change. Use a time outside the repeated hour.')
    }
  }
  return result
}

/** Resolve once in the authoritative building zone; retained intervals never move later. */
export function prepareUnitBlock(input: Record<string, unknown>, unitIds: string[], zone: string, now: Date): UnitBlock {
  const timeZone = validateTimeZone(zone)
  const requestId = requestIdentity(input.requestId)
  const unitId = knownUnit(input.unitId, unitIds)!
  if (typeof input.allDay !== 'boolean') throw new CalendarActionError('invalid_block_mode', 'Choose all-day or timed unavailability.')
  let date: string, endDate: string
  try {
    parseCalendarDate(input.date, timeZone)
    parseCalendarDate(input.endDate ?? input.date, timeZone)
    date = String(input.date); endDate = String(input.endDate ?? input.date)
  } catch { throw new CalendarActionError('invalid_block_date', 'Use real dates in YYYY-MM-DD format.') }
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000
  if (days < 0 || days > 365) throw new CalendarActionError('invalid_block_range', 'Apartment unavailability must span no more than 366 days, with the end on or after the start.')
  const startsAt = input.allDay ? parseCalendarDate(date, timeZone) : timedInstant(date, input.startTime, timeZone)
  const endsAt = input.allDay ? parseCalendarDate(addCalendarDays(endDate, 1), timeZone) : timedInstant(endDate, input.endTime, timeZone)
  if (endsAt <= startsAt) throw new CalendarActionError('invalid_block_range', 'The end must be after the start.')
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.reason)) {
    throw new CalendarActionError('invalid_block_reason', 'Add a short reason, up to 200 characters.')
  }
  return { id: `unit-block-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`, requestId,
    unitId, date, endDate, allDay: input.allDay, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    reason: input.reason.trim(), blockedAt: now.toISOString(), timeZone, revision: 0 }
}

const identity = (block: UnitBlock) => JSON.stringify([block.unitId, block.date, block.endDate, block.allDay, block.startsAt, block.endsAt, block.reason, block.timeZone])

export function activeUnitBlocks(state: CalendarState): UnitBlock[] {
  if (state.unitBlocks !== undefined && !Array.isArray(state.unitBlocks)) throw new Error('Stored apartment unavailability is invalid.')
  return (state.unitBlocks ?? []).filter(block => !block.removedAt)
}

export function addUnitBlock(state: CalendarState, block: UnitBlock): CalendarState {
  const blocks = state.unitBlocks ?? []
  const existing = blocks.find(row => row.requestId === block.requestId)
  if (existing) {
    if (identity(existing) !== identity(block)) throw new CalendarActionError('unit_block_conflict', 'This request was already used for different apartment unavailability.', 409)
    return state // A delayed retry cannot recreate a block an operator already removed.
  }
  if (blocks.length >= 2000) throw new CalendarActionError('unit_block_limit', 'Apartment unavailability history requires administrator review before adding more entries.', 409)
  return { ...state, unitBlocks: [...blocks, block] }
}

export function removeUnitBlock(state: CalendarState, blockId: unknown, revision: unknown, now: Date): CalendarState {
  if (typeof blockId !== 'string' || !/^unit-block-[a-f0-9]{32}$/.test(blockId) || !Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new CalendarActionError('invalid_unit_block', 'A saved blockId and revision are required.')
  }
  const block = (state.unitBlocks ?? []).find(row => row.id === blockId)
  if (!block) throw new CalendarActionError('unit_block_missing', 'This apartment block no longer exists.', 404)
  if (block.removedAt && block.revision === Number(revision) + 1) return state
  if (block.revision !== revision) throw new CalendarActionError('unit_block_conflict', 'Apartment unavailability changed. Reload before editing.', 409)
  return { ...state, unitBlocks: state.unitBlocks!.map(row => row.id === blockId
    ? { ...row, removedAt: now.toISOString(), revision: row.revision + 1 } : row) }
}
