import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { CalendarState, SlotBooking, TourCancellation } from './types.ts'
import type { LeadProfile } from '../leads/profile.ts'
import { assertAuthorizedScope } from '../auth/authorization.ts'
import { hashJson } from '../workflows/validation.ts'
import { bookingSlot } from './slots.ts'
import { findBooking } from './reschedule.ts'
import { bookingReviewProjectionPending } from './booking-review.ts'
import { CalendarActionError, requestIdentity } from './unit-blocks.ts'
import { cancellations, checkedCancellation } from './cancellation.ts'
import { cancellationProfileKey, retainCancellation, applySavedCancellations, matchesCancelledBooking } from '../leads/cancellation.ts'

const fail = (code: string, message: string, status = 409): never => { throw new CalendarActionError(code, message, status) }
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const commandKey = (id: string) => 'tour-cancellation-command:' + hashJson(id)
interface Receipt { format: 'tour-cancellation-command-v1'; manifestSha256: string; cancellation: TourCancellation;
  projection: { status: 'complete' | 'awaiting_call' | 'needs_review'; retired: number; review: number } }
const corrupt = (): never => fail('tour_cancellation_invalid', 'The cancellation history needs administrator review.')
export function parseTourCancellation(input: unknown) {
  const v = input as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || Object.keys(v).sort().join(',') !== 'action,expectedSha256,externalId,reason,requestId,verified'
    || v.action !== 'cancel' || !text(v.externalId, 1024) || !digest(v.expectedSha256)
    || !text(v.reason, 500) || v.reason.trim().length < 3 || v.verified !== true) {
    return fail('tour_cancellation_input_invalid', 'Review the reservation, confirm it is the right tour, and enter a cancellation reason.', 400)
  }
  return { action: 'cancel' as const, externalId: v.externalId, expectedSha256: v.expectedSha256,
    requestId: requestIdentity(v.requestId), reason: v.reason.trim(), verified: true as const }
}
function held(state: CalendarState, booking: SlotBooking, now: Date): string | null {
  const slot = bookingSlot(booking)
  if (!cancellationProfileKey(booking)) return 'This reservation needs its original caller identity verified before cancellation.'
  if (!booking.startsAt || !booking.endsAt || !slot) return 'Verify this reservation’s start and end times before cancelling.'
  if (slot.startsAt <= now) return 'This tour has already started. Preserve its history and record the outcome with staff.'
  if (bookingReviewProjectionPending(state, booking.externalId) || booking.rescheduleHistory?.some(c => c.projection === 'pending')) return 'Resolve this reservation’s pending booking review before cancelling.'
  return null
}
export function createTourCancellationService(runtime: ResolvedPropertyRuntime, now = () => new Date()) {
  assertAuthorizedScope(runtime.scope, 'operate')
  const actor = runtime.scope.actor
  if (actor.kind !== 'user') return fail('tour_cancellation_staff_required', 'Staff sign-in is required.', 403)
  const fingerprint = (booking: SlotBooking) => hashJson({ organizationId: runtime.scope.organizationId,
    propertyId: runtime.scope.propertyId, configurationVersion: runtime.snapshot.version, booking })
  const stamp = () => { const d = now(); if (!Number.isFinite(d.getTime())) return fail('tour_cancellation_clock_invalid', 'The calendar clock is unavailable.'); return d }
  const archived = (state: CalendarState, externalId: string) => {
    const found = cancellations(state).find(c => c.booking.externalId === externalId)
    if (found && state.bookings.some(b => b.externalId === externalId)) return corrupt()
    return found
  }
  function view(state: CalendarState, externalId: unknown) {
    if (!text(externalId,1024)) return fail('tour_cancellation_input_invalid', 'Choose a saved reservation.', 400)
    const saved = archived(state, externalId)
    if (saved) return { status: 'cancelled' as const, externalId, booking: saved.booking, cancellation: saved,
      canCancel: false, reason: null, expectedSha256: null, notification: 'not_sent' as const }
    const booking = findBooking(state, externalId), reason = held(state, booking, stamp())
    return { status: 'active' as const, externalId, booking, cancellation: null,
      canCancel: reason === null, reason, expectedSha256: fingerprint(booking), notification: 'not_sent' as const }
  }
  return {
    read: (externalId: unknown) => runtime.calendarStore.transaction(async unit => {
      const current = view(await unit.readCalendar(), externalId)
      if (current.status !== 'active' || current.booking.interactionId) return current
      const key = cancellationProfileKey(current.booking), profile = key ? await unit.documents.get<LeadProfile>(key) : null
      const probe = { booking: current.booking, interactionIds: [], at: stamp().toISOString() }
      const targets = profile?.bookings.filter(b => matchesCancelledBooking(b, probe, profile)) ?? []
      return targets.length === 1 ? current : { ...current, canCancel: false,
        reason: 'Link this reservation to its original call before cancellation so delayed call results cannot restore it.' }
    }),
    async cancel(input: unknown) {
      const command = parseTourCancellation(input), manifestSha256 = hashJson({ ...command, actorId: actor.userId })
      return runtime.calendarStore.transaction(async unit => {
        const state = await unit.readCalendar(), saved = archived(state, command.externalId)
        const prior = await unit.documents.get<Receipt>(commandKey(command.requestId))
        if (prior) {
          if (prior.format !== 'tour-cancellation-command-v1' || !digest(prior.manifestSha256)
            || hashJson(checkedCancellation(prior.cancellation)) !== hashJson(saved)
            || !prior.projection || !['complete','awaiting_call','needs_review'].includes(prior.projection.status)
            || !Number.isSafeInteger(prior.projection.retired) || prior.projection.retired < 0
            || !Number.isSafeInteger(prior.projection.review) || prior.projection.review < 0) return corrupt()
          if (prior.manifestSha256 !== manifestSha256 || prior.cancellation.requestId !== command.requestId
            || prior.cancellation.actorId !== actor.userId || prior.cancellation.reason !== command.reason) return fail('tour_cancellation_request_conflict', 'This request belongs to a different cancellation. Reload the reservation.')
          return { replayed: true, current: view(state, command.externalId), projection: prior.projection }
        }
        if (saved) return fail('tour_already_cancelled', 'This reservation was already cancelled. Reload to read its saved history.')
        const booking = findBooking(state, command.externalId)
        if (fingerprint(booking) !== command.expectedSha256) return fail('tour_cancellation_changed', 'The reservation changed. Reload and review its current time and contact before cancelling.')
        const at = stamp(), reason = held(state, booking, at)
        if (reason) return fail('tour_cancellation_held', reason)
        const key = cancellationProfileKey(booking)
        // Missing leads must be locked too. A late completion cannot insert behind this decision.
        const profile = key ? await unit.readLockedDocument<LeadProfile>(key) : null
        const cancellation: TourCancellation = { format: 'tour-cancellation-v1', booking: structuredClone(booking),
          requestId: command.requestId, actorId: actor.userId, at: at.toISOString(), reason: command.reason,
          interactionIds: booking.interactionId ? [booking.interactionId] : [], notification: 'not_sent' }
        if (profile) {
          const targets = profile.bookings.filter(b => matchesCancelledBooking(b, cancellation, profile))
          if (targets.length > 1) return fail('tour_cancellation_identity_ambiguous', 'The lead contains conflicting reservation identities. Resolve them before cancelling.')
          cancellation.interactionIds = [...new Set([...cancellation.interactionIds, ...targets.map(b => b.callId)])]
        }
        if (!cancellation.interactionIds.length) return fail('tour_cancellation_identity_missing', 'Link this reservation to its original call before cancellation.')
        checkedCancellation(cancellation)
        const updated = await unit.calendar.mutate(current => {
          const b = findBooking(current, command.externalId)
          if (fingerprint(b) !== command.expectedSha256) return fail('tour_cancellation_changed', 'The reservation changed. Reload before cancelling.')
          return { ...current, bookings: current.bookings.filter(row => row !== b), cancelledBookings: [...cancellations(current), cancellation] }
        })
        await retainCancellation(unit.documents, cancellation)
        const projected = key && profile ? await applySavedCancellations(unit.documents, key, profile, runtime.snapshot.timeZone) : null
        const projection: Receipt['projection'] = { status: !profile ? 'awaiting_call' : projected?.review ? 'needs_review' : 'complete',
          retired: projected?.retired ?? 0, review: projected?.review ?? 0 }
        await unit.documents.set<Receipt>(commandKey(command.requestId), { format: 'tour-cancellation-command-v1', manifestSha256, cancellation, projection })
        return { replayed: false, current: view(updated, command.externalId), projection }
      })
    },
  }
}
