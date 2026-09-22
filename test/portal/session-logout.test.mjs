import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import dashboard from '../../api/dashboard.ts'
import { DatabaseRuntime } from '../../src/application/runtime.ts'
import { issueAuthenticatedUser } from '../../src/auth/identity.ts'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const account = Object.freeze({ userId: 'synthetic-operator', username: 'operator', displayName: 'Synthetic Operator',
  sessionId: '00000000-0000-4000-8000-000000000001' })
const token = 'synthetic-session-bound-form-token'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

/** Execute the real Status handler, request path, toast and invalidation behavior. */
function fixture(transport, { mode = 'postgres', named = true } = {}) {
  const requests = [], navigations = [], errors = [], timers = new Map(), intervals = new Map()
  let nextTimer = 0, mediaPauses = 0, pollStops = 0, renderCount = 0
  const node = () => {
    const attributes = new Map(), classes = new Set()
    return { textContent: '', innerHTML: '', hidden: false, disabled: false, isConnected: true, dataset: {}, children: [],
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle() {} },
      setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key),
      addEventListener() {}, contains: () => false, focus() {},
      appendChild(child) { this.children.push(child); child.parent = this },
      replaceChildren() { this.children = []; this.innerHTML = ''; this.textContent = '' },
      remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) },
      querySelector: () => ({ addEventListener() {}, focus() {} }), querySelectorAll: () => [],
    }
  }
  const button = node(); button.dataset.action = 'signout'
  const stack = node(), live = node(), body = node(), workspace = node()
  workspace.innerHTML = 'Synthetic private details'
  const document = { readyState: 'loading', hidden: false, body, activeElement: body, addEventListener() {},
    getElementById: id => id === 'toasts' ? stack : id === 'live' ? live : null,
    querySelector: () => null,
    querySelectorAll: selector => selector === '.view' ? [workspace] : selector === 'audio, video' ? [{ pause() { mediaPauses++ } }] : [],
    createElement: node,
  }
  const window = {
    ATRIUM_RUNTIME_MODE: mode, ATRIUM_SESSION_FORM_TOKEN: token,
    ATRIUM_ACCOUNT: mode === 'postgres' ? account : named ? { username: 'legacy', displayName: 'Legacy workspace', tenantId: 'synthetic-legacy' } : undefined,
    ATRIUM_PROPERTY: mode === 'postgres' ? {
      organizationId: 'synthetic-org', propertyId: 'synthetic-property', buildingName: 'Synthetic House',
      locationLabel: '', timeZone: 'America/Chicago', configurationVersion: 1, permissionVersion: 'synthetic-version',
      permissions: ['read', 'operate'], hours: {}, leasingPhone: null, leasingPhoneDisplay: null,
    } : undefined,
  }
  const location = { hash: '#/status', assign: url => navigations.push(url), reload: () => navigations.push('reload') }
  const context = { window, document, location, Intl, Date, URLSearchParams, structuredClone, AbortController,
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args), log() {} },
    matchMedia: () => ({ matches: false }),
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id },
    clearInterval(id) { if (intervals.delete(id)) pollStops++ },
    fetch: async (path, options) => { requests.push({ path, ...options }); return transport(path, options) },
  }
  assert.equal(source.split('window.Atrium = {').length, 2, 'exactly one app exposure anchor')
  // Expose the actual existing view and activate only its document/poll lifecycle;
  // do not start resource fetches, replace signOut, or stub its state mutations.
  runInNewContext(source.replace('window.Atrium = {',
    "window.logoutViewForTest = statusView; window.activateLogoutTest = () => { booted = true; pollTimer = setInterval(() => {}, 5000); }; window.Atrium = {"), context)
  const app = window.Atrium, view = window.logoutViewForTest
  app.state.calls = [{ id: 'synthetic-call', details: 'Synthetic private details' }]
  app.state.leads = { profiles: [{ key: 'synthetic-person' }] }
  app.state.calendar = { bookings: [{ externalId: 'synthetic-booking' }] }
  app.state.loaded = { calls: true, calendar: true, leads: true }
  window.activateLogoutTest()
  const initial = structuredClone(app.state)
  return { app, button, view, workspace, requests, navigations, errors, timers, intervals, initial,
    signOut: () => view.signOut(button),
    repaintSignOutButton() {
      view.root = workspace
      app.state.lastPollAt = new Date(Date.now() + ++renderCount).toISOString()
      const previousHtml = workspace.innerHTML
      view.render(app.state)
      if (workspace.innerHTML === previousHtml) return button
      const rendered = workspace.innerHTML.match(/<button[^>]*data-action="signout"[^>]*>/)?.[0]
      assert.ok(rendered, 'real Status rendering still contains its sign-out button')
      const replacement = node(); replacement.dataset.action = 'signout'; replacement.disabled = /\bdisabled(?:[=\s>])/.test(rendered)
      return replacement
    },
    click: () => view.onClick({ target: { closest: selector => { assert.equal(selector, 'button[data-action]'); return button } } }),
    notices: () => stack.children.filter(child => child.isConnected).map(child => ({ html: child.innerHTML, className: child.className })),
    pollStops: () => pollStops, mediaPauses: () => mediaPauses,
    expire() { const entry = [...timers].find(([, timer]) => timer.delay === 15000); assert.ok(entry, 'logout request has a deadline'); timers.delete(entry[0]); entry[1].callback() },
  }
}
function unchanged(ui) {
  assert.deepEqual(structuredClone(ui.app.state), ui.initial)
  assert.equal(ui.app.can('operate'), true)
  assert.equal(ui.workspace.innerHTML, 'Synthetic private details')
  assert.equal(ui.workspace.hidden, false)
  assert.deepEqual(ui.navigations, [])
  assert.equal(ui.mediaPauses(), 0)
  assert.equal(ui.pollStops(), 0)
  assert.equal(ui.intervals.size, 1)
  assert.deepEqual(ui.errors, [])
}
function unconfirmed(ui) {
  unchanged(ui)
  const notices = ui.notices()
  assert.equal(notices.length, 1)
  assert.match(notices[0].className, /toast-warn/)
  assert.match(notices[0].html, /Sign-out could not be confirmed/)
  assert.match(notices[0].html, /Reload the workspace to check your session/)
  assert.doesNotMatch(notices[0].html, /toast-ok|You are signed out|Successfully signed out/)
  assert.equal(ui.button.disabled, false)
  assert.equal(ui.button.classList.contains('is-busy'), false)
  assert.equal(ui.button.getAttribute('aria-busy'), undefined)
  assert.equal([...ui.timers.values()].some(timer => timer.delay === 15000), false)
}

test('managed logout sends the rendered identity/session/CSRF and waits for parsed committed success before clearing or navigating', async () => {
  const requestGate = deferred(), bodyGate = deferred(), bodyEntered = deferred()
  const ui = fixture(() => requestGate.promise)
  const pending = ui.signOut()
  const request = ui.requests[0]
  assert.equal(request.path, '/api/dashboard')
  assert.equal(request.method, 'POST')
  assert.equal(request.credentials, 'same-origin')
  assert.equal(request.cache, 'no-store')
  assert.equal(request.redirect, 'error')
  assert.equal(request.headers['content-type'], 'application/json')
  assert.equal(request.headers['x-atrium-user-id'], account.userId)
  assert.equal(request.headers['x-atrium-session-id'], account.sessionId)
  assert.equal(request.headers['x-atrium-csrf'], token)
  assert.equal(request.headers['x-atrium-property-id'], undefined)
  assert.equal(request.headers['x-atrium-organization-id'], undefined)
  assert.deepEqual(JSON.parse(request.body), { action: 'logout' })
  assert.equal(ui.button.disabled, true)
  unchanged(ui)
  requestGate.resolve({ ok: true, status: 200, json() { bodyEntered.resolve(); return bodyGate.promise } })
  await bodyEntered.promise
  unchanged(ui)
  bodyGate.resolve({ status: 'signed_out' }); await pending
  assert.deepEqual(ui.navigations, ['/api/dashboard?reauthenticate=1'])
  assert.equal(ui.app.can('operate'), false)
  assert.equal(ui.app.state.calls.length, 0)
  assert.equal(ui.app.state.leads, null); assert.equal(ui.app.state.calendar, null)
  assert.equal(ui.workspace.hidden, true); assert.equal(ui.workspace.innerHTML, '')
  assert.equal(ui.mediaPauses(), 1); assert.equal(ui.pollStops(), 1)
  assert.equal(ui.intervals.size, 0); assert.equal(ui.timers.size, 0)
  assert.equal(ui.button.disabled, true)
  assert.deepEqual(ui.errors, [])
})

test('server refusals and malformed receipts preserve the workspace and never announce successful logout', async () => {
  const outcomes = [
    () => reply(503, { code: 'session_unavailable' }), () => reply(409, { code: 'account_changed' }),
    () => reply(403, { code: 'invalid_account_form' }), () => reply(401, { code: 'unauthenticated' }),
    () => reply(500, { status: 'signed_out' }), () => reply(200, {}), () => reply(200, null),
    () => reply(200, 'signed_out'), () => reply(200, { status: 'success' }),
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('unreadable receipt') } }),
  ]
  for (const outcome of outcomes) {
    const ui = fixture(outcome)
    await ui.signOut()
    unconfirmed(ui)
    assert.equal(ui.requests.length, 1)
  }
})

test('lost logout response leaves state intact and only a deliberate retry may issue another request', async () => {
  let calls = 0
  const ui = fixture(() => { if (++calls === 1) throw new Error('connection lost after possible commit'); return reply(200, { status: 'signed_out' }) })
  await ui.signOut()
  unconfirmed(ui)
  assert.equal(ui.requests.length, 1)
  await ui.signOut()
  assert.equal(ui.requests.length, 2)
  assert.deepEqual(ui.navigations, ['/api/dashboard?reauthenticate=1'])
  assert.equal(ui.app.can('operate'), false)
})

test('a request or response-body timeout aborts without premature invalidation or automatic retry', async () => {
  for (const phase of ['request', 'response-body']) {
    const entered = deferred()
    const ui = fixture((path, { signal }) => {
      const waiting = () => { entered.resolve(); return new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }) }
      return phase === 'request' ? waiting() : { ok: true, status: 200, json: waiting }
    })
    const pending = ui.signOut()
    await entered.promise
    unchanged(ui)
    ui.expire(); await pending
    assert.equal(ui.requests[0].signal.aborted, true)
    unconfirmed(ui)
    assert.equal(ui.requests.length, 1)
  }
})

test('repeated Status clicks during pending logout send exactly one request', async () => {
  const gate = deferred(), ui = fixture(() => gate.promise)
  const first = ui.signOut()
  for (let index = 0; index < 3; index++) { ui.click(); await ui.signOut() }
  assert.equal(ui.requests.length, 1)
  assert.equal(ui.button.getAttribute('aria-busy'), 'true')
  unchanged(ui)
  gate.resolve(reply(200, { status: 'signed_out' })); await first
  assert.deepEqual(ui.navigations, ['/api/dashboard?reauthenticate=1'])
})

test('a Status poll repaint cannot admit another logout while the original request is pending', async () => {
  const gate = deferred(), ui = fixture(() => gate.promise)
  ui.repaintSignOutButton()
  const first = ui.signOut()
  const replacement = ui.repaintSignOutButton()
  const second = ui.view.signOut(replacement)
  const requestCount = ui.requests.length
  gate.resolve(reply(200, { status: 'signed_out' }))
  await Promise.all([first, second])
  assert.equal(requestCount, 1, 'the pending guard must survive replacement of the clicked DOM button')
  assert.deepEqual(ui.navigations, ['/api/dashboard?reauthenticate=1'])
})

test('legacy named and shared-passcode logout keep successful HTTP behavior without managed-session headers', async () => {
  for (const named of [true, false]) {
    const gate = deferred(), ui = fixture(() => gate.promise, { mode: 'legacy', named })
    const pending = ui.signOut()
    unchanged(ui)
    const request = ui.requests[0]
    for (const key of ['x-atrium-user-id', 'x-atrium-session-id', 'x-atrium-csrf']) assert.equal(request.headers[key], undefined)
    assert.deepEqual(JSON.parse(request.body), { action: 'logout' })
    gate.resolve({ ok: true, status: 200, json() { assert.fail('Legacy success must not depend on a new JSON receipt') } })
    await pending
    assert.deepEqual(ui.navigations, ['/api/dashboard?reauthenticate=1'])
    assert.equal(ui.pollStops(), 1)
    assert.equal(ui.notices().length, 0)
  }
})


async function pickerHtml() {
  const previous = process.env.ATRIUM_RUNTIME_MODE
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  try {
    // Only page construction is under test here. Real session admission and the
    // rendered form's HTTP request are covered by session-http.test.mjs.
    const principal = issueAuthenticatedUser({ id: account.userId, username: account.username, displayName: account.displayName,
      status: 'active', credentialVersion: 1 }, { id: account.sessionId, expiresAt: Date.now() + 28_800_000 })
    const runtime = Object.assign(Object.create(DatabaseRuntime.prototype), {
      sessionSecret: 'synthetic-picker-rendering-secret-at-least-32-characters', authenticate: async () => principal,
      authorization: { listAuthorizedProperties: async () => [1, 2].map(index => ({ id: `property-${index}`, name: `Synthetic property ${index}`,
        organizationId: 'synthetic-org', organizationName: 'Synthetic organization', role: 'viewer' })) },
    })
    // This browser-script fixture renders an unenrolled viewer's picker. Actual
    // privileged MFA admission is exercised through real HTTP/PostgreSQL tests.
    Object.defineProperty(runtime, 'mfa', { value: { state: async () => ({ required: false, assurances: [] }) } })
    const response = { code: 0, body: '', setHeader() {}, status(code) { this.code = code; return this }, send(body) { this.body = body; return this } }
    await dashboard({ method: 'GET', url: '/api/dashboard', headers: {}, atriumRuntime: runtime }, response)
    assert.equal(response.code, 200)
    return response.body
  } finally { previous === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = previous }
}
function pickerFixture(html, transport) {
  const tag = html.match(/<form id="signout-form"[^>]*>/)?.[0]
  assert.ok(tag)
  assert.match(html, /<button type="submit" disabled>Sign out<\/button>/)
  const dataset = Object.fromEntries([['userId', 'user-id'], ['sessionId', 'session-id'], ['formToken', 'form-token']]
    .map(([key, attribute]) => [key, new RegExp(`data-${attribute}="([A-Za-z0-9_.-]+)"`).exec(tag)?.[1]]))
  for (const value of Object.values(dataset)) assert.ok(value)
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(value => value.includes("getElementById('signout-form')"))
  assert.ok(script)
  const button = { disabled: true, textContent: 'Sign out' }, notice = { textContent: '' }, next = { hidden: true }
  const requests = [], timers = new Map(), location = { href: '/api/dashboard' }
  let submit, timerId = 0
  const form = { dataset, querySelector(selector) { assert.equal(selector, 'button'); return button },
    addEventListener(name, listener) { assert.equal(name, 'submit'); submit = listener } }
  runInNewContext(script, { document: { getElementById: id => ({ 'signout-form': form, 'signout-notice': notice, 'signout-next': next })[id] },
    location, AbortController, setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
    fetch(path, options) { requests.push({ path, ...options }); return transport(path, options) },
  })
  assert.equal(button.disabled, false)
  return { button, notice, next, requests, location, dataset, timers, submit: () => submit({ preventDefault() {} }),
    expire() { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; assert.equal(timer.delay, 15000); timers.delete(id); timer.callback() } }
}

test('actual property-picker script sends its rendered JSON proof and navigates only after success is parsed', async () => {
  const gate = deferred(), bodyGate = deferred(), entered = deferred()
  const ui = pickerFixture(await pickerHtml(), () => gate.promise)
  const pending = ui.submit()
  await ui.submit()
  assert.equal(ui.requests.length, 1)
  const request = ui.requests[0]
  assert.equal(request.path, '/api/dashboard'); assert.equal(request.method, 'POST')
  assert.equal(request.credentials, 'same-origin'); assert.equal(request.redirect, 'error')
  assert.equal(request.headers['content-type'], 'application/json')
  assert.equal(request.headers['x-atrium-user-id'], account.userId)
  assert.equal(request.headers['x-atrium-session-id'], account.sessionId)
  assert.equal(request.headers['x-atrium-csrf'], ui.dataset.formToken)
  assert.deepEqual(JSON.parse(request.body), { action: 'logout' })
  assert.equal(ui.location.href, '/api/dashboard')
  gate.resolve({ status: 200, json() { entered.resolve(); return bodyGate.promise } })
  await entered.promise
  assert.equal(ui.location.href, '/api/dashboard')
  bodyGate.resolve({ status: 'signed_out' }); await pending
  assert.equal(ui.location.href, '/api/dashboard?reauthenticate=1')
  assert.equal(ui.notice.textContent, ''); assert.equal(ui.timers.size, 0)
})

test('picker failure, lost or malformed response retires sign-out controls and requires reload', async () => {
  const html = await pickerHtml()
  for (const transport of [() => reply(503, { status: 'signed_out' }), () => reply(409, {}), () => reply(200, {}),
    () => reply(200, null), () => ({ status: 200, json: async () => { throw new Error('unreadable') } }),
    () => { throw new Error('response lost after possible commit') }]) {
    const ui = pickerFixture(html, transport)
    await ui.submit()
    assert.equal(ui.location.href, '/api/dashboard')
    assert.equal(ui.button.disabled, true)
    assert.equal(ui.next.hidden, false)
    assert.match(ui.notice.textContent, /couldn’t confirm sign-out.*Reload this page/)
    await ui.submit()
    assert.equal(ui.requests.length, 1)
    assert.equal(ui.timers.size, 0)
  }
})

test('picker request and body timeout abort without navigation, success claims or automatic retries', async () => {
  const html = await pickerHtml()
  for (const phase of ['request', 'response-body']) {
    const entered = deferred()
    const ui = pickerFixture(html, (path, { signal }) => {
      const waiting = () => { entered.resolve(); return new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }) }
      return phase === 'request' ? waiting() : { status: 200, json: waiting }
    })
    const pending = ui.submit(); await entered.promise
    ui.expire(); await pending
    assert.equal(ui.requests[0].signal.aborted, true)
    assert.equal(ui.location.href, '/api/dashboard')
    assert.equal(ui.button.disabled, true); assert.equal(ui.next.hidden, false)
    assert.match(ui.notice.textContent, /couldn’t confirm/)
    await ui.submit(); assert.equal(ui.requests.length, 1)
  }
})
