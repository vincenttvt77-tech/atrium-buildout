import type { TourSlot } from '../booking/types.ts'
import type { CalendarState } from './types.ts'
import { nyWall, nyInstant, nyDate } from '../time/ny.ts'

export interface BusinessHours {
  /** 0 = Sunday. Missing day means closed. */
  [dayOfWeek: number]: { openHour: number; closeHour: number } | undefined
}

/** Parsed from the property's leasing hours; New York, because the building is. */
export const DEFAULT_HOURS: BusinessHours = {
  0: { openHour: 11, closeHour: 16 },
  1: { openHour: 10, closeHour: 18 },
  2: { openHour: 10, closeHour: 18 },
  3: { openHour: 10, closeHour: 19 },
  4: { openHour: 10, closeHour: 19 },
  5: { openHour: 10, closeHour: 18 },
  6: { openHour: 10, closeHour: 17 },
}

const DAY = 86_400_000

/**
 * Minutes are part of the id. Truncating at the hour gave 2:00 and 2:30 the same id, so a
 * block on one silently blocked the other and a booking on one showed on both.
 */
export const slotIdFor = (startsAt: Date) => `slot-${startsAt.toISOString().slice(0, 16)}`

/** The ISO date a slot falls on in building time — what a day block matches against. */
export function slotDate(startsAt: Date): string {
  return nyDate(startsAt)
}

export interface SlotOptions {
  days?: number
  slotMinutes?: number
  hours?: BusinessHours
  /** Tours cannot be booked closer than this — staff need warning. */
  minimumNoticeMinutes?: number
}

/** Every slot the calendar could offer, before blocks and bookings are applied. */
export function generateSlots(now: Date, opts: SlotOptions = {}): TourSlot[] {
  const days = opts.days ?? 14
  const minutes = opts.slotMinutes ?? 30
  const hours = opts.hours ?? DEFAULT_HOURS
  const notice = (opts.minimumNoticeMinutes ?? 120) * 60_000

  const slots: TourSlot[] = []
  for (let d = 0; d <= days; d++) {
    // Step by calendar day in New York, not by 24 UTC hours, so the transition day is
    // neither skipped nor doubled.
    const wall = nyWall(new Date(now.getTime() + d * DAY))
    const window = hours[wall.dayOfWeek]
    if (!window) continue

    for (let h = window.openHour; h < window.closeHour; h++) {
      for (let m = 0; m < 60; m += minutes) {
        const startsAt = nyInstant(wall.year, wall.month, wall.day, h, m)
        if (startsAt.getTime() < now.getTime() + notice) continue
        slots.push({
          slotId: slotIdFor(startsAt),
          startsAt,
          endsAt: new Date(startsAt.getTime() + minutes * 60_000),
        })
      }
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

export type SlotStatus = 'open' | 'blocked' | 'booked'

export function statusOf(slot: TourSlot, state: CalendarState): SlotStatus {
  if (state.bookings.some((b) => b.slotId === slot.slotId)) return 'booked'
  return blockFor(slot, state) ? 'blocked' : 'open'
}

/**
 * The block that applies to a slot. A slot-level block outranks a whole-day block so the
 * dashboard shows the more specific reason, rather than whichever happened to be added
 * first.
 */
export function blockFor(slot: TourSlot, state: CalendarState) {
  const date = slotDate(slot.startsAt)
  return state.blocks.find((b) => b.target === slot.slotId)
    ?? state.blocks.find((b) => b.target === date)
}

/** Only these may be offered to a caller. */
export function openSlots(now: Date, state: CalendarState, opts?: SlotOptions): TourSlot[] {
  return generateSlots(now, opts).filter((s) => statusOf(s, state) === 'open')
}
