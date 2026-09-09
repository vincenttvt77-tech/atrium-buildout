import type { RunResult } from './runner.ts'
import type { Grade } from './grade.ts'
import type { Verdict } from './judge.ts'

export interface Outcome {
  run: RunResult
  grade: Grade
  verdict: Verdict | null
}

/** The call as a reviewer reads it: who said what, and what each tool answered. */
export function transcriptText(run: RunResult): string {
  return run.turns.map((t) => {
    if (t.who === 'tool') return `  [tool ${t.name}] ${JSON.stringify(t.input)}\n  [tool answered] ${t.result}`
    return `${t.who === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`
  }).join('\n')
}

export function reportMarkdown(outcomes: Outcome[], meta: { at: Date; assistantModel: string; callerModel: string; judgeModel: string | null }): string {
  const lines: string[] = []
  lines.push(`# Simulated calls — ${meta.at.toISOString()}`, '')
  lines.push('Off-phone text/tool simulation. Each scenario uses a separate memory-only worker and synthetic workspace; operational network transports are denied. Model requests run separately. This does not test live calls, audio, transcription, Vapi turn detection or latency.', '')
  lines.push(`Assistant model: ${meta.assistantModel}. Caller model: ${meta.callerModel}. Judge: ${meta.judgeModel ?? 'off'}.`, '')
  lines.push('| Scenario | Checks | Judge | Turns | Ended by |', '|---|---|---|---|---|')
  for (const o of outcomes) {
    const failed = o.grade.checks.filter((c) => !c.ok).length
    const checks = failed === 0 ? `pass (${o.grade.checks.length})` : `**${failed} failed** of ${o.grade.checks.length}`
    const judge = o.verdict ? `${o.verdict.pass ? 'pass' : '**fail**'} ${o.verdict.score}/5` : '—'
    lines.push(`| ${o.run.scenario.title} | ${checks} | ${judge} | ${o.run.callerTurns} | ${o.run.endedBy} |`)
  }
  lines.push('')
  for (const o of outcomes) {
    lines.push(`## ${o.run.scenario.title}`, '', `Goal: ${o.run.scenario.goal}`, '')
    lines.push('### Checks', '')
    for (const c of o.grade.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.id} — ${c.detail}`)
    lines.push('')
    if (o.verdict) {
      lines.push('### Judge', '', `${o.verdict.pass ? 'Pass' : 'Fail'}, ${o.verdict.score}/5. ${o.verdict.summary}`, '')
      for (const i of o.verdict.issues) lines.push(`- ${i}`)
      lines.push('')
    }
    lines.push('### Transcript', '', '```', transcriptText(o.run), '```', '')
  }
  const totalIn = outcomes.reduce((n, o) => n + o.run.usage.input, 0)
  const totalOut = outcomes.reduce((n, o) => n + o.run.usage.output, 0)
  lines.push(`Tokens: ${totalIn} in, ${totalOut} out (calls only; the judge is not counted).`, '')
  return lines.join('\n')
}

/** One line per scenario for the terminal. */
export function summaryLines(outcomes: Outcome[]): string[] {
  return outcomes.map((o) => {
    const failed = o.grade.checks.filter((c) => !c.ok)
    const j = o.verdict ? ` judge ${o.verdict.pass ? 'pass' : 'FAIL'} ${o.verdict.score}/5` : ''
    const head = `${failed.length === 0 ? 'PASS' : 'FAIL'}  ${o.run.scenario.id.padEnd(16)}${j}`
    return [head, ...failed.map((c) => `      ✗ ${c.id}: ${c.detail}`), ...(o.verdict?.issues ?? []).map((i) => `      • ${i}`)].join('\n')
  })
}
