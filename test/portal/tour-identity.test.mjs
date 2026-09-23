import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const [app, calendar, leads] = await Promise.all(['app.js', 'calendar.js', 'leads.js'].map(name => readFile(new URL('../../ops/src/' + name, import.meta.url), 'utf8')))
const at = '2032-06-01T17:00:00.000Z', end = '2032-06-01T17:30:00.000Z', slot = 'slot-2032-06-01T17:00'
const booked = (id, call, over = {}) => ({ externalId: id, interactionId: call, slotId: slot, startsAt: at, endsAt: end,
  prospectName: 'Same Name', prospectEmail: null, prospectPhone: 'unknown', unitId: '4A', bookedAt: '2032-06-01T12:00:00Z', revision: 0, ...over })
const profile = (id, call, phone, over = {}) => ({ phone, name: 'Same Name', email: phone.slice(-4) + '@example.test',
  stage: 'tour_scheduled', calls: [{ callId: call, at: '2032-06-01T12:00:00Z', toolsCalled: [] }], notes: [], signals: {},
  bookings: [{ externalId: id, callId: call, slotId: slot, startsAt: at, unitId: '4A', status: 'confirmed' }], ...over })

test('Calendar and Today show the reservation contact, including an explicitly cleared email', () => {
  const old = profile('one', 'call-one', '+13125550101', { name: 'Old Name', email: 'old@example.test' })
  for (const email of ['corrected@example.test', null]) {
    const t = ui([booked('one', 'call-one', { prospectName: 'Corrected Name', prospectEmail: email })], [old])
    assert.equal(t.info('one').email, email)
    assert.equal(t.info('one').name, 'Corrected Name')
    const row = t.A.derive.toursOn(t.A.state, '2032-06-01')[0]
    assert.equal(row.name, 'Corrected Name'); assert.equal(row.email, email)
    assert.equal(row.profile, old); assert.equal(t.info('one').phone, old.phone)
  }
})

function ui(rows, profiles = []) {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2032-06-01T12:00:00Z'])) } static now() { return Date.parse('2032-06-01T12:00:00Z') } }
  const window = { ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_ACCOUNT: { userId: 'user-one', username: 'operator' },
    ATRIUM_PROPERTY: { organizationId: 'org-one', propertyId: 'property-one', buildingName: 'Synthetic building', timeZone: 'America/Chicago',
      configurationVersion: 1, permissionVersion: 'p1', permissions: ['read', 'operate'], hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, body: { classList: { add() {}, remove() {}, toggle() {} } } }
  const context = { window, document, location: { hash: '#/calendar?date=2032-06-01&view=day' }, Date: Clock, Intl,
    URLSearchParams, structuredClone, console, setTimeout, clearTimeout, setInterval, clearInterval, matchMedia: () => ({ matches: false }) }
  runInNewContext(app.replace('window.Atrium = {', 'window.identityToday = { tourRowHtml }; window.Atrium = {'), context)
  runInNewContext(calendar.replace("A.register('calendar', view)", 'window.identityCalendar = { buildModel, tourInfo, tourContent, popSig, view, cal }; A.register(\'calendar\', view)'), context)
  runInNewContext(leads.replace("A.register('leads', view)", 'window.identityLeads = { calendarName, leadPanelHtml, leadBriefHtml }; A.register(\'leads\', view)'), context)
  const A = window.Atrium
  Object.assign(A.state, { calls: [], loaded: { calls: true, leads: true, calendar: true },
    leads: { profiles, followUps: [], tourChangeRequests: [] },
    calendar: { range: { from: '2032-06-01', to: '2032-06-01' }, bookings: rows, blocks: [], unitBlocks: [],
      slots: [{ slotId: slot, startsAt: at, endsAt: end, date: '2032-06-01', status: 'open', capacity: 3, bookings: rows }] } })
  const c = window.identityCalendar, model = () => c.buildModel(A.state, { date: '2032-06-01', view: 'day' })
  const tours = () => model().dayModels[0].tours
  const info = id => { const m = model(), item = m.dayModels[0].tours.find(t => t.slot.booking?.externalId === id); assert.ok(item); return c.tourInfo(A.state, m, item.slot) }
  return { A, c, model, tours, info, leads: window.identityLeads, today: window.identityToday, context }
}

test('shared-unit same-name simultaneous tours keep their own lead and contact', () => {
  const one = profile('one', 'call-one', '+13125550101'), two = profile('two', 'call-two', '+13125550202')
  const t = ui([booked('one', 'call-one'), booked('two', 'call-two')], [two, one])
  assert.equal(t.info('one').profile, one)
  assert.equal(t.info('one').phone, one.phone)
  assert.equal(t.info('two').profile, two)
})

test('a tour without a projected lead never borrows the only other lead at that time', () => {
  const other = profile('other', 'other-call', '+13125550202')
  const t = ui([booked('unprojected', 'new-call', { unitId: '7B' }), booked('other', 'other-call')], [other])
  assert.equal(t.info('unprojected').profile, null)
  assert.equal(t.info('unprojected').phone, null)
  assert.equal(t.info('unprojected').email, null)
})

test('Today does not revive a removed tour or borrow its profile when another occupies the same time', () => {
  const old = profile('removed', 'old-call', '+13125550101')
  const t = ui([booked('replacement', 'new-call', { prospectName: 'New Visitor' })], [old])
  const rows = t.A.derive.toursOn(t.A.state, '2032-06-01')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].profile, null)
  assert.equal(rows[0].name, 'New Visitor')
  assert.notEqual(rows[0].phone, old.phone)
})

test('lead name suggestions do not use somebody else’s same-time tour', () => {
  const p = profile('missing', 'missing-call', '+13125550101', { name: null })
  const t = ui([booked('other', 'other-call', { prospectName: 'Wrong Person' })], [p])
  assert.equal(t.leads.calendarName(p, t.A.state), null)
})

test('duplicate saved IDs or competing lead projections cannot enable a guessed contact or edit', () => {
  const one = profile('one', 'call-one', '+13125550101'), conflicting = profile('one', 'call-one', '+13125550202')
  const duplicate = ui([booked('one', 'call-one'), booked('one', 'call-one')], [one])
  assert.equal(duplicate.A.derive.calendarBooking(duplicate.A.state, { externalId: 'one' }), null)
  const m = duplicate.model(), item = m.dayModels[0].tours[0]
  const content = duplicate.c.tourContent(duplicate.A.state, m, item)
  assert.match(content.body, /could not be matched to one saved record/)
  assert.doesNotMatch(content.actions, /Reschedule|Email confirmation|Open lead|tel:/)
  const competing = ui([booked('one', 'call-one')], [one, conflicting])
  assert.equal(competing.info('one').profile, null)
  assert.equal(competing.info('one').phone, null)
  assert.equal(competing.leads.calendarName(one, competing.A.state), null)
})

test('legacy projections need the unique original call; conflicting reservation IDs never fall back', () => {
  const p = profile('one', 'call-one', '+13125550101')
  delete p.bookings[0].externalId
  const t = ui([booked('one', 'call-one')], [p])
  assert.equal(t.info('one').profile, p)
  p.bookings[0].externalId = 'other'
  assert.equal(t.info('one').profile, null)
  delete p.bookings[0].externalId
  t.A.state.calendar.bookings.push(booked('two', 'call-one'))
  assert.equal(t.info('one').profile, null)
  t.A.state.calendar.bookings = [booked('one', 'call-one'), booked('one', 'different-call')]
  assert.equal(t.A.derive.calendarBookingForLead(t.A.state, p.bookings[0]), null)
})

test('contradictory original call identity prevents a profile join even with matching external ID', () => {
  const p = profile('one', 'different-call', '+13125550101')
  const t = ui([booked('one', 'call-one')], [p])
  assert.equal(t.info('one').profile, null)
})

test('opaque reservation IDs are never parsed to manufacture a call link', () => {
  const t = ui([booked('calendar|other-call|opaque', undefined)])
  t.A.state.leads.profiles = [profile('other', 'other-call', '+13125550202')]
  assert.equal(t.info('calendar|other-call|opaque').callId, null)
})

test('missing and stale slot summaries cannot inherit the first saved reservation or edit target', () => {
  const t = ui([booked('one', 'call-one')], [profile('one', 'call-one', '+13125550101')])
  t.A.state.calendar.slots[0].bookings = [{ prospectName: 'Same Name', unitId: '4A' }]
  let m = t.model(), item = m.dayModels[0].tours[0]
  assert.equal(item.slot.booking, null)
  assert.equal(t.c.tourInfo(t.A.state, m, item.slot).profile, null)
  assert.doesNotMatch(t.c.tourContent(t.A.state, m, item).actions, /Reschedule|Email confirmation/)
  t.A.state.calendar.slots[0].bookings = [{ ...booked('one', 'call-one'), unitId: '7B' }]
  m = t.model(); item = m.dayModels[0].tours[0]
  assert.equal(item.slot.booking, null)
})

test('two same-name legacy summaries remain visible instead of being merged into one tour', () => {
  const t = ui([])
  t.A.state.calendar.slots[0].bookings = [{ prospectName: 'Same Name', unitId: '4A' }, { prospectName: 'Same Name', unitId: '4A' }]
  assert.equal(t.tours().length, 2)
  assert.equal(new Set(t.tours().map(item => item.key)).size, 2)
  assert.ok(t.tours().every(item => item.slot.booking === null))
})

test('tour keys stay attached to reservations when simultaneous rows reorder', () => {
  const a = booked('one', 'call-one'), b = booked('two', 'call-two'), t = ui([a, b])
  const keys = Object.fromEntries(t.tours().map(item => [item.slot.booking.externalId, item.key]))
  const before = t.c.popSig(t.tours()[0])
  t.A.state.calendar.bookings.reverse(); t.A.state.calendar.slots[0].bookings = [b, a]
  assert.deepEqual(Object.fromEntries(t.tours().map(item => [item.slot.booking.externalId, item.key])), keys)
  assert.equal(t.c.popSig(t.tours().find(item => item.slot.booking.externalId === 'one')), before)
})

test('open tour detail signatures change when only contact or identity evidence changes', () => {
  const p = profile('one', 'call-one', '+13125550101'), t = ui([booked('one', 'call-one')], [p])
  const item = t.tours()[0], before = t.c.popSig(item)
  p.email = 'old-lead-edit@example.test'
  assert.equal(t.c.popSig(item), before, 'Historical lead email is not the reservation contact')
  t.A.state.calendar.bookings[0].prospectEmail = 'corrected@example.test'
  const updated = t.c.popSig(item)
  assert.notEqual(updated, before)
  p.bookings[0].externalId = 'different'
  assert.notEqual(t.c.popSig(item), updated)
})

test('Today preserves both actual reservations and exact contacts outside the loaded grid range', () => {
  const one = profile('one', 'call-one', '+13125550101'), two = profile('two', 'call-two', '+13125550202')
  const t = ui([booked('one', 'call-one'), booked('two', 'call-two')], [two, one])
  t.A.state.calendar.slots = []; t.A.state.calendar.range = { from: '2040-01-01', to: '2040-01-01' }
  const rows = t.A.derive.toursOn(t.A.state, '2032-06-01')
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.externalId === 'one').phone, one.phone)
  assert.equal(rows.find(row => row.externalId === 'two').phone, two.phone)
  const html = rows.map(row => t.today.tourRowHtml(row, t.A.state, '2032-06-01')).join('')
  assert.match(html, /booking=one/); assert.match(html, /booking=two/)
  assert.equal(new Set([...html.matchAll(/data-key="tour:([^"]+)"/g)].map(match => match[1])).size, 2)
})

test('anonymous calendar and Today lead links retain the selected original call', () => {
  const a = profile('one', 'anonymous-one', 'unknown'), b = profile('two', 'anonymous-two', 'unknown')
  const t = ui([booked('one', 'anonymous-one'), booked('two', 'anonymous-two')], [b, a])
  const m = t.model(), item = m.dayModels[0].tours.find(row => row.slot.booking.externalId === 'one')
  const content = t.c.tourContent(t.A.state, m, item)
  assert.match(content.actions, /phone=unknown&amp;call=anonymous-one/)
  assert.doesNotMatch(content.actions, /anonymous-two/)
  const row = t.A.derive.toursOn(t.A.state, '2032-06-01').find(row => row.externalId === 'one')
  assert.match(t.today.tourRowHtml(row, t.A.state, '2032-06-01'), /phone=unknown&amp;call=anonymous-one/)
})

test('lead panel identifies missing reservation despite a different booking at that time', () => {
  const p = profile('removed', 'old-call', '+13125550101'), t = ui([booked('other', 'other-call')], [p])
  const html = t.leads.leadPanelHtml(p, t.A.state, new Map())
  assert.match(html, /Not matched to a saved reservation/)
  assert.match(html, /booking=removed/)
  assert.doesNotMatch(html, /booking=other/)
})

test('identity links and labels escape HTML without using URL characters as another identity', () => {
  const id = 'tour&\"<one>', p = profile(id, 'call-one', '+13125550101'), t = ui([booked(id, 'call-one')], [p])
  const html = t.leads.leadBriefHtml(p, t.A.state)
  assert.match(html, /booking=tour%26%22%3Cone%3E/)
  assert.doesNotMatch(html, /<one>/)
})


test('competing lead claims cannot show a calendar-confirmed chip', () => {
  const a = profile('one', 'call-one', '+13125550101'), b = profile('one', 'call-one', '+13125550202')
  const t = ui([booked('one', 'call-one')], [a, b])
  assert.match(t.leads.leadPanelHtml(a, t.A.state), /Not matched to a saved reservation/)
  assert.match(t.leads.leadPanelHtml(b, t.A.state), /Not matched to a saved reservation/)
})

test('unidentified historical tours link to the day without selecting somebody else’s slot', () => {
  const p = profile(undefined, 'old-call', '+13125550101'), t = ui([booked('new', 'new-call')], [p])
  const html = t.leads.leadBriefHtml(p, t.A.state)
  assert.doesNotMatch(html, /slot=|booking=/)
  t.A.state.calendar = null
  const row = t.A.derive.toursOn(t.A.state, '2032-06-01')[0]
  assert.doesNotMatch(t.today.tourRowHtml(row, t.A.state, '2032-06-01'), /slot=|booking=/)
})
