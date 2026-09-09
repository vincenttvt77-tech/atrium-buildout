import type { PropertyId, PersonId, InteractionId } from '../domain/ids.ts'

export interface TourSlot {
  /** Stable id from the calendar system. */
  slotId: string
  startsAt: Date
  endsAt: Date
  /** Which agent or office the slot belongs to, where the calendar exposes it. */
  host?: string
}

export interface BookingRequest {
  propertyId: PropertyId
  interactionId: InteractionId
  personId: PersonId | null
  prospectName: string
  prospectPhone: string
  prospectEmail: string | null
  slot: TourSlot
  /** The unit or plan the tour is for, when the prospect picked one. */
  unitId: string | null
  floorPlanId: string | null
  notes?: string
}

/**
 * Recorded before anything is written externally, per SOW 13.3 "Atrium record first".
 * If the external write fails or the process dies mid-flight, this is what makes the
 * booking recoverable instead of lost.
 */
export interface BookingIntent {
  intentId: string
  /** Derived from the prospect and slot so a retry cannot double-book. */
  idempotencyKey: string
  request: BookingRequest
  createdAt: Date
}

export type BookingState =
  /** Written and read back. Only now may the agent say "confirmed". */
  | { status: 'confirmed'; externalId: string; verifiedAt: Date; slot: TourSlot }
  /**
   * Written, but read-back has not yet succeeded. The agent must say it is being
   * arranged — never "confirmed" — per SOW 13.3 truthful resident messaging.
   */
  | { status: 'arranging'; externalId: string | null; attempts: number; lastError: string | null }
  /** The slot went while we were writing. The agent must offer alternatives. */
  | { status: 'slot_taken'; alternatives: TourSlot[] }
  /** Repeated failure. Queue for a human, tell the prospect a person will call. */
  | { status: 'failed'; attempts: number; lastError: string; queuedForHuman: true }

export interface Booking {
  intent: BookingIntent
  state: BookingState
  updatedAt: Date
}

/**
 * The calendar system. Implemented against Google Calendar, a PMS, or a JSON file for the
 * demo — the booking logic does not know or care which, which is what keeps the read-back
 * discipline intact when a real PMS replaces the demo source.
 */
export interface CalendarPort {
  listSlots(propertyId: PropertyId, from: Date, to: Date, unitId?: string | null): Promise<TourSlot[]>
  /** Same-key retries must match the original apartment and actual tour interval. */
  createBooking(intent: BookingIntent): Promise<{ externalId: string }>
  /** Reads the booking back from the system of record. Null means it is not there. */
  readBooking(externalId: string): Promise<{ externalId: string; slot: TourSlot; unitId?: string | null } | null>
}
