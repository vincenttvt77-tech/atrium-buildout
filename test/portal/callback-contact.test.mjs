import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const leadsSource = await readFile(new URL('../../ops/src/leads.js', import.meta.url), 'utf8')
const leadsCss = await readFile(new URL('../../ops/src/leads.css', import.meta.url), 'utf8')
const at = '2026-09-20T14:00:00.000Z'
const callback = { value: '+13125550102', excerpt: 'Please call me at 312 555 0102.', callId: 'call-one', at, confidence: 1 }
const profile = overrides => ({ phone: '+13125550101', name: 'Dana', email: null, stage: 'new',
  firstSeenAt: at, lastSeenAt: at, calls: [{ callId: 'call-one', at, outcome: 'Enquired', toolsCalled: [] }],
  bookings: [], signals: {}, escalations: [], notes: [], unitsDiscussed: [], callbackPhone: callback, ...overrides })

function workspace(width = 1280) {
  const window = { addEventListener() {}, scrollTo() {}, scrollY: 0,
    ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_ACCOUNT: { username: 'operator', userId: 'user-one' },
    ATRIUM_PROPERTY: { organizationId: 'org-one', propertyId: 'building-one', buildingName: 'Lake House',
      timeZone: 'America/Chicago', configurationVersion: 1, permissionVersion: 'one', permissions: ['read', 'operate'], hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, activeElement: null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const context = { window, document, location: { hash: '#/leads' }, Intl, Date, URLSearchParams, structuredClone, console,
    localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? true : query.includes('min-width') ? width >= 1200 : width <= 959 }),
    fetch: () => assert.fail('Rendering a callback must not place a call or send a message') }
  runInNewContext(appSource, context)
  runInNewContext(leadsSource.replace("A.register('leads', view)",
    "window.callbackUi = { leadPanelHtml, leadMatches, leadRowHtml, fuRowHtml, view }; A.register('leads', view)"), context)
  const state = window.Atrium.state
  state.loaded = { leads: true, calls: true, calendar: true }
  state.leads = { profiles: [], followUps: [], tourChangeRequests: [], outboundEnabled: false }
  state.calendar = { bookings: [] }; state.calls = []
  const messages = [], navigations = []
  window.Atrium.toast = message => messages.push(message)
  function mount(route = { tab: 'all' }) {
    const controls = new Map()
    const control = selector => {
      if (!controls.has(selector)) controls.set(selector, {
        innerHTML: '', hidden: false, value: '', dataset: {}, scrollTop: 0, textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        contains: () => false, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
      })
      return controls.get(selector)
    }
    control('.tabs').querySelectorAll = () => ['todo', 'all'].map(tab => ({ dataset: { tab }, textContent: '', setAttribute() {} }))
    const root = { innerHTML: '', hidden: false, querySelector: control, querySelectorAll: () => [] }
    const view = window.callbackUi.view
    view.params = () => route
    view.setParams = patch => {
      navigations.push(patch)
      Object.assign(route, patch)
      for (const key of Object.keys(route)) if (route[key] === undefined) delete route[key]
    }
    view.mount(root)
    return { view, route, controls }
  }
  return { state, ui: window.callbackUi, mount, messages, navigations, A: window.Atrium }
}

test('lead drawer distinguishes caller number from requested callback and keeps the original words', () => {
  const { state, ui } = workspace(), p = profile()
  state.leads.profiles = [p]
  const before = JSON.stringify(p), html = ui.leadPanelHtml(p, state)
  assert.match(html, /Caller number: <a href="tel:\+13125550101">/)
  assert.match(html, /<h3>Requested callback<\/h3>/)
  assert.match(html, /<dt>Number<\/dt><dd><a href="tel:\+13125550102">/)
  assert.match(html, /Please call me at 312 555 0102\./)
  assert.match(html, /does not verify who owns the number/)
  assert.match(html, /class="btn btn-primary lead-call" href="tel:\+13125550102"/)
  assert.match(html, /Call requested number/)
  assert.match(html, /does not place or log a call in Atrium/)
  assert.equal(JSON.stringify(p), before)
})

test('callback searching finds a record without changing its provider identity', () => {
  const { ui } = workspace(), p = profile()
  assert.equal(ui.leadMatches(p, '312 555 0102'), true)
  assert.equal(ui.leadMatches(p, '312 555 0101'), true)
  assert.equal(ui.leadMatches(p, '312 555 0199'), false)
  assert.equal(p.phone, '+13125550101')
})

test('hidden caller identity remains hidden even when a callback number was supplied', () => {
  const { state, ui } = workspace(), html = ui.leadPanelHtml(profile({ phone: 'unknown' }), state)
  assert.match(html, /from numbers that weren't shared/)
  assert.match(html, /Requested callback/)
  assert.match(html, /href="tel:\+13125550102"/)
  assert.doesNotMatch(html, /Caller number:|href="tel:unknown"|data-action="setname"/)
})

test('legacy and malformed callback records do not invent a contact or create unsafe links', () => {
  const { state, ui } = workspace()
  for (const callbackPhone of [undefined, { ...callback, value: 'javascript:alert(1)' }, { ...callback, value: '<img src=x>' }]) {
    const html = ui.leadPanelHtml(profile({ callbackPhone }), state)
    assert.doesNotMatch(html, /Requested callback|javascript:|<img/)
    assert.match(html, /class="btn btn-primary lead-call" href="tel:\+13125550101"/)
  }
})

test('callback evidence is escaped and uses the existing wrapping mobile detail layout', () => {
  for (const width of [320, 390, 1280]) {
    const { state, ui } = workspace(width)
    const html = ui.leadPanelHtml(profile({ callbackPhone: { ...callback,
      excerpt: '<script>alert("x")</script>' + 'CallerWords'.repeat(80) } }), state)
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /<dl class="facts"><dt>Number<\/dt>/)
    assert.match(html, /Call requested number/)
  }
  assert.match(leadsCss, /\.leads-view \.lead-panel \.facts dd \{ overflow-wrap: anywhere;/)
  assert.match(leadsCss, /@media \(max-width: 959px\)[\s\S]*?\.lead-panel \.lead-call \{ display: inline-flex;/)
})

const anonymous = (callId, name, number) => profile({ phone: 'unknown', name,
  calls: [{ callId, at, outcome: 'Enquired', toolsCalled: [] }],
  callbackPhone: { ...callback, value: number, callId, excerpt: `${name} requested this callback.` } })
const task = (callId, id) => ({ id, phone: 'unknown', kind: 'nurture', status: 'scheduled',
  dueAt: at, createdAt: at, createdFromCall: callId, channel: 'call', reason: 'Follow up' })

test('anonymous rows and work-queue links retain the exact saved call identity', () => {
  const { state, ui } = workspace()
  const ana = anonymous('call-ana', 'Ana', '+13125550102'), ben = anonymous('call-ben', 'Ben', '+13125550103')
  state.leads.profiles = [ana, ben]
  for (const p of [ana, ben]) {
    const callId = p.calls[0].callId
    assert.match(ui.leadRowHtml(p, state), new RegExp(`data-key="lead:call:${callId}" data-phone="unknown" data-call="${callId}"`))
    const html = ui.fuRowHtml(task(callId, 'task-' + callId), state, { nameLink: true })
    assert.match(html, new RegExp(`data-phone="unknown" data-call="${callId}"`))
    assert.match(html, new RegExp(`>${p.name}</button>`))
  }
})

test('mobile drawer opens the selected anonymous caller and excludes another callers work and callback', () => {
  for (const width of [320, 390, 1280]) {
    const fixture = workspace(width), { state } = fixture
    const ana = anonymous('call-ana', 'Ana', '+13125550102'), ben = anonymous('call-ben', 'Ben', '+13125550103')
    state.leads.profiles = [ana, ben]
    state.leads.followUps = [task('call-ana', 'task-ana'), task('call-ben', 'task-ben')]
    const { view, route, controls } = fixture.mount()
    view.open('unknown', { dataset: { call: 'call-ben', key: 'lead:call:call-ben' } })
    assert.equal(route.call, 'call-ben')
    view.render(state)
    assert.equal(view.current().name, 'Ben')
    const html = controls.get('.lead-panel').innerHTML
    assert.match(html, /Ben requested this callback/)
    assert.match(html, /data-fu="task-ben"/)
    assert.doesNotMatch(html, /Ana requested|data-fu="task-ana"|tel:\+13125550102|data-action="setname"|class="note-form"/)
    view.close()
    assert.equal(route.phone, undefined)
    assert.equal(route.call, undefined)
  }
})

test('ambiguous or missing anonymous links never default to the first hidden caller', () => {
  for (const route of [{ phone: 'unknown' }, { phone: 'unknown', call: 'missing' }]) {
    const fixture = workspace()
    fixture.state.leads.profiles = [anonymous('call-ana', 'Ana', '+13125550102'), anonymous('call-ben', 'Ben', '+13125550103')]
    const { view, controls } = fixture.mount({ tab: 'all', ...route })
    view.render(fixture.state)
    assert.equal(view.current(), null)
    assert.equal(controls.get('.lead-panel').innerHTML, '')
    assert.equal(fixture.messages.length, 1)
    assert.equal(fixture.navigations[0].phone, undefined)
  }
})

test('unknown identity cannot be submitted by name or note mutation handlers', async () => {
  const fixture = workspace(), { view } = fixture.mount()
  fixture.A.api.post = () => assert.fail('An anonymous drawer must not submit a phone-keyed mutation')
  fixture.A.prompt = () => assert.fail('An anonymous drawer must not offer a phone-keyed edit')
  view.drafts.unknown = 'A note that must not be sent'
  await view.saveNote('unknown', null)
  await view.postName('unknown', 'Changed', null)
  await view.setName(anonymous('call-ana', 'Ana', '+13125550102'), null)
})
