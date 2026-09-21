import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const callsSource = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const at = '2032-06-01T15:00:00.000Z'
const checkedAt = '2032-06-01T15:05:00.000Z'
const scope = { organizationId: 'org-one', propertyId: 'building-one', configurationVersion: 3, permissionVersion: 'permissions-one' }
const attempt = { externalId: 'call-one', slotId: 'slot-one', startsAt: '2032-06-02T17:00:00.000Z', endsAt: '2032-06-02T17:30:00.000Z', unitId: '19A' }
const review = (overrides = {}) => ({ id: 'booking-review:call-one', version: 1, callId: 'call-one', kind: 'booking_review',
  durable: true, needsReview: true, at, updatedAt: at, sourceRevision: 4,
  phone: 'unknown', name: 'Dana Sample', email: 'dana@example.test',
  booking: { ...attempt, status: 'arranging' }, notificationStatus: 'not_sent', ...overrides })
const resolution = (overrides = {}) => ({ requestId: 'request-one', callId: 'call-one', sourceRevision: 4,
  actorId: 'operator-one', checkedAt, attempt, outcome: 'confirmed', booking: { ...attempt, revision: 1 }, projection: 'complete', ...overrides })
const story = (overrides = {}) => ({ needsPerson: false, emergency: false, ...overrides })
const button = (call = 'call-one', overrides = {}) => ({ dataset: { call }, disabled: false, getAttribute: () => null, ...overrides })

function workspace({ width = 1280, permissions = ['read', 'operate'] } = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [at])) }
    static now() { return Date.parse(at) }
  }
  const window = { addEventListener() {}, scrollTo() {}, scrollY: 0, ATRIUM_RUNTIME_MODE: 'postgres',
    ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'operator-one' },
    ATRIUM_PROPERTY: { ...scope, buildingName: 'Synthetic House', timeZone: 'America/Chicago', permissions, hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, activeElement: null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const context = { window, document, location: { hash: '#/calls' }, Intl, Date: Clock, URLSearchParams, structuredClone, console,
    localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? true : query.includes('min-width: 1200') ? width >= 1200 : query.includes('min-width: 960') ? width >= 960 : width <= 959 }),
    fetch: () => assert.fail('Calls rendering or action dispatch must not bypass the shared review helper') }
  runInNewContext(appSource, context)
  runInNewContext(callsSource.replace("A.register('calls', view)",
    "window.reviewResolutionUi = { bookingReviewFor, bookingReviewPresentation, checkBookingReview, callContextHtml, panelHtml, view }; A.register('calls', view)"), context)
  const A = window.Atrium, s = A.state, dispatched = [], accepted = new Map()
  // Validation belongs to the shared helper. This fixture returns only explicitly accepted DTOs.
  A.derive.bookingReviewResolution = value => accepted.get(value) || null
  A.reviewBooking = (value, trigger) => { dispatched.push({ review: value, trigger }); return 'dialog-opened' }
  const load = (events, extra = {}) => A.apply('calls', { scope, calls: [], callsConfigured: true, events, ...extra })
  A.apply('leads', { scope, profiles: [], followUps: [], tourChangeRequests: [] })
  s.calendar = { bookings: [] }; s.loaded.calendar = true
  const record = value => ({ id: value.callId, events: [value], profile: null })
  return { A, s, ui: window.reviewResolutionUi, dispatched, load, record,
    accept(value, checked) { accepted.set(value, checked); return value } }
}

test('an unresolved review offers one operate-only reservation check with its exact call identity', () => {
  for (const width of [320, 390, 1280]) {
    const { ui, record, s } = workspace({ width })
    const saved = review(), html = ui.callContextHtml(record(saved), story(), s)
    assert.match(html, /Tour booking needs verification/)
    assert.match(html, /data-action="review-booking" data-call="call-one"/)
    assert.match(html, /data-key="booking-review:call-one:check" data-write="calendar">Check reservation<\/button>/)
    assert.match(html, /href="#\/calendar"/)
    assert.doesNotMatch(html, /Mark handled|Reservation verified|data-action="book"/)
  }
  const { ui, record, s } = workspace({ permissions: ['read'] })
  const html = ui.callContextHtml(record(review()), story(), s)
  assert.match(html, /Tour booking needs verification|Review calendar/)
  assert.doesNotMatch(html, /data-action="review-booking"/)
})

test('a completed confirmation describes checked-at history and never promises a current reservation or new notification', () => {
  const { ui, record, s, accept } = workspace()
  const saved = accept(review({ needsReview: false }), resolution())
  const html = ui.callContextHtml(record(saved), story(), s)
  assert.match(html, /Booking review record/)
  assert.match(html, /Reservation verified/)
  assert.match(html, /matched this request when checked/)
  assert.match(html, /Later changes may have been made/)
  assert.match(html, /Checked .*10:05 AM/)
  assert.match(html, /This records the result at that time/)
  assert.match(html, /No notification was sent by this review/)
  assert.doesNotMatch(html, /call-context-attention|data-action="review-booking"|Tour booking needs verification|Staff notified|currently confirmed/)
})

test('definitive absence applies to the original attempt without claiming a newly arranged tour', () => {
  const { ui, record, s, accept } = workspace()
  const saved = accept(review({ needsReview: false }), resolution({ outcome: 'not_booked', booking: null }))
  const html = ui.callContextHtml(record(saved), story(), s)
  assert.match(html, /No reservation found/)
  assert.match(html, /No matching reservation was on the calendar when checked/)
  assert.match(html, /This original attempt cannot create one later/)
  assert.match(html, /Arrange another time with the prospect if needed/)
  assert.match(html, /Checked .*10:05 AM/)
  assert.doesNotMatch(html, /Reservation verified|Tour booked|data-action="review-booking"|staff records still need updating/)
})

test('a calendar receipt with unfinished projection keeps a recovery action even when needsReview is false', () => {
  for (const needsReview of [true, false]) {
    for (const outcome of ['confirmed', 'not_booked']) {
      const { ui, record, s, accept } = workspace()
      const saved = accept(review({ needsReview }), resolution({ outcome, booking: outcome === 'confirmed' ? { ...attempt, revision: 1 } : null, projection: 'pending' }))
      const html = ui.callContextHtml(record(saved), story(), s)
      assert.match(html, /call-context-attention/)
      assert.match(html, /Review updates are still pending/)
      assert.match(html, />Finish review<\/button>/)
      assert.match(html, /Finish the review before treating this request as resolved/)
      assert.doesNotMatch(html, /<h3>Reservation verified|<h3>No reservation found|Booking review record/)
    }
  }
})

test('missing or rejected resolution evidence never closes a review or presents a checked timestamp', () => {
  const { ui, record, s } = workspace()
  for (const candidate of [undefined, {}, { outcome: 'confirmed', checkedAt }, { projection: 'complete', ...resolution(), callId: 'other-call' }]) {
    const saved = review({ needsReview: false, resolution: candidate })
    const html = ui.callContextHtml(record(saved), story(), s)
    assert.match(html, /call-context-attention/)
    assert.match(html, /Tour booking needs verification/)
    assert.match(html, /could not be verified/)
    assert.doesNotMatch(html, /<h3>Reservation verified|No reservation found|Checked |Booking review record|data-action="review-booking"/)
  }
})

test('an inconsistent completed DTO with needsReview true stays unresolved', () => {
  const { ui, record, s, accept } = workspace()
  const saved = accept(review(), resolution())
  const html = ui.callContextHtml(record(saved), story(), s)
  assert.match(html, /Tour booking needs verification/)
  assert.match(html, />Check reservation<\/button>/)
  assert.doesNotMatch(html, /<h3>Reservation verified|Booking review record|Checked /)
})

test('a foreign call review cannot supply a review action or contact details to this call', () => {
  const { ui, s } = workspace()
  const rec = { id: 'call-other', events: [review()], profile: null }
  assert.equal(ui.bookingReviewFor(rec), null)
  const html = ui.callContextHtml(rec, story(), s)
  assert.doesNotMatch(html, /review-booking|dana@example.test|Residence 19A|Requested callback|Tour booking needs verification/)
})

test('review contact and apartment values remain escaped in the new actionable card', () => {
  const { ui, record, s } = workspace()
  const saved = review({ email: '<svg/onload=bad>@example.test', booking: { ...attempt, unitId: '<19A>' },
    callbackPhone: { value: '<script>bad</script>' } })
  const html = ui.callContextHtml(record(saved), story(), s)
  assert.match(html, /Residence &lt;19A&gt;/)
  assert.match(html, /Requested callback: &lt;script&gt;bad&lt;\/script&gt;/)
  assert.match(html, /Email: &lt;svg\/onload=bad&gt;@example.test/)
  assert.doesNotMatch(html, /<script>|<svg\/onload/)
})

test('completed evidence preserves separate exact-call staff work and anonymous prospect navigation', () => {
  const { ui, record, s, accept } = workspace()
  const saved = accept(review({ needsReview: false }), resolution())
  const rec = { ...record(saved), profile: { phone: 'unknown' } }
  s.leads.followUps = [{ id: 'fu-one', createdFromCall: 'call-one', status: 'scheduled' }, { id: 'fu-other', createdFromCall: 'call-other', status: 'scheduled' }]
  s.leads.tourChangeRequests = [{ id: 'change-one', callId: 'call-one', status: 'pending', excerpts: ['Please move this tour later.'] },
    { id: 'change-other', callId: 'call-other', status: 'pending', excerpts: ['Another caller private detail'] }]
  const html = ui.callContextHtml(rec, story({ needsPerson: true, emergency: true }), s)
  assert.match(html, /call-context-attention/)
  assert.match(html, /Review staff work/)
  assert.match(html, /Please move this tour later/)
  assert.match(html, /phone=unknown&amp;call=call-one/)
  assert.doesNotMatch(html, /Another caller private detail|call=call-other|data-fu="fu-other"/)
})

test('dispatch re-reads the latest review and passes it to the shared helper without its own mutation', () => {
  const { ui, load, dispatched } = workspace()
  const saved = review(), updated = review({ sourceRevision: 5, updatedAt: checkedAt })
  load([saved])
  load([updated])
  const trigger = button()
  assert.equal(ui.checkBookingReview(trigger), 'dialog-opened')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].review, updated)
  assert.equal(dispatched[0].trigger, trigger)
})

test('viewer, disabled, busy, missing-call and completed buttons cannot invoke the review helper', () => {
  const viewer = workspace({ permissions: ['read'] })
  viewer.load([review()]); viewer.ui.checkBookingReview(button())
  assert.equal(viewer.dispatched.length, 0)
  const { A, ui, load, dispatched, accept } = workspace()
  load([review()])
  for (const trigger of [null, button('missing-call'), button('call-one', { disabled: true }), button('call-one', { getAttribute: () => 'true' })]) ui.checkBookingReview(trigger)
  A.busyNow = () => true
  ui.checkBookingReview(button())
  assert.equal(dispatched.length, 0)
  A.busyNow = () => false
  load([accept(review({ needsReview: false }), resolution())])
  ui.checkBookingReview(button())
  assert.equal(dispatched.length, 0)
})

test('unfinished projection dispatches through the helper and unavailable helper fails safely', () => {
  const { A, ui, load, dispatched, accept, record, s } = workspace()
  const saved = accept(review({ needsReview: false }), resolution({ projection: 'pending' }))
  load([saved]); ui.checkBookingReview(button())
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].review, saved)
  delete A.reviewBooking
  assert.doesNotThrow(() => ui.checkBookingReview(button()))
  assert.doesNotMatch(ui.callContextHtml(record(saved), story(), s), /data-action="review-booking"/)
})
