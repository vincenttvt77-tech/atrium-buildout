import Anthropic from '@anthropic-ai/sdk'
import type { Model, ModelRequest, ModelResponse, ContentBlock } from './types.ts'

/**
 * The real Messages API behind the simulator's narrow `Model` interface.
 *
 * The model credential stays in the parent model adapter. The operational worker never
 * receives it. Pin the destination so an inherited base-URL override cannot redirect it.
 */
export function anthropicModel(client?: Anthropic): Model {
  if (!client) {
    if (process.env.ANTHROPIC_CUSTOM_HEADERS?.trim()) throw new Error('Simulation model custom headers are not allowed.')
    if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL !== 'https://api.anthropic.com') {
      throw new Error('Simulation model endpoint overrides are not allowed.')
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for model simulation.')
    const modelFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages') {
        throw new Error('Simulation model request destination is not allowed.')
      }
      return fetch(input, { ...init, redirect: 'error' })
    }
    client = new Anthropic({ apiKey, authToken: null, webhookKey: null, baseURL: 'https://api.anthropic.com',
      fetch: modelFetch, logLevel: 'off', timeout: 60_000, maxRetries: 1 })
  }
  const messages = client.messages
  return {
    async create(req: ModelRequest): Promise<ModelResponse> {
      const r = await messages.create({
        model: req.model,
        max_tokens: req.max_tokens,
        ...(req.system ? { system: req.system } : {}),
        ...(req.tools ? { tools: req.tools as Anthropic.Tool[] } : {}),
        ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
        ...(req.thinking ? { thinking: req.thinking } : {}),
        messages: req.messages as Anthropic.MessageParam[],
      }).catch(() => { throw new Error('Simulation model request failed; no model result was produced.') })
      // Thinking blocks are not part of the transcript; only what was said or looked up.
      const content: ContentBlock[] = []
      for (const b of r.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> })
      }
      return { content, stop_reason: r.stop_reason, usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens } }
    },
  }
}
