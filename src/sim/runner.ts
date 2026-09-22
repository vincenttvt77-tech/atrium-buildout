import type { ContentBlock, Model, ModelMessage, ModelTool, Turn, Webhook } from './types.ts'
import type { Scenario } from './scenarios.ts'
import { VapiBridge } from './bridge.ts'
import { randomUUID } from 'node:crypto'

/**
 * Plays one scenario end to end.
 *
 * Two models take part. The assistant side is the same model the phone line runs on,
 * given the same system prompt and tool schemas the Vapi assistant carries, with every
 * tool call answered by the real webhook handler in-process. The caller side is a second
 * model playing the persona. This exercises text, tool and application behavior; it does
 * not reproduce Vapi audio, turn detection, transcription, delivery or live latency.
 */
export interface RunOptions {
  scenario: Scenario
  /** Answers for the assistant. Must be the model the Vapi assistant is configured with. */
  assistant: Model
  assistantModel: string
  /** Plays the caller. */
  caller: Model
  callerModel: string
  webhook: Webhook
  /** The assistant's system prompt, verbatim from the Vapi configuration. */
  system: string
  tools: ModelTool[]
  firstMessage: string
  callId?: string
  now?: () => Date
  /** Vapi ends the call when the assistant says one of these. */
  endCallPhrases?: string[]
  /** A safety limit; a scenario has its own, tighter expectation. */
  maxCallerTurns?: number
  log?: (line: string) => void
}

export interface RunResult {
  scenario: Scenario
  callId: string
  assistantModel: string
  turns: Turn[]
  startedAt?: string
  endedBy: 'caller' | 'assistant' | 'limit' | 'silence'
  callerTurns: number
  usage: { input: number; output: number }
}

export const HANG_UP = '[HANGS UP]'

/** Vapi's OpenAI-shaped tool definitions, as the Messages API wants them. */
export function toModelTools(vapiTools: ReadonlyArray<{ function: { name: string; description: string; parameters: unknown } }>): ModelTool[] {
  return vapiTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Record<string, unknown>,
  }))
}

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text.trim()).filter(Boolean).join(' ')
}

export async function runScenario(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? (() => new Date())
  const callId = o.callId ?? `sim-${o.scenario.id}-${randomUUID()}`
  const bridge = new VapiBridge(o.webhook)
  const log = o.log ?? (() => {})
  const limit = o.maxCallerTurns ?? 14
  const endPhrases = (o.endCallPhrases ?? ['goodbye', 'bye now', 'have a good one']).map((p) => p.toLowerCase())
  const startedAt = now()
  const usage = { input: 0, output: 0 }
  const turns: Turn[] = []

  // The assistant's own view of the call. A Messages conversation has to open with the
  // caller, so the line connecting stands in for it, and the greeting Vapi speaks first
  // is on the record as the assistant's opening line.
  const history: ModelMessage[] = [
    { role: 'user', content: '(The call connects.)' },
    { role: 'assistant', content: o.firstMessage },
  ]
  turns.push({ who: 'assistant', text: o.firstMessage })
  log(`assistant: ${o.firstMessage}`)

  // The caller's view: what the assistant says is the "user" side of their conversation.
  const callerHistory: ModelMessage[] = [{ role: 'user', content: o.firstMessage }]

  let endedBy: RunResult['endedBy'] = 'limit'
  let callerTurns = 0
  let toolSeq = 0

  while (callerTurns < limit) {
    // --- the caller speaks ---
    const c = await o.caller.create({ model: o.callerModel, max_tokens: 300, system: o.scenario.persona, messages: [...callerHistory] })
    usage.input += c.usage?.input_tokens ?? 0
    usage.output += c.usage?.output_tokens ?? 0
    let said = textOf(c.content)
    const hangsUp = said.includes(HANG_UP)
    said = said.replace(HANG_UP, '').replace(/\s+/g, ' ').trim()
    if (!said) said = hangsUp ? 'Okay, bye.' : '…'
    callerTurns += 1
    callerHistory.push({ role: 'assistant', content: said })
    turns.push({ who: 'caller', text: said })
    log(`caller: ${said}`)
    await bridge.transcript(callId, said)
    history.push({ role: 'user', content: said })

    if (hangsUp) { endedBy = 'caller'; break }

    // --- the assistant answers, calling tools until it has something to say ---
    let spoken: string[] = []
    let rounds = 0
    let ended = false
    while (rounds < 6) {
      rounds += 1
      const a = await o.assistant.create({ model: o.assistantModel, max_tokens: 1024, system: o.system, tools: o.tools, messages: [...history] })
      usage.input += a.usage?.input_tokens ?? 0
      usage.output += a.usage?.output_tokens ?? 0
      const blocks = a.content.filter((b) => b.type === 'text' || b.type === 'tool_use')
      const text = textOf(blocks)
      if (text) { spoken.push(text); turns.push({ who: 'assistant', text }); log(`assistant: ${text}`) }
      const calls = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      if (blocks.length > 0) history.push({ role: 'assistant', content: blocks })
      if (calls.length === 0 || a.stop_reason !== 'tool_use') break

      const answers = await bridge.toolCalls(callId, calls.map((tc) => ({ id: tc.id || `sim-tc-${++toolSeq}`, name: tc.name, input: tc.input })))
      const results: ContentBlock[] = []
      for (const tc of calls) {
        const result = answers.get(tc.id) ?? answers.get(`sim-tc-${toolSeq}`) ?? 'The lookup did not answer.'
        turns.push({ who: 'tool', name: tc.name, input: tc.input, result })
        log(`  [${tc.name}] ${JSON.stringify(tc.input)} → ${result.replace(/\s+/g, ' ').slice(0, 160)}`)
        results.push({ type: 'tool_result', tool_use_id: tc.id, content: result })
      }
      history.push({ role: 'user', content: results })
    }

    const reply = spoken.join(' ').trim()
    if (!reply) { endedBy = 'silence'; break }
    callerHistory.push({ role: 'user', content: reply })
    ended = endPhrases.some((p) => reply.toLowerCase().includes(p))
    if (ended) { endedBy = 'assistant'; break }
  }

  await bridge.endOfCall(callId, startedAt, now())
  return { scenario: o.scenario, callId, assistantModel: o.assistantModel, startedAt: startedAt.toISOString(), turns, endedBy, callerTurns, usage }
}
