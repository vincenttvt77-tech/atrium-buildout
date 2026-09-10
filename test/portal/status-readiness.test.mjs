import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')

/** Render real source with a controlled clock and optional synthetic request lifecycle. */
function portal({ demo = false, persistent = false } = {}) {
  let clock = Date.parse('2032-06-01T15:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  const window = { ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_DEMO: demo, ATRIUM_DEMO_PERSISTENT: persistent,
    ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'user-one' },
    ATRIUM_PROPERTY: { organizationId: 'organization-one', propertyId: 'property-one', buildingName: 'Lake House',
      locationLabel: 'Chicago, IL', timeZone: 'America/Chicago', configurationVersion: 1,
      permissionVersion: 'permissions-v1', permissions: ['read', 'operate'], hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, body: { textContent: '', classList: { toggle() {}, add() {}, remove() {} } } }
  let transport = () => assert.fail('Rendering readiness must not start a request'), timerId = 0
  const timers = new Map(), messages = [], requests = []
  window.toastResultsForTest = messages
  runInNewContext(source.replace('window.Atrium = {', 'window.statusViewForTest = statusView; window.pollingForTest = { fetchOne, pollRound }; window.Atrium = {')
    .replace('function toast(txt, opts) {', 'function toast(txt, opts) { window.toastResultsForTest.push({ text: txt, ...opts });'),
    { window, document, Intl, Date: Clock, console, URLSearchParams, structuredClone,
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
      clearTimeout(id) { timers.delete(id) }, setInterval, clearInterval,
      matchMedia: () => ({ matches: false }), location: { hash: '#/status' },
      fetch(path, options) { requests.push({ path, ...options }); return transport(path, options) } })
  const state = window.Atrium.state
  const root = { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [] }
  window.statusViewForTest.root = root
  const buttonClasses = new Set(), buttonAttributes = new Map()
  const button = { isConnected: true, classList: { add(name) { buttonClasses.add(name) }, remove(name) { buttonClasses.delete(name) } },
    setAttribute(name, value) { buttonAttributes.set(name, value) }, removeAttribute(name) { buttonAttributes.delete(name) } }
  return { state, app: window.Atrium, polling: window.pollingForTest, messages, requests,
    manualRefresh: () => window.statusViewForTest.refreshNow(button),
    busy: () => window.statusViewForTest.busyAction,
    buttonBusy: () => buttonClasses.has('is-busy') || buttonAttributes.has('aria-busy'),
    activeTimers: () => timers.size,
    expireRefresh() {
      assert.equal(timers.size, 1)
      const [id, timer] = [...timers][0]
      assert.equal(timer.delay, 15000)
      clock += timer.delay; timers.delete(id); timer.callback()
    },
    advance(ms) { clock += ms },
    transport(fn) { transport = fn },
    markRefreshedNow() { window.statusViewForTest.refreshedAt = clock },
    success() {
      const p = window.ATRIUM_PROPERTY
      return { ok: true, status: 200, json: async () => ({
        scope: { organizationId: p.organizationId, propertyId: p.propertyId,
          configurationVersion: p.configurationVersion, permissionVersion: p.permissionVersion },
        timeZone: p.timeZone, store: { kind: 'postgres', durable: true }, callsConfigured: true,
        calls: [], events: [], profiles: [], followUps: [], slots: [], bookings: [], blocks: [],
      }) }
    },
    ready() {
      state.loaded = { leads: true, calendar: true, calls: true }
      state.leads = { profiles: [], followUps: [], store: { kind: 'postgres', durable: true } }
      state.calendar = { slots: [], bookings: [], blocks: [], store: { kind: 'postgres', durable: true } }
      state.callsConfigured = true
      state.updatedAt = new Clock().toISOString()
      state.lastGoodAt = { leads: state.updatedAt, calendar: state.updatedAt, calls: state.updatedAt }
    },
    render() {
      window.statusViewForTest.render(state)
      const title = root.innerHTML.match(/<div class="summary-title">([^<]*)<\/div>/)?.[1]
      const detail = root.innerHTML.match(/<div class="summary-sub">([^<]*)<\/div>/)?.[1]
      const classes = root.innerHTML.match(/class="card status-summary ([^"]*)"/)?.[1]
      assert.ok(title); assert.ok(detail)
      return { title, detail, classes }
    },
  }
}

test('initial pending checks are neutral and do not claim connections are available', () => {
  const ui = portal(), summary = ui.render()
  assert.equal(summary.title, 'Checking this workspace…')
  assert.match(summary.detail, /callers and to-dos.*calendar.*call history/)
  assert.equal(summary.classes, '')
  assert.doesNotMatch(summary.title, /available|attention/)
})

test('one successful load still waits for the other resources and repaints after completion', () => {
  const ui = portal()
  ui.state.loaded.leads = true
  ui.state.leads = { profiles: [], followUps: [], store: { kind: 'postgres', durable: true } }
  ui.state.updatedAt = '2032-06-01T15:00:00Z'
  const partial = ui.render()
  assert.equal(partial.title, 'Still checking this workspace…')
  assert.match(partial.detail, /calendar.*call history/)
  assert.doesNotMatch(partial.detail, /Updated|callers/)
  assert.equal(partial.classes, '')
  ui.ready()
  const full = ui.render()
  assert.equal(full.title, 'Workspace data is available.')
  assert.match(full.detail, /Callers, calendar and call history are loaded/)
  assert.equal(full.classes, 'is-ok')
  assert.doesNotMatch(full.title + full.detail, /all connections|phone assistant|PMS|live availability/i)
})

test('a partial failure is visible even when another success resets consecutive failure counts', () => {
  const ui = portal()
  ui.state.loaded.leads = true
  ui.state.leads = { profiles: [], followUps: [], store: { durable: true } }
  ui.state.failedRounds = 0
  ui.state.errors.calendar = { message: 'Synthetic unavailable calendar', at: '2032-06-01T15:00:00Z' }
  ui.state.updatedAt = '2032-06-01T15:00:00Z'
  const summary = ui.render()
  assert.equal(summary.title, 'Some workspace information is unavailable.')
  assert.match(summary.detail, /Couldn’t refresh calendar/)
  assert.equal(summary.classes, 'is-warn')
})

test('an error after previous success never presents cached data as fully current', () => {
  const ui = portal()
  ui.ready()
  assert.equal(ui.render().classes, 'is-ok')
  ui.state.errors.leads = { message: 'Synthetic refresh failure', at: '2032-06-01T15:05:00Z' }
  ui.state.updatedAt = '2032-06-01T15:05:00Z'
  const summary = ui.render()
  assert.match(summary.detail, /Couldn’t refresh callers and to-dos.*out of date/)
  assert.equal(summary.classes, 'is-warn')
  delete ui.state.errors.leads
  assert.equal(ui.render().classes, 'is-ok')
})

test('missing saving, call-history or read-time evidence remains unconfirmed after data loads', () => {
  for (const missing of ['saving', 'call-history', 'read-time']) {
    const ui = portal()
    ui.ready()
    if (missing === 'saving') ui.state.leads.store = null
    else if (missing === 'call-history') ui.state.callsConfigured = null
    else delete ui.state.lastGoodAt.calls
    const summary = ui.render()
    assert.equal(summary.title, 'Some workspace checks are unconfirmed.')
    assert.notEqual(summary.classes, 'is-ok')
  }
})

test('unconnected hosted call history is distinct from available local sample history', () => {
  const hosted = portal()
  hosted.ready(); hosted.state.callsConfigured = false
  assert.equal(hosted.render().title, 'Call history isn’t connected.')
  const local = portal({ demo: true, persistent: true })
  local.ready(); local.state.callsConfigured = false
  const summary = local.render()
  assert.equal(summary.title, 'Local demo data is loaded.')
  assert.match(summary.detail, /Sample callers, tours and call history are loaded/)
  assert.equal(summary.classes, 'is-ok')
  assert.doesNotMatch(summary.title + summary.detail, /all connections|phone assistant|live|PMS/i)
})

test('persistent saving failures warn while explicitly temporary samples describe their reset', () => {
  const persistent = portal({ demo: true, persistent: true })
  persistent.ready(); persistent.state.calendar.store = { kind: 'memory', durable: false }
  assert.equal(persistent.render().title, 'Saving needs attention.')
  const temporary = portal({ demo: true })
  temporary.ready()
  temporary.state.leads.store = temporary.state.calendar.store = { kind: 'memory', durable: false }
  const summary = temporary.render()
  assert.equal(summary.title, 'Demo data is loaded.')
  assert.match(summary.detail, /reset when the preview restarts/)
  assert.notEqual(summary.classes, 'is-ok')
})

test('safety and call-history feed errors remain visible even when every request loaded', () => {
  for (const [field, title] of [['safetyEventsError', 'Safety reports need attention.'], ['callsError', 'Call history needs attention.']]) {
    const ui = portal({ demo: true, persistent: true })
    ui.ready(); ui.state[field] = 'Synthetic feed unavailable'
    const summary = ui.render()
    assert.equal(summary.title, title)
    assert.equal(summary.classes, 'is-warn')
  }
})

test('failed initial checks and missing setup never look like successful loading', () => {
  const failed = portal()
  failed.state.errors.calls = { message: 'Synthetic request failure', at: '2032-06-01T15:00:00Z' }
  assert.equal(failed.render().title, 'Workspace information is unavailable.')
  const unconfigured = portal()
  unconfigured.state.notConfigured = true
  assert.equal(unconfigured.render().title, 'This workspace needs setup.')
})

test('complete freshness uses the oldest resource check, not a newer aggregate or button timestamp', () => {
  const ui = portal()
  ui.ready(); ui.advance(5000)
  ui.state.updatedAt = ui.state.lastGoodAt.leads = ui.state.lastGoodAt.calendar = '2032-06-01T15:00:05Z'
  ui.state.lastGoodAt.calls = '2032-06-01T14:59:30Z'
  ui.markRefreshedNow()
  const summary = ui.render()
  assert.equal(summary.classes, 'is-ok')
  assert.match(summary.detail, /Last complete refresh: Today 9:59 AM/)
  assert.doesNotMatch(summary.detail, /just now|10:00 AM/)
})

test('a hanging resource cannot borrow fresh status from successful partial polling rounds', async () => {
  const ui = portal()
  ui.ready()
  let release
  const pending = new Promise(resolve => { release = resolve })
  ui.transport(path => path === '/api/vapi' ? pending : ui.success())
  const hungRead = ui.polling.fetchOne('calls')
  try {
    ui.advance(61000)
    await ui.polling.pollRound(true)
    assert.equal(ui.state.failedRounds, 0, 'the other resources refreshed successfully')
    assert.equal(ui.state.updatedAt, '2032-06-01T15:01:01.000Z')
    assert.equal(ui.state.lastGoodAt.calls, '2032-06-01T15:00:00.000Z')
    assert.deepEqual(Object.keys(ui.state.errors), [])
    ui.markRefreshedNow()
    const stale = ui.render()
    assert.equal(stale.title, 'Some information needs a refresh.')
    assert.equal(stale.classes, '')
    assert.match(stale.detail, /Last complete refresh: Today 10:00 AM.*out of date/)
    assert.doesNotMatch(stale.detail, /just now|10:01 AM/)
  } finally { release(ui.success()); await hungRead }
  assert.equal(ui.render().classes, 'is-ok', 'the formerly stalled resource confirmed a fresh read')
})

test('successful reads do not conceal a historical rejected or unconfirmed write', async () => {
  for (const status of [400, 503]) {
    const ui = portal({ demo: true, persistent: true })
    ui.ready()
    ui.transport((path, options) => options.method === 'POST'
      ? { ok: false, status, json: async () => ({ error: 'Synthetic save rejection' }) } : ui.success())
    await assert.rejects(ui.app.api.post('/api/leads', { action: 'save-note' }, { doing: 'Saving a note' }), /Synthetic save rejection/)
    await ui.polling.pollRound(true)
    const summary = ui.render()
    assert.equal(summary.title, 'Local demo data is loaded.')
    assert.match(summary.detail, /A previous change reported an error \(Today 10:00 AM\).*Open For support/)
    assert.equal(summary.classes, '', 'historical errors are neither a current outage nor a green save confirmation')
    assert.doesNotMatch(summary.detail, /Changes are saved|Saving needs attention|aren’t being saved/)
  }
})

test('manual refresh releases its controls after 15 seconds while the delayed read remains pending', async () => {
  const ui = portal()
  ui.ready(); ui.advance(1000)
  let release
  const pending = new Promise(resolve => { release = resolve })
  ui.transport(path => path === '/api/vapi' ? pending : ui.success())
  const manual = ui.manualRefresh()
  try {
    await new Promise(setImmediate)
    assert.equal(ui.busy(), true); assert.equal(ui.buttonBusy(), true)
    await ui.manualRefresh()
    assert.equal(ui.requests.filter(r => r.path === '/api/vapi').length, 1, 'repeated clicks do not duplicate the held request')
    ui.expireRefresh()
    await manual
    assert.equal(ui.busy(), false); assert.equal(ui.buttonBusy(), false)
    assert.equal(ui.activeTimers(), 0)
    assert.equal(ui.messages.at(-1).kind, 'warn')
    assert.match(ui.messages.at(-1).text, /still pending.*may finish later/)
    assert.doesNotMatch(ui.messages.at(-1).text, /cancel|Up to date|data refreshed/i)
    ui.advance(61000)
    await ui.polling.pollRound(true)
    assert.equal(ui.requests.filter(r => r.path === '/api/vapi').length, 1, 'timeout does not clear inflight or pretend to cancel GET')
    assert.equal(ui.render().title, 'Some information needs a refresh.')
  } finally { release(ui.success()); await new Promise(setImmediate) }
  assert.equal(ui.render().classes, 'is-ok', 'the genuine delayed response can still update data')
})

test('manual refresh never calls a partial success up to date', async () => {
  const ui = portal()
  ui.ready(); ui.advance(1000)
  ui.transport(path => path.startsWith('/api/calendar')
    ? { ok: false, status: 503, json: async () => ({ error: 'Synthetic calendar unavailable' }) } : ui.success())
  await ui.manualRefresh()
  assert.equal(ui.state.failedRounds, 0, 'other requests succeeded')
  assert.ok(ui.state.errors.calendar)
  assert.equal(ui.messages.at(-1).kind, 'warn')
  assert.match(ui.messages.at(-1).text, /Refresh is incomplete/)
  assert.doesNotMatch(ui.messages.at(-1).text, /Up to date|data refreshed/)
  assert.equal(ui.busy(), false); assert.equal(ui.buttonBusy(), false); assert.equal(ui.activeTimers(), 0)
})

test('manual refresh confirms only after every resource advances beyond its prior check', async () => {
  const ui = portal()
  ui.ready(); ui.advance(1000)
  ui.transport(() => ui.success())
  await ui.manualRefresh()
  for (const name of ['calls', 'leads', 'calendar']) assert.equal(ui.state.lastGoodAt[name], '2032-06-01T15:00:01.000Z')
  assert.equal(ui.messages.at(-1).text, 'Workspace data refreshed.')
  assert.equal(ui.messages.at(-1).kind, 'ok')
  assert.equal(ui.busy(), false); assert.equal(ui.buttonBusy(), false); assert.equal(ui.activeTimers(), 0)
})
