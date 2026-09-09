import { createHash } from 'node:crypto'
import { TOOL_DEFINITIONS } from './assistant.ts'

/** Public compatibility proof, not a claim that a conversation or audio test passed. */
export const VOICE_CONTRACT = Object.freeze({
  version: 1,
  toolSchemaSha256: createHash('sha256').update(JSON.stringify(TOOL_DEFINITIONS)).digest('hex'),
})

/** A saved prompt must not be connected to a backend with an older tool contract. */
export async function verifyVoiceBackend(origin: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL('/api/health', origin), {
      method: 'GET', headers: { accept: 'application/json', 'cache-control': 'no-store' }, redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return false
    const body = await response.json() as Record<string, any>
    return body?.ok === true && body.durable === true
      && body.voiceContract?.version === VOICE_CONTRACT.version
      && body.voiceContract?.toolSchemaSha256 === VOICE_CONTRACT.toolSchemaSha256
  } catch { return false }
}
