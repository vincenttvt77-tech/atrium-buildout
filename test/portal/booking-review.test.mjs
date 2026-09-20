import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const callsSource = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const callsCss = await readFile(new URL('../../ops/src/calls.css', import.meta.url), 'utf8')
const at = '2032-06-01T15:00:00.000Z'
const scope = { organizationId: 'org-one', propertyId: 'building-one', configurationVersion: 3, permissionVersion: 'permissions-one' }
const plain = value => JSON.parse(JSON.stringify(value))
const review = overrides => ({ id: 'booking-review:call-one', version: 1, callId: 'call-one', kind: 'booking_review',
  durable: true, needsReview: true, at, updatedAt: at, sourceRevision: 4,
  phone: '+13125550101', name: 'Dana', email: 'dana@example.test',
  callbackPhone: { value: '+13125550102', excerpt: 'Please call this number instead.', callId: 'call-one', at, confidence: 1 },
  booking: { slotId: 'slot-one', startsAt: '2032-06-02T17:00:00.000Z', unitId: '19A', status: 'arranging' },
  notificationStatus: 'not_sent', ...overrides })
const profile = (callId, name, overrides = {}) => ({ phone: 'unknown', name, email: null, stage: 'escalated',
  firstSeenAt: at, lastSeenAt: at, calls: [{ callId, at, outcome: 'Escalated: Please call back', durationSeconds: 60, toolsCalled: [] }],
  bookings: [], signals: {}, notes: [], unitsDiscussed: [],
  escalations: [{ callId, at, trigger: 'human_requested', detail: `${name} asked a separate question.` }], ...overrides })
const callback = (callId, id, overrides = {}) => ({ id, phone: 'unknown', kind: 'callback', status: 'scheduled',
  channel: 'call', dueAt: at, createdAt: at, createdFromCall: callId, reason: 'Please call back', ...overrides })

function workspace(width = 1280) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [at])) }
    static now() { return Date.parse(at) }
  }
  const window = { addEventListener() {}, scrollTo() {}, scrollY: 0,
    ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'user-one' },
    ATRIUM_PROPERTY: { ...scope, buildingName: 'Lake House', timeZone: 'America/Chicago', permissions: ['read', 'operate'], hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, activeElement: null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const context = { window, document, location: { hash: '#/calls' }, Intl, Date: Clock, URLSearchParams, structuredClone, console,
    localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? true : query.includes('min-width: 1200') ? width >= 1200 : query.includes('min-width: 960') ? width >= 960 : width <= 959 }),
    fetch: () => assert.fail('Rendering a saved review must never contact a provider') }
  runInNewContext(appSource.replace('window.Atrium = {', 'window.reviewState = { ingest, snapshot, personRowHtml, followUpRowHtml }; window.Atrium = {'), context)
  runInNewContext(callsSource.replace("A.register('calls', view)",
    "window.reviewUi = { callContextHtml, panelHtml, rowHtml, callOverviewHtml, passes, view }; A.register('calls', view)"), context)
  const A = window.Atrium, s = A.state
  const ingest = (resource, payload) => window.reviewState.ingest(resource, { scope, ...payload })
  ingest('leads', { profiles: [], followUps: [], tourChangeRequests: [] })
  ingest('calls', { calls: [], events: [], callsConfigured: true })
  s.calendar = { bookings: [] }; s.loaded.calendar = true
  return { A, s, ingest, ui: window.reviewUi, internals: window.reviewState }
}

test('a durable review without finished projection is visible as staff work, never a confirmed tour', () => {
  const { A, s, ingest, ui, internals } = workspace()
  ingest('calls', { calls: [], events: [review()], callsConfigured: true })
  const records = A.derive.callRecords(s)
  assert.equal(records.length, 1)
  const rec = records[0], story = A.derive.callStory(rec, s)
  assert.equal(rec.id, 'call-one')
  assert.equal(rec.name, 'Dana')
  assert.equal(rec.phone, '+13125550101')
  assert.equal(rec.profile, null)
  assert.equal(story.booked, null)
  assert.equal(story.needsPerson, true)
  assert.equal(ui.passes('person', story), true)
  assert.equal(ui.passes('booked', story), false)
  const work = A.derive.needsPerson(s).filter(item => item.callId === 'call-one')
  assert.equal(work.length, 1)
  const workHtml = internals.personRowHtml(work[0], s)
  assert.match(workHtml, /href="#\/calls\?id=call-one"/)
  assert.match(workHtml, /Check the existing reservation/)
  assert.match(workHtml, /No notification has been sent/)
  assert.doesNotMatch(workHtml, /data-action="handled"/)
  const html = ui.callOverviewHtml(s, records, new Map([[rec.id, story]]))
  assert.match(html, /Calls to review.*?>1</)
  assert.match(html, /Tour-booking outcomes.*?>0</)
})

test('review details preserve uncertainty and safely render contacts at desktop and mobile fixture widths', () => {
  for (const width of [320, 390, 1280]) {
    const { A, s, ingest, ui } = workspace(width)
    ingest('calls', { calls: [], events: [review({ name: '<img src=x>', email: '<svg/onload=bad>@example.test',
      callbackPhone: { value: '<script>bad</script>', excerpt: '<bad>', callId: 'call-one', at, confidence: 1 },
      booking: { slotId: 'slot-one', startsAt: '2032-06-02T17:00:00.000Z', unitId: '<19A>', status: 'arranging' } })] })
    const rec = A.derive.callRecords(s)[0], story = A.derive.callStory(rec, s)
    const html = ui.panelHtml(rec, story, s)
    assert.match(html, /Tour booking needs verification/)
    assert.match(html, /Check the existing reservation before arranging another tour/)
    assert.match(html, /no notification has been sent/)
    assert.match(html, /Residence &lt;19A&gt;/)
    assert.match(html, /Requested callback: &lt;script&gt;bad&lt;\/script&gt;/)
    assert.match(html, /Email: &lt;svg\/onload=bad&gt;@example.test/)
    assert.match(html, /12:00 PM/)
    assert.match(html, /href="#\/calendar"/)
    assert.doesNotMatch(html, /<img|<script>|<svg\/onload|Tour booked|someone would call back|couldn't be booked|Staff notified/)
    assert.doesNotMatch(html, /data-action="handled"/)
  }
  assert.match(callsCss, /overflow-wrap: anywhere/)
  assert.match(callsCss, /@media \(max-width: 599px\)/)
})

test('partial booking-review failure retains saved reviews and does not retain stale ordinary events', () => {
  const { A, s, ingest, ui } = workspace()
  const saved = review(), temporary = { id: 'ordinary-one', kind: 'signal_captured', callId: 'ordinary-call', at, signal: 'bedrooms', value: 1 }
  ingest('calls', { events: [saved, temporary], calls: [] })
  A.apply('calls', { scope, calls: [], events: [], bookingReviewsError: 'unavailable' })
  assert.deepEqual(plain(s.events), [saved])
  assert.equal(s.bookingReviewsError, 'unavailable')
  const rec = A.derive.callRecords(s)[0], story = A.derive.callStory(rec, s)
  assert.match(ui.callOverviewHtml(s, [rec], new Map([[rec.id, story]])), /Saved snapshot · refresh needed/)
  A.apply('calls', { scope, calls: [], events: [] })
  assert.deepEqual(plain(s.events), [])
  assert.equal(s.bookingReviewsError, null)
  assert.equal(A.derive.callRecords(s).length, 0)
})

test('review retention deduplicates by durable event ID and is independent of emergency-feed errors', () => {
  const { A, s, ingest } = workspace()
  const saved = review(), emergency = { id: 'emergency:call-two', callId: 'call-two', kind: 'emergency', durable: true, at, emergencyKind: 'gas' }
  ingest('calls', { calls: [], events: [saved, emergency] })
  const updated = review({ updatedAt: '2032-06-01T15:01:00.000Z', sourceRevision: 5, name: 'Dana updated' })
  A.apply('calls', { scope, calls: [], events: [updated], bookingReviewsError: 'partial', safetyEventsError: 'partial' })
  assert.equal(s.events.filter(event => event.id === saved.id).length, 1)
  assert.equal(s.events.find(event => event.id === saved.id).name, 'Dana updated')
  assert.equal(s.events.some(event => event.id === emergency.id), true)
  A.apply('calls', { scope, calls: [], events: [], safetyEventsError: 'partial' })
  assert.deepEqual(plain(s.events), [emergency])
})

test('anonymous shared work derivation does not borrow names, questions or handled status from another call', () => {
  const { A, s, ingest } = workspace()
  const ana = profile('call-ana', 'Ana'), ben = profile('call-ben', 'Ben')
  ingest('leads', { profiles: [ana, ben], followUps: [callback('call-ana', 'fu-ana'), callback('call-ben', 'fu-ben')] })
  const work = A.derive.needsPerson(s)
  assert.equal(work.length, 2)
  assert.deepEqual(plain(work.map(item => [item.callId, item.name, item.question])), [
    ['call-ana', 'Ana', 'Ana asked a separate question.'], ['call-ben', 'Ben', 'Ben asked a separate question.'],
  ])
  ingest('leads', { profiles: [ana, ben], followUps: [callback('call-ana', 'fu-ana', { status: 'done' }), callback('call-ben', 'fu-ben')] })
  assert.equal(A.derive.displayStage(ana, s).key, 'handled')
  assert.equal(A.derive.displayStage(ben, s).key, 'escalated')
})

test('Calls links select the exact anonymous prospect and never expose another callers completion action', () => {
  const { A, s, ingest, ui } = workspace()
  const ana = profile('call-ana', 'Ana'), ben = profile('call-ben', 'Ben')
  ingest('leads', { profiles: [ana, ben], followUps: [callback('call-ben', 'fu-ben')] })
  ingest('calls', { calls: [], events: [review({ id: 'booking-review:call-ana', callId: 'call-ana', phone: 'unknown', name: 'Ana' })] })
  const rec = A.derive.callRecords(s).find(record => record.id === 'call-ana'), story = A.derive.callStory(rec, s)
  const html = ui.panelHtml(rec, story, s)
  assert.match(html, /href="#\/leads\?phone=unknown&amp;call=call-ana/)
  assert.doesNotMatch(html, /call=call-ben|data-fu="fu-ben"|Call Ben back/)
})

test('Today follow-up links select their own anonymous prospect', () => {
  const { s, ingest, internals } = workspace()
  const task = callback('call-ben', 'fu-ben', { kind: 'nurture' })
  ingest('leads', { profiles: [profile('call-ana', 'Ana', { callbackPhone: { value: '+13125550103', callId: 'call-ana', at, confidence: 1, excerpt: 'Call me here.' } }),
    profile('call-ben', 'Ben', { callbackPhone: { value: '+13125550104', callId: 'call-ben', at, confidence: 1, excerpt: 'Call me here.' } })], followUps: [task] })
  const html = internals.followUpRowHtml(task, s)
  assert.match(html, /href="#\/leads\?phone=unknown&amp;call=call-ben"/)
  assert.doesNotMatch(html, /call=call-ana|>Ana</)
  assert.match(html, /href="tel:\+13125550104"/)
  assert.match(html, /Call requested number/)
  assert.doesNotMatch(html, /tel:\+13125550103/)
})

test('an unprojected anonymous provider call cannot borrow an existing anonymous prospect', () => {
  const { A, s, ingest, ui } = workspace()
  ingest('leads', { profiles: [profile('call-ana', 'Ana')], followUps: [] })
  ingest('calls', { calls: [{ id: 'new-hidden-call', customerNumber: null, startedAt: at,
    durationSeconds: 30, toolCalls: [], transcript: 'User: New caller.' }], events: [] })
  const rec = A.derive.callRecords(s).find(record => record.id === 'new-hidden-call')
  assert.equal(rec.profile, null)
  assert.equal(rec.name, null)
  const html = ui.panelHtml(rec, A.derive.callStory(rec, s), s)
  assert.doesNotMatch(html, /Ana|Open lead|View prospect/)
})

test('unresolved durable reviews remain in staff work after ordinary call-history age windows', () => {
  const { A, s, ingest } = workspace()
  ingest('calls', { calls: [], events: [review({ at: '2032-05-01T15:00:00.000Z', updatedAt: '2032-05-01T15:00:00.000Z' })] })
  assert.equal(A.derive.needsPerson(s).some(item => item.callId === 'call-one'), true)
})
