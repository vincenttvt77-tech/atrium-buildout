import type { Model } from './types.ts'
import type { RunResult } from './runner.ts'
import { transcriptText } from './report.ts'

/**
 * A second opinion from a stronger model, on the things a rule cannot check: did the
 * caller get what they came for, did it sound like a person, was anything said that a
 * leasing manager would wince at. It reads the transcript and every tool result, so it
 * can see whether a claim was grounded — the same evidence a human reviewer would have.
 */
export interface Verdict {
  pass: boolean
  score: number
  issues: string[]
  summary: string
}

export const JUDGE_MODEL = 'claude-opus-5'

export async function judge(run: RunResult, model: Model, modelId: string = JUDGE_MODEL): Promise<Verdict> {
  const r = await model.create({
    model: modelId,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: `You review recordings of an AI leasing assistant for a residential building. You are strict, specific, and you quote the line you object to. You know the rules the assistant is held to: it may only name residences, rents and availability that a tool returned; it says dollar amounts in words; it never asks a question the caller already answered; it does not promise to email or text anything itself; it answers building questions from the tool's answer rather than guessing or refusing; it keeps replies to a sentence or two; it never quotes a rent before it has the caller's move-in timing and budget, unless they asked about one specific residence. Fair-housing questions and reasonable-accommodation requests are handed to a person, and any emergency gets an immediate safety instruction.`,
    tools: [{
      name: 'verdict',
      description: 'Your review of the call.',
      input_schema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean', description: 'Would a leasing manager be comfortable with this call going to a real prospect?' },
          score: { type: 'integer', minimum: 1, maximum: 5, description: '5 = as good as a strong human agent; 3 = acceptable with rough edges; 1 = would lose the prospect.' },
          issues: { type: 'array', items: { type: 'string' }, description: 'Each problem in one sentence, quoting the offending line. Empty if none.' },
          summary: { type: 'string', description: 'Two sentences: what went well and what did not.' },
        },
        required: ['pass', 'score', 'issues', 'summary'],
      },
    }],
    tool_choice: { type: 'tool', name: 'verdict' },
    messages: [{
      role: 'user',
      content: `The caller's goal: ${run.scenario.goal}\n\nHow the call ended: ${run.endedBy}.\n\nTranscript, with every tool call and what the tool answered:\n\n${transcriptText(run)}`,
    }],
  })
  const use = r.content.find((b) => b.type === 'tool_use')
  if (!use || use.type !== 'tool_use') return { pass: false, score: 0, issues: ['the judge did not return a verdict'], summary: '' }
  const v = use.input as Partial<Verdict>
  return {
    pass: Boolean(v.pass),
    score: Number(v.score ?? 0),
    issues: Array.isArray(v.issues) ? v.issues.map(String) : [],
    summary: String(v.summary ?? ''),
  }
}
