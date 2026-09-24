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
  runInNewContext(leads.replace("A.register('leads', view)", 'window.identityLeads = { calendarName, leadPanelHtml, leadBriefHtml, todoListHtml }; A.register(\'leads\', view)'), context)
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

test('confirmation task does not label another tour belonging to the same caller', () => {
  const p = profile('one','call-one','+13125550101')
  p.bookings.push({...p.bookings[0],externalId:'two',callId:'call-two'})
  const t=ui([booked('one','call-one'),booked('two','call-two')],[p])
  t.A.state.leads.followUps=[{id:'confirm-one',phone:p.phone,kind:'confirm_tour',status:'scheduled',dueAt:at,createdFromCall:'call-one',
    source:{version:2,kind:'booking',callId:'call-one',booking:{...p.bookings[0]}}}]
  const row=t.A.derive.toursOn(t.A.state,'2032-06-01').find(row=>row.externalId==='two')
  assert.doesNotMatch(t.today.tourRowHtml(row,t.A.state,'2032-06-01'),/Call to confirm/)
})

test('task description does not borrow a conflicting reservation’s details', () => {
  const p=profile('other','call-other','+13125550101'),t=ui([booked('other','call-other')],[p])
  const f={phone:p.phone,kind:'confirm_tour',status:'scheduled',dueAt:at,reason:'Confirm the reservation.',createdFromCall:'call-one',
    source:{version:2,kind:'booking',callId:'call-one',booking:{...p.bookings[0],externalId:'missing'}}}
  const text=t.A.derive.todoSentence(f,p,t.A.state)
  assert.doesNotMatch(text.after,/apartment 4A|12:00 PM/)
})

test('failed tour stays visible when a different reservation occupies the same time', () => {
  const p=profile('confirmed','call-one','+13125550101')
  p.bookings.push({...p.bookings[0],externalId:'failed',callId:'failed-call',status:'failed'})
  p.calls.push({callId:'failed-call',at:'2032-06-01T11:30:00Z',toolsCalled:[]})
  const t=ui([booked('confirmed','call-one')],[p])
  assert.ok(t.A.derive.needsPerson(t.A.state).some(row=>row.type==='stuckTour'&&row.callId==='failed-call'))
})


test('task matching refuses stale revisions, conflicting calls and ambiguous older bookings', () => {
  const p=profile('one','call-one','+13125550101'),t=ui([booked('one','call-one')],[p])
  const f={phone:p.phone,kind:'confirm_tour',createdFromCall:'call-one',source:{version:2,kind:'booking',callId:'call-one',booking:{...p.bookings[0],revision:0}}}
  assert.equal(t.A.derive.followUpBooking(f,p),p.bookings[0])
  p.bookings[0].rescheduleRevision=1
  assert.equal(t.A.derive.followUpBooking(f,p),null)
  p.bookings[0].rescheduleRevision=0;f.source.callId='different'
  assert.equal(t.A.derive.followUpBooking(f,p),null)
  delete f.source;p.bookings.push({...p.bookings[0],externalId:'two'})
  assert.equal(t.A.derive.followUpBooking(f,p),null)
})

test('review-held tasks cannot become a tour-specific call-to-confirm action', () => {
  const p=profile('one','call-one','+13125550101'),t=ui([booked('one','call-one')],[p])
  const f={phone:p.phone,kind:'confirm_tour',status:'scheduled',createdFromCall:'call-one',reconciliation:{status:'needs_review'},
    source:{version:2,kind:'booking',callId:'call-one',booking:{...p.bookings[0]}}}
  t.A.state.leads.followUps=[f]
  assert.equal(t.A.derive.followUpBooking(f,p),null)
  const row=t.A.derive.toursOn(t.A.state,'2032-06-01')[0]
  assert.doesNotMatch(t.today.tourRowHtml(row,t.A.state,'2032-06-01'),/Call to confirm/)
})

test('unrelated callback does not hide an unresolved booking for the same caller', () => {
  const p=profile('failed','failed-call','+13125550101');p.bookings[0].status='failed'
  p.calls.push({callId:'other-call',at:'2032-06-01T11:45:00Z',toolsCalled:[]})
  const t=ui([],[p]);t.A.state.leads.followUps=[{id:'callback',phone:p.phone,kind:'callback',status:'scheduled',createdFromCall:'other-call',reason:'General question',createdAt:at,dueAt:at}]
  assert.ok(t.A.derive.needsPerson(t.A.state).some(row=>row.type==='stuckTour'&&row.callId==='failed-call'))
})


test('completed future tasks remain recoverable and older completed work is explicitly loadable',()=>{
  const t=ui([])
  t.A.state.leads.followUps=Array.from({length:25},(_,i)=>({id:'fu-'+i,phone:'unknown',kind:'callback',status:'done',
    dueAt:'2032-07-01T14:00:00Z',createdAt:at,createdFromCall:'call-'+i,reason:'Synthetic follow-up',
    staffDecisions:[{requestId:'decision-'+i,to:'done',actorLabel:'Staff <script>',at:'2032-06-01T12:00:00Z'}]}))
  const html=t.leads.todoListHtml(t.A.state)
  assert.match(html,/Showing 20 of 25 completed tasks/);assert.match(html,/Show more completed tasks/)
  assert.equal((html.match(/data-action="back"/g)||[]).length,20)
  assert.match(html,/Staff &lt;script&gt;/);assert.doesNotMatch(html,/Staff <script>/)
})
