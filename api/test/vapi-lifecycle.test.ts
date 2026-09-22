import { after, before, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { MemoryCalendarStore, calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { generateSlots } from '../../src/calendar/slots.ts'
import type { CalendarState } from '../../src/calendar/types.ts'

const savedEnv = { ...process.env }, originalFetch = globalThis.fetch
const documents = documentStoreFromEnv(), calendar = calendarStoreFromEnv()
const FINISHED_AT = new Date().toISOString()
let handler: (req: any, res: any) => Promise<void>
before(async () => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  globalThis.fetch = async () => { throw new Error('Lifecycle regression tests forbid external network') }
  handler = (await import('../vapi.ts')).default
})
beforeEach(async () => { await calendar.mutate(() => ({ blocks: [], bookings: [] })) })
after(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(message: Record<string, unknown>) {
  const response: any = { code: 0, body: null, headers: {},
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value) },
    status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this },
  }
  await handler({ method: 'POST', headers: {}, body: { message } }, response)
  return response
}
const call = (id: string, phone = '+15555550101') => ({ id, customer: { number: phone } })
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args })
const contact = (id = 'contact-tool') => tool(id, 'capture_contact', {
  name: 'Synthetic Prospect', email: 'synthetic@example.com', excerpt: 'My email is synthetic@example.com',
})
const tools = (id: string, list: unknown[], phone = '+15555550101') => invoke({ type: 'tool-calls', call: call(id, phone), toolCallList: list })
const end = (id: string, phone = '+15555550101') => invoke({ type: 'end-of-call-report', call: call(id, phone), endedAt: FINISHED_AT })
const retryEnd = (id: string) => invoke({ type: 'end-of-call-report', call: { id } })
function booking() {
  const slot = generateSlots(new Date()).at(-1)
  assert.ok(slot, 'use a real open future slot, not a booking that would fail independently')
  return tool('booking-tool', 'book_tour', { slotId: slot.slotId, prospectName: 'Synthetic Prospect' })
}
function assertWaiting(response: any) {
  assert.equal(response.code, 503)
  assert.ok(Number(response.headers['retry-after']) > 0)
}

test('end report waits for admitted booking and contact, then the last tool projects both without a second end report', async () => {
  const id = 'lifecycle-booking-contact-overlap', phone = '+15555550111'
  const original = MemoryCalendarStore.prototype.mutate
  let interleaved = false, pendingEnd: any, observedEnding: any
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function (this: MemoryCalendarStore, fn: (state: CalendarState) => CalendarState) {
    const stored = await original.call(this, fn)
    if (!interleaved && stored.bookings.length > 0) {
      interleaved = true
      // The calendar has really committed, but bookTour readback and saveCall have
      // not finished. A different webhook instance processes the end report now.
      pendingEnd = await end(id, phone)
      observedEnding = await documents.get(`call:${id}`)
    }
    return stored
  })
  let response: any
  try { response = await tools(id, [contact(), booking()], phone) }
  finally { mutation.mock.restore() }
  assert.equal(interleaved, true)
  assertWaiting(pendingEnd)
  assert.equal(observedEnding.work.phase, 'ending')
  assert.equal(observedEnding.completedAt, undefined)
  assert.equal(response.code, 200)
  assert.match(response.body.results[1].result, /tour is confirmed/i)
  assert.equal((await calendar.read()).bookings.length, 1)
  const drained: any = await documents.get(`call:${id}`)
  assert.ok(drained.work.intents.every((intent: any) => ['complete', 'blocked'].includes(intent.status)))
  assert.equal(drained.work.phase, 'complete', 'the original end report must drain without provider redelivery')
  assert.equal((await documents.get<any>(`call-receipt:${id}`)).status, 'complete')
  const profile: any = await documents.get(`lead:${phone}`)
  assert.equal(profile.bookings.length, 1)
  assert.equal(profile.bookings[0].status, 'confirmed')
  assert.equal(profile.email, 'synthetic@example.com')
  assert.equal(profile.calls.filter((item: any) => item.callId === id).length, 1)
  assert.equal(profile.calls.find((item: any) => item.callId === id).at, FINISHED_AT)
  const completed: any = await documents.get(`call:${id}`)
  assert.equal(completed.work.phase, 'complete')
  assert.equal(completed.phone, phone)
  assert.equal(completed.work.end.endedAt, FINISHED_AT)
  assert.equal((await retryEnd(id)).code, 200)
  assert.equal((await calendar.read()).bookings.length, 1)
})

test('a contact completion admitted before the end report persists through ending and its frozen snapshot', async () => {
  const id = 'lifecycle-contact-save-overlap', phone = '+15555550112'
  const originalUpdate = MemoryDocumentStore.prototype.update, originalGet = MemoryDocumentStore.prototype.get
  let interleaved = false, pendingEnd: any
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function (this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    const current: any = key === `call:${id}` ? await originalGet.call(this, key) : null
    if (!interleaved && current?.work?.intents.some((intent: any) => intent.id === 'contact-tool' && intent.status === 'admitted')) {
      interleaved = true
      pendingEnd = await end(id, phone)
    }
    return originalUpdate.call(this, key, initial, fn)
  })
  let response: any
  try { response = await tools(id, [contact()], phone) }
  finally { update.mock.restore() }
  assert.equal(interleaved, true, 'pause after admission, before the contact completion update')
  assertWaiting(pendingEnd)
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /contact details saved/i)
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'complete')
  const profile: any = await documents.get(`lead:${phone}`)
  assert.equal(profile.name, 'Synthetic Prospect')
  assert.equal(profile.email, 'synthetic@example.com')
  assert.equal(profile.calls.find((item: any) => item.callId === id).at, FINISHED_AT)
  assert.equal((await retryEnd(id)).code, 200)
})

test('completed tool redelivery uses cached results without duplicate captures, including after call completion', async () => {
  const id = 'lifecycle-completed-tool-cache', phone = '+15555550113'
  const first = await tools(id, [contact()], phone)
  assert.equal(first.code, 200)
  const before: any = await documents.get(`call:${id}`)
  const duplicate = await tools(id, [contact()], phone)
  const after: any = await documents.get(`call:${id}`)
  assert.deepEqual(duplicate.body.results, first.body.results)
  assert.equal(after.work.revision, before.work.revision)
  assert.equal(after.work.intents.length, 1)
  assert.deepEqual(after.toolsCalled, before.toolsCalled)
  assert.equal((await end(id, phone)).code, 200)
  const completedDuplicate = await tools(id, [contact()], phone)
  assert.deepEqual(completedDuplicate.body.results, first.body.results)
  const profile: any = await documents.get(`lead:${phone}`)
  assert.equal(profile.calls.filter((item: any) => item.callId === id).length, 1)
})

test('changed arguments under an existing tool ID conflict instead of silently overwriting contact data', async () => {
  const id = 'lifecycle-tool-identity-conflict', phone = '+15555550114'
  assert.equal((await tools(id, [contact()], phone)).code, 200)
  const conflicting = await tools(id, [tool('contact-tool', 'capture_contact', {
    name: 'Different Person', email: 'different@example.com', excerpt: 'Use a different contact',
  })], phone)
  assert.equal(conflicting.code, 409)
  assert.equal(conflicting.body.code, 'call_tool_identity_conflict')
  const stored: any = await documents.get(`call:${id}`)
  assert.equal(stored.email, 'synthetic@example.com')
  assert.equal(stored.work.intents.length, 1)
})

test('a booking redelivery while dispatch is in flight stays busy and cannot create another calendar entry', async () => {
  const id = 'lifecycle-inflight-tool-busy', phone = '+15555550115', request = booking()
  const original = MemoryCalendarStore.prototype.mutate
  let interleaved = false, duplicate: any
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function (this: MemoryCalendarStore, fn: (state: CalendarState) => CalendarState) {
    const stored = await original.call(this, fn)
    if (!interleaved && stored.bookings.length > 0) {
      interleaved = true
      duplicate = await tools(id, [request], phone)
    }
    return stored
  })
  let response: any
  try { response = await tools(id, [request], phone) }
  finally { mutation.mock.restore() }
  assert.equal(interleaved, true)
  assertWaiting(duplicate)
  assert.equal(duplicate.body.code, 'call_work_busy')
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /tour is confirmed/i)
  assert.equal((await calendar.read()).bookings.length, 1)
})

test('finished report retries preserve accepted identity and explicitly reject contradictory phone or timestamp', async () => {
  const id = 'lifecycle-finished-identity-conflict', phone = '+15555550116'
  assert.equal((await tools(id, [contact()], phone)).code, 200)
  assert.equal((await end(id, phone)).code, 200)
  const accepted: any = await documents.get(`call:${id}`)
  assert.equal((await retryEnd(id)).code, 200)
  const same: any = await documents.get(`call:${id}`)
  assert.deepEqual(same.work.end, accepted.work.end)
  assert.equal(same.phone, phone)
  const changedPhone = await invoke({ type: 'end-of-call-report', call: call(id, '+15555550999'), endedAt: FINISHED_AT })
  assert.equal(changedPhone.code, 409)
  assert.equal(changedPhone.body.code, 'call_event_identity_conflict')
  const changedTime = await invoke({ type: 'end-of-call-report', call: call(id, phone), endedAt: new Date(Date.parse(FINISHED_AT) + 60000).toISOString() })
  assert.equal(changedTime.code, 409)
  assert.equal(changedTime.body.code, 'call_event_identity_conflict')
  assert.equal(await documents.get('lead:+15555550999'), null)
  assert.deepEqual((await documents.get<any>(`call:${id}`)).work.end, accepted.work.end)
})

test('new work after a completed call is refused before any calendar side effect', async () => {
  const id = 'lifecycle-new-tool-after-close', phone = '+15555550117'
  assert.equal((await end(id, phone)).code, 200)
  const response = await tools(id, [booking()], phone)
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /already ended|no action was taken/i)
  assert.equal((await calendar.read()).bookings.length, 0)
})

test('failed automatic projection retains truthful booking results and a cached tool retry finishes the frozen call', async () => {
  const id = 'lifecycle-auto-projection-outage', phone = '+15555550118', request = booking()
  const originalMutation = MemoryCalendarStore.prototype.mutate, originalUpdate = MemoryDocumentStore.prototype.update
  let interleaved = false, pendingEnd: any
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function (this: MemoryCalendarStore, fn: (state: CalendarState) => CalendarState) {
    const stored = await originalMutation.call(this, fn)
    if (!interleaved && stored.bookings.length) { interleaved = true; pendingEnd = await end(id, phone) }
    return stored
  })
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function (this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    if (key === `lead:${phone}`) throw new Error('Synthetic projection failure')
    return originalUpdate.call(this, key, initial, fn)
  })
  let response: any
  try { response = await tools(id, [request], phone) }
  finally { mutation.mock.restore(); update.mock.restore() }
  assertWaiting(pendingEnd)
  assertWaiting(response)
  assert.equal(response.body.code, 'call_projection_pending')
  assert.match(response.body.results[0].result, /tour is confirmed/i, 'the calendar readback succeeded even though CRM projection failed')
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'frozen')
  assert.equal((await documents.get<any>(`call-receipt:${id}`)).status, 'pending')
  assert.equal(await documents.get(`lead:${phone}`), null)
  const retry = await tools(id, [request], phone)
  assert.equal(retry.code, 200)
  assert.deepEqual(retry.body.results, response.body.results)
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'complete')
  assert.equal((await documents.get<any>(`call-receipt:${id}`)).status, 'complete')
  assert.equal((await documents.get<any>(`lead:${phone}`)).bookings.length, 1)
  assert.equal((await calendar.read()).bookings.length, 1)
})

test('malformed optional report timestamps never become fabricated event dates and fallback remains stable on retry', async () => {
  const malformed: unknown[] = ['2026-02-30T12:00:00Z', 'https://example.test/2026-01-01', 0, { time: FINISHED_AT }]
  for (const [index, badTime] of malformed.entries()) {
    const id = `lifecycle-invalid-report-date-${index}`
    const before = Date.now()
    const response = await invoke({ type: 'end-of-call-report', call: call(id), endedAt: badTime, startedAt: badTime })
    const after = Date.now()
    assert.equal(response.code, 200)
    const accepted: any = await documents.get(`call:${id}`)
    assert.equal(accepted.work.end.startedAt, null)
    assert.equal(accepted.work.end.durationSeconds, null)
    assert.ok(Date.parse(accepted.work.end.endedAt) >= before && Date.parse(accepted.work.end.endedAt) <= after)
    assert.equal(accepted.work.end.endedAt, accepted.work.end.receivedAt)
    assert.equal((await retryEnd(id)).code, 200)
    assert.deepEqual((await documents.get<any>(`call:${id}`)).work.end, accepted.work.end)
  }
})

test('a late emergency during failed frozen projection survives completion as a durable staff report with no notification claim', async () => {
  const id = 'lifecycle-late-frozen-emergency', phone = '+15555550119'
  assert.equal((await tools(id, [contact()], phone)).code, 200)
  const originalUpdate = MemoryDocumentStore.prototype.update
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function (this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    if (key === `lead:${phone}`) throw new Error('Synthetic frozen projection failure')
    return originalUpdate.call(this, key, initial, fn)
  })
  let failed: any
  try { failed = await end(id, phone) }
  finally { update.mock.restore() }
  assertWaiting(failed)
  const frozen: any = await documents.get(`call:${id}`)
  assert.equal(frozen.work.phase, 'frozen')
  const urgent = await invoke({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'I smell gas', call: call(id, phone) })
  assert.equal(urgent.code, 200)
  const incident: any = await documents.get(`call-safety:${id}`)
  assert.equal(incident.signal.kind, 'gas')
  assert.equal(incident.needsReview, true)
  assert.equal(incident.notificationStatus, 'not_sent')
  assert.equal((await documents.get<any>(`call:${id}`)).work.frozenRevision, frozen.work.frozenRevision)
  assert.equal((await retryEnd(id)).code, 200)
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'complete')
  assert.deepEqual(await documents.get(`call-safety:${id}`), incident)
  assert.equal((await calendar.read()).emergencyHolds?.find(hold => hold.interactionId === id)?.kind, 'gas')
  process.env.OPS_DASHBOARD_PASSCODE = 'synthetic-incident-review-passcode'
  const response: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
  await handler({ method: 'GET', headers: { 'x-ops-passcode': process.env.OPS_DASHBOARD_PASSCODE } }, response)
  assert.equal(response.code, 200)
  const visible = response.body.events.find((event: any) => event.callId === id && event.durable === true)
  assert.ok(visible, 'the retained event must be visible through the authenticated operator API')
  assert.equal(visible.notificationStatus, 'not_sent')
  assert.equal(visible.needsReview, true)
})
