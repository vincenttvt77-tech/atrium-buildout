import { uuid } from './config.ts'

/** Bounded, fixed-origin providers. No URL or credentials come from the visitor. */
export async function boundedJson(response: Response, max = 32768): Promise<any> {
  if (!response.ok || !response.body) throw new Error('provider_unavailable')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength
    if (size > max) throw new Error('provider_response_too_large'); chunks.push(part.value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}
export class CallbackTransport {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) { this.apiKey = apiKey; this.fetchImpl = fetchImpl }
  async create(body: Record<string, unknown>, signal: AbortSignal) {
    return boundedJson(await this.fetchImpl('https://api.vapi.ai/call', { method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), 262144)
  }
  async read(id: string, signal: AbortSignal) {
    if (!uuid(id)) throw new Error('callback_reference_invalid')
    return boundedJson(await this.fetchImpl(`https://api.vapi.ai/call/${id}`, { redirect: 'error', signal,
      headers: { authorization: `Bearer ${this.apiKey}` } }), 1048576)
  }
}
export class CallbackChallenge {
  private readonly secret: string
  private readonly fetchImpl: typeof fetch
  constructor(secret: string, fetchImpl: typeof fetch = fetch) { this.secret = secret; this.fetchImpl = fetchImpl }
  async verify(token: string, origin: string, channel: string, ip: string, now: Date): Promise<boolean> {
    try {
      const result = await boundedJson(await this.fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: this.secret, response: token, remoteip: ip }),
      }), 8192)
      const age = now.getTime() - Date.parse(result.challenge_ts)
      return result.success === true && result.hostname === new URL(origin).hostname && result.action === 'atrium-callback'
        && result.cdata === channel && Number.isFinite(age) && age >= -10000 && age <= 300000
    } catch { return false }
  }
}
