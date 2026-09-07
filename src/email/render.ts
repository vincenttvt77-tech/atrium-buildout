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
  | { sent: true; id: string }
  | { sent: false; reason: string; queued: boolean }

/** Pluggable so the demo can render without sending and production can swap providers. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>
}

/** Renders and records, sends nothing. What the demo runs on until a provider key exists. */
export class NoopTransport implements EmailTransport {
  readonly outbox: EmailMessage[] = []
  async send(message: EmailMessage): Promise<SendResult> {
    this.outbox.push(message)
    return { sent: false, reason: 'no email provider configured', queued: true }
  }
}

/** Resend. Activates automatically when RESEND_API_KEY is present. */
export class ResendTransport implements EmailTransport {
  readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: [message.to], from: message.from, subject: message.subject,
          html: message.html, ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      })
      if (!res.ok) {
        return { sent: false, reason: `resend ${res.status}: ${await res.text()}`, queued: true }
      }
      const body = await res.json() as { id?: string }
      return { sent: true, id: body.id ?? 'unknown' }
    } catch (err) {
      return { sent: false, reason: err instanceof Error ? err.message : String(err), queued: true }
    }
  }
}

export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const key = env.RESEND_API_KEY
  return key && key.trim() ? new ResendTransport(key) : new NoopTransport()
}
