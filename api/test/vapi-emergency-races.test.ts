import { after, before, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { MemoryCalendarStore, calendarStoreFromEnv } from '../../src/calendar/store.ts'
import type { CalendarState } from '../../src/calendar/types.ts'
import { generateSlots } from '../../src/calendar/slots.ts'

const savedEnv = { ...process.env }
const originalFetch = globalThis.fetch
const documents = documentStoreFromEnv()
const calendar = calendarStoreFromEnv()
let handler: (req: any, res: any) => Promise<void>

before(async () => {
  for (const key of ['OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  // This test process uses only real handler logic and isolated memory stores.
  // A forgotten external dependency must fail rather than contact a live service.
  globalThis.fetch = async () => { throw new Error('Emergency regression test denies external network') }
  handler = (await import('../vapi.ts')).default
})
beforeEach(async () => { await calendar.mutate(() => ({ blocks: [], bookings: [] })) })
after(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(message: Record<string, unknown>) {
  const res: any = { code: 0, body: null, setHeader() {},
    status(code: number) { this.code = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  await handler({ method: 'POST', headers: {}, body: { message } }, res)
  return res
}
const tool = (name: string, args: Record<string, unknown>) => ({ id: name, name, arguments: args })
const tools = (id: string, toolCallList: unknown[]) => invoke({ type: 'tool-calls', call: { id }, toolCallList })
const transcript = (id: string) => invoke({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'I smell gas', call: { id } })
const gas = () => tool('answer_question', { question: 'I smell gas', topic: 'general_property_fact' })
function booking() {
  const slot = generateSlots(new Date()).at(-1)
  assert.ok(slot, 'exercise a real bookable slot rather than a request that would fail independently')
  return tool('book_tour', { slotId: slot.slotId, prospectName: 'Synthetic Safety Review', prospectEmail: 'safety-review@example.com' })
}
function assertNoConfirmation(response: any) {
  for (const result of response.body.results ?? []) assert.doesNotMatch(String(result.result), /tour is confirmed|you.re all set/i)
}
function assertGasGuidance(response: any) {
  assert.ok(response.body.results?.length)
  for (const { result } of response.body.results) {
    assert.match(String(result), /outside.*call 911/i)
    assert.match(String(result), /have not contacted emergency services or building staff/)
    assert.doesNotMatch(String(result), /offer.*callback|call them back|take their number|tour is confirmed/i)
  }
}

test('caller evidence in capture_loss_reason pre-empts a preceding booking', async () => {
  const id = 'emergency-regression-evidence'
  const response = await tools(id, [booking(), tool('capture_loss_reason', {
    kind: 'policy', detail: 'Caller must leave the apartment', evidence: 'I smell gas now',
  })])
  assert.equal((await calendar.read()).bookings.length, 0, 'caller evidence must be screened before any booking in the batch')
  assertNoConfirmation(response)
  assert.equal((await documents.get<any>(`call:${id}`)).emergency?.kind, 'gas')
})

test('a malformed nested question cannot allow booking after emergency guidance in the same batch', async () => {
  const id = 'emergency-regression-nested-question'
  const response = await tools(id, [tool('answer_question', {
    question: ['I smell gas'], topic: 'general_property_fact',
  }), booking()])
  assert.equal((await calendar.read()).bookings.length, 0, 'schema-invalid caller text must not bypass pre-screening or the remaining-tool pause')
  assertNoConfirmation(response)
})

test('an emergency committed after a booking request read prevents that request from booking', async () => {
  const id = 'emergency-regression-concurrent-read'
  const original = MemoryDocumentStore.prototype.get
  let emergencyCommitted = false
  const get = mock.method(MemoryDocumentStore.prototype, 'get', async function(this: MemoryDocumentStore, key: string) {
    const stale = await original.call(this, key)
    if (key === `call:${id}` && !emergencyCommitted) {
      // The pending request already read the old record. A separate transcript
      // request completes its durable-state-equivalent write before it resumes.
      emergencyCommitted = true
      assert.equal((await transcript(id)).code, 200)
    }
    return stale
  })
  let response: any
  try { response = await tools(id, [booking()]) }
  finally { get.mock.restore() }
  assert.equal(emergencyCommitted, true)
  assert.equal((await documents.get<any>(`call:${id}`)).emergency?.kind, 'gas', 'the emergency really committed before the pending booking resumed')
  assert.equal((await calendar.read()).bookings.length, 0, 'merging an emergency flag after the calendar write is too late')
  assertNoConfirmation(response)
})

test('a failed emergency write does not permit later same-call booking when storage recovers', async () => {
  const id = 'emergency-regression-recovery'
  const original = MemoryDocumentStore.prototype.update
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: unknown, fn: (state: any) => any) {
    if (key === `call:${id}`) throw new Error('Synthetic emergency persistence outage')
    return original.call(this, key, initial, fn)
  })
  let urgent: any
  try { urgent = await tools(id, [gas()]) }
  finally { update.mock.restore() }
  assert.match(urgent.body.results?.[0]?.result ?? '', /outside.*call 911/i, 'the outage must not suppress immediate guidance')
  assert.match(urgent.body.results[0].result, /have not contacted emergency services or building staff/)
  assert.equal(await documents.get(`call:${id}`), null, 'the simulated emergency write truly failed')
  const recovered = await tools(id, [booking()])
  assert.equal((await calendar.read()).bookings.length, 0, 'recovery must not silently clear the emergency pause acknowledged to this call')
  assertNoConfirmation(recovered)
})

test('a stronger call emergency survives a failed hold upgrade and repairs the weaker calendar hold', async () => {
  const id = 'emergency-regression-stronger-call-state'
  await tools(id, [tool('answer_question', { question: 'My bathroom is flooding', topic: 'general_property_fact' })])
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async () => { throw new Error('Synthetic hold upgrade failure') })
  let upgraded: any
  try { upgraded = await tools(id, [gas()]) }
  finally { mutation.mock.restore() }
  assert.equal(upgraded.code, 503)
  assertGasGuidance(upgraded)
  assert.equal((await documents.get<any>(`call:${id}`)).emergency?.kind, 'gas')
  assert.equal((await calendar.read()).emergencyHolds?.find(hold => hold.interactionId === id)?.kind, 'flooding')
  const later = await tools(id, [tool('check_availability', {})])
  assert.equal(later.code, 200)
  assertGasGuidance(later)
  assert.equal((await calendar.read()).emergencyHolds?.find(hold => hold.interactionId === id)?.kind, 'gas')
  assert.deepEqual((await calendar.read()).bookings, [])
})

test('a call-record save failure after a concurrent safety pause preserves guidance with a retryable response', async () => {
  const id = 'emergency-regression-post-pause-save-failure'
  const originalGet = MemoryDocumentStore.prototype.get, originalUpdate = MemoryDocumentStore.prototype.update
  let emergencyCommitted = false, failSave = false, failedSaves = 0
  const get = mock.method(MemoryDocumentStore.prototype, 'get', async function(this: MemoryDocumentStore, key: string) {
    const stale = await originalGet.call(this, key)
    if (key === `call:${id}` && !emergencyCommitted) {
      emergencyCommitted = true
      assert.equal((await transcript(id)).code, 200)
      failSave = true
    }
    return stale
  })
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: unknown, fn: (state: any) => any) {
    if (key === `call:${id}` && failSave) { failedSaves++; throw new Error('Synthetic final call projection failure') }
    return originalUpdate.call(this, key, initial, fn)
  })
  let response: any
  try { response = await tools(id, [booking()]) }
  finally { get.mock.restore(); update.mock.restore() }
  assert.equal(failedSaves, 1, 'fail only the final save after the independent emergency request committed')
  assert.equal(response.code, 503)
  assert.equal(response.body.code, 'emergency_persistence_unavailable')
  assertGasGuidance(response)
  assert.equal((await calendar.read()).emergencyHolds?.find(hold => hold.interactionId === id)?.kind, 'gas')
  assert.deepEqual((await calendar.read()).bookings, [])
})

test('the booking pause carries safety guidance without needing another readable calendar', async () => {
  const id = 'emergency-regression-post-pause-read-failure'
  const originalGet = MemoryDocumentStore.prototype.get
  const originalRead = MemoryCalendarStore.prototype.read, originalMutate = MemoryCalendarStore.prototype.mutate
  let emergencyCommitted = false, bookingPaused = false, readsAfterPause = 0
  const get = mock.method(MemoryDocumentStore.prototype, 'get', async function(this: MemoryDocumentStore, key: string) {
    const stale = await originalGet.call(this, key)
    if (key === `call:${id}` && !emergencyCommitted) {
      emergencyCommitted = true
      assert.equal((await transcript(id)).code, 200)
    }
    return stale
  })
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: (state: CalendarState) => CalendarState) {
    try { return await originalMutate.call(this, fn) }
    catch (error) {
      if (error instanceof Error && error.message === 'CALENDAR_INTERACTION_PAUSED') bookingPaused = true
      throw error
    }
  })
  const read = mock.method(MemoryCalendarStore.prototype, 'read', async function(this: MemoryCalendarStore) {
    if (bookingPaused) { readsAfterPause++; throw new Error('Synthetic calendar read outage after guard rejection') }
    return originalRead.call(this)
  })
  let response: any
  try { response = await tools(id, [booking()]) }
  finally { get.mock.restore(); mutation.mock.restore(); read.mock.restore() }
  assert.equal(bookingPaused, true, 'the real calendar callback rejected the pending stale booking')
  assert.equal(readsAfterPause, 0, 'the already-known signal must not depend on another calendar read')
  assert.equal(response.code, 200)
  assertGasGuidance(response)
  assert.deepEqual((await calendar.read()).bookings, [])
})
