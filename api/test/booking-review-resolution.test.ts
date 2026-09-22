import { after, before, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarHandler } from '../calendar.ts'
import { calendarStoreFromEnv, MemoryCalendarStore } from '../../src/calendar/store.ts'
import { documentStoreFromEnv, MemoryDocumentStore } from '../../src/store/documents.ts'
import { emptyQualification } from '../../src/leasing/qualification.ts'
import { initializeCallLifecycle, admitToolBatch, markToolDispatch, completeToolBatch, requestCallEnd, hashCallToolArgs } from '../../src/calls/lifecycle.ts'
import { recordBookingReview } from '../../src/calls/booking-review.ts'
import vapiHandler from '../vapi.ts'
import { generateSlots } from '../../src/calendar/slots.ts'
import { withTenant } from '../../src/tenancy/context.ts'

const savedEnv = { ...process.env }
const now = new Date('2032-06-01T10:00:00.000Z'), passcode = 'synthetic-booking-review-passcode'
const documents = documentStoreFromEnv(), calendar = calendarStoreFromEnv()
const handler = createCalendarHandler({ now: () => now })
const phone = '+15555550700'
const attempt = { externalId: 'synthetic-property|+15555550700|slot-2032-06-02T14:00',
  slotId: 'slot-2032-06-02T14:00', startsAt: '2032-06-02T14:00:00.000Z', endsAt: '2032-06-02T14:30:00.000Z', unitId: '19A' }
before(() => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'OPS_ACCOUNTS_JSON', 'OPS_SESSION_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL', 'NODE_ENV', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY']) delete process.env[key]
  process.env.OPS_DASHBOARD_PASSCODE = passcode
})
after(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv) })
beforeEach(async () => {
  await calendar.mutate(() => ({ blocks: [], bookings: [] }))
  for (const key of await documents.list('')) await documents.delete(key)
})
async function seed(id: string, options: { exists?: boolean; ended?: boolean; dispatching?: boolean; tenantId?: string; evidence?: boolean } = {}) {
  const at = now.toISOString(), provenance = { tenantId: options.tenantId ?? 'legacy', timeZone: 'America/New_York' }
  let work = initializeCallLifecycle({ now: at, provenance })
  work = admitToolBatch(work, { token: 'synthetic-token', now: at, provenance,
    tools: [{ id: 'book', name: 'book_tour', argsHash: hashCallToolArgs({ slotId: attempt.slotId }) }] }).work
  work = markToolDispatch(work, { token: 'synthetic-token', toolId: 'book', now: at })
  if (!options.dispatching) work = completeToolBatch(work, { token: 'synthetic-token', now: at,
    results: [{ toolId: 'book', outcome: 'needs_review', result: 'The reservation could not be verified.' }] })
  if (options.ended !== false) work = requestCallEnd(work, { now: at, provenance, metadata: { eventKey: `end-${id}`, endedAt: at, reportedPhone: phone } })
  const state = { qualification: emptyQualification(), phone, name: 'Synthetic Review Prospect', email: 'review@example.test',
    unitsDiscussed: ['19A'], booking: { ...attempt, status: 'arranging' }, lossReason: null, escalation: null, emergency: null,
    toolsCalled: ['book_tour'], work, ...(options.evidence === false ? {} : { bookingAttempt: { ...attempt, toolId: 'book' } }) }
  await documents.set(`call:${id}`, state)
  await recordBookingReview(documents, { ...state, callId: id, now })
  if (options.exists) await calendar.mutate(current => ({ ...current, bookings: [{ ...attempt, interactionId: id,
    prospectName: state.name, prospectPhone: phone, prospectEmail: state.email, bookedAt: at }] }))
  return { action: 'booking_review', requestId: `review-${id}`, callId: id, sourceRevision: work.revision }
}
async function invoke(body: Record<string, unknown>, extra: Record<string, string | undefined> = {}) {
  const res: any = { code: 0, body: null, headers: {}, setHeader(key: string, value: string) { this.headers[key] = value },
    status(code: number) { this.code = code; return this }, json(value: unknown) { this.body = value; return this } }
  await handler({ method: 'POST', headers: { 'x-ops-passcode': passcode, 'x-atrium-tenant-id': 'legacy', ...extra },
    body: { expectedTimeZone: 'America/New_York', ...body } }, res)
  return res
}

test('staff check confirms only the exact saved reservation, completes the lead and leaves one historical receipt', async () => {
  const request = await seed('http-confirmed', { exists: true })
  const response = await invoke({ ...request, actorId: 'forged-actor', attempt: { externalId: 'forged-reservation' }, outcome: 'not_booked' })
  assert.equal(response.code, 200, JSON.stringify(response.body))
  assert.equal(response.body.status, 'complete')
  assert.equal(response.body.notificationSent, false)
  const review = response.body.bookingReview
  assert.equal(review.needsReview, false)
  assert.equal(review.resolution.outcome, 'confirmed')
  assert.equal(review.resolution.projection, 'complete')
  assert.notEqual(review.resolution.actorId, 'forged-actor')
  assert.deepEqual(review.resolution.attempt, attempt)
  assert.equal((await documents.get<any>('call:http-confirmed')).work.phase, 'complete')
  const profile = await documents.get<any>(`lead:${phone}`)
  assert.equal(profile.calls.filter((call: any) => call.callId === request.callId).length, 1)
  assert.equal(profile.bookings[0].externalId, attempt.externalId)
  const again = await invoke(request)
  assert.equal(again.code, 200)
  assert.deepEqual(again.body.bookingReview.resolution, review.resolution)
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.equal((await calendar.read()).bookingReviewResolutions?.length, 1)
})

test('staff check of a stranded dispatched attempt records absence and callback work without creating a tour', async () => {
  const request = await seed('http-dispatched', { dispatching: true })
  const response = await invoke(request)
  assert.equal(response.code, 200, JSON.stringify(response.body))
  assert.equal(response.body.bookingReview.resolution.outcome, 'not_booked')
  assert.equal((await calendar.read()).bookings.length, 0)
  const profile = await documents.get<any>(`lead:${phone}`)
  assert.ok(profile.calls.some((call: any) => call.callId === request.callId))
  const followups = await Promise.all((await documents.list('followup:')).map(key => documents.get<any>(key)))
  assert.ok(followups.some(row => row.createdFromCall === request.callId && row.kind === 'callback' && !row.executable))
})

test('authorization, tenant header and timezone guards run before a review can claim the call', async () => {
  const request = await seed('http-guarded', { exists: true })
  assert.equal((await invoke(request, { 'x-ops-passcode': undefined })).code, 401)
  assert.equal((await invoke(request, { 'x-atrium-tenant-id': undefined })).code, 428)
  assert.equal((await invoke(request, { 'x-atrium-tenant-id': 'foreign' })).code, 409)
  assert.equal((await invoke({ ...request, expectedTimeZone: 'Pacific/Honolulu' })).code, 409)
  assert.equal((await documents.get<any>(`call:${request.callId}`)).bookingReviewWork, undefined)
  assert.equal((await calendar.read()).bookingReviewResolutions, undefined)
})

test('stale, live, missing-evidence and foreign-provenance calls remain unresolved without a fence', async () => {
  const stale = await seed('http-stale')
  assert.equal((await invoke({ ...stale, sourceRevision: stale.sourceRevision - 1 })).code, 409)
  const live = await seed('http-live', { ended: false })
  assert.equal((await invoke(live)).code, 409)
  const old = await seed('http-old', { evidence: false })
  assert.equal((await invoke(old)).code, 409)
  const foreign = await seed('http-foreign', { tenantId: 'foreign' })
  assert.equal((await invoke(foreign)).code, 409)
  assert.equal((await calendar.read()).bookingReviewResolutions, undefined)
  for (const request of [stale, live, old, foreign]) assert.equal((await documents.get<any>(`call:${request.callId}`)).bookingReviewWork, undefined)
})

test('same call id stored under another account is never used to resolve the selected account', async () => {
  const request = await withTenant('other-property', () => seed('http-other-property', { exists: true, tenantId: 'other-property' }))
  const response = await invoke(request)
  assert.equal(response.code, 409)
  assert.equal(await documents.get(`call:${request.callId}`), null)
  assert.equal((await calendar.read()).bookings.length, 0)
  await withTenant('other-property', async () => {
    assert.equal((await documents.get<any>(`call:${request.callId}`)).bookingReviewWork, undefined)
    assert.equal((await calendar.read()).bookings.length, 1)
  })
})

test('infrastructure failure does not expose raw errors or falsely report a completed check', async () => {
  const request = await seed('http-unavailable')
  const reading = mock.method(MemoryDocumentStore.prototype, 'get', async () => { throw new Error('synthetic-private-storage-detail') })
  let response: any
  try { response = await invoke(request) } finally { reading.mock.restore() }
  assert.equal(response.code, 503)
  assert.equal(response.body.code, 'booking_review_unavailable')
  assert.equal(response.body.retryable, true)
  assert.doesNotMatch(JSON.stringify(response.body), /synthetic-private-storage-detail/)
})


test('staff absence check wins against a real delayed webhook create and prevents its late completion', { timeout: 10000 }, async () => {
  const callId = 'http-live-create-race'
  const slot = generateSlots(new Date()).at(-1)
  assert.ok(slot)
  const voice = async (message: unknown) => {
    const res: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
    await vapiHandler({ method: 'POST', headers: {}, body: { message } }, res)
    return res
  }
  let reached!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve }), proceed = new Promise<void>(resolve => { release = resolve })
  const original = MemoryCalendarStore.prototype.mutate
  let intercepted = false
  const mutation = mock.method(MemoryCalendarStore.prototype, 'mutate', async function(this: MemoryCalendarStore, fn: Parameters<MemoryCalendarStore['mutate']>[0]) {
    if (!intercepted) { intercepted = true; reached(); await proceed }
    return original.call(this, fn)
  })
  const call = { id: callId, customer: { number: phone } }
  const pending = voice({ type: 'tool-calls', call, toolCallList: [{ id: 'book', name: 'book_tour', arguments: {
    slotId: slot.slotId, unitId: '19A', prospectName: 'Synthetic Delayed Prospect' } }] })
  try {
    await waiting
    const ended = await voice({ type: 'end-of-call-report', call })
    assert.equal(ended.code, 503)
    const review = await documents.get<any>(`booking-review:${callId}`)
    assert.ok(review, 'end report exposes the stranded dispatch before original completion')
    const checked = await invoke({ action: 'booking_review', requestId: 'staff-race-request', callId, sourceRevision: review.sourceRevision })
    assert.equal(checked.code, 200, JSON.stringify(checked.body))
    assert.equal(checked.body.bookingReview.resolution.outcome, 'not_booked')
    release()
    const late = await pending
    assert.equal(late.code, 503)
    assert.equal((await calendar.read()).bookings.length, 0)
    assert.equal((await documents.get<any>(`call:${callId}`)).work.phase, 'complete')
    const profile = await documents.get<any>(`lead:${phone}`)
    assert.equal(profile.calls.filter((row: any) => row.callId === callId).length, 1)
    assert.ok(!profile.bookings.some((row: any) => row.callId === callId && row.status === 'confirmed'))
    assert.equal((await documents.get<any>(`booking-review:${callId}`)).resolution.outcome, 'not_booked')
  } finally { release(); await pending; mutation.mock.restore() }
})
