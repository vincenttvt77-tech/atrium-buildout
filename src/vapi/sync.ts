import type { DemoAssistantConfig } from './config.ts'

/**
 * Pushes the script and tools to the live Vapi assistant.
 *
 * Every fix to the prompt or a tool used to mean pasting text into Vapi's editor by hand,
 * and the two drifted: the phone line ran a prompt three edits behind the repository for
 * most of a day. This writes exactly what the repository holds — the system prompt, the
 * tools with their spoken messages, the server URL, the opening line — and nothing else:
 * the voice, the transcriber, the endpointing plans and the model choice are tuned in
 * Vapi's own screens and are read back and kept as they are.
 */

export interface VapiAssistantSummary { id: string; name: string }

export function chooseAssistant(
  list: VapiAssistantSummary[], wanted: { id?: string | undefined; name: string },
): { assistant: VapiAssistantSummary } | { error: string; candidates: VapiAssistantSummary[] } {
  if (wanted.id) {
    const byId = list.find((a) => a.id === wanted.id)
    return byId ? { assistant: byId } : { error: `No assistant with id ${wanted.id} in this Vapi account.`, candidates: list }
  }
  const byName = list.filter((a) => a.name === wanted.name)
  if (byName.length === 1) return { assistant: byName[0]! }
  if (byName.length === 0 && list.length === 1) return { assistant: list[0]! }
  return {
    error: byName.length > 1
      ? `${byName.length} assistants are named "${wanted.name}". Set VAPI_ASSISTANT_ID to the one the phone number uses.`
      : list.length === 0
        ? 'This Vapi account has no assistants yet.'
        : `None of the ${list.length} assistants is named "${wanted.name}". Set VAPI_ASSISTANT_ID to the one the phone number uses.`,
    candidates: list,
  }
}

/** What is written: the repository's script, tools, server and opening line, over the assistant's own model settings. */
export function assistantPatch(existing: Record<string, unknown>, config: DemoAssistantConfig) {
  const model = (existing.model && typeof existing.model === 'object' ? existing.model : {}) as Record<string, unknown>
  const patched: Record<string, unknown> = {
    ...model,
    messages: config.model.messages,
    tools: config.model.tools,
    // Tools attached as separate Vapi resources would be merged with — or shadow — the
    // inline ones. The inline definitions are the ones under test here, so they are the
    // only ones.
    toolIds: [],
  }
  const server = existing.server && typeof existing.server === 'object' ? existing.server as Record<string, unknown> : {}
  const nextServer: Record<string, unknown> & { url: string } = { ...server, ...config.server }
  return { firstMessage: config.firstMessage, server: nextServer, model: patched }
}

export const KEPT_IN_VAPI = ['voice', 'transcriber', 'start and stop speaking plans', 'model provider and temperature'] as const

export interface SyncResult {
  ok: boolean
  assistant?: VapiAssistantSummary
  updated?: string[]
  kept?: readonly string[]
  error?: string
  candidates?: VapiAssistantSummary[]
}

export async function syncAssistant(opts: {
  apiKey: string
  assistantId?: string | undefined
  config: DemoAssistantConfig
  fetchImpl?: typeof fetch
  baseUrl?: string
}): Promise<SyncResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const base = (opts.baseUrl ?? 'https://api.vapi.ai').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' }
  const signal = AbortSignal.timeout(15000)
  const summarise = (a: unknown): VapiAssistantSummary => {
    const r = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    return { id: String(r.id ?? ''), name: String(r.name ?? '') }
  }

  let assistantId = opts.assistantId
  if (assistantId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(assistantId)) {
    return { ok: false, error: 'The assistant ID is invalid.' }
  }
  // A bound workspace reads only its own assistant. Listing the organization first would
  // disclose other tenants' names in both ambiguous-selection errors and API responses.
  if (assistantId === undefined) {
    const listRes = await doFetch(`${base}/assistant`, { headers, signal })
    if (!listRes.ok) return { ok: false, error: `Vapi returned ${listRes.status} when listing assistants${listRes.status === 401 ? ' — the key is not the private key' : ''}.` }
    const listBody = await listRes.json() as unknown
    if (!Array.isArray(listBody)) return { ok: false, error: 'Vapi returned an invalid assistant list.' }
    const list = listBody.map(summarise).filter((a) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(a.id))
    const chosen = chooseAssistant(list, { name: config_name(opts.config) })
    if ('error' in chosen) return { ok: false, error: chosen.error, candidates: chosen.candidates }
    assistantId = chosen.assistant.id
  }
  const endpoint = `${base}/assistant/${encodeURIComponent(assistantId)}`
  const getRes = await doFetch(endpoint, { headers, signal })
  if (!getRes.ok) return { ok: false, error: `Vapi returned ${getRes.status} when reading the configured assistant${getRes.status === 401 ? ' — the key is not the private key' : ''}.` }
  const existing = await getRes.json() as Record<string, unknown>
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) || existing.id !== assistantId) {
    return { ok: false, error: 'Vapi returned an assistant that does not match the configured ID.' }
  }
  const assistant = summarise(existing)

  const patch = assistantPatch(existing, opts.config)
  const patchRes = await doFetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(patch), signal })
  if (!patchRes.ok) {
    let detail = ''
    try { const b = await patchRes.json() as { message?: unknown }; if (b?.message) detail = ` — ${Array.isArray(b.message) ? b.message.join('; ') : String(b.message)}` } catch { /* no body */ }
    return { ok: false, error: `Vapi returned ${patchRes.status} when updating "${assistant.name}"${detail}.`, assistant }
  }
  // A successful PATCH response only acknowledges the write. Report success after the
  // saved assistant independently returns the expected script, tools and destination.
  const readbackRes = await doFetch(endpoint, { headers, signal })
  if (!readbackRes.ok) return { ok: false, error: `The update was sent, but Vapi returned ${readbackRes.status} when verifying the saved assistant.`, assistant }
  const readback = await readbackRes.json() as Record<string, unknown>
  if (!readback || readback.id !== assistantId || !containsPatch(readback, patch)) {
    return { ok: false, error: 'The update was sent, but the saved assistant did not match the expected configuration. Check Vapi before retrying.', assistant }
  }
  return {
    ok: true,
    assistant,
    updated: ['the script', `${(opts.config.model.tools as unknown[]).length} tools with their spoken messages`, 'the server address', 'the opening line'],
    kept: KEPT_IN_VAPI,
  }
}

const config_name = (c: DemoAssistantConfig) => c.name

/** API defaults may add fields, but every intended field and ordered array must survive. */
function containsPatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => containsPatch(actual[index], value))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, value]) => containsPatch((actual as Record<string, unknown>)[key], value))
  }
  return actual === expected
}
