/**
 * The tour calendar: what slots exist, which are blocked, and which are booked.
 *
 * Blocks are the point of this. Generated slots prove nothing — an agent that invents
 * times looks identical to one reading a real calendar until you take a time away and see
 * whether it still offers it.
 */

import type { TourSettings } from './settings.ts'
import type { EmergencyKind } from '../escalation/emergency.ts'

export interface SlotBlock {
  /** Slot id, or an ISO date (YYYY-MM-DD) to block the whole day. */
  target: string
  reason: string
  blockedAt: string
  startsAt?: string
  endsAt?: string
}

export interface SlotBooking {
  slotId: string
  externalId: string
  prospectName: string
  prospectEmail: string | null
  prospectPhone: string
  unitId: string | null
  bookedAt: string
  /** Original caller interaction, retained when staff moves this same reservation. */
  interactionId?: string
  revision?: number
  rescheduleHistory?: BookingReschedule[]
  /** Immutable tour and staff occupancy instants, independent of later setting changes. */
  startsAt?: string
  endsAt?: string
  occupiedStartsAt?: string
  occupiedEndsAt?: string
}

export interface BookingReschedule {
  requestId: string
  revision: number
  at: string
  actorId: string
  timeZone: string
  from: { slotId: string; startsAt: string; endsAt: string; unitId: string | null }
  to: { slotId: string; startsAt: string; endsAt: string; unitId: string | null }
  projection: 'pending' | 'complete'
}

export interface UnitBlock {
  id: string
  requestId: string
  unitId: string
  date: string
  endDate: string
  allDay: boolean
  startsAt: string
  endsAt: string
  reason: string
  blockedAt: string
  timeZone: string
  revision: number
  removedAt?: string
}

export interface CalendarState {
  blocks: SlotBlock[]
  bookings: SlotBooking[]
  /** Separate from staff/global blocks: one apartment never closes unrelated apartments. */
  unitBlocks?: UnitBlock[]
  settings?: TourSettings
  settingsRevision?: number
  /** Admission guard shares the booking CAS; it is not a notification or cancellation. */
  emergencyHolds?: Array<{ interactionId: string; kind: EmergencyKind; recordedAt: string }>
  /** Caller change request: prevents new voice bookings, never blocks a staff reschedule. */
  tourChangeHolds?: Array<{ interactionId: string; recordedAt: string }>
}

export const emptyCalendar = (): CalendarState => ({ blocks: [], bookings: [] })

/**
 * Read-modify-write against whatever backs the calendar.
 *
 * mutate() rather than read() plus write() because two people blocking slots in the same
 * second through separate lambda invocations would otherwise silently drop one of the
 * changes — the second write overwrites state it never saw.
 */
export interface CalendarStore {
  read(): Promise<CalendarState>
  mutate(fn: (state: CalendarState) => CalendarState): Promise<CalendarState>
  /** What this store actually is, so the dashboard can say when blocks will not persist. */
  describe(): { kind: 'memory' | 'kv' | 'postgres'; durable: boolean; note: string }
}
