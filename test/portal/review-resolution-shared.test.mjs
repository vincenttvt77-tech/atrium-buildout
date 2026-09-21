import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const at = '2032-06-01T15:00:00.000Z', checkedAt = '2032-06-01T15:05:00.000Z'
const scope = { organizationId: 'org-one', propertyId: 'building-one', configurationVersion: 3, permissionVersion: 'permissions-one' }
const timeZone = 'America/Chicago'
const attempt = { externalId: 'booking-one', slotId: 'slot-2032-06-02T17:00', startsAt: '2032-06-02T17:00:00.000Z', endsAt: '2032-06-02T17:30:00.000Z', unitId: '19A' }
const review = (overrides = {}) => ({ id: 'booking-review:call-one', version: 1, callId: 'call-one', kind: 'booking_review',
  durable: true, needsReview: true, at, updatedAt: at, sourceRevision: 4, phone: 'unknown', name: 'Dana Sample', email: null,
  callbackPhone: null, booking: { ...attempt, status: 'arranging' }, notificationStatus: 'not_sent', ...overrides })
const resolution = (overrides = {}) => ({ requestId: 'request-saved', callId: 'call-one', sourceRevision: 4, actorId: 'operator-one', checkedAt,
  attempt: { ...attempt }, outcome: 'confirmed', booking: { ...attempt, revision: 0 }, projection: 'complete', ...overrides })
const resolved = (overrides = {}) => review({ needsReview: false, updatedAt: checkedAt, resolution: resolution(overrides) })
const plain = value => JSON.parse(JSON.stringify(value))
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const receipt = (bookingReview = resolved(), overrides = {}) => ({ scope, timeZone, bookingReview,
  notificationSent: false, status: bookingReview.resolution?.projection === 'pending' ? 'pending_projection' : 'complete', ...overrides })
const record = (events, tools = []) => ({ id: 'call-one', name: 'Dana Sample', phone: 'unknown', startedAt: at, durationSeconds: 45,
  profile: null, events, call: { toolCalls: tools, startedAt: at, transcript: '' } })
const tool = (result, overrides = {}) => ({ name: 'book_tour', arguments: { slotId: attempt.slotId, unitId: '19A' }, result, ...overrides })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function portal({ permissions = ['read', 'operate'], legacy = false } = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [checkedAt])) }
    static now() { return Date.parse(checkedAt) }
  }
  const window = { ATRIUM_RUNTIME_MODE: legacy ? 'legacy' : 'postgres',
    ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'operator-one', tenantId: 'tenant-one' },
    ATRIUM_PROPERTY: { ...scope, buildingName: 'Synthetic House', timeZone, permissions, hours: {} },
    crypto: { randomUUID: () => 'request-generated' }, addEventListener() {}, scrollTo() {} }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const requests = [], dialogs = [], toasts = []
  let reloads = 0, handler = () => response(receipt())
  const context = { window, document, Intl, Date: Clock, console, URLSearchParams, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false }), location: { hash: '#/calls?id=call-one', reload() { reloads++ } },
    fetch: async (path, init) => {
      requests.push({ path, ...init, data: init.body ? JSON.parse(init.body) : null })
      if (init.method === 'POST') return handler(path, init)
      if (path.startsWith('/api/calendar')) return response({ scope, timeZone, slots: [], blocks: [], bookings: [] })
      if (path === '/api/leads') return response({ scope, profiles: [], followUps: [], tourChangeRequests: [] })
      return response({ scope, events: [], calls: [] })
    } }
  runInNewContext(source.replace('window.Atrium = {',
    'window.reviewInternals = { personRowHtml, todayView, invalidateDocument, getIssue: () => documentAccessIssue }; window.Atrium = {'), context)
  const A = window.Atrium
  A.toast = (...args) => toasts.push(args)
  A.dialog = spec => {
    const d = { spec, body: { innerHTML: '' }, errors: [], primary: { label: spec.primary.label }, closed: false,
      setError(value) { this.errors.push(value) }, setPrimary(value) { Object.assign(this.primary, value) },
      close() { this.closed = true; spec.onClose?.() }, submit() { return spec.primary.onClick(this) } }
    spec.build(d.body); dialogs.push(d); return d
  }
  A.apply('leads', { scope, profiles: [], followUps: [], tourChangeRequests: [] })
  const load = (events, extras = {}) => A.apply('calls', { scope, calls: [], events, callsConfigured: true, ...extras })
  return { A, window, requests, dialogs, toasts, load, context, internals: window.reviewInternals,
    handler(value) { handler = typeof value === 'function' ? value : () => response(value) },
    posts: () => requests.filter(r => r.method === 'POST'), reloads: () => reloads }
}

test('shared resolution validator accepts exact historical confirmed and absent observations', () => {
  const { A } = portal()
  assert.deepEqual(plain(A.derive.bookingReviewResolution(resolved())), resolution())
  const absent = resolved({ outcome: 'not_booked', booking: null })
  assert.deepEqual(plain(A.derive.bookingReviewResolution(absent)), absent.resolution)
  const pending = resolved({ projection: 'pending' })
  assert.equal(A.derive.bookingReviewResolution(pending).projection, 'pending')
  const normalized = resolved()
  normalized.booking.unitId = ' 19a '; normalized.resolution.attempt.unitId = '19a'
  assert.equal(A.derive.bookingReviewResolution(normalized).attempt.unitId, '19A')
})

test('shared resolution validator rejects mismatched identity, attempt, timestamps and completion pairings', () => {
  const { A } = portal()
  const changes = [
    r => { r.needsReview = true }, r => { r.version = 2 }, r => { r.id = 'booking-review:other' },
    r => { r.sourceRevision = -1 }, r => { r.notificationStatus = 'sent' }, r => { r.resolution.callId = 'other' },
    r => { r.resolution.sourceRevision++ }, r => { r.resolution.requestId = 'short' }, r => { r.resolution.actorId = '<bad>\n' },
    r => { r.resolution.checkedAt = '2032-06-01' }, r => { r.resolution.checkedAt = '2032-05-01T15:00:00.000Z' },
    r => { r.updatedAt = at }, r => { r.resolution.projection = 'done' }, r => { r.resolution.outcome = 'success' },
    r => { r.resolution.attempt.externalId = 'other' }, r => { r.resolution.attempt.endsAt = r.resolution.attempt.startsAt },
    r => { r.resolution.attempt.slotId = 'slot-other' }, r => { r.resolution.attempt.startsAt = '2032-06-02T18:00:00.000Z' },
    r => { r.resolution.attempt.unitId = '20B' }, r => { delete r.booking.endsAt }, r => { delete r.booking.externalId },
    r => { r.resolution.booking = null }, r => { r.resolution.booking.revision = -1 }, r => { r.resolution.booking.unitId = '20B' },
    r => { r.resolution.outcome = 'not_booked' }, r => { r.resolution.booking.externalId = 'other' },
  ]
  for (const change of changes) {
    const candidate = resolved(); change(candidate)
    assert.equal(A.derive.bookingReviewResolution(candidate), null, JSON.stringify(candidate))
  }
})

test('completed review suppresses only its old booking concern, preserving unrelated tool errors and safety', () => {
  const { A } = portal()
  const old = { kind: 'tour_booked', callId: 'call-one', status: 'arranging', ...attempt }
  const saved = resolved()
  const plainStory = A.derive.callStory(record([old, saved], [tool("I'm getting that booked.")]), A.state)
  assert.equal(plainStory.needsPerson, false)
  assert.equal(plainStory.findings.arranging, null)
  assert.equal(plainStory.booked, null, 'staff verification must not fabricate an assistant booking')
  assert.match(plainStory.sentence, /was verified when checked/)
  assert.doesNotMatch(plainStory.steps.map(x => x.text).join(' '), /not confirmed yet|Staff review is needed/)
  const errorStory = A.derive.callStory(record([saved], [tool('unauthorized'), tool('unauthorized', { name: 'answer_question', arguments: { question: 'Gym?' } })]), A.state)
  assert.equal(errorStory.needsPerson, true)
  assert.equal(errorStory.findings.crash, true)
  assert.match(errorStory.sentence, /A system step failed/)
  assert.ok(errorStory.chips.some(c => c.text === 'System step failed'))
  const emergency = A.derive.callStory(record([saved, { kind: 'emergency', callId: 'call-one', emergencyKind: 'gas', durable: true }]), A.state)
  assert.equal(emergency.emergency, true)
  assert.match(emergency.sentence, /gas/)
  const otherAttempt = A.derive.callStory(record([saved], [tool("I'm getting that booked.", { arguments: { slotId: 'slot-other', unitId: '20B' } })]), A.state)
  assert.equal(otherAttempt.needsPerson, true)
  assert.match(otherAttempt.sentence, /arranging a tour of apartment 20B/)
})

test('a general tour with omitted unit argument matches only a saved general-tour resolution', () => {
  const { A } = portal(), saved = resolved()
  saved.booking.unitId = null; saved.resolution.attempt.unitId = null; saved.resolution.booking.unitId = null
  const original = tool("I'm getting that booked.", { arguments: { slotId: attempt.slotId } })
  const result = A.derive.callStory(record([saved], [original]), A.state)
  assert.equal(result.needsPerson, false)
  assert.equal(result.findings.arranging, null)
  assert.match(result.sentence, /reservation was verified when checked/)
  assert.equal(A.derive.callStory(record([resolved()], [original]), A.state).needsPerson, true)
})

test('completed absence remains checked-at history after a newer tour and cannot borrow another call receipt', () => {
  const { A } = portal()
  const saved = resolved({ outcome: 'not_booked', booking: null })
  A.state.calendar = { bookings: [{ ...attempt, externalId: 'later-call', startsAt: '2032-06-03T17:00:00.000Z' }] }
  const result = A.derive.callStory(record([saved], [tool("I'm getting that booked.")]), A.state)
  assert.equal(result.findings.arranging, null)
  assert.match(result.sentence, /No matching reservation was found when checked/)
  assert.equal(result.booked, null)
  const foreign = record([saved], [tool("I'm getting that booked.")]); foreign.id = 'call-other'
  assert.equal(A.derive.callStory(foreign, A.state).needsPerson, true)
})

test('Today removes only completed booking work and keeps pending, callbacks and tour-change requests', () => {
  const { A, load, internals } = portal()
  const profile = { phone: 'unknown', name: 'Dana', stage: 'new', calls: [{ callId: 'call-one', at, durationSeconds: 45 }],
    bookings: [{ ...attempt, callId: 'call-one', status: 'arranging' }], escalations: [], signals: {}, notes: [] }
  A.apply('leads', { scope, profiles: [profile], followUps: [], tourChangeRequests: [] })
  load([resolved()])
  assert.equal(A.derive.needsPerson(A.state).length, 0)
  load([resolved({ projection: 'pending' })])
  const pending = A.derive.needsPerson(A.state)[0]
  assert.equal(pending.type, 'bookingReview')
  assert.match(internals.personRowHtml(pending, A.state), /Finish review|review updates are still pending/)
  load([resolved()])
  A.apply('leads', { scope, profiles: [profile], followUps: [{ id: 'fu-one', phone: 'unknown', kind: 'callback', status: 'scheduled', createdFromCall: 'call-one', dueAt: at }],
    tourChangeRequests: [{ id: 'change-one', callId: 'call-one', status: 'pending', firstRequestedAt: at }] })
  assert.deepEqual(plain(A.derive.needsPerson(A.state).map(item => item.type)), ['tourChange', 'callback'])
})

test('malformed closed reviews remain staff work and cannot be presented as complete', () => {
  const { A, load } = portal()
  const saved = resolved(); saved.resolution.attempt.unitId = '20B'
  load([saved])
  assert.equal(A.derive.needsPerson(A.state)[0].type, 'bookingReview')
  assert.equal(A.derive.callStory(record([saved]), A.state).needsPerson, true)
})

test('Today keeps a separate unresolved system concern after its booking review completes', () => {
  const { A, load, internals } = portal()
  const call = { id: 'call-one', customerNumber: null, startedAt: at, durationSeconds: 45, transcript: '',
    toolCalls: [tool('unauthorized', { name: 'answer_question', arguments: { question: 'Gym?' } })] }
  load([resolved()], { calls: [call] })
  const work = A.derive.needsPerson(A.state)
  assert.equal(work.length, 1)
  assert.equal(work[0].type, 'callReview')
  assert.match(internals.personRowHtml(work[0], A.state), /Other call steps still need review/)
  assert.doesNotMatch(internals.personRowHtml(work[0], A.state), /data-action="review-booking"|Mark handled/)
})

test('review action sends scoped exact identity and accepts a canonical receipt from another staff request', async () => {
  const ui = portal(), saved = review()
  ui.load([saved]); ui.handler(receipt(resolved({ requestId: 'request-other-staff', actorId: 'other-operator' })))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(ui.posts().length, 1)
  assert.deepEqual(ui.posts()[0].data, { action: 'booking_review', requestId: 'request-generated', callId: 'call-one', sourceRevision: 4,
    expectedTimeZone: timeZone, from: '2032-06-01', to: '2032-06-15' })
  assert.equal(ui.posts()[0].headers['x-atrium-organization-id'], scope.organizationId)
  assert.equal(ui.posts()[0].headers['x-atrium-property-id'], scope.propertyId)
  assert.equal(dialog.closed, true)
  assert.equal(ui.A.state.events[0].resolution.requestId, 'request-other-staff')
  assert.match(ui.toasts[0][0], /verified when checked.*No notification/i)
})

test('completion restores lost mobile focus to the visible call heading without stealing an existing focus target', async () => {
  for (const retainFocus of [false, true]) {
    const ui = portal(), saved = review(), document = ui.context.document
    let visibleFocus = 0, hiddenFocus = 0
    const field = {}, hiddenHero = { getClientRects: () => [], focus() { hiddenFocus++ } }
    const callHeading = { getClientRects: () => [{ width: 200 }], focus() { visibleFocus++; document.activeElement = this } }
    document.querySelector = selector => selector === '.view:not([hidden])' ? { querySelectorAll: () => [hiddenHero, callHeading] } : null
    ui.load([saved]); ui.handler(receipt())
    const dialog = ui.A.reviewBooking(saved), close = dialog.close.bind(dialog)
    dialog.close = () => { close(); document.activeElement = retainFocus ? field : document.body }
    await dialog.submit()
    assert.equal(visibleFocus, retainFocus ? 0 : 1)
    assert.equal(hiddenFocus, 0)
    assert.equal(document.activeElement, retainFocus ? field : callHeading)
  }
})

test('unknown network outcome retries the identical request and exact original source revision', async () => {
  const ui = portal(), saved = review()
  ui.load([saved]); ui.handler(() => { throw new Error('Synthetic dropped acknowledgement') })
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(dialog.closed, false)
  assert.equal(dialog.primary.label, 'Retry verification')
  assert.match(dialog.errors.at(-1), /may have been recorded/)
  ui.load([review({ sourceRevision: 6 })])
  ui.handler(receipt())
  await dialog.submit()
  assert.deepEqual(ui.posts()[0].data, ui.posts()[1].data)
  assert.equal(ui.posts()[1].data.sourceRevision, 4)
  assert.equal(dialog.closed, true)
})

test('invalid or wrong-attempt acknowledgements keep the exact retry instead of success', async () => {
  for (const mutate of [r => { r.notificationSent = true }, r => { r.status = 'pending_projection' },
    r => { r.bookingReview.resolution.attempt.unitId = '20B' },
    r => { r.bookingReview.resolution.callId = 'another-call' },
    r => { r.bookingReview.sourceRevision = 5; r.bookingReview.resolution.sourceRevision = 5 }]) {
    const ui = portal(), saved = review(), bad = receipt(); mutate(bad)
    ui.load([saved]); ui.handler(bad)
    const dialog = ui.A.reviewBooking(saved)
    await dialog.submit()
    assert.equal(dialog.closed, false)
    assert.equal(dialog.primary.label, 'Retry verification')
    assert.equal(ui.toasts.length, 0)
    assert.equal(ui.A.state.events[0].needsReview, true)
    ui.handler(receipt()); await dialog.submit()
    assert.deepEqual(ui.posts()[0].data, ui.posts()[1].data)
  }
})

test('pending projection stays open and retries the verified canonical claim without success notification', async () => {
  const ui = portal(), saved = review()
  ui.load([saved]); ui.handler(receipt(resolved({ projection: 'pending', requestId: 'canonical-request' })))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(dialog.closed, false)
  assert.equal(dialog.primary.label, 'Retry verification')
  assert.match(dialog.errors.at(-1), /updates are still pending/)
  assert.equal(ui.A.state.events[0].resolution.projection, 'pending')
  assert.equal(ui.A.derive.needsPerson(ui.A.state).length, 1)
  assert.equal(ui.toasts.length, 0)
  ui.handler(receipt(resolved({ requestId: 'canonical-request' })))
  await dialog.submit()
  assert.equal(ui.posts()[1].data.requestId, 'canonical-request')
  assert.equal(dialog.closed, true)
})

test('claim-only pending projection without a calendar receipt keeps the original exact retry', async () => {
  const ui = portal(), saved = review()
  ui.load([saved]); ui.handler(receipt(saved, { status: 'pending_projection' }))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(dialog.closed, false)
  assert.equal(dialog.primary.label, 'Retry verification')
  assert.equal(ui.A.state.events[0].needsReview, true)
  assert.equal(ui.toasts.length, 0)
  ui.handler(receipt()); await dialog.submit()
  assert.deepEqual(ui.posts()[0].data, ui.posts()[1].data)
  assert.equal(dialog.closed, true)
})

test('a reopened pending review uses its saved canonical request identity', async () => {
  const ui = portal(), saved = resolved({ projection: 'pending', requestId: 'canonical-request' })
  ui.load([saved]); ui.handler(receipt(resolved({ requestId: 'canonical-request' })))
  const dialog = ui.A.reviewBooking(saved)
  assert.equal(dialog.primary.label, 'Finish review')
  await dialog.submit()
  assert.equal(ui.posts()[0].data.requestId, 'canonical-request')
})

test('double activation and a second dialog cannot submit concurrent checks', async () => {
  const ui = portal(), saved = review(), wait = deferred()
  ui.load([saved]); ui.handler(() => wait.promise)
  const dialog = ui.A.reviewBooking(saved), pending = dialog.submit()
  await dialog.submit(); ui.A.reviewBooking(saved)
  assert.equal(ui.posts().length, 1)
  assert.equal(ui.dialogs.length, 1)
  assert.equal(ui.A.busyNow('calls'), true)
  wait.resolve(response(receipt())); await pending
  assert.equal(ui.A.busyNow('calls'), false)
})

test('viewer, stale and completed records cannot open a mutation dialog', () => {
  const viewer = portal({ permissions: ['read'] }), saved = review()
  viewer.load([saved]); viewer.A.reviewBooking(saved)
  assert.equal(viewer.dialogs.length, 0)
  const ui = portal(); ui.load([review({ sourceRevision: 6 })]); ui.A.reviewBooking(saved)
  assert.equal(ui.dialogs.length, 0)
  const done = resolved(); ui.load([done]); ui.A.reviewBooking(done)
  assert.equal(ui.dialogs.length, 0)
})

test('conflict offers a read refresh and does not retry a changed review', async () => {
  const ui = portal(), saved = review()
  ui.load([saved]); ui.handler(() => response({ code: 'booking_review_revision_conflict', error: '<private server detail>' }, 409))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(dialog.primary.label, 'Close and refresh')
  assert.doesNotMatch(dialog.errors.at(-1), /private server detail/)
  await dialog.submit()
  assert.equal(ui.posts().length, 1)
  assert.equal(dialog.closed, true)
})

test('wrong property, permission version or timezone retires the result and blocks further review writes', async () => {
  for (const changed of [{ scope: { ...scope, propertyId: 'another-building' } },
    { scope: { ...scope, permissionVersion: 'new-permissions' } }, { timeZone: 'America/New_York' }]) {
    const ui = portal(), saved = review()
    ui.load([saved]); ui.handler(receipt(resolved(), changed))
    const dialog = ui.A.reviewBooking(saved)
    await dialog.submit(); await dialog.submit()
    assert.equal(ui.toasts.length, 0)
    assert.equal(ui.A.state.events.length, 0)
    assert.equal(ui.A.can('operate'), false)
    assert.equal(ui.posts().length, 1)
    assert.match(ui.internals.getIssue().message, /reservation review is unconfirmed and may have been recorded/i)
  }
})

test('expired session keeps the uncertain-review warning and never automatically resubmits after login', async () => {
  const ui = portal(), saved = review()
  ui.load([saved]); ui.handler(() => response({}, 401))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit(); await dialog.submit()
  assert.equal(ui.reloads(), 0)
  assert.equal(ui.posts().length, 1)
  assert.equal(ui.A.can('operate'), false)
  assert.match(ui.internals.getIssue().message, /review is unconfirmed and may have been recorded/)
  assert.equal(ui.toasts.length, 0)
})

test('session retirement preserves both an in-flight review and existing service-save uncertainty', async () => {
  const ui = portal(), saved = review(), reviewWait = deferred(), serviceWait = deferred()
  ui.load([saved]); ui.handler(path => path === '/api/calendar' ? reviewWait.promise : serviceWait.promise)
  const dialog = ui.A.reviewBooking(saved), checking = dialog.submit()
  const service = ui.A.api.post('/api/resident-services', { action: 'save_request' }).catch(error => error)
  reviewWait.resolve(response({}, 401)); await checking
  assert.match(ui.internals.getIssue().message, /reservation review is unconfirmed and may have been recorded/)
  assert.match(ui.internals.getIssue().message, /service save is unconfirmed and may have been recorded/)
  serviceWait.resolve(response({ scope })); await service
  assert.equal(ui.toasts.length, 0)
  assert.equal(ui.reloads(), 0)
})

test('an in-flight result cannot populate a document retired by another request', async () => {
  const ui = portal(), saved = review(), wait = deferred()
  ui.load([saved]); ui.handler(() => wait.promise)
  const dialog = ui.A.reviewBooking(saved), pending = dialog.submit()
  ui.internals.invalidateDocument('The property changed.')
  wait.resolve(response(receipt())); await pending
  assert.equal(ui.toasts.length, 0)
  assert.equal(ui.A.state.events.length, 0)
  await dialog.submit()
  assert.equal(ui.posts().length, 1)
})

test('legacy request uses its frozen tenant header and account changes retire the review', async () => {
  const ui = portal({ legacy: true }), saved = review()
  ui.load([saved]); ui.window.ATRIUM_ACCOUNT.tenantId = 'other-tenant'
  ui.handler(() => response({ code: 'portal_tenant_changed', error: 'Account changed' }, 409))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(ui.posts()[0].headers['x-atrium-tenant-id'], 'tenant-one')
  assert.equal(ui.A.can('operate'), false)
  assert.match(ui.internals.getIssue().message, /review is unconfirmed and may have been recorded/)
})

test('saving one review does not erase partial-feed warnings or invent a current calendar booking', async () => {
  const ui = portal(), saved = review()
  ui.load([saved], { bookingReviewsError: 'partial', safetyEventsError: 'partial', callsError: 'partial' })
  ui.A.state.errors.calls = { message: 'History is unavailable' }
  ui.A.state.calendar = { bookings: [{ ...attempt, startsAt: '2032-06-03T17:00:00.000Z', revision: 2 }] }
  const existing = plain(ui.A.state.calendar.bookings)
  ui.handler(receipt(resolved({ projection: 'pending' })))
  const dialog = ui.A.reviewBooking(saved)
  await dialog.submit()
  assert.equal(ui.A.state.bookingReviewsError, 'partial')
  assert.equal(ui.A.state.safetyEventsError, 'partial')
  assert.equal(ui.A.state.errors.calls.message, 'History is unavailable')
  assert.deepEqual(plain(ui.A.state.calendar.bookings), existing)
})
