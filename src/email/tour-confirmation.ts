import { propertyEmailBinding } from './sender.ts'
import { bookingRevision, findBooking } from '../calendar/reschedule.ts'
import { bookingSlot, blockFor, unitBlocksFor } from '../calendar/slots.ts'
import { bookingReviewProjectionPending } from '../calendar/booking-review.ts'
import { heldEmergency } from '../calendar/safety.ts'
import { CalendarActionError } from '../calendar/unit-blocks.ts'
import type { CalendarState } from '../calendar/types.ts'
import type { PropertySnapshot } from '../properties/model.ts'
import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import { PostgresWorkflowRepository, type WorkflowTransaction } from '../database/workflows.ts'
import { hashJson } from '../workflows/validation.ts'
import { runWorkflowOnce } from '../workflows/worker.ts'
import type { WorkflowAction } from '../workflows/model.ts'
import { ResendTransport, validEmailAddress } from './render.ts'
import type { EmailMessage } from './render.ts'
import { emailWorkflowAction, emailMessageDigest, createResendEmailConnector } from './workflow.ts'

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown, max = 500): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const fail = (code: string, message: string, status = 409): never => { throw new CalendarActionError(code, message, status) }
export const tourEmailBinding = (snapshot: PropertySnapshot, now: Date) => propertyEmailBinding(snapshot, now, 'tourConfirmationEmail')
export function prepareTourConfirmation(state: CalendarState, snapshot: PropertySnapshot, externalId: unknown, now: Date) {
  if (!Number.isFinite(now.getTime())) return fail('confirmation_clock_invalid', 'The confirmation clock is unavailable.')
  const booking = findBooking(state, externalId)
  if (typeof booking.startsAt !== 'string' || typeof booking.endsAt !== 'string') {
    return fail('confirmation_details_missing', 'The saved tour needs exact start and end times before sending.')
  }
  const slot = bookingSlot(booking)
  if (!slot || slot.startsAt <= now) return fail('confirmation_tour_past', 'Only a future, confirmed tour can receive a confirmation.')
  if (bookingReviewProjectionPending(state, booking.externalId) || booking.rescheduleHistory?.some(change => change.projection === 'pending')
    || (booking.interactionId && heldEmergency(state, booking.interactionId))) return fail('confirmation_tour_held', 'Resolve the tour’s pending review before sending a confirmation.')
  const options = { timeZone: snapshot.timeZone }
  const occupancy = { ...slot, startsAt: new Date(booking.occupiedStartsAt ?? slot.startsAt), endsAt: new Date(booking.occupiedEndsAt ?? slot.endsAt) }
  if (!Number.isFinite(occupancy.startsAt.getTime()) || !Number.isFinite(occupancy.endsAt.getTime())
    || occupancy.startsAt > slot.startsAt || occupancy.endsAt < slot.endsAt) return fail('confirmation_details_missing', 'The tour’s reserved time needs review.')
  if (blockFor(occupancy, state, options) || (booking.unitId && unitBlocksFor(occupancy, state, options, booking.unitId).length)) {
    return fail('confirmation_tour_blocked', 'This tour overlaps an availability hold. Review its time or apartment before sending.')
  }
  if (!validEmailAddress(booking.prospectEmail)) return fail('confirmation_email_missing', 'The saved tour needs a valid prospect email address before sending.')
  if (!text(booking.prospectName, 200) || !text(snapshot.property.buildingName, 100) || !text(snapshot.property.address)
    || (booking.unitId !== null && !text(booking.unitId, 80))) return fail('confirmation_details_missing', 'The saved tour or property details need review.')
  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: snapshot.timeZone }).format(slot.startsAt)
  const binding = tourEmailBinding(snapshot, now)
  const subject = `Your tour at ${snapshot.property.buildingName}`
  const body = `Hi ${booking.prospectName},\n\nYour saved tour is scheduled for ${when} (${snapshot.timeZone}).\n${booking.unitId ? `Residence ${booking.unitId}\n` : ''}${snapshot.property.buildingName}\n${snapshot.property.address}\n\nThese details reflect the saved reservation. Contact the leasing team if your plans change.`
  const message: EmailMessage | null = binding ? { to: booking.prospectEmail, from: binding.from, replyTo: binding.replyTo,
    subject, html: body.split('\n\n').map(part => `<p>${escape(part).replace(/\n/g, '<br>')}</p>`).join('') } : null
  const bookingSha256 = hashJson({ organizationId: snapshot.organizationId, propertyId: snapshot.propertyId, version: snapshot.version,
    externalId: booking.externalId, revision: bookingRevision(booking), startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(),
    recipient: booking.prospectEmail, unitId: booking.unitId, subject, body, binding })
  return { externalId: booking.externalId, reservationRevision: bookingRevision(booking), bookingSha256, recipient: booking.prospectEmail, when, subject, body, message, binding }
}

export interface TourConfirmationRecord {
  format: 'tour-confirmation-v1'; id: string; externalId: string; bookingSha256: string
  reservationRevision?: number
  actionId: string; actorId: string; actorKind?: 'user' | 'channel'; recordedAt: string; messageSha256: string
}
export const tourConfirmationKey = (id: string) => 'tour-confirmation:' + id
const key = tourConfirmationKey
const summary = (record: TourConfirmationRecord, action: WorkflowAction) => ({ id: record.id, state: action.state,
  permissionRecordedAt: record.recordedAt, updatedAt: action.updatedAt, code: action.lastErrorCode,
  delivery: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered' ? 'delivered' : 'not_verified',
  canProcess: ['queued','retry_wait','verifying'].includes(action.state) || action.state === 'running',
  message: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered' ? 'The provider reports delivery. This does not mean the prospect read the email.'
    : action.state === 'succeeded' ? 'The workflow completed without verified delivery. Ask an administrator to review it.'
    : action.state === 'needs_review' ? 'Delivery needs staff review. Do not create a duplicate send.'
      : action.state === 'cancelled' ? 'This confirmation was cancelled before dispatch.'
        : action.dispatchStarted ? 'Delivery is not yet verified. Check again to reconcile this same email.' : 'Saved with permission. This email has not been sent yet.' })
export function validateTourConfirmationRecord(value: unknown, id: string): TourConfirmationRecord {
  const v = value as TourConfirmationRecord | null
  if (!v || v.format !== 'tour-confirmation-v1' || v.id !== id || v.bookingSha256 !== id || !text(v.actionId, 128)
    || !text(v.externalId, 1024) || !text(v.actorId, 128) || !text(v.recordedAt, 50) || !Number.isFinite(Date.parse(v.recordedAt))
    || (v.reservationRevision !== undefined && (!Number.isSafeInteger(v.reservationRevision) || v.reservationRevision < 0))
    || (v.actorKind !== undefined && !['user','channel'].includes(v.actorKind)) || !digest(v.messageSha256)) return fail('confirmation_record_invalid', 'The saved confirmation needs administrator review.')
  return v
}
export function validateTourConfirmationAction(runtime: ResolvedPropertyRuntime, record: TourConfirmationRecord, action: WorkflowAction | null): WorkflowAction {
  const message = action?.input.message as EmailMessage | undefined
  const consent = action?.input.consent as { receiptId?: unknown; recordedAt?: unknown } | undefined
  if (!action || action.id !== record.actionId || action.kind !== 'leasing_email' || action.connector !== 'resend_email_v1'
    || action.organizationId !== runtime.scope.organizationId || action.propertyId !== runtime.scope.propertyId
    || (record.actorKind === 'channel' ? action.origin.kind !== 'channel' || action.origin.bindingId !== record.actorId
      : action.origin.kind !== 'user' || action.origin.userId !== record.actorId)
    || hashJson(action.input) !== action.inputSha256 || !message || emailMessageDigest(message) !== record.messageSha256
    || consent?.receiptId !== 'tour-' + record.id || consent.recordedAt !== record.recordedAt) {
    return fail('confirmation_record_invalid', 'The confirmation workflow needs administrator review.')
  }
  return action
}
/** One reservation revision is one confirmation purpose even when contact/content changes.
 * Legacy records without a scheduling revision conservatively require review.
 * The index is scoped, transactionally written and bounded per reservation, not per building.
 */
const confirmationIndexKey = (externalId: string) => 'tour-confirmation-index:' + hashJson(externalId)
export const priorConfirmationMessage = 'An earlier confirmation exists for this reservation. Its address or details differ. Review it in the Work queue before requesting another email; delivery may already have occurred.'
export async function tourConfirmationHistory(runtime: ResolvedPropertyRuntime, unit: WorkflowTransaction,
  draft: ReturnType<typeof prepareTourConfirmation>) {
  const index = await unit.documents.get<{ format: string; externalId: string; ids: string[] }>(confirmationIndexKey(draft.externalId))
  if (index && (index.format !== 'tour-confirmation-index-v1' || index.externalId !== draft.externalId
    || !Array.isArray(index.ids) || index.ids.length > 1000 || index.ids.some(id => !digest(id))
    || new Set(index.ids).size !== index.ids.length)) return fail('confirmation_record_invalid', 'The confirmation history needs administrator review.')
  const ids: string[] = [], relevant: Array<{ record: TourConfirmationRecord; action: WorkflowAction }> = []
  let exact: { record: TourConfirmationRecord; action: WorkflowAction } | null = null
  // A delayed older writer may have saved a record without updating this index.
  // Exact scoped discovery prevents a partially upgraded index from hiding that action.
  const keys = [...new Set([...(index?.ids.map(key) ?? []), ...await unit.tourConfirmationKeys(draft.externalId)])]
  if (keys.length > 1000) return fail('confirmation_record_invalid', 'The confirmation history needs administrator review.')
  for (const recordKey of keys) {
    const raw = await unit.documents.get<TourConfirmationRecord>(recordKey)
    if (!index && raw?.externalId !== draft.externalId) continue
    const record = validateTourConfirmationRecord(raw, recordKey.slice('tour-confirmation:'.length))
    if (record.externalId !== draft.externalId) return fail('confirmation_record_invalid', 'The confirmation history needs administrator review.')
    ids.push(record.id)
    if (record.id !== draft.bookingSha256 && record.reservationRevision !== undefined && record.reservationRevision !== draft.reservationRevision) continue
    const action = validateTourConfirmationAction(runtime, record, await unit.workflows.get(record.actionId))
    const entry = { record, action }
    if (record.id === draft.bookingSha256) exact = entry
    if (!(action.state === 'cancelled' && !action.dispatchStarted && !action.providerReference)) relevant.push(entry)
  }
  if (ids.length > 1000 || relevant.length > 1) return fail('confirmation_record_invalid', 'The confirmation history needs administrator review before another email.')
  return { ids, exact, conflict: relevant.find(entry => entry.record.id !== draft.bookingSha256) ?? null }
}
export async function saveTourConfirmation(unit: WorkflowTransaction, record: TourConfirmationRecord, priorIds: string[]) {
  const ids = [...new Set([...priorIds, record.id])]
  if (ids.length > 1000) return fail('confirmation_record_invalid', 'The confirmation history needs administrator review.')
  await unit.documents.set(key(record.id), record)
  await unit.documents.set(confirmationIndexKey(record.externalId), { format: 'tour-confirmation-index-v1', externalId: record.externalId, ids })
}
export function createTourConfirmationService(runtime: ResolvedPropertyRuntime, workflows: PostgresWorkflowRepository,
  provider: { configured: boolean; transport: () => ResendTransport }, now: () => Date = () => new Date()) {
  const readiness = () => provider.configured && !!tourEmailBinding(runtime.snapshot, now())
  const reason = () => readiness() ? null : 'Email sending is not configured for this property. No email will be queued or sent.'
  const validateAction = (record: TourConfirmationRecord, action: WorkflowAction | null) => validateTourConfirmationAction(runtime, record, action)
  return {
    async preview(externalId: unknown) {
      return workflows.transaction(async unit => {
        const draft = prepareTourConfirmation(await unit.readCalendar(), runtime.snapshot, externalId, now())
        const history = await tourConfirmationHistory(runtime, unit, draft)
        const record = history.exact?.record, action = history.exact?.action
        return { preview: { externalId: draft.externalId, bookingSha256: draft.bookingSha256, recipient: draft.recipient, subject: draft.subject, body: draft.body },
          ready: readiness() && !history.conflict, reason: history.conflict ? priorConfirmationMessage : reason(), confirmation: record && action ? summary(record, action) : null }
      })
    },
    async queue(input: unknown) {
      const v = input as Record<string, unknown> | null
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'action,bookingSha256,externalId,permissionConfirmed'
        || v.action !== 'queue' || !digest(v.bookingSha256) || v.permissionConfirmed !== true) return fail('confirmation_input_invalid', 'Review the current tour and confirm the prospect’s permission.', 400)
      if (!readiness()) return fail('confirmation_not_configured', reason()!, 503)
      if (runtime.scope.actor.kind !== 'user') return fail('confirmation_staff_required', 'Staff sign-in is required.', 403)
      const actorId = runtime.scope.actor.userId
      return workflows.transaction(async unit => {
        const draft = prepareTourConfirmation(await unit.readCalendar(), runtime.snapshot, v.externalId, now())
        if (draft.bookingSha256 !== v.bookingSha256 || !draft.message) return fail('confirmation_tour_changed', 'The tour changed. Review the new details before recording permission.')
        const history = await tourConfirmationHistory(runtime, unit, draft)
        if (history.conflict) return fail('confirmation_prior_exists', priorConfirmationMessage)
        if (history.exact) return summary(history.exact.record, history.exact.action)
        const recordedAt = now().toISOString(), messageSha256 = emailMessageDigest(draft.message)
        const consent = { purpose: 'tour_confirmation' as const, recipient: draft.recipient, contentSha256: messageSha256, recordedAt,
          expiresAt: new Date(Date.parse(recordedAt) + 3600000).toISOString(), receiptId: 'tour-' + draft.bookingSha256 }
        const accepted = await unit.workflows.accept({ source: 'staff_tour_confirmation', eventId: draft.bookingSha256,
          payload: { permission: 'staff_attested_explicit_email_permission', bookingSha256: draft.bookingSha256 },
          actions: [emailWorkflowAction(draft.message, consent, 'tour-' + draft.bookingSha256)] })
        const action = accepted.actions[0]!
        const record: TourConfirmationRecord = { format: 'tour-confirmation-v1', id: draft.bookingSha256, externalId: draft.externalId,
          bookingSha256: draft.bookingSha256, reservationRevision: draft.reservationRevision, actionId: action.id, actorId, recordedAt, messageSha256 }
        await saveTourConfirmation(unit, record, history.ids)
        return summary(record, action)
      })
    },
    async process(id: unknown) {
      if (!digest(id)) return fail('confirmation_input_invalid', 'Choose a saved confirmation.', 400)
      if (!readiness()) return fail('confirmation_not_configured', reason()!, 503)
      const raw = await runtime.documents.get<TourConfirmationRecord>(key(id))
      if (!raw) return fail('confirmation_missing', 'This confirmation is not available in this property.', 404)
      const record = validateTourConfirmationRecord(raw, id)
      validateAction(record, await workflows.get(record.actionId))
      const binding = tourEmailBinding(runtime.snapshot, now())!
      const connector = createResendEmailConnector({ organizationId: runtime.scope.organizationId, propertyId: runtime.scope.propertyId,
        from: binding.from, replyTo: binding.replyTo, transport: provider.transport(), now })
      const original = connector.dispatch
      connector.dispatch = async (action, signal) => {
        try {
          validateAction(record, action)
          const current = prepareTourConfirmation(await runtime.calendarStore.read(), runtime.snapshot, record.externalId, now())
          if (current.bookingSha256 !== record.bookingSha256) return { status: 'rejected', code: 'tour_changed_before_send', retryable: false }
        } catch { return { status: 'rejected', code: 'tour_not_verified_before_send', retryable: false } }
        return original(action, signal)
      }
      await runWorkflowOnce({ repository: workflows, actionId: record.actionId, workerId: 'staff-tour-email',
        connectors: new Map([[connector.id, connector]]), now, timeoutMs: 6000, leaseMs: 20000,
        baseBackoffMs: 1000, maxBackoffMs: 60000 })
      return summary(record, validateAction(record, await workflows.get(record.actionId)))
    },
  }
}
