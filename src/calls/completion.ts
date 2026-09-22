import type { DocumentStore } from '../store/documents.ts'
import { emptyQualification, type QualificationState } from '../leasing/qualification.ts'
import type { LossReason } from '../record/store.ts'
import type { EmergencySignal } from '../escalation/emergency.ts'
import { normalisePhone, type Evidence } from '../leads/profile.ts'
import { receiveFinishedCall, type CallReceiptScope } from '../leads/inbox.ts'
import { freezeCall, completeCall, validateCallLifecycle, CallLifecycleError, type CallLifecycle } from './lifecycle.ts'
import type { BookingReviewAttempt } from '../calendar/types.ts'
import { validateBookingReviewAttempt } from '../calendar/booking-review.ts'
import { requestIdentity } from '../calendar/unit-blocks.ts'
import { canonicalJson } from '../workflows/validation.ts'

export interface BookingReviewWork {
  requestId: string
  callId: string
  sourceRevision: number
  actorId: string
  claimedAt: string
  toolId: string
  attempt: BookingReviewAttempt
}

export interface CallState {
  routing?: { organizationId: string; propertyId: string; channelBindingId: string }
  qualification: QualificationState
  phone?: string
  callbackPhone?: Evidence<string>
  completedAt?: string
  work?: CallLifecycle
  name: string | null
  email: string | null
  unitsDiscussed: string[]
  booking: { slotId: string; startsAt: string; endsAt?: string; unitId: string | null;
    status: 'confirmed' | 'arranging' | 'failed'; externalId?: string } | null
  /** Saved with dispatch admission before any calendar create is attempted. */
  bookingAttempt?: BookingReviewAttempt & { toolId: string }
  /** Permanent canonical staff ownership; never released on a timeout. */
  bookingReviewWork?: BookingReviewWork
  lossReason: LossReason | null
  escalation: { trigger: string; detail: string } | null
  emergency: EmergencySignal | null
  tourChangeRequested?: boolean
  toolsCalled: string[]
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
export function validateBookingReviewWork(value: BookingReviewWork): BookingReviewWork {
  if (!value || typeof value !== 'object' || typeof value.callId !== 'string' || !ID.test(value.callId)
    || typeof value.toolId !== 'string' || !ID.test(value.toolId)
    || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0
    || typeof value.actorId !== 'string' || !value.actorId.trim() || value.actorId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.actorId)
    || typeof value.claimedAt !== 'string' || !Number.isFinite(Date.parse(value.claimedAt)) || new Date(value.claimedAt).toISOString() !== value.claimedAt) {
    throw new CallLifecycleError('call_work_invalid')
  }
  requestIdentity(value.requestId)
  return { requestId: value.requestId, callId: value.callId, sourceRevision: value.sourceRevision,
    actorId: value.actorId, claimedAt: value.claimedAt, toolId: value.toolId, attempt: validateBookingReviewAttempt(value.attempt) }
}

const fresh = (): CallState => ({ qualification: emptyQualification(), name: null, email: null, unitsDiscussed: [],
  booking: null, lossReason: null, escalation: null, emergency: null, toolsCalled: [] })

/** Pure revival; transport retains responsibility for the current routing check. */
export function reviveStoredCall(raw: CallState): CallState {
  if (!raw || typeof raw !== 'object' || !raw.qualification || typeof raw.qualification !== 'object') throw new CallLifecycleError('call_work_invalid')
  const state = structuredClone(raw), q = state.qualification as unknown as Record<string, unknown>
  if (state.work) {
    const work = validateCallLifecycle(state.work)
    if ((state.completedAt !== undefined) !== (work.phase === 'complete')
      || (state.completedAt !== undefined && state.completedAt !== work.end?.endedAt)) throw new CallLifecycleError('call_work_invalid')
  }
  for (const k of ['moveInTiming', 'budget', 'bedrooms', 'pets', 'parking', 'source'] as const) {
    const value = q[k] as { at?: string | Date; value?: Record<string, unknown> } | undefined
    if (value?.at) value.at = new Date(value.at)
    if (k === 'moveInTiming' && value?.value) {
      if (value.value.earliest) value.value.earliest = new Date(value.value.earliest as string)
      if (value.value.latest) value.value.latest = new Date(value.value.latest as string)
    }
  }
  return { ...fresh(), ...state }
}

export function assertCallProjectionClaim(state: CallState, callId: string, expected?: BookingReviewWork): void {
  if (!state.bookingReviewWork && !expected) return
  if (!state.bookingReviewWork || !expected) throw new CallLifecycleError('call_admission_stale')
  const actual = validateBookingReviewWork(state.bookingReviewWork), claim = validateBookingReviewWork(expected)
  if (actual.callId !== callId || claim.callId !== callId || canonicalJson(actual) !== canonicalJson(claim)) {
    throw new CallLifecycleError('call_admission_stale')
  }
}

function completionScope(state: CallState, expected?: CallReceiptScope): { scope?: CallReceiptScope; legacyTimeZone?: string } {
  const provenance = state.work ? validateCallLifecycle(state.work).provenance : null
  if (!provenance) return expected ? { scope: expected } : {}
  if ('tenantId' in provenance) {
    if (expected) throw new CallLifecycleError('call_provenance_conflict')
    return { legacyTimeZone: provenance.timeZone }
  }
  const scope: CallReceiptScope = { organizationId: provenance.organizationId, propertyId: provenance.propertyId,
    channelBindingId: provenance.channelBindingId, configurationVersion: provenance.configurationVersion, timeZone: provenance.timeZone }
  if (expected && canonicalJson(scope) !== canonicalJson(expected)) throw new CallLifecycleError('call_provenance_conflict')
  if (!state.routing || state.routing.organizationId !== scope.organizationId || state.routing.propertyId !== scope.propertyId
    || state.routing.channelBindingId !== scope.channelBindingId) throw new CallLifecycleError('call_provenance_conflict')
  return { scope }
}

/** Document-only completion; its caller owns the PostgreSQL transaction or KV retry. */
export async function projectFrozenCall(store: DocumentStore, callId: string, now: Date,
  options: { reviewClaim?: BookingReviewWork; receiptScope?: CallReceiptScope } = {}): Promise<CallState> {
  if (typeof callId !== 'string' || !ID.test(callId)) throw new CallLifecycleError('call_work_invalid')
  const frozen = reviveStoredCall((await store.update<CallState | null>(`call:${callId}`, null, raw => {
    if (!raw) throw new CallLifecycleError('call_work_unresolved')
    const current = reviveStoredCall(raw)
    assertCallProjectionClaim(current, callId, options.reviewClaim)
    if (current.completedAt) return current
    if (!current.work) throw new CallLifecycleError('call_work_unresolved')
    completionScope(current, options.receiptScope)
    return { ...current, work: freezeCall(current.work, { now: now.toISOString() }) }
  }))!)
  if (frozen.completedAt) return frozen
  const work = frozen.work!, end = work.end!, phone = normalisePhone(frozen.phone ?? end.reportedPhone ?? 'unknown')
  const scope = completionScope(frozen, options.receiptScope)
  await receiveFinishedCall(store, { callId, phone, at: new Date(end.endedAt), durationSeconds: end.durationSeconds,
    qualification: frozen.qualification, name: frozen.name, email: frozen.email,
    ...(frozen.callbackPhone ? { callbackPhone: frozen.callbackPhone } : {}), unitsDiscussed: frozen.unitsDiscussed,
    booking: frozen.booking, lossReason: frozen.lossReason, escalation: frozen.escalation, toolsCalled: frozen.toolsCalled,
  }, now, scope.scope, scope.legacyTimeZone)
  return (await store.update<CallState | null>(`call:${callId}`, null, raw => {
    if (!raw) throw new CallLifecycleError('call_revision_conflict')
    const current = reviveStoredCall(raw)
    assertCallProjectionClaim(current, callId, options.reviewClaim)
    if (!current.work) throw new CallLifecycleError('call_revision_conflict')
    const completed = completeCall(current.work, { now: now.toISOString(), frozenRevision: work.frozenRevision! })
    return { ...fresh(), phone, completedAt: end.endedAt, work: completed,
      ...(current.routing ? { routing: current.routing } : {}),
      ...(current.bookingAttempt ? { bookingAttempt: current.bookingAttempt } : {}),
      ...(current.bookingReviewWork ? { bookingReviewWork: current.bookingReviewWork } : {}),
      emergency: current.emergency, escalation: current.escalation,
      ...(current.tourChangeRequested ? { tourChangeRequested: true } : {}) }
  }))!
}
