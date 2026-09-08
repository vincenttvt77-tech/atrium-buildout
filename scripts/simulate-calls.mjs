/**
 * Simulated phone calls against the real webhook, with the real assistant model.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=… npm run simulate                 # every scenario, judged
 *   npm run simulate -- --scenario evan --scenario priya # some of them
 *   npm run simulate -- --no-judge                       # rule checks only, cheaper
 *   npm run simulate -- --list                           # the scenario ids
 *
 * The report lands in sim-reports/<timestamp>.md (git-ignored) and a summary is printed.
 * Exit code 1 if any scenario failed a check or the judge.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const wanted = []
let judgeOn = true
let list = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--scenario' || a === '-s') wanted.push(args[++i])
  else if (a.startsWith('--scenario=')) wanted.push(a.slice('--scenario='.length))
  else if (a === '--no-judge') judgeOn = false
  else if (a === '--list') list = true
  else if (a === '--all') { /* default */ }
  else { console.error(`Unknown argument: ${a}`); process.exit(2) }
}

const { SCENARIOS, findScenario } = await import('../src/sim/scenarios.ts')
if (list) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(16)} ${s.title}`)
  process.exit(0)
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Export it in this shell (never paste it in chat or commit it) and run again.')
  process.exit(2)
}

const scenarios = wanted.length ? wanted.map((id) => {
  const s = findScenario(id)
  if (!s) { console.error(`No scenario "${id}". Try --list.`); process.exit(2) }
  return s
}) : SCENARIOS

const { demoAssistantConfig } = await import('../src/vapi/config.ts')
const { runScenario, toModelTools } = await import('../src/sim/runner.ts')
const { grade } = await import('../src/sim/grade.ts')
const { judge, JUDGE_MODEL } = await import('../src/sim/judge.ts')
const { reportMarkdown, summaryLines } = await import('../src/sim/report.ts')
const { anthropicModel } = await import('../src/sim/anthropic.ts')
const vapi = await import('../api/vapi.ts')

const property = JSON.parse(await readFile('data/property.json', 'utf8'))
const now = new Date()
const config = demoAssistantConfig(property, 'https://ghost-building.vercel.app', now)
const assistantModel = config.model.model
const system = config.model.messages[0].content
const tools = toModelTools(config.model.tools)
const callerModel = assistantModel

const model = anthropicModel()
console.log(`Assistant: ${assistantModel} with ${tools.length} tools. Caller: ${callerModel}. Judge: ${judgeOn ? JUDGE_MODEL : 'off'}.\n`)

const outcomes = []
for (const scenario of scenarios) {
  console.log(`── ${scenario.title}`)
  const run = await runScenario({
    scenario,
    assistant: model, assistantModel,
    caller: model, callerModel,
    webhook: vapi.default,
    system, tools,
    firstMessage: config.firstMessage,
    endCallPhrases: config.endCallPhrases,
    log: (line) => console.log(`   ${line}`),
  })
  const events = vapi.eventLog.filter((e) => e.callId === run.callId)
  const g = grade(run, scenario, events)
  let verdict = null
  if (judgeOn) {
    try { verdict = await judge(run, model) } catch (err) { console.error(`   judge failed: ${err instanceof Error ? err.message : err}`) }
  }
  outcomes.push({ run, grade: g, verdict })
  console.log('')
}

const report = reportMarkdown(outcomes, { at: now, assistantModel, callerModel, judgeModel: judgeOn ? JUDGE_MODEL : null })
await mkdir('sim-reports', { recursive: true })
const file = join('sim-reports', `${now.toISOString().replace(/[:.]/g, '-')}.md`)
await writeFile(file, report)

console.log(summaryLines(outcomes).join('\n'))
console.log(`\nReport: ${file}`)
const failed = outcomes.some((o) => !o.grade.passed || (o.verdict && !o.verdict.pass))
process.exit(failed ? 1 : 0)
