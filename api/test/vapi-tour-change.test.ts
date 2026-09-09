import { after, before, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { generateSlots } from '../../src/calendar/slots.ts'
import { listTourChangeRequests, TOUR_CHANGE_UNSAVED } from '../../src/leads/tour-change.ts'
import { TOOL_DEFINITIONS } from '../../src/vapi/assistant.ts'
import { systemPrompt } from '../../src/vapi/prompt.ts'

const savedEnv = { ...process.env }, originalFetch = globalThis.fetch
const docs = documentStoreFromEnv(), calendar = calendarStoreFromEnv()
let handler: (req: any, res: any) => Promise<void>
before(async () => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  globalThis.fetch = async () => { throw new Error('Callback regressions prohibit external network') }
  handler = (await import('../vapi.ts')).default
})
beforeEach(async () => {
  await calendar.mutate(() => ({ blocks: [], bookings: [] }))
  for (const key of await docs.list('')) await docs.delete(key)
})
after(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})
const phone = '+12025550199'
const call = (id: string, number = phone) => ({ id, customer: { number } })
const tool = (id: string, name: string, args: unknown) => ({ id, name, arguments: args })
async function invoke(message: Record<string, unknown>) {
  const res: any = { code: 0, body: null, headers: {}, setHeader(k: string, v: unknown) { this.headers[k] = v },
    status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
  await handler({ method: 'POST', headers: {}, body: { message } }, res)
  return res
}
const slots = () => { const all = generateSlots(new Date()); assert.ok(all.length > 5); return [all[1]!, all[5]!] as const }
const book = (slot: ReturnType<typeof slots>[number], id = 'book') => tool(id, 'book_tour', { slotId: slot.slotId, prospectName: 'Synthetic Visitor', unitId: '08E' })
const tools = (id: string, list: unknown[], number = phone) => invoke({ type: 'tool-calls', call: call(id, number), toolCallList: list })
const end = (id: string) => invoke({ type: 'end-of-call-report', call: call(id) })
async function seedOriginal() {
  const [original, alternative] = slots()
  assert.equal((await tools('original-call', [book(original)])).code, 200)
  assert.equal((await calendar.read()).bookings.length, 1)
  return { original: structuredClone((await calendar.read()).bookings[0]!), alternative }
}

test('callback reschedule preserves original tour and durable staff request through completion and retries', async () => {
  const { original, alternative } = await seedOriginal(), id = 'reschedule-callback'
  const transcript = 'I already booked a tour. I need to reschedule my tour to Wednesday at four.'
  assert.equal((await invoke({ type: 'transcript', transcriptType: 'final', role: 'user', transcript, call: call(id) })).code, 200)
  const request = [tool('contact', 'capture_contact', { name: 'Synthetic Visitor', phone, excerpt: transcript, requestType: 'tour_change' }), book(alternative)]
  const response = await tools(id, request)
  assert.equal(response.code, 200)
  assert.match(response.body.results[1].result, /saved for staff review/)
  assert.doesNotMatch(response.body.results[1].result, /tour is confirmed|I've moved|notification was sent/i)
  assert.deepEqual((await calendar.read()).bookings, [original])
  const first = (await listTourChangeRequests(docs))[0]!
  assert.equal(first.identityVerified, false)
  assert.equal(first.notificationStatus, 'not_sent')
  assert.equal((await end(id)).code, 200)
  assert.equal((await end(id)).code, 200)
  assert.equal((await tools(id, request)).code, 200)
  assert.equal((await listTourChangeRequests(docs)).length, 1)
  assert.equal((await listTourChangeRequests(docs))[0]!.firstRequestedAt, first.firstRequestedAt)
  const profile = await docs.get<any>(`lead:${phone}`)
  assert.equal(profile.escalations.filter((e: any) => e.trigger === 'tour_change').length, 1)
  const followups = await Promise.all((await docs.list('followup:')).map(key => docs.get<any>(key)))
  assert.equal(followups.filter(f => f.kind === 'callback' && f.createdFromCall === id).length, 0,
    'the dedicated durable request owns staff review; do not create a second task')
  assert.deepEqual((await calendar.read()).bookings, [original])
})

test('whole-batch screening blocks an earlier booking even with malformed later tour-change arguments', async () => {
  const { original, alternative } = await seedOriginal()
  const response = await tools('batch-change', [book(alternative), tool('question', 'unknown_tool', '{"question":"Please reschedule my tour"')], '+12025550177')
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /staff review/)
  assert.deepEqual((await calendar.read()).bookings, [original])
  assert.equal((await listTourChangeRequests(docs)).length, 1)
})

test('different future booking for same normalized phone is refused without revealing original details', async () => {
  const { original, alternative } = await seedOriginal()
  const response = await tools('new-time-same-phone', [book(alternative)], '(202) 555-0199')
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /staff review/)
  for (const privateValue of [original.externalId, original.slotId, original.unitId!, original.prospectName]) assert.ok(!response.body.results[0].result.includes(privateValue))
  assert.deepEqual((await calendar.read()).bookings, [original])
  assert.equal((await listTourChangeRequests(docs))[0]?.reason, 'existing_future_tour')
})

test('same-slot retry from another call resolves original booking without a change request', async () => {
  const [original] = slots()
  assert.equal((await tools('book-first', [book(original)])).code, 200)
  const retry = await tools('book-retry', [book(original)])
  assert.equal(retry.code, 200)
  assert.match(retry.body.results[0].result, /tour is confirmed/)
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await listTourChangeRequests(docs)).length, 0)
})

test('competing new calls for one prospect cannot create two future tours', async () => {
  const [one, two] = slots()
  const responses = await Promise.all([tools('race-one', [book(one)]), tools('race-two', [book(two)])])
  assert.equal(responses.filter(r => /tour is confirmed/.test(r.body.results[0].result)).length, 1)
  assert.equal(responses.filter(r => /staff review/.test(r.body.results[0].result)).length, 1)
  assert.equal((await calendar.read()).bookings.length, 1)
})

test('request-write failure never claims saved and exact tool retry repairs the durable staff record', async () => {
  const { original, alternative } = await seedOriginal()
  const update = MemoryDocumentStore.prototype.update
  let fail = true
  const mocked = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    if (fail && key.startsWith('tour-change:')) throw new Error('Synthetic request storage outage')
    return update.call(this, key, initial, fn)
  })
  try {
    const response = await tools('request-failure', [book(alternative)])
    assert.equal(response.code, 503)
    assert.equal(response.body.results[0].result, TOUR_CHANGE_UNSAVED)
    assert.equal((await listTourChangeRequests(docs)).length, 0)
    assert.deepEqual((await calendar.read()).bookings, [original])
    assert.equal((await end('request-failure')).code, 200)
    fail = false
    const retried = await tools('request-failure', [book(alternative)])
    assert.equal(retried.code, 200)
    assert.match(retried.body.results[0].result, /saved for staff review/)
    assert.equal((await listTourChangeRequests(docs)).length, 1)
  } finally { mocked.mock.restore() }
})

test('late final transcript after call completion is independently saved for staff review', async () => {
  const id = 'late-callback'
  assert.equal((await end(id)).code, 200)
  const response = await invoke({ type: 'transcript', role: 'user', transcriptType: 'final', call: call(id), transcript: 'Please cancel my existing tour.' })
  assert.equal(response.code, 200)
  assert.equal((await listTourChangeRequests(docs))[0]!.callId, id)
  assert.equal((await docs.get<any>(`call:${id}`)).work.phase, 'complete')
})

test('seven-tool schema and prompt separate staff review from a verified tour move', () => {
  assert.equal(TOOL_DEFINITIONS.length, 7)
  const capture = TOOL_DEFINITIONS[0]
  assert.equal(capture.function.name, 'capture_contact')
  assert.deepEqual(capture.function.parameters.properties.requestType.enum, ['tour_change'])
  const prompt = systemPrompt({ buildingName: 'Synthetic', address: '1 Test', neighborhood: 'Test', leasingHours: 'Varies', managementCompany: 'Test' })
  assert.match(prompt, /requestType: "tour_change"/)
  assert.match(prompt, /Staff must verify identity/)
  assert.match(prompt, /Only say the request was saved after the tool verifies persistence/)
})
