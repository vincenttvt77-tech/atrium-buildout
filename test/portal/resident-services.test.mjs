import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const app = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const source = await readFile(new URL('../../ops/src/services.js', import.meta.url), 'utf8')
const html = await readFile(new URL('../../ops/src/index.html', import.meta.url), 'utf8')
const css = await readFile(new URL('../../ops/src/services.css', import.meta.url), 'utf8')
const plain = v => JSON.parse(JSON.stringify(v)), settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const result = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const instant = '2026-09-01T14:00:00.000Z'
const resident = (overrides = {}) => ({ id: 'resident-one', personId: 'person-one', organizationId: 'organization-one', propertyId: 'building-one', unitId: '13L', displayName: 'Alex Example', relationship: 'occupant', startsOn: '2026-01-01', endsOn: null, phone: null, email: null, source: { kind: 'staff_review', reference: 'Synthetic occupancy list', version: 'v1', observedAt: instant, validUntil: '2026-11-01T15:00:00.000Z' }, status: 'active', version: 2, createdAt: instant, updatedAt: instant, reviewedBy: 'staff-one', reviewedAt: instant, contextState: 'current', ...overrides })
const request = (overrides = {}) => ({ id: 'case-one', organizationId: 'organization-one', propertyId: 'building-one', version: 2, location: { kind: 'unit', unitId: '13L' }, intakeLocation: { kind: 'unit', unitId: '13L' }, residentIdAtIntake: 'resident-one', residentId: 'resident-one', requestOrigin: 'resident_report', contextNeedsReview: false, summary: 'Kitchen tap leaking', description: 'Drips after closing the tap.', category: 'plumbing', reportedPriority: 'routine', reporterName: null, reporterPhone: null, reporterEmail: null, accessNotes: 'Reported availability only', state: 'needs_triage', priority: 'routine', emergencyKinds: [], createdAt: instant, updatedAt: instant, createdBy: 'staff-one', residentVersionAtIntake: 2, residentNameAtIntake: 'Alex Example', dispatchStatus: 'not_dispatched', notificationStatus: 'not_sent', callerIdentityVerified: false, entryAuthorized: false, ...overrides })
const event = (overrides = {}) => ({ id: 'event-one', caseId: 'case-one', caseVersion: 1, kind: 'intake', contextLocation: { kind: 'unit', unitId: '13L' }, contextResidentId: 'resident-one', contextResidentVersion: 2, contextResidentName: 'Alex Example', actorUserId: 'staff-one', createdAt: instant, note: 'Report recorded.', state: 'needs_triage', priority: 'routine', ...overrides })
const detail = (r = request(), overrides = {}) => ({ request: r, resident: { state: r.residentId ? 'current' : 'not_established', residentId: r.residentId, residentVersion: r.residentId ? 2 : null, displayName: r.residentId ? 'Alex Example' : null, unitId: r.residentId ? '13L' : null, callerIdentityVerified: false, entryAuthorized: false }, events: [event({ caseId: r.id })], eventsTruncated: false, nextEventsCursor: null, related: [], relatedTruncated: false, ...overrides })
function portal({ legacy = false, permissions = ['read', 'operate', 'configure'], mobile = false, reduced = false } = {}) {
  const scope = { organizationId: 'organization-one', propertyId: 'building-one', configurationVersion: 3, permissionVersion: 'permission-three' }
  const window = { ATRIUM_RUNTIME_MODE: legacy ? 'legacy' : 'postgres', ATRIUM_ACCOUNT: { username: 'operator', tenantId: 'larkin' }, ATRIUM_PROPERTY: { ...scope, buildingName: 'Lake House', timeZone: 'America/Chicago', permissions, hours: {} }, handlers: new Map(), addEventListener(name, fn) { this.handlers.set(name, fn) } }
  const nodes = new Map(), timers = new Map(), requests = [], dialogs = [], toasts = []
  let timerId = 0, uuid = 0, reloads = 0, handler = defaultHandler
  const document = { readyState: 'loading', activeElement: null, addEventListener() {}, getElementById() { return null }, querySelector() { return null }, querySelectorAll: key => key === '.view' ? [root] : [], body: { classList: { toggle() {}, add() {}, remove() {} } } }
  function node() {
    let content = '', children = []
    const n = { dataset: {}, attributes: {}, value: '', hidden: false, disabled: false, isConnected: true, scrollTop: 0, scrollLeft: 0, writes: 0, handlers: new Map(), classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { n.attributes[k] = v }, getAttribute(k) { return n.attributes[k] }, removeAttribute(k) { delete n.attributes[k] },
      addEventListener(k, fn) { n.handlers.set(k, fn) }, focus() { document.activeElement = n }, scrollIntoView(o) { n.scrolled = o },
      contains(target) { return target === n || children.includes(target) },
      matches(selector) { return selector.startsWith('#') ? n.id === selector.slice(1) : selector.startsWith('.') ? (n.attributes.class || '').split(' ').includes(selector.slice(1)) : selector.startsWith('[data-') ? n.dataset[selector.slice(6, -1)] !== undefined : false },
      querySelectorAll(selector) { return children.filter(child => selector.split(',').some(sel => { const s = sel.trim(), match = /^\[data-([\w-]+)(?:="([^"]+)")?\]$/.exec(s); return match ? child.dataset[match[1]] !== undefined && (match[2] === undefined || child.dataset[match[1]] === match[2]) : child.matches(s) })) },
      querySelector(selector) { return n.querySelectorAll(selector)[0] || null },
      get childNodes() { return children }, replaceChildren(...next) { children = next; if (!next.length) content = '' },
      get innerHTML() { return content }, set innerHTML(value) {
        content = value; n.writes++; for (const child of children) child.isConnected = false
        children = [...value.matchAll(/<(button|h2|h3|summary|input|select|textarea|div|p)\b([^>]*)>/g)].map(match => {
          const [, tag, attrs] = match, child = node(); child.tagName = tag.toUpperCase()
          for (const [, key, val] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) { child.attributes[key] = val; if (key.startsWith('data-')) child.dataset[key.slice(5)] = val; if (key === 'id') child.id = val; if (key === 'value') child.value = val }
          child.disabled = /\sdisabled(?:\s|$)/.test(attrs); child.hidden = /\shidden(?:\s|$)/.test(attrs)
          child.closest = selector => selector === 'button' && tag === 'button' ? child : null
          if (tag === 'select') {
            const body = value.slice(match.index + match[0].length).split('</select>')[0], options = [...body.matchAll(/<option\b([^>]*)>/g)]
            const selected = options.find(o => /\sselected(?:\s|$)/.test(o[1])) || options[0]; child.value = selected ? /value="([^"]*)"/.exec(selected[1])?.[1] || '' : ''
          }
          if (tag === 'textarea') child.value = value.slice(match.index + match[0].length).split('</textarea>')[0]
          return child
        })
      },
    }; return n
  }
  const root = node(), query = root.querySelector, all = root.querySelectorAll
  root.querySelector = selector => {
    if (['.sv-errors', '.sv-results', '.sv-detail', '.sv-filters', '.sv-loaded', '.sv-unit-filter'].includes(selector)) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector) }
    return query(selector) || [...nodes.values()].map(n => n.querySelector(selector)).find(Boolean) || null
  }
  root.querySelectorAll = selector => [...all(selector), ...[...nodes.values()].flatMap(n => n.querySelectorAll(selector))]
  root.contains = target => target === root || root.childNodes.includes(target) || [...nodes.values()].some(n => n.contains(target))
  const location = { hash: '#/services', reload() { reloads++ } }
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-13T01:00:00.000Z'])) } static now() { return Date.parse('2026-09-13T01:00:00.000Z') } }
  const context = { window, document, location, Intl, Date: FixedDate, URLSearchParams, structuredClone, console, crypto: { randomUUID() { return '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') } }, matchMedia: q => ({ matches: q.includes('reduced-motion') ? reduced : mobile }), setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id }, clearTimeout(id) { timers.delete(id) }, setInterval() {}, clearInterval() {}, fetch: async (path, init) => { requests.push({ path, ...init }); return handler(path, init) } }
  runInNewContext(app.replace('window.Atrium = {', 'window.serviceAppTest = { emit, markBooted() { booted = true }, accessIssue: () => documentAccessIssue }; window.Atrium = {'), context)
  const A = window.Atrium; A.toast = (message, options) => { const record = { message, options, closed: false, close() { record.closed = true } }; toasts.push(record); return record };  A.announce = () => {}; A.paintPermissions = () => {}
  A.dialog = options => {
    const body = node(), dialog = { body, options, error: null, primary: { ...options.primary }, closed: false, setError(v) { dialog.error = v }, setPrimary(v) { Object.assign(dialog.primary, v) }, setBusy(v) { dialog.busy = v }, close() { if (!dialog.closed) { dialog.closed = true; options.onClose?.() } }, click() { return options.primary.onClick(dialog) } }
    options.build(body, dialog); dialogs.push(dialog); return dialog
  }
  runInNewContext(source.replace("A.register('services', view)", "window.serviceTest = { view, load, select, loadEvents, readSummary, readResident, readDetail, readReceipt, sourceInstant, readIntake, immediateSafety, openForm, paint, state: () => ({tab,filter,items,cursor,selected,loaded,loading,detail,detailLoading,error,pending,busy,overview}) }; A.register('services', view)"), context)
  const helpers = window.serviceTest
  A.navigate = (name, params = {}) => { location.hash = A.hashFor(name, params); if (name === 'services') helpers?.view.render(); window.serviceAppTest.emit('route', A.route()) }
  function body(value) { return { scope, ...value } }
  function defaultHandler(path, init) {
    const query = new URL(path, 'https://example.test').searchParams
    if (init?.method === 'POST') { const command = JSON.parse(init.body); return result(body({ receipt: receipt(command) })) }
    switch (query.get('resource')) {
      case 'overview': return result(body({ canManageResidents: permissions.includes('configure'), units: [{ id: '13L', label: '13L' }, { id: '20A', label: '20A' }], timeZone: 'America/Chicago', formToken: 'fixed-synthetic-form' }))
      case 'requests': return result(body({ requests: [request()], nextCursor: null }))
      case 'residents': return result(body({ residents: [resident()], nextCursor: null }))
      case 'resident': return result(body({ resident: resident({ id: query.get('id') }) }))
      case 'request': return result(body({ detail: detail(request({ id: query.get('id') })), safetyInstructions: [], safetyCallEmergencyServices: false }))
      case 'events': return result(body({ events: [], nextCursor: null }))
    }
  }
  const receipt = command => ({ action: command.action, requestId: command.requestId, resource: command.action.includes('resident') ? 'resident' : 'request', id: command.id || (command.action.includes('resident') ? 'resident-new' : 'case-new'), version: command.expectedVersion ? command.expectedVersion + 1 : 1, committedAt: instant, replayed: false })
  return { A, helpers, root, nodes, document, window, context, location, requests, dialogs, toasts, scope, body, receipt, defaultHandler, node,
    setHandler(fn) { handler = fn }, async mount() { helpers?.view.mount(root); helpers?.view.render(); await settle() },
    async expire() { for (const [id,t] of timers) if (t.delay === 15000) { timers.delete(id); t.fn() }; await settle() },
    text() { return [...nodes.values()].map(n => n.innerHTML).join('') }, markBooted() { window.serviceAppTest.markBooted() }, reloads: () => reloads,
    click(selector) { const button = root.querySelector(selector); assert.ok(button, selector); root.handlers.get('click')({ target: button }); return button },
  }
}
const fill = (dialog, values) => { for (const [key,value] of Object.entries(values)) { const node = dialog.body.querySelector('#sv-' + key); assert.ok(node, key); node.value = value } }

test('Service is PostgreSQL operate-only and cannot register or fetch for viewer or legacy', async () => {
  for (const opts of [{ legacy: true }, { permissions: ['read'] }]) { const ui = portal(opts); await ui.mount(); assert.equal(ui.helpers, undefined); assert.equal(ui.A.route().name, 'today'); assert.equal(ui.requests.length, 0) }
  assert.match(html, /data-service-only hidden><a[^>]*href="#\/services"/)
  const ui = portal(); await ui.mount(); assert.equal(ui.A.route().name, 'services'); assert.equal(ui.helpers.state().loaded, true); assert.equal(ui.A.state.loaded.calls, false)
  const count = ui.requests.length; ui.window.serviceAppTest.emit('data', ui.A.state, new Set(['leads'])); assert.equal(ui.requests.length, count)
})
test('immutable scope headers, action token and configure guard reach the actual API helper', async () => {
  const ui = portal(); ui.window.ATRIUM_PROPERTY.propertyId = 'tampered'; await ui.mount()
  assert.equal(ui.requests[0].headers['x-atrium-property-id'], 'building-one'); assert.equal(ui.requests[0].headers['x-atrium-config-version'], '3')
  await ui.A.api.post('/api/resident-services', { action: 'add_note' }, { formToken: 'bound-token' })
  assert.equal(ui.requests.at(-1).headers['x-atrium-service-form'], 'bound-token'); assert.equal(ui.requests.at(-1).headers['x-atrium-service-action'], 'add_note')
  const staff = portal({ permissions: ['read', 'operate'] }); await staff.mount(); await assert.rejects(staff.A.api.post('/api/resident-services', { action: 'add_resident' }), e => e.status === 403)
  staff.A.navigate('services', { tab: 'residents' }); await settle(); assert.equal(staff.root.querySelector('[data-command="add"]').hidden, true)
})
test('current source context is separate from identity, entry and fulfillment; all content is escaped', async () => {
  const ui = portal(); ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(request({ summary: '<img src=x>', description: '<script>bad</script>' })), safetyInstructions: [], safetyCallEmergencyServices: false })) : ui.defaultHandler(path, init))
  await ui.mount(); assert.match(ui.text(), /Source review current/); assert.match(ui.text(), /Caller identity not verified/); assert.match(ui.text(), /No entry permission/); assert.match(ui.text(), /Not dispatched/); assert.match(ui.text(), /No notification sent/)
  assert.match(ui.text(), /&lt;script&gt;bad/); assert.doesNotMatch(ui.text(), /<script>bad/)
  assert.throws(() => ui.helpers.readDetail(detail(request({ entryAuthorized: true })), 'case-one'), /unreadable/)
  assert.throws(() => ui.helpers.readResident(resident({ propertyId: 'foreign' })), /unreadable/)
  assert.throws(() => ui.helpers.readSummary({ ...request(), residentId: undefined }), /unreadable/)
})
test('expired or revoked source does not make previously triaged planning currently ready', async () => {
  const ui = portal(); ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(request({ state: 'ready_for_planning' }), { resident: { state: 'expired', residentId: 'resident-one', residentVersion: 3, displayName: 'Alex Example', unitId: '13L', callerIdentityVerified: false, entryAuthorized: false } }), safetyInstructions: [] })) : ui.defaultHandler(path, init))
  await ui.mount(); assert.match(ui.text(), /Triaged for planning/); assert.match(ui.text(), /Review current request context before planning/); assert.match(ui.text(), /current unit or occupancy context needs review/)
})
test('source datetime conversion uses the property zone and rejects ambiguous/nonexistent DST times', async () => {
  const ui = portal(); await ui.mount()
  assert.equal(ui.helpers.sourceInstant('2026-09-01T09:00'), '2026-09-01T14:00:00.000Z')
  assert.throws(() => ui.helpers.sourceInstant('2026-03-08T02:30'), /clock change/)
  assert.throws(() => ui.helpers.sourceInstant('2026-11-01T01:30'), /clock change/)
})
test('initial pending, failed load and empty successful results remain distinct', async () => {
  const ui = portal(); let finish; ui.setHandler(() => new Promise(resolve => { finish = resolve })); await ui.mount(); assert.match(ui.text(), /Loading saved records/); assert.doesNotMatch(ui.text(), /No requests in/)
  finish(result({}, 503)); await settle(); assert.match(ui.text(), /could not be loaded/); assert.equal(ui.helpers.state().loaded, false)
  ui.setHandler((path, init) => path.includes('resource=requests') ? result(ui.body({ requests: [], nextCursor: null })) : ui.defaultHandler(path, init)); await ui.helpers.load(); assert.match(ui.text(), /No requests in this result/)
})
test('explicit selection leaves list DOM and scroll stable; mobile detail focuses after its response', async () => {
  const ui = portal({ mobile: true, reduced: true }); await ui.mount(); const list = ui.nodes.get('.sv-results'); list.scrollTop = 331; const writes = list.writes
  await ui.helpers.select('case-one'); assert.equal(list.writes, writes); assert.equal(list.scrollTop, 331); assert.equal(ui.document.activeElement.dataset.key, 'service-detail-heading'); assert.equal(ui.document.activeElement.scrolled.behavior, 'auto')
  ui.helpers.view.render(); assert.equal(list.scrollTop, 331); assert.match(css, /min-height:48px/); assert.match(css, /prefers-reduced-motion/)
})
test('older selected detail and route-abandoned requests cannot revive stale data', async () => {
  const ui = portal(); await ui.mount(); let old; ui.setHandler(() => new Promise(resolve => { old = resolve })); const first = ui.helpers.select('old-case')
  ui.setHandler(ui.defaultHandler); await ui.helpers.select('case-two'); old(result(ui.body({ detail: detail(request({ id: 'old-case' })), safetyInstructions: [] }))); await first
  assert.equal(ui.helpers.state().detail.request.id, 'case-two')
  let late; ui.setHandler(() => new Promise(resolve => { late = resolve })); const second = ui.helpers.select('late-case'); ui.A.navigate('today'); late(result(ui.body({ detail: detail(request({ id: 'late-case' })), safetyInstructions: [] }))); await second
  assert.notEqual(ui.helpers.state().detail?.request.id, 'late-case')
})
test('keyset paging keeps cursor precision, list scroll and final keyboard focus', async () => {
  const ui = portal(), first = request({ createdAt: '2026-09-01T14:00:00.123456Z' })
  ui.setHandler((path, init) => path.includes('resource=requests') ? result(ui.body({ requests: [first], nextCursor: { id: first.id, createdAt: first.createdAt } })) : ui.defaultHandler(path, init)); await ui.mount()
  const list = ui.nodes.get('.sv-results'); list.scrollTop = 123; ui.root.querySelector('[data-command="more"]').focus()
  ui.setHandler((path, init) => path.includes('resource=requests') ? result(ui.body({ requests: [request({ id: 'case-two' })], nextCursor: null })) : ui.defaultHandler(path, init)); await ui.helpers.load(true)
  assert.equal(ui.helpers.state().items.length, 2); assert.equal(list.scrollTop, 123); assert.equal(ui.document.activeElement.dataset.select, 'case-two')
  assert.ok(ui.requests.some(r => r.path.includes('beforeCreatedAt=2026-09-01T14%3A00%3A00.123456Z')))
})
test('unknown and common-area requests save without inventing resident identity or matching phones', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('create_request'); const dialog = ui.dialogs.at(-1)
  fill(dialog, { location: 'common_area', 'location-label': 'Lobby', origin: 'staff_observation', summary: 'Tile is cracked', 'reporter-phone': '+12125550111' }); await dialog.click()
  assert.match(dialog.body.innerHTML, /REVIEW BEFORE SAVING/); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 0)
  await dialog.click(); const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body)
  assert.equal(command.intake.residentId, null); assert.equal(command.intake.requestOrigin, 'staff_observation'); assert.equal(command.intake.reporterPhone, '+12125550111'); assert.equal(command.intake.location.kind, 'common_area')
  assert.match(ui.toasts[0].message, /Change recorded/)
})
test('emergency warning appears while typing, before any save, and saved emergency cannot ordinary-triage', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('create_request'); const dialog = ui.dialogs.at(-1); fill(dialog, { summary: 'I smell gas' }); ui.helpers.immediateSafety(dialog.body)
  const warning = dialog.body.querySelector('.sv-immediate-safety'); assert.equal(warning.hidden, false); assert.match(warning.innerHTML, /does not contact/); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 0); dialog.close()
  ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(request({ priority: 'emergency', state: 'emergency_review', emergencyKinds: ['gas'] })), safetyInstructions: ['Approved synthetic safety guidance.'], safetyCallEmergencyServices: true })) : ui.defaultHandler(path, init)); await ui.helpers.select('case-one')
  assert.match(ui.text(), /Approved synthetic safety guidance/); assert.doesNotMatch(ui.text(), /data-command="triage"/); ui.helpers.openForm('triage_request'); assert.equal(ui.dialogs.length, 1)
})
test('note is reviewed then saved with original version, request identity and frozen form token', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Resident described a slow drip.' }); await dialog.click(); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 0)
  await dialog.click(); const sent = ui.requests.find(r => r.method === 'POST'), command = JSON.parse(sent.body)
  assert.equal(command.id, 'case-one'); assert.equal(command.expectedVersion, 2); assert.equal(command.note, 'Resident described a slow drip.'); assert.equal(sent.headers['x-atrium-service-form'], 'fixed-synthetic-form'); assert.equal(sent.headers['x-atrium-service-action'], 'add_note')
  await settle(); ui.helpers.openForm('add_note'); assert.equal(ui.toasts[0].closed, true, 'The prior saved toast must not cover the next form')
})
test('lost acknowledgement freezes exact command and suppresses parallel click/new mutation', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Request follow-up recorded.' }); await dialog.click()
  let finish; ui.setHandler((path, init) => init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : ui.defaultHandler(path, init)); const sending = dialog.click(); await dialog.click(); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 1)
  finish({ ok: true, status: 200, json: async () => { throw new Error('truncated') } }); await sending
  assert.match(dialog.error, /may have been recorded/); assert.equal(ui.toasts.length, 0); const original = ui.requests.find(r => r.method === 'POST'); assert.ok(ui.helpers.state().pending)
  dialog.close(); ui.helpers.openForm('create_request'); assert.equal(ui.dialogs.length, 1)
  ui.helpers.openForm('add_note', ui.helpers.state().pending); const retry = ui.dialogs.at(-1); ui.setHandler(ui.defaultHandler); await retry.click()
  const posts = ui.requests.filter(r => r.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[1].body, original.body); assert.equal(posts[1].headers['x-atrium-service-form'], original.headers['x-atrium-service-form'])
})
test('wrong action, entity, version and request receipts remain uncertain rather than confirmed', async () => {
  for (const change of [r => { r.action = 'triage_request' }, r => { r.id = 'other-case' }, r => { r.version = 5 }, r => { r.requestId = 'different' }]) {
    const ui = portal(); await ui.mount(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Synthetic staff note.' }); await dialog.click()
    ui.setHandler((path, init) => { if (init?.method !== 'POST') return ui.defaultHandler(path, init); const receipt = ui.receipt(JSON.parse(init.body)); change(receipt); return result(ui.body({ receipt })) }); await dialog.click()
    assert.ok(ui.helpers.state().pending); assert.equal(ui.toasts.length, 0); assert.match(dialog.error, /unconfirmed/)
  }
})
test('post-commit access/config refusal retires page with honest uncertainty, never a fresh ID', async () => {
  for (const status of [403, 409]) {
    const ui = portal(); await ui.mount(); ui.markBooted(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Synthetic staff note.' }); await dialog.click()
    ui.setHandler(() => result({ code: status === 403 ? 'forbidden' : 'property_configuration_changed', error: 'Refused' }, status)); await dialog.click()
    assert.equal(ui.A.can('operate'), false); assert.match(ui.window.serviceAppTest.accessIssue().message, /save is unconfirmed and may have been recorded/); assert.equal(ui.toasts.length, 0); assert.ok(ui.helpers.state().pending)
  }
})
test('unresolved writes time out without claiming cancelled or automatically retrying', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Synthetic staff note.' }); await dialog.click(); ui.setHandler(() => new Promise(() => {})); const writing = dialog.click(); await ui.expire(); await writing
  assert.match(dialog.error, /unconfirmed/); assert.equal(ui.helpers.state().busy, false); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 1); assert.equal(ui.toasts.length, 0)
})
test('known first-attempt version conflict requires a fresh review without claiming saved', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Synthetic staff note.' }); await dialog.click(); ui.setHandler(() => result({ code: 'service_version_conflict', error: 'Changed' }, 409)); await dialog.click()
  assert.match(dialog.error, /record changed/); assert.equal(ui.helpers.state().pending, null); assert.equal(ui.toasts.length, 0); assert.equal(dialog.primary.label, 'Close and refresh'); await dialog.click(); assert.equal(dialog.closed, true)
})
test('resident revoke preserves immutable record identity and requires configure permission', async () => {
  const ui = portal(); await ui.mount(); ui.A.navigate('services', { tab: 'residents' }); await settle(); ui.helpers.openForm('revoke_resident'); const dialog = ui.dialogs.at(-1); fill(dialog, { reason: 'New source confirms occupancy ended.' }); await dialog.click(); await dialog.click()
  const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body); assert.equal(command.action, 'revoke_resident'); assert.equal(command.id, 'resident-one'); assert.equal(command.expectedVersion, 2); assert.equal(command.details, undefined)
})
test('add resident requires actual reviewed source dates and saves a complete property-scoped record', async () => {
  const ui = portal(); await ui.mount(); ui.A.navigate('services', { tab: 'residents' }); await settle(); ui.helpers.openForm('add_resident'); const dialog = ui.dialogs.at(-1)
  fill(dialog, { unit: '20A', name: 'Taylor Sample', relationship: 'leaseholder', starts: '2026-08-01', reference: 'Manager reviewed lease record', 'source-version': 'lease-2', observed: '2026-09-01T09:00', 'valid-until': '2026-11-01T09:00', reason: 'Reviewed authorized occupancy source.' }); await dialog.click()
  assert.match(dialog.body.innerHTML, /REVIEW BEFORE SAVING/); assert.match(dialog.body.innerHTML, /does not verify a caller/); await dialog.click()
  const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body)
  assert.equal(command.details.unitId, '20A'); assert.equal(command.details.source.kind, 'staff_review'); assert.equal(command.details.source.observedAt, '2026-09-01T14:00:00.000Z'); assert.equal(command.details.source.validUntil, '2026-11-01T15:00:00.000Z'); assert.equal(command.details.phone, null); assert.equal(command.details.email, null); assert.equal(command.details.endsOn, null)
})
test('source review preserves immutable ownership and original timestamp precision when unchanged', async () => {
  const ui = portal(), record = resident({ source: { ...resident().source, observedAt: '2026-09-01T14:00:21.123Z', validUntil: '2026-11-01T15:00:41.456Z' } })
  ui.setHandler((path, init) => path.includes('resource=resident&') ? result(ui.body({ resident: record })) : ui.defaultHandler(path, init)); await ui.mount(); ui.A.navigate('services', { tab: 'residents' }); await settle(); ui.helpers.openForm('review_resident'); const dialog = ui.dialogs.at(-1); fill(dialog, { reason: 'Source checked again, contact corrected.', phone: '+12125550199' }); await dialog.click(); await dialog.click()
  const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body); assert.equal(command.id, record.id); assert.equal(command.details.unitId, undefined); assert.equal(command.details.personId, undefined); assert.equal(command.details.source.observedAt, record.source.observedAt); assert.equal(command.details.source.validUntil, record.source.validUntil)
})
test('expired or future source and overlong review windows stay in the unsaved form', async () => {
  for (const dates of [{ observed: '2025-09-01T09:00', 'valid-until': '2025-10-01T09:00' }, { observed: '2032-09-01T09:00', 'valid-until': '2032-10-01T09:00' }, { observed: '2026-09-01T09:00', 'valid-until': '2027-02-01T09:00' }]) {
    const ui = portal(); await ui.mount(); ui.A.navigate('services', { tab: 'residents' }); await settle(); ui.helpers.openForm('add_resident'); const dialog = ui.dialogs.at(-1)
    fill(dialog, { unit: '13L', name: 'Alex Example', starts: '2026-01-01', reference: 'Reviewed source', 'source-version': '1', reason: 'Reviewed occupancy record.', ...dates }); await dialog.click()
    assert.match(dialog.error, /source review dates/); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 0)
  }
})
test('planning cases with newly stale context appear as attention without rewriting their triage history', async () => {
  const ui = portal(), row = request({ state: 'ready_for_planning', contextNeedsReview: true })
  ui.setHandler((path, init) => path.includes('resource=requests') ? result(ui.body({ requests: [row], nextCursor: null })) : ui.defaultHandler(path, init)); await ui.mount()
  assert.equal(ui.helpers.state().items[0].state, 'ready_for_planning'); assert.match(ui.nodes.get('.sv-results').innerHTML, /Context needs review/); assert.equal(ui.helpers.state().filter, 'attention')
  assert.throws(() => ui.helpers.readSummary({ ...row, contextNeedsReview: undefined }), /unreadable/)
})
test('unknown location remains a saveable unlinked report and does not invent an apartment', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('create_request'); const dialog = ui.dialogs.at(-1); fill(dialog, { location: 'unknown', summary: 'Resident reported a leak', origin: 'unknown' }); await dialog.click(); await dialog.click()
  const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body); assert.deepEqual(command.intake.location, { kind: 'unknown', label: 'Location not established' }); assert.equal(command.intake.residentId, null); assert.equal(command.intake.reporterPhone, null)
})
test('26-entry history opens its first 25 and pages the final event without losing keyboard focus', async () => {
  const ui = portal(), rows = Array.from({ length: 25 }, (_, index) => event({ id: 'event-' + String(26 - index).padStart(2, '0'), caseVersion: 26 - index }))
  ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(request({ version: 26 }), { events: rows, eventsTruncated: true, nextEventsCursor: { id: rows.at(-1).id, createdAt: instant } }), safetyInstructions: [] }))
    : path.includes('resource=events') ? result(ui.body({ events: [event({ id: 'event-01' })], nextCursor: null })) : ui.defaultHandler(path, init))
  await ui.mount(); assert.equal(ui.helpers.state().detail.events.length, 25); ui.root.querySelector('[data-command="events"]').focus(); await ui.helpers.loadEvents()
  assert.equal(ui.helpers.state().detail.events.length, 26); assert.equal(ui.helpers.state().detail.nextEventsCursor, null); assert.equal(ui.document.activeElement.dataset.key, 'service-detail-heading')
})
test('uncertain triage recovery uses its frozen review after switching to the resident tab', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.openForm('triage_request'); const first = ui.dialogs.at(-1); fill(first, { note: 'Review access context before planning.', state: 'management_review', priority: 'urgent' }); await first.click()
  ui.setHandler((path, init) => init?.method === 'POST' ? result({}, 503) : ui.defaultHandler(path, init)); await first.click(); const frozen = plain(ui.helpers.state().pending); first.close()
  ui.A.navigate('services', { tab: 'residents' }); await settle(); ui.helpers.openForm('triage_request', ui.helpers.state().pending); const retry = ui.dialogs.at(-1)
  assert.equal(retry.body.innerHTML, frozen.html); ui.setHandler(ui.defaultHandler); await retry.click()
  const posts = ui.requests.filter(r => r.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body); assert.equal(posts[0].headers['x-atrium-service-form'], posts[1].headers['x-atrium-service-form'])
})
test('postcommit 401 leaves an explicit reconciliation warning until deliberate sign-in navigation', async () => {
  const ui = portal(); await ui.mount(); ui.markBooted(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'This may commit before the session expires.' }); await dialog.click()
  ui.setHandler(() => result({ code: 'unauthenticated', error: 'Expired' }, 401)); await dialog.click()
  assert.equal(ui.reloads(), 0); assert.equal(ui.A.can('operate'), false); assert.match(ui.window.serviceAppTest.accessIssue().message, /After sign-in, check the current record/); assert.ok(ui.helpers.state().pending); assert.equal(ui.toasts.length, 0)
  ui.window.handlers.get('pagehide')(); assert.equal(ui.helpers.state().pending, null); assert.equal(ui.helpers.state().detail, null); assert.equal(ui.root.innerHTML, '')
  ui.window.handlers.get('pageshow')({ persisted: true }); assert.equal(ui.reloads(), 1)
  assert.equal(ui.requests.filter(r => r.method === 'POST').length, 1, 'No command crosses sign-in or automatically repeats')
})
test('an authentication poll cannot erase reconciliation warning during or after a Service write', async () => {
  const ui = portal(); await ui.mount(); ui.markBooted(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Save pending while a polling session expires.' }); await dialog.click()
  let finish; ui.setHandler((path, init) => init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : result({ code: 'unauthenticated' }, 401)); const saving = dialog.click()
  await assert.rejects(ui.A.api.get('/api/leads'), e => e.status === 401)
  assert.equal(ui.reloads(), 0); assert.match(ui.window.serviceAppTest.accessIssue().message, /service save is unconfirmed/)
  finish(result({ code: 'unauthenticated' }, 401)); await saving; await assert.rejects(ui.A.api.get('/api/properties'), e => e.status === 401)
  assert.equal(ui.reloads(), 0); assert.ok(ui.helpers.state().pending); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 1)
})
test('a nonproperty authentication response first still retires protected data during a pending Service save', async () => {
  const ui = portal(); await ui.mount(); ui.markBooted(); ui.helpers.openForm('add_note'); const dialog = ui.dialogs.at(-1); fill(dialog, { note: 'Another request may discover the expired session first.' }); await dialog.click()
  let finish; ui.setHandler((path, init) => init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : result({ code: 'unauthenticated' }, 401)); const writing = dialog.click()
  await assert.rejects(ui.A.api.get('/api/properties'), e => e.status === 401); assert.equal(ui.reloads(), 0); assert.equal(ui.A.can('operate'), false); assert.match(ui.window.serviceAppTest.accessIssue().message, /service save is unconfirmed/)
  finish(result({ code: 'unauthenticated' }, 401)); await writing; assert.ok(ui.helpers.state().pending)
})
test('staff can clarify unknown intake to an explicitly selected unit/source while original intake stays visible', async () => {
  const ui = portal(), original = request({ location: { kind: 'unknown', label: 'Not established' }, intakeLocation: { kind: 'unknown', label: 'Not established' }, residentId: null, residentIdAtIntake: null, residentNameAtIntake: null, residentVersionAtIntake: null })
  let saved = false
  ui.setHandler((path, init) => {
    if (init?.method === 'POST') { saved = true; return result(ui.body({ receipt: ui.receipt(JSON.parse(init.body)) })) }
    if (path.includes('resource=request&')) return result(ui.body({ detail: detail(saved ? { ...original, version: 3, location: { kind: 'unit', unitId: '13L' }, residentId: 'resident-one' } : original), safetyInstructions: [] }))
    return ui.defaultHandler(path, init)
  })
  await ui.mount(); ui.helpers.openForm('update_context'); const dialog = ui.dialogs.at(-1)
  fill(dialog, { location: 'unit', unit: '13L', note: 'Staff clarified the apartment and selected reviewed occupancy.' }); dialog.body.handlers.get('change')({ target: { id: 'sv-unit' } }); await settle(); fill(dialog, { resident: 'resident-one' }); await dialog.click()
  assert.match(dialog.body.innerHTML, /Alex Example/); assert.match(dialog.body.innerHTML, /original intake retained/); await dialog.click()
  const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body); assert.equal(command.action, 'update_context'); assert.equal(command.id, original.id); assert.equal(command.expectedVersion, 2); assert.deepEqual(command.location, { kind: 'unit', unitId: '13L' }); assert.equal(command.residentId, 'resident-one'); assert.equal(command.requestOrigin, undefined)
  assert.match(ui.text(), /Original intake context/); assert.match(ui.text(), /Not established/); assert.match(ui.text(), /Caller identity not verified/)
})
test('context updates remain available for emergency review without offering a priority downgrade', async () => {
  const ui = portal(), r = request({ priority: 'emergency', state: 'emergency_review', emergencyKinds: ['gas'] })
  ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(r), safetyInstructions: [] })) : ui.defaultHandler(path, init)); await ui.mount(); ui.helpers.openForm('update_context'); const dialog = ui.dialogs.at(-1); await settle()
  assert.match(dialog.body.innerHTML, /emergency evidence stays held/); assert.equal(dialog.body.querySelector('#sv-priority'), null); fill(dialog, { note: 'Confirmed the same unit location with staff.' }); await dialog.click(); await dialog.click()
  const command = JSON.parse(ui.requests.find(r => r.method === 'POST').body); assert.equal(command.action, 'update_context'); assert.equal(command.residentId, 'resident-one'); assert.equal(command.priority, undefined)
})
test('timeline shows immutable location/source snapshots and rejects incomplete event context', async () => {
  const ui = portal(); ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(request(), { events: [event({ kind: 'context', contextLocation: { kind: 'unknown', label: 'Original lobby report' }, contextResidentName: 'Source name at that time' })] }), safetyInstructions: [] })) : ui.defaultHandler(path, init)); await ui.mount()
  assert.match(ui.text(), /Request context updated/); assert.match(ui.text(), /Original lobby report/); assert.match(ui.text(), /Source name at that time/); assert.match(ui.text(), /source version 2/)
  assert.throws(() => ui.helpers.readDetail(detail(request(), { events: [event({ contextResidentVersion: undefined })] }), 'case-one'), /unreadable/)
})
test('staff notes, triage and context reasons show immediate emergency guidance before any save', async () => {
  for (const action of ['add_note', 'triage_request', 'update_context']) {
    const ui = portal(); await ui.mount(); ui.helpers.openForm(action); const dialog = ui.dialogs.at(-1); await settle(); fill(dialog, { note: 'The resident now says I smell gas.' }); dialog.body.handlers.get('input')()
    const warning = dialog.body.querySelector('.sv-immediate-safety'); assert.equal(warning.hidden, false); assert.match(warning.innerHTML, /Act on immediate danger/); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 0)
    await dialog.click(); assert.match(dialog.body.innerHTML, /Act on immediate danger/); assert.match(dialog.body.innerHTML, /does not contact emergency services/)
  }
})
test('a removed-unit context flag is visible even for a staff-observed planning request', async () => {
  const ui = portal(), r = request({ requestOrigin: 'staff_observation', state: 'ready_for_planning', contextNeedsReview: true, residentId: null })
  ui.setHandler((path, init) => path.includes('resource=request&') ? result(ui.body({ detail: detail(r), safetyInstructions: [] })) : ui.defaultHandler(path, init)); await ui.mount()
  assert.match(ui.text(), /Context needs review/); assert.match(ui.text(), /unit or occupancy context needs review/); assert.match(ui.text(), /Apartment 13L/)
})
