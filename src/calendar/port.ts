import type { CalendarPort, TourSlot, BookingIntent } from '../booking/types.ts'
import type { CalendarStore, SlotBooking } from './types.ts'
import { openSlots, generateSlots, bookingSlot, canBook } from './slots.ts'
import { effectiveOptions } from './settings.ts'
import type { SlotOptions } from './slots.ts'
import { heldEmergency, CalendarInteractionPausedError } from './safety.ts'

const normalizedUnit = (unit: string | null | undefined): string | null => unit?.trim().toUpperCase() || null
const sameSlot = (left: TourSlot | null, right: TourSlot): boolean => left !== null
  && left.slotId === right.slotId
  && left.startsAt.getTime() === right.startsAt.getTime()
  && left.endsAt.getTime() === right.endsAt.getTime()

function verifyRetry(booking: SlotBooking, intent: BookingIntent): void {
  if (!sameSlot(bookingSlot(booking), intent.request.slot)
    || normalizedUnit(booking.unitId) !== normalizedUnit(intent.request.unitId)) {
    throw new Error('booking conflict: this request key already belongs to a different apartment or tour time')
  }
}

/** Stored intervals are immutable; current showing rules govern only new bookings. */
export function storeBackedCalendar(
  store: CalendarStore,
  now: () => Date,
  opts?: SlotOptions,
): CalendarPort {
  return {
    async listSlots(_propertyId, from, to, unitId) {
      const state = await store.read()
      const options = effectiveOptions(state, { capacity: 1, ...opts })
      const unit = normalizedUnit(unitId)
      if (unit && options.unitIds && !options.unitIds.some((id) => normalizedUnit(id) === unit)) return []
      return openSlots(now(), state, options, { from, to }, unit)
    },

    async createBooking(intent: BookingIntent) {
      const slot = intent.request.slot
      const unit = normalizedUnit(intent.request.unitId)
      let reason = 'slot already booked or blocked'
      const result = await store.mutate((state) => {
        // Check even same-key retries: a pause that won this CAS must not admit
        // another leasing action from a request with stale conversation state.
        const pause = heldEmergency(state, String(intent.request.interactionId))
        if (pause) throw new CalendarInteractionPausedError(pause)
        // The callback can be replayed after a competing write. Resolve all mutable
        // policy and occupancy against that invocation's state, never a stale pre-read.
        reason = 'slot already booked or blocked'
        const existing = state.bookings.find((booking) => booking.externalId === intent.idempotencyKey)
        if (existing) {
          verifyRetry(existing, intent)
          return state
        }

        const options = effectiveOptions(state, { capacity: 1, ...opts })
        if (unit && options.unitIds && !options.unitIds.some((id) => normalizedUnit(id) === unit)) {
          throw new Error('booking unavailable: the selected apartment is not in this property inventory')
        }
        const at = now()
        const available = generateSlots(at, { ...options, from: slot.startsAt, to: slot.endsAt, enforceBookingRules: true })
          .find((candidate) => sameSlot(candidate, slot))
        if (!available) return state
        if (!canBook(slot, state, options, unit)) {
          if (unit && canBook(slot, state, options, null)) {
            reason = `slot taken: apartment ${unit} is already being shown at that time`
          }
          return state
        }

        const buffer = (options.bufferMinutes ?? 0) * 60_000
        return {
          ...state,
          bookings: [...state.bookings, {
            slotId: slot.slotId,
            externalId: intent.idempotencyKey,
            prospectName: intent.request.prospectName,
            prospectEmail: intent.request.prospectEmail,
            prospectPhone: intent.request.prospectPhone,
            unitId: unit,
            startsAt: slot.startsAt.toISOString(),
            endsAt: slot.endsAt.toISOString(),
            occupiedStartsAt: new Date(slot.startsAt.getTime() - buffer).toISOString(),
            occupiedEndsAt: new Date(slot.endsAt.getTime() + buffer).toISOString(),
            bookedAt: at.toISOString(),
          }],
        }
      })

      const landed = result.bookings.find((booking) => booking.externalId === intent.idempotencyKey)
      if (!landed) throw new Error(reason)
      verifyRetry(landed, intent)
      return { externalId: landed.externalId }
    },

    async readBooking(externalId: string) {
      const state = await store.read()
      const booking = state.bookings.find((candidate) => candidate.externalId === externalId)
      if (!booking) return null
      const slot = bookingSlot(booking)
      if (!slot) return null
      return { externalId, slot, unitId: normalizedUnit(booking.unitId) }
    },
  }
}
