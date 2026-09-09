import { before, after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { documentStoreFromEnv } from '../../src/store/documents.ts'

// Deterministic replay of failed-call decisions through the real handler. No model,
// speech provider, phone network or external Vapi request participates in this test.
const savedEnv = { ...process.env }, savedFetch = globalThis.fetch
const now = new Date('2026-09-09T19:12:00Z')
const callId = 'synthetic-transcript-regression'
const phone = '+12025550149'
let handler: (req: any, res: any) => Promise<void>
let networkAttempts = 0
const calendar = calendarStoreFromEnv(), documents = documentStoreFromEnv()

before(async () => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'OPS_ACCOUNTS_JSON',
    'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  process.env.VAPI_WEBHOOK_SECRET = 'synthetic-transcript-secret'
  globalThis.fetch = async () => { networkAttempts++; throw new Error('External requests are forbidden in this regression') }
  mock.timers.enable({ apis: ['Date'], now })
  handler = (await import('../vapi.ts')).default
  await calendar.mutate(() => ({ bookings: [], blocks: [] }))
})
after(() => {
  mock.timers.reset()
  globalThis.fetch = savedFetch
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(message: Record<string, unknown>): Promise<any> {
  const res: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this },
    json(body: unknown) { this.body = body; return this } }
  await handler({ method: 'POST', headers: { 'x-vapi-secret': 'synthetic-transcript-secret' },
    body: { message: { call: { id: callId, customer: { number: phone } }, ...message } } }, res)
  assert.equal(res.code, 200, JSON.stringify(res.body))
  return res.body
}
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  return (await invoke({ type: 'tool-calls', toolCallList: [{ id: name, name, arguments: args }] })).results[0].result
}

test('failed-call inputs retain a spending floor, find West Collection homes and book next Wednesday at four', async () => {
  await tool('capture_contact', { name: 'Test Visitor', phone, excerpt: 'My name is Test Visitor.' })
  const quote = await tool('check_availability', { bedrooms: '3', moveIn: 'within now to 3 months', budget: 'over $8. 000' })
  assert.match(quote, /fictional demo catalogue/)
  assert.match(quote, /sample availability/)
  assert.match(quote, /September 1, 2026/)
  assert.match(quote, /29E/)
  assert.match(quote, /33A/)
  assert.match(quote, /Coming up a bit later: Unit 29E/)
  assert.doesNotMatch(quote, /Unit 12A|Unit 19A/)
  const saved = await documents.get<any>(`call:${callId}`)
  assert.deepEqual(saved.qualification.budget.value, { minMonthly: 8000, maxMonthly: null, stated: true })
  assert.equal(saved.qualification.moveInTiming.value.latest, '2026-12-09T19:12:00.000Z')
  const firstSection = quote.slice(0, quote.indexOf('Coming up a bit later:'))
  assert.doesNotMatch(firstSection, /Unit 29E/, 'December 12 must not be presented as inside the December 9 window')

  const explanation = await tool('answer_question', { question: 'Why is there a difference between lease rent and net effective rent?', topic: 'pricing' })
  assert.match(explanation, /average monthly cost/)
  assert.match(explanation, /does not verify when/)
  assert.doesNotMatch(explanation, /get that free month upfront|free month is applied upfront/)

  const expensive = await tool('check_availability', { sortBy: 'price_desc', ignoreBudget: true, includeOutsideMoveIn: true })
  assert.ok(expensive.indexOf('Unit 33A') < expensive.indexOf('Unit 29E'), expensive)
  assert.match(expensive, /higher|highest net effective rent first/)
  const afterBroadening = await documents.get<any>(`call:${callId}`)
  assert.deepEqual(afterBroadening.qualification, saved.qualification, 'Search controls must not erase saved caller preferences')
  const west = await tool('answer_question', { question: "What's the West Collection?", topic: 'general_property_fact' })
  assert.doesNotMatch(west, /do not want to guess|don't have anything called/i)
  for (const unitId of ['29E', '33A', 'C2']) {
    const specific = await tool('check_availability', { unitId })
    assert.match(specific, unitId === 'C2' ? /29E[\s\S]*33A|33A[\s\S]*29E/ : new RegExp(`Residence ${unitId} is available`))
    assert.doesNotMatch(specific, /not currently available|no residence/i)
  }

  const times = await tool('list_tour_slots', { preferredDate: '2026-09-16', preferredTime: '16:00', unitId: '19A' })
  assert.match(times, /slot-2026-09-16T20:00 — Wednesday, September 16, 2026 at 4:00 PM/)
  const confirmed = await tool('book_tour', { slotId: 'slot-2026-09-16T20:00', unitId: '19A', prospectName: 'Test Visitor' })
  assert.match(confirmed, /tour is confirmed|all set/i)
  const booked = (await calendar.read()).bookings
  assert.equal(booked.length, 1)
  assert.equal(booked[0]!.startsAt, '2026-09-16T20:00:00.000Z')
  await invoke({ type: 'end-of-call-report', endedAt: now.toISOString() })
  const profile = await documents.get<any>(`lead:${phone}`)
  assert.deepEqual(profile.signals.budgetRange.value, { minMonthly: 8000, maxMonthly: null })
  assert.equal(profile.signals.budget, undefined)
  assert.equal(networkAttempts, 0)
})
