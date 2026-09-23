import { cancellations } from '../calendar/cancellation.ts'
import { CalendarActionError } from '../calendar/unit-blocks.ts'
import type { CalendarState, TourCancellation } from '../calendar/types.ts'
import type { PropertySnapshot } from '../properties/model.ts'
import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import { PostgresWorkflowRepository, type WorkflowTransaction } from '../database/workflows.ts'
import { hashJson } from '../workflows/validation.ts'
import { runWorkflowOnce } from '../workflows/worker.ts'
import type { WorkflowAction } from '../workflows/model.ts'
import { propertyEmailBinding } from './sender.ts'
import { ResendTransport, validEmailAddress, validEmailMessage, type EmailMessage } from './render.ts'
import { createResendEmailConnector, emailMessageDigest, emailWorkflowAction } from './workflow.ts'

const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const fail = (code: string, message: string, status = 409): never => { throw new CalendarActionError(code, message, status) }
const binding = (snapshot: PropertySnapshot, now: Date) => propertyEmailBinding(snapshot, now, 'tourCancellationEmail')
const recordKey = (id: string) => 'tour-cancellation-email:' + id
const purposeId = (source: TourCancellation) => hashJson([source.booking.externalId, source.requestId])
const indexKey = (source: TourCancellation) => 'tour-cancellation-email-index:' + purposeId(source)

function sourceFor(state: CalendarState, externalId: unknown): TourCancellation {
  if (!text(externalId, 1024)) return fail('cancellation_email_input_invalid', 'Choose a cancelled tour.', 400)
  const source = cancellations(state).find(row => row.booking.externalId === externalId)
  if (!source) return fail('cancellation_email_missing', 'This cancellation is not available in this property.', 404)
  if (state.bookings.some(row => row.externalId === externalId)) return fail('cancellation_email_source_conflict', 'The tour status needs staff review before sending.')
  return source
}

export function prepareCancellationEmail(state: CalendarState, snapshot: PropertySnapshot, externalId: unknown, now: Date) {
  if (!Number.isFinite(now.getTime())) return fail('cancellation_email_clock_invalid', 'The email clock is unavailable.')
  const source = sourceFor(state, externalId), booking = source.booking
  if (!validEmailAddress(booking.prospectEmail)) return fail('cancellation_email_recipient_missing', 'This cancelled tour has no valid saved email. Contact the prospect separately.')
  if (!text(booking.startsAt, 50) || !Number.isFinite(Date.parse(booking.startsAt))
    || !text(snapshot.property.buildingName, 100) || (booking.prospectName && !text(booking.prospectName, 200))
    || (booking.unitId !== null && !text(booking.unitId, 80))) return fail('cancellation_email_details_invalid', 'The saved tour details need review.')
  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: snapshot.timeZone }).format(new Date(booking.startsAt!))
  const subject = `Your tour at ${snapshot.property.buildingName} has been cancelled`
  // Staff's internal reason, caller identity and notes never enter outgoing copy.
  const body = `${booking.prospectName ? `Hi ${booking.prospectName},` : 'Hello,'}\n\nYour tour at ${snapshot.property.buildingName}, scheduled for ${when} (${snapshot.timeZone})${booking.unitId ? ` for Residence ${booking.unitId}` : ''}, has been cancelled.\n\nThis email does not reserve a replacement tour. Contact the leasing team if you would like to arrange another visit.`
  const sender = binding(snapshot, now)
  const message: EmailMessage | null = sender ? { to: booking.prospectEmail, from: sender.from, replyTo: sender.replyTo, subject,
    html: body.split('\n\n').map(part => `<p>${escape(part).replace(/\n/g, '<br>')}</p>`).join('') } : null
  // The shared review modal calls this bookingSha256; it binds the cancellation,
  // current property publication, recipient, exact copy and reviewed sender.
  const bookingSha256 = hashJson({ organizationId: snapshot.organizationId, propertyId: snapshot.propertyId,
    configurationVersion: snapshot.version, source, recipient: booking.prospectEmail, subject, body, sender })
  return { source, externalId: booking.externalId, bookingSha256, recipient: booking.prospectEmail, subject, body, message }
}

interface CancellationEmailRecord {
  format: 'tour-cancellation-email-v1'; id: string; purposeId: string; externalId: string
  actionId: string; actorId: string; recordedAt: string; messageSha256: string
}
function checkedRecord(raw: unknown, id: string): CancellationEmailRecord {
  const v = raw as CancellationEmailRecord | null
  if (!v || v.format !== 'tour-cancellation-email-v1' || v.id !== id || !digest(id) || !digest(v.purposeId)
    || !text(v.externalId, 1024) || !text(v.actionId, 128) || !text(v.actorId, 128) || !digest(v.messageSha256)
    || !text(v.recordedAt, 50) || !Number.isFinite(Date.parse(v.recordedAt))) return fail('cancellation_email_record_invalid', 'The saved email requires administrator review.')
  return v
}
function checkedAction(runtime: ResolvedPropertyRuntime, record: CancellationEmailRecord, action: WorkflowAction | null): WorkflowAction {
  const message = action?.input.message as EmailMessage | undefined
  const consent = action?.input.consent as Record<string, unknown> | undefined
  if (!action || action.id !== record.actionId || action.kind !== 'leasing_email' || action.connector !== 'resend_email_v1'
    || action.organizationId !== runtime.scope.organizationId || action.propertyId !== runtime.scope.propertyId
    || action.origin.kind !== 'user' || action.origin.userId !== record.actorId
    || action.inputSha256 !== hashJson(action.input) || !validEmailMessage(message) || emailMessageDigest(message) !== record.messageSha256
    || consent?.purpose !== 'tour_cancellation' || consent.receiptId !== 'cancel-' + record.id
    || consent.recordedAt !== record.recordedAt) return fail('cancellation_email_record_invalid', 'The saved email workflow requires administrator review.')
  return action
}
const summary = (record: CancellationEmailRecord, action: WorkflowAction) => ({ id: record.id, actionId: action.id,
  state: action.state, permissionRecordedAt: record.recordedAt, updatedAt: action.updatedAt, code: action.lastErrorCode,
  delivery: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered' ? 'delivered' : 'not_verified',
  canProcess: ['queued','retry_wait','verifying','running'].includes(action.state),
  message: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered'
    ? 'The provider reports delivery of the cancellation email. This does not mean the prospect read it.'
    : action.state === 'succeeded' ? 'The workflow completed without verified delivery. Ask an administrator to review it.'
      : action.state === 'needs_review' ? 'Delivery needs staff review. Do not create a duplicate email.'
        : action.state === 'cancelled' ? 'This email was cancelled before dispatch. The tour remains cancelled.'
          : action.dispatchStarted ? 'Delivery is not yet verified. Check this same email again.' : 'Permission saved. This cancellation email has not been sent yet.' })

export function createCancellationEmailService(runtime: ResolvedPropertyRuntime, workflows: PostgresWorkflowRepository,
  provider: { configured: boolean; transport: () => ResendTransport }, now: () => Date = () => new Date()) {
  const staff = () => { if (runtime.scope.actor.kind !== 'user') fail('cancellation_email_staff_required', 'Staff sign-in is required.', 403) }
  const ready = () => provider.configured && !!binding(runtime.snapshot, now())
  const unavailable = () => 'Cancellation email sending is not configured for this property. No email will be queued or sent.'
  const priorMessage = 'A cancellation email already exists with different reviewed details. Review that saved email in the Work queue before taking further action; it may already have been sent.'
  async function existing(unit: WorkflowTransaction, source: TourCancellation) {
    const index = await unit.documents.get<{ format: string; purposeId: string; id: string }>(indexKey(source))
    if (!index) return null
    if (index.format !== 'tour-cancellation-email-index-v1' || index.purposeId !== purposeId(source) || !digest(index.id)) return fail('cancellation_email_record_invalid', 'The saved email index requires administrator review.')
    const record = checkedRecord(await unit.documents.get(recordKey(index.id)), index.id)
    if (record.externalId !== source.booking.externalId || record.purposeId !== index.purposeId) return fail('cancellation_email_record_invalid', 'The saved email does not match this cancellation.')
    return { record, action: checkedAction(runtime, record, await unit.workflows.get(record.actionId)) }
  }
  return {
    async preview(externalId: unknown) {
      staff()
      return workflows.transaction(async unit => {
        const state = await unit.readCalendar(), source = sourceFor(state, externalId)
        const previous = await existing(unit, source)
        let draft: ReturnType<typeof prepareCancellationEmail> | null = null, unavailableDraft: CalendarActionError | null = null
        try { draft = prepareCancellationEmail(state, runtime.snapshot, externalId, now()) }
        catch (error) { if (!(error instanceof CalendarActionError)) throw error; unavailableDraft = error }
        if (!draft && !previous) throw unavailableDraft!
        const conflict = previous && previous.record.id !== draft?.bookingSha256 ? previous : null
        return { preview: draft ? { externalId: draft.externalId, bookingSha256: draft.bookingSha256, recipient: draft.recipient,
          subject: draft.subject, body: draft.body } : null, ready: !!draft && ready() && !conflict,
          reason: conflict ? priorMessage : ready() ? null : unavailable(),
          confirmation: previous && !conflict ? summary(previous.record, previous.action) : null,
          priorConfirmation: conflict ? { ...summary(conflict.record, conflict.action), recipient: (conflict.action.input.message as unknown as EmailMessage).to } : null }
      })
    },
    async queue(input: unknown) {
      staff()
      const v = input as Record<string, unknown> | null
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'action,bookingSha256,externalId,permissionConfirmed'
        || v.action !== 'queue' || !digest(v.bookingSha256) || v.permissionConfirmed !== true) return fail('cancellation_email_input_invalid', 'Review this email and confirm the prospect’s permission.', 400)
      if (!ready()) return fail('cancellation_email_not_configured', unavailable(), 503)
      return workflows.transaction(async unit => {
        const draft = prepareCancellationEmail(await unit.readCalendar(), runtime.snapshot, v.externalId, now())
        if (draft.bookingSha256 !== v.bookingSha256 || !draft.message) return fail('cancellation_email_changed', 'The cancellation or email details changed. Review them again.')
        const previous = await existing(unit, draft.source)
        if (previous) {
          if (previous.record.id !== draft.bookingSha256) return fail('cancellation_email_prior_exists', priorMessage)
          return summary(previous.record, previous.action)
        }
        const recordedAt = now().toISOString(), messageSha256 = emailMessageDigest(draft.message)
        const accepted = await unit.workflows.accept({ source: 'staff_tour_cancellation', eventId: purposeId(draft.source),
          payload: { permission: 'staff_attested_explicit_email_permission', cancellationSha256: draft.bookingSha256 },
          actions: [emailWorkflowAction(draft.message, { purpose: 'tour_cancellation', recipient: draft.recipient,
            contentSha256: messageSha256, recordedAt, expiresAt: new Date(Date.parse(recordedAt) + 3600000).toISOString(),
            receiptId: 'cancel-' + draft.bookingSha256 }, 'cancel-' + purposeId(draft.source))] })
        const record: CancellationEmailRecord = { format: 'tour-cancellation-email-v1', id: draft.bookingSha256,
          purposeId: purposeId(draft.source), externalId: draft.externalId, actionId: accepted.actions[0]!.id,
          actorId: runtime.scope.actor.kind === 'user' ? runtime.scope.actor.userId : '', recordedAt, messageSha256 }
        await unit.documents.set(recordKey(record.id), record)
        await unit.documents.set(indexKey(draft.source), { format: 'tour-cancellation-email-index-v1', purposeId: record.purposeId, id: record.id })
        return summary(record, accepted.actions[0]!)
      })
    },
    async process(id: unknown) {
      staff()
      if (!digest(id)) return fail('cancellation_email_input_invalid', 'Choose a saved cancellation email.', 400)
      if (!ready()) return fail('cancellation_email_not_configured', unavailable(), 503)
      const raw = await runtime.documents.get(recordKey(id))
      if (!raw) return fail('cancellation_email_missing', 'This email is not available in this property.', 404)
      const record = checkedRecord(raw, id)
      checkedAction(runtime, record, await workflows.get(record.actionId))
      const sender = binding(runtime.snapshot, now())!
      const connector = createResendEmailConnector({ organizationId: runtime.scope.organizationId, propertyId: runtime.scope.propertyId,
        from: sender.from, replyTo: sender.replyTo, transport: provider.transport(), now })
      const dispatch = connector.dispatch
      connector.dispatch = async (action, signal) => {
        try {
          checkedAction(runtime, record, action)
          const current = prepareCancellationEmail(await runtime.calendarStore.read(), runtime.snapshot, record.externalId, now())
          if (current.bookingSha256 !== record.id || purposeId(current.source) !== record.purposeId) return { status: 'rejected', code: 'cancellation_changed_before_send', retryable: false }
          await runtime.revalidate()
        } catch { return { status: 'rejected', code: 'cancellation_not_verified_before_send', retryable: false } }
        return dispatch(action, signal)
      }
      await runWorkflowOnce({ repository: workflows, actionId: record.actionId, workerId: 'staff-cancellation-email',
        connectors: new Map([[connector.id, connector]]), now, timeoutMs: 6000, leaseMs: 20000, baseBackoffMs: 1000, maxBackoffMs: 60000 })
      return summary(record, checkedAction(runtime, record, await workflows.get(record.actionId)))
    },
  }
}
