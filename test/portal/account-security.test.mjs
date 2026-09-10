import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { accountSecurityPage } from '../../src/auth/account-page.ts'

const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const index = await readFile(new URL('../../ops/src/index.html', import.meta.url), 'utf8')

/** Render the real Status view without booting polling or issuing requests. */
function statusPage({ mode = 'postgres', permissions = ['read', 'operate'], mobile = false, account } = {}) {
  const window = {
    ATRIUM_RUNTIME_MODE: mode,
    ATRIUM_ACCOUNT: account === null ? undefined : account || { username: 'operator', displayName: 'Operator', userId: 'user-one' },
    ATRIUM_PROPERTY: mode === 'postgres' ? {
      organizationId: 'organization-one', propertyId: 'property-one', buildingName: 'Lake House',
      locationLabel: 'Chicago, IL', timeZone: 'America/Chicago', configurationVersion: 7,
      permissionVersion: 'permissions-v3', permissions, hours: {}, leasingPhone: null, leasingPhoneDisplay: null,
    } : undefined,
  }
  const document = {
    readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, body: { textContent: '', classList: { toggle() {}, add() {}, remove() {} } },
  }
  const context = {
    window, document, Intl, Date, console, URLSearchParams, structuredClone, setTimeout, clearTimeout,
    setInterval, clearInterval, matchMedia: () => ({ matches: mobile }), location: { hash: '#/status' },
    fetch() { assert.fail('Account navigation must not require a property request') },
  }
  runInNewContext(source.replace('window.Atrium = {', 'window.statusViewForTest = statusView; window.Atrium = {'), context)
  const root = { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [] }
  const view = window.statusViewForTest
  view.root = root
  view.render(window.Atrium.state)
  const signedIn = root.innerHTML.match(/<section class="status-section"><h2>Signed in<\/h2>[\s\S]*?<\/section>/)?.[0]
  assert.ok(signedIn)
  return { signedIn, app: window.Atrium, view }
}

test('PostgreSQL operators and viewers get property-independent account navigation', () => {
  for (const permissions of [['read', 'operate'], ['read']]) {
    const { signedIn, view } = statusPage({ permissions })
    const anchor = signedIn.match(/<a\b[^>]*>Account security<\/a>/)?.[0]
    assert.ok(anchor)
    assert.match(anchor, /href="\/api\/account"/)
    assert.doesNotMatch(anchor, /data-write|data-permission|organization|property|\?|target=/)
    assert.match(signedIn, /data-action="signout"/)
    // The view delegates buttons only; a real anchor retains native full-page navigation.
    view.onClick({ target: { closest: selector => { assert.equal(selector, 'button[data-action]'); return null } },
      preventDefault() { assert.fail('Account navigation must not be intercepted') } })
  }
})

test('legacy named accounts and shared-passcode sessions omit personal password navigation', () => {
  for (const account of [{ username: 'legacy-operator', displayName: 'Legacy workspace', tenantId: 'legacy-example' }, null]) {
    const { signedIn } = statusPage({ mode: 'legacy', account })
    assert.doesNotMatch(signedIn, /Account security|\/api\/account/)
    assert.match(signedIn, /data-action="signout"/)
  }
})

test('the shared mobile Status tab reaches account security without a property write permission', () => {
  const statusHref = index.match(/<a class="nav-item" href="([^"]+)" data-view="status"/)?.[1]
  const { signedIn, app } = statusPage({ mobile: true, permissions: ['read'] })
  assert.equal(statusHref, '#/status')
  assert.equal(app.route().name, 'status')
  assert.equal(app.can('operate'), false)
  assert.match(signedIn, /href="\/api\/account"[^>]*>Account security<\/a>/)
})

const principal = { userId: 'user-one', username: 'operator', displayName: 'Operator', credentialVersion: 1, kind: 'user' }
const accountHtml = () => accountSecurityPage(principal, 'synthetic-form-token', 'synthetic-nonce')
const reply = (status, data) => ({ status, json: async () => data })

/** Execute the actual server-rendered script with synthetic credentials and transport. */
function accountForm(transport) {
  const html = accountHtml()
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  let submit, resets = 0, focused = false
  const elements = Object.fromEntries(['notice', 'save-password', 'current-password', 'new-password', 'confirm-password',
    'outcome', 'outcome-title', 'outcome-message'].map(id => [id, { textContent: '', dataset: {}, hidden: false, value: '' }]))
  elements['current-password'].value = 'previous synthetic password'
  elements['new-password'].value = elements['confirm-password'].value = 'replacement synthetic password'
  elements['save-password'].disabled = true
  elements.outcome.hidden = true
  elements.outcome.focus = () => { focused = true }
  elements['password-form'] = {
    dataset: { userId: principal.userId, formToken: 'synthetic-form-token' }, hidden: false,
    addEventListener(name, fn) { assert.equal(name, 'submit'); submit = fn },
    reset() { resets++; for (const id of ['current-password', 'new-password', 'confirm-password']) elements[id].value = '' },
  }
  const requests = [], timers = new Map()
  let nextTimer = 0
  runInNewContext(script, { document: { getElementById: id => elements[id] }, AbortController,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch: async (path, options) => { requests.push({ path, ...options }); return transport(path, options) } })
  assert.equal(typeof submit, 'function')
  return { elements, requests, submit: () => submit({ preventDefault() {} }), resets: () => resets, focused: () => focused,
    activeTimers: () => timers.size,
    expireRequest() {
      assert.equal(timers.size, 1)
      const [id, timer] = [...timers][0]
      assert.equal(timer.delay, 15000)
      timers.delete(id)
      timer.callback()
    },
  }
}

test('password form cannot send named credentials through a JavaScript-disabled GET', () => {
  const html = accountHtml()
  const form = html.match(/<form\b[^>]*>/)?.[0]
  const button = html.match(/<button\b[^>]*id="save-password"[^>]*>/)?.[0]
  assert.match(form, /method="post"/i)
  assert.match(form, /action="\/api\/account"/)
  assert.match(button, /\bdisabled\b/)
  const ui = accountForm(() => assert.fail('Installing the handler must not submit credentials'))
  assert.equal(ui.elements['save-password'].disabled, false)
  assert.equal(ui.requests.length, 0)
})

test('unreadable, malformed, wrong-user, server-error and lost responses never claim a changed password', async () => {
  const outcomes = [
    () => ({ status: 200, json: async () => { throw new SyntaxError('unreadable response') } }),
    () => reply(200, {}),
    () => reply(200, { status: 'password_changed', userId: 'another-user' }),
    () => reply(503, { error: 'temporarily unavailable' }),
    () => { throw new Error('connection lost after write') },
  ]
  for (const transport of outcomes) {
    const ui = accountForm(transport)
    await ui.submit()
    assert.equal(ui.elements['outcome-title'].textContent, 'Check your sign-in')
    assert.match(ui.elements['outcome-message'].textContent, /couldn’t confirm whether your password changed/)
    assert.equal(ui.elements['password-form'].hidden, true)
    assert.equal(ui.elements.outcome.hidden, false)
    assert.equal(ui.resets(), 1)
    assert.equal(ui.focused(), true)
    await ui.submit()
    assert.equal(ui.requests.length, 1, 'An uncertain completed attempt must not silently retry')
  }
})

test('one verified successful receipt confirms the rendered identity and retires the form', async () => {
  const ui = accountForm(() => reply(200, { status: 'password_changed', userId: principal.userId }))
  await ui.submit()
  assert.equal(ui.elements['outcome-title'].textContent, 'Password changed')
  assert.equal(ui.elements['password-form'].hidden, true)
  assert.equal(ui.resets(), 1)
  assert.equal(ui.requests[0].path, '/api/account')
  assert.equal(ui.requests[0].credentials, 'same-origin')
  assert.equal(ui.requests[0].redirect, 'error')
  assert.equal(ui.requests[0].headers['x-atrium-user-id'], principal.userId)
  assert.equal(ui.requests[0].headers['x-atrium-csrf'], 'synthetic-form-token')
  assert.equal(ui.requests[0].headers['x-atrium-property-id'], undefined)
  assert.deepEqual(Object.keys(JSON.parse(ui.requests[0].body)).sort(), ['action', 'currentPassword', 'newPassword'])
  await ui.submit()
  assert.equal(ui.requests.length, 1)
})

test('duplicate submits while a password change is pending send only one request', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = accountForm(() => pending)
  const first = ui.submit()
  assert.equal(ui.elements['save-password'].disabled, true)
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(ui.elements[id].disabled, true)
  await ui.submit()
  assert.equal(ui.requests.length, 1)
  release(reply(200, { status: 'password_changed', userId: principal.userId }))
  await first
  assert.equal(ui.elements['outcome-title'].textContent, 'Password changed')
  assert.equal(ui.activeTimers(), 0)
})

test('a request or response-body timeout retires the form without claiming success or retrying', async () => {
  const untilAbort = signal => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  for (const phase of ['request', 'response-body']) {
    const ui = accountForm((path, { signal }) => phase === 'request'
      ? untilAbort(signal) : { status: 200, json: () => untilAbort(signal) })
    const submitted = ui.submit()
    assert.equal(ui.elements['save-password'].disabled, true)
    ui.expireRequest()
    await submitted
    assert.equal(ui.requests[0].signal.aborted, true)
    assert.equal(ui.elements['outcome-title'].textContent, 'Check your sign-in')
    assert.match(ui.elements['outcome-message'].textContent, /couldn’t confirm whether your password changed/)
    assert.equal(ui.elements['password-form'].hidden, true)
    assert.equal(ui.resets(), 1)
    assert.equal(ui.activeTimers(), 0)
    await ui.submit()
    assert.equal(ui.requests.length, 1)
  }
})

test('known rejected credentials allow a deliberate corrected retry before verified success', async () => {
  let count = 0
  const ui = accountForm(() => ++count === 1
    ? reply(400, { code: 'incorrect_password', error: 'Your current password was not correct.' })
    : reply(200, { status: 'password_changed', userId: principal.userId }))
  await ui.submit()
  assert.equal(ui.elements['password-form'].hidden, false)
  assert.equal(ui.elements['save-password'].disabled, false)
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(ui.elements[id].disabled, false)
  assert.equal(ui.elements['save-password'].textContent, 'Change password')
  assert.equal(ui.elements.outcome.hidden, true)
  assert.equal(ui.resets(), 0)
  assert.match(ui.elements.notice.textContent, /current password was not correct/)
  ui.elements['current-password'].value = 'corrected synthetic password'
  await ui.submit()
  assert.equal(ui.requests.length, 2)
  assert.equal(JSON.parse(ui.requests[1].body).currentPassword, 'corrected synthetic password')
  assert.equal(ui.elements['outcome-title'].textContent, 'Password changed')
})
