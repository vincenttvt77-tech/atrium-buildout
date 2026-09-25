import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const app = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const calls = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const at = '2032-06-01T15:00:00.000Z'
const summary = id => ({ callId: id, at, durationSeconds: 4, outcome: 'Enquired', toolsCalled: [] })
const profile = ids => ({ phone: 'unknown', name: 'Synthetic fixture', stage: 'new', firstSeenAt: at,
  lastSeenAt: at, calls: ids.map(summary), bookings: [], signals: {}, notes: [], escalations: [], unitsDiscussed: [] })

function workspace({ demo = false } = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [at])) }
    static now() { return Date.parse(at) }
  }
  const window = { addEventListener() {}, ATRIUM_DEMO: demo, ATRIUM_RUNTIME_MODE: 'postgres',
    ATRIUM_ACCOUNT: { username: 'operator', userId: 'operator' },
    ATRIUM_PROPERTY: { organizationId: 'org-one', propertyId: 'property-one', buildingName: 'Fixture House',
      timeZone: 'America/Chicago', configurationVersion: 1, permissionVersion: 'one', permissions: ['read'], hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], getElementById: () => null, activeElement: null,
    body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const context = { window, document, location: { hash: '#/today' }, Date: Clock, Intl,
    URLSearchParams, structuredClone, console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }),
    fetch: () => assert.fail('Evidence rendering must not contact a provider') }
  runInNewContext(app.replace('window.Atrium = {',
    'window.evidenceTest = { todayModel, todayView, recentCallRowHtml, ingest }; window.Atrium = {'), context)
  runInNewContext(calls.replace("A.register('calls', view)",
    "window.evidenceCalls = { rowHtml, panelHtml }; A.register('calls', view)"), context)
  const A = window.Atrium, s = A.state
  Object.assign(s, { calls: [], events: [], callsConfigured: true, errors: {},
    loaded: { calls: true, leads: true, calendar: true }, lastGoodAt: { calls: at, leads: at, calendar: at },
    leads: { profiles: [], followUps: [], tourChangeRequests: [], store: { durable: true } },
    calendar: { bookings: [], slots: [], blocks: [], store: { durable: true } } })
  const root = { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [] }
  window.evidenceTest.todayView.root = root
  return { A, s,
    model: () => window.evidenceTest.todayModel(s),
    history(records) { window.evidenceTest.ingest('calls', { calls: records, events: [], callsConfigured: true,
      scope: { organizationId: 'org-one', propertyId: 'property-one', configurationVersion: 1, permissionVersion: 'one' } }) },
    today() { window.evidenceTest.todayView.render(s); return root.innerHTML },
    rows(record) {
      const story = A.derive.callStory(record, s)
      return { today: window.evidenceTest.recentCallRowHtml(record, s),
        calls: window.evidenceCalls.rowHtml(record, story, false, false, false),
        detail: window.evidenceCalls.panelHtml(record, story, s) }
    },
  }
}

test('retained summaries are labelled on Today as well as Calls without claiming verified phone activity', () => {
  const ui = workspace(); ui.s.leads.profiles = [profile(['summary-only'])]
  const record = ui.A.derive.callRecords(ui.s)[0], html = ui.rows(record)
  assert.equal(record.call, null)
  assert.match(html.today, /Saved summary/)
  assert.match(html.calls, /Saved summary/)
  assert.match(html.detail, /matching call is not in the loaded history/)
  assert.match(html.today, /Saved notes:/)
  assert.doesNotMatch(html.detail, /Synthetic fixture called/)
  assert.doesNotMatch(html.today + html.calls + html.detail, /Demo record|verified phone call/)
})

test('notes and call history remain deduplicated records and are not reported as received calls', () => {
  const ui = workspace(); ui.s.leads.profiles = [profile(['history-one', 'summary-only'])]
  ui.s.calls = [{ id: 'history-one', startedAt: at, customerNumber: null, toolCalls: [], transcript: 'User: Hello.' }]
  ui.s.events = [{ callId: 'tool-only', kind: 'availability_checked', at, outcome: 'no_availability' }]
  const model = ui.model(), html = ui.today()
  assert.equal(model.callsValue, '3')
  assert.equal(model.records.length, 3)
  assert.match(model.callsNote, /1 from call history.*2 from saved notes/)
  assert.match(html, /Call records/)
  assert.doesNotMatch(html, /Calls received/)
  assert.match(model.briefing, /3 call records/)
})

test('an empty notes-only workspace cannot say that no calls arrived', () => {
  const ui = workspace(); ui.s.callsConfigured = false
  assert.equal(ui.model().callsValue, '0')
  assert.match(ui.model().callsNote, /Call history not connected/)
  assert.match(ui.today(), /no call records loaded/i)
  assert.doesNotMatch(ui.today(), /no calls yet|Calls received/)
})

test('tool-only activity retains its record and staff attention with an explicit source label', () => {
  const ui = workspace()
  ui.s.events = [{ id: 'report', callId: 'tool-only', kind: 'emergency', durable: true,
    at, emergencyKind: 'fire', matched: 'synthetic fixture', notificationStatus: 'not_sent', phone: 'unknown' }]
  const record = ui.A.derive.callRecords(ui.s)[0], html = ui.rows(record)
  assert.equal(ui.A.derive.callStory(record, ui.s).emergency, true)
  assert.match(html.today, /Saved tool activity/)
  assert.match(html.calls, /Saved tool activity/)
  assert.match(html.detail, /does not establish a completed phone call/)
})

test('explicit demo mode labels every source as sample data without guessing from a name or ID', () => {
  const demo = workspace({ demo: true }); demo.s.leads.profiles = [profile(['real-looking-id'])]
  const sample = demo.rows(demo.A.derive.callRecords(demo.s)[0])
  assert.match(sample.today, /Demo record/); assert.match(sample.calls, /Demo record/)
  assert.match(sample.detail, /Sample conversation data/)
  const normal = workspace(); normal.s.calls = [{ id: 'synthetic-release-not-proof', startedAt: at,
    customerNumber: null, transcript: 'User: I live in Demo House.', toolCalls: [] }]
  const real = normal.rows(normal.A.derive.callRecords(normal.s)[0])
  assert.match(real.today, /Transcript/)
  assert.doesNotMatch(real.today + real.calls + real.detail, /Demo record|Sample conversation data/)
})

test('a full provider page reports the known union lower bound, including extra retained summaries', () => {
  const ui = workspace()
  ui.s.calls = Array.from({ length: 20 }, (_, i) => ({ id: 'history-' + i, startedAt: at, customerNumber: null, toolCalls: [] }))
  ui.s.leads.profiles = [profile(['summary-a', 'summary-b'])]
  assert.equal(ui.model().callsValue, '22+')
  assert.match(ui.model().briefing, /22\+ call records/)
})

test('late history matches replace a retained source label without duplicating its old record', () => {
  const ui = workspace(), past = '2032-05-01T15:00:00.000Z'
  ui.s.leads.profiles = [profile(['older-record'])]
  ui.s.leads.profiles[0].calls[0].at = past
  assert.match(ui.today(), /Saved summary/)
  ui.history([{ id: 'older-record', startedAt: past, customerNumber: null, toolCalls: [], transcript: 'User: Hello.' }])
  assert.equal(ui.model().records.length, 1)
  assert.equal(ui.model().callsValue, '0')
  assert.match(ui.today(), /Transcript/)
  assert.doesNotMatch(ui.today(), /Saved summary/)
})
