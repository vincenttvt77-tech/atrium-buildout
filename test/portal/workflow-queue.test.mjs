import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const queueSource = await readFile(new URL('../../ops/src/workflows.js', import.meta.url), 'utf8')
const htmlSource = await readFile(new URL('../../ops/src/index.html', import.meta.url), 'utf8')
const cssSource = await readFile(new URL('../../ops/src/workflows.css', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const result = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const item = (overrides = {}) => ({ id: 'action-one', kind: 'maintenance.dispatch', connector: 'vendor_system', state: 'needs_review', phase: 'dispatch',
  createdAt: '2032-06-01T14:30:00.123456Z', updatedAt: '2032-06-01T14:32:00.123Z', availableAt: '2032-06-01T14:32:00.123Z',
  completedAt: '2032-06-01T14:32:00.123Z', lastErrorCode: 'connector_unavailable', dispatchAttempts: 0,
  verificationAttempts: 0, maxAttempts: 5, dispatchStarted: false, revision: 'a'.repeat(64), canReplay: true, canCancel: true, ...overrides })

/** Real app + view scripts and API wrapper; controlled DOM/HTTP/timers, no provider calls. */
function portal({ legacy = false, permissions = ['read', 'operate', 'configure'], mobile = false, reducedMotion = false } = {}) {
  const scope = { organizationId: 'organization-one', propertyId: 'building-one', configurationVersion: 3, permissionVersion: 'permission-three' }
  const window = { ATRIUM_RUNTIME_MODE: legacy ? 'legacy' : 'postgres', ATRIUM_ACCOUNT: { username: 'operator', tenantId: 'larkin' },
    ATRIUM_PROPERTY: { ...scope, buildingName: 'Lake House', timeZone: 'America/Chicago', permissions, hours: {} } }
  const nodes = new Map(), timers = new Map(), requests = [], toasts = [], announcements = [], dialogs = []
  let timerId = 0, reloads = 0, handler = () => result(page([item()])), requestCount = 0
  const document = { readyState: 'loading', activeElement: null, addEventListener() {}, getElementById: () => null,
    querySelector: () => null, querySelectorAll: selector => selector === '.view' ? [root] : [],
    body: { classList: { toggle() {}, add() {}, remove() {} } } }
  function node() {
    let content = '', children = []
    const self = { dataset: {}, hidden: false, disabled: false, isConnected: true, scrollTop: 0, scrollLeft: 0, writes: 0,
      classList: { add() {}, remove() {}, toggle() {} }, handlers: new Map(), attributes: {},
      setAttribute(key, value) { self.attributes[key] = value }, getAttribute(key) { return self.attributes[key] }, removeAttribute(key) { delete self.attributes[key] },
      contains(target) { return target === self || children.includes(target) },
      querySelectorAll(selector) { return children.filter(child => selector === '[data-key]' ? child.dataset.key
        : selector === '[data-select]' ? child.dataset.select : selector === '[data-filter]' ? child.dataset.filter : false) },
      querySelector(selector) {
        const match = /^\[data-(key|command|filter|select)="([^"]+)"\]$/.exec(selector)
        return match ? children.find(child => child.dataset[match[1]] === match[2]) || null : null
      },
      addEventListener(name, fn) { self.handlers.set(name, fn) }, focus() { document.activeElement = self },
      scrollIntoView(options) { self.scrolled = options }, replaceChildren() { self.innerHTML = '' },
      get innerHTML() { return content }, set innerHTML(value) {
        content = value; self.writes++
        for (const child of children) child.isConnected = false
        children = [...value.matchAll(/<(button|h2|summary)\b([^>]*)>/g)].map(([, tag, attrs]) => {
          const child = node(); child.tagName = tag.toUpperCase()
          for (const [, key, val] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
            if (key.startsWith('data-')) child.dataset[key.slice(5)] = val
            child.attributes[key] = val
          }
          child.disabled = /\sdisabled(?:\s|$)/.test(attrs)
          child.closest = selector => selector === 'button' && tag === 'button' ? child : null
          return child
        })
      },
    }
    return self
  }
  const root = node()
  const query = root.querySelector
  root.querySelector = selector => {
    if (['.wq-errors', '.wq-results', '.wq-detail', '.wq-loaded'].includes(selector)) {
      if (!nodes.has(selector)) nodes.set(selector, node())
      return nodes.get(selector)
    }
    return query(selector) || [...nodes.values()].map(host => host.querySelector(selector)).find(Boolean) || null
  }
  const contains = root.contains
  root.contains = target => contains(target) || [...nodes.values()].some(host => host.contains(target))
  const location = { hash: '#/workflows', reload() { reloads++ } }
  const context = { window, document, location, Intl, Date, console, URLSearchParams, structuredClone,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    setInterval() {}, clearInterval() {}, matchMedia: query => ({ matches: query.includes('reduced-motion') ? reducedMotion : mobile }),
    fetch: async (path, init) => { requests.push({ path, ...init }); requestCount++; return handler(path, init, requestCount) } }
  runInNewContext(appSource.replace('window.Atrium = {', 'window.queueAppTest = { emit, markBooted() { booted = true } }; window.Atrium = {'), context)
  const A = window.Atrium
  A.toast = (text, options) => { toasts.push({ text, options }) }
  A.announce = text => announcements.push(text)
  A.paintPermissions = () => {}
  A.dialog = options => {
    const reason = { value: options.title.startsWith('Cancel') ? 'no_longer_needed' : 'reviewed_request', disabled: false }
    const body = { innerHTML: '', querySelector: () => reason }
    const dialog = { body, closed: false, error: null, primary: { ...options.primary },
      setError(value) { dialog.error = value }, setPrimary(value) { Object.assign(dialog.primary, value) }, setBusy(value) { dialog.busy = value },
      close() { if (!dialog.closed) { dialog.closed = true; options.onClose?.() } },
      click() { return options.primary.onClick(dialog) } }
    options.build(body, dialog); dialogs.push(dialog); return dialog
  }
  runInNewContext(queueSource.replace("A.register('workflows', view)",
    "window.queueTest = { view, load, select, recover, readItem, readPage, readReceipt, detailHtml, listHtml, paint, state: () => ({ items, cursor, selected, filter, loading, loaded, error, checkedAt, canManage, actionBusy }) }; A.register('workflows', view)"), context)
  const helpers = window.queueTest
  A.navigate = (name, params = {}) => {
    location.hash = A.hashFor(name, params)
    if (name === 'workflows') helpers?.view.render()
    window.queueAppTest.emit('route', A.route())
  }
  function page(actions, extra = {}) { return { scope, actions, nextCursor: null, canManage: permissions.includes('configure'), executionEnabled: false, ...extra } }
  return { A, helpers, root, nodes, document, window, context, location, requests, toasts, announcements, dialogs, scope, page,
    setHandler(fn) { handler = fn }, respond(body, status = 200) { handler = () => result(body, status) },
    async mount() { helpers?.view.mount(root); helpers?.view.render(); await settle() },
    async expire() { for (const [id, timer] of timers) if (timer.delay === 15000) { timers.delete(id); timer.fn() }; await settle() },
    markBooted() { window.queueAppTest.markBooted() }, reloads: () => reloads,
    click(selector) { const button = root.querySelector(selector); assert.ok(button, selector); root.handlers.get('click')({ target: button }); return button },
    html() { return [...nodes.values()].map(host => host.innerHTML).join('') },
  }
}

test('legacy omits queue registration and rejects its route; PostgreSQL queue is reachable without calls polling', async () => {
  const legacy = portal({ legacy: true }); await legacy.mount()
  assert.equal(legacy.helpers, undefined); assert.equal(legacy.A.route().name, 'today')
  assert.equal(legacy.A.views.includes('workflows'), false); assert.equal(legacy.requests.length, 0)
  assert.match(htmlSource, /<li data-postgres-only hidden><a[^>]*href="#\/workflows"/)
  const ui = portal(); await ui.mount()
  assert.equal(ui.A.route().name, 'workflows'); assert.equal(ui.requests.length, 1)
  assert.equal(ui.requests[0].path, '/api/workflows?state=attention&limit=25')
  assert.equal(ui.A.state.loaded.calls, false)
  ui.window.queueAppTest.emit('data', ui.A.state, new Set(['leads']))
  assert.equal(ui.requests.length, 1, 'Shared polling must not fetch or replace queue state')
})

test('requests retain immutable property headers and configure permission is required before any write', async () => {
  const ui = portal(); ui.window.ATRIUM_PROPERTY.propertyId = 'tampered'; await ui.mount()
  const request = ui.requests[0]
  assert.equal(request.headers['x-atrium-property-id'], 'building-one')
  assert.equal(request.headers['x-atrium-config-version'], '3')
  assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store')
  const reader = portal({ permissions: ['read'] }); await reader.mount()
  assert.doesNotMatch(reader.html(), /data-command="replay"|data-command="cancel"/)
  reader.helpers.recover('cancel'); assert.equal(reader.dialogs.length, 0)
  await assert.rejects(reader.A.api.post('/api/workflows', {}), error => error.status === 403)
  assert.equal(reader.requests.length, 1)
  const staff = portal({ permissions: ['read', 'operate'] }); await staff.mount()
  await assert.rejects(staff.A.api.post('/api/workflows', {}), error => error.status === 403)
})

test('only validated projected fields render and local timestamps remain property based', async () => {
  const ui = portal()
  ui.respond(ui.page([item({ input: { private: 'DO_NOT_DISPLAY' }, evidence: 'NO_RAW_BODY', providerReference: 'NO_REFERENCE' })]))
  await ui.mount()
  assert.match(ui.html(), /Maintenance dispatch/); assert.match(ui.html(), /Central Time/)
  assert.match(ui.html(), /9:30 AM/); assert.match(ui.html(), /connection is not available/)
  assert.doesNotMatch(ui.html(), /DO_NOT_DISPLAY|NO_RAW_BODY|NO_REFERENCE/)
  assert.match(ui.root.innerHTML, /Automatic execution is not connected/)
  assert.match(ui.root.innerHTML, /Requeuing does not run or complete it/)
  assert.equal(plain(ui.helpers.state()).items[0].input, undefined)
  for (const bad of [item({ state: '__proto__' }), item({ kind: '<img onerror=alert(1)>' }), item({ revision: ['a'.repeat(64)] }), item({ canReplay: 'true' })])
    assert.throws(() => ui.helpers.readItem(bad), /unreadable/)
  assert.throws(() => ui.helpers.readPage(ui.page([item()], { executionEnabled: true }), 'attention'), /unreadable/)
})

test('loading, initial failure and refreshed empty results have distinct truthful copy', async () => {
  const ui = portal(); let release
  ui.setHandler(() => new Promise(resolve => { release = resolve }))
  await ui.mount(); assert.match(ui.html(), /Loading the work queue/); assert.doesNotMatch(ui.html(), /No actions need review/)
  release(result({ error: 'unavailable' }, 503)); await settle()
  assert.match(ui.html(), /could not be loaded/); assert.match(ui.html(), /Work queue not loaded/)
  ui.respond(ui.page([])); await ui.helpers.load()
  assert.match(ui.html(), /No actions need review in this result/)
  assert.doesNotMatch(ui.html(), /Nothing needs you|all work complete/i)
})

test('keyset paging preserves microseconds and selection, and deduplicates changed pages', async () => {
  const ui = portal(), first = item(), next = item({ id: 'action-two', createdAt: '2032-06-01T14:29:00.654321Z' })
  ui.respond(ui.page([first], { nextCursor: { createdAt: first.createdAt, id: first.id } })); await ui.mount()
  ui.respond(ui.page([first, next])); await ui.helpers.load(true)
  const sent = new URL(ui.requests.at(-1).path, 'https://example.test')
  assert.equal(sent.searchParams.get('beforeCreatedAt'), first.createdAt)
  assert.equal(sent.searchParams.get('beforeId'), first.id)
  assert.equal(ui.helpers.state().selected, first.id)
  assert.deepEqual(plain(ui.helpers.state().items.map(row => row.id)), [first.id, next.id])
  assert.equal(ui.helpers.state().cursor, null)
})

test('click selection preserves list DOM, focus and scroll, including later harmless renders', async () => {
  const ui = portal(); ui.respond(ui.page([item(), item({ id: 'action-two' })])); await ui.mount()
  const list = ui.nodes.get('.wq-results'), writes = list.writes
  list.scrollTop = 327
  const button = list.querySelector('[data-select="action-two"]'); button.focus()
  ui.helpers.select('action-two')
  assert.equal(list.writes, writes); assert.equal(list.scrollTop, 327)
  assert.equal(ui.document.activeElement, button); assert.equal(button.getAttribute('aria-current'), 'true')
  ui.helpers.view.render()
  assert.equal(list.scrollTop, 327); assert.equal(ui.document.activeElement?.dataset.key, 'work:action-two')
  assert.equal(ui.helpers.state().selected, 'action-two')
})

test('explicit mobile selection focuses the selected detail and respects reduced motion', async () => {
  const ui = portal({ mobile: true, reducedMotion: true }); await ui.mount()
  ui.helpers.select('action-one')
  assert.equal(ui.document.activeElement.dataset.key, 'work-detail-heading')
  assert.deepEqual(plain(ui.document.activeElement.scrolled), { block: 'start', behavior: 'auto' })
  assert.match(cssSource, /min-height: 44px/); assert.match(cssSource, /prefers-reduced-motion: reduce/)
})

test('late results cannot replace a newer filter or revive a route that has been left', async () => {
  const ui = portal(); let first
  ui.setHandler(() => new Promise(resolve => { first = resolve })); await ui.mount()
  ui.respond(ui.page([item({ id: 'queued-two', state: 'queued', completedAt: null })]))
  ui.A.navigate('workflows', { state: 'active' }); await settle()
  first(result(ui.page([item({ id: 'old-attention' })]))); await settle()
  assert.deepEqual(plain(ui.helpers.state().items.map(row => row.id)), ['queued-two'])
  let late
  ui.setHandler(() => new Promise(resolve => { late = resolve }))
  const fetch = ui.helpers.load(); ui.A.navigate('today')
  late(result(ui.page([item({ id: 'wrong-late', state: 'queued' })]))); await fetch
  assert.deepEqual(plain(ui.helpers.state().items.map(row => row.id)), ['queued-two'])
})

test('mismatched property echoes retire the document and reject late queue responses', async () => {
  const ui = portal(); await ui.mount(); ui.markBooted()
  let release
  ui.setHandler(path => path.startsWith('/api/workflows') ? new Promise(resolve => { release = resolve }) : result({ error: 'Revoked' }, 403))
  const late = ui.helpers.load()
  await assert.rejects(ui.A.api.get('/api/leads'), error => error.status === 403)
  release(result(ui.page([item({ id: 'must-not-render' })]))); await late
  assert.equal(ui.A.can('read'), false); assert.doesNotMatch(ui.root.innerHTML, /must-not-render/)
  const other = portal(); other.respond(other.page([item()], { scope: { ...other.scope, propertyId: 'foreign' } })); await other.mount()
  assert.equal(other.A.can('read'), false); assert.equal(other.helpers.state().loaded, false)
})

test('known replay can remain held and must not announce completed work', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.recover('replay')
  const dialog = ui.dialogs.at(-1)
  ui.respond({ scope: ui.scope, executionEnabled: false, action: item({ revision: 'b'.repeat(64), lastErrorCode: 'workflow_attempts_exhausted' }) })
  await dialog.click()
  const command = JSON.parse(ui.requests.at(-1).body)
  assert.deepEqual(command, { action: 'replay', id: 'action-one', expectedRevision: 'a'.repeat(64), reason: 'reviewed_request' })
  assert.equal(ui.requests.at(-1).headers['x-atrium-property-id'], 'building-one')
  assert.match(ui.toasts.at(-1).text, /still held for review/); assert.doesNotMatch(ui.toasts.at(-1).text, /completed|sent successfully/i)
  assert.equal(dialog.closed, true)
})

test('cancellation confirms only the queue state; possible dispatch permits verification but not cancellation', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.recover('cancel')
  ui.respond({ scope: ui.scope, executionEnabled: false, action: item({ state: 'cancelled', revision: 'b'.repeat(64), lastErrorCode: null, canCancel: false }) })
  await ui.dialogs.at(-1).click()
  assert.match(ui.toasts.at(-1).text, /No external booking or work order was cancelled/)
  const dispatched = portal()
  dispatched.respond(dispatched.page([item({ phase: 'verify', dispatchStarted: true, dispatchAttempts: 1, canCancel: false })])); await dispatched.mount()
  assert.match(dispatched.html(), /Requeue verification/); assert.doesNotMatch(dispatched.html(), /data-command="cancel"/)
  dispatched.helpers.recover('cancel'); assert.equal(dispatched.dialogs.length, 0)
})

test('unreadable or wrong-action successful receipts remain uncertain with no blind mutation retry', async () => {
  for (const response of [{ executionEnabled: false, action: null }, { executionEnabled: false, action: item({ id: 'wrong' }) },
    { executionEnabled: false, action: item({ state: 'succeeded' }) }]) {
    const ui = portal(); await ui.mount(); ui.helpers.recover('replay')
    ui.respond({ scope: ui.scope, ...response }); const dialog = ui.dialogs.at(-1)
    await dialog.click(); const sent = ui.requests.length
    assert.match(dialog.error, /unconfirmed/); assert.equal(dialog.primary.label, 'Close and review')
    await dialog.click(); assert.equal(dialog.closed, true); assert.equal(ui.requests.length, sent)
    ui.helpers.recover('replay'); assert.equal(ui.dialogs.length, 1)
    assert.doesNotMatch(ui.html(), /data-command="replay"/); assert.equal(ui.toasts.length, 0)
  }
})

test('timeout and duplicate click never submit twice; a late successful save is not presented as confirmation', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.recover('replay')
  let release; ui.setHandler(() => new Promise(resolve => { release = resolve }))
  const dialog = ui.dialogs.at(-1), saving = dialog.click()
  await dialog.click(); assert.equal(ui.requests.length, 2); assert.equal(dialog.body.querySelector().disabled, true)
  await ui.expire(); await saving
  assert.match(dialog.error, /unconfirmed/); assert.equal(ui.helpers.state().actionBusy, false)
  release(result({ scope: ui.scope, executionEnabled: false, action: item({ state: 'queued', revision: 'b'.repeat(64) }) })); await settle()
  assert.equal(ui.toasts.length, 0); assert.equal(ui.helpers.state().items[0].state, 'needs_review')
})

test('conflict or failed refresh preserves last loaded data and requires a new review', async () => {
  const ui = portal(); await ui.mount(); ui.helpers.recover('replay')
  ui.respond({ error: 'Changed', code: 'workflow_revision_conflict' }, 409)
  await ui.dialogs.at(-1).click(); await ui.dialogs.at(-1).click()
  assert.match(ui.html(), /Refresh the queue and review its latest state/)
  assert.doesNotMatch(ui.html(), /data-command="replay"/)
  ui.respond({ error: 'unavailable' }, 503); await ui.helpers.load()
  assert.equal(ui.helpers.state().items.length, 1); assert.match(ui.html(), /last loaded actions/)
  ui.respond(ui.page([item({ revision: 'c'.repeat(64) })])); await ui.helpers.load(); ui.helpers.recover('replay')
  assert.equal(ui.dialogs.length, 2)
})

test('unresolved queue reads release the refresh control honestly after the bounded wait', async () => {
  const ui = portal(); ui.setHandler(() => new Promise(() => {})); await ui.mount()
  await ui.expire()
  assert.equal(ui.helpers.state().loading, false)
  assert.match(ui.html(), /request may still be pending/)
  assert.equal(ui.root.querySelector('[data-command="refresh"]').disabled, false)
  assert.equal(ui.helpers.state().loaded, false)
})

test('terminal and held actions have truthful next steps and emitted hold codes explain the actual issue', async () => {
  const ui = portal(); await ui.mount()
  const cancelled = ui.helpers.detailHtml(item({ state: 'cancelled', canCancel: false }))
  assert.match(cancelled, /None — this queued action is stopped/)
  assert.doesNotMatch(cancelled, /<dd>Dispatch when authorized/)
  const verified = ui.helpers.detailHtml(item({ state: 'succeeded', phase: 'verify', canReplay: false, canCancel: false }))
  assert.match(verified, /None — the action result is verified/)
  assert.doesNotMatch(verified, /<dd>Check the provider result/)
  const revoked = ui.helpers.detailHtml(item({ lastErrorCode: 'original_authorization_changed' }))
  assert.match(revoked, /originally authorized this action has changed/)
  assert.match(revoked, /Administrator review before further work/)
  assert.match(ui.helpers.detailHtml(item({ lastErrorCode: 'original_configuration_changed' })), /property configuration has changed/)
  assert.match(ui.helpers.detailHtml(item({ lastErrorCode: 'verification_attempts_exhausted' })), /verification attempts have been used/)
  assert.match(ui.helpers.detailHtml(item({ lastErrorCode: 'verification_unknown' })), /result could not be established/)
})

test('the final keyboard page keeps list scroll and moves focus to the last appended action', async () => {
  const ui = portal(), first = item()
  ui.respond(ui.page([first], { nextCursor: { id: first.id, createdAt: first.createdAt } })); await ui.mount()
  const list = ui.nodes.get('.wq-results'); list.scrollTop = 260
  const more = ui.root.querySelector('[data-command="more"]'); more.focus()
  ui.respond(ui.page([item({ id: 'action-second' }), item({ id: 'action-final' })])); await ui.helpers.load(true)
  assert.equal(more.hidden, true)
  assert.equal(ui.document.activeElement.dataset.key, 'work:action-final')
  assert.equal(list.scrollTop, 260)
})

test('a mutation does not advance the timestamp for the entire queue snapshot', async () => {
  const ui = portal(); await ui.mount()
  const lastRead = ui.helpers.state().checkedAt
  ui.helpers.recover('replay')
  ui.respond({ scope: ui.scope, executionEnabled: false, action: item({ revision: 'b'.repeat(64), state: 'queued', completedAt: null }) })
  await ui.dialogs.at(-1).click()
  assert.equal(ui.helpers.state().checkedAt, lastRead)
})
