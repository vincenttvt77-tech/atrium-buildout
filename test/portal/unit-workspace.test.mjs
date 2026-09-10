import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const unitsSource = await readFile(new URL('../../ops/src/units.js', import.meta.url), 'utf8')
const styles = await readFile(new URL('../../ops/src/units.css', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

function workspace({ permissions = ['read', 'operate'], reducedMotion = false, mobile = false } = {}) {
  let now = Date.parse('2032-06-01T15:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const window = { ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'user-one' },
    ATRIUM_PROPERTY: { organizationId: 'org-one', propertyId: 'building-one', buildingName: 'Lake House', timeZone: 'America/Chicago',
      configurationVersion: 3, permissionVersion: 'permission-one', permissions, hours: {} } }
  const documentHandlers = new Map()
  const document = { readyState: 'loading', addEventListener(name, fn) {
    if (!documentHandlers.has(name)) documentHandlers.set(name, [])
    documentHandlers.get(name).push(fn)
  }, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, activeElement: null, body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const location = { hash: '#/units' }, actions = [], requests = [], animations = []
  const context = { window, document, location, Intl, Date: Clock, URLSearchParams, structuredClone, console,
    setTimeout, clearTimeout, setInterval, clearInterval, matchMedia: query => ({ matches: query.includes('reduced-motion') ? reducedMotion : query.includes('max-width') ? mobile : false }),
    fetch: () => { requests.push(true); assert.fail('Unit workspace must not issue a provider request') } }
  runInNewContext(appSource, context)
  const subscriptions = new Map(), subscribe = window.Atrium.on
  window.Atrium.on = (name, fn) => {
    if (!subscriptions.has(name)) subscriptions.set(name, [])
    subscriptions.get(name).push(fn); return subscribe(name, fn)
  }
  runInNewContext(unitsSource.replace("A.register('units', view)",
    "window.workspaceTest = { feedbackModel, workspaceModel, workspaceHtml, unitsHtml, sourceHtml, openUnitAvailability, view }; A.register('units', view)"), context)
  const A = window.Atrium, helpers = window.workspaceTest
  A.calendarActions = { openUnitBlocks: args => actions.push(args) }
  const at = () => new Clock().toISOString()
  A.state.loaded = { leads: true, calendar: true, calls: false }
  A.state.lastGoodAt = { leads: at(), calendar: at() }
  A.state.leads = { feedbackInventory: { sourceMode: 'demo', fictional: true, readAt: '2026-09-01T12:00:00Z', source: 'Approved fixture label' },
    feedbackUnits: [{ unitId: '4A', floor: 9, floorPlanName: 'West Collection', bedrooms: 1, sqft: 750, monthlyRent: 4200, status: 'available' },
      { unitId: '7B', floor: 7, bedrooms: 2 }], unitFeedback: [], unitFeedbackTruncated: false, profiles: [] }
  A.state.calendar = { bookings: [], unitBlocks: [], units: [{ unitId: '4A' }, { unitId: '7B' }] }
  return { A, helpers, context, location, actions, requests, animations,
    dispatchDocument(name, event) { for (const fn of documentHandlers.get(name) || []) fn(event) },
    emit(name, event) { for (const fn of subscriptions.get(name) || []) fn(event) },
    advance(ms) { now += ms },
    model(unitId = '', options = {}) {
      const model = helpers.feedbackModel(A.state, { unitId, ...options })
      model.workspace = helpers.workspaceModel(A.state, model)
      return model
    },
    html(unitId = '', options = {}) { return helpers.workspaceHtml(this.model(unitId, options), A.state) },
    mount() {
      const controls = new Map(), handlers = new Map()
      const control = selector => {
        if (!controls.has(selector)) controls.set(selector, selector === '.uf-units' ? unitListElement(document) : { innerHTML: '', hidden: false, disabled: false,
          contains: () => false, querySelectorAll: () => [], addEventListener() {}, animate: (...args) => animations.push(args) })
        return controls.get(selector)
      }
      const root = { innerHTML: '', hidden: false, querySelector: control, querySelectorAll: () => [],
        addEventListener: (name, fn) => handlers.set(name, fn) }
      helpers.view.mount(root); helpers.view.render(A.state)
      return { root, controls, handlers }
    },
  }
}

function unitListElement(document) {
  let html = '', nodes = [], scroller = null
  return {
    writes: 0,
    get innerHTML() { return html },
    set innerHTML(value) {
      html = value; this.writes++
      for (const node of nodes) node.isConnected = false
      nodes = [...value.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)].map(([, source]) => {
        const attrs = Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, val]) => [key, val]))
        const node = { dataset: { unit: attrs['data-unit'], key: attrs['data-key'] }, isConnected: true,
          getAttribute: key => attrs[key], setAttribute: (key, val) => { attrs[key] = val },
          focus: () => { document.activeElement = node },
          closest: selector => selector === '[data-unit]' ? node : null }
        return node
      })
      scroller = value.includes('uf-unit-list') ? { scrollTop: 0, scrollLeft: 0 } : null
    },
    querySelector: selector => selector === '.uf-unit-list' ? scroller : null,
    querySelectorAll: selector => selector === '[data-unit]' || selector === '[data-key]' ? nodes : [],
    contains: node => nodes.includes(node),
  }
}

const tour = (overrides = {}) => ({ externalId: 'booking-one', revision: 1, slotId: 'slot-2032-06-01T17:00:00.000Z',
  startsAt: '2032-06-01T17:00:00Z', endsAt: '2032-06-01T17:45:00Z', unitId: '4A',
  prospectPhone: '+13125550101', prospectName: 'Saved Name', ...overrides })
const person = (overrides = {}) => ({ phone: '+13125550101', name: 'Jordan', notes: [], calls: [], bookings: [], signals: {}, ...overrides })
const feedback = (overrides = {}) => ({ id: 'feedback-one', unitId: '4A', leadPhone: '+13125550101',
  sentiment: 'negative', category: 'price', observedDate: '2032-06-01', createdAt: '2032-06-01T14:00:00Z', note: 'Monthly rent is a concern.',
  createdBy: { label: 'Operator' }, ...overrides })

test('joins canonical tours and saved prospect evidence without inventing interest or duplicate tours', () => {
  const ui = workspace(), s = ui.A.state
  s.calendar.bookings = [tour(), tour(), tour({ externalId: 'booking-two', prospectPhone: '+13125550102', prospectName: 'Casey' }),
    tour({ externalId: 'other-unit', unitId: '7B', prospectPhone: '+13125550103' }),
    tour({ externalId: 'cancelled', status: 'cancelled' })]
  s.leads.profiles = [person({ signals: { budgetRange: { value: { minMonthly: 3500, maxMonthly: 4500 }, confidence: .9 },
    moveIn: { excerpt: 'Within three months', value: {}, confidence: .5 } }, notes: ['Operator: prefers afternoon tours'],
    bookings: [tour({ externalId: 'stale-profile-only', startsAt: '2032-06-02T17:00:00Z' })] }),
  person({ phone: '+13125550102', name: 'Casey' }), person({ phone: '+13125550103', name: 'Unrelated' })]
  const model = ui.model('4A'), html = ui.html('4A')
  assert.deepEqual(plain(model.workspace.tours.map(t => t.externalId)), ['booking-one', 'booking-two'])
  assert.equal(model.workspace.profiles.length, 2)
  assert.match(html, /Jordan/); assert.match(html, /Casey/)
  assert.match(html, /\$3,500–\$4,500\/mo/); assert.match(html, /Within three months/)
  assert.match(html, /Move-in · check with prospect/); assert.match(html, /prefers afternoon tours/)
  assert.doesNotMatch(html, /Unrelated|stale-profile-only|qualified prospect|conversion rate/i)
  assert.match(html, /12:00 – 12:45 PM/); assert.match(html, /Central Time/)
  assert.equal(ui.requests.length, 0)
})

test('seven-day window uses property-local dates, includes an ongoing tour and excludes the following day', () => {
  const ui = workspace()
  ui.A.state.calendar.bookings = [tour({ externalId: 'ongoing', startsAt: '2032-06-01T14:45:00Z', endsAt: '2032-06-01T15:15:00Z' }),
    tour({ externalId: 'day-seven', startsAt: '2032-06-08T04:00:00Z', endsAt: '2032-06-08T04:30:00Z' }),
    tour({ externalId: 'day-eight', startsAt: '2032-06-08T05:00:00Z', endsAt: '2032-06-08T05:30:00Z' }),
    tour({ externalId: 'finished', startsAt: '2032-06-01T14:00:00Z', endsAt: '2032-06-01T14:45:00Z' })]
  assert.deepEqual(plain(ui.model().workspace.tours.map(t => t.externalId)), ['ongoing', 'day-seven'])
  assert.match(ui.html(), /Scheduled now/)
  assert.doesNotMatch(ui.html(), />Toured<|attendance confirmed/)
})

test('active unit holds flag only overlapping occupied intervals and never remove a saved tour', () => {
  const ui = workspace()
  ui.A.state.calendar.bookings = [tour({ occupiedStartsAt: '2032-06-01T16:45:00Z', occupiedEndsAt: '2032-06-01T18:00:00Z' })]
  ui.A.state.calendar.unitBlocks = [{ id: 'buffer-overlap', unitId: '4A', startsAt: '2032-06-01T16:50:00Z', endsAt: '2032-06-01T16:55:00Z', reason: 'Access unavailable' },
    { id: 'other-unit', unitId: '7B', startsAt: '2032-06-01T17:00:00Z', endsAt: '2032-06-01T18:00:00Z' },
    { id: 'removed', unitId: '4A', startsAt: '2032-06-01T17:00:00Z', endsAt: '2032-06-01T18:00:00Z', removedAt: '2032-06-01T14:00:00Z' }]
  const model = ui.model('4A'), html = ui.html('4A')
  assert.equal(model.workspace.tours.length, 1)
  assert.deepEqual(plain(model.workspace.conflicts(model.workspace.tours[0]).map(b => b.id)), ['buffer-overlap'])
  assert.match(html, /Availability conflict/); assert.match(html, /The booking is still saved/)
  assert.match(html, /Access unavailable/)
})

test('unloaded, failed and stalled calendars never present zero tours or allow stale contacting/hold actions', () => {
  const ui = workspace()
  ui.A.state.calendar.bookings = [tour()]
  ui.A.state.loaded.calendar = false
  assert.match(ui.html('4A'), /Calendar has not loaded yet/)
  assert.match(ui.html('4A'), /Tours · next 7 days<\/span><strong>—/)
  assert.doesNotMatch(ui.html('4A'), /href="tel:|data-unit-availability=/)
  ui.A.state.loaded.calendar = true; ui.A.state.errors.calendar = 'Connection unavailable'
  assert.match(ui.html('4A'), /Calendar needs a refresh/); assert.match(ui.html('4A'), /Last saved tour/)
  delete ui.A.state.errors.calendar
  ui.advance(61000)
  assert.match(ui.html('4A'), /current availability is unconfirmed/)
  ui.helpers.openUnitAvailability('4A')
  assert.equal(ui.actions.length, 0)
})

test('prior unit references retain saved context while unknown-property selection reveals no other records', () => {
  const ui = workspace()
  ui.A.state.calendar.bookings = [tour({ unitId: 'RETIRED' })]
  ui.A.state.leads.profiles = [person()]
  assert.equal(ui.model('RETIRED').selected.current, false)
  assert.match(ui.html('RETIRED'), /Prior unit reference/); assert.match(ui.html('RETIRED'), /Jordan/)
  assert.doesNotMatch(ui.html('RETIRED'), /data-unit-availability=/)
  const missing = ui.html('property-two-unit')
  assert.match(missing, /not in the current workspace/)
  assert.doesNotMatch(missing, /Jordan|booking-one|4A|RETIRED/)
})

test('demo source, recorded floor, missing rent and truncated feedback stay explicit', () => {
  const ui = workspace()
  ui.A.state.leads.unitFeedback = [feedback()]; ui.A.state.leads.unitFeedbackTruncated = true
  const model = ui.model('4A'), html = ui.html('4A')
  assert.match(html, /Sample rent/); assert.match(html, /\$4,200/); assert.match(html, /Within loaded feedback only/)
  assert.match(ui.helpers.unitsHtml(model, '4A'), /Floor 9/)
  assert.doesNotMatch(ui.helpers.unitsHtml(model, '4A'), /Floor 4/)
  assert.match(ui.helpers.unitsHtml(model, '4A'), /not a floor plan/)
  assert.match(ui.helpers.sourceHtml(model), /not live availability/)
  assert.match(ui.html('7B'), /Rent not supplied/)
  assert.doesNotMatch(html, /live availability|occupancy rate|revenue opportunity|lease probability/i)
})

test('unsafe names, notes, source labels, IDs and numbers never become executable markup or phone links', () => {
  const ui = workspace(), unsafe = '<img src=x onerror=alert(1)>'
  ui.A.state.calendar.bookings = [tour({ prospectName: unsafe, prospectPhone: 'javascript:123' })]
  ui.A.state.leads.unitFeedback = [feedback({ note: unsafe })]
  ui.A.state.leads.feedbackInventory.source = unsafe
  ui.A.state.leads.profiles = [person({ name: unsafe, notes: [unsafe] })]
  const html = ui.html('4A') + ui.helpers.sourceHtml(ui.model())
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img|href="tel:|href="javascript:/)
  assert.equal(ui.requests.length, 0)
})

test('phone actions require an operator and valid number; hold action rechecks current property data', () => {
  const ui = workspace()
  ui.A.state.calendar.bookings = [tour()]
  assert.match(ui.html('4A'), /href="tel:\+13125550101"/)
  assert.match(ui.html('4A'), /Call in phone app/)
  ui.helpers.openUnitAvailability('4A')
  assert.deepEqual(plain(ui.actions), [{ unitId: '4A' }])
  ui.A.state.leads = null; ui.A.state.calendar = null
  ui.helpers.openUnitAvailability('4A')
  assert.equal(ui.actions.length, 1)
  const reader = workspace({ permissions: ['read'] })
  reader.A.state.calendar.bookings = [tour()]
  assert.doesNotMatch(reader.html('4A'), /href="tel:|data-unit-availability=|data-edit=/)
  reader.helpers.openUnitAvailability('4A')
  assert.equal(reader.actions.length, 0)
})

test('selection animation runs only for a different apartment and honors reduced motion', () => {
  const ui = workspace(), mounted = ui.mount()
  assert.equal(ui.animations.length, 0)
  ui.location.hash = '#/units?unit=4A'; ui.helpers.view.render(ui.A.state)
  assert.equal(ui.animations.length, 1)
  ui.A.state.calendar.bookings = [tour()]; ui.helpers.view.render(ui.A.state)
  assert.equal(ui.animations.length, 1)
  assert.match(mounted.controls.get('.uf-detail').innerHTML, /Saved Name/)
  const reduced = workspace({ reducedMotion: true }); reduced.mount()
  reduced.location.hash = '#/units?unit=4A'; reduced.helpers.view.render(reduced.A.state)
  assert.equal(reduced.animations.length, 0)
  assert.match(styles, /prefers-reduced-motion: reduce/)
})

test('rendered unit action selects the actual apartment and busy state removes the action', () => {
  const ui = workspace(), mounted = ui.mount()
  ui.location.hash = '#/units?unit=4A'; ui.helpers.view.render(ui.A.state)
  assert.match(mounted.controls.get('.uf-detail').innerHTML, /data-unit-availability="4A"/)
  mounted.handlers.get('click')({ target: { closest: selector => selector === '[data-unit-availability]' ? { dataset: { unitAvailability: '4A' } } : null } })
  assert.deepEqual(plain(ui.actions), [{ unitId: '4A' }])
  ui.A.busyNow = () => true; ui.helpers.view.render(ui.A.state)
  assert.doesNotMatch(mounted.controls.get('.uf-detail').innerHTML, /data-unit-availability=/)
})

test('an explicit mobile apartment selection focuses its brief once, without moving the reader on polls', () => {
  for (const reducedMotion of [false, true]) {
    const ui = workspace({ mobile: true, reducedMotion }), mounted = ui.mount(), focus = [], scrolls = []
    const heading = { focus: args => focus.push(args), scrollIntoView: args => scrolls.push(args) }
    mounted.controls.get('.uf-detail').querySelector = () => heading
    ui.A.navigate = (name, args) => { ui.location.hash = ui.A.hashFor(name, args); ui.helpers.view.render(ui.A.state) }
    mounted.handlers.get('click')({ target: { closest: selector => selector === '[data-unit]' ? { dataset: { unit: '4A' } } : null } })
    assert.match(mounted.controls.get('.uf-detail').innerHTML, /Apartment 4A/)
    assert.equal(focus.length, 1); assert.equal(scrolls.length, 1)
    assert.equal(scrolls[0].behavior, reducedMotion ? 'instant' : 'smooth')
    ui.A.state.calendar.bookings = [tour()]; ui.helpers.view.render(ui.A.state)
    assert.equal(focus.length, 1); assert.equal(scrolls.length, 1)
  }
})


test('selecting an apartment keeps the scrolled explorer and original button nodes', () => {
  const ui = workspace(), mounted = ui.mount(), list = mounted.controls.get('.uf-units')
  const scroller = list.querySelector('.uf-unit-list')
  scroller.scrollTop = 960
  const button = [...list.querySelectorAll('[data-unit]')].find(node => node.dataset.unit === '7B')
  button.focus()
  const writes = list.writes
  ui.A.navigate = (name, args) => { ui.location.hash = ui.A.hashFor(name, args); ui.helpers.view.render(ui.A.state) }
  mounted.handlers.get('click')({ target: button })
  assert.equal(ui.location.hash, '#/units?unit=7B')
  assert.match(mounted.controls.get('.uf-detail').innerHTML, /Apartment 7B/)
  assert.equal(list.writes, writes, 'selection must only update aria-current, not replace the explorer')
  assert.equal(list.querySelector('.uf-unit-list'), scroller)
  assert.equal(scroller.scrollTop, 960)
  assert.equal(button.isConnected, true)
  assert.equal(button.getAttribute('aria-current'), 'true')
  assert.equal(ui.context.document.activeElement, button)
  ui.advance(5000); ui.helpers.view.render(ui.A.state)
  assert.equal(list.writes, writes)
})

test('changed tour/feedback data preserves nested scroll, focused unit and current selection', () => {
  const ui = workspace(), mounted = ui.mount(), list = mounted.controls.get('.uf-units')
  ui.location.hash = '#/units?unit=7B'; ui.helpers.view.render(ui.A.state)
  const scroller = list.querySelector('.uf-unit-list'); scroller.scrollTop = 840; scroller.scrollLeft = 12
  const focused = [...list.querySelectorAll('[data-unit]')].find(node => node.dataset.unit === '7B')
  focused.focus()
  ui.A.state.calendar.bookings = [tour({ unitId: '7B' })]
  ui.A.state.leads.unitFeedback = [feedback({ unitId: '7B' })]
  ui.advance(5000); ui.helpers.view.render(ui.A.state)
  assert.equal(list.querySelector('.uf-unit-list').scrollTop, 840)
  assert.equal(list.querySelector('.uf-unit-list').scrollLeft, 12)
  assert.equal(ui.context.document.activeElement.dataset.unit, '7B')
  assert.equal(ui.context.document.activeElement.getAttribute('aria-current'), 'true')
  assert.match(list.innerHTML, /1 tour/)
  assert.match(mounted.controls.get('.uf-detail').innerHTML, /Monthly rent is a concern/)
})

test('a refresh between pointer press and click cannot detach or redirect the pressed apartment', () => {
  const ui = workspace(), mounted = ui.mount(), list = mounted.controls.get('.uf-units')
  const button = [...list.querySelectorAll('[data-unit]')].find(node => node.dataset.unit === '7B')
  list.querySelector('.uf-unit-list').scrollTop = 900
  mounted.handlers.get('pointerdown')?.({ target: button, pointerId: 2, button: 0 })
  const writes = list.writes
  ui.A.state.calendar.bookings = [tour({ unitId: '7B' })]
  ui.advance(5000); ui.helpers.view.render(ui.A.state)
  assert.equal(list.writes, writes, 'data redraw must wait while a unit press is in progress')
  assert.equal(button.isConnected, true)
  ui.dispatchDocument('pointerup', { pointerId: 2 })
  ui.A.navigate = (name, args) => { ui.location.hash = ui.A.hashFor(name, args); ui.helpers.view.render(ui.A.state) }
  mounted.handlers.get('click')({ target: button })
  assert.equal(ui.location.hash, '#/units?unit=7B')
  assert.equal(list.querySelector('.uf-unit-list').scrollTop, 900)
  assert.match(list.innerHTML, /1 tour/)
  assert.match(mounted.controls.get('.uf-detail').innerHTML, /Apartment 7B/)
})

test('cancelled pointer and released keyboard presses resume pending list updates without selection', async () => {
  for (const input of ['pointer', 'keyboard']) {
    const ui = workspace(), mounted = ui.mount(), list = mounted.controls.get('.uf-units')
    const button = [...list.querySelectorAll('[data-unit]')].find(node => node.dataset.unit === '7B')
    list.querySelector('.uf-unit-list').scrollTop = 700
    if (input === 'pointer') mounted.handlers.get('pointerdown')?.({ target: button, pointerId: 3, button: 0 })
    else mounted.handlers.get('keydown')?.({ target: button, key: ' ' })
    const writes = list.writes
    ui.A.state.calendar.bookings = [tour({ unitId: '7B' })]
    ui.helpers.view.render(ui.A.state)
    assert.equal(list.writes, writes)
    if (input === 'pointer') ui.dispatchDocument('pointercancel', { pointerId: 3 })
    else ui.dispatchDocument('keyup', { key: ' ' })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(list.writes > writes)
    assert.equal(list.querySelector('.uf-unit-list').scrollTop, 700)
    assert.equal(ui.location.hash, '#/units')
    assert.match(list.innerHTML, /1 tour/)
  }
})


test('pointer release outside the list unfreezes it even when the pointer never clicks an apartment', async () => {
  const ui = workspace(), mounted = ui.mount(), list = mounted.controls.get('.uf-units')
  const button = [...list.querySelectorAll('[data-unit]')].find(node => node.dataset.unit === '7B')
  list.querySelector('.uf-unit-list').scrollTop = 640
  mounted.handlers.get('pointerdown')({ target: button, pointerId: 8, button: 0 })
  ui.A.state.leads.unitFeedback = [feedback({ unitId: '7B' })]
  const writes = list.writes
  ui.helpers.view.render(ui.A.state)
  assert.equal(list.writes, writes)
  ui.dispatchDocument('pointerup', { pointerId: 8, target: { closest: () => null } })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(ui.helpers.view.listActivation, null)
  assert.ok(list.writes > writes)
  assert.equal(list.querySelector('.uf-unit-list').scrollTop, 640)
  assert.equal(ui.location.hash, '#/units')
})

test('leaving Units during a press clears pending activation and fresh data renders when returning', () => {
  const ui = workspace(), mounted = ui.mount(), list = mounted.controls.get('.uf-units')
  const button = [...list.querySelectorAll('[data-unit]')].find(node => node.dataset.unit === '7B')
  list.querySelector('.uf-unit-list').scrollTop = 600
  mounted.handlers.get('pointerdown')({ target: button, pointerId: 9, button: 0 })
  ui.A.state.calendar.bookings = [tour({ unitId: '7B' })]
  const writes = list.writes
  ui.helpers.view.render(ui.A.state)
  assert.equal(list.writes, writes)
  mounted.root.hidden = true
  ui.emit('route', { name: 'today', params: {} })
  assert.equal(ui.helpers.view.listActivation, null)
  assert.equal(ui.helpers.view.listUpdateTimer, null)
  assert.equal(list.writes, writes, 'hidden view must not repaint as a cleanup side effect')
  mounted.root.hidden = false; ui.helpers.view.render(ui.A.state)
  assert.ok(list.writes > writes)
  assert.equal(list.querySelector('.uf-unit-list').scrollTop, 600)
  assert.match(list.innerHTML, /1 tour/)
})
