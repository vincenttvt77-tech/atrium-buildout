import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const calendarSource = await readFile(new URL('../../ops/src/calendar.js', import.meta.url), 'utf8')
const leadsSource = await readFile(new URL('../../ops/src/leads.js', import.meta.url), 'utf8')
const callsSource = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const property = (overrides = {}) => ({
  organizationId: 'organization-one', propertyId: 'chicago-one', buildingName: 'Lake House',
  locationLabel: 'Chicago, IL', timeZone: 'America/Chicago', configurationVersion: 7,
  permissionVersion: 'permissions-v3', permissions: ['read', 'operate', 'configure'],
  hours: { 1: [9, 17] }, leasingPhone: null, leasingPhoneDisplay: null, ...overrides,
})
const scopeOf = value => Object.fromEntries(['organizationId', 'propertyId', 'configurationVersion', 'permissionVersion'].map(key => [key, value[key]]))
const plain = value => JSON.parse(JSON.stringify(value))
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/** Execute the real browser source, without starting timers or a network server. */
function portal(options = {}) {
  const bootstrap = property(options.property)
  const window = { ATRIUM_RUNTIME_MODE: 'postgres', ATRIUM_PROPERTY: bootstrap,
    ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'user-one' }, ...options.window }
  const classes = new Set(), controls = []
  const classList = { toggle(key, on) { if (on) classes.add(key); else classes.delete(key) }, add(key) { classes.add(key) }, remove(key) { classes.delete(key) } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-write], [data-permission]' ? controls : [],
    getElementById: () => null, body: { textContent: '', classList } }
  let payload = { scope: scopeOf(bootstrap), timeZone: bootstrap.timeZone, calls: [], events: [], slots: [], blocks: [], bookings: [], profiles: [], followUps: [] }
  let handler = () => response(payload), reloads = 0
  const requests = []
  const context = { window, document, Intl, Date, console, URLSearchParams, setTimeout, clearTimeout,
    setInterval, clearInterval, matchMedia: () => ({ matches: false }),
    location: { hash: '', reload() { reloads++ } },
    fetch: async (path, init) => { requests.push({ path, ...init }); return handler(path, init) } }
  runInNewContext(source.replace('window.Atrium = {',
    'window.testPortal = { showView, paintCluster, todayView, followUpRowHtml, markBooted() { booted = true } }; window.Atrium = {'), context)
  return { app: window.Atrium, context, document, controls, classes, requests, bootstrap,
    scope: scopeOf(bootstrap), payload: () => payload, respond(data, status = 200) { payload = data; handler = () => response(payload, status) },
    handler(fn) { handler = fn }, reloads: () => reloads }
}

test('demo catalogue tool results retain priced-out and named-lookup facts after a cold start', async () => {
  const { checkAvailability } = await import('../../src/conversation/tools.ts')
  const { loadInventory } = await import('../../src/inventory/load.ts')
  const { emptyQualification } = await import('../../src/leasing/qualification.ts')
  const readData = async name => JSON.parse(await readFile(new URL(`../../data/${name}.json`, import.meta.url), 'utf8'))
  const [units, plans, provenance] = await Promise.all(['inventory', 'floorplans', 'inventory-source'].map(readData))
  const now = new Date('2026-09-09T19:12:00Z')
  const inventory = loadInventory(units, plans, new Date(provenance.catalogAsOf), 'bundled demo', provenance, now).snapshot
  const ctx = { propertyId: 'prop-demo', interactionId: 'portal-source-regression', inventory,
    articles: [], qualification: emptyQualification(), jurisdiction: 'NY', confidenceThreshold: 0.7, now }
  const ui = portal()
  const storyFor = args => {
    const result = checkAvailability(ctx, args).say
    assert.match(result, /fictional.*demo/i)
    // No process-local decision events survive this simulated cold start.
    return ui.app.derive.callStory({ id: 'call-source-regression', events: [],
      call: { toolCalls: [{ name: 'check_availability', arguments: args, result }] } }, ui.app.state)
  }
  const priced = storyFor({ bedrooms: '3', budget: '1000', moveIn: 'within three months' })
  assert.equal(priced.findings.pricedOut?.budget, 1000)
  assert.match(priced.steps[0].text, /nothing under \$1,000/i)
  assert.match(storyFor({ unitId: '29E' }).steps[0].text, /Looked up apartment 29E: available/)
  assert.match(storyFor({ unitId: 'NOT-A-UNIT' }).steps[0].text, /not on the list/)
  assert.equal(storyFor({ bedrooms: '4', budget: '12000', moveIn: 'within three months' }).findings.bedroomMismatch, true)
})

test('database property facts and timezone come only from the document bootstrap', () => {
  const ui = portal()
  assert.equal(ui.app.property.name, 'Lake House')
  assert.equal(ui.app.property.locationLabel, 'Chicago, IL')
  assert.equal(ui.app.property.leasingPhone, null)
  assert.deepEqual(plain(ui.app.property.hours), { 1: [9, 17] })
  assert.equal(ui.app.fmt.time('2032-06-01T15:00:00Z'), '10:00 AM')
  assert.equal(portal({ property: { hours: {}, locationLabel: '' } }).app.property.locationLabel, '')
  assert.deepEqual(plain(portal({ property: { hours: {} } }).app.property.hours), {})
  const legacy = portal({ window: { ATRIUM_RUNTIME_MODE: 'legacy', ATRIUM_PROPERTY: undefined } })
  assert.equal(legacy.app.property.name, 'The Larkin')
  assert.equal(legacy.app.property.timeZone, 'America/New_York')
})

test('budget displays preserve a minimum, maximum, range, or the caller’s original words', () => {
  const { derive } = portal().app
  assert.equal(derive.budgetText({ minMonthly: 8000, maxMonthly: null }), '$8,000+/mo')
  assert.equal(derive.budgetText({ minMonthly: 8000, maxMonthly: 12000 }), '$8,000–$12,000/mo')
  assert.equal(derive.budgetText({ minMonthly: null, maxMonthly: 8000 }), 'up to $8,000/mo')
  assert.equal(derive.budgetText(8000), 'up to $8,000/mo')
  assert.equal(derive.factValue('budget', 'over eight thousand'), 'over eight thousand')
  assert.equal(derive.budgetText({ minMonthly: 12000, maxMonthly: 8000 }), '')
})

test('call facts retain relative move timing when only the original tool words are available', () => {
  const ui = portal()
  const said = 'within now to three months'
  const story = ui.app.derive.callStory({ events: [], call: { toolCalls: [{ name: 'capture_signal',
    arguments: { signal: 'moveInTiming', value: said, excerpt: said }, result: 'Got it.' }] } }, ui.app.state)
  assert.doesNotMatch(story.wants, /from —/)
  assert.match(story.wants, /within now to three months/)
  assert.equal(story.facts[0].value, said)
})

test('invalid database bootstrap fails visibly before creating the app or requesting data', () => {
  for (const invalid of [
    { organizationId: '../other' }, { propertyId: null }, { configurationVersion: '7' },
    { configurationVersion: 0 }, { permissionVersion: '' }, { permissions: [] },
    { permissions: ['read', 'root'] }, { permissions: ['read', 'read'] },
    { timeZone: null }, { timeZone: 'Mars/Olympus' }, { buildingName: '' },
    { hours: null }, { hours: { 7: [9, 17] } }, { hours: { 1: [17, 9] } },
  ]) {
    const ui = portal({ property: invalid })
    assert.equal(ui.app, undefined, JSON.stringify(invalid))
    assert.match(ui.document.body.textContent, /configuration needs attention/i)
    assert.equal(ui.requests.length, 0)
  }
})

test('all scoped endpoints send immutable document identity and successful echoes are required', async () => {
  const ui = portal()
  ui.context.window.ATRIUM_PROPERTY.organizationId = 'tampered'
  ui.context.window.ATRIUM_PROPERTY.configurationVersion = 99
  for (const path of ['/api/vapi', '/api/calendar?from=2032-06-01', '/api/leads', '/api/vapi-sync']) {
    await ui.app.api.get(path)
    const sent = ui.requests.at(-1)
    assert.equal(sent.headers['x-atrium-organization-id'], 'organization-one')
    assert.equal(sent.headers['x-atrium-property-id'], 'chicago-one')
    assert.equal(sent.headers['x-atrium-config-version'], '7')
    assert.equal(sent.credentials, 'same-origin')
    assert.equal(sent.cache, 'no-store')
  }
  await ui.app.api.post('/api/calendar', { action: 'block', target: '2032-06-01' })
  const sent = ui.requests.at(-1)
  assert.equal(sent.headers['x-atrium-config-version'], '7')
  assert.equal(JSON.parse(sent.body).expectedTimeZone, 'America/Chicago')
  for (const path of ['/api/health', '/api/properties']) {
    await ui.app.api.get(path)
    assert.equal(ui.requests.at(-1).headers['x-atrium-property-id'], undefined)
  }
})

test('missing or mismatched response identity clears every loaded resource and prevents further ingestion', async () => {
  for (const mismatch of [null, { organizationId: 'other' }, { propertyId: 'other' }, { configurationVersion: 8 }, { permissionVersion: 'revoked' }]) {
    const ui = portal()
    ui.app.apply('leads', { ...ui.payload(), profiles: [{ phone: '+13125550101', name: 'Private Caller' }] })
    ui.app.apply('calls', { ...ui.payload(), calls: [{ id: 'private-call' }] })
    ui.app.apply('calendar', { ...ui.payload(), bookings: [{ slotId: 'private-tour' }] })
    const scope = mismatch === null ? undefined : { ...ui.scope, ...mismatch }
    ui.respond({ scope, profiles: [{ phone: '+13125550102', name: 'Wrong Property' }] })
    await assert.rejects(ui.app.api.get('/api/leads'), /property or your access changed/i)
    assert.equal(ui.app.state.leads, null)
    assert.equal(ui.app.state.calendar, null)
    assert.equal(ui.app.state.calls.length, 0)
    assert.deepEqual(plain(ui.app.state.loaded), { calls: false, calendar: false, leads: false })
    assert.throws(() => ui.app.apply('leads', { scope: ui.scope, profiles: [{ name: 'Late old data' }] }), /property or your access changed/i)
    const n = ui.requests.length
    await assert.rejects(ui.app.api.get('/api/leads'), /property or your access changed/i)
    assert.equal(ui.requests.length, n)
  }
})

test('an in-flight success cannot repopulate data after another request revokes property access', async () => {
  const ui = portal()
  let release
  ui.handler(path => path === '/api/leads'
    ? new Promise(resolve => { release = resolve })
    : response({ error: 'Property access revoked' }, 403))
  const late = ui.app.api.get('/api/leads')
  await assert.rejects(ui.app.api.get('/api/vapi'), error => error.status === 403)
  release(response({ scope: ui.scope, profiles: [{ name: 'Old pending result' }] }))
  await assert.rejects(late, /earlier property session/i)
  assert.equal(ui.app.state.leads, null)
  assert.equal(ui.reloads(), 0, '403 must not create a sign-in reload loop')
  ui.respond({ properties: [] })
  assert.deepEqual(plain(await ui.app.api.get('/api/properties')), { properties: [] }, 'authorized property catalogue remains reachable')
})

test('revoked access retires visible and cached hidden views and stops recordings', async () => {
  const ui = portal()
  const views = [false, true].map(hidden => ({ hidden, text: 'Cached private caller', replaceChildren() { this.text = '' } }))
  let pauses = 0
  const oldQuery = ui.document.querySelectorAll
  ui.document.querySelectorAll = selector => selector === '.view' ? views
    : selector === 'audio, video' ? [{ pause() { pauses++ } }] : oldQuery(selector)
  ui.context.window.testPortal.markBooted()
  ui.respond({ error: 'Revoked' }, 403)
  await assert.rejects(ui.app.api.get('/api/leads'))
  assert.equal(pauses, 1)
  assert.ok(views.every(view => view.hidden && view.text === ''))
  ui.context.window.testPortal.showView({ name: 'leads' }, true)
  assert.ok(views.every(view => view.hidden), 'hash navigation cannot revive a retired property document')
})

test('401 clears data and signs out once, while normal calendar conflicts allow retry', async () => {
  const signedOut = portal()
  signedOut.app.apply('leads', { ...signedOut.payload(), profiles: [{ name: 'Private Caller' }] })
  signedOut.respond({ error: 'Signed out' }, 401)
  await assert.rejects(signedOut.app.api.get('/api/leads'), error => error.signedOut === true)
  await assert.rejects(signedOut.app.api.get('/api/leads'), error => error.signedOut === true)
  assert.equal(signedOut.reloads(), 1)
  assert.equal(signedOut.app.state.leads, null)

  const conflict = portal()
  conflict.respond({ error: 'Settings changed', code: 'settings_conflict' }, 409)
  await assert.rejects(conflict.app.api.post('/api/calendar', { action: 'settings' }), error => error.status === 409)
  conflict.respond({ scope: conflict.scope, timeZone: 'America/Chicago', slots: [], blocks: [], bookings: [] })
  await conflict.app.api.get('/api/calendar')
  assert.equal(conflict.app.can('operate'), true)
})

test('stale configuration and missing property acknowledgement require a new document', async () => {
  for (const [status, code] of [[409, 'property_configuration_changed'], [428, 'property_scope_required']]) {
    const ui = portal()
    ui.respond({ error: 'Reload', code }, status)
    await assert.rejects(ui.app.api.get('/api/calendar'), /configuration changed/i)
    assert.equal(ui.app.can('operate'), false)
    assert.equal(ui.reloads(), 0, 'show explicit reload guidance')
    const count = ui.requests.length
    await assert.rejects(ui.app.api.post('/api/leads', { action: 'note' }), error => error.status === 403)
    assert.equal(ui.requests.length, count)
  }
})

test('database calendar refuses missing, invalid and contradictory timezones even with matching scope', async () => {
  for (const timeZone of [undefined, null, 'Mars/Olympus', 'America/Chicago']) {
    const ui = portal({ property: { timeZone: 'America/New_York' } })
    ui.respond({ scope: ui.scope, timeZone, slots: [], bookings: [], blocks: [] })
    await assert.rejects(ui.app.api.get('/api/calendar'), /timezone/i)
    assert.equal(ui.app.can('operate'), false)
  }
})

test('viewer writes and staff configuration changes are refused before network access', async () => {
  const viewer = portal({ property: { permissions: ['read'] } })
  await viewer.app.api.get('/api/leads')
  for (const [path, body] of [
    ['/api/leads', { action: 'add_note' }], ['/api/calendar', { action: 'block' }],
    ['/api/calendar', { action: 'settings' }], ['/api/vapi-sync', {}],
  ]) await assert.rejects(viewer.app.api.post(path, body), error => error.status === 403)
  assert.equal(viewer.requests.length, 1)
  const staff = portal({ property: { permissions: ['read', 'operate'] } })
  await staff.app.api.post('/api/calendar', { action: 'block' })
  await assert.rejects(staff.app.api.post('/api/calendar', { action: 'settings' }), error => error.status === 403)
  assert.equal(staff.requests.length, 1)
})

test('partial mutation results retain the validated scope while merging their resource', () => {
  const ui = portal()
  ui.app.apply('leads', { scope: ui.scope, profiles: [{ phone: 'one' }], followUps: [{ id: 'follow-one', dueAt: '2032-01-01' }] })
  ui.app.apply('leads', { scope: ui.scope, profile: { phone: 'two' } })
  assert.equal(ui.app.state.leads.profiles.length, 2)
  assert.equal(ui.app.state.leads.followUps.length, 1)
  ui.app.apply('calendar', { scope: ui.scope, timeZone: 'America/Chicago', slots: [], bookings: [{ slotId: 'tour-one' }], blocks: [] })
  ui.app.apply('calendar', { scope: ui.scope, blocks: [{ target: '2032-06-01' }] })
  assert.equal(ui.app.state.calendar.bookings.length, 1)
  assert.equal(ui.app.state.calendar.blocks.length, 1)
})

test('two documents keep independent properties, full navigation links and preference namespaces', async () => {
  const first = portal({ property: { organizationId: 'a.b', propertyId: 'c' } })
  const second = portal({ property: { organizationId: 'a', propertyId: 'b.c', timeZone: 'America/Los_Angeles' } })
  await Promise.all([first.app.api.get('/api/leads'), second.app.api.get('/api/leads')])
  assert.equal(first.requests[0].headers['x-atrium-property-id'], 'c')
  assert.equal(second.requests[0].headers['x-atrium-property-id'], 'b.c')
  assert.notEqual(first.app.preferenceKey('leads.tab'), second.app.preferenceKey('leads.tab'))
  const key = first.app.preferenceKey('leads.tab')
  first.context.window.ATRIUM_ACCOUNT.userId = 'changed'
  assert.equal(first.app.preferenceKey('leads.tab'), key)
  assert.equal(second.app.propertyUrl(second.scope), '/api/dashboard?organizationId=a&propertyId=b.c')
  assert.equal(second.app.propertyUrl({ organizationId: 'https://evil', propertyId: 'x' }), '/api/dashboard')
})

test('permission presentation hides denied controls without revealing intentionally hidden allowed controls', () => {
  const ui = portal({ property: { permissions: ['read', 'operate'] } })
  const control = (permission, hidden = false) => ({ dataset: permission ? { permission } : {}, hidden, disabled: false,
    attrs: {}, setAttribute(key, value) { this.attrs[key] = value } })
  const write = control(null), configure = control('configure'), hiddenWrite = control(null, true)
  ui.controls.push(write, configure, hiddenWrite)
  ui.app.paintPermissions()
  assert.equal(write.hidden, false)
  assert.equal(hiddenWrite.hidden, true)
  assert.equal(configure.hidden, true)
  assert.equal(configure.disabled, true)
  assert.equal(ui.classes.has('portal-no-configure'), true)
})

test('persistent sample workspace labels saved local data and never promises a restart reset', () => {
  const ui = portal({ window: { ATRIUM_DEMO: true, ATRIUM_DEMO_PERSISTENT: true } })
  const cluster = { innerHTML: '', setAttribute() {} }
  ui.document.getElementById = id => id === 'cluster' ? cluster : null
  ui.app.apply('leads', { ...ui.payload(), store: { kind: 'postgres', durable: true } })
  assert.match(cluster.innerHTML, /Local demo workspace/)
  assert.match(cluster.innerHTML, /Sample data saved locally/)
  assert.doesNotMatch(cluster.innerHTML, /restart|reset/i)
  ui.app.apply('leads', { ...ui.payload(), store: { kind: 'postgres', durable: false } })
  assert.match(cluster.innerHTML, /Changes aren&#39;t being saved/)
  assert.doesNotMatch(cluster.innerHTML, /restart|reset/i)
})

test('viewer calendar gestures cannot open editing dialogs and lead details omit the note editor', () => {
  const viewer = portal({ property: { permissions: ['read'] } })
  runInNewContext(calendarSource.replace("A.register('calendar', view)",
    "window.testCalendar = { openSheet, openSettings, view, cal }; A.register('calendar', view)"), viewer.context)
  const calendar = viewer.context.window.testCalendar
  calendar.cal.inert = false
  calendar.openSheet({ date: '2032-06-01' })
  calendar.openSettings()
  calendar.view.onPointerDown({ target: { closest: () => ({}) }, button: 0, pointerType: 'mouse' })
  assert.equal(calendar.cal.sheet, null)
  assert.equal(calendar.cal.drag, null)

  const profile = { phone: '+13125550101', name: 'Test Caller', stage: 'new', calls: [], bookings: [], notes: [], escalations: [] }
  for (const [permissions, hasEditor] of [[['read'], false], [['read', 'operate'], true]]) {
    const ui = portal({ property: { permissions } })
    runInNewContext(leadsSource.replace("A.register('leads', view)",
      "window.testLeadPanel = leadPanelHtml; A.register('leads', view)"), ui.context)
    const html = ui.context.window.testLeadPanel(profile, ui.app.state)
    assert.equal(html.includes('class="note-form"'), hasEditor)
    assert.ok(html.includes('Test Caller'), 'viewer retains read access to lead details')
  }
})

const reviewProvenance = { status: 'needs_review', code: 'legacy_followup_identity_ambiguous',
  candidateIds: ['private-candidate-one', '<img src=x onerror=alert(1)>'] }
const followUpFixture = (overrides = {}) => ({
  id: 'fu-legacy-review', phone: '+13125550101', kind: 'confirm_tour', channel: 'call',
  dueAt: '2020-06-01T15:00:00.000Z', reason: 'Staff retained this original reason.', status: 'scheduled',
  createdAt: '2020-05-31T15:00:00.000Z', createdFromCall: 'old-call', executable: false, ...overrides,
})
function loadLeadRenderers(ui) {
  runInNewContext(leadsSource.replace("A.register('leads', view)",
    "window.testLeads = { fuRowHtml, doneRowHtml, todoListHtml, leadPanelHtml }; A.register('leads', view)"), ui.context)
  return ui.context.window.testLeads
}
function assertReviewWarning(html) {
  assert.match(html, /Review needed/)
  assert.match(html, /This older task may refer to more than one tour\. Check the booking before contacting the caller\./)
  assert.doesNotMatch(html, /private-candidate|onerror=alert|<img/)
}

test('ambiguous follow-ups show safe review guidance in scheduled rows, completed rows and lead details without changing saved work', () => {
  const ui = portal(), render = loadLeadRenderers(ui)
  const profile = { phone: '+13125550101', name: 'Caller <strong>example</strong>', stage: 'new',
    calls: [], bookings: [], notes: [], escalations: [] }
  for (const status of ['scheduled', 'done', 'skipped']) {
    const followUp = followUpFixture({ status, dueAt: '2200-06-01T15:00:00.000Z', reconciliation: reviewProvenance })
    const original = structuredClone(followUp)
    ui.app.apply('leads', { scope: ui.scope, profiles: [profile], followUps: [followUp] })
    const row = status === 'scheduled' ? render.fuRowHtml(followUp, ui.app.state, { nameLink: true })
      : render.doneRowHtml(followUp, ui.app.state)
    assertReviewWarning(row)
    assert.doesNotMatch(row, /<strong>example<\/strong>/)
    assert.match(row, /&lt;strong&gt;example&lt;\/strong&gt;/)
    assertReviewWarning(render.leadPanelHtml(profile, ui.app.state))
    const list = render.todoListHtml(ui.app.state)
    assertReviewWarning(list)
    if (status !== 'scheduled') {
      assert.match(row, status === 'done' ? />Done</ : />Not needed</)
      assert.match(list, /<summary[^>]*>[\s\S]*?Review needed[\s\S]*?<\/summary>/)
      assert.match(list, /Review older tasks/)
      assert.doesNotMatch(list, /All caught up/)
    }
    assert.deepEqual(followUp, original)
    assert.deepEqual(plain(ui.app.state.leads.followUps[0]), original)
  }
  const normal = followUpFixture()
  assert.doesNotMatch(render.fuRowHtml(normal, ui.app.state), /Review needed/)
})

test('Today repaints both ordinary tasks and callback cards when polling adds only reconciliation status', () => {
  for (const kind of ['confirm_tour', 'callback']) {
    const ui = portal(), today = ui.context.window.testPortal.todayView
    const profile = { phone: '+13125550101', name: 'Caller', stage: 'new', calls: [], bookings: [], notes: [], escalations: [] }
    let html = '', writes = 0
    today.root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [],
      get innerHTML() { return html }, set innerHTML(value) { html = value; writes++ } }
    const followUp = followUpFixture({ kind })
    ui.app.apply('leads', { scope: ui.scope, profiles: [profile], followUps: [followUp] })
    today.render(ui.app.state)
    assert.doesNotMatch(html, /Review needed/)
    const before = writes
    ui.app.apply('leads', { scope: ui.scope, followUp: { ...followUp, reconciliation: reviewProvenance } })
    today.render(ui.app.state)
    assert.equal(writes, before + 1, `${kind} must repaint the new warning`)
    assertReviewWarning(html)
    today.render(ui.app.state)
    assert.equal(writes, before + 1, 'an unchanged poll does not replace the view again')
    assert.equal(ui.requests.length, 0, 'rendering a review warning cannot dispatch a contact action')
  }
})

test('the call detail keeps review guidance visible even when its callback was marked done', () => {
  const ui = portal()
  runInNewContext(callsSource.replace("A.register('calls', view)",
    "window.testCallPanel = panelHtml; A.register('calls', view)"), ui.context)
  const profile = { phone: '+13125550101', name: 'Caller', stage: 'escalated', bookings: [], notes: [],
    escalations: [{ callId: 'old-call', trigger: 'restricted:reasonable_accommodation', detail: 'A person was requested', at: '2020-05-31T15:00:00Z' }],
    calls: [{ callId: 'old-call', at: '2020-05-31T15:00:00Z', toolsCalled: [], outcome: 'Escalated' }] }
  const followUp = followUpFixture({ kind: 'callback', status: 'done', reconciliation: reviewProvenance })
  ui.app.apply('leads', { scope: ui.scope, profiles: [profile], followUps: [followUp] })
  const record = { id: 'old-call', phone: profile.phone, displayName: profile.name, profile,
    events: [{ kind: 'escalated', ...profile.escalations[0] }], call: null }
  const story = ui.app.derive.callStory(record, ui.app.state)
  assert.equal(story.needsPerson, true)
  const html = ui.context.window.testCallPanel(record, story, ui.app.state)
  assertReviewWarning(html)
  assert.match(html, /Handled — a person marked this done/)
})

test('same-day v2 tour tasks name their exact source booking while legacy rows retain date matching', () => {
  const { app } = portal()
  const bookings = [
    { slotId: 'same-slot-label', startsAt: '2032-06-01T15:00:00.000Z', unitId: '4A', status: 'confirmed' },
    { slotId: 'same-slot-label', startsAt: '2032-06-01T15:30:00.000Z', unitId: '7B', status: 'confirmed' },
  ]
  const profile = { phone: '+13125550101', name: 'Caller', bookings }
  for (const kind of ['confirm_tour', 'remind_tour', 'post_tour']) {
    for (const booking of bookings) {
      const followUp = followUpFixture({ kind, dueAt: kind === 'remind_tour' ? '2032-05-31T15:00:00Z' : '2032-06-01T12:00:00Z',
        source: { version: 2, kind: 'booking', booking: { ...booking, unitId: booking.unitId.toLowerCase() } } })
      const sentence = app.derive.todoSentence(followUp, profile, app.state).text
      assert.match(sentence, new RegExp(`apartment ${booking.unitId}`))
      assert.doesNotMatch(sentence, new RegExp(`apartment ${booking.unitId === '4A' ? '7B' : '4A'}`))
    }
  }
  for (const changed of [{ slotId: 'missing' }, { startsAt: '2032-06-01T15:45:00Z' }, { unitId: '99Z' }]) {
    const followUp = followUpFixture({ dueAt: '2032-06-01T12:00:00Z',
      source: { version: 2, kind: 'booking', booking: { ...bookings[1], ...changed } } })
    assert.doesNotMatch(app.derive.todoSentence(followUp, profile, app.state).text, /apartment (4A|7B)/)
  }
  const legacy = followUpFixture({ dueAt: '2032-06-01T12:00:00Z' })
  assert.match(app.derive.todoSentence(legacy, profile, app.state).text, /apartment 4A/)
})

test('durable late or anonymous safety reports appear in Today and call details without a notification claim', async () => {
  const { MemoryDocumentStore } = await import('../../src/store/documents.ts')
  const { recordCallSafetyEvent, listCallSafetyEvents, safetyEventForOps } = await import('../../src/calls/safety-events.ts')
  for (const known of [false, true]) {
    const ui = portal(), store = new MemoryDocumentStore(), callId = 'original-safety-call'
    const oldCall = { id: callId, startedAt: '2020-01-01T12:00:00Z', customerNumber: '+13125550101',
      transcript: 'User: Just checking the address.\nAI: Thank you for calling.', toolCalls: [] }
    await recordCallSafetyEvent(store, { callId, at: new Date(), signal: { kind: 'gas',
      matched: 'smell gas <img src=x onerror=alert(1)>', callEmergencyServices: true } })
    const events = (await listCallSafetyEvents(store)).map(safetyEventForOps)
    // Process-local events and profile history are absent after the simulated cold start.
    ui.app.apply('calls', { scope: ui.scope, calls: known ? [oldCall] : [], events, callsConfigured: true })
    ui.app.apply('leads', { scope: ui.scope, profiles: [], followUps: [] })
    const records = ui.app.derive.callRecords(ui.app.state)
    assert.equal(records.length, 1); assert.equal(records[0].id, callId)
    assert.equal(records[0].profile, null)
    if (known) assert.equal(records[0].startedAt, oldCall.startedAt)
    else assert.equal(records[0].displayName, 'Hidden number')
    const items = ui.app.derive.needsPerson(ui.app.state)
    assert.equal(items.length, 1); assert.equal(items[0].type, 'emergency')
    assert.match(items[0].action, /Emergency report saved for staff review\. No automatic notification has been sent\./)
    const today = ui.context.window.testPortal.todayView
    today.root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], innerHTML: '' }
    today.render(ui.app.state)
    assert.match(today.root.innerHTML, /Emergency report saved for staff review/)
    assert.match(today.root.innerHTML, /No automatic notification has been sent/)
    assert.match(today.root.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(today.root.innerHTML, /<img src=x|assistant told them|staff (?:was|were|has been) notified/i)
    runInNewContext(callsSource.replace("A.register('calls', view)",
      "window.testCallPanel = panelHtml; A.register('calls', view)"), ui.context)
    const story = ui.app.derive.callStory(records[0], ui.app.state)
    const panel = ui.context.window.testCallPanel(records[0], story, ui.app.state)
    assert.match(panel, /No automatic notification has been sent/)
    assert.doesNotMatch(panel, /assistant told them|<img src=x/i)
    assert.deepEqual(plain(ui.app.state.leads.profiles), [])
    assert.deepEqual(plain(ui.app.state.leads.followUps), [])
    assert.equal(ui.requests.length, 0)
  }
})

test('a failed safety feed preserves known incidents and repaints an explicit incomplete-list warning', () => {
  const ui = portal(), event = { id: 'call-safety:known', kind: 'emergency', durable: true,
    callId: 'known', at: new Date().toISOString(), emergencyKind: 'gas', matched: 'smell gas', notificationStatus: 'not_sent' }
  ui.app.apply('calls', { scope: ui.scope, calls: [], events: [event] })
  ui.app.apply('leads', { scope: ui.scope, profiles: [], followUps: [] })
  const today = ui.context.window.testPortal.todayView
  today.root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], innerHTML: '' }
  today.render(ui.app.state)
  assert.doesNotMatch(today.root.innerHTML, /Safety reports are temporarily unavailable/)
  ui.app.apply('calls', { scope: ui.scope, calls: [], events: [], safetyEventsError: 'unavailable' })
  today.render(ui.app.state)
  assert.match(today.root.innerHTML, /Safety reports are temporarily unavailable\. The list may be incomplete\./)
  assert.match(today.root.innerHTML, /Emergency report saved/)
  assert.deepEqual(plain(ui.app.state.events), [event])
  ui.app.apply('calls', { scope: ui.scope, calls: [], events: [event], safetyEventsError: null })
  today.render(ui.app.state)
  assert.doesNotMatch(today.root.innerHTML, /Safety reports are temporarily unavailable/)
})
