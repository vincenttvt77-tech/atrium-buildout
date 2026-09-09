import type { CalendarPort, TourSlot, BookingIntent } from '../booking/types.ts'
import type { CalendarStore } from './types.ts'
import { openSlots, statusOf, generateSlots, bookingsFor } from './slots.ts'
import type { SlotOptions } from './slots.ts'

/**
 * The booking flow's calendar, backed by the store.
 *
 * createBooking is idempotent on the intent's key: the same prospect and slot resolves to
 * the same booking however many times a retry runs it, which is what stops a flaky network
 * putting two tours on the calendar.
 */
export function storeBackedCalendar(
  store: CalendarStore,
  now: () => Date,
  opts?: SlotOptions,
): CalendarPort {
  return {
    async listSlots() {
      return openSlots(now(), await store.read(), opts)
    },

    async createBooking(intent: BookingIntent) {
      const slot = intent.request.slot
      let sameUnit = false
      const result = await store.mutate((state) => {
        const existing = state.bookings.find((b) => b.externalId === intent.idempotencyKey)
        if (existing) return state

        sameUnit = false
        const available = generateSlots(now(), opts).find((s) => s.slotId === slot.slotId)
        if (!available || available.startsAt.getTime() !== slot.startsAt.getTime() || available.endsAt.getTime() !== slot.endsAt.getTime()) return state
        if (statusOf(slot, state, opts?.capacity ?? 1) !== 'open') return state
        // Two tours can share a time; one apartment cannot be shown to two parties at once.
        const unit = intent.request.unitId
        if (unit && bookingsFor(slot, state).some((b) => b.unitId && b.unitId.toUpperCase() === unit.toUpperCase())) {
          sameUnit = true
          return state
        }

        return {
          ...state,
          bookings: [...state.bookings, {
            slotId: slot.slotId,
            externalId: intent.idempotencyKey,
            prospectName: intent.request.prospectName,
            prospectEmail: intent.request.prospectEmail,
            prospectPhone: intent.request.prospectPhone,
            unitId: intent.request.unitId,
            bookedAt: now().toISOString(),
          }],
        }
      })

      const landed = result.bookings.find((b) => b.externalId === intent.idempotencyKey)
      if (!landed) {
        // The slot went between listing and booking. Say so rather than writing anyway —
        // the booking flow turns this into real alternatives for the caller.
        throw new Error(sameUnit
          ? `slot taken: apartment ${intent.request.unitId} is already being shown at that time`
          : 'slot already booked or blocked')
      }
      return { externalId: landed.externalId }
    },

    async readBooking(externalId: string) {
      const state = await store.read()
      const booking = state.bookings.find((b) => b.externalId === externalId)
      if (!booking) return null
      const slot = generateSlots(now(), opts).find((s) => s.slotId === booking.slotId)
      if (!slot) return null
      return { externalId, slot }
    },
  }
}
