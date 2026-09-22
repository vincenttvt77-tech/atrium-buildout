import { after, before, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { MemoryCalendarStore, calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { generateSlots } from '../../src/calendar/slots.ts'
import type { CalendarState } from '../../src/calendar/types.ts'

const savedEnv = { ...process.env }, originalFetch = globalThis.fetch
const documents = documentStoreFromEnv(), calendar = calendarStoreFromEnv()
let handler: (req: any, res: any) => Promise<void>
before(async () => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  globalThis.fetch = async () => { throw new Error('External network forbidden') }
  handler = (await import('../vapi.ts')).default
})
beforeEach(async () => { await calendar.mutate(() => ({ blocks: [], bookings: [] })) })
after(() => { globalThis.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv) })
const phone = '+15555550300'
async function invoke(message: any, method = 'POST') {
  const response: any = { code: 0, body: null, headers: {}, setHeader(k: string, v: string) { this.headers[k] = v },
    status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
  await handler({ method, headers: method === 'GET' ? { 'x-ops-passcode': 'synthetic-review-passcode' } : {}, body: { message } }, response)
  return response
}
const contact = (id = 'contact') => ({ id, name: 'capture_contact', arguments: { name: 'Review Prospect', phone: '+15555550301',
  email: 'review@example.test', excerpt: 'Please call my other number at 555 555 0301' } })
const booking = () => ({ id: 'book', name: 'book_tour', arguments: { slotId: generateSlots(new Date()).at(-1)!.slotId,
  unitId: '19A', prospectName: 'Review Prospect' } })
const tools = (id: string, list: unknown[]) => invoke({ type: 'tool-calls', call: { id, customer: { number: phone } }, toolCallList: list })
const end = (id: string) => invoke({ type: 'end-of-call-report', call: { id, customer: { number: phone } } })
function uncertainCalendar() {
  const originalMutate = MemoryCalendarStore.prototype.mutate, originalRead = MemoryCalendarStore.prototype.read
  let landed = false
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: (s: CalendarState) => CalendarState) {
    const value = await originalMutate.call(this, fn); if (value.bookings.length) landed = true; return value
  })
  const reading = mock.method(MemoryCalendarStore.prototype, 'read', async function(this: MemoryCalendarStore) {
    if (landed) throw new Error('Synthetic calendar read outage')
    return originalRead.call(this)
  })
  return () => { mutation.mock.restore(); reading.mock.restore() }
}

test('a definite pre-write booking failure saves contact, completes the lead and creates staff callback work', async () => {
  const id = 'recovery-definite-failure', request = booking()
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async () => { throw new Error('Synthetic pre-write failure') })
  let response: any
  try { response = await tools(id, [request, contact()]) } finally { mutation.mock.restore() }
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /couldn.t confirm/i)
  assert.match(response.body.results[1].result, /Contact details saved/)
  assert.equal((await calendar.read()).bookings.length, 0)
  assert.equal((await end(id)).code, 200)
  const profile: any = await documents.get(`lead:${phone}`)
  assert.ok(profile.calls.some((c: any) => c.callId === id))
  assert.equal(profile.callbackPhone.value, '+15555550301')
  assert.ok(profile.escalations.some((e: any) => e.callId === id && e.trigger === 'booking_failed'))
  const followUps = await Promise.all((await documents.list('followup:')).map(key => documents.get<any>(key)))
  assert.ok(followUps.some(f => f.createdFromCall === id && f.kind === 'callback' && f.executable === false))
  assert.equal((await tools(id, [request])).code, 200)
  assert.equal((await calendar.read()).bookings.length, 0, 'replay of a known failure must not silently create a tour')
})

test('lost create acknowledgement recovers one exact booking without repeating its write', async () => {
  const id = 'recovery-lost-calendar-ack', original = MemoryCalendarStore.prototype.mutate
  let writes = 0
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: (s: CalendarState) => CalendarState) {
    const saved = await original.call(this, fn); writes++; throw new Error('Synthetic lost write acknowledgement')
  })
  let response: any
  try { response = await tools(id, [booking()]) } finally { mutation.mock.restore() }
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /tour is confirmed/i)
  assert.equal(writes, 1)
  assert.equal((await calendar.read()).bookings.length, 1)
})

test('uncertain booking keeps same-batch and later callback details visible while refusing another booking', async () => {
  const id = 'recovery-uncertain', request = booking(), restore = uncertainCalendar()
  let response: any, followup: any
  try {
    response = await tools(id, [request, contact()])
    followup = await tools(id, [contact('contact-again')])
  } finally { restore() }
  assert.equal(response.code, 503)
  assert.match(response.body.results[0].result, /isn.t confirmed/i)
  assert.match(response.body.results[1].result, /Contact details saved/)
  assert.equal(followup.code, 200, 'contact-only recovery works during calendar outage')
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'needs_review')
  const review: any = await documents.get(`booking-review:${id}`)
  assert.equal(review.phone, phone)
  assert.equal(review.callbackPhone.value, '+15555550301')
  assert.equal(review.email, 'review@example.test')
  assert.equal(review.booking.status, 'arranging')
  assert.equal(review.notificationStatus, 'not_sent')
  const retry = await tools(id, [{ ...request, id: 'different-book' }])
  assert.equal(retry.body.code, 'call_closed')
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await end(id)).code, 503, 'staff review remains unresolved, never fabricated complete')
  process.env.OPS_DASHBOARD_PASSCODE = 'synthetic-review-passcode'
  const dashboard = await invoke(null, 'GET')
  assert.equal(dashboard.code, 200)
  assert.ok(dashboard.body.events.some((e: any) => e.id === `booking-review:${id}` && e.durable && e.needsReview))
})

test('lost dispatch-marker response completes known no-calendar action instead of stranding admitted work', async () => {
  const id = 'recovery-marker-ack', original = MemoryDocumentStore.prototype.update
  let lost = false
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (s: any) => any) {
    const saved: any = await original.call(this, key, initial, fn)
    if (!lost && key === `call:${id}` && saved.work?.intents.some((i: any) => i.status === 'dispatch_started')) {
      lost = true; throw new Error('Synthetic lost dispatch marker acknowledgement')
    }
    return saved
  })
  let response: any
  try { response = await tools(id, [booking(), contact()]) } finally { update.mock.restore() }
  assert.equal(lost, true)
  assert.equal(response.code, 200)
  assert.equal((await calendar.read()).bookings.length, 0)
  assert.equal((await end(id)).code, 200)
  assert.ok((await documents.get<any>(`lead:${phone}`)).calls.some((c: any) => c.callId === id))
})

test('replaying an uncertain booking retries failed staff projection without creating another booking', async () => {
  const id = 'recovery-review-write-replay', request = booking(), restore = uncertainCalendar()
  const original = MemoryDocumentStore.prototype.update
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (s: any) => any) {
    if (key === `booking-review:${id}`) throw new Error('Synthetic review-store failure')
    return original.call(this, key, initial, fn)
  })
  let first: any
  try { first = await tools(id, [request]) } finally { update.mock.restore(); restore() }
  assert.equal(first.code, 503)
  assert.equal(first.body.code, 'booking_review_persistence_unavailable')
  assert.equal(await documents.get(`booking-review:${id}`), null)
  const retry = await tools(id, [request])
  assert.equal(retry.code, 503, 'booking itself still needs review')
  assert.ok(await documents.get(`booking-review:${id}`), 'retry restores missing independent review')
  assert.equal((await calendar.read()).bookings.length, 1)
})

test('exact recovery evidence is durable before the calendar write begins', async () => {
  const id = 'recovery-exact-dispatch-evidence', request = booking(), original = MemoryCalendarStore.prototype.mutate
  let observed = false
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: (s: CalendarState) => CalendarState) {
    const state = await documents.get<any>(`call:${id}`)
    const attempt = state.bookingAttempt
    assert.equal(attempt.toolId, request.id)
    assert.equal(attempt.slotId, request.arguments.slotId)
    assert.equal(attempt.startsAt, `${request.arguments.slotId.slice(5)}:00.000Z`)
    assert.ok(Date.parse(attempt.endsAt) > Date.parse(attempt.startsAt))
    assert.equal(attempt.externalId, `prop-demo|${phone}|${request.arguments.slotId}`)
    assert.equal(state.booking.endsAt, attempt.endsAt)
    assert.equal(state.booking.externalId, attempt.externalId)
    assert.equal(state.work.intents.find((row: any) => row.id === request.id).status, 'dispatch_started')
    observed = true
    return original.call(this, fn)
  })
  let response: any
  try { response = await tools(id, [request]) } finally { mutation.mock.restore() }
  assert.equal(response.code, 200)
  assert.equal(observed, true)
  assert.equal((await calendar.read()).bookings.length, 1)
})
