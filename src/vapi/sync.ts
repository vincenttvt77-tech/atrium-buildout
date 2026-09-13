import type { DemoAssistantConfig } from './config.ts'

/**
 * Pushes the script and tools to the live Vapi assistant.
 *
 * Every fix to the prompt or a tool used to mean pasting text into Vapi's editor by hand,
 * and the two drifted: the phone line ran a prompt three edits behind the repository for
 * most of a day. This writes exactly what the repository holds — the system prompt, the
 * tools with their spoken messages, server URL, opening disclosure and timing controls.
 * Voice, transcriber, model choice and an existing smart endpointing provider stay tuned
 * in Vapi. Every written field is checked against a fresh saved-state read-back.
 */

export interface VapiAssistantSummary { id: string; name: string }

const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-vapi-secret', 'x-vapi-signature'])
const configurationError = () => new Error('Webhook authentication is missing or conflicts with an existing secret or authentication header. Reconcile the configuration before publishing; no update was sent.')
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A vault credential owns authentication. Inline headers/legacy secrets cannot compete. */
function assertCredentialServer(value: unknown): asserts value is Record<string, unknown> & { url: string; credentialId: string } {
  if (!record(value) || typeof value.url !== 'string' || typeof value.credentialId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.credentialId)
    || (value.secret !== undefined && value.secret !== null)) throw configurationError()
  let url: URL
  try { url = new URL(value.url) } catch { throw configurationError() }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/vapi'
    || value.url !== url.href || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw configurationError()
  if (value.headers !== undefined && value.headers !== null) {
    if (!record(value.headers) || Object.entries(value.headers).some(([key, header]) =>
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || AUTH_HEADERS.has(key.toLowerCase())
      || ['host', ':authority'].includes(key.toLowerCase()) || typeof header !== 'string' || /[\r\n]/.test(header))) throw configurationError()
  }
}

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

/** Apply tested workflow and timing settings over the assistant's existing providers. */
export function assistantPatch(existing: Record<string, unknown>, config: DemoAssistantConfig) {
  const model = (existing.model && typeof existing.model === 'object' ? existing.model : {}) as Record<string, unknown>
  const server = record(existing.server) ? existing.server : {}
  const nextServer = { ...server, ...config.server }
  assertCredentialServer(nextServer)
  if (!Array.isArray(config.model.tools) || !config.model.tools.length) throw configurationError()
  const tools = config.model.tools.map((tool: unknown) => {
    if (!record(tool) || tool.type !== 'function') throw configurationError()
    // Retain unrelated server options, but remove any dependence on implicit
    // assistant-to-tool credential inheritance. Each function has the same route.
    if (tool.server !== undefined) {
      assertCredentialServer(tool.server)
      if (tool.server.url !== nextServer.url || tool.server.credentialId !== nextServer.credentialId) throw configurationError()
    }
    return { ...tool, server: { ...nextServer,
      ...(record(nextServer.headers) ? { headers: { ...nextServer.headers } } : {}) } }
  })
  const patched: Record<string, unknown> = {
    ...model,
    messages: config.model.messages,
    tools,
    // Tools attached as separate Vapi resources would be merged with — or shadow — the
    // inline ones. The inline definitions are the ones under test here, so they are the
    // only ones.
    toolIds: [],
  }
  const start = existing.startSpeakingPlan && typeof existing.startSpeakingPlan === 'object' ? existing.startSpeakingPlan : {}
  const stop = existing.stopSpeakingPlan && typeof existing.stopSpeakingPlan === 'object' ? existing.stopSpeakingPlan : {}
  return {
    firstMessage: config.firstMessage,
    firstMessageMode: config.firstMessageMode,
    server: nextServer,
    model: patched,
    startSpeakingPlan: { ...start, ...config.startSpeakingPlan },
    stopSpeakingPlan: { ...stop, ...config.stopSpeakingPlan },
  }
}

export const KEPT_IN_VAPI = ['voice', 'transcriber', 'model provider and temperature', 'existing smart endpointing provider'] as const

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

  let patch: ReturnType<typeof assistantPatch>
  try { patch = assistantPatch(existing, opts.config) }
  catch { return { ok: false, error: configurationError().message, assistant } }
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
  if (!readback || readback.id !== assistantId || !containsPatch(readback, patch) || !verifiedRoutes(readback, patch)) {
    return { ok: false, error: 'The update was sent, but the saved assistant did not match the expected configuration. Check Vapi before retrying.', assistant }
  }
  return {
    ok: true,
    assistant,
    updated: ['the script', `${(opts.config.model.tools as unknown[]).length} tools with their spoken messages`, 'the server address', 'the opening disclosure', 'response and interruption timing'],
    kept: KEPT_IN_VAPI,
  }
}

const config_name = (c: DemoAssistantConfig) => c.name

/** Added API defaults must never create an alternate route or authentication source. */
function verifiedRoutes(actual: Record<string, unknown>, expected: ReturnType<typeof assistantPatch>): boolean {
  try {
    assertCredentialServer(actual.server)
    if (actual.server.url !== expected.server.url || actual.server.credentialId !== expected.server.credentialId
      || !record(actual.model) || !Array.isArray(actual.model.tools)) return false
    for (const tool of actual.model.tools) {
      if (!record(tool) || tool.type !== 'function') return false
      assertCredentialServer(tool.server)
      if (tool.server.url !== expected.server.url || tool.server.credentialId !== expected.server.credentialId) return false
    }
    return true
  } catch { return false }
}

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
