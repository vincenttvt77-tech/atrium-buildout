import type { CalendarState, TourCancellation } from './types.ts'
import { bookingSlot } from './slots.ts'

const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
export function checkedCancellation(value: TourCancellation): TourCancellation {
  if (!value || value.format !== 'tour-cancellation-v1' || !value.booking
    || !text(value.booking.externalId, 1024) || !bookingSlot(value.booking)
    || typeof value.booking.prospectPhone !== 'string' || value.booking.prospectPhone.length > 64
    || !text(value.requestId, 128) || !text(value.actorId, 128) || !text(value.reason, 500)
    || !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at
    || !Array.isArray(value.interactionIds) || !value.interactionIds.length || value.interactionIds.some(id => !text(id, 1024))
    || new Set(value.interactionIds).size !== value.interactionIds.length || value.notification !== 'not_sent') {
    throw new Error('Stored tour cancellation requires review')
  }
  return value
}
export function cancellations(state: CalendarState): TourCancellation[] {
  if (state.cancelledBookings !== undefined && !Array.isArray(state.cancelledBookings)) throw new Error('Stored tour cancellations require review')
  const rows = (state.cancelledBookings ?? []).map(checkedCancellation)
  if (new Set(rows.map(r => r.booking.externalId)).size !== rows.length) throw new Error('Duplicate tour cancellation requires review')
  return rows
}
export function cancelledTour(state: CalendarState, interactionId: string, externalId?: string | null): TourCancellation | null {
  return cancellations(state).find(row => row.interactionIds.includes(interactionId)
    || !!externalId && row.booking.externalId === externalId) ?? null
}
export const CANCELLED_TOUR_RESPONSE = 'Staff cancelled this tour. It is no longer reserved. Do not confirm the old booking or say a cancellation message was sent. Ask the leasing team to arrange any replacement tour.'
