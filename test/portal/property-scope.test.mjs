import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const calendarSource = await readFile(new URL('../../ops/src/calendar.js', import.meta.url), 'utf8')
const leadsSource = await readFile(new URL('../../ops/src/leads.js', import.meta.url), 'utf8')
const callsSource = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const unitsSource = await readFile(new URL('../../ops/src/units.js', import.meta.url), 'utf8')
const calendarActionsSource = await readFile(new URL('../../ops/src/calendar-actions.js', import.meta.url), 'utf8')
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
  const context = { window, document, Intl, Date, console, URLSearchParams, structuredClone, setTimeout, clearTimeout,
    setInterval, clearInterval, matchMedia: () => ({ matches: false }),
    location: { hash: '', reload() { reloads++ } },
    fetch: async (path, init) => { requests.push({ path, ...init }); return handler(path, init) } }
  runInNewContext(source.replace('window.Atrium = {',
    'window.testPortal = { showView, paintCluster, todayView, followUpRowHtml, addDialog(dialog) { dialogs.push(dialog) }, markBooted() { booted = true } }; window.Atrium = {'), context)
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

const feedbackFixture = (overrides = {}) => ({ id: 'uf-' + 'a'.repeat(64), unitId: '4A', sentiment: 'positive', category: 'light',
  note: 'Afternoon light was a highlight.', leadPhone: '+13125550101', observedDate: '2026-09-09',
  createdAt: '2026-09-09T16:00:00Z', updatedAt: '2026-09-09T16:00:00Z', createdBy: { id: 'staff-one', label: 'Staff One' },
  updatedBy: { id: 'staff-one', label: 'Staff One' }, revision: 1, ...overrides })
function feedbackPayload(ui, overrides = {}) {
  return { ...ui.payload(), feedbackUnits: [
    { unitId: '4A', floorPlanId: 'studio-a', floorPlanName: 'Studio A', bedrooms: 0, sqft: 480 },
    { unitId: '7B', floorPlanId: 'one-b', floorPlanName: 'One Bedroom B', bedrooms: 1, sqft: 760 },
  ], feedbackInventory: { sourceMode: 'demo', readAt: '2026-09-01T12:00:00Z', source: 'Fictional source <b>only</b>', fictional: true },
    unitFeedback: [], unitFeedbackTruncated: false,
    profiles: [{ phone: '+13125550101', name: 'Test Prospect', notes: [], bookings: [], calls: [] }], ...overrides }
}
function loadUnits(ui) {
  runInNewContext(unitsSource.replace("A.register('units', view)",
    "window.testUnits = { feedbackModel, detailHtml, sourceHtml, unitsHtml, feedbackRequest, openFeedback, view }; A.register('units', view)"), ui.context)
  return ui.context.window.testUnits
}
function feedbackDialog(ui, values) {
  let spec, closed = false, error = '', primary = {}
  const fieldset = { disabled: false }
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]))
  const form = { addEventListener() {}, reportValidity: () => true,
    elements: { namedItem: key => fields[key] }, querySelector: selector => selector === 'fieldset' ? fieldset : null }
  const handle = { setError(value) { error = value }, setPrimary(value) { primary = { ...primary, ...value } },
    close() { closed = true; spec.onClose() }, isBusy: () => false }
  ui.context.window.crypto = { randomUUID: () => '00000000-1111-4222-8333-444444444444' }
  ui.app.dialog = value => { spec = value; spec.build({ innerHTML: '', querySelector: () => form }); ui.context.window.testPortal.addDialog(handle); return handle }
  return { fields, fieldset, submit: () => spec.primary.onClick(handle), closed: () => closed, error: () => error, primary: () => primary }
}

test('unit feedback summaries count saved observations, preserve prior units and escape notes, names and source labels', () => {
  const ui = portal(), units = loadUnits(ui)
  const unsafe = '<img src=x onerror=alert(1)>'
  ui.app.apply('leads', feedbackPayload(ui, { unitFeedback: [feedbackFixture({ note: unsafe, createdBy: { id: 'staff', label: unsafe } }),
    feedbackFixture({ id: 'negative', unitId: '4A', sentiment: 'negative', category: 'price', leadPhone: null }),
    feedbackFixture({ id: 'neutral', unitId: '7B', sentiment: 'neutral', category: 'layout' }),
    feedbackFixture({ id: 'prior', unitId: 'OLD', sentiment: 'negative', category: 'noise' })] }))
  const model = units.feedbackModel(ui.app.state)
  assert.deepEqual(plain(model.counts), { positive: 1, negative: 2, neutral: 1 })
  assert.equal(model.entries.length, 4); assert.equal(model.unitsWithFeedback, 3)
  assert.equal(model.shownUnits.find(unit => unit.unitId === 'OLD').current, false)
  const selected = units.feedbackModel(ui.app.state, { unitId: '4A' })
  assert.deepEqual(plain(selected.counts), { positive: 1, negative: 1, neutral: 0 })
  assert.equal(units.feedbackModel(ui.app.state, { unitId: 'other-property-unit' }).entries.length, 0)
  assert.equal(units.feedbackModel(ui.app.state, { query: 'studio' }).shownUnits.length, 1)
  const html = units.detailHtml(selected, ui.app.state) + units.sourceHtml(model)
  assert.match(html, /Recurring reasons/); assert.match(html, /Test Prospect/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /Fictional demo catalogue/); assert.match(html, /&lt;b&gt;only&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<img src=x|<b>only<\/b>|property score:\s*\d/i)
  assert.match(units.unitsHtml(model, 'OLD'), /Prior unit reference/)
})

test('feedback filtering uses property-local observed dates and signals unavailable data or truncation honestly', () => {
  const ui = portal(), units = loadUnits(ui), today = ui.app.fmt.nyNow().ymd
  ui.app.apply('leads', feedbackPayload(ui, { unitFeedback: [feedbackFixture({ observedDate: today }),
    feedbackFixture({ id: 'older', observedDate: ui.app.fmt.addDays(today, -30) })], unitFeedbackTruncated: true }))
  assert.equal(units.feedbackModel(ui.app.state, { period: '30' }).entries.length, 1)
  const view = units.view
  view.root = { querySelectorAll: () => [] }; view.add = {}; view.source = { innerHTML: '' }; view.list = { innerHTML: '', querySelectorAll: () => [] }; view.detail = { innerHTML: '' }
  view.render(ui.app.state)
  assert.match(view.source.innerHTML, /latest 500 saved entries/)
  ui.app.apply('leads', { scope: ui.scope, feedbackInventory: null })
  view.render(ui.app.state)
  assert.match(view.source.innerHTML, /not available from this workspace/)
  assert.equal(view.add.disabled, true); assert.equal(view.detail.innerHTML, '')
})

test('feedback mutation merging keeps all other current-property CRM data and catalog metadata', () => {
  const ui = portal()
  const initial = feedbackPayload(ui, { followUps: [followUpFixture()] })
  ui.app.apply('leads', initial)
  const entry = feedbackFixture()
  ui.app.apply('leads', { scope: ui.scope, unitFeedback: entry })
  ui.app.apply('leads', { scope: ui.scope, profile: { ...initial.profiles[0], name: 'Changed name' } })
  ui.app.apply('leads', { scope: ui.scope, unitFeedback: { ...entry, revision: 2, note: 'Edited note' } })
  assert.equal(ui.app.state.leads.unitFeedback.length, 1)
  assert.equal(ui.app.state.leads.unitFeedback[0].revision, 2)
  assert.deepEqual(plain(ui.app.state.leads.feedbackUnits), initial.feedbackUnits)
  assert.deepEqual(plain(ui.app.state.leads.feedbackInventory), initial.feedbackInventory)
  assert.deepEqual(plain(ui.app.state.leads.followUps), initial.followUps)
  assert.equal(ui.app.state.leads.profiles[0].name, 'Changed name')
})

test('pending tour reconciliation survives feedback writes and cannot reintroduce held scheduled tasks', () => {
  const ui = portal(), banner = { innerHTML: '' }, pending = { externalId: 'tour-one', requestId: 'request-one', revision: 2 }
  ui.document.getElementById = id => id === 'global-banners' ? banner : null
  const held = followUpFixture()
  ui.app.apply('leads', feedbackPayload(ui, { followUps: [], heldFollowUps: [held], rescheduleProjectionPending: [pending] }))
  ui.app.apply('calendar', calendarPayload(ui, { rescheduleProjectionPending: [pending] }))
  ui.app.apply('leads', { scope: ui.scope, unitFeedback: feedbackFixture() })
  ui.app.apply('leads', { scope: ui.scope, followUp: held })
  assert.deepEqual(plain(ui.app.state.leads.followUps), [])
  assert.deepEqual(plain(ui.app.state.leads.heldFollowUps), [held])
  assert.deepEqual(plain(ui.app.state.leads.rescheduleProjectionPending), [pending])
  assert.match(banner.innerHTML, /A tour change is saved; CRM follow-ups are pending reconciliation/)
  assert.doesNotMatch(banner.innerHTML, /2 tour changes/)
  ui.app.apply('leads', { scope: ui.scope, followUp: { ...held, status: 'done' } })
  assert.equal(ui.app.state.leads.followUps[0].status, 'done', 'completed staff history remains visible')
  ui.app.apply('leads', { scope: ui.scope, rescheduleProjectionPending: [], heldFollowUps: [] })
  ui.app.apply('calendar', { scope: ui.scope, timeZone: 'America/Chicago', rescheduleProjectionPending: [] })
  assert.equal(banner.innerHTML, '')
})

test('feedback forms require current property references and dates; edits cannot change the unit', () => {
  const ui = portal(), units = loadUnits(ui)
  ui.app.apply('leads', feedbackPayload(ui))
  const valid = { unitId: '4A', sentiment: 'negative', category: 'price', observedDate: ui.app.fmt.nyNow().ymd,
    note: 'Rent was beyond the stated budget.', leadPhone: '+13125550101' }
  const request = units.feedbackRequest(valid, ui.app.state, null, 'retry-key')
  assert.equal(request.action, 'unit_feedback_add'); assert.equal(request.unitId, '4A')
  for (const invalid of [{ unitId: 'foreign' }, { sentiment: '' }, { category: '' }, { observedDate: '2026-02-30' },
    { observedDate: '2099-01-01' }, { leadPhone: '+13125550999' }, { note: 'x'.repeat(1001) }])
    assert.throws(() => units.feedbackRequest({ ...valid, ...invalid }, ui.app.state, null, 'retry-key'))
  const edit = units.feedbackRequest({ ...valid, unitId: '7B' }, ui.app.state, feedbackFixture({ revision: 4 }), 'retry-key')
  assert.equal(edit.action, 'unit_feedback_edit'); assert.equal(edit.expectedRevision, 4)
  assert.equal('unitId' in edit, false)
})

test('a lost feedback acknowledgement retries the same immutable payload and merges exactly one saved entry', async () => {
  const ui = portal(), units = loadUnits(ui)
  ui.app.apply('leads', feedbackPayload(ui))
  const values = { unitId: '4A', sentiment: 'positive', category: 'light', observedDate: ui.app.fmt.nyNow().ymd, note: 'Bright rooms.', leadPhone: '' }
  const dialog = feedbackDialog(ui, values)
  units.openFeedback('4A')
  let attempts = 0
  ui.handler(() => { if (++attempts === 1) throw new Error('lost acknowledgement'); return response({ scope: ui.scope, unitFeedback: feedbackFixture({ leadPhone: null }) }) })
  await dialog.submit()
  assert.match(dialog.error(), /save could not be confirmed/); assert.equal(dialog.fieldset.disabled, true)
  assert.equal(dialog.closed(), false); assert.equal(ui.app.state.leads.unitFeedback.length, 0)
  dialog.fields.note.value = 'A changed local field must not change an ambiguous retry.'
  await dialog.submit()
  const posts = ui.requests.filter(request => request.method === 'POST')
  assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body)
  assert.equal(posts[0].headers['x-atrium-property-id'], 'chicago-one')
  assert.equal(dialog.closed(), true); assert.equal(ui.app.state.leads.unitFeedback.length, 1)
})

test('viewers and forms from revoked property documents cannot save feedback', async () => {
  const viewer = portal({ property: { permissions: ['read'] } }), readonly = loadUnits(viewer)
  viewer.app.apply('leads', feedbackPayload(viewer, { unitFeedback: [feedbackFixture()] }))
  assert.equal(readonly.openFeedback('4A'), null)
  assert.doesNotMatch(readonly.detailHtml(readonly.feedbackModel(viewer.app.state), viewer.app.state), /data-edit=/)
  assert.equal(viewer.requests.length, 0)
  const ui = portal(), units = loadUnits(ui)
  ui.app.apply('leads', feedbackPayload(ui))
  const dialog = feedbackDialog(ui, { unitId: '4A', sentiment: 'positive', category: 'light', observedDate: ui.app.fmt.nyNow().ymd, note: '', leadPhone: '' })
  units.openFeedback('4A')
  ui.respond({ scope: { ...ui.scope, propertyId: 'different-property' }, unitFeedback: [] })
  await assert.rejects(ui.app.api.get('/api/leads'))
  await dialog.submit()
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 0)
  assert.equal(ui.app.state.leads, null)
})

function calendarActionsDialog(ui, values) {
  let spec, closed = false, error = '', primary = {}, html = '', opened = 0
  const fields = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name,
    value: typeof value === 'boolean' ? '' : value, checked: value === true, innerHTML: '', disabled: false,
    listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn } }]))
  const nodes = { '[data-block-list]': { innerHTML: '', addEventListener() {} }, '[data-times]': { hidden: true },
    fieldset: { disabled: false }, form: { reportValidity: () => true, addEventListener() {}, querySelectorAll: () => Object.values(fields) } }
  const body = { get innerHTML() { return html }, set innerHTML(value) { html = value },
    querySelectorAll: selector => selector === '[name]' ? Object.values(fields) : [], querySelector: selector => nodes[selector] || null }
  const handle = { body, el: { querySelector: () => ({ click() {} }) }, setError(value) { error = value },
    setPrimary(value) { primary = { ...primary, ...value } }, setBusy() {}, close() { closed = true; spec.onClose() }, isBusy: () => false }
  let sequence = 0
  ui.context.window.crypto = { randomUUID: () => `00000000-1111-4222-8333-${String(++sequence).padStart(12, '0')}` }
  ui.app.dialog = value => { opened++; spec = value; primary = value.primary || {}; spec.build(body, handle); ui.context.window.testPortal.addDialog(handle); return handle }
  ui.app.refresh = async () => undefined
  runInNewContext(calendarActionsSource, ui.context)
  return { fields, submit: () => spec.primary.onClick(handle), close: () => handle.close(), closed: () => closed,
    error: () => error, primary: () => primary, html: () => html, opened: () => opened }
}
const calendarPayload = (ui, extra = {}) => ({ ...ui.payload(), units: [{ unitId: '4A', label: 'Apartment 4A' }, { unitId: '7B', label: 'Apartment 7B' }], unitBlocks: [], ...extra })
const bookingFixture = () => ({ externalId: 'booking-original', revision: 3, unitId: '4A', prospectName: 'Test Tour',
  startsAt: '2032-06-01T15:00:00Z', endsAt: '2032-06-01T15:45:00Z' })
const tourOption = (id, startsAt = '2032-06-02T15:00:00Z') => ({ slotId: id, startsAt, endsAt: new Date(Date.parse(startsAt) + 45 * 60000).toISOString() })
const flushTasks = () => new Promise(resolve => setImmediate(resolve))

test('rescheduling ignores out-of-order availability and rejects a changed booking revision', async () => {
  const ui = portal(), pending = []
  ui.app.apply('calendar', calendarPayload(ui, { bookings: [bookingFixture()] }))
  const dialog = calendarActionsDialog(ui, { unitId: '4A', date: '2032-06-02', slotId: '' })
  ui.handler((url) => new Promise(resolve => pending.push({ url, resolve })))
  ui.app.calendarActions.openReschedule(bookingFixture())
  await flushTasks()
  dialog.fields.date.value = '2032-06-03'
  const second = dialog.fields.date.listeners.change()
  assert.equal(pending.length, 2)
  pending[1].resolve(response({ ...calendarPayload(ui), reschedule: { booking: { revision: 3 }, slots: [tourOption('latest-slot')] } }))
  await second
  assert.match(dialog.fields.slotId.innerHTML, /latest-slot/)
  pending[0].resolve(response({ ...calendarPayload(ui), reschedule: { booking: { revision: 3 }, slots: [tourOption('obsolete-slot')] } }))
  await flushTasks()
  assert.match(dialog.fields.slotId.innerHTML, /latest-slot/)
  assert.doesNotMatch(dialog.fields.slotId.innerHTML, /obsolete-slot/)
  dialog.fields.date.value = '2032-06-04'
  const changed = dialog.fields.date.listeners.change()
  pending[2].resolve(response({ ...calendarPayload(ui), reschedule: { booking: { revision: 4 }, slots: [tourOption('changed-booking-slot')] } }))
  await changed
  assert.match(dialog.error(), /tour changed in another session/)
  assert.equal(dialog.primary().disabled, true)
  assert.doesNotMatch(dialog.fields.slotId.innerHTML, /changed-booking-slot/)
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 0)
})

test('rescheduling retains booking revision and request identity after a lost acknowledgement', async () => {
  const ui = portal()
  ui.app.apply('calendar', calendarPayload(ui, { bookings: [bookingFixture()] }))
  const dialog = calendarActionsDialog(ui, { unitId: '4A', date: '2032-06-02', slotId: '' })
  let posts = 0
  ui.handler((path, init) => {
    if (init.method === 'POST') {
      if (++posts === 1) throw new Error('lost response')
      return response(savedReschedulePayload(ui, JSON.parse(init.body), tourOption('replacement-slot')))
    }
    return response({ ...calendarPayload(ui), reschedule: { booking: { revision: 3 }, slots: [tourOption('replacement-slot')] } })
  })
  ui.app.calendarActions.openReschedule(bookingFixture())
  await flushTasks()
  dialog.fields.slotId.value = 'replacement-slot'
  await assert.rejects(dialog.submit(), /result could not be (?:fully )?verified/)
  assert.ok(Object.values(dialog.fields).every(field => field.disabled), 'ambiguous saves lock the prior selection')
  assert.equal(dialog.closed(), false)
  await dialog.submit()
  const requests = ui.requests.filter(request => request.method === 'POST')
  assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body)
  const sent = JSON.parse(requests[0].body)
  assert.equal(sent.externalId, 'booking-original'); assert.equal(sent.expectedRevision, 3)
  assert.equal(sent.expectedTimeZone, 'America/Chicago')
  assert.equal(requests[0].headers['x-atrium-property-id'], 'chicago-one')
  assert.equal(dialog.closed(), true)
  assert.equal(ui.app.state.calendar.bookings[0].revision, 4)
})

test('unit blackout selectors use the current property inventory and exact retries preserve units and blocks', async () => {
  const ui = portal(), block = { id: 'unit-block', revision: 1, unitId: '4A', startsAt: '2032-06-01T05:00:00Z', endsAt: '2032-06-02T05:00:00Z', reason: 'Painting' }
  ui.app.apply('calendar', calendarPayload(ui, { units: [{ unitId: '4A', label: 'Apartment <unsafe>' }] }))
  const dialog = calendarActionsDialog(ui, { unitId: '4A', allDay: true, date: '2032-06-01', endDate: '2032-06-01', startTime: '09:00', endTime: '17:00', reason: 'Painting' })
  let posts = 0
  ui.handler((path, init) => {
    if (init.method === 'POST') { if (++posts === 1) throw new Error('lost response'); Object.assign(block, { requestId: JSON.parse(init.body).requestId, date: '2032-06-01', endDate: '2032-06-01', allDay: true }); return response(calendarPayload(ui, { unitBlocks: [block] })) }
    return response(calendarPayload(ui, { units: [{ unitId: '4A' }] }))
  })
  ui.app.calendarActions.openUnitBlocks({ unitId: 'FOREIGN-PROPERTY-UNIT', date: '2032-06-01' })
  assert.match(dialog.html(), /Apartment &lt;unsafe&gt;/)
  assert.doesNotMatch(dialog.html(), /FOREIGN-PROPERTY-UNIT|<unsafe>/)
  await assert.rejects(dialog.submit())
  assert.ok(Object.values(dialog.fields).every(field => field.disabled), 'ambiguous unit blocks lock the prior selection')
  await dialog.submit()
  const requests = ui.requests.filter(request => request.method === 'POST')
  assert.equal(requests[0].body, requests[1].body)
  assert.equal(JSON.parse(requests[0].body).unitId, '4A')
  assert.deepEqual(plain(ui.app.state.calendar.unitBlocks), [block])
  ui.app.apply('calendar', { scope: ui.scope, timeZone: 'America/Chicago', slots: [] })
  assert.deepEqual(plain(ui.app.state.calendar.unitBlocks), [block])
  assert.equal(ui.app.state.calendar.units.length, 2)
})

test('read-only users cannot open tour-change or unit-blackout forms and closed previews cannot repopulate options', async () => {
  const viewer = portal({ property: { permissions: ['read'] } })
  viewer.app.apply('calendar', calendarPayload(viewer))
  const readonly = calendarActionsDialog(viewer, {})
  viewer.app.calendarActions.openUnitBlocks(); viewer.app.calendarActions.openReschedule(bookingFixture())
  assert.equal(readonly.opened(), 0); assert.equal(viewer.requests.length, 0)
  const ui = portal()
  ui.app.apply('calendar', calendarPayload(ui))
  const dialog = calendarActionsDialog(ui, { unitId: '4A', date: '2032-06-02', slotId: '' })
  let resolve
  ui.handler(() => new Promise(done => { resolve = done }))
  ui.app.calendarActions.openReschedule(bookingFixture())
  await flushTasks(); dialog.close()
  resolve(response({ ...calendarPayload(ui), reschedule: { booking: { revision: 3 }, slots: [tourOption('too-late')] } }))
  await flushTasks()
  assert.doesNotMatch(dialog.fields.slotId.innerHTML, /too-late/)
  assert.equal(dialog.closed(), true)
})

const legacyPortal = () => portal({ property: { timeZone: 'America/New_York' }, window: { ATRIUM_RUNTIME_MODE: 'legacy',
  ATRIUM_PROPERTY: { timeZone: 'America/New_York' }, ATRIUM_ACCOUNT: { username: 'first', tenantId: 'account-one', displayName: 'First account' } } })

test('legacy property requests bind to the rendered account, while PostgreSQL uses its existing property scope', async () => {
  const ui = legacyPortal()
  ui.context.window.ATRIUM_ACCOUNT.tenantId = 'account-two'
  for (const path of ['/api/leads', '/api/calendar', '/api/vapi', '/api/vapi-sync']) {
    await ui.app.api.get(path)
    await ui.app.api.post(path, { action: 'synthetic-check' })
    for (const request of ui.requests.slice(-2)) {
      assert.equal(request.headers['x-atrium-tenant-id'], 'account-one')
      assert.equal(request.headers['x-atrium-property-id'], undefined)
    }
  }
  await ui.app.api.get('/api/health')
  assert.equal(ui.requests.at(-1).headers['x-atrium-tenant-id'], undefined)
  const db = portal()
  await db.app.api.get('/api/leads')
  assert.equal(db.requests[0].headers['x-atrium-tenant-id'], undefined)
  const fallback = portal({ property: { timeZone: 'America/New_York' }, window: { ATRIUM_RUNTIME_MODE: 'legacy', ATRIUM_PROPERTY: undefined, ATRIUM_ACCOUNT: undefined } })
  await fallback.app.api.get('/api/leads')
  assert.equal(fallback.requests[0].headers['x-atrium-tenant-id'], 'legacy')
})

test('a changed legacy account rejects feedback or blackout before storage and closes the stale form', async () => {
  for (const action of ['feedback', 'blackout']) {
    const ui = legacyPortal()
    ui.app.apply('leads', feedbackPayload(ui))
    ui.app.apply('calendar', calendarPayload(ui))
    let dialog
    if (action === 'feedback') {
      const units = loadUnits(ui)
      dialog = feedbackDialog(ui, { unitId: '4A', sentiment: 'positive', category: 'light', observedDate: ui.app.fmt.nyNow().ymd, note: 'Synthetic note', leadPhone: '' })
      units.openFeedback('4A')
    } else {
      dialog = calendarActionsDialog(ui, { unitId: '4A', allDay: true, date: '2032-06-01', endDate: '2032-06-01', startTime: '09:00', endTime: '17:00', reason: 'Synthetic painting' })
      ui.app.calendarActions.openUnitBlocks({ unitId: '4A', date: '2032-06-01' })
    }
    ui.context.window.testPortal.markBooted()
    const currentCookieAccount = 'account-two'
    let storedWrites = 0
    ui.handler((path, request) => {
      if (request.headers['x-atrium-tenant-id'] !== currentCookieAccount) return response({ code: 'portal_tenant_changed', error: 'Account changed' }, 409)
      storedWrites++; return response({ unitFeedback: feedbackFixture() })
    })
    await dialog.submit().catch(error => assert.match(error.message, /account changed in another tab/))
    assert.equal(storedWrites, 0)
    assert.equal(dialog.closed(), true)
    assert.equal(ui.app.can('operate'), false)
    assert.equal(ui.app.state.leads, null); assert.equal(ui.app.state.calendar, null)
    await assert.rejects(ui.app.api.get('/api/leads'), /account changed in another tab/)
    assert.equal(ui.requests.length, 1, 'the retired document makes no further scoped requests')
  }
})

test('an older successful legacy response cannot repopulate data after account mismatch', async () => {
  const ui = legacyPortal()
  let resolveOld
  ui.handler(path => path === '/api/leads' ? new Promise(resolve => { resolveOld = resolve })
    : response({ code: 'portal_tenant_changed', error: 'Account changed' }, 409))
  const old = ui.app.api.get('/api/leads')
  await assert.rejects(ui.app.api.get('/api/vapi'), /account changed in another tab/)
  resolveOld(response(feedbackPayload(ui, { unitFeedback: [feedbackFixture()] })))
  await assert.rejects(old, /earlier property session/)
  assert.equal(ui.app.state.leads, null)
  assert.throws(() => ui.app.apply('leads', feedbackPayload(ui)), /account changed in another tab/)
})

const tourChangeFixture = (overrides = {}) => ({ version: 1, id: 'tour-change:' + 'c'.repeat(64), callId: 'change-call',
  firstRequestedAt: '2026-09-09T20:00:00Z', lastUpdatedAt: '2026-09-09T20:00:00Z', revision: 0, status: 'pending',
  reason: 'caller_requested', excerpts: ['Please move my tour.'], phone: null, name: null, email: null,
  identityVerified: false, notificationStatus: 'not_sent', ...overrides })
function tourReviewDialog(ui) {
  let spec, closed = false, error = '', primary = {}, html = ''
  const note = { value: '', disabled: false }, messages = []
  const handle = { setError(value) { error = value }, setPrimary(value) { primary = {...primary, ...value} },
    close() { closed = true; spec.onClose() }, isBusy: () => false }
  ui.app.dialog = value => { spec = value; const body = { querySelector: () => note, set innerHTML(v) { html = v } }; spec.build(body); ui.context.window.testPortal.addDialog(handle); return handle }
  ui.app.toast = value => messages.push(value)
  return { note, messages, submit: () => spec.primary.onClick(handle), closed: () => closed, error: () => error, primary: () => primary, html: () => html }
}

test('anonymous tour-change requests appear in Today and Leads without inventing a profile or promising changes', () => {
  const ui = portal(), unsafe = '<img src=x onerror=alert(1)>', request = tourChangeFixture({ excerpts: [unsafe] })
  const renderers = loadLeadRenderers(ui)
  ui.app.apply('leads', {...ui.payload(), tourChangeRequests: [request]})
  assert.equal(ui.app.derive.needsPerson(ui.app.state)[0].type, 'tourChange')
  assert.equal(ui.app.derive.dueTodayCount(ui.app.state), 1)
  const today = ui.context.window.testPortal.todayView
  today.root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], innerHTML: '' }
  today.render(ui.app.state)
  for (const html of [today.root.innerHTML, renderers.todoListHtml(ui.app.state)]) {
    assert.match(html, /Tour-change request/)
    assert.match(html, /Caller details not provided.*identity unverified/)
    assert.match(html, /Verify the caller and the correct booking/)
    assert.match(html, /href="#\/calendar"/)
    assert.match(html, /&lt;img src=x/)
    assert.doesNotMatch(html, /<img src=x|All caught up|Nothing to do yet/)
  }
  assert.deepEqual(plain(ui.app.state.leads.profiles), [])
  const reviewed = {...request, status: 'reviewed', revision: 1, review: { at: '2026-09-09T21:00:00Z', actorId: 'staff', note: unsafe } }
  ui.app.apply('leads', {scope: ui.scope, tourChangeRequest: reviewed})
  today.render(ui.app.state)
  assert.doesNotMatch(today.root.innerHTML, /Review request/)
  assert.equal(ui.app.derive.needsPerson(ui.app.state).length, 0)
  const history = renderers.todoListHtml(ui.app.state)
  assert.match(history, /Reviewed tour-change requests/)
  assert.match(history, /does not confirm rescheduling or contact/)
  assert.doesNotMatch(history, /<img src=x/)
})

test('tour-change render polling uses revised evidence and partial lead mutations preserve queue records', () => {
  const ui = portal(), request = tourChangeFixture()
  ui.app.apply('leads', {...ui.payload(), tourChangeRequests: [request]})
  const today = ui.context.window.testPortal.todayView
  today.root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], innerHTML: '' }
  today.render(ui.app.state)
  const updated = {...request, revision: 1, excerpts: ['Please cancel my tour instead.']}
  ui.app.apply('leads', {scope: ui.scope, tourChangeRequests: [updated]})
  today.render(ui.app.state)
  assert.match(today.root.innerHTML, /Please cancel my tour instead/)
  ui.app.apply('leads', {scope: ui.scope, unitFeedback: feedbackFixture()})
  assert.deepEqual(plain(ui.app.state.leads.tourChangeRequests), [updated])
  assert.equal(ui.app.state.leads.unitFeedback.length, 1)
})

test('review holds the exact revision and note after a lost response and confirms only server readback', async () => {
  const ui = portal(), request = tourChangeFixture(), form = tourReviewDialog(ui)
  ui.app.apply('leads', {...ui.payload(), tourChangeRequests: [request]})
  ui.app.reviewTourChange(request.id)
  form.note.value = 'Reviewed the request; caller verification still required.'
  ui.handler(() => { throw new TypeError('Lost connection') })
  await form.submit()
  const sent = JSON.parse(ui.requests.at(-1).body)
  assert.equal(sent.expectedRevision, 0)
  assert.equal(ui.requests.at(-1).headers['x-atrium-property-id'], 'chicago-one')
  assert.equal(form.closed(), false)
  assert.equal(form.note.disabled, true)
  assert.match(form.error(), /could not be confirmed/)
  assert.equal(form.messages.length, 0)
  form.note.value = 'Different note must not change a pending retry.'
  const saved = {...request, status: 'reviewed', revision: 1, review: { at: '2026-09-09T21:00:00Z', actorId: 'user-one', note: sent.note } }
  ui.respond({scope: ui.scope, tourChangeRequest: saved})
  await form.submit()
  assert.deepEqual(JSON.parse(ui.requests.at(-1).body), sent)
  assert.equal(form.closed(), true)
  assert.deepEqual(plain(ui.app.state.leads.tourChangeRequests), [saved])
  assert.match(form.messages[0], /No booking changed or notification sent/)
  assert.equal(ui.requests.some(r => r.path.startsWith('/api/calendar')), false)
})

test('reviewers cannot silently acknowledge newer evidence, and viewers never get review controls', async () => {
  const viewer = portal({property: {permissions: ['read']}}), request = tourChangeFixture()
  viewer.app.apply('leads', {...viewer.payload(), tourChangeRequests: [request]})
  viewer.app.dialog = () => assert.fail('viewer opened a write dialog')
  viewer.app.reviewTourChange(request.id)
  assert.doesNotMatch(viewer.app.html.tourChangeRequest(request), /data-action="review-tour-change"/)
  assert.match(viewer.app.html.tourChangeRequest(request), /Open calendar/)
  const ui = portal(), form = tourReviewDialog(ui)
  ui.app.apply('leads', {...ui.payload(), tourChangeRequests: [request]})
  ui.app.reviewTourChange(request.id)
  ui.respond({scope: ui.scope, code: 'tour_change_conflict', error: 'New evidence'}, 409)
  await form.submit()
  assert.match(form.error(), /cannot confirm your review/)
  assert.equal(form.primary().label, 'Close and refresh')
  assert.equal(ui.app.state.leads.tourChangeRequests[0].status, 'pending')
  assert.equal(form.messages.length, 0)
})

test('a legacy cookie switch retires the open review form and cannot submit to the new workspace', async () => {
  const ui = legacyPortal(), form = tourReviewDialog(ui), request = tourChangeFixture()
  ui.app.apply('leads', {profiles: [], followUps: [], tourChangeRequests: [request]})
  ui.app.reviewTourChange(request.id)
  ui.context.window.testPortal.markBooted()
  ui.context.window.ATRIUM_ACCOUNT.tenantId = 'tampered-new-account'
  ui.respond({code: 'portal_tenant_changed', error: 'The workspace changed.'}, 409)
  await form.submit()
  assert.equal(ui.requests[0].headers['x-atrium-tenant-id'], 'account-one')
  assert.equal(form.closed(), true)
  assert.equal(ui.app.state.leads, null)
  const n = ui.requests.length
  await form.submit()
  assert.equal(ui.requests.length, n)
  assert.equal(form.messages.length, 0)
})

test('mobile simultaneous tours use distinct agenda identities and reschedule the selected booking with spare capacity', () => {
  const ui = portal()
  ui.context.matchMedia = query => ({matches: query.includes('max-width')})
  runInNewContext(calendarSource.replace("A.register('calendar', view)",
    "window.testCalendar = { buildModel, agendaHtml, findItem, view, cal }; A.register('calendar', view)"), ui.context)
  const c = ui.context.window.testCalendar
  const slot = {slotId: 'slot-2032-06-01T15:00', startsAt: '2032-06-01T15:00:00Z', endsAt: '2032-06-01T15:45:00Z', date: '2032-06-01', status: 'open', capacity: 3}
  const bookings = ['first', 'second'].map((id, i) => ({externalId: id, slotId: slot.slotId, startsAt: slot.startsAt, endsAt: slot.endsAt,
    prospectName: `Prospect ${i + 1}`, prospectPhone: `+1312555010${i}`, unitId: `${i + 1}A`, revision: 0}))
  ui.app.state.calendar = {...slot, slots: [{...slot, bookings}], bookings, blocks: [], range: {from: '2032-06-01', to: '2032-06-01'}, settings: {capacity: 3}}
  const m = c.buildModel(ui.app.state, {date: '2032-06-01', view: 'day'})
  c.cal.model = m; c.cal.root = {contains: () => true, querySelector: () => null}
  const html = c.agendaHtml(m)
  const keys = [...html.matchAll(/data-action="agenda-tour"[^>]*data-key="([^"]+)"/g)].map(match => match[1])
  assert.equal(keys.length, 2)
  assert.equal(new Set(keys).size, 2)
  assert.ok(m.dayModels[0].items.some(item => item.kind === 'open'))
  const selected = [], titles = []
  let clicked
  ui.app.calendarActions = {openReschedule(booking) {selected.push(booking.externalId)}}
  ui.app.dialog = spec => {
    titles.push(spec.title)
    const body = {innerHTML: '', addEventListener(name, handler) { if (name === 'click') clicked = handler }}
    spec.build(body)
    return {close() {spec.onClose()}}
  }
  for (const key of keys) {
    const item = c.findItem(key)
    assert.equal(item.kind, 'tour')
    const button = {dataset: {action: 'agenda-tour', key}, getAttribute: () => null}
    c.view.onClick({target: {closest: () => button}})
    clicked({target: {closest: () => ({dataset: {pop: 'reschedule'}})}})
  }
  assert.deepEqual(selected, ['first', 'second'])
  assert.deepEqual(titles, ['Prospect 1', 'Prospect 2'])
})

test('shared dialogs restore idle labels after busy operations and retain explicit retry labels and disabled state', () => {
  const ui = portal(), nodes = new Map()
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, {textContent: '', hidden: false, attributes: new Map(), classList: {add() {}, remove() {}, toggle() {}},
      addEventListener() {}, focus() {}, querySelector: selector => node(selector), querySelectorAll: () => [],
      setAttribute(name, value) {this.attributes.set(name, value)}, removeAttribute(name) {this.attributes.delete(name)},
      getAttribute(name) {return this.attributes.get(name) ?? null}})
    return nodes.get(key)
  }
  ui.document.createElement = () => ({innerHTML: '', querySelector: selector => node(selector), addEventListener() {}, remove() {}})
  ui.document.body.appendChild = () => {}
  const dialog = ui.app.dialog({title: 'Availability', primary: {label: 'Block unit'}})
  const primary = node('.dlg-primary')
  dialog.setBusy('Reopening…'); assert.equal(primary.textContent, 'Reopening…')
  dialog.setBusy(null); assert.equal(primary.textContent, 'Block unit')
  dialog.setBusy('Saving…'); dialog.setPrimary({label: 'Retry review', disabled: true})
  dialog.setBusy(null)
  assert.equal(primary.textContent, 'Retry review')
  assert.equal(primary.getAttribute('aria-disabled'), 'true')
  dialog.setPrimary({disabled: false})
  assert.equal(primary.getAttribute('aria-disabled'), null)
})


function savedReschedulePayload(ui, input, slot) {
  return calendarPayload(ui, { bookings: [{...bookingFixture(), revision: input.expectedRevision + 1,
    slotId: input.slotId, startsAt: slot.startsAt, endsAt: slot.endsAt, unitId: input.unitId}],
    reschedule: {externalId: input.externalId, requestId: input.requestId, revision: input.expectedRevision + 1,
      status: 'complete', notificationSent: false} })
}
const unreadableSuccess = () => ({ok: true, status: 200, json: async () => {throw new SyntaxError('Unparseable acknowledgement')}})

test('unreadable or incomplete successful blackout replies freeze the exact payload and request key until a verified retry', async () => {
  for (const malformed of ['invalid-json', 'missing-calendar', 'wrong-unit']) {
    const ui = portal(), messages = []
    ui.app.apply('calendar', calendarPayload(ui))
    ui.app.toast = value => messages.push(value)
    const dialog = calendarActionsDialog(ui, { unitId: '4A', allDay: true, date: '2032-06-01', endDate: '2032-06-01', startTime: '09:00', endTime: '17:00', reason: 'Painting' })
    let posts = 0
    ui.handler((path, init) => {
      if (init.method !== 'POST') return response(calendarPayload(ui))
      const input = JSON.parse(init.body)
      const saved = {...input, id: 'unit-block-synthetic', revision: 0, startsAt: '2032-06-01T05:00:00Z', endsAt: '2032-06-02T05:00:00Z'}
      if (++posts === 1) {
        if (malformed === 'invalid-json') return unreadableSuccess()
        if (malformed === 'missing-calendar') return response({scope: ui.scope, timeZone: 'America/Chicago'})
        return response(calendarPayload(ui, {unitBlocks: [{...saved, unitId: '7B'}]}))
      }
      return response(calendarPayload(ui, {unitBlocks: [saved]}))
    })
    ui.app.calendarActions.openUnitBlocks({unitId: '4A', date: '2032-06-01'})
    await assert.rejects(dialog.submit(), /result could not be verified/)
    assert.equal(dialog.closed(), false)
    assert.ok(Object.values(dialog.fields).every(field => field.disabled))
    assert.equal(messages.length, 0)
    // Even programmatic changes cannot alter the uncertain operation's identity.
    dialog.fields.unitId.value = '7B'; dialog.fields.reason.value = 'Different request'
    await dialog.submit()
    const sent = ui.requests.filter(request => request.method === 'POST')
    assert.equal(sent.length, 2)
    assert.equal(sent[0].body, sent[1].body, malformed)
    assert.equal(ui.app.state.calendar.unitBlocks[0].unitId, '4A')
    assert.equal(dialog.closed(), true)
    assert.match(messages.at(-1), /Apartment 4A blocked/)
  }
})

test('unreadable or mismatched reschedule acknowledgements retain original unit, slot, revision and operation key', async () => {
  for (const malformed of ['invalid-json', 'missing-receipt', 'wrong-request', 'wrong-unit']) {
    const ui = portal(), messages = [], option = tourOption('replacement-slot')
    ui.app.apply('calendar', calendarPayload(ui, {bookings: [bookingFixture()]}))
    ui.app.toast = value => messages.push(value)
    const dialog = calendarActionsDialog(ui, {unitId: '4A', date: '2032-06-02', slotId: ''})
    let posts = 0
    ui.handler((path, init) => {
      if (init.method !== 'POST') return response({...calendarPayload(ui), reschedule: {booking: {revision: 3}, slots: [option]}})
      const input = JSON.parse(init.body), saved = savedReschedulePayload(ui, input, option)
      if (++posts === 1) {
        if (malformed === 'invalid-json') return unreadableSuccess()
        if (malformed === 'missing-receipt') delete saved.reschedule
        if (malformed === 'wrong-request') saved.reschedule.requestId = 'another-operation'
        if (malformed === 'wrong-unit') saved.bookings[0].unitId = '7B'
      }
      return response(saved)
    })
    ui.app.calendarActions.openReschedule(bookingFixture())
    await flushTasks(); dialog.fields.slotId.value = option.slotId
    await assert.rejects(dialog.submit(), /result could not be fully verified/)
    assert.ok(Object.values(dialog.fields).every(field => field.disabled))
    assert.equal(dialog.closed(), false); assert.equal(messages.length, 0)
    dialog.fields.unitId.value = '7B'; dialog.fields.date.value = '2032-06-03'; dialog.fields.slotId.value = 'changed-slot'
    await dialog.submit()
    const sent = ui.requests.filter(request => request.method === 'POST')
    assert.equal(sent[0].body, sent[1].body, malformed)
    assert.equal(ui.app.state.calendar.bookings[0].unitId, '4A')
    assert.equal(ui.app.state.calendar.bookings[0].slotId, option.slotId)
    assert.equal(dialog.closed(), true)
    assert.match(messages.at(-1), /Tour moved/)
  }
})

test('unreadable HTTP 200 review acknowledgement retains the same note and revision on retry', async () => {
  const ui = portal(), request = tourChangeFixture(), form = tourReviewDialog(ui)
  ui.app.apply('leads', {...ui.payload(), tourChangeRequests: [request]})
  ui.app.reviewTourChange(request.id); form.note.value = 'Original review note'
  ui.handler(unreadableSuccess)
  await form.submit()
  assert.equal(form.closed(), false); assert.equal(form.note.disabled, true)
  assert.match(form.error(), /could not be confirmed/); assert.equal(form.messages.length, 0)
  const original = JSON.parse(ui.requests[0].body)
  form.note.value = 'Must not replace the uncertain review'
  const saved = {...request, revision: 1, status: 'reviewed', review: {at: '2032-06-01T12:00:00Z', actorId: 'user-one', note: original.note}}
  ui.respond({scope: ui.scope, tourChangeRequest: saved})
  await form.submit()
  assert.deepEqual(JSON.parse(ui.requests[1].body), original)
  assert.equal(form.closed(), true)
  assert.match(form.messages[0], /Review recorded/)
})
