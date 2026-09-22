import { ResendTransport, validEmailMessage, validEmailId } from './render.ts'
import type { EmailMessage } from './render.ts'
import { hashJson } from '../workflows/validation.ts'
import { WorkflowError } from '../workflows/model.ts'
import type { WorkflowAction, WorkflowConnector, NewWorkflowAction, JsonObject, DispatchResult, VerificationResult } from '../workflows/model.ts'

export interface EmailConsent {
  purpose: 'leasing_shortlist' | 'tour_confirmation'
  recipient: string
  contentSha256: string
  recordedAt: string
  expiresAt: string
  /** Server-recorded receipt reference; the workflow separately retains the authorized actor. */
  receiptId: string
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const time = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? Date.parse(value) : NaN
const invalid = (): never => { throw new WorkflowError('workflow_invalid_input', 'The email intent or permission receipt is invalid.') }
export const emailMessageDigest = (message: EmailMessage): string => hashJson({ ...message })

function parse(input: unknown): { message: EmailMessage; consent: EmailConsent } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const data = input as Record<string, unknown>
  if (Object.keys(data).length !== 2 || !validEmailMessage(data.message) || !data.consent || typeof data.consent !== 'object' || Array.isArray(data.consent)) return invalid()
  const consent = data.consent as Record<string, unknown>
  const keys = ['purpose','recipient','contentSha256','recordedAt','expiresAt','receiptId']
  if (Object.keys(consent).length !== keys.length || keys.some(key => !Object.hasOwn(consent, key))
    || !['leasing_shortlist','tour_confirmation'].includes(String(consent.purpose))
    || consent.recipient !== data.message.to || consent.contentSha256 !== emailMessageDigest(data.message)
    || !identifier(consent.receiptId)) return invalid()
  const recorded = time(consent.recordedAt), expires = time(consent.expiresAt)
  if (![recorded, expires].every(Number.isFinite) || expires <= recorded || expires - recorded > 86400000) return invalid()
  return { message: structuredClone(data.message), consent: { ...consent } as unknown as EmailConsent }
}

/** Trusted admission must establish permission and booking/shortlist facts first.
 * This validates a receipt binding, not independent evidence of consent, and does not enqueue. */
export function emailWorkflowAction(message: EmailMessage, consent: EmailConsent, operationKey: string): NewWorkflowAction {
  if (!identifier(operationKey)) return invalid()
  const parsed = parse({ message, consent })
  const input: JsonObject = { message: { ...parsed.message }, consent: { ...parsed.consent } }
  return { kind: 'leasing_email', connector: 'resend_email_v1', operationKey, input, maxAttempts: 10 }
}

/** Explicit registry construction only; this module never loads credentials or starts a worker. */
export function createResendEmailConnector(options: {
  organizationId: string; propertyId: string; from: string; replyTo?: string
  transport: ResendTransport; now?: () => Date
}): WorkflowConnector {
  if (!identifier(options.organizationId) || !identifier(options.propertyId)
    || !validEmailMessage({ to: 'validation@example.test', from: options.from, subject: 'Validation', html: '<p>Validation</p>',
      ...(options.replyTo ? { replyTo: options.replyTo } : {}) })) throw new Error('Invalid email connector binding')
  const binding = { organizationId: options.organizationId, propertyId: options.propertyId, from: options.from, replyTo: options.replyTo }
  const transport = options.transport, now = options.now ?? (() => new Date())
  function intent(action: WorkflowAction) {
    if (action.organizationId !== binding.organizationId || action.propertyId !== binding.propertyId
      || action.kind !== 'leasing_email' || action.connector !== 'resend_email_v1'
      || action.inputSha256 !== hashJson(action.input)) return invalid()
    const parsed = parse(action.input)
    if (parsed.message.from !== binding.from || parsed.message.replyTo !== binding.replyTo
      || !Number.isFinite(Date.parse(action.createdAt)) || time(parsed.consent.recordedAt) > Date.parse(action.createdAt)) return invalid()
    return parsed
  }
  return {
    id: 'resend_email_v1',
    // The generic worker's flag promises unbounded retry safety. Resend's24h key does not.
    idempotentWrites: false,
    verificationRequiresReference: true,
    async dispatch(action: WorkflowAction, signal: AbortSignal): Promise<DispatchResult> {
      let parsed: ReturnType<typeof intent>
      try { parsed = intent(action) } catch { return { status: 'rejected', code: 'email_intent_invalid', retryable: false } }
      const dispatchTime = now().getTime()
      if (!Number.isFinite(dispatchTime) || dispatchTime < time(parsed.consent.recordedAt)
        || dispatchTime >= time(parsed.consent.expiresAt)) return { status: 'rejected', code: 'email_consent_expired', retryable: false }
      const result = await transport.send(parsed.message, { operationKey: action.operationKey, inputSha256: action.inputSha256,
        createdAt: action.createdAt, signal })
      if (result.status === 'accepted') return { status: 'accepted', providerReference: result.id }
      if (result.status === 'unknown') return { status: 'unknown', code: result.reason }
      return { status: 'rejected', code: result.status === 'not_configured' ? 'email_not_configured' : result.reason, retryable: false }
    },
    async verify(action: WorkflowAction, signal: AbortSignal): Promise<VerificationResult> {
      let parsed: ReturnType<typeof intent>
      try { parsed = intent(action) } catch { return { status: 'mismatch', code: 'email_intent_invalid' } }
      if (!validEmailId(action.providerReference)) return { status: 'unknown', code: 'email_acknowledgement_missing' }
      try {
        const response = await transport.retrieve(action.providerReference, signal)
        // A404 is not evidence that an earlier send never reached its recipient.
        if (response.status !== 200) return { status: 'unknown', code: 'email_readback_unavailable' }
        const body = response.body as Record<string, unknown> | null
        if (!body || body.object !== 'email' || body.id !== action.providerReference) return { status: 'mismatch', code: 'email_provider_identity_mismatch' }
        const expected = parsed.message
        const sameList = (value: unknown, expected: string[]) => Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
        const tags = body.tags
        const tag = (name: string, value: string) => Array.isArray(tags) && tags.filter(item => item && item.name === name).length === 1
          && tags.some(item => item && item.name === name && item.value === value)
        if (body.from !== expected.from || !sameList(body.to, [expected.to]) || body.subject !== expected.subject || body.html !== expected.html
          || !sameList(body.cc, []) || !sameList(body.bcc, []) || !sameList(body.reply_to, expected.replyTo ? [expected.replyTo] : [])
          || !tag('atrium_operation', action.operationKey) || !tag('atrium_input', action.inputSha256)) return { status: 'mismatch', code: 'email_provider_payload_mismatch' }
        if (['bounced','failed','suppressed','complained','canceled','cancelled'].includes(String(body.last_event))) {
          return { status: 'mismatch', code: 'email_delivery_failed' }
        }
        // Tracking pixels and links can be loaded by machines. Do not call that a human read
        // or invent a delivery event when only a later/unknown event is available.
        if (body.last_event !== 'delivered') return { status: 'unknown', code: 'email_delivery_unverified' }
        const observedAt = now()
        if (!Number.isFinite(observedAt.getTime())) return { status: 'unknown', code: 'email_clock_invalid' }
        return { status: 'matched', operationKey: action.operationKey, inputSha256: action.inputSha256,
          providerReference: action.providerReference, evidence: { provider: 'resend', deliveryStatus: 'delivered',
            observedAt: observedAt.toISOString(), recipientRead: 'not_established' } }
      } catch { return { status: 'unknown', code: 'email_readback_unavailable' } }
    },
  }
}
