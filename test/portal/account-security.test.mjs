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

const sessionIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']
const principal = { userId: 'user-one', username: 'operator', displayName: 'Operator', credentialVersion: 1, kind: 'user',
  sessionId: sessionIds[0], sessionExpiresAt: Date.parse('2032-06-01T20:00:00Z') }
const sessions = sessionIds.map((id, index) => ({ id, userId: principal.userId, credentialVersion: 1, label: `Synthetic browser ${index + 1}`,
  createdAt: Date.parse('2032-06-01T12:00:00Z'), lastSeenAt: Date.parse('2032-06-01T12:00:00Z'), expiresAt: principal.sessionExpiresAt, revokedAt: null }))
const accountHtml = () => accountSecurityPage(principal, 'synthetic-form-token', 'synthetic-nonce', sessions)
const reply = (status, data) => ({ status, json: async () => data })

/** Execute the actual server-rendered script with synthetic credentials and transport. */
function accountForm(transport) {
  const html = accountHtml()
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  let submit, resets = 0, focused = false
  const elements = Object.fromEntries(['notice', 'save-password', 'current-password', 'new-password', 'confirm-password',
    'outcome', 'outcome-title', 'outcome-message', 'session-list', 'sign-out-others', 'session-notice', 'session-next', 'session-timezone'].map(id => [id, { textContent: '', dataset: {}, hidden: false, value: '' }]))
  elements['current-password'].value = 'previous synthetic password'
  elements['new-password'].value = elements['confirm-password'].value = 'replacement synthetic password'
  elements['save-password'].disabled = true
  elements.outcome.hidden = true
  elements.outcome.focus = () => { focused = true }
  elements['password-form'] = {
    dataset: { userId: principal.userId, sessionId: principal.sessionId, formToken: 'synthetic-form-token' }, hidden: false,
    addEventListener(name, fn) { assert.equal(name, 'submit'); submit = fn },
    reset() { resets++; for (const id of ['current-password', 'new-password', 'confirm-password']) elements[id].value = '' },
  }
  const rows = sessions.map(session => ({ dataset: { sessionId: session.id }, removed: false, remove() { this.removed = true } }))
  const controls = sessions.map(session => ({ dataset: { sessionId: session.id }, disabled: true,
    addEventListener(name, fn) { assert.equal(name, 'click'); this.click = fn } }))
  elements['sign-out-others'].addEventListener = function (name, fn) { assert.equal(name, 'click'); this.click = fn }
  elements['session-next'].hidden = true
  const document = { getElementById: id => elements[id], querySelectorAll(selector) {
    if (selector === '.session-revoke') return controls
    if (selector === '.session-row') return rows.filter(row => !row.removed)
    if (selector === '.sessions time') return []
    assert.fail(`Unexpected account selector ${selector}`)
  } }
  const requests = [], timers = new Map()
  let nextTimer = 0
  runInNewContext(script, { document, AbortController,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch: async (path, options) => { requests.push({ path, ...options }); return transport(path, options) } })
  assert.equal(typeof submit, 'function')
  return { elements, requests, controls, rows, revoke: target => target === 'others' ? elements['sign-out-others'].click() : controls.find(control => control.dataset.sessionId === target).click(), submit: () => submit({ preventDefault() {} }), resets: () => resets, focused: () => focused,
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
  assert.equal(ui.requests[0].headers['x-atrium-session-id'], principal.sessionId)
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


const sessionReceipt = (revokedIds, currentRevoked = false, fields = {}) => ({ status: 'sessions_revoked', userId: principal.userId,
  actingSessionId: principal.sessionId, revokedIds, currentRevoked, ...fields })

test('session controls send the rendered user, session and form proof; verified single receipt removes only its target', async () => {
  const target = sessionIds[1], ui = accountForm(() => reply(200, sessionReceipt([target])))
  await ui.revoke(target)
  const request = ui.requests[0]
  assert.equal(request.path, '/api/account')
  assert.equal(request.credentials, 'same-origin')
  assert.equal(request.redirect, 'error')
  assert.equal(request.headers['x-atrium-user-id'], principal.userId)
  assert.equal(request.headers['x-atrium-session-id'], principal.sessionId)
  assert.equal(request.headers['x-atrium-csrf'], 'synthetic-form-token')
  assert.equal(request.headers['x-atrium-account-action'], 'revoke-session')
  assert.deepEqual(JSON.parse(request.body), { action: 'revoke-session', sessionId: target })
  assert.deepEqual(ui.rows.filter(row => row.removed).map(row => row.dataset.sessionId), [target])
  assert.equal(ui.elements['session-notice'].textContent, 'The selected session is signed out.')
  assert.equal(ui.elements['password-form'].hidden, false)
  assert.equal(ui.elements['save-password'].disabled, false)
  assert.equal(ui.activeTimers(), 0)
})

test('verified revoke-others keeps the current row and a current-session receipt retires the password form', async () => {
  const ui = accountForm(() => reply(200, sessionReceipt(sessionIds.slice(1))))
  await ui.revoke('others')
  assert.deepEqual(JSON.parse(ui.requests[0].body), { action: 'revoke-other-sessions' })
  assert.equal(ui.requests[0].headers['x-atrium-account-action'], 'revoke-other-sessions')
  assert.deepEqual(ui.rows.filter(row => !row.removed).map(row => row.dataset.sessionId), [principal.sessionId])
  assert.equal(ui.elements['sign-out-others'].disabled, true)
  assert.match(ui.elements['session-notice'].textContent, /Reload to check for newer sign-ins/)
  const self = accountForm(() => reply(200, sessionReceipt([principal.sessionId], true)))
  await self.revoke(principal.sessionId)
  assert.equal(self.elements['password-form'].hidden, true)
  assert.equal(self.resets(), 1)
  assert.equal(self.elements['session-list'].hidden, true)
  assert.equal(self.elements['session-next'].hidden, false)
  assert.match(self.elements['session-notice'].textContent, /^This session is signed out/)
  await self.submit(); await self.revoke('others')
  assert.equal(self.requests.length, 1)
})

test('verified already-inactive own target receipt succeeds without pretending an unknown target was verified', async () => {
  const target = sessionIds[1], own = accountForm(() => reply(200, sessionReceipt([])))
  await own.revoke(target)
  assert.equal(own.rows.find(row => row.dataset.sessionId === target).removed, true)
  const unknown = accountForm(() => reply(400, { code: 'invalid_session', error: 'Choose a session from this account security page.' }))
  await unknown.revoke(target)
  assert.ok(unknown.rows.every(row => !row.removed))
  assert.match(unknown.elements['session-notice'].textContent, /couldn’t confirm/)
})

test('wrong identity, stale acting session, malformed and contradictory receipts never claim sign-out', async () => {
  const target = sessionIds[1]
  for (const payload of [
    {}, sessionReceipt([target], false, { userId: 'other-user' }),
    sessionReceipt([target], false, { actingSessionId: sessionIds[2] }),
    sessionReceipt([target], true), sessionReceipt([sessionIds[2]]), sessionReceipt([target, target]),
    sessionReceipt(['not-a-session']), sessionReceipt([target], false, { currentRevoked: 'false' }),
  ]) {
    const ui = accountForm(() => reply(200, payload))
    await ui.revoke(target)
    assert.ok(ui.rows.every(row => !row.removed))
    assert.match(ui.elements['session-notice'].textContent, /couldn’t confirm/)
    assert.equal(ui.elements['session-next'].hidden, false)
    assert.equal(ui.elements['save-password'].disabled, true)
    assert.ok(ui.controls.every(control => control.disabled))
    await ui.revoke(target); await ui.submit()
    assert.equal(ui.requests.length, 1)
  }
  const self = accountForm(() => reply(200, sessionReceipt([])))
  await self.revoke(principal.sessionId)
  assert.match(self.elements['session-notice'].textContent, /couldn’t confirm/)
  assert.equal(self.elements['password-form'].hidden, false, 'an empty receipt cannot claim the active current session was revoked')
})

test('a pending session change blocks double clicks and password submits; lost or stale responses require reload', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const pending = accountForm(() => waiting)
  const first = pending.revoke(sessionIds[1])
  await pending.revoke(sessionIds[2]); await pending.submit()
  assert.equal(pending.requests.length, 1)
  release(reply(503, { code: 'session_unavailable' })); await first
  assert.match(pending.elements['session-notice'].textContent, /couldn’t confirm/)
  for (const response of [() => { throw new Error('response lost') }, () => reply(409, { code: 'account_changed' }),
    () => ({ status: 200, json: async () => { throw new Error('response unreadable') } })]) {
    const ui = accountForm(response)
    await ui.revoke(sessionIds[1])
    assert.ok(ui.rows.every(row => !row.removed))
    assert.equal(ui.elements['session-next'].hidden, false)
    assert.equal(ui.elements['save-password'].disabled, true)
    await ui.revoke(sessionIds[1]); await ui.submit()
    assert.equal(ui.requests.length, 1)
  }
})

test('session request timeout aborts and retires controls without a blind retry', async () => {
  const ui = accountForm((path, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
  const pending = ui.revoke(sessionIds[1])
  ui.expireRequest(); await pending
  assert.equal(ui.requests[0].signal.aborted, true)
  assert.match(ui.elements['session-notice'].textContent, /couldn’t confirm/)
  assert.ok(ui.rows.every(row => !row.removed))
  await ui.revoke(sessionIds[1]); await ui.submit()
  assert.equal(ui.requests.length, 1)
  assert.equal(ui.activeTimers(), 0)
})
