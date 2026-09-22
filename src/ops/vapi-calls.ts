/**
 * Reads call history from Vapi rather than from this process's memory.
 *
 * The event log was an in-process array. On serverless each request may land on a
 * different instance, so a dashboard request routinely queried an instance that had never
 * seen the call — the log looked empty and the call looked lost. It was not lost; it was
 * somewhere else.
 *
 * Vapi already holds the authoritative record: the transcript, every tool call with its
 * arguments, and every result we returned. Reading from there needs no new service and no
 * second source of truth to drift.
 */

export interface VapiToolCall {
  name: string
  arguments: Record<string, unknown>
  result: string | null
}

export interface VapiCall {
  id: string
  startedAt: string | null
  endedAt: string | null
  durationSeconds: number | null
  endedReason: string | null
  customerNumber: string | null
  transcript: string | null
  recordingUrl: string | null
  toolCalls: VapiToolCall[]
  cost: number | null
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {}
}

/**
 * Tool calls live in the message list, split across the assistant's request and a matching
 * result entry. Pairing them by id is what turns "the agent called check_availability" into
 * "the agent called check_availability and was told nothing matched" — which is the only
 * form in which the log explains a bad call.
 */
function extractToolCalls(messages: unknown[]): VapiToolCall[] {
  const requested = new Map<string, { name: string; arguments: Record<string, unknown> }>()
  const results = new Map<string, string>()

  for (const raw of messages) {
    const m = asRecord(raw)
    const role = String(m.role ?? '')

    for (const tc of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
      const t = asRecord(tc)
      const fn = asRecord(t.function)
      const id = String(t.id ?? '')
      let args: Record<string, unknown> = {}
      const rawArgs = fn.arguments
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs) } catch { args = { raw: rawArgs } }
      } else args = asRecord(rawArgs)
      if (id) requested.set(id, { name: String(fn.name ?? t.name ?? 'unknown'), arguments: args })
    }

    if (role === 'tool_call_result' || m.toolCallId) {
      const id = String(m.toolCallId ?? '')
      if (id) results.set(id, String(m.result ?? m.content ?? ''))
    }
  }

  return [...requested.entries()].map(([id, r]) => ({
    name: r.name,
    arguments: r.arguments,
    result: results.get(id) ?? null,
  }))
}

export function normaliseCall(raw: unknown): VapiCall {
  const c = asRecord(raw)
  const messages = Array.isArray(c.messages) ? c.messages : []
  const startedAt = c.startedAt ? String(c.startedAt) : null
  const endedAt = c.endedAt ? String(c.endedAt) : null

  return {
    id: String(c.id ?? ''),
    startedAt,
    endedAt,
    durationSeconds: startedAt && endedAt
      ? Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)
      : null,
    endedReason: c.endedReason ? String(c.endedReason) : null,
    customerNumber: (asRecord(c.customer).number as string) ?? null,
    transcript: c.transcript ? String(c.transcript) : null,
    recordingUrl: c.recordingUrl ? String(c.recordingUrl) : null,
    toolCalls: extractToolCalls(messages),
    cost: typeof c.cost === 'number' ? c.cost : null,
  }
}

export type FetchResult =
  | { ok: true; calls: VapiCall[] }
  | { ok: false; reason: string; configured: boolean }

/**
 * Never throws. A dashboard that errors when the upstream is slow is a dashboard nobody
 * trusts during the exact incident they opened it for.
 */
export async function fetchCalls(
  opts: { apiKey?: string | undefined; limit?: number; assistantIds?: string[] | undefined; fetchImpl?: typeof fetch } = {},
): Promise<FetchResult> {
  // An explicitly unbound workspace has no voice history. It must never fall back to
  // the API key's organization-wide list, even when the key is missing.
  const assistantIds = opts.assistantIds === undefined ? undefined : [...new Set(opts.assistantIds)]
  if (assistantIds?.length === 0) return { ok: true, calls: [] }
  if (assistantIds && (assistantIds.length > 100 || assistantIds.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)))) {
    return { ok: false, reason: 'This workspace has an invalid assistant binding.', configured: false }
  }
  // Either name. VAPI_API_KEY is what someone naturally types into the Vercel form, and
  // a dashboard that stays empty because of a variable name is a bad afternoon.
  const apiKey = opts.apiKey ?? process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, reason: 'VAPI_PRIVATE_KEY (or VAPI_API_KEY) is not set, so call history cannot be read.', configured: false }
  }

  const doFetch = opts.fetchImpl ?? fetch
  try {
    const limit = Number.isSafeInteger(opts.limit) ? Math.max(1, Math.min(100, opts.limit!)) : 20
    // One deadline bounds the complete fan-out, rather than granting every assistant a
    // fresh eight seconds. At most four upstream requests are active at once.
    const signal = AbortSignal.timeout(8000)
    const targets = assistantIds ?? [undefined]
    const records: unknown[] = []
    let next = 0
    let failure: string | undefined
    async function worker() {
      while (next < targets.length && !failure) {
        const assistantId = targets[next++]
        const query = new URLSearchParams({ limit: String(limit) })
        if (assistantId !== undefined) query.set('assistantId', assistantId)
        try {
          signal.throwIfAborted()
          const res = await doFetch(`https://api.vapi.ai/call?${query}`, {
            headers: { authorization: `Bearer ${apiKey}` }, signal,
          })
          if (!res.ok) throw new Error(`Vapi returned ${res.status}`)
          const body = await res.json() as unknown
          const list = Array.isArray(body) ? body : asRecord(body).results
          if (!Array.isArray(list)) throw new Error('Vapi returned an invalid call list.')
          for (const call of list) {
            const record = asRecord(call)
            // Filter the upstream response before normalization strips assistant identity.
            // Missing IDs are excluded: the query parameter alone is not an access check.
            if (assistantId !== undefined && record.assistantId !== assistantId) continue
            if (typeof record.id !== 'string' || !record.id) continue
            records.push(record)
          }
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()))
    if (failure) return { ok: false, reason: failure, configured: true }
    const date = (call: VapiCall) => Date.parse(call.startedAt ?? '') || 0
    const sorted = records.map(normaliseCall).sort((a, b) => date(b) - date(a) || a.id.localeCompare(b.id))
    const unique = new Map<string, VapiCall>()
    for (const call of sorted) if (!unique.has(call.id)) unique.set(call.id, call)
    return { ok: true, calls: [...unique.values()].slice(0, limit) }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      configured: true,
    }
  }
}
