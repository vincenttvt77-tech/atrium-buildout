import { timingSafeEqual } from 'node:crypto'
import type { DatabaseRuntime, ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { PostgresWorkflowRepository } from '../database/workflows.ts'
import type { JsonObject, WorkflowAction, WorkflowConnector } from '../workflows/model.ts'
import { hashJson } from '../workflows/validation.ts'
import { runWorkflowOnce } from '../workflows/worker.ts'
import { CALLBACK_CHANNEL, CallbackError, callbackBinding, callbackOpen, callbackDeadline, callbackPolicy, callbackGreeting, digest, uuid } from './config.ts'
import type { CallbackBinding } from './config.ts'
import { CallbackTransport } from './transport.ts'

const fail = (code: string, message: string, status = 409): never => { throw new CallbackError(code, message, status) }
export interface CallbackRequest {
  requestId: string; receiptToken: string; name: string; phone: string; consent: true; policySha256: string
}
export function callbackRequest(v: any): CallbackRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'consent,name,phone,policySha256,receiptToken,requestId'
    || !uuid(v.requestId) || !digest(v.receiptToken) || !digest(v.policySha256) || v.consent !== true
    || typeof v.name !== 'string' || v.name !== v.name.trim() || !/^[\p{L}\p{M} .'-]{1,80}$/u.test(v.name)
    || typeof v.phone !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(v.phone)) {
    return fail('callback_invalid_input', 'Enter your name, a valid +1 phone number and permission for this call.', 400)
  }
  return v
}
interface CallbackRecord { format: 'website-callback-v1'; id: string; actionId: string; tokenHash: string; commandHash: string }
interface Observation { status: string; observedAt: string }
interface Admission { at: number; phone: string; network: string }
const key = (id: string) => 'website-callback:' + id
const observationKey = (id: string) => 'callback-observation:' + id
const callbackInput = (action: WorkflowAction) => action.input as unknown as {
  requestId: string; name: string; phone: string; origin: string; binding: CallbackBinding; consent: string
  policySha256: string; requestedAt: string; expiresAt: string; firstMessage: string
}
export function callbackObservation(call: any, action: WorkflowAction): Observation | null {
  const input = callbackInput(action), b = input.binding
  if (!call || call.id !== action.providerReference || !uuid(call.id) || call.orgId !== b.providerOrgId
    || call.type !== 'outboundPhoneCall' || call.name !== 'ac-' + action.id || call.assistantId !== b.assistantId
    || call.assistantVersion !== b.assistantVersion || call.phoneNumberId !== b.phoneNumberId
    || call.customer?.number !== input.phone || call.customer?.name !== input.name
    || call.assistantOverrides?.firstMessage !== input.firstMessage || call.assistantOverrides?.firstMessageMode !== 'assistant-speaks-first'
    || call.assistantOverrides?.maxDurationSeconds !== 300
    || !['scheduled','queued','ringing','in-progress','forwarding','ended'].includes(call.status)
    || call.schedulePlan?.latestAt !== input.expiresAt || !Number.isFinite(Date.parse(call.schedulePlan?.earliestAt))
    || Date.parse(call.schedulePlan.earliestAt) < Date.parse(input.requestedAt) || Date.parse(call.schedulePlan.earliestAt) >= Date.parse(input.expiresAt)
    || !Number.isFinite(Date.parse(call.createdAt)) || Date.parse(call.createdAt) < Date.parse(input.requestedAt) - 5000
    || Date.parse(call.createdAt) > Date.parse(input.expiresAt) + 60000) return null
  return { status: call.status, observedAt: new Date().toISOString() }
}
export function callbackSummary(action: WorkflowAction, observation?: Observation | null) {
  let stage = 'saved'
  if (action.state === 'cancelled') stage = 'cancelled'
  else if (action.state === 'needs_review') stage = 'needs_review'
  else if (action.state === 'succeeded') stage = observation?.status ?? String(action.evidence?.callStatus ?? 'requested')
  else if (action.dispatchStarted) stage = 'checking'
  const messages: Record<string, string> = {
    saved: 'Your request is saved. A call has not been confirmed yet.',
    checking: 'We are checking whether your call started. Do not submit another request.',
    requested: 'The calling service accepted your request. A connection has not been confirmed.',
    scheduled: 'The calling service has scheduled your requested call within its short callback window.',
    forwarding: 'The calling service reports that the call is being routed. This does not confirm that a person has answered.',
    queued: 'The calling service has queued your call. Your phone may ring shortly.',
    ringing: 'The calling service reports that your phone is ringing.',
    'in-progress': 'The calling service reports a call in progress. This does not confirm a tour booking.',
    ended: 'The calling service reports that this call ended. Check any tour details with the assistant or leasing team.',
    needs_review: 'This request needs staff review. A call may have started; please do not request another.',
    cancelled: 'This request was cancelled before a call was started.',
  }
  return { stage, message: messages[stage] ?? messages.checking!, observedAt: observation?.observedAt ?? action.updatedAt,
    requestedAt: callbackInput(action).requestedAt, automaticRetry: false }
}
/** Resolve the server-published assistant separately through the existing authenticator.
 * A public website channel never gains general visibility of other channel rows. */
export async function validateCallbackRoute(runtime: DatabaseRuntime, property: ResolvedPropertyRuntime, binding: CallbackBinding) {
  const voice = await runtime.loadChannel('vapi', binding.assistantId, property.requestId)
  if (voice.scope.organizationId !== property.scope.organizationId || voice.scope.propertyId !== property.scope.propertyId
    || voice.snapshot.version !== property.snapshot.version) return fail('callback_unavailable', 'The property voice connection needs review.', 503)
  await voice.revalidate(); await property.revalidate()
}
export function createCallbackService(property: ResolvedPropertyRuntime, repository: PostgresWorkflowRepository,
  provider: { configured: boolean; transport: () => CallbackTransport; validateRoute: (binding: CallbackBinding) => Promise<void> }, now: () => Date = () => new Date()) {
  const binding = () => {
    const b = callbackBinding(property.snapshot, now())
    if (!provider.configured) return fail('callback_unavailable', 'Online callbacks are unavailable. Please use the building’s published contact number.', 503)
    return b
  }
  const ready = async () => { const b = binding(); await provider.validateRoute(b); return b }
  const actionValid = (action: WorkflowAction) => {
    const b = binding(), i = callbackInput(action)
    if (action.kind !== 'website_callback' || action.connector !== 'vapi_callback_v1' || hashJson(action.input) !== action.inputSha256
      || action.organizationId !== property.scope.organizationId || action.propertyId !== property.scope.propertyId
      || action.configurationVersion !== property.snapshot.version || action.origin.kind !== 'channel'
      || action.origin.provider !== CALLBACK_CHANNEL || action.origin.externalId !== b.channelId
      || hashJson(i.binding) !== hashJson(b) || i.policySha256 !== callbackPolicy(property.snapshot, b).policySha256
      || !uuid(i.requestId) || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(i.phone) || i.origin !== b.origin
      || i.consent !== callbackPolicy(property.snapshot, b).consent || i.firstMessage !== callbackGreeting(String(property.snapshot.property.buildingName))) {
      return fail('callback_changed', 'This request’s property configuration changed. Staff must review it.')
    }
    return i
  }
  const connector: WorkflowConnector = {
    id: 'vapi_callback_v1', idempotentWrites: false, verificationRequiresReference: true,
    async dispatch(action, signal) {
      try {
        const input = actionValid(action)
        await ready()
        if (Date.parse(input.expiresAt) <= now().getTime() + 5000 || !callbackOpen(input.binding, property.snapshot.timeZone, now())) {
          return { status: 'rejected', code: 'callback_permission_expired_or_closed', retryable: false }
        }
        const call = await provider.transport().create({ name: 'ac-' + action.id, assistantId: input.binding.assistantId,
          assistantVersion: input.binding.assistantVersion, phoneNumberId: input.binding.phoneNumberId,
          schedulePlan: { earliestAt: new Date(now().getTime() + 3000).toISOString(), latestAt: input.expiresAt },
          customer: { number: input.phone, name: input.name }, assistantOverrides: {
            firstMessage: input.firstMessage, firstMessageMode: 'assistant-speaks-first', maxDurationSeconds: 300,
          } }, signal)
        // Even an incomplete acknowledgement must never cause another POST. A valid
        // reference can be read back; all other response shapes remain uncertain.
        return uuid(call?.id) ? { status: 'accepted', providerReference: call.id } : { status: 'unknown', code: 'callback_acknowledgement_missing' }
      } catch { return { status: 'unknown', code: 'callback_submission_uncertain' } }
    },
    async verify(action, signal) {
      try {
        actionValid(action); await ready()
        if (!action.providerReference) return { status: 'unknown', code: 'callback_acknowledgement_missing' }
        const observed = callbackObservation(await provider.transport().read(action.providerReference, signal), action)
        await ready()
        if (!observed) return { status: 'mismatch', code: 'callback_readback_mismatch' }
        return { status: 'matched', operationKey: action.operationKey, inputSha256: action.inputSha256, providerReference: action.providerReference,
          evidence: { initiationVerified: true, callStatus: observed.status, observedAt: observed.observedAt } }
      } catch { return { status: 'unknown', code: 'callback_readback_unavailable' } }
    },
  }
  async function check(actionId: string, expectedRevision?: string) {
    const action = await repository.get(actionId)
    if (!action) return fail('callback_not_found', 'This callback request is unavailable.', 404)
    actionValid(action)
    if (expectedRevision !== undefined && action.revision !== expectedRevision) return fail('callback_changed', 'This request changed. Refresh the work queue.')
    if (action.dispatchStarted && !['succeeded','needs_review','cancelled'].includes(action.state)) {
      await runWorkflowOnce({ repository, connectors: new Map([[connector.id, connector]]), workerId: 'callback-check:' + property.requestId,
        actionId, verifyOnly: true, ...(expectedRevision ? { expectedRevision } : {}), timeoutMs: 2500, leaseMs: 15000, baseBackoffMs: 1000, maxBackoffMs: 60000 })
    }
    let current = (await repository.get(actionId))!, observation = await property.documents.get<Observation>(observationKey(actionId))
    // Later inspection reads the same call; a successful initiation is not a
    // successful leasing conversation. Terminal calls are not fetched repeatedly.
    if (current.state === 'succeeded' && current.providerReference && observation?.status !== 'ended'
      && (!observation || now().getTime() - Date.parse(observation.observedAt) >= 5000)) {
      try {
        actionValid(current); await ready()
        const found = callbackObservation(await provider.transport().read(current.providerReference, AbortSignal.timeout(2500)), current)
        await ready()
        if (found) {
          const next = { ...found, observedAt: now().toISOString() }, ranks: Record<string, number> = { scheduled: 0, queued: 1, ringing: 2, 'in-progress': 3, forwarding: 3, ended: 4 }
          observation = await property.documents.update<Observation>(observationKey(actionId), next, prior =>
            (ranks[prior.status] ?? -1) > (ranks[next.status] ?? -1) || Date.parse(prior.observedAt) > Date.parse(next.observedAt) ? prior : next)
        }
      } catch { /* Retain the dated last verified state, never infer a connection. */ }
    }
    await property.revalidate()
    return { action: current, summary: callbackSummary(current, observation) }
  }
  async function publicRecord(id: unknown, token: unknown) {
    if (!uuid(id) || !digest(token)) return fail('callback_not_found', 'This callback request is unavailable.', 404)
    const record = await property.documents.get<CallbackRecord>(key(id))
    const hash = hashJson(token)
    if (!record || record.format !== 'website-callback-v1' || record.id !== id || !digest(record.tokenHash)
      || !timingSafeEqual(Buffer.from(record.tokenHash), Buffer.from(hash))) return fail('callback_not_found', 'This callback request is unavailable.', 404)
    return record
  }
  return {
    binding, ready, check,
    async status(id: unknown, token: unknown) { const record = await publicRecord(id, token); return (await check(record.actionId)).summary },
    async request(raw: unknown, network: string) {
      const command = callbackRequest(raw), b = await ready(), policy = callbackPolicy(property.snapshot, b)
      if (property.scope.actor.kind !== 'channel' || property.scope.actor.provider !== CALLBACK_CHANNEL || property.scope.actor.externalId !== b.channelId) return fail('callback_forbidden', 'Use the approved website callback form.', 403)
      if (command.policySha256 !== policy.policySha256) return fail('callback_changed', 'The callback form changed. Reload it and review the permission text.')
      if (!callbackOpen(b, property.snapshot.timeZone, now())) return fail('callback_closed', 'Callbacks are closed right now. Please return during the displayed calling hours.')
      const requestedAt = now().toISOString(), expiresAt = callbackDeadline(b, property.snapshot.timeZone, now())
      if (Date.parse(expiresAt) <= now().getTime() + 5000) return fail('callback_closed', 'The callback window is closing. Please use the building’s published contact number.')
      const tokenHash = hashJson(command.receiptToken), commandHash = hashJson(command)
      const record = await repository.transaction(async unit => {
        // One property lock serializes both deduplication and all three admission
        // budgets. Receipt, consent, budget and outbox commit or roll back together.
        const existing = await unit.documents.update<Admission[]>('callback-admissions', [], rows => rows)
        const prior = await unit.documents.get<CallbackRecord>(key(command.requestId))
        if (prior) {
          if (prior.commandHash !== commandHash || prior.tokenHash !== tokenHash) return fail('callback_changed', 'This request cannot be replaced. Check the existing request.')
          return prior
        }
        const time = now().getTime(), rows = existing.filter(row => row.at > time - 86400000)
        const phone = hashJson(command.phone)
        if (rows.length >= b.dailyLimit || rows.some(row => row.phone === phone)
          || rows.filter(row => row.network === network && row.at > time - 3600000).length >= 3) {
          return fail('callback_limited', 'Online callbacks are temporarily limited. Please use the building’s published contact number.', 429)
        }
        const input = { requestId: command.requestId, name: command.name, phone: command.phone, origin: b.origin, binding: b,
          policySha256: policy.policySha256, consent: policy.consent, requestedAt,
          expiresAt, firstMessage: callbackGreeting(String(property.snapshot.property.buildingName)) }
        const accepted = await unit.workflows.accept({ source: CALLBACK_CHANNEL, eventId: command.requestId,
          payload: { commandHash, policySha256: policy.policySha256, explicitConsent: true },
          actions: [{ kind: 'website_callback', connector: connector.id, operationKey: command.requestId, input: input as unknown as JsonObject, maxAttempts: 4 }] })
        const result: CallbackRecord = { format: 'website-callback-v1', id: command.requestId, actionId: accepted.actions[0]!.id, tokenHash, commandHash }
        await unit.documents.set(key(command.requestId), result)
        await unit.documents.set('callback-admissions', [...rows, { at: time, phone, network }])
        return result
      })
      try {
      await runWorkflowOnce({ repository, connectors: new Map([[connector.id, connector]]), actionId: record.actionId,
        workerId: 'website-callback:' + property.requestId, timeoutMs: 5000, leaseMs: 20000, baseBackoffMs: 1, maxBackoffMs: 1000 })
      return (await check(record.actionId)).summary
      } catch { return fail('callback_request_uncertain', 'Your request is saved, but its call status is unconfirmed. Check this request; do not submit another.', 503) }
    },
  }
}
