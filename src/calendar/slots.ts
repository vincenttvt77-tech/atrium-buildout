import type { TourSlot } from '../booking/types.ts'
import type { CalendarState } from './types.ts'

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
/** New York is UTC-4 in EDT. Tours are shown in building time, so slots are built in it. */
const NY_OFFSET_HOURS = 4

export const slotIdFor = (startsAt: Date) => `slot-${startsAt.toISOString().slice(0, 13)}`

/** The ISO date a slot falls on in building time — what a day block matches against. */
export function slotDate(startsAt: Date): string {
  return new Date(startsAt.getTime() - NY_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10)
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
    const day = new Date(now.getTime() + d * DAY)
    const local = new Date(day.getTime() - NY_OFFSET_HOURS * 3_600_000)
    const window = hours[local.getUTCDay()]
    if (!window) continue

    for (let h = window.openHour; h < window.closeHour; h++) {
      for (let m = 0; m < 60; m += minutes) {
        const startsAt = new Date(Date.UTC(
          local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
          h + NY_OFFSET_HOURS, m, 0,
        ))
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
  const date = slotDate(slot.startsAt)
  if (state.blocks.some((b) => b.target === slot.slotId || b.target === date)) return 'blocked'
  return 'open'
}

/** Only these may be offered to a caller. */
export function openSlots(now: Date, state: CalendarState, opts?: SlotOptions): TourSlot[] {
  return generateSlots(now, opts).filter((s) => statusOf(s, state) === 'open')
}
