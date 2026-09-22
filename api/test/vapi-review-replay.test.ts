import { after, before, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { MemoryCalendarStore, calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { generateSlots } from '../../src/calendar/slots.ts'
import type { CalendarState } from '../../src/calendar/types.ts'

const savedEnv = { ...process.env }, originalFetch = globalThis.fetch
const documents = documentStoreFromEnv(), calendar = calendarStoreFromEnv()
const NOW = new Date('2032-06-01T12:00:00.000Z')
let handler: (req: any, res: any) => Promise<void>
before(async () => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  globalThis.fetch = async () => { throw new Error('Independent regression tests forbid external network') }
  mock.timers.enable({ apis: ['Date'], now: NOW })
  handler = (await import('../vapi.ts')).default
})
beforeEach(async () => {
  mock.timers.setTime(NOW.getTime())
  await calendar.mutate(() => ({ blocks: [], bookings: [] }))
})
after(() => {
  mock.timers.reset()
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(message: any) {
  const response: any = { code: 0, body: null, headers: {},
    setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value },
    status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
  await handler({ method: 'POST', headers: {}, body: { message } }, response)
  return response
}
const caller = '+15555550380'
const tools = (id: string, list: unknown[]) => invoke({ type: 'tool-calls', call: { id, customer: { number: caller } }, toolCallList: list })
const end = (id: string) => invoke({ type: 'end-of-call-report', call: { id, customer: { number: caller } } })
const contact = (id: string, phone = '+15555550381', email?: string) => ({ id, name: 'capture_contact', arguments: {
  phone, ...(email ? { email } : {}), excerpt: `Please use ${phone} as my callback number.${email ? ` My email is ${email}.` : ''}` } })
const booking = (id = 'book', unitId = '19A') => ({ id, name: 'book_tour', arguments: {
  slotId: generateSlots(new Date()).at(-1)!.slotId, unitId, prospectName: 'Independent recovery test' } })

function unreadableAfterBooking() {
  const originalMutate = MemoryCalendarStore.prototype.mutate, originalRead = MemoryCalendarStore.prototype.read
  let savedBooking = false
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: (state: CalendarState) => CalendarState) {
    const saved = await originalMutate.call(this, fn)
    if (saved.bookings.length) savedBooking = true
    return saved
  })
  const reading = mock.method(MemoryCalendarStore.prototype, 'read', async function(this: MemoryCalendarStore) {
    if (savedBooking) throw new Error('Synthetic verification outage')
    return originalRead.call(this)
  })
  return () => { mutation.mock.restore(); reading.mock.restore() }
}

test('persistent review projection failure stays retryable across booking replays and recovers without another tour', async () => {
  const id = 'independent-review-persistent', request = booking(), restoreCalendar = unreadableAfterBooking()
  const original = MemoryDocumentStore.prototype.update
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    if (key === `booking-review:${id}`) throw new Error('Synthetic review projection outage')
    return original.call(this, key, initial, fn)
  })
  let first: any, retry: any
  try {
    first = await tools(id, [request])
    restoreCalendar()
    retry = await tools(id, [request])
  } finally { restoreCalendar(); update.mock.restore() }
  for (const response of [first, retry]) {
    assert.equal(response.code, 503)
    assert.equal(response.body.code, 'booking_review_persistence_unavailable')
    assert.equal(response.body.retryable, true)
    assert.ok(Number(response.headers['retry-after']) > 0)
  }
  assert.equal(await documents.get(`booking-review:${id}`), null)
  const recovered = await tools(id, [request])
  assert.equal(recovered.code, 503, 'restoring review visibility cannot claim the booking verified')
  assert.equal(recovered.body.code, 'call_work_busy')
  assert.ok(await documents.get(`booking-review:${id}`))
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'needs_review')
})

test('cached contact replay retries its failed staff projection and preserves details during that outage', async () => {
  const id = 'independent-review-contact-replay', request = contact('callback'), restoreCalendar = unreadableAfterBooking()
  try { assert.equal((await tools(id, [booking()])).code, 503) } finally { restoreCalendar() }
  const original = MemoryDocumentStore.prototype.update
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    if (key === `booking-review:${id}`) throw new Error('Synthetic review projection outage')
    return original.call(this, key, initial, fn)
  })
  let first: any, retry: any
  try { first = await tools(id, [request]); retry = await tools(id, [request]) }
  finally { update.mock.restore() }
  assert.equal(first.code, 503)
  assert.equal(retry.code, 503)
  assert.equal(first.body.code, 'booking_review_persistence_unavailable')
  assert.equal(retry.body.code, 'booking_review_persistence_unavailable')
  const saved: any = await documents.get(`call:${id}`)
  assert.equal(saved.callbackPhone.value, '+15555550381', 'callback save is independent of review projection availability')
  assert.equal(saved.work.intents.filter((intent: any) => intent.id === 'callback').length, 1)
  assert.equal((await documents.get<any>(`booking-review:${id}`)).callbackPhone, null)
  const recovered = await tools(id, [request])
  assert.equal(recovered.code, 200)
  assert.match(recovered.body.results[0].result, /Contact details saved/)
  assert.equal((await documents.get<any>(`booking-review:${id}`)).callbackPhone.value, '+15555550381')
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await documents.get<any>(`call:${id}`)).work.phase, 'needs_review')
})

test('a second booking in one batch retains the first confirmed tour and requests staff change', async () => {
  const id = 'independent-review-two-bookings'
  const response = await tools(id, [booking('first', '19A'), booking('second', '12A')])
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /tour is confirmed/i)
  assert.match(response.body.results[1].result, /change|reschedul/i)
  assert.doesNotMatch(response.body.results[1].result, /would any of those work/i)
  const saved: any = await documents.get(`call:${id}`)
  assert.equal(saved.booking.status, 'confirmed')
  assert.equal(saved.booking.unitId, '19A')
  assert.equal(saved.tourChangeRequested, true)
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await calendar.read()).bookings[0]!.unitId, '19A')
  assert.equal((await end(id)).code, 200)
  const profile: any = await documents.get(`lead:${caller}`)
  assert.ok(profile.bookings.some((row: any) => row.callId === id && row.unitId === '19A' && row.status === 'confirmed'))
})

test('an older contact completion cannot overwrite a newer concurrent callback request', async () => {
  const id = 'independent-review-contact-order', originalUpdate = MemoryDocumentStore.prototype.update
  const originalGet = MemoryDocumentStore.prototype.get
  let interleaved = false, newer: any
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    const current: any = key === `call:${id}` ? await originalGet.call(this, key) : null
    if (!interleaved && current?.work?.intents.some((intent: any) => intent.id === 'older' && intent.status === 'admitted')) {
      interleaved = true
      mock.timers.setTime(NOW.getTime() + 1000)
      newer = await tools(id, [contact('newer', '+15555550382')])
    }
    return originalUpdate.call(this, key, initial, fn)
  })
  let older: any
  try { older = await tools(id, [contact('older', '+15555550381')]) } finally { update.mock.restore() }
  assert.equal(interleaved, true)
  assert.equal(older.code, 200)
  assert.equal(newer.code, 200)
  assert.equal((await documents.get<any>(`call:${id}`)).callbackPhone.value, '+15555550382')
  assert.equal((await end(id)).code, 200)
  assert.equal((await documents.get<any>(`lead:${caller}`)).callbackPhone.value, '+15555550382')
})

test('a stale booking dispatch snapshot preserves a newer concurrent callback through confirmation', async () => {
  const id = 'independent-review-dispatch-contact-order'
  assert.equal((await tools(id, [contact('original-callback', '+15555550381', 'original@example.test')])).code, 200)
  mock.timers.setTime(NOW.getTime() + 2000)
  const originalUpdate = MemoryDocumentStore.prototype.update, originalGet = MemoryDocumentStore.prototype.get
  let interleaved = false, newer: any, markerCallback: string | undefined
  const update = mock.method(MemoryDocumentStore.prototype, 'update', async function(this: MemoryDocumentStore, key: string, initial: any, fn: (state: any) => any) {
    const current: any = key === `call:${id}` ? await originalGet.call(this, key) : null
    if (!interleaved && current?.work?.intents.some((intent: any) => intent.id === 'book' && intent.status === 'admitted')) {
      interleaved = true
      mock.timers.setTime(NOW.getTime() + 3000)
      newer = await tools(id, [contact('newer-callback', '+15555550383', 'corrected@example.test')])
    }
    const saved: any = await originalUpdate.call(this, key, initial, fn)
    if (key === `call:${id}` && saved.work?.intents.some((intent: any) => intent.id === 'book' && intent.status === 'dispatch_started')) {
      markerCallback = saved.callbackPhone?.value
    }
    return saved
  })
  let response: any
  try { response = await tools(id, [booking()]) } finally { update.mock.restore() }
  assert.equal(interleaved, true)
  assert.equal(newer.code, 200)
  assert.equal(response.code, 200)
  assert.match(response.body.results[0].result, /tour is confirmed/i)
  assert.equal(markerCallback, '+15555550383')
  assert.equal((await documents.get<any>(`call:${id}`)).callbackPhone.value, '+15555550383')
  assert.equal((await documents.get<any>(`call:${id}`)).email, 'corrected@example.test')
  assert.equal((await end(id)).code, 200)
  assert.equal((await documents.get<any>(`lead:${caller}`)).callbackPhone.value, '+15555550383')
  assert.equal((await documents.get<any>(`lead:${caller}`)).email, 'corrected@example.test')
})
