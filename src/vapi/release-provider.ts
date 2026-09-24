import { VapiClient } from '@vapi-ai/server-sdk'
import type { Vapi } from '@vapi-ai/server-sdk'
import { VoiceReleaseError } from './managed-release.ts'
import type { VoiceReleaseProvider } from './managed-release.ts'

const MAX_REPLY = 512 * 1024
const failure = () => new VoiceReleaseError(502, 'voice_provider_unavailable', 'The phone provider response could not be verified. Check the saved release before retrying.')

/** Official SDK with a fixed destination, no automatic writes/retries and bounded, redacted replies. */
export function vapiReleaseProvider(apiKey: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): VoiceReleaseProvider {
  if (!apiKey?.trim()) throw failure()
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw failure()
  const transport = options.fetch ?? fetch
  const client = new VapiClient({ token: apiKey, maxRetries: 0, timeoutInSeconds: timeoutMs / 1000,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.origin !== 'https://api.vapi.ai' || url.username || url.password || url.search || url.hash
        || !/^\/assistant\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(url.pathname)
        || !['GET', 'PATCH'].includes(init?.method ?? 'GET')) throw failure()
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])])
      let abort: () => void = () => {}, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }) })
      const operation = async () => {
        const response = await transport(url.href, { ...init, redirect: 'error', signal })
        if (response.status >= 300 && response.status < 400) throw failure()
        if (Number(response.headers.get('content-length') ?? 0) > MAX_REPLY) throw failure()
        reader = response.body?.getReader()
        const parts: Uint8Array[] = []; let total = 0
        if (reader) while (true) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.byteLength
          if (total > MAX_REPLY) throw failure()
          parts.push(next.value)
        }
        return new Response(parts.length ? Buffer.concat(parts) : null, { status: response.status, headers: response.headers })
      }
      try { if (signal.aborted) throw failure(); return await Promise.race([operation(), cancelled]) }
      catch { return Response.json({ error: 'provider_response_unverified' }, { status: 502 }) }
      finally { signal.removeEventListener('abort', abort); if (reader) void reader.cancel().catch(() => {}) }
    },
  })
  const validId = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw failure() }
  return {
    async read(assistantId) {
      validId(assistantId)
      try {
        const value = await client.assistants.get({ id: assistantId })
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== assistantId) throw failure()
        return value as unknown as Record<string, unknown>
      }
      catch { throw failure() }
    },
    async patch(assistantId, patch) {
      validId(assistantId)
      try { await client.assistants.update({ ...patch, id: assistantId } as unknown as Vapi.UpdateAssistantDto) }
      catch { throw failure() }
    },
  }
}
