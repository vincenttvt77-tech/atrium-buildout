import type { CalendarState, SlotBooking, BookingReschedule } from './types.ts'
import type { SlotOptions } from './slots.ts'
import { bookingSlot, canBook, generateSlots, openSlots } from './slots.ts'
import { effectiveOptions } from './settings.ts'
import { CalendarActionError, knownUnit, requestIdentity } from './unit-blocks.ts'
import { heldEmergency } from './safety.ts'
import { DEFAULT_TIME_ZONE, validateTimeZone } from './time.ts'

export const bookingRevision = (booking: SlotBooking): number => {
  const value = booking.revision ?? 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored booking revision is invalid.')
  return value
}

export function findBooking(state: CalendarState, externalId: unknown): SlotBooking {
  if (typeof externalId !== 'string' || !externalId || externalId.length > 1024) throw new CalendarActionError('invalid_booking', 'Choose a saved tour to reschedule.')
  const matches = state.bookings.filter(booking => booking.externalId === externalId)
  if (!matches.length) throw new CalendarActionError('booking_missing', 'This tour no longer exists. Reload the calendar.', 404)
  if (matches.length !== 1) throw new CalendarActionError('booking_identity_conflict', 'This reservation requires administrator review before rescheduling.', 409)
  return matches[0]!
}

function selectedUnit(value: unknown, booking: SlotBooking, options: SlotOptions): string | null {
  return knownUnit(value === undefined ? booking.unitId : value, options.unitIds ?? [], true)
}

export function previewReschedule(state: CalendarState, externalId: unknown, unitId: unknown,
  now: Date, range: { start: Date; end: Date }, defaults: SlotOptions) {
  const booking = findBooking(state, externalId)
  const options = effectiveOptions(state, defaults)
  const unit = selectedUnit(unitId, booking, options)
  const remaining = { ...state, bookings: state.bookings.filter(row => row.externalId !== booking.externalId) }
  return { booking: { ...booking, revision: bookingRevision(booking) }, unitId: unit,
    slots: openSlots(now, remaining, options, { from: range.start, to: range.end }, unit),
    notificationSent: false }
}

/** One calendar CAS replaces the existing reservation, preserving its external identity. */
export function rescheduleBooking(state: CalendarState, input: Record<string, unknown>, now: Date,
  defaults: SlotOptions, actorId: string): CalendarState {
  const requestId = requestIdentity(input.requestId)
  const booking = findBooking(state, input.externalId)
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new CalendarActionError('invalid_booking_revision', 'The saved booking revision is required.')
  if (typeof input.slotId !== 'string' || !/^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.slotId)) {
    throw new CalendarActionError('invalid_slot', 'Choose an available tour time from the calendar.')
  }
  const options = effectiveOptions(state, defaults)
  const history = booking.rescheduleHistory ?? []
  const replay = state.bookings.flatMap(row => (row.rescheduleHistory ?? []).map(change => ({ row, change })))
    .find(entry => entry.change.requestId === requestId)
  if (replay) {
    const requestedUnit = input.unitId === undefined ? replay.change.from.unitId
      : input.unitId === null ? null : typeof input.unitId === 'string' ? input.unitId.trim().toUpperCase() : undefined
    if (replay.row.externalId !== booking.externalId || replay.change.to.slotId !== input.slotId
      || replay.change.to.unitId !== requestedUnit || replay.change.revision !== Number(input.expectedRevision) + 1) {
      throw new CalendarActionError('reschedule_request_conflict', 'This requestId was already used for a different tour change.', 409)
    }
    return state
  }
  if (bookingRevision(booking) !== input.expectedRevision) throw new CalendarActionError('booking_revision_conflict', 'This tour changed in another session. Reload before rescheduling.', 409)
  if (history.some(change => change.projection === 'pending')) throw new CalendarActionError('reschedule_projection_pending', 'The prior tour change is still being reconciled. Retry that change before moving it again.', 409)
  if (history.length >= 1000) throw new CalendarActionError('reschedule_history_limit', 'This reservation requires administrator review before another change.', 409)
  if (booking.interactionId && heldEmergency(state, booking.interactionId)) throw new CalendarActionError('booking_safety_hold', 'This call has a safety hold. Staff must review it before changing its tour.', 409)
  const unitId = selectedUnit(input.unitId, booking, options)
  const startsAt = new Date(`${input.slotId.slice(5)}:00.000Z`)
  if (!Number.isFinite(startsAt.getTime()) || startsAt.toISOString().slice(0, 16) !== input.slotId.slice(5)) throw new CalendarActionError('invalid_slot', 'Choose a real tour time from the calendar.')
  const slot = generateSlots(now, { ...options, from: startsAt, to: new Date(startsAt.getTime() + 86400000), enforceBookingRules: true })
    .find(candidate => candidate.slotId === input.slotId)
  if (!slot) throw new CalendarActionError('reschedule_unavailable', 'That time is outside the current tour hours, notice or booking window. The original tour is unchanged.', 409)
  const previous = bookingSlot(booking)
  if (!previous) throw new CalendarActionError('booking_time_invalid', 'The original reservation times require administrator review.', 409)
  if (previous.startsAt.getTime() === slot.startsAt.getTime() && previous.endsAt.getTime() === slot.endsAt.getTime() && booking.unitId === unitId) {
    throw new CalendarActionError('reschedule_unchanged', 'Choose a different tour time or apartment.')
  }
  const remaining = { ...state, bookings: state.bookings.filter(row => row.externalId !== booking.externalId) }
  if (!canBook(slot, remaining, options, unitId)) throw new CalendarActionError('reschedule_unavailable', 'That apartment or time is no longer available. The original tour is unchanged.', 409)
  const revision = bookingRevision(booking) + 1
  const change: BookingReschedule = { requestId, revision, at: now.toISOString(), actorId,
    timeZone: validateTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE), projection: 'pending',
    from: { slotId: booking.slotId, startsAt: previous.startsAt.toISOString(), endsAt: previous.endsAt.toISOString(), unitId: booking.unitId },
    to: { slotId: slot.slotId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), unitId } }
  const buffer = (options.bufferMinutes ?? 0) * 60000
  const updated: SlotBooking = { ...booking, ...change.to, revision,
    occupiedStartsAt: new Date(slot.startsAt.getTime() - buffer).toISOString(),
    occupiedEndsAt: new Date(slot.endsAt.getTime() + buffer).toISOString(),
    rescheduleHistory: [...history, change] }
  return { ...state, bookings: state.bookings.map(row => row.externalId === booking.externalId ? updated : row) }
}

export function completeRescheduleProjection(state: CalendarState, externalId: string, requestId: string, revision: number): CalendarState {
  const booking = findBooking(state, externalId)
  const change = booking.rescheduleHistory?.find(row => row.requestId === requestId)
  if (!change || change.revision !== revision || bookingRevision(booking) !== revision) throw new CalendarActionError('reschedule_completion_conflict', 'The tour changed before reconciliation finished. Reload the calendar.', 409)
  return { ...state, bookings: state.bookings.map(row => row.externalId === externalId ? {
    ...row, rescheduleHistory: row.rescheduleHistory!.map(item => item.requestId === requestId ? { ...item, projection: 'complete' as const } : item),
  } : row) }
}
