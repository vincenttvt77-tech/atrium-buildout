import type { RunResult } from './runner.ts'
import type { Scenario } from './scenarios.ts'

/**
 * The checks that need no judgement.
 *
 * Each one is a thing a caller has actually complained about, turned into a rule the
 * transcript either breaks or does not. A failed check names the line, so the fix goes
 * to the prompt or the tool that produced it rather than to a re-run.
 */
export interface Check {
  id: string
  ok: boolean
  detail: string
}

export interface Grade {
  passed: boolean
  checks: Check[]
}

/** "$5,440", "5,440", "5440 a month", "4000 dollars" — anything a voice would read as digits. */
export const MONEY_AS_DIGITS = /\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d{3,6}\s*(?:a|per)\s+month\b|\b\d{3,6}\s+dollars\b/i

/** A residence number as the building writes them: floor then line letter. */
const RESIDENCE = /\b(\d{1,2}[A-N])\b/g

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function grade(run: RunResult, scenario: Scenario, events: Array<Record<string, unknown>>): Grade {
  const checks: Check[] = []
  const assistantLines = run.turns.filter((t): t is Extract<typeof t, { who: 'assistant' }> => t.who === 'assistant')
  const tools = run.turns.filter((t): t is Extract<typeof t, { who: 'tool' }> => t.who === 'tool')
  const toolText = tools.map((t) => t.result).join('\n')
  const said = assistantLines.map((t) => t.text).join('\n')
  const called = new Set(tools.map((t) => t.name))

  // 1. Money is spoken in words.
  const digits = assistantLines.find((t) => MONEY_AS_DIGITS.test(t.text))
  checks.push({
    id: 'money-in-words', ok: !digits,
    detail: digits ? `read a dollar amount as digits: "${digits.text}"` : 'every dollar amount was in words',
  })

  // 2. It does not say the same thing twice.
  const seen = new Set<string>()
  let repeated: string | null = null
  for (const t of assistantLines) {
    const key = normalise(t.text)
    if (key.length > 24 && seen.has(key)) { repeated = t.text; break }
    seen.add(key)
  }
  checks.push({
    id: 'no-loop', ok: !repeated,
    detail: repeated ? `repeated itself: "${repeated}"` : 'never repeated a line',
  })

  // 3. Every residence it names came from a tool.
  const invented = new Set<string>()
  for (const line of assistantLines) {
    for (const m of line.text.matchAll(RESIDENCE)) {
      const id = m[1]!
      if (!new RegExp(`\\b${id}\\b`).test(toolText)) invented.add(id)
    }
  }
  checks.push({
    id: 'residences-grounded', ok: invented.size === 0,
    detail: invented.size ? `named residences no tool returned: ${[...invented].join(', ')}` : 'every residence named came from a lookup',
  })

  // 4. No rent figure before check_availability answered.
  const firstCheck = run.turns.findIndex((t) => t.who === 'tool' && t.name === 'check_availability')
  const quotesMoney = (text: string) => /\bdollars\b/i.test(text) || MONEY_AS_DIGITS.test(text)
  const early = run.turns.findIndex((t, i) => t.who === 'assistant' && quotesMoney(t.text) && (firstCheck === -1 || i < firstCheck))
  checks.push({
    id: 'quote-after-lookup', ok: early === -1,
    detail: early === -1 ? 'no rent was quoted before a lookup' : `quoted money before any availability lookup: "${(run.turns[early] as { text: string }).text}"`,
  })

  // 5. What the scenario itself expects.
  const e = scenario.expect
  for (const tool of e.tools ?? []) {
    checks.push({ id: `calls-${tool}`, ok: called.has(tool), detail: called.has(tool) ? `${tool} was called` : `${tool} was never called` })
  }
  if (e.booking) {
    const booked = events.some((ev) => ev.kind === 'tour_booked' && ev.status === 'confirmed')
    checks.push({ id: 'tour-booked', ok: booked, detail: booked ? 'a tour was confirmed' : 'no tour was confirmed' })
  }
  if (e.escalated) {
    const esc = events.some((ev) => ev.kind === 'escalated' || ev.kind === 'emergency')
    checks.push({ id: 'escalated', ok: esc, detail: esc ? 'the call was escalated' : 'nothing was escalated' })
  }
  for (const re of e.mustSay ?? []) {
    const ok = re.test(said)
    checks.push({ id: `says-${re.source.slice(0, 24)}`, ok, detail: ok ? `said something matching ${re}` : `never said anything matching ${re}` })
  }
  for (const re of e.mustNotSay ?? []) {
    const hit = assistantLines.find((t) => re.test(t.text))
    checks.push({ id: `avoids-${re.source.slice(0, 24)}`, ok: !hit, detail: hit ? `said "${hit.text}"` : `never said anything matching ${re}` })
  }
  if (e.maxCallerTurns) {
    const ok = run.callerTurns <= e.maxCallerTurns && run.endedBy !== 'limit'
    checks.push({
      id: 'call-length', ok,
      detail: ok ? `${run.callerTurns} caller turns, ended by ${run.endedBy}` : `${run.callerTurns} caller turns (limit ${e.maxCallerTurns}), ended by ${run.endedBy}`,
    })
  }
  if (run.endedBy === 'silence') checks.push({ id: 'answered', ok: false, detail: 'the assistant went silent' })

  return { passed: checks.every((c) => c.ok), checks }
}
