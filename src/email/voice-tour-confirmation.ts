import { randomUUID } from 'node:crypto'
import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import { reviveStoredCall, type CallState } from '../calls/completion.ts'
import type { CalendarState } from '../calendar/types.ts'
import { findBooking } from '../calendar/reschedule.ts'
import { heldEmergency } from '../calendar/safety.ts'
import { CalendarActionError } from '../calendar/unit-blocks.ts'
import { PostgresWorkflowRepository } from '../database/workflows.ts'
import type { PropertySnapshot } from '../properties/model.ts'
import type { WorkflowAction } from '../workflows/model.ts'
import { hashJson } from '../workflows/validation.ts'
import { runWorkflowOnce } from '../workflows/worker.ts'
import { ResendTransport } from './render.ts'
import { createResendEmailConnector, emailMessageDigest, emailWorkflowAction } from './workflow.ts'
import { spokenEmail, voiceEmailHistory, voiceEmailPermission, VoiceEmailError } from './voice-shortlist.ts'
import { prepareTourConfirmation, tourEmailBinding, tourConfirmationKey,
  validateTourConfirmationRecord, validateTourConfirmationAction, type TourConfirmationRecord } from './tour-confirmation.ts'

const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const fail = (message: string): never => { throw new VoiceEmailError(message) }
type Draft = ReturnType<typeof prepareTourConfirmation>
interface Offer {
  format: 'voice-tour-email-v1'; id: string; callId: string; bindingId: string; configurationVersion: number
  externalId: string; bookingSha256: string; messageSha256: string; question: string
  preparedAt: string; expiresAt: string; historyLength: number; historySha256: string
}
export function voiceTourEmailEnabled(snapshot: PropertySnapshot, now: Date): boolean {
  const raw = snapshot.property.voiceTourConfirmation
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isFinite(now.getTime())) return false
  const v = raw as Record<string, unknown>
  return Object.keys(v).sort().join(',') === 'enabled,organizationId,propertyId,reviewExpiresAt'
    && v.enabled === true && v.organizationId === snapshot.organizationId && v.propertyId === snapshot.propertyId
    && typeof v.reviewExpiresAt === 'string' && Date.parse(v.reviewExpiresAt) > now.getTime()
    && Date.parse(v.reviewExpiresAt) - now.getTime() <= 30 * 86400000
}
const result = (offer: Offer, action: WorkflowAction) => ({ offerId: offer.id,
  status: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered' ? 'delivered'
    : ['needs_review','cancelled','succeeded'].includes(action.state) ? 'needs_review'
      : action.providerReference ? 'accepted' : action.dispatchStarted ? 'unconfirmed' : 'queued',
  say: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered'
    ? 'The email provider reports delivery of the tour confirmation. This does not mean it was read.'
    : ['needs_review','cancelled','succeeded'].includes(action.state) ? 'This confirmation needs staff review. Delivery is not confirmed. Do not create a replacement.'
      : action.providerReference ? 'The email provider accepted the tour confirmation. Delivery is not confirmed yet.'
        : action.dispatchStarted ? 'The confirmation request is saved, but delivery is unconfirmed. Do not send it again.'
          : 'The confirmation is saved in the delivery queue and has not been sent. Staff can process this same saved request.' })

export function createVoiceTourConfirmationService(runtime: ResolvedPropertyRuntime, workflows: PostgresWorkflowRepository,
  provider: { configured: boolean; transport: () => ResendTransport }, now: () => Date = () => new Date()) {
  const scope = runtime.scope
  const ready = () => provider.configured && voiceTourEmailEnabled(runtime.snapshot, now()) && !!tourEmailBinding(runtime.snapshot, now())
  const actor = () => {
    if (!ready()) return fail('Tour confirmation email is not configured for this property. Nothing new was sent. Offer staff follow-up.')
    if (scope.actor.kind !== 'channel' || scope.actor.provider !== 'vapi') return fail('A verified voice connection is required. Nothing new was sent.')
    return scope.actor
  }
  const key = (callId: string) => 'voice-tour-email:' + hashJson(callId)
  const question = (draft: Draft) => `May I email the confirmation for your ${draft.when} tour to ${spokenEmail(draft.recipient)}?`
  function currentDraft(calendar: CalendarState, raw: CallState | null, callId: string): Draft {
    const channel = actor()
    if (!raw) return fail('The call record is unavailable. Nothing new was sent.')
    const call = reviveStoredCall(raw)
    if (call.completedAt || call.work?.phase !== 'open' || call.emergency || call.tourChangeRequested
      || heldEmergency(calendar, callId) || call.routing?.channelBindingId !== channel.bindingId
      || call.routing.organizationId !== scope.organizationId || call.routing.propertyId !== scope.propertyId
      || call.booking?.status !== 'confirmed' || !call.booking.externalId) {
      return fail('A current confirmed tour from this call is required. An uncertain or changed tour cannot receive a confirmation.')
    }
    const booking = findBooking(calendar, call.booking.externalId)
    if (booking.interactionId !== callId || booking.startsAt !== call.booking.startsAt || booking.unitId !== call.booking.unitId
      || !call.email || call.email !== booking.prospectEmail) {
      return fail('The saved tour and caller details need staff review before sending a confirmation. Nothing new was sent.')
    }
    return prepareTourConfirmation(calendar, runtime.snapshot, booking.externalId, now())
  }
  function saved(value: unknown, callId: string, offerId: unknown): Offer {
    const v = value as Offer | null
    if (!v || v.format !== 'voice-tour-email-v1' || !id(v.id) || v.id !== offerId || v.callId !== callId
      || v.bindingId !== actor().bindingId || v.configurationVersion !== runtime.snapshot.version
      || typeof v.externalId !== 'string' || !digest(v.bookingSha256) || !digest(v.messageSha256)
      || typeof v.question !== 'string' || v.question.length > 1500
      || !Number.isFinite(Date.parse(v.preparedAt)) || !Number.isFinite(Date.parse(v.expiresAt))
      || Date.parse(v.expiresAt) - Date.parse(v.preparedAt) !== 300000
      || !Number.isSafeInteger(v.historyLength) || v.historyLength < 0 || v.historyLength > 1000 || !digest(v.historySha256)) {
      return fail('This confirmation offer is unavailable for this call. Nothing new was sent.')
    }
    return v
  }
  const actionFor = (record: TourConfirmationRecord, action: WorkflowAction | null) => validateTourConfirmationAction(runtime, record, action)
  async function process(offer: Offer, record: TourConfirmationRecord, dispatch: boolean) {
    const existing = actionFor(record, await workflows.get(record.actionId))
    if (!dispatch && !existing.dispatchStarted) return result(offer, existing)
    const binding = tourEmailBinding(runtime.snapshot, now())!
    const connector = createResendEmailConnector({ organizationId: scope.organizationId, propertyId: scope.propertyId,
      from: binding.from, replyTo: binding.replyTo, transport: provider.transport(), now })
    const send = connector.dispatch
    connector.dispatch = async (action, signal) => {
      try {
        actor(); actionFor(record, action)
        const draft = currentDraft(await runtime.calendarStore.read(), await runtime.documents.get<CallState>('call:' + offer.callId), offer.callId)
        if (draft.bookingSha256 !== offer.bookingSha256 || !draft.message || emailMessageDigest(draft.message) !== offer.messageSha256) {
          return { status: 'rejected', code: 'voice_tour_changed_before_send', retryable: false }
        }
      } catch { return { status: 'rejected', code: 'voice_tour_not_verified_before_send', retryable: false } }
      return send(action, signal)
    }
    await runWorkflowOnce({ repository: workflows, actionId: record.actionId, workerId: 'voice-tour-email', verifyOnly: !dispatch,
      connectors: new Map([[connector.id,connector]]), timeoutMs: 3000, leaseMs: 15000, baseBackoffMs: 1000, now })
    return result(offer, actionFor(record, await workflows.get(record.actionId)))
  }
  return { ready,
    async command(input: unknown, callId: string, artifactMessages: unknown, admission: { toolId: string; token: string }) {
      actor()
      const v = input as Record<string, unknown> | null
      if (!id(callId) || !v || typeof v !== 'object' || Array.isArray(v) || !['prepare','send','status'].includes(String(v.action))
        || Object.keys(v).sort().join(',') !== (v.action === 'prepare' ? 'action' : 'action,offerId')
        || (v.action !== 'prepare' && !id(v.offerId))) return fail('Use the prepared tour confirmation offer. Nothing new was sent.')
      try {
        const admitted = await workflows.transaction(async unit => {
          const calendar = await unit.readCalendar()
          const current = await unit.documents.update<CallState | null>('call:' + callId, null, raw => {
            const intent = raw?.work?.intents.find(i => i.id === admission.toolId)
            if (intent?.name !== 'email_tour_confirmation' || intent.token !== admission.token || intent.status !== 'admitted') {
              return fail('This call cannot authorize a new confirmation action. Nothing new was sent.')
            }
            return raw
          })
          const draft = currentDraft(calendar, current, callId)
          if (!draft.message) return fail('Tour confirmation email is not configured. Nothing new was sent.')
          const history = v.action === 'prepare' || v.action === 'send' ? voiceEmailHistory(artifactMessages) : []
          let offer: Offer
          if (v.action === 'prepare') {
            const stamp = now()
            offer = { format: 'voice-tour-email-v1', id: randomUUID(), callId, bindingId: actor().bindingId,
              configurationVersion: runtime.snapshot.version, externalId: draft.externalId, bookingSha256: draft.bookingSha256,
              messageSha256: emailMessageDigest(draft.message), question: question(draft),
              preparedAt: stamp.toISOString(), expiresAt: new Date(stamp.getTime() + 300000).toISOString(),
              historyLength: history.length, historySha256: hashJson(history) }
            await unit.documents.set(key(callId), offer)
          } else {
            offer = saved(await unit.documents.get<Offer>(key(callId)), callId, v.offerId)
            if (offer.bookingSha256 !== draft.bookingSha256 || offer.externalId !== draft.externalId
              || offer.messageSha256 !== emailMessageDigest(draft.message) || offer.question !== question(draft)) {
              return fail('The tour or email details changed. Prepare the new details and ask permission again.')
            }
          }
          // Same property lock and record as staff admission: voice and staff race
          // to inspect/create one confirmation, never two separate provider actions.
          const prior = await unit.documents.get<TourConfirmationRecord>(tourConfirmationKey(draft.bookingSha256))
          if (prior) {
            const record = validateTourConfirmationRecord(prior, draft.bookingSha256)
            actionFor(record, await unit.workflows.get(record.actionId))
            return { offer, record, dispatch: false }
          }
          if (v.action === 'prepare') return { offer, record: null, dispatch: false }
          if (v.action === 'status') return fail('No confirmation email has been saved for this offer.')
          if (Date.parse(offer.expiresAt) <= now().getTime() || Date.parse(offer.preparedAt) > now().getTime()) {
            return fail('The confirmation offer expired. Prepare it again and ask permission again.')
          }
          const permissionSha256 = voiceEmailPermission(history, offer), recordedAt = now().toISOString()
          const accepted = await unit.workflows.accept({ source: 'voice_tour_confirmation', eventId: draft.bookingSha256,
            payload: { callId, offerId: offer.id, permissionSha256, evidenceSource: 'authenticated_vapi_artifact_question_reply' },
            actions: [emailWorkflowAction(draft.message, { purpose: 'tour_confirmation', recipient: draft.recipient,
              contentSha256: offer.messageSha256, receiptId: 'tour-' + draft.bookingSha256, recordedAt,
              expiresAt: offer.expiresAt }, 'tour-' + draft.bookingSha256)] })
          const record: TourConfirmationRecord = { format: 'tour-confirmation-v1', id: draft.bookingSha256,
            externalId: draft.externalId, bookingSha256: draft.bookingSha256, actionId: accepted.actions[0]!.id,
            actorId: actor().bindingId, actorKind: 'channel', recordedAt, messageSha256: offer.messageSha256 }
          await unit.documents.set(tourConfirmationKey(record.id), record)
          return { offer, record, dispatch: true }
        })
        if (!admitted.record) return { status: 'permission_required', offerId: admitted.offer.id, question: admitted.offer.question,
          say: 'Nothing has been sent. Ask this exact question alone, then wait for clear agreement. Do not read the offer ID aloud.' }
        return process(admitted.offer, admitted.record, admitted.dispatch)
      } catch (error) {
        if (error instanceof CalendarActionError) return fail(error.message)
        throw error
      }
    },
  }
}
