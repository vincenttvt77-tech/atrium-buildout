import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const index = await readFile(new URL('../../ops/src/index.html', import.meta.url), 'utf8')
const styles = await readFile(new URL('../../ops/src/polish.css', import.meta.url), 'utf8')

function dashboard({ demo = false, persistent = false, mode = 'postgres', permissions = ['read', 'operate'], reducedMotion = false } = {}) {
  let now = Date.parse('2032-06-01T15:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const window = { ATRIUM_RUNTIME_MODE: mode, ATRIUM_DEMO: demo, ATRIUM_DEMO_PERSISTENT: persistent,
    ATRIUM_ACCOUNT: { userId: 'user-one', username: 'operator', displayName: 'Operator', tenantId: 'tenant-one' },
    ATRIUM_PROPERTY: mode === 'postgres' ? { organizationId: 'org-one', propertyId: 'building-one', buildingName: 'Lake House',
      timeZone: 'America/Chicago', configurationVersion: 1, permissionVersion: 'p1', permissions, hours: { 1: [9, 17] } } : undefined }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, activeElement: null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const requests = [], animations = [], location = { hash: '#/today' }
  const context = { window, document, location, Date: Clock, Intl, URLSearchParams, structuredClone, console,
    setTimeout, clearTimeout, setInterval, clearInterval, matchMedia: () => ({ matches: reducedMotion }),
    fetch: () => { requests.push(true); assert.fail('Dashboard presentation must not dispatch a request') } }
  runInNewContext(source.replace('window.Atrium = {',
    'window.dashboardTest = { todayModel, todayPresentation, todayHeroHtml, todayView, statusView, tourRowHtml, showView }; window.Atrium = {'), context)
  const A = window.Atrium, helpers = window.dashboardTest
  const roots = new Map()
  for (const name of ['today', 'status']) {
    let html = '', writes = 0
    const root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], dataset: { view: name },
      animate: (...args) => animations.push(args),
      get innerHTML() { return html }, set innerHTML(value) { html = value; writes++ }, writes: () => writes }
    helpers[name + 'View'].root = root; roots.set(name, root)
  }
  return { A, helpers, context, roots, requests, animations,
    advance(ms) { now += ms },
    ready() {
      const at = new Clock().toISOString()
      Object.assign(A.state, { loaded: { calls: true, leads: true, calendar: true }, lastGoodAt: { calls: at, leads: at, calendar: at },
        callsConfigured: true, callsError: null, errors: {}, safetyEventsError: null, calls: [], events: [],
        leads: { profiles: [], followUps: [], tourChangeRequests: [], outboundEnabled: false,
          store: { kind: 'postgres', durable: true }, feedbackInventory: { sourceMode: 'demo', fictional: true, readAt: '2026-09-01T12:00:00Z', source: 'Fictional catalogue' } },
        calendar: { bookings: [], slots: [], blocks: [], unitBlocks: [], store: { kind: 'postgres', durable: true } } })
    },
    render(name = 'today') { helpers[name + 'View'].render(A.state); return roots.get(name).innerHTML },
  }
}

const booking = (overrides = {}) => ({ externalId: 'booking-one', slotId: 'slot-2032-06-01T17:00', startsAt: '2032-06-01T17:00:00Z',
  endsAt: '2032-06-01T17:30:00Z', bookedAt: '2032-06-01T14:00:00Z', unitId: '4A', prospectName: 'Jordan', prospectPhone: '+13125550101', ...overrides })
const profile = (overrides = {}) => ({ phone: '+13125550101', name: 'Jordan', stage: 'tour_scheduled', notes: [], signals: {},
  calls: [{ callId: 'call-one', at: '2032-06-01T14:00:00Z', toolsCalled: [], outcome: 'Tour booked' }], bookings: [], ...overrides })

test('Today opens with an actual upcoming tour and routes its brief to the correct apartment', () => {
  const ui = dashboard(); ui.ready()
  ui.A.state.calendar.bookings = [booking()]
  ui.A.state.leads.profiles = [profile()]
  const html = ui.render(), m = ui.helpers.todayModel(ui.A.state)
  assert.equal(m.toursBooked, 1)
  assert.match(html, /class="page-hero today-hero"/)
  assert.match(html, /NEXT TOUR TODAY/); assert.match(html, /12:00 PM/)
  assert.match(html, /Apartment 4A/); assert.match(html, /Central Time/)
  assert.match(html, /href="#\/units\?unit=4A"[^>]*>Prepare for this tour/)
  assert.match(html, /href="#\/leads\?tab=todo"/)
  assert.match(html, /class="today-workbench"/)
  assert.doesNotMatch(html, /revenue|conversion rate|lease probability|guaranteed/i)
  assert.equal(ui.requests.length, 0)
})

test('loading and stale records never produce a reassuring current overview or a next-tour shortcut', () => {
  const ui = dashboard(), pending = ui.render()
  assert.match(pending, /Tour schedule unconfirmed/)
  assert.match(pending, /Loading today/)
  assert.doesNotMatch(pending, /Nothing needs you|all handled|NEXT TOUR TODAY/)
  ui.ready(); ui.A.state.calendar.bookings = [booking()]
  assert.match(ui.render(), /NEXT TOUR TODAY/)
  ui.advance(61000)
  const stale = ui.render()
  assert.match(stale, /Tour schedule unconfirmed/)
  assert.match(stale, /last loaded records/)
  assert.match(stale, /Review status is not confirmed yet/)
  assert.doesNotMatch(stale, /Prepare for this tour|Nothing needs a person right now/)
  assert.match(stale, /Jordan/, 'Retain useful saved records while making their status clear')
})

test('partial errors remain distinct from a genuinely empty, fresh list', () => {
  const ui = dashboard(); ui.ready()
  const empty = ui.render()
  assert.match(empty, /Nothing needs a person right now/)
  assert.match(empty, /No tours today/)
  ui.A.state.errors.calendar = { message: 'Synthetic calendar failure', at: new Date().toISOString() }
  const failed = ui.render()
  assert.match(failed, /Today’s calendar is not confirmed yet/)
  assert.match(failed, /We can&#39;t load the calendar/)
  assert.doesNotMatch(failed, /No tours today/)
})

test('past tours remain scheduled records and simultaneous tours keep distinct focus identities', () => {
  const ui = dashboard(); ui.ready()
  ui.A.state.calendar.bookings = [booking({ startsAt: '2032-06-01T14:00:00Z', endsAt: '2032-06-01T14:30:00Z', slotId: 'slot-2032-06-01T14:00' }),
    booking({ externalId: 'booking-two', unitId: '7B', prospectPhone: '+13125550102', prospectName: 'Casey',
      startsAt: '2032-06-01T14:00:00Z', endsAt: '2032-06-01T14:30:00Z', slotId: 'slot-2032-06-01T14:00' })]
  const html = ui.render()
  assert.match(html, /Scheduled earlier/); assert.match(html, /attendance not recorded here/)
  assert.doesNotMatch(html, />Toured<|Attendance confirmed/)
  const keys = [...html.matchAll(/data-key="(tour:[^"]+)"/g)].map(match => match[1])
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 2)
})

test('the redesigned attention queue retains anonymous review requests and emergency evidence', () => {
  const ui = dashboard(); ui.ready()
  ui.A.state.events = [{ id: 'safety-one', kind: 'emergency', durable: true, callId: 'emergency-call',
    at: '2032-06-01T14:45:00Z', emergencyKind: 'gas', matched: 'I smell gas', notificationStatus: 'not_sent' }]
  ui.A.state.leads.tourChangeRequests = [{ version: 1, id: 'request-one', callId: 'change-call', firstRequestedAt: '2032-06-01T14:30:00Z',
    lastUpdatedAt: '2032-06-01T14:30:00Z', revision: 1, status: 'pending', reason: 'caller_requested', excerpts: ['Please move the tour'],
    phone: null, name: null, email: null, identityVerified: false, notificationStatus: 'not_sent' }]
  const html = ui.render()
  assert.match(html, /Emergency/); assert.match(html, /I smell gas/)
  assert.match(html, /Tour-change request/); assert.match(html, /identity unverified/)
  assert.match(html, /data-action="review-tour-change"/)
  assert.match(html, /data-request="request-one"/)
  assert.doesNotMatch(html, /staff (?:was|were) notified|booking has been moved/i)
  assert.equal(ui.requests.length, 0)
})

test('metric links contain no nested anchors when call history is disconnected', () => {
  const ui = dashboard(); ui.ready(); ui.A.state.callsConfigured = false
  const html = ui.render()
  const metric = html.match(/<a class="today-metric"[^>]+data-key="tile:Calls received">[\s\S]*?<\/a>/)?.[0]
  assert.ok(metric); assert.match(metric, /href="#\/status"/)
  assert.equal((metric.match(/<a\b/g) || []).length, 1)
  assert.match(metric, /Call history is not connected/)
})

test('Status groups useful controls without exposing a PostgreSQL account link in legacy mode', () => {
  const ui = dashboard(); ui.ready()
  const html = ui.render('status')
  assert.match(html, /class="page-hero status-hero"/)
  assert.match(html, /CONNECTIONS AND SAVING/); assert.match(html, /ACCESS AND OPERATING CONTROLS/)
  assert.match(html, /href="\/api\/account"[^>]*>Account security/)
  assert.match(html, /data-action="signout"/); assert.match(html, /data-action="refresh"/)
  assert.match(html, /Fictional demo catalogue/); assert.match(html, /not a live PMS feed/)
  assert.match(html, /Central Time/)
  assert.doesNotMatch(html, /MFA enabled|Aircall connected|PMS connected/)
  const legacy = dashboard({ mode: 'legacy' }); legacy.ready()
  assert.doesNotMatch(legacy.render('status'), /href="\/api\/account"/)
})

test('Status detail cards keep pending and stale checks neutral, including sample call history', () => {
  const ui = dashboard({ demo: true, persistent: true })
  let html = ui.render('status')
  assert.match(html, /Checking call history/)
  assert.doesNotMatch(html, /Sample calls and transcripts are included/)
  ui.ready(); html = ui.render('status')
  assert.match(html, /Sample data saved locally/)
  assert.match(html, /Sample calls and transcripts are included/)
  assert.doesNotMatch(html, /resets when the preview restarts/)
  ui.advance(61000); html = ui.render('status')
  assert.match(html, /saving check needs a refresh/)
  assert.match(html, /Call history needs a refresh/)
  assert.doesNotMatch(html, /Sample calls and transcripts are included/)
})

test('unsafe source labels and names are escaped in new hero, inventory and operating cards', () => {
  const ui = dashboard(); ui.ready(); const unsafe = '<img src=x onerror=alert(1)>'
  ui.A.state.calendar.bookings = [booking({ prospectName: unsafe, unitId: unsafe })]
  ui.A.state.leads.feedbackInventory.source = unsafe
  const html = ui.render() + ui.render('status')
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src=x/)
})

test('unchanged polling does not rewrite the redesigned views or replay navigation motion', () => {
  const ui = dashboard(); ui.ready()
  ui.render(); ui.render('status')
  const todayWrites = ui.roots.get('today').writes(), statusWrites = ui.roots.get('status').writes()
  ui.render(); ui.render('status')
  assert.equal(ui.roots.get('today').writes(), todayWrites)
  assert.equal(ui.roots.get('status').writes(), statusWrites)
  assert.equal(ui.animations.length, 0)
  assert.match(styles, /prefers-reduced-motion: reduce/)
  for (const name of ['today', 'calls', 'leads', 'units', 'calendar', 'status']) assert.match(index, new RegExp(`href="#/${name}" data-view="${name}"`))
  assert.match(index, /Briefing &amp; priorities/)
})

test('explicit page navigation has one restrained transition and reduced motion suppresses it', () => {
  for (const reducedMotion of [false, true]) {
    const ui = dashboard({ reducedMotion }); ui.ready()
    const root = ui.roots.get('today')
    ui.context.document.querySelector = selector => selector === '.view[data-view="today"]' ? root : null
    ui.A.register('today', { mount() {}, render() {} })
    ui.helpers.showView({ name: 'today', params: {} }, true)
    assert.equal(ui.animations.length, reducedMotion ? 0 : 1)
    if (!reducedMotion) assert.equal(ui.animations[0][1].duration, 180)
    ui.helpers.showView({ name: 'today', params: {} }, false)
    assert.equal(ui.animations.length, reducedMotion ? 0 : 1)
    assert.equal(ui.requests.length, 0)
  }
})
