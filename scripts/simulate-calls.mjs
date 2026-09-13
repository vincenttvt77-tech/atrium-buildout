/**
 * Off-phone text/tool calls against the real handler in isolated local workers.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=… npm run simulate                 # every scenario, judged
 *   npm run simulate -- --scenario evan --scenario priya # some of them
 *   npm run simulate -- --no-judge                       # rule checks only, cheaper
 *   npm run simulate -- --list                           # the scenario ids
 *   npm run simulate -- --preflight                      # isolation check, no model key
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
let preflight = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--scenario' || a === '-s') {
    const id = args[++i]
    if (!id || id.startsWith('-')) { console.error('--scenario needs a scenario id.'); process.exit(2) }
    wanted.push(id)
  }
  else if (a.startsWith('--scenario=')) wanted.push(a.slice('--scenario='.length))
  else if (a === '--no-judge') judgeOn = false
  else if (a === '--list') list = true
  else if (a === '--preflight' || a === '--dry-run') preflight = true
  else if (a === '--all') { /* default */ }
  else { console.error(`Unknown argument: ${a}`); process.exit(2) }
}

const { SCENARIOS, findScenario } = await import('../src/sim/scenarios.ts')
if (list) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(16)} ${s.title}`)
  process.exit(0)
}

const scenarios = wanted.length ? wanted.map((id) => {
  const s = findScenario(id)
  if (!s) { console.error(`No scenario "${id}". Try --list.`); process.exit(2) }
  return s
}) : SCENARIOS

const { createSimulationSandbox } = await import('../src/sim/sandbox.ts')
const { ISOLATION_MODE } = await import('../src/sim/isolation.ts')
if (preflight) {
  const sandbox = await createSimulationSandbox()
  try {
    const snapshot = await sandbox.inspect()
    console.log(`Isolation: ${ISOLATION_MODE}`)
    console.log(`Storage: ${snapshot.storage.kind}; operational network attempts: ${snapshot.networkAttempts}; initial records: ${Object.keys(snapshot.documents).length}`)
    console.log('Selected scenarios:')
    for (const scenario of scenarios) console.log(`  ${scenario.id.padEnd(16)} ${scenario.title}`)
    console.log('Preflight passed. Model conversations and grading were not run; no phone call, email, live webhook or latency test occurred.')
  } finally { await sandbox.close() }
  process.exit(0)
}

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error('ANTHROPIC_API_KEY is not set. Model conversations were not run. Use --preflight for a key-free isolation check.')
  process.exit(2)
}

const { demoAssistantConfig } = await import('../src/vapi/config.ts')
const { runScenario, toModelTools } = await import('../src/sim/runner.ts')
const { grade } = await import('../src/sim/grade.ts')
const { judge, JUDGE_MODEL } = await import('../src/sim/judge.ts')
const { reportMarkdown, summaryLines } = await import('../src/sim/report.ts')
const { anthropicModel } = await import('../src/sim/anthropic.ts')
const property = JSON.parse(await readFile(new URL('../data/property.json', import.meta.url), 'utf8'))
const now = new Date()
const config = demoAssistantConfig(property, 'https://simulation.invalid', now, { dynamicDate: false })
const assistantModel = config.model.model
const system = config.model.messages[0].content
const tools = toModelTools(config.model.tools)
const callerModel = assistantModel

const model = anthropicModel()
console.log(`Isolation: ${ISOLATION_MODE}. This tests text/tools, not live audio or latency.`)
console.log(`Assistant: ${assistantModel} with ${tools.length} tools. Caller: ${callerModel}. Judge: ${judgeOn ? JUDGE_MODEL : 'off'}.\n`)

const outcomes = []
for (const scenario of scenarios) {
  console.log(`── ${scenario.title}`)
  const sandbox = await createSimulationSandbox()
  try {
    const run = await runScenario({
      scenario,
      assistant: model, assistantModel,
      caller: model, callerModel,
      webhook: sandbox.webhook,
      system, tools,
      firstMessage: config.firstMessage,
      endCallPhrases: config.endCallPhrases,
      log: (line) => console.log(`   ${line}`),
    })
    const events = (await sandbox.inspect()).events.filter((e) => e.callId === run.callId)
    const g = grade(run, scenario, events)
    let verdict = null
    if (judgeOn) {
      try { verdict = await judge(run, model) } catch {
        verdict = { pass: false, score: 0, issues: ['Judge request failed; model review was not completed.'], summary: 'Not evaluated.' }
        console.error('   Judge request failed; model review was not completed.')
      }
    }
    outcomes.push({ run, grade: g, verdict })
    console.log('')
  } finally { await sandbox.close() }
}

const report = reportMarkdown(outcomes, { at: now, assistantModel, callerModel, judgeModel: judgeOn ? JUDGE_MODEL : null })
await mkdir('sim-reports', { recursive: true })
const file = join('sim-reports', `${now.toISOString().replace(/[:.]/g, '-')}.md`)
await writeFile(file, report)

console.log(summaryLines(outcomes).join('\n'))
console.log(`\nReport: ${file}`)
const failed = outcomes.some((o) => !o.grade.passed || (o.verdict && !o.verdict.pass))
process.exit(failed ? 1 : 0)
