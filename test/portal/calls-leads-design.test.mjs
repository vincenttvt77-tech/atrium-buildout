import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const callsSource = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const leadsSource = await readFile(new URL('../../ops/src/leads.js', import.meta.url), 'utf8')
const callsCss = await readFile(new URL('../../ops/src/calls.css', import.meta.url), 'utf8')
const leadsCss = await readFile(new URL('../../ops/src/leads.css', import.meta.url), 'utf8')
const at = '2032-06-01T15:00:00.000Z'
const plain = value => JSON.parse(JSON.stringify(value))

function workspace({ permissions = ['read', 'operate'], mobile = false } = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [at])) }
    static now() { return Date.parse(at) }
  }
  const window = { addEventListener() {}, scrollTo() {}, scrollY: 0,
    ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'user-one' },
    ATRIUM_PROPERTY: { organizationId: 'org-one', propertyId: 'building-one', buildingName: 'Lake House', timeZone: 'America/Chicago',
      configurationVersion: 3, permissionVersion: 'permissions-one', permissions, hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, activeElement: null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const location = { hash: '#/calls' }, requests = []
  const context = { window, document, location, Intl, Date: Clock, URLSearchParams, structuredClone, console,
    localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? true : query.includes('max-width') ? mobile : !mobile }),
    fetch: (...args) => { requests.push(args); assert.fail('Rendering must not make a provider request') } }
  runInNewContext(appSource, context)
  runInNewContext(callsSource.replace("A.register('calls', view)",
    "window.callDesign = { callOverviewHtml, callContextHtml, callWork, rowHtml, panelHtml, view }; A.register('calls', view)"), context)
  runInNewContext(leadsSource.replace("A.register('leads', view)",
    "window.leadDesign = { leadOverviewHtml, leadBriefHtml, leadRowHtml, leadPanelHtml, todoListHtml, view }; A.register('leads', view)"), context)
  const A = window.Atrium
  A.state.loaded = { leads: true, calls: true, calendar: true }
  A.state.lastGoodAt = { leads: at, calls: at, calendar: at }
  A.state.leads = { profiles: [], followUps: [], tourChangeRequests: [], outboundEnabled: false }
  A.state.calendar = { bookings: [] }
  A.state.calls = []
  const classes = () => {
    const values = new Set()
    return { contains: key => values.has(key), add: key => values.add(key), remove: key => values.delete(key),
      toggle(key, on) { on ? values.add(key) : values.delete(key) } }
  }
  function mount(name) {
    location.hash = '#/' + name
    const controls = new Map(), writes = new Map()
    const control = selector => {
      if (!controls.has(selector)) {
        let html = ''
        const el = { hidden: false, style: {}, value: '', dataset: {}, classList: classes(), scrollTop: 0,
          textContent: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [],
          addEventListener() {}, setAttribute() {}, removeAttribute() {} }
        Object.defineProperty(el, 'innerHTML', { get: () => html, set(value) { html = value; writes.set(selector, (writes.get(selector) || 0) + 1) } })
        controls.set(selector, el)
      }
      return controls.get(selector)
    }
    const tabs = ['todo', 'all'].map(key => ({ dataset: { tab: key }, textContent: '', setAttribute() {} }))
    control('.tabs').querySelectorAll = () => tabs
    const root = { innerHTML: '', hidden: false, querySelector: control, querySelectorAll: () => [], addEventListener() {} }
    const view = name === 'calls' ? window.callDesign.view : window.leadDesign.view
    view.mount(root); view.render(A.state)
    return { root, view, controls, writes, tabs }
  }
  return { A, s: A.state, calls: window.callDesign, leads: window.leadDesign, requests, mount }
}
const prospect = (overrides = {}) => ({ phone: '+13125550101', name: 'Jordan', stage: 'new',
  firstSeenAt: at, lastSeenAt: at, calls: [], bookings: [], signals: {}, escalations: [], notes: [], unitsDiscussed: [], ...overrides })
const booking = (overrides = {}) => ({ status: 'confirmed', externalId: 'booking-one', slotId: 'slot-one', unitId: '4A',
  startsAt: '2032-06-02T17:00:00Z', endsAt: '2032-06-02T17:45:00Z', callId: 'call-one', ...overrides })
const request = (overrides = {}) => ({ id: 'request-one', callId: 'call-one', phone: '+13125550101', name: 'Jordan',
  status: 'pending', reason: 'caller_requested', firstRequestedAt: at, lastUpdatedAt: at, revision: 1,
  identityVerified: false, notificationStatus: 'not_sent', excerpts: ['Please move my tour to Friday.'], ...overrides })
const followUp = (overrides = {}) => ({ id: 'followup-one', phone: '+13125550101', kind: 'callback', status: 'scheduled',
  dueAt: '2032-06-01T14:00:00Z', createdAt: at, createdFromCall: 'call-one', channel: 'call', reason: 'Answer the question', ...overrides })
const record = (overrides = {}) => ({ id: 'call-one', phone: '+13125550101', name: 'Jordan', displayName: 'Jordan', startedAt: at,
  durationSeconds: 80, profile: null, events: [], call: { startedAt: at, transcript: 'User: Hi.\nAI: How can I help?', toolCalls: [] }, ...overrides })

test('overview shows unknown before loading, and counts only saved records with clear stale provenance', () => {
  const ui = workspace(), rec = record(), story = ui.A.derive.callStory(rec, ui.s), stories = new Map([[rec.id, story]])
  ui.s.loaded = { calls: false, leads: false, calendar: false }
  const waiting = ui.calls.callOverviewHtml(ui.s, [], new Map())
  assert.equal((waiting.match(/class="metric-value num">—/g) || []).length, 3)
  assert.doesNotMatch(waiting, /class="metric-value num">0/)
  ui.s.loaded.leads = true; ui.s.errors.calls = 'unavailable'
  ui.s.leads.tourChangeRequests = [request()]
  const saved = ui.calls.callOverviewHtml(ui.s, [rec], stories)
  assert.match(saved, /Saved call records.*?>1</)
  assert.match(saved, /Saved snapshot · refresh needed/)
  assert.match(saved, /Calls to review.*?>1</)
  assert.doesNotMatch(saved, /conversion|all-time|last 20|live activity/i)
})

test('work queue metrics count dedicated requests plus scheduled tasks without counting reviewed or skipped work', () => {
  const ui = workspace()
  ui.s.leads.profiles = [prospect({ bookings: [booking()] }), prospect({ phone: '+13125550102', bookings: [booking({ startsAt: '2032-05-01T17:00:00Z' })] })]
  ui.s.leads.followUps = [followUp(), followUp({ id: 'skipped', status: 'skipped' })]
  ui.s.leads.tourChangeRequests = [request(), request({ id: 'reviewed', status: 'reviewed' })]
  const html = ui.leads.leadOverviewHtml(ui.s)
  assert.match(html, /Saved prospects.*?>2</)
  assert.match(html, /Prospects with tours.*?>1</)
  assert.match(html, /Open staff tasks.*?>2</)
  assert.match(html, /1 follow-ups · 1 tour requests · 1 overdue/)
  const mounted = ui.mount('leads')
  assert.equal(mounted.tabs[0].textContent, 'Work queue · 2')
  assert.equal(mounted.tabs[1].textContent, 'Prospects · 2')
  assert.match(mounted.controls.get('.leads-list').innerHTML, /data-action="review-tour-change"/)
})

test('call-to-request handoff preserves the original words and never reports rescheduling or notification', () => {
  const ui = workspace(), p = prospect(), rec = record({ profile: p })
  ui.s.leads.tourChangeRequests = [request({ excerpts: ['Please <script>cancel</script> my tour.'] })]
  const story = ui.A.derive.callStory(rec, ui.s)
  const html = ui.calls.panelHtml(rec, story, ui.s)
  assert.match(html, /Tour change awaiting staff review/)
  assert.match(html, /does not confirm a changed tour or a notification/)
  assert.match(html, /Please &lt;script&gt;cancel&lt;\/script&gt; my tour/)
  assert.match(html, /href="#\/leads\?tab=todo&amp;phone=%2B13125550101"/)
  assert.match(html, /Review staff work/)
  assert.doesNotMatch(html, /<script>|Staff notified|Tour rescheduled/)
  assert.equal(ui.requests.length, 0)
})

test('call detail keeps safe audio, escaped transcript, keyboard actions and truthful missing evidence', () => {
  const ui = workspace(), rec = record({ call: { toolCalls: [], transcript: 'User: <img src=x onerror=alert(1)>\nAI: Hello.', recordingUrl: 'https://storage.vapi.ai/recording.wav' } })
  const story = ui.A.derive.callStory(rec, ui.s), html = ui.calls.panelHtml(rec, story, ui.s)
  assert.match(html, /href="https:\/\/storage.vapi.ai\/recording.wav" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /data-action="read"/)
  assert.match(html, /data-key="convo"/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /No structured requirements were saved/)
  assert.match(html, /No completed tool actions/)
  rec.call.recordingUrl = 'javascript:alert(1)'
  const unsafe = ui.calls.panelHtml(rec, story, ui.s)
  assert.doesNotMatch(unsafe, /href="javascript:|Listen to the recording/)
  const row = ui.calls.rowHtml(rec, story, true, true, false)
  assert.match(row, /aria-current="true" tabindex="0"/)
  assert.match(row, /Transcript/)
  assert.doesNotMatch(row, / · Audio/)
})

test('fictional recording placeholders are not offered as playable audio in a demo', () => {
  const ui = workspace(), rec = record({ call: { toolCalls: [], transcript: 'User: Synthetic call.', recordingUrl: 'https://example.com/recordings/dev-call-09.wav' } })
  const story = ui.A.derive.callStory(rec, ui.s)
  assert.doesNotMatch(ui.calls.panelHtml(rec, story, ui.s), /Listen to the recording|href="https:\/\/example\.com/)
  assert.doesNotMatch(ui.calls.rowHtml(rec, story), / · Audio/)
})

test('skipped callback is not displayed as handled; completed callback retains the exact existing action receipt', () => {
  const ui = workspace(), p = prospect(), rec = record({ profile: p,
    events: [{ kind: 'escalated', trigger: 'restricted:reasonable_accommodation', detail: 'Please ask a person', at }] })
  const story = ui.A.derive.callStory(rec, ui.s)
  ui.s.leads.followUps = [followUp({ status: 'skipped' })]
  assert.match(ui.calls.panelHtml(rec, story, ui.s), /Marked not needed/)
  assert.doesNotMatch(ui.calls.panelHtml(rec, story, ui.s), /Handled — a person marked/)
  ui.s.leads.followUps[0].status = 'done'
  assert.match(ui.calls.panelHtml(rec, story, ui.s), /Handled — a person marked this done/)
  ui.s.leads.followUps[0].status = 'scheduled'
  assert.match(ui.calls.panelHtml(rec, story, ui.s), /data-action="handled" data-fu="followup-one".*?data-write="leads"/)
})

test('prospect brief preserves budget floor, move-in evidence, property time and apartment/call paths', () => {
  const ui = workspace(), p = prospect({ stage: 'tour_booked', signals: {
    budgetRange: { value: { minMonthly: 8000, maxMonthly: null }, confidence: 1, excerpt: 'Over eight thousand' },
    bedrooms: { value: 2, confidence: 1, excerpt: 'Two bedrooms' },
    moveIn: { value: { earliest: '2032-06-01', latest: '2032-09-01' }, confidence: .9, excerpt: 'Within three months' },
  }, bookings: [booking()], unitsDiscussed: ['4A'], calls: [{ callId: 'call-one', at, outcome: 'Booked a tour of 4A' }] })
  ui.s.leads.profiles = [p]
  ui.s.calls = [{ ...record().call, id: 'call-one', customerNumber: p.phone }]
  const html = ui.leads.leadPanelHtml(p, ui.s)
  assert.match(html, /\$8,000\+\/mo/)
  assert.doesNotMatch(html, /up to \$8,000/)
  assert.match(html, /Within three months/)
  assert.match(html, /Next tour recorded on profile/)
  assert.match(html, /12:00 PM/)
  assert.match(html, /href="#\/units\?unit=4A"/)
  assert.match(html, /href="#\/calls\?id=call-one"/)
  assert.match(html, /href="#\/calendar\?date=2032-06-02&amp;slot=slot-one"/)
  assert.match(html, /does not place or log a call in Atrium/)
  assert.match(html, /Not in the loaded calendar window/)
  assert.doesNotMatch(html, /No longer on the calendar/)
  assert.equal(ui.requests.length, 0)
})

test('lead rows and historical details do not turn elapsed bookings into attendance or old requests into handled actions', () => {
  const ui = workspace(), p = prospect({ stage: 'tour_booked', bookings: [booking({ startsAt: '2032-05-01T17:00:00Z' })],
    escalations: [{ callId: 'old-call', at, trigger: 'tour_change', detail: 'Please move the tour' }] })
  ui.s.leads.profiles = [p]
  const row = ui.leads.leadRowHtml(p, ui.s, true, true)
  assert.match(row, /Tour booked/)
  assert.doesNotMatch(row, />Toured<|attendance confirmed/)
  const html = ui.leads.leadPanelHtml(p, ui.s)
  assert.match(html, /Earlier request/)
  assert.doesNotMatch(html, /Handled —/)
  assert.match(html, /No upcoming tour is recorded on this profile/)
})

test('read-only prospect and tour-request details retain navigation without exposing edit controls', () => {
  const ui = workspace({ permissions: ['read'] }), p = prospect({ unitsDiscussed: ['4A'] })
  ui.s.leads.profiles = [p]; ui.s.leads.tourChangeRequests = [request()]
  const before = plain(ui.s.leads)
  const queue = ui.leads.todoListHtml(ui.s), panel = ui.leads.leadPanelHtml(p, ui.s)
  assert.match(queue, /identity unverified/)
  assert.match(queue, /No tour change or notification is made/)
  assert.doesNotMatch(queue, /data-action="review-tour-change"/)
  assert.doesNotMatch(panel, /class="note-form"/)
  assert.match(panel, /href="#\/units\?unit=4A"/)
  assert.deepEqual(plain(ui.s.leads), before)
  assert.equal(ui.requests.length, 0)
})

test('unchanged refreshes leave overview and detail DOM intact in both workspaces', () => {
  for (const name of ['calls', 'leads']) {
    const ui = workspace(), mounted = ui.mount(name)
    const first = new Map(mounted.writes)
    mounted.view.render(ui.s)
    assert.deepEqual(mounted.writes, first, `${name} should preserve the existing regions on an unchanged refresh`)
    assert.match(mounted.root.innerHTML, /page-hero/)
    assert.match(mounted.root.innerHTML, /workspace-panel/)
  }
})

test('mobile detail views and reduced motion have explicit scoped layouts without truncating saved words', () => {
  for (const [name, css] of [['calls', callsCss], ['leads', leadsCss]]) {
    const ui = workspace({ mobile: true }), mounted = ui.mount(name)
    assert.match(mounted.root.innerHTML, /Search.*name, number or apartment/)
    assert.match(css, /\.has-panel > \.page-hero/)
    assert.match(css, /prefers-reduced-motion: reduce/)
    assert.match(css, /animation: none; transition: none/)
    assert.match(css, /overflow-wrap: anywhere/)
    assert.match(css, /min-height: 44px/)
  }
})
