import { randomUUID } from 'node:crypto'
import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { CallState } from '../calls/completion.ts'
import { reviveStoredCall } from '../calls/completion.ts'
import { heldEmergency } from '../calendar/safety.ts'
import { PostgresWorkflowRepository } from '../database/workflows.ts'
import { inventoryIsQuotable, inventoryDemoDisclosure } from '../inventory/source.ts'
import { publicShortlistLink } from '../properties/public-website.ts'
import { hashJson } from '../workflows/validation.ts'
import { runWorkflowOnce } from '../workflows/worker.ts'
import type { WorkflowAction } from '../workflows/model.ts'
import { ResendTransport, validEmailAddress, validEmailMessage } from './render.ts'
import type { EmailMessage } from './render.ts'
import { propertyEmailBinding } from './sender.ts'
import { emailWorkflowAction, emailMessageDigest, createResendEmailConnector } from './workflow.ts'

export interface VoiceShortlist { unitIds: string[]; preparedAt: string; configurationVersion: number }
type Spoken = { role: 'bot' | 'user'; message: string }
interface Offer {
  format: 'voice-shortlist-email-v1'; id: string; callId: string; bindingId: string; configurationVersion: number
  preparedAt: string; expiresAt: string; shortlist: VoiceShortlist; message: EmailMessage; question: string
  historyLength: number; historySha256: string; actionId: string | null; permissionSha256: string | null
}
export class VoiceEmailError extends Error {}
const fail = (message: string): never => { throw new VoiceEmailError(message) }
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(s)
const escape = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
const normalize = (s: string) => s.toLowerCase().replace(/[.,!?;:]/g,' ').replace(/\s+/g,' ').trim()
export const spokenEmail = (s: string) => s.replace(/@/g,' at ').replace(/\./g,' dot ').replace(/_/g,' underscore ').replace(/-/g,' dash ').replace(/\+/g,' plus ')

/** Only provider artifact.messages from an authenticated webhook belongs here.
 * This is evidence of a spoken request, never identity/email-ownership verification. */
export function voiceEmailHistory(value: unknown): Spoken[] {
  if (!Array.isArray(value) || value.length > 1000) return fail('The conversation record is unavailable. Nothing new was sent.')
  const result: Spoken[] = []
  let size = 0
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('The conversation record needs review. Nothing new was sent.')
    if (!['bot','assistant','user'].includes(row.role)) continue
    if (typeof row.message !== 'string' || !row.message.trim() || row.isFiltered === true
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.message)) return fail('The conversation record needs review. Nothing new was sent.')
    size += Buffer.byteLength(row.message)
    if (size > 65536) return fail('The conversation record is too long to verify permission. Nothing new was sent.')
    result.push({ role: row.role === 'user' ? 'user' : 'bot', message: row.message })
  }
  return result
}

export function voiceEmailPermission(history: Spoken[], offer: Pick<Offer,'question'|'historyLength'|'historySha256'>): string {
  if (history.length < offer.historyLength + 2 || hashJson(history.slice(0,offer.historyLength)) !== offer.historySha256) {
    return fail('I could not verify new permission for this email. Nothing new was sent. Ask the permission question once more.')
  }
  const question = history.at(-2)!, reply = history.at(-1)!
  if (question.role !== 'bot' || normalize(question.message) !== normalize(offer.question) || reply.role !== 'user'
    || reply.message.includes('?')
    || !/^(yes|yes please|yes send it|yes please send it|yes you may|sure|sure please|please do|go ahead)$/.test(normalize(reply.message))) {
    return fail('Permission was not clearly confirmed for this email. Nothing new was sent. Do not treat silence, a correction or a refusal as agreement.')
  }
  return hashJson({ question, reply, historySha256: hashJson(history) })
}

const result = (offer: Offer, action: WorkflowAction) => ({ offerId: offer.id,
  status: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered' ? 'delivered'
    : action.state === 'needs_review' || action.state === 'cancelled' || action.state === 'succeeded' ? 'needs_review'
      : action.providerReference ? 'accepted' : action.dispatchStarted ? 'unconfirmed' : 'queued',
  say: action.state === 'succeeded' && action.evidence?.deliveryStatus === 'delivered' ? 'The email provider reports that the apartment link was delivered. This does not mean it was read.'
    : action.state === 'needs_review' || action.state === 'cancelled' || action.state === 'succeeded' ? 'This email needs staff review. Delivery is not confirmed. Do not submit a replacement.'
      : action.providerReference ? 'The email provider accepted the apartment link. Delivery is not confirmed yet.'
        : action.dispatchStarted ? 'The email request is saved, but delivery is not confirmed. Do not send it again.'
          : 'The apartment email is saved in the delivery queue. It has not been sent yet.' })

export function createVoiceShortlistEmailService(runtime: ResolvedPropertyRuntime, workflows: PostgresWorkflowRepository,
  provider: { configured: boolean; transport: () => ResendTransport }, now: () => Date = () => new Date()) {
  const scope = runtime.scope
  const binding = () => propertyEmailBinding(runtime.snapshot, now(), 'voiceShortlistEmail')
  const ready = () => provider.configured && !!binding() && !!runtime.snapshot.publicShortlistWebsite
  const requireReady = () => {
    if (!ready()) return fail('Apartment email is not configured for this property. Nothing new was sent. Offer to save contact details for staff.')
    if (scope.actor.kind !== 'channel' || scope.actor.provider !== 'vapi') return fail('A verified voice connection is required. Nothing new was sent.')
    return scope.actor
  }
  const key = (callId: string) => 'voice-shortlist-email:' + hashJson(callId)
  function message(shortlist: VoiceShortlist, recipient: string): EmailMessage {
    const stamp = now().getTime(), prepared = Date.parse(shortlist.preparedAt)
    if (!Number.isFinite(stamp) || !Number.isFinite(prepared) || prepared > stamp || stamp - prepared >= 300000
      || shortlist.configurationVersion !== runtime.snapshot.version || !Array.isArray(shortlist.unitIds)
      || !inventoryIsQuotable(runtime.snapshot.inventory, now())
      || shortlist.unitIds.some(id => !runtime.snapshot.inventory.units.some(unit => unit.unitId === id && unit.status === 'available'))) {
      return fail('The apartment shortlist changed or expired. Check availability again before offering an email.')
    }
    const url = publicShortlistLink(runtime.snapshot.publicShortlistWebsite, { organizationId: scope.organizationId,
      propertyId: scope.propertyId, inventorySource: runtime.snapshot.inventory.source }, shortlist.unitIds, now())
    const sender = binding()
    if (!url || !sender || !validEmailAddress(recipient)) return fail('The email address or property link needs review. Nothing new was sent.')
    const building = runtime.snapshot.property.buildingName
    if (typeof building !== 'string' || !building.trim() || building.length > 100) return fail('The property details need review. Nothing new was sent.')
    const value = { to: recipient, from: sender.from, replyTo: sender.replyTo, subject: `Your apartment shortlist at ${building}`,
      html: `<p>Here is the apartment shortlist you requested from ${escape(building)}.</p><p>Residences: ${shortlist.unitIds.map(escape).join(', ')}.</p><p><a href="${escape(url)}">View your apartment shortlist</a></p><p>Availability and pricing can change. These options may include alternatives discussed during your call. This link is not a reservation.</p>${inventoryDemoDisclosure(runtime.snapshot.inventory, now()) ? '<p>This is a fictional demo property. Apartment details are sample data, not live availability.</p>' : ''}` }
    if (!validEmailMessage(value)) return fail('The apartment email needs review. Nothing new was sent.')
    return value
  }
  function saved(value: unknown, callId: string, offerId?: unknown): Offer {
    const actor = requireReady(), v = value as Offer | null
    if (!v || v.format !== 'voice-shortlist-email-v1' || v.callId !== callId || !identifier(v.id)
      || v.bindingId !== actor.bindingId || v.configurationVersion !== runtime.snapshot.version
      || (offerId !== undefined && v.id !== offerId) || !validEmailMessage(v.message)
      || !Number.isFinite(Date.parse(v.preparedAt)) || !Number.isFinite(Date.parse(v.expiresAt))
      || Date.parse(v.expiresAt) - Date.parse(v.preparedAt) !== 300000
      || !Number.isSafeInteger(v.historyLength) || v.historyLength < 0 || v.historyLength > 1000
      || !/^[a-f0-9]{64}$/.test(v.historySha256) || v.question !== `May I email this apartment shortlist to ${spokenEmail(v.message.to)}?`
      || (v.actionId !== null && !identifier(v.actionId)) || (v.permissionSha256 !== null && !/^[a-f0-9]{64}$/.test(v.permissionSha256))
      || (v.actionId === null) !== (v.permissionSha256 === null)) return fail('This email request is unavailable for this call. Nothing new was sent.')
    return v
  }
  function actionFor(offer: Offer, action: WorkflowAction | null): WorkflowAction {
    if (!action || !offer.permissionSha256 || action.id !== offer.actionId || action.organizationId !== scope.organizationId
      || action.propertyId !== scope.propertyId || action.origin.kind !== 'channel' || action.origin.bindingId !== offer.bindingId
      || action.kind !== 'leasing_email' || action.connector !== 'resend_email_v1'
      || action.inputSha256 !== hashJson(action.input) || hashJson(action.input.message) !== hashJson(offer.message)
      || (action.input.consent as Record<string,unknown>)?.receiptId !== 'voice-' + offer.id) return fail('This email needs staff review. Do not submit a replacement.')
    return action
  }
  async function process(offer: Offer, verifyOnly: boolean) {
    const existing = actionFor(offer, await workflows.get(offer.actionId!))
    if (verifyOnly && !existing.dispatchStarted) return result(offer, existing)
    const sender = binding()!
    const connector = createResendEmailConnector({ organizationId: scope.organizationId, propertyId: scope.propertyId,
      from: sender.from, replyTo: sender.replyTo, transport: provider.transport(), now })
    const dispatch = connector.dispatch
    connector.dispatch = async (action, signal) => {
      try {
        actionFor(offer, action)
        const call = await runtime.documents.get<CallState>('call:' + offer.callId)
        if (!call || call.completedAt || call.work?.phase !== 'open' || call.emergency || call.tourChangeRequested
          || call.email !== offer.message.to || !call.emailShortlist || hashJson(call.emailShortlist) !== hashJson(offer.shortlist)) {
          return { status: 'rejected', code: 'voice_email_call_changed', retryable: false }
        }
        if (heldEmergency(await runtime.calendarStore.read(), offer.callId)
          || hashJson(message(offer.shortlist, offer.message.to)) !== hashJson(offer.message)) {
          return { status: 'rejected', code: 'voice_email_context_changed', retryable: false }
        }
      } catch { return { status: 'rejected', code: 'voice_email_context_unverified', retryable: false } }
      return dispatch(action, signal)
    }
    await runWorkflowOnce({ repository: workflows, actionId: offer.actionId!, workerId: 'voice-shortlist-email',
      connectors: new Map([[connector.id,connector]]), timeoutMs: 3000, leaseMs: 15000, baseBackoffMs: 1000, now })
    return result(offer, actionFor(offer, await workflows.get(offer.actionId!)))
  }
  return { ready,
    async command(input: unknown, callId: string, artifactMessages: unknown, admission: { toolId: string; token: string }) {
      requireReady()
      const v = input as Record<string, unknown> | null
      if (!identifier(callId) || !v || typeof v !== 'object' || Array.isArray(v)
        || !['prepare','send','status'].includes(String(v.action))
        || Object.keys(v).sort().join(',') !== (v.action === 'prepare' ? 'action' : 'action,offerId')
        || (v.action !== 'prepare' && !identifier(v.offerId))) return fail('Use the prepared apartment email request. Nothing new was sent.')
      const admitted = await workflows.transaction(async unit => {
        // One property lock serializes record/receipt admission and checks safety together.
        const calendar = await unit.readCalendar()
        if (heldEmergency(calendar, callId)) return fail('Leasing follow-up is paused for this call. Nothing new was sent.')
        const current = await unit.documents.update<CallState | null>('call:' + callId, null, raw => {
          if (!raw) return fail('The call record is unavailable. Nothing new was sent.')
          const state = reviveStoredCall(raw), actor = requireReady(), intent = state.work?.intents.find(i => i.id === admission.toolId)
          if (state.completedAt || state.work?.phase !== 'open' || state.emergency || state.tourChangeRequested
            || state.routing?.channelBindingId !== actor.bindingId || state.routing.organizationId !== scope.organizationId
            || state.routing.propertyId !== scope.propertyId || intent?.name !== 'email_shortlist' || intent.token !== admission.token
            || intent.status !== 'admitted') return fail('This call cannot authorize a new email action. Nothing new was sent.')
          return state
        })
        const prior = await unit.documents.get<Offer>(key(callId))
        if (prior) saved(prior, callId)
        if (prior?.actionId) {
          const offer = saved(prior, callId, v.offerId)
          actionFor(offer, await unit.workflows.get(offer.actionId!))
          return { offer, prepared: false }
        }
        if (v.action === 'status') return fail('No apartment email has been accepted for this call.')
        const history = voiceEmailHistory(artifactMessages)
        if (!current?.emailShortlist || !current.email) return fail('Check availability and save the caller’s email before preparing the apartment email.')
        const rendered = message(current.emailShortlist, current.email)
        if (v.action === 'prepare') {
          // A fresh preparation replaces an unaccepted offer, even for the same
          // units/address: it needs a new question/reply after this history boundary.
          const preparedAt = now()
          const offer: Offer = { format: 'voice-shortlist-email-v1', id: randomUUID(), callId, bindingId: requireReady().bindingId,
            configurationVersion: runtime.snapshot.version, preparedAt: preparedAt.toISOString(), expiresAt: new Date(preparedAt.getTime() + 300000).toISOString(),
            shortlist: structuredClone(current.emailShortlist), message: rendered,
            question: `May I email this apartment shortlist to ${spokenEmail(rendered.to)}?`,
            historyLength: history.length, historySha256: hashJson(history), actionId: null, permissionSha256: null }
          await unit.documents.set(key(callId), offer)
          return { offer, prepared: true }
        }
        const offer = saved(prior,callId,v.offerId)
        if (Date.parse(offer.expiresAt) <= now().getTime() || hashJson(rendered) !== hashJson(offer.message)
          || hashJson(current.emailShortlist) !== hashJson(offer.shortlist)) return fail('The email details changed or expired. Prepare them again and ask permission again.')
        const permissionSha256 = voiceEmailPermission(history, offer), recordedAt = now().toISOString()
        const accepted = await unit.workflows.accept({ source: 'voice_shortlist_email', eventId: offer.id,
          payload: { callId, offerId: offer.id, permissionSha256, evidenceSource: 'authenticated_vapi_artifact_question_reply' },
          actions: [emailWorkflowAction(offer.message, { purpose: 'leasing_shortlist', recipient: offer.message.to,
            contentSha256: emailMessageDigest(offer.message), receiptId: 'voice-' + offer.id, recordedAt,
            expiresAt: offer.expiresAt }, 'voice-' + offer.id)] })
        const updated = { ...offer, actionId: accepted.actions[0]!.id, permissionSha256 }
        await unit.documents.set(key(callId), updated)
        return { offer: updated, prepared: false }
      })
      if (admitted.prepared) return { status: 'permission_required', offerId: admitted.offer.id,
        question: admitted.offer.question, say: 'Nothing has been sent. Ask the exact question, then wait for the caller’s clear agreement. Do not read the offer ID aloud.' }
      if (v.action === 'prepare') return result(admitted.offer, actionFor(admitted.offer, await workflows.get(admitted.offer.actionId!)))
      return process(admitted.offer, v.action === 'status')
    },
  }
}
