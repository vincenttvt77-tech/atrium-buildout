/**
 * Minimal {{placeholder}} rendering for the branded email templates.
 *
 * Deliberately not a template engine. The templates are HTML emails written by hand for
 * client compatibility, and the only dynamic behaviour they need is substitution. Adding
 * a dependency with loops and conditionals invites logic into the template, which is where
 * broken Outlook rendering comes from.
 */

export interface RenderResult {
  html: string
  /** Placeholders present in the template but not supplied. Never silently blank. */
  missing: string[]
  /** Values supplied that the template does not use — usually a renamed placeholder. */
  unused: string[]
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Escaped so a prospect named `<script>` cannot inject into an email we send. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function placeholdersIn(template: string): string[] {
  const found = new Set<string>()
  for (const m of template.matchAll(PLACEHOLDER)) found.add(m[1]!)
  return [...found]
}

export function render(template: string, values: Record<string, string | number | null | undefined>): RenderResult {
  const present = new Set(placeholdersIn(template))
  const supplied = new Set(Object.keys(values).filter((k) => values[k] !== null && values[k] !== undefined))
  const missing: string[] = []

  const html = template.replace(PLACEHOLDER, (_full, key: string) => {
    const v = values[key]
    if (v === null || v === undefined || v === '') {
      missing.push(key)
      return ''
    }
    return escapeHtml(String(v))
  })

  return {
    html,
    missing: [...new Set(missing)],
    unused: [...supplied].filter((k) => !present.has(k)),
  }
}

export interface EmailMessage {
  to: string
  from: string
  subject: string
  html: string
  replyTo?: string
}

export type SendResult =
  | { status: 'accepted'; accepted: true; sent: false; delivered: false; id: string; reason: string }
  | { status: 'not_configured' | 'rejected' | 'unknown'; accepted: false; sent: false; delivered: false; reason: string }

export interface EmailAttempt {
  /** Persisted, property-scoped operation identity. Never mint a new key on a retry. */
  operationKey: string
  inputSha256: string
  createdAt: string
  signal?: AbortSignal
}

export interface EmailTransport {
  send(message: EmailMessage, attempt?: EmailAttempt): Promise<SendResult>
}

/** Preview only. This process-local array is neither a durable queue nor a send. */
export class NoopTransport implements EmailTransport {
  readonly outbox: EmailMessage[] = []
  async send(message: EmailMessage): Promise<SendResult> {
    this.outbox.push(structuredClone(message))
    return { status: 'not_configured', accepted: false, sent: false, delivered: false,
      reason: 'No email provider configured. Preview retained in memory only; nothing queued or sent.' }
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export const validEmailId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
export const validEmailAddress = (value: unknown): value is string => typeof value === 'string' && value.length <= 254
  && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
export function validEmailMessage(value: unknown): value is EmailMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (Object.keys(message).some(key => !['to','from','subject','html','replyTo'].includes(key))) return false
  const display = typeof message.from === 'string' ? /^[^<>\u0000-\u001f\u007f-\u009f]{1,100} <([^<>]+)>$/.exec(message.from) : null
  return validEmailAddress(message.to) && (validEmailAddress(message.from) || !!display && validEmailAddress(display[1]))
    && (message.replyTo === undefined || validEmailAddress(message.replyTo))
    && typeof message.subject === 'string' && message.subject.trim().length > 0 && message.subject.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(message.subject)
    && typeof message.html === 'string' && message.html.trim().length > 0 && Buffer.byteLength(message.html) <= 65536
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message.html)
}

/** Fixed provider origin; response/error bodies and credentials never enter reasons. */
export class ResendTransport implements EmailTransport {
  #apiKey: string
  #fetch: typeof fetch
  #now: () => Date
  constructor(apiKey: string, options: { fetch?: typeof fetch; now?: () => Date } = {}) {
    if (!apiKey.trim() || /[\s\u0000-\u001f\u007f]/.test(apiKey)) throw new Error('Invalid email provider configuration')
    this.#apiKey = apiKey; this.#fetch = options.fetch ?? fetch; this.#now = options.now ?? (() => new Date())
  }
  async #request(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    if (path !== '/emails' && !/^\/emails\/[a-f0-9-]{36}$/i.test(path)) throw new Error('Invalid provider path')
    const cancellation = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    const response = await this.#fetch('https://api.resend.com' + path, { ...init, redirect: 'error', signal: cancellation,
      headers: { ...init.headers, authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' } })
    const reader = response.body?.getReader()
    let bytes = 0; const chunks: Uint8Array[] = []
    if (reader) {
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break
          bytes += part.value.byteLength
          if (bytes > 262144) { await reader.cancel(); throw new Error('Provider response too large') }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
    }
    let body: unknown = null
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* Unknown/malformed response. */ }
    return { status: response.status, body }
  }
  async retrieve(id: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    if (!validEmailId(id)) throw new Error('Invalid provider message identity')
    return this.#request('/emails/' + id, { method: 'GET' }, signal)
  }
  async send(message: EmailMessage, attempt?: EmailAttempt): Promise<SendResult> {
    const failed = (status: 'rejected' | 'unknown', reason: string): SendResult =>
      ({ status, accepted: false, sent: false, delivered: false, reason })
    if (!validEmailMessage(message)) return failed('rejected', 'email_message_invalid')
    if (!attempt || !/^[a-f0-9]{64}$/.test(attempt.operationKey) || !/^[a-f0-9]{64}$/.test(attempt.inputSha256)) {
      return failed('rejected', 'email_durable_identity_required')
    }
    const age = this.#now().getTime() - Date.parse(attempt.createdAt)
    // Resend deduplicates for24h. Refuse all new dispatch after23h; never reset age on retry.
    if (!Number.isFinite(age) || age < 0 || age >= 23 * 3600000) return failed('rejected', 'email_dispatch_window_expired')
    if (attempt.signal?.aborted) return failed('rejected', 'email_cancelled_before_dispatch')
    try {
      const response = await this.#request('/emails', { method: 'POST', headers: { 'idempotency-key': 'atrium-' + attempt.operationKey },
        body: JSON.stringify({ to: [message.to], from: message.from, subject: message.subject, html: message.html,
          ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
          tags: [{ name: 'atrium_operation', value: attempt.operationKey }, { name: 'atrium_input', value: attempt.inputSha256 }] }) }, attempt.signal)
      if (response.status < 200 || response.status >= 300) return failed(
        [400,401,403,422,429].includes(response.status) ? 'rejected' : 'unknown', 'email_provider_http_' + response.status)
      const body = response.body as { id?: unknown } | null
      if (!body || !validEmailId(body.id)) return failed('unknown', 'email_provider_acknowledgement_invalid')
      return { status: 'accepted', accepted: true, sent: false, delivered: false, id: body.id,
        reason: 'Provider accepted the email; delivery has not been verified.' }
    } catch { return failed('unknown', 'email_submission_unverified') }
  }
}

/** A key alone does not authorize a send: a durable operation identity is also required. */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const key = env.RESEND_API_KEY
  return key && key.trim() ? new ResendTransport(key) : new NoopTransport()
}
