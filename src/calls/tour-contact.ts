import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import { bookingReviewProjectionPending } from '../calendar/booking-review.ts'
import { findBooking } from '../calendar/reschedule.ts'
import { heldEmergency } from '../calendar/safety.ts'
import { CalendarActionError } from '../calendar/unit-blocks.ts'
import { validEmailAddress } from '../email/render.ts'
import { reviveStoredCall, type CallState } from './completion.ts'

const refuse = (): never => { throw new CalendarActionError('tour_contact_review',
  'The reservation could not be updated safely. Staff must review its contact details before sending a confirmation.') }

/** Original-call correction only. Calendar and call changes commit together; no provider IO.
 * Contact edits do not advance the scheduling revision or change caller identity.
 */
export async function correctVoiceTourContact(runtime: ResolvedPropertyRuntime, input: {
  callId: string; toolId: string; token: string; now: Date
  booking: NonNullable<CallState['booking']>
  previous: { name: string | null; email: string | null }
  next: { name: string | null; email: string | null }
}): Promise<void> {
  const { scope } = runtime, { booking, previous, next, callId } = input, actor = scope.actor
  if (actor.kind !== 'channel' || actor.provider !== 'vapi'
    || !next.name || next.name.length > 200 || /[\u0000-\u001f\u007f]/.test(next.name)
    || (next.email !== null && !validEmailAddress(next.email))
    || booking.status !== 'confirmed' || !booking.externalId || !Number.isFinite(input.now.getTime())) return refuse()
  await runtime.calendarStore.transaction(async unit => {
    // Same lock order as confirmation admission: calendar, then call document.
    await unit.calendar.mutate(state => {
      const saved = findBooking(state, booking.externalId)
      if (saved.interactionId !== callId || saved.startsAt !== booking.startsAt
        || saved.endsAt !== booking.endsAt || saved.unitId !== booking.unitId
        || !saved.startsAt || Date.parse(saved.startsAt) <= input.now.getTime()
        || !Number.isFinite(Date.parse(saved.startsAt))
        || saved.prospectName !== previous.name || saved.prospectEmail !== previous.email
        || heldEmergency(state, callId) || state.tourChangeHolds?.some(hold => hold.interactionId === callId)
        || bookingReviewProjectionPending(state, saved.externalId)
        || saved.rescheduleHistory?.some(change => change.projection === 'pending')) refuse()
      return { ...state, bookings: state.bookings.map(row => row === saved
        ? { ...row, prospectName: next.name ?? row.prospectName, prospectEmail: next.email } : row) }
    })
    await unit.documents.update<CallState | null>('call:' + callId, null, raw => {
      if (!raw) return refuse()
      const current = reviveStoredCall(raw), intent = current.work?.intents.find(row => row.id === input.toolId)
      const sameBatchBooking = current.booking?.status === 'arranging'
        && current.bookingAttempt?.externalId === booking.externalId
        && current.work?.intents.some(row => row.id === current.bookingAttempt?.toolId
          && row.name === 'book_tour' && row.token === input.token && row.status === 'dispatch_started')
      if (current.completedAt || !['open','ending'].includes(current.work?.phase ?? '') || current.bookingReviewWork
        || current.emergency || current.escalation?.trigger === 'emergency' || current.tourChangeRequested
        || current.routing?.organizationId !== scope.organizationId || current.routing.propertyId !== scope.propertyId
        || current.routing.channelBindingId !== actor.bindingId
        || intent?.name !== 'capture_contact' || intent.status !== 'admitted' || intent.token !== input.token
        || current.name !== previous.name || current.email !== previous.email
        || !current.booking || current.booking.externalId !== booking.externalId || current.booking.startsAt !== booking.startsAt
        || current.booking.endsAt !== booking.endsAt || current.booking.unitId !== booking.unitId
        || (current.booking.status !== 'confirmed' && !sameBatchBooking)) return refuse()
      return { ...current, name: next.name, email: next.email, booking: { ...booking } }
    })
  })
}
