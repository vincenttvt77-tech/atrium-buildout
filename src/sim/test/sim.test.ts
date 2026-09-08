import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, toModelTools } from '../runner.ts'
import { grade, MONEY_AS_DIGITS } from '../grade.ts'
import { judge } from '../judge.ts'
import { reportMarkdown } from '../report.ts'
import { TOOL_DEFINITIONS } from '../../vapi/assistant.ts'
import type { Model, ModelRequest, ModelResponse, Webhook } from '../types.ts'
import type { Scenario } from '../scenarios.ts'

/** Answers each request from a queue, and remembers what it was asked. */
function scripted(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    async create(req) {
      requests.push(req)
      const next = responses.shift()
      if (!next) throw new Error('scripted model ran out of answers')
      return next
    },
  }
}

const text = (t: string, stop = 'end_turn'): ModelResponse => ({ content: [{ type: 'text', text: t }], stop_reason: stop })
const toolUse = (id: string, name: string, input: Record<string, unknown>, say?: string): ModelResponse => ({
  content: [...(say ? [{ type: 'text' as const, text: say }] : []), { type: 'tool_use' as const, id, name, input }],
  stop_reason: 'tool_use',
})

const scenario: Scenario = {
  id: 'test', title: 'Test caller', goal: 'get a price',
  persona: 'You are a test caller.',
  expect: { tools: ['check_availability'], maxCallerTurns: 4, mustNotSay: [/just confirming/i] },
}

/** A webhook that records what it was sent and answers tools with a fixed line. */
function fakeWebhook(answer: (name: string) => string): Webhook & { received: any[] } {
  const received: any[] = []
  const hook: any = async (req: any, res: any) => {
    received.push(req.body.message)
    const m = req.body.message
    if (m.type === 'tool-calls') {
      res.status(200).json({ results: m.toolCallList.map((tc: any) => ({ toolCallId: tc.id, result: answer(tc.name) })) })
    } else res.status(200).json({})
  }
  hook.received = received
  return hook
}

describe('the simulated call', () => {
  test('bridges tool calls to the webhook and ends when the caller hangs up', async () => {
    const assistant = scripted([
      toolUse('tc-1', 'check_availability', { bedrooms: '2', budget: '4000', moveIn: 'two months' }, 'Let me pull that up.'),
      text('Nothing two bedroom fits four thousand, but residence 08E, a studio, is three thousand nine hundred dollars a month.'),
    ])
    const caller = scripted([
      text('Hi, two bedroom under four thousand, moving in two months.'),
      text('Okay thanks, bye. [HANGS UP]'),
    ])
    const webhook = fakeWebhook(() => 'No two bedroom fits. Closest: 08E studio $3,900/month — say "three thousand nine hundred dollars".')

    const run = await runScenario({
      scenario, assistant, assistantModel: 'claude-sonnet-5', caller, callerModel: 'claude-sonnet-5',
      webhook, system: 'SYSTEM', tools: toModelTools(TOOL_DEFINITIONS), firstMessage: 'Thanks for calling.',
      callId: 'sim-test-1', now: () => new Date('2026-09-08T15:00:00Z'),
    })

    assert.equal(run.endedBy, 'caller')
    assert.equal(run.callerTurns, 2)
    const kinds = webhook.received.map((m) => m.type)
    assert.deepEqual(kinds, ['transcript', 'tool-calls', 'transcript', 'end-of-call-report'])
    assert.equal(webhook.received[1].toolCallList[0].name, 'check_availability')
    assert.equal(webhook.received[1].call.id, 'sim-test-1')

    // The assistant was asked with the real system prompt and tool schemas, as the phone is.
    assert.equal(assistant.requests[0]!.system, 'SYSTEM')
    assert.equal(assistant.requests[0]!.model, 'claude-sonnet-5')
    assert.ok(assistant.requests[0]!.tools!.some((t) => t.name === 'book_tour'))
    // Its second request carried the tool result back.
    const second = assistant.requests[1]!.messages.at(-1)!
    assert.ok(Array.isArray(second.content) && second.content[0]!.type === 'tool_result')

    const tools = run.turns.filter((t) => t.who === 'tool')
    assert.equal(tools.length, 1)
    const g = grade(run, scenario, [])
    assert.ok(g.passed, JSON.stringify(g.checks.filter((c) => !c.ok)))
  })

  test('ends when the assistant says goodbye, and stops at the limit otherwise', async () => {
    const webhook = fakeWebhook(() => 'ok')
    const goodbye = await runScenario({
      scenario, assistant: scripted([text('Sure. Goodbye!')]), assistantModel: 'm', caller: scripted([text('bye')]), callerModel: 'm',
      webhook, system: 's', tools: [], firstMessage: 'hi', callId: 'c1',
    })
    assert.equal(goodbye.endedBy, 'assistant')

    const endless = await runScenario({
      scenario, assistant: scripted([text('a'), text('b'), text('c')]), assistantModel: 'm',
      caller: scripted([text('1'), text('2'), text('3')]), callerModel: 'm',
      webhook, system: 's', tools: [], firstMessage: 'hi', callId: 'c2', maxCallerTurns: 3,
    })
    assert.equal(endless.endedBy, 'limit')
    assert.equal(endless.callerTurns, 3)
  })
})

describe('grading', () => {
  test('catches the things callers complained about', () => {
    assert.ok(MONEY_AS_DIGITS.test('That one is $5,440 a month.'))
    assert.ok(MONEY_AS_DIGITS.test('It rents for 5,440.'))
    assert.ok(MONEY_AS_DIGITS.test('about 4000 dollars'))
    assert.ok(!MONEY_AS_DIGITS.test('five thousand four hundred forty dollars a month'))
    assert.ok(!MONEY_AS_DIGITS.test('Tuesday, September 15, 2026 at 2:00 PM'))
    assert.ok(!MONEY_AS_DIGITS.test('residence 19A on the 19th floor'))

    const run = {
      scenario, callId: 'x', assistantModel: 'm', endedBy: 'caller' as const, callerTurns: 3, usage: { input: 0, output: 0 },
      turns: [
        { who: 'assistant' as const, text: 'Thanks for calling.' },
        { who: 'caller' as const, text: 'How much is 12C?' },
        { who: 'assistant' as const, text: 'Residence 12C is $5,440 a month.' },
        { who: 'caller' as const, text: 'Say again?' },
        { who: 'assistant' as const, text: 'Residence 12C is $5,440 a month.' },
        { who: 'tool' as const, name: 'check_availability', input: {}, result: 'Residence 21B is open.' },
        { who: 'assistant' as const, text: 'Just confirming, two bedroom?' },
      ],
    }
    const g = grade(run, scenario, [])
    const failed = Object.fromEntries(g.checks.filter((c) => !c.ok).map((c) => [c.id, c.detail]))
    assert.ok(!g.passed)
    assert.match(failed['money-in-words']!, /digits/)
    assert.match(failed['no-loop']!, /repeated/)
    assert.match(failed['residences-grounded']!, /12C/)
    assert.match(failed['quote-after-lookup']!, /before any availability lookup/)
    assert.match(failed['avoids-just confirming']!, /Just confirming/)
    assert.equal(failed['calls-check_availability'], undefined)
  })

  test('reads bookings and escalations from the handler events', () => {
    const run = {
      scenario: { ...scenario, expect: { booking: true, escalated: true } }, callId: 'x', assistantModel: 'm',
      endedBy: 'caller' as const, callerTurns: 1, usage: { input: 0, output: 0 },
      turns: [{ who: 'assistant' as const, text: 'Booked.' }],
    }
    const none = grade(run, run.scenario, [])
    assert.deepEqual(none.checks.filter((c) => !c.ok).map((c) => c.id), ['tour-booked', 'escalated'])
    const both = grade(run, run.scenario, [{ kind: 'tour_booked', status: 'confirmed' }, { kind: 'escalated', trigger: 'emergency' }])
    assert.ok(both.passed)
  })
})

describe('the judge', () => {
  test('is forced to return a verdict and parses it', async () => {
    const model = scripted([{ content: [{ type: 'tool_use', id: 'v', name: 'verdict', input: { pass: false, score: 2, issues: ['read digits'], summary: 'meh' } }], stop_reason: 'tool_use' }])
    const run = { scenario, callId: 'x', assistantModel: 'm', endedBy: 'caller' as const, callerTurns: 1, usage: { input: 0, output: 0 }, turns: [{ who: 'assistant' as const, text: 'hi' }] }
    const v = await judge(run, model)
    assert.deepEqual(v, { pass: false, score: 2, issues: ['read digits'], summary: 'meh' })
    assert.equal(model.requests[0]!.model, 'claude-opus-5')
    assert.deepEqual(model.requests[0]!.tool_choice, { type: 'tool', name: 'verdict' })
    assert.deepEqual(model.requests[0]!.thinking, { type: 'adaptive' })

    const md = reportMarkdown([{ run, grade: grade(run, scenario, []), verdict: v }], { at: new Date('2026-09-08T00:00:00Z'), assistantModel: 'm', callerModel: 'm', judgeModel: 'j' })
    assert.match(md, /\| Test caller \|/)
    assert.match(md, /read digits/)
  })
})
