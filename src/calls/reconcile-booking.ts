import type { CalendarStore } from '../calendar/types.ts'
import type { DocumentStore } from '../store/documents.ts'
import { CalendarActionError, requestIdentity } from '../calendar/unit-blocks.ts'
import { validateBookingReviewAttempt, reconcileCalendarBookingReview, calendarBookingReviewForCall,
  completeCalendarBookingReviewResolution, validateCalendarBookingReviewResolution } from '../calendar/booking-review.ts'
import type { CalendarBookingReviewResolution } from '../calendar/types.ts'
import { getBookingReview, resolveBookingReviewRecord, type BookingReview } from './booking-review.ts'
import { reviveStoredCall, validateBookingReviewWork, projectFrozenCall, assertCallProjectionClaim,
  type CallState, type BookingReviewWork } from './completion.ts'
import { validateCallLifecycle, resolveReviewedBookingIntent, CallLifecycleError } from './lifecycle.ts'
import { canonicalJson } from '../workflows/validation.ts'
import { receiptKey } from '../leads/inbox.ts'

export type BookingReviewScope = { tenantId: string } | { organizationId: string; propertyId: string }
export interface ReconcileBookingReviewInput {
  callId: string
  sourceRevision: number
  requestId: string
  actorId: string
  now: Date
  scope: BookingReviewScope
}
export interface ReconcileBookingReviewResult {
  status: 'complete' | 'pending_projection'
  bookingReview: BookingReview
  notificationSent: false
  message?: string
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const fail = (code: string, message: string): never => { throw new CalendarActionError(code, message, 409) }
const key = (callId: string) => `call:${callId}`

/** Current authorization belongs to the caller; stored identity must match its selected scope. */
function assertScope(state: CallState, expected: BookingReviewScope): void {
  if (!state.work) return fail('booking_review_call_unavailable', 'Saved call evidence is incomplete. An administrator must inspect this review.')
  const provenance = validateCallLifecycle(state.work).provenance
  if (!provenance || !expected || typeof expected !== 'object') return fail('booking_review_scope_conflict', 'This call does not have verified property ownership.')
  if ('tenantId' in expected) {
    if (!ID.test(expected.tenantId) || !('tenantId' in provenance) || provenance.tenantId !== expected.tenantId || state.routing) {
      return fail('booking_review_scope_conflict', 'This call belongs to another workspace.')
    }
  } else if ('tenantId' in provenance || !ID.test(expected.organizationId) || !ID.test(expected.propertyId)
    || provenance.organizationId !== expected.organizationId || provenance.propertyId !== expected.propertyId
    || !state.routing || state.routing.organizationId !== expected.organizationId || state.routing.propertyId !== expected.propertyId
    || state.routing.channelBindingId !== provenance.channelBindingId) {
    return fail('booking_review_scope_conflict', 'This call belongs to another property or has inconsistent routing evidence.')
  }
}

function savedAttempt(state: CallState, claim?: BookingReviewWork) {
  if (!state.bookingAttempt || typeof state.bookingAttempt.toolId !== 'string' || !ID.test(state.bookingAttempt.toolId)) {
    return fail('booking_review_evidence_incomplete', 'This older call lacks exact dispatch evidence. Staff must inspect its calendar manually.')
  }
  const attempt = validateBookingReviewAttempt(state.bookingAttempt)
  if (claim && (state.bookingAttempt.toolId !== claim.toolId || canonicalJson(attempt) !== canonicalJson(claim.attempt))) {
    return fail('booking_review_attempt_conflict', 'The saved staff claim no longer matches this booking attempt.')
  }
  return attempt
}

function assertReviewAttempt(review: BookingReview, state: CallState): void {
  const attempt = savedAttempt(state)
  if (!review.booking || canonicalJson(validateBookingReviewAttempt({ ...review.booking,
    endsAt: review.booking.endsAt!, externalId: review.booking.externalId! })) !== canonicalJson(attempt)
    || !state.booking || state.booking.status !== 'arranging'
    || canonicalJson(validateBookingReviewAttempt({ ...state.booking, endsAt: state.booking.endsAt!, externalId: state.booking.externalId! })) !== canonicalJson(attempt)) {
    return fail('booking_review_attempt_conflict', 'The call, review and attempted reservation do not agree. Staff must inspect the calendar.')
  }
}

function eligible(state: CallState, sourceRevision: number): void {
  const work = validateCallLifecycle(state.work!)
  if (state.completedAt || work.phase === 'complete' || work.phase === 'frozen') {
    return fail('booking_review_call_completed', 'This call already completed through another request. Refresh before reviewing it.')
  }
  if (work.revision !== sourceRevision) return fail('booking_review_revision_conflict', 'The call changed. Reload this review before continuing.')
  const uncertain = work.intents.filter(intent => intent.status !== 'complete' && intent.status !== 'blocked')
  if (!work.end || uncertain.length !== 1 || uncertain[0]!.name !== 'book_tour'
    || !['needs_review', 'dispatch_started'].includes(uncertain[0]!.status) || uncertain[0]!.dispatchStartedAt === null
    || uncertain[0]!.id !== state.bookingAttempt!.toolId) {
    return fail('booking_review_call_unresolved', 'Wait for the call to finish and other call work to settle before verifying this booking.')
  }
}

function matchReceipt(receipt: CalendarBookingReviewResolution, claim: BookingReviewWork): void {
  if (receipt.requestId !== claim.requestId || receipt.callId !== claim.callId || receipt.sourceRevision !== claim.sourceRevision
    || receipt.actorId !== claim.actorId || canonicalJson(receipt.attempt) !== canonicalJson(claim.attempt)) {
    return fail('booking_review_receipt_conflict', 'Saved calendar evidence does not match the canonical staff review.')
  }
}

function result(bookingReview: BookingReview, pending = false): ReconcileBookingReviewResult {
  return { status: pending ? 'pending_projection' : 'complete', bookingReview, notificationSent: false,
    ...(pending ? { message: 'The review is still being reconciled. Retry this review; no new booking or notification was requested by this check.' } : {}) }
}

/** Calendar/document ports are already authorized and property-scoped. Never calls createBooking. */
export async function reconcileBookingReview(calendar: CalendarStore, documents: DocumentStore,
  input: ReconcileBookingReviewInput): Promise<ReconcileBookingReviewResult> {
  if (typeof input.callId !== 'string' || !ID.test(input.callId) || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    return fail('booking_review_revision_conflict', 'Choose a saved booking review and reload its current revision.')
  }
  requestIdentity(input.requestId)
  const checkedAt = input.now.toISOString()
  const review = await getBookingReview(documents, input.callId)
  if (!review) return fail('booking_review_missing', 'This saved review is unavailable. Reload before proceeding.')
  let claim: BookingReviewWork | undefined
  try {
    const claimed = (await documents.update<CallState | null>(key(input.callId), null, raw => {
      if (!raw) return fail('booking_review_call_unavailable', 'The original call evidence is unavailable. Staff must inspect this review.')
      const current = reviveStoredCall(raw)
      assertScope(current, input.scope)
      if (current.bookingReviewWork) {
        const saved = validateBookingReviewWork(current.bookingReviewWork)
        if (saved.callId !== input.callId) return fail('booking_review_receipt_conflict', 'This staff claim belongs to another call.')
        savedAttempt(current, saved)
        return current
      }
      if (!review.needsReview || review.sourceRevision !== input.sourceRevision) return fail('booking_review_revision_conflict', 'This review changed. Refresh before proceeding.')
      assertReviewAttempt(review, current)
      eligible(current, input.sourceRevision)
      const bookingReviewWork = validateBookingReviewWork({ requestId: input.requestId, callId: input.callId,
        sourceRevision: input.sourceRevision, actorId: input.actorId, claimedAt: checkedAt,
        toolId: current.bookingAttempt!.toolId, attempt: savedAttempt(current) })
      return { ...current, bookingReviewWork }
    }))!
    claim = validateBookingReviewWork(claimed.bookingReviewWork!)
    // The durable call claim must win before any calendar admission fence. A
    // competing webhook that already froze the call makes that first CAS refuse.
    let calendarState = await calendar.read()
    let receipt = calendarBookingReviewForCall(calendarState, input.callId)
    if (receipt) matchReceipt(receipt, claim)
    if (receipt?.projection === 'complete') {
      // Later calendar/lead changes are legitimate. Completed history permits
      // only final review metadata repair, never old call/profile projection.
      const closed = await resolveBookingReviewRecord(documents, { callId: input.callId, sourceRevision: claim.sourceRevision, resolution: receipt, now: input.now })
      return result(closed)
    }
    if (!receipt) {
      // A normal call receipt must not precede staff ownership. Never overwrite
      // an already accepted older outcome with a staff-generated confirmation.
      if (await documents.get(receiptKey(input.callId))) return fail('booking_review_call_completed', 'This call already has a finished-call receipt. An administrator must inspect it before reconciliation.')
      calendarState = await calendar.mutate(current => reconcileCalendarBookingReview(current, {
        requestId: claim!.requestId, callId: claim!.callId, sourceRevision: claim!.sourceRevision,
        actorId: claim!.actorId, checkedAt, attempt: claim!.attempt,
      }))
      receipt = calendarBookingReviewForCall(calendarState, input.callId)
      if (!receipt) throw new Error('Saved calendar review receipt was not returned')
    }
    matchReceipt(receipt, claim)
    validateCalendarBookingReviewResolution(calendarState, receipt)
    const resolution = receipt
    await documents.update<CallState | null>(key(input.callId), null, raw => {
      if (!raw) return fail('booking_review_call_unavailable', 'The saved call is unavailable. Retry this review.')
      const current = reviveStoredCall(raw)
      assertScope(current, input.scope); assertCallProjectionClaim(current, input.callId, claim)
      savedAttempt(current, claim)
      if (!current.work) throw new CallLifecycleError('call_work_unresolved')
      const work = resolveReviewedBookingIntent(current.work, { toolId: claim!.toolId, requestId: claim!.requestId,
        outcome: resolution.outcome, checkedAt: resolution.checkedAt, now: checkedAt })
      if (current.completedAt || current.work.phase === 'frozen' || current.work.phase === 'complete') return current
      return { ...current, work, booking: { ...resolution.attempt, status: resolution.outcome === 'confirmed' ? 'confirmed' as const : 'failed' as const },
        escalation: resolution.outcome === 'not_booked' && current.escalation === null
          ? { trigger: 'booking_failed', detail: 'Staff verified that no reservation remains for this attempted tour. Staff must contact the prospect; no notification was sent.' }
          : current.escalation }
    })
    await projectFrozenCall(documents, input.callId, input.now, { reviewClaim: claim })
    await resolveBookingReviewRecord(documents, { callId: input.callId, sourceRevision: claim.sourceRevision, resolution, now: input.now })
    calendarState = await calendar.mutate(current => completeCalendarBookingReviewResolution(current, claim!.requestId))
    const complete = calendarBookingReviewForCall(calendarState, input.callId)
    if (!complete || complete.projection !== 'complete') throw new Error('Calendar projection completion was not returned')
    const closed = await resolveBookingReviewRecord(documents, { callId: input.callId, sourceRevision: claim.sourceRevision, resolution: complete, now: input.now })
    return result(closed)
  } catch (error) {
    if (calendar.describe().kind === 'postgres' || error instanceof CalendarActionError || error instanceof CallLifecycleError) throw error
    // KV cannot roll back several records. A durable claim is recoverable, even
    // when the acknowledgement that created it was lost. Never unlock by age.
    const saved = await documents.get<CallState>(key(input.callId)).catch(() => null)
    if (saved) {
      const current = reviveStoredCall(saved)
      assertScope(current, input.scope)
      if (current.bookingReviewWork) {
        const canonical = validateBookingReviewWork(current.bookingReviewWork)
        if (canonical.callId !== input.callId) throw error
        const latest = await getBookingReview(documents, input.callId).catch(() => null)
        if (latest) return result(latest, true)
      }
    }
    throw error
  }
}
