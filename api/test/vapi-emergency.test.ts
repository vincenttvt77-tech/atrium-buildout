import { after, before, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { MemoryCalendarStore, calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { generateSlots } from '../../src/calendar/slots.ts'

const savedEnv = { ...process.env }
let handler: (req: any, res: any) => Promise<void>
let eventLog: Array<Record<string, unknown>>
before(async () => {
  // Real handler, isolated memory stores. No environment-dependent external services.
  for (const key of ['OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'KV_REST_API_URL',
    'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  const vapi = await import('../vapi.ts')
  handler = vapi.default; eventLog = vapi.eventLog
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(message: Record<string, unknown>) {
  const res: any = { code: 0, body: null, headers: {},
    setHeader(k: string, v: string) { this.headers[k] = v },
    status(code: number) { this.code = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  await handler({ method: 'POST', headers: {}, body: { message } }, res)
  return res
}
const tool = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args })
const tools = (id: string, toolCallList: unknown[]) => invoke({ type: 'tool-calls', call: { id }, toolCallList })
const gas = () => tool('answer_question', { question: 'I smell gas in my apartment right now. What should I do?', topic: 'general_property_fact' })
const booking = () => {
  const slot = generateSlots(new Date()).at(-1)
  assert.ok(slot, 'use a real bookable-format slot, not an invalid ID that would fail anyway')
  return tool('book_tour', { slotId: slot.slotId, unitId: '08E', prospectName: 'Synthetic Emergency Test', prospectEmail: 'emergency-test@example.com' })
}
const state = (id: string) => documentStoreFromEnv().get<any>(`call:${id}`)
const assertSafety = (value: string) => {
  assert.match(value, /outside.*call 911/i)
  assert.match(value, /have not contacted emergency services or building staff/i)
  assert.doesNotMatch(value, /do not want to guess|I.?m alerting|dispatching|tour is confirmed/i)
}

test('answer_question gives safety guidance without needing a transcript event and persists a truthful escalation', async () => {
  const id = 'emergency-direct-tool'
  const response = await tools(id, [gas()])
  assert.equal(response.code, 200)
  assertSafety(response.body.results[0].result)
  const saved = await state(id)
  assert.equal(saved.emergency.kind, 'gas')
  assert.equal(saved.escalation.trigger, 'emergency')
  assert.equal(saved.booking, null)
  const logs = eventLog.filter(e => e.callId === id)
  assert.ok(logs.some(e => e.kind === 'emergency' && e.persisted === true && e.notificationStatus === 'not_sent'))
  assert.ok(logs.some(e => e.kind === 'escalated' && e.notificationStatus === 'not_sent'))
})

test('a later emergency question pre-empts earlier booking and all leasing writes in the same batch', async () => {
  const id = 'emergency-last-in-batch'
  const beforeCalendar = await calendarStoreFromEnv().read()
  const mutate = MemoryCalendarStore.prototype.mutate
  const calendarWrite = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: any) {
    return mutate.call(this, current => {
      const next = fn(current)
      assert.deepEqual(next.bookings, current.bookings, 'the emergency guard may write, but no booking may change')
      return next
    })
  })
  try {
    const response = await tools(id, [booking(),
      tool('capture_contact', { name: 'Must Not Save', email: 'must-not-save@example.com', excerpt: 'my name is Must Not Save' }),
      tool('capture_signal', { signal: 'budget', value: '4500', excerpt: 'my budget is 4500' }),
      tool('capture_loss_reason', { kind: 'budget', detail: 'must not save', evidence: 'too expensive' }),
      { id: 'emergency-last', function: { name: 'answer_question', arguments: JSON.stringify(gas().arguments) } },
    ])
    assert.equal(response.code, 200)
    assert.equal(response.body.results.length, 5)
    for (const r of response.body.results) assertSafety(r.result)
    assert.match(response.body.results[0].result, /requested action was not taken/)
    assert.equal(calendarWrite.mock.callCount(), 1)
    const saved = await state(id)
    assert.equal(saved.name, null); assert.equal(saved.email, null)
    assert.equal(saved.booking, null); assert.equal(saved.lossReason, null)
    assert.equal(saved.qualification.budget, undefined)
    assert.equal(saved.emergency.kind, 'gas')
    const afterCalendar = await calendarStoreFromEnv().read()
    assert.deepEqual(afterCalendar.bookings, beforeCalendar.bookings)
    assert.deepEqual(afterCalendar.blocks, beforeCalendar.blocks)
    assert.ok(afterCalendar.emergencyHolds?.some(hold => hold.interactionId === id))
  } finally { calendarWrite.mock.restore() }
})

test('an emergency in caller excerpt also blocks the full batch before qualification capture', async () => {
  const response = await tools('emergency-capture-excerpt', [booking(),
    tool('capture_signal', { signal: 'budget', value: '4500', excerpt: 'My budget is 4500, but I smell gas now.' }),
  ])
  for (const r of response.body.results) assertSafety(r.result)
  assert.equal((await state('emergency-capture-excerpt')).qualification.budget, undefined)
})

test('unknown tools and malformed JSON or array arguments cannot hide an emergency behind an earlier booking', async () => {
  const emergencyArgs: unknown[] = [
    { question: 'I smell gas right now' },
    '{"question":"I smell gas right now',
    '{"question":"I smell \\u0067as right now',
    [{ question: 'I smell gas right now' }],
  ]
  const mutate = MemoryCalendarStore.prototype.mutate
  const calendarWrite = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: any) {
    return mutate.call(this, current => {
      const next = fn(current)
      assert.deepEqual(next.bookings, current.bookings)
      return next
    })
  })
  try {
    for (const [i, argumentsValue] of emergencyArgs.entries()) {
      const id = `emergency-malformed-${i}`
      const response = await tools(id, [booking(), { id: 'unknown-emergency', name: 'unknown_tool', arguments: argumentsValue }])
      assert.equal(response.code, 200)
      assert.equal(response.body.results.length, 2)
      for (const r of response.body.results) assertSafety(r.result)
      assert.equal((await state(id)).booking, null)
    }
    assert.equal(calendarWrite.mock.callCount(), emergencyArgs.length)
  } finally { calendarWrite.mock.restore() }
})

test('a transcript emergency persists the pause for later tool requests, and unrelated calls remain usable', async () => {
  const id = 'emergency-transcript-pause'
  const first = await invoke({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'I smell gas', call: { id } })
  assert.equal(first.code, 200)
  const next = await tools(id, [booking(), tool('check_availability', { unitId: '08E' })])
  for (const r of next.body.results) assertSafety(r.result)
  assert.equal((await state(id)).booking, null)
  const other = await tools('emergency-other-caller', [tool('capture_signal', { signal: 'budget', value: '4500', excerpt: '4500 is my budget' })])
  assert.match(other.body.results[0].result, /Got it/)
  assert.equal((await state('emergency-other-caller')).qualification.budget.value.maxMonthly, 4500)
})

test('ordinary pets, fire pits, and smoking questions do not freeze a call', async () => {
  for (const [i, question] of ['Do you allow dogs?', 'Is there a fire pit on the roof?', 'Can I smoke in my apartment?'].entries()) {
    const id = `ordinary-question-${i}`
    const response = await tools(id, [tool('answer_question', { question, topic: 'general_property_fact' }),
      tool('capture_signal', { signal: 'budget', value: '4500', excerpt: '4500 maximum' })])
    assert.doesNotMatch(response.body.results[0].result, /call 911|leasing actions are paused/i)
    assert.match(response.body.results[1].result, /Got it/)
    assert.equal((await state(id)).emergency, null)
  }
})

test('life safety outranks a flooding report elsewhere in the batch', async () => {
  const response = await tools('emergency-severity', [
    tool('answer_question', { question: 'My bathroom is flooding.', topic: 'general_property_fact' }, 'flood'), gas(),
  ])
  for (const r of response.body.results) assertSafety(r.result)
  assert.equal((await state('emergency-severity')).emergency.kind, 'gas')
  const later = await tools('emergency-severity', [tool('answer_question', { question: 'My bathroom is flooding.', topic: 'general_property_fact' })])
  assertSafety(later.body.results[0].result)
  assert.match((await state('emergency-severity')).escalation.detail, /^gas:/)
})

test('legacy emergency state without a structured signal still pauses bookings', async () => {
  const id = 'emergency-legacy-record'
  await tools(id, [tool('capture_signal', { signal: 'budget', value: '4500', excerpt: '4500 maximum' })])
  const prior = await state(id)
  delete prior.emergency
  prior.escalation = { trigger: 'emergency', detail: 'gas: "smell gas"' }
  await documentStoreFromEnv().set(`call:${id}`, prior)
  const response = await tools(id, [booking()])
  assertSafety(response.body.results[0].result)
  assert.equal((await state(id)).booking, null)
})

test('saving a stale ordinary escalation cannot overwrite a concurrently persisted emergency', async () => {
  const id = 'emergency-concurrent-save'
  const original = MemoryDocumentStore.prototype.update
  let inserted = false
  const intercepted = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: unknown, fn: (v: any) => any) {
    if (key === `call:${id}` && !inserted) {
      inserted = true
      await original.call(this, key, initial, (current: any) => ({ ...current,
        emergency: { kind: 'gas', matched: 'smell gas', callEmergencyServices: true },
        escalation: { trigger: 'emergency', detail: 'gas: "smell gas"' },
      }))
    }
    return original.call(this, key, initial, fn)
  })
  try {
    await tools(id, [tool('answer_question', { question: 'Will you approve my service animal?', topic: 'pet_policy' })])
    const saved = await state(id)
    assert.equal(saved.emergency.kind, 'gas')
    assert.equal(saved.escalation.trigger, 'emergency')
    assert.match(saved.escalation.detail, /^gas:/)
  } finally { intercepted.mock.restore() }
})

test('failure of both safety stores returns retryable guidance and never acknowledges persistence or books', async () => {
  const id = 'emergency-store-outage'
  const write = mock.method(MemoryDocumentStore.prototype, 'update', async () => { throw new Error('synthetic store failure') })
  const calendarWrite = mock.method(MemoryCalendarStore.prototype, 'mutate', async () => { throw new Error('must not write') })
  try {
    const response = await tools(id, [booking(), gas()])
    assert.equal(response.code, 503)
    assert.equal(response.body.code, 'emergency_persistence_unavailable')
    for (const r of response.body.results) assertSafety(r.result)
    assert.equal(calendarWrite.mock.callCount(), 1)
    const logs = eventLog.filter(e => e.callId === id)
    assert.ok(logs.some(e => e.kind === 'emergency_record_failed'))
    assert.ok(logs.some(e => e.kind === 'emergency' && e.persisted === false))
    assert.ok(!logs.some(e => e.persisted === true || e.notificationStatus === 'sent'))
  } finally { write.mock.restore(); calendarWrite.mock.restore() }
})
