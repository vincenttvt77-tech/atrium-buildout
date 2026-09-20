import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { documentStoreFromEnv } from '../../src/store/documents.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'

const savedEnv = { ...process.env }
let handler: (req: any, res: any) => Promise<void>
before(async () => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL',
    'OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'KV_REST_API_URL',
    'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  handler = (await import('../vapi.ts')).default
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(message: Record<string, unknown>) {
  const res: any = { code: 0, body: null,
    setHeader() {},
    status(code: number) { this.code = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  await handler({ method: 'POST', headers: {}, body: { message } }, res)
  return res
}
const tool = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args })
const tools = (id: string, toolCallList: unknown[]) => invoke({ type: 'tool-calls', call: { id }, toolCallList })
const budget = (excerpt = 'My budget is 4500.') => tool('capture_signal', { signal: 'budget', value: '4500', excerpt })
const question = (text: string) => tool('answer_question', { question: text, topic: 'general_property_fact' })
const state = (id: string) => documentStoreFromEnv().get<any>(`call:${id}`)
const held = async (id: string) => (await calendarStoreFromEnv().read()).emergencyHolds?.some(hold => hold.interactionId === id) ?? false

test('hypothetical, historical and negated heating questions allow later leasing tools in the same batch', async () => {
  for (const [index, text] of [
    'What happens if there is no heat?',
    'We had no heat at my old apartment last winter.',
    "I am not reporting no heat. I'm asking about your policy.",
  ].entries()) {
    const id = `heat-context-question-${index}`
    const response = await tools(id, [question(text), budget()])
    assert.equal(response.code, 200)
    assert.match(response.body.results[1].result, /Got it/)
    assert.doesNotMatch(response.body.results[0].result, /leasing actions are paused/i)
    const saved = await state(id)
    assert.equal(saved.emergency, null)
    assert.equal(saved.qualification.budget.value.maxMonthly, 4500)
    assert.equal(await held(id), false)
  }
})

test('a historical heating excerpt does not prevent qualification capture', async () => {
  const id = 'heat-context-excerpt'
  const response = await tools(id, [budget('My budget is 4500. I had no heat at my old apartment last winter.')])
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /Got it/)
  assert.equal((await state(id)).qualification.budget.value.maxMonthly, 4500)
  assert.equal(await held(id), false)
})

test('hypothetical heating transcript does not freeze a later request', async () => {
  const id = 'heat-context-transcript'
  const transcript = await invoke({ type: 'transcript', role: 'user', transcriptType: 'final', call: { id },
    transcript: 'What should I do if the heat is out?' })
  assert.equal(transcript.code, 200)
  const response = await tools(id, [budget()])
  assert.match(response.body.results[0].result, /Got it/)
  assert.equal((await state(id)).emergency, null)
  assert.equal(await held(id), false)
})

test('a current heating report pre-empts the batch and durably blocks later leasing writes', async () => {
  const id = 'heat-context-current'
  const first = await tools(id, [budget(), question('We have no heat in our apartment right now.')])
  assert.equal(first.code, 200)
  for (const result of first.body.results) assert.match(result.result, /emergency maintenance line directly about the loss of heat/)
  assert.equal((await state(id)).qualification.budget, undefined)
  assert.equal((await state(id)).emergency.kind, 'no_heat')
  assert.equal(await held(id), true)

  // Model output or a later correction cannot silently release an established hold.
  const later = await tools(id, [question('I am not reporting no heat.'), budget()])
  assert.equal(later.code, 200)
  assert.match(later.body.results[1].result, /emergency maintenance line directly about the loss of heat/)
  assert.equal((await state(id)).qualification.budget, undefined)
  assert.equal(await held(id), true)
})

test('an actual current heating transcript holds the call despite an earlier hypothetical mention', async () => {
  const id = 'heat-context-current-transcript'
  const transcript = await invoke({ type: 'transcript', role: 'user', transcriptType: 'final', call: { id },
    transcript: 'What happens if there is no heat? Actually we have no heat in our apartment right now.' })
  assert.equal(transcript.code, 200)
  const response = await tools(id, [budget()])
  assert.match(response.body.results[0].result, /emergency maintenance line directly about the loss of heat/)
  assert.equal((await state(id)).emergency.kind, 'no_heat')
  assert.equal((await state(id)).qualification.budget, undefined)
  assert.equal(await held(id), true)
})

test('past heating reports with no affirmative resolution remain guarded', async () => {
  for (const [index, text] of [
    'We had no heat yesterday and the problem continues.',
    'We had no heat last night and nobody has fixed it.',
    'We had no heat yesterday, it has not been repaired.',
    'I reported no heat yesterday. Please send somebody to fix it.',
    'We had no heat yesterday; it was fixed but broke again.',
    'We had no heat yesterday; it was fixed but has stopped working again.',
    'No heat again after they fixed it yesterday.',
  ].entries()) {
    const id = `heat-context-unresolved-${index}`
    const response = await tools(id, [budget(), question(text)])
    assert.equal(response.code, 200)
    for (const result of response.body.results) assert.match(result.result, /emergency maintenance line directly about the loss of heat/)
    assert.equal((await state(id)).emergency.kind, 'no_heat')
    assert.equal((await state(id)).qualification.budget, undefined)
    assert.equal(await held(id), true)
  }
})

test('hypothetical heating never suppresses gas or fire in the same tool or a later batch item', async () => {
  for (const [index, [text, kind]] of [
    ['What if there is no heat? I smell gas in my apartment.', 'gas'],
    ['We had no heat last winter, but there is a fire in my apartment.', 'smoke_or_fire'],
  ].entries()) {
    const id = `heat-context-life-safety-${index}`
    const response = await tools(id, [budget(), question(text!),
      tool('capture_contact', { name: 'Synthetic Safety Caller', excerpt: 'I am not reporting no heat.' })])
    assert.equal(response.code, 200)
    for (const result of response.body.results) assert.match(result.result, /call 911/)
    assert.equal((await state(id)).emergency.kind, kind)
    assert.equal((await state(id)).qualification.budget, undefined)
    assert.equal((await state(id)).name, null)
    assert.equal(await held(id), true)
  }
})
