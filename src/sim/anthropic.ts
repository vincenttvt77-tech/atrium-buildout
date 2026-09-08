import Anthropic from '@anthropic-ai/sdk'
import type { Model, ModelRequest, ModelResponse, ContentBlock } from './types.ts'

/**
 * The real Messages API behind the simulator's narrow `Model` interface.
 *
 * The SDK reads ANTHROPIC_API_KEY from the environment. It is never read here, never
 * logged, and never passed in as an argument, so it cannot end up in a report.
 */
export function anthropicModel(client: Anthropic = new Anthropic()): Model {
  return {
    async create(req: ModelRequest): Promise<ModelResponse> {
      const r = await client.messages.create({
        model: req.model,
        max_tokens: req.max_tokens,
        ...(req.system ? { system: req.system } : {}),
        ...(req.tools ? { tools: req.tools as Anthropic.Tool[] } : {}),
        ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
        ...(req.thinking ? { thinking: req.thinking } : {}),
        messages: req.messages as Anthropic.MessageParam[],
      })
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
