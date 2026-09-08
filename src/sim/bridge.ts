import type { Webhook } from './types.ts'

/**
 * Speaks to the webhook handler the way Vapi does, without a network.
 *
 * Vapi sends three kinds of message that matter to a call: a `transcript` for each thing
 * the caller finished saying, a `tool-calls` batch when the model wants a lookup, and an
 * `end-of-call-report` when the line drops. The simulator sends exactly those, with the
 * same payload shapes, so a call that passes here exercised the real handler — the same
 * quote gate, the same calendar, the same knowledge guard — not a stand-in.
 */
export interface BridgeResult {
  status: number
  body: any
}

export class VapiBridge {
  private readonly handler: Webhook
  private readonly secret: string | undefined

  constructor(handler: Webhook, secret?: string) {
    this.handler = handler
    this.secret = secret
  }

  private async post(body: unknown): Promise<BridgeResult> {
    const out: BridgeResult = { status: 0, body: null }
    const res = {
      status(c: number) { out.status = c; return res },
      json(b: unknown) { out.body = b; return res },
      setHeader() { return res },
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.secret) headers['x-vapi-secret'] = this.secret
    await this.handler({ method: 'POST', headers, body }, res)
    return out
  }

  /** A finished caller utterance — what Vapi sends as `transcriptType: 'final'`. */
  async transcript(callId: string, text: string): Promise<void> {
    await this.post({ message: { type: 'transcript', role: 'user', transcriptType: 'final', transcript: text, call: { id: callId } } })
  }

  /** One batch of tool calls from a single model turn, answered in order. */
  async toolCalls(callId: string, calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): Promise<Map<string, string>> {
    const r = await this.post({
      message: {
        type: 'tool-calls',
        call: { id: callId },
        toolCallList: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.input })),
      },
    })
    const answers = new Map<string, string>()
    const results: Array<{ toolCallId: string; result: string }> = r.body?.results ?? []
    for (const x of results) answers.set(String(x.toolCallId), String(x.result))
    for (const c of calls) {
      // The handler's failure path answers a single 'error' id for the whole batch.
      if (!answers.has(c.id)) answers.set(c.id, answers.get('error') ?? 'The lookup did not answer.')
    }
    return answers
  }

  async endOfCall(callId: string, startedAt: Date, endedAt: Date): Promise<void> {
    await this.post({
      message: {
        type: 'end-of-call-report',
        call: { id: callId, customer: { number: `+1555${callId.replace(/\D/g, '').slice(-7).padStart(7, '0')}` }, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
        endedReason: 'customer-ended-call',
      },
    })
  }
}
