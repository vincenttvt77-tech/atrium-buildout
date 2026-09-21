import type { BookingReviewAttempt, CalendarBookingReviewResolution, CalendarState, SlotBooking } from './types.ts'
import { CalendarActionError, requestIdentity } from './unit-blocks.ts'
import { canonicalJson } from '../workflows/validation.ts'
import { bookingRevision } from './reschedule.ts'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const fail = (code: string, message: string): never => { throw new CalendarActionError(code, message, 409) }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const exactInstant = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const normalizedUnit = (value: unknown): string | null | undefined => value === null ? null
  : typeof value === 'string' && value.trim().length > 0 && value.length <= 128 ? value.trim().toUpperCase() : undefined

/** No current settings or guessed duration can supply missing historic attempt evidence. */
export function validateBookingReviewAttempt(value: BookingReviewAttempt): BookingReviewAttempt {
  if (!object(value) || typeof value.externalId !== 'string'
    || !value.externalId.trim() || value.externalId.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.externalId)
    || typeof value.slotId !== 'string' || !/^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.slotId)
    || !exactInstant(value.startsAt) || !exactInstant(value.endsAt)
    || value.startsAt !== `${value.slotId.slice(5)}:00.000Z` || value.endsAt <= value.startsAt
    || normalizedUnit(value.unitId) === undefined) {
    return fail('booking_review_evidence_incomplete', 'This review lacks exact booking evidence. Check the saved calendar with an administrator; it has not been resolved.')
  }
  return { externalId: value.externalId, slotId: value.slotId, startsAt: value.startsAt,
    endsAt: value.endsAt, unitId: normalizedUnit(value.unitId)! }
}

const sameAttempt = (left: BookingReviewAttempt, right: BookingReviewAttempt): boolean => left.externalId === right.externalId
  && left.slotId === right.slotId && left.startsAt === right.startsAt && left.endsAt === right.endsAt
  && normalizedUnit(left.unitId) === normalizedUnit(right.unitId)

export function validateBookingReviewResolution(value: CalendarBookingReviewResolution): CalendarBookingReviewResolution {
  if (!object(value) || typeof value.callId !== 'string' || !ID.test(value.callId)
    || typeof value.actorId !== 'string' || !value.actorId.trim() || value.actorId.length > 256
    || /[\u0000-\u001f\u007f]/.test(value.actorId) || !integer(value.sourceRevision) || !exactInstant(value.checkedAt)
    || !['confirmed', 'not_booked'].includes(value.outcome) || !['pending', 'complete'].includes(value.projection)) {
    return fail('booking_review_receipt_invalid', 'Saved booking review evidence is invalid. An administrator must inspect it.')
  }
  requestIdentity(value.requestId)
  const attempt = validateBookingReviewAttempt(value.attempt)
  if (value.outcome === 'confirmed') {
    if (!value.booking || !integer(value.booking.revision) || !sameAttempt(validateBookingReviewAttempt(value.booking), attempt)) {
      return fail('booking_review_receipt_invalid', 'Saved booking review evidence is invalid. An administrator must inspect it.')
    }
  } else if (value.booking !== null) return fail('booking_review_receipt_invalid', 'Saved booking review evidence is invalid. An administrator must inspect it.')
  return { requestId: value.requestId, callId: value.callId, sourceRevision: value.sourceRevision,
    actorId: value.actorId, checkedAt: value.checkedAt, attempt, outcome: value.outcome, projection: value.projection,
    booking: value.booking ? { ...validateBookingReviewAttempt(value.booking), revision: value.booking.revision } : null }
}

function resolutions(state: CalendarState): CalendarBookingReviewResolution[] {
  if (state.bookingReviewResolutions !== undefined && !Array.isArray(state.bookingReviewResolutions)) {
    return fail('booking_review_receipt_invalid', 'Saved booking review evidence is invalid. An administrator must inspect it.')
  }
  const rows = (state.bookingReviewResolutions ?? []).map(validateBookingReviewResolution)
  const requests = new Set<string>(), calls = new Set<string>()
  for (const row of rows) {
    if (requests.has(row.requestId) || calls.has(row.callId)) return fail('booking_review_receipt_invalid', 'Conflicting booking review evidence requires administrator review.')
    requests.add(row.requestId); calls.add(row.callId)
  }
  return rows
}

export function findCalendarBookingReviewResolution(state: CalendarState, requestId: string): CalendarBookingReviewResolution | null {
  requestIdentity(requestId)
  return resolutions(state).find(row => row.requestId === requestId) ?? null
}

/** Read by call for recovery after a lost HTTP response without guessing its request id. */
export function calendarBookingReviewForCall(state: CalendarState, callId: string): CalendarBookingReviewResolution | null {
  return resolutions(state).find(row => row.callId === callId) ?? null
}

/** Checked inside the same CAS as create; it also rejects a late retry of a removed booking. */
export function bookingReviewBlocksCreate(state: CalendarState, callId: string, externalId: string): boolean {
  return resolutions(state).some(row => row.callId === callId || (row.projection === 'pending' && row.attempt.externalId === externalId))
}

function observedBooking(state: CalendarState, callId: string, attempt: BookingReviewAttempt): SlotBooking | null {
  const matchingKey = state.bookings.filter(row => row.externalId === attempt.externalId)
  const matchingCall = state.bookings.filter(row => row.interactionId === callId)
  if (matchingKey.length > 1 || matchingCall.length > 1
    || (matchingKey.length === 0 && matchingCall.length !== 0)) {
    return fail('booking_review_calendar_conflict', 'This call has conflicting reservations. Staff must inspect the current calendar before resolving it.')
  }
  const booking = matchingKey[0]
  if (!booking) return null
  if (booking.interactionId !== callId || !sameAttempt({ externalId: booking.externalId, slotId: booking.slotId,
    startsAt: booking.startsAt ?? '', endsAt: booking.endsAt ?? '', unitId: booking.unitId }, attempt)
    || bookingRevision(booking) !== 0 || (booking.rescheduleHistory !== undefined
      && (!Array.isArray(booking.rescheduleHistory) || booking.rescheduleHistory.length !== 0))) {
    return fail('booking_review_calendar_conflict', 'The saved reservation differs from this attempted tour. Staff must inspect the current calendar before resolving it.')
  }
  bookingRevision(booking)
  return booking
}

/** A historical confirmation is not a current confirmation after a move or removal. */
export function validateCalendarBookingReviewResolution(state: CalendarState, input: CalendarBookingReviewResolution): void {
  const resolution = validateBookingReviewResolution(input)
  const stored = resolutions(state).find(row => row.requestId === resolution.requestId)
  if (!stored || canonicalJson(stored) !== canonicalJson(resolution)) return fail('booking_review_receipt_missing', 'The calendar review receipt could not be verified. Retry the saved review.')
  const booking = observedBooking(state, resolution.callId, resolution.attempt)
  if ((resolution.outcome === 'confirmed' && (!booking || bookingRevision(booking) !== resolution.booking!.revision))
    || (resolution.outcome === 'not_booked' && booking !== null)) {
    return fail('booking_review_calendar_changed', 'The reservation changed after this review. Refresh and inspect the current calendar before proceeding.')
  }
}

export function reconcileCalendarBookingReview(state: CalendarState, input: Omit<CalendarBookingReviewResolution, 'outcome' | 'booking' | 'projection'>): CalendarState {
  const attempt = validateBookingReviewAttempt(input.attempt)
  const candidate: CalendarBookingReviewResolution = { ...input, attempt, outcome: 'not_booked', projection: 'pending', booking: null }
  validateBookingReviewResolution(candidate)
  const receipts = resolutions(state)
  const existing = receipts.find(row => row.requestId === input.requestId)
  if (existing) {
    if (existing.callId !== input.callId || existing.sourceRevision !== input.sourceRevision
      || existing.actorId !== input.actorId || !sameAttempt(existing.attempt, attempt)) {
      return fail('booking_review_request_conflict', 'This review request was already used for a different attempt. Refresh before continuing.')
    }
    // Completed receipts are checked-at history. A later authorized move or a
    // genuinely new call must not cause replay to overwrite current calendar data.
    if (existing.projection === 'pending') validateCalendarBookingReviewResolution(state, existing)
    return state
  }
  if (receipts.some(row => row.callId === input.callId)) return fail('booking_review_already_checked', 'This call has a saved review. Retry its saved request to finish reconciliation.')
  if (receipts.length >= 2000) return fail('booking_review_limit', 'Booking review history needs administrator attention before another review can be saved.')
  const booking = observedBooking(state, input.callId, attempt)
  const resolution: CalendarBookingReviewResolution = booking
    ? { ...candidate, outcome: 'confirmed', booking: { ...attempt, revision: bookingRevision(booking) } } : candidate
  return { ...state, bookingReviewResolutions: [...receipts, resolution] }
}

/** Staff cannot move the checked reservation while its cross-document repair is pending. */
export function bookingReviewProjectionPending(state: CalendarState, externalId: string): boolean {
  return resolutions(state).some(row => row.projection === 'pending' && row.attempt.externalId === externalId)
}

/** Called only after the call, lead, follow-up and review projections have been saved. */
export function completeCalendarBookingReviewResolution(state: CalendarState, requestId: string): CalendarState {
  const resolution = findCalendarBookingReviewResolution(state, requestId)
  if (!resolution) return fail('booking_review_receipt_missing', 'The calendar review receipt could not be verified. Retry the saved review.')
  if (resolution.projection === 'complete') return state
  validateCalendarBookingReviewResolution(state, resolution)
  return { ...state, bookingReviewResolutions: resolutions(state).map(row => row.requestId === requestId
    ? { ...row, projection: 'complete' as const } : row) }
}
