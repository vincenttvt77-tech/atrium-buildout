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
  const summarise = (a: unknown): VapiAssistantSummary => {
    const r = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    return { id: String(r.id ?? ''), name: String(r.name ?? '') }
  }

  const listRes = await doFetch(`${base}/assistant`, { headers })
  if (!listRes.ok) return { ok: false, error: `Vapi returned ${listRes.status} when listing assistants${listRes.status === 401 ? ' — the key is not the private key' : ''}.` }
  const listBody = await listRes.json() as unknown
  const list = (Array.isArray(listBody) ? listBody : []).map(summarise)
  const chosen = chooseAssistant(list, { id: opts.assistantId, name: config_name(opts.config) })
  if ('error' in chosen) return { ok: false, error: chosen.error, candidates: chosen.candidates }

  const getRes = await doFetch(`${base}/assistant/${chosen.assistant.id}`, { headers })
  if (!getRes.ok) return { ok: false, error: `Vapi returned ${getRes.status} when reading "${chosen.assistant.name}".` }
  const existing = await getRes.json() as Record<string, unknown>

  const patch = assistantPatch(existing, opts.config)
  const patchRes = await doFetch(`${base}/assistant/${chosen.assistant.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })
  if (!patchRes.ok) {
    let detail = ''
    try { const b = await patchRes.json() as { message?: unknown }; if (b?.message) detail = ` — ${Array.isArray(b.message) ? b.message.join('; ') : String(b.message)}` } catch { /* no body */ }
    return { ok: false, error: `Vapi returned ${patchRes.status} when updating "${chosen.assistant.name}"${detail}.`, assistant: chosen.assistant }
  }
  return {
    ok: true,
    assistant: chosen.assistant,
    updated: ['the script', `${(opts.config.model.tools as unknown[]).length} tools with their spoken messages`, 'the server address', 'the opening line'],
    kept: KEPT_IN_VAPI,
  }
}

const config_name = (c: DemoAssistantConfig) => c.name
