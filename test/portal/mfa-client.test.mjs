import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { renderMfaPage } from '../../src/auth/mfa-page.ts'

const source = (await readFile(new URL('../../src/auth/mfa-client.js', import.meta.url), 'utf8'))
  .replace("import { startRegistration, startAuthentication } from '@simplewebauthn/browser'", '')
  .replace('export function mountMfaClient()', 'function mountMfaClient()')
const state = () => ({ securityVersion: 1, required: true, everEnabled: false, sessionVerified: false,
  manageVerified: false, administratorVerified: false, recoveryRemaining: 0, factors: [] })
const response = body => ({ status: 200, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(initial = state()) {
  const nodes = new Map(), events = new Map(), life = new Map(), requests = [], ceremonies = []
  const callbacks = { registration: async () => ({ id: 'synthetic-wire-registration' }), authentication: async () => ({ id: 'synthetic-wire-assertion' }) }
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false, dataset: {}, focus() {},
      querySelectorAll: () => [...nodes.values()].filter(n => n.id.startsWith('mfa-')),
      addEventListener: (type, callback) => events.set(type, callback), contains: () => true })
    return nodes.get(id)
  }
  const bootstrap = { userId: 'synthetic-user', sessionId: randomUUID(), formToken: 'synthetic-form-token', state: structuredClone(initial) }
  const window = { ATRIUM_MFA: bootstrap, addEventListener: (type, callback) => life.set(type, callback) }
  let transport = async () => { throw new Error('No synthetic reply configured') }
  runInNewContext(source, { window, document: { getElementById: node }, Date, AbortController,
    crypto: { randomUUID }, setTimeout, clearTimeout,
    startRegistration: async input => { ceremonies.push({ kind: 'registration', input }); return callbacks.registration(input) },
    startAuthentication: async input => { ceremonies.push({ kind: 'authentication', input }); return callbacks.authentication(input) },
    fetch: async (path, options) => { requests.push({ path, ...options, payload: JSON.parse(options.body) }); return transport(requests.at(-1)) },
  })
  const result = {
    node, bootstrap, requests, ceremonies, callbacks,
    reply(action, extra = {}, current = initial) { return response({ ok: true, userId: bootstrap.userId, sessionId: bootstrap.sessionId,
      action, state: structuredClone(current), ...extra }) },
    setTransport(fn) { transport = fn },
    click(action, factorId) {
      const control = { disabled: false, dataset: { action, ...(factorId ? { factorId } : {}) } }
      return events.get('click')({ target: { closest: () => control } })
    },
    submit() { return events.get('submit')({ target: { id: 'mfa-action-form' }, preventDefault() {} }) },
    hide() { life.get('pagehide')() },
  }
  return result
}
function options(f, kind = 'registration', extra = {}) {
  return f.reply(`${kind}-options`, { challengeId: randomUUID(), expiresAt: Date.now() + 300000,
    optionsJSON: kind === 'registration' ? { challenge: 'synthetic-challenge-at-least-sixteen', rp: { id: 'localhost' }, user: { id: 'opaque-handle' } }
      : { challenge: 'synthetic-challenge-at-least-sixteen', rpId: 'localhost' }, ...extra })
}
async function startSetup(f) {
  f.click('add'); f.node('mfa-password').value = 'Synthetic current password'; f.node('mfa-label').value = 'Device'
  f.setTransport(request => request.payload.action === 'password'
    ? f.reply('password', { reauthenticationId: randomUUID(), expiresAt: Date.now() + 300000 }) : options(f))
  await f.submit()
}

test('setup binds identity/action/CSRF and only an explicit ceremony click opens the browser prompt', async () => {
  const f = fixture()
  await startSetup(f)
  assert.equal(f.ceremonies.length, 0)
  assert.equal(f.requests.length, 2)
  assert.equal(f.node('mfa-password').value, '')
  for (const request of f.requests) {
    assert.equal(request.headers['x-atrium-account-action'], request.payload.action)
    assert.equal(request.headers['x-atrium-user-id'], f.bootstrap.userId)
    assert.equal(request.headers['x-atrium-session-id'], f.bootstrap.sessionId)
    assert.equal(request.headers['x-atrium-csrf'], f.bootstrap.formToken)
    assert.equal(request.redirect, 'error')
  }
  f.callbacks.registration = async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }) }
  await f.click('ceremony')
  assert.equal(f.ceremonies.length, 1)
  assert.equal(f.requests.length, 2, 'cancelled browser ceremony sends no claimed verification')
  assert.match(f.node('mfa-notice').textContent, /closed or timed out/)
})
test('unknown or foreign-session 200 locks the workflow without claiming success', async () => {
  for (const extra of [{ sessionId: randomUUID() }, { ok: false }, { action: 'wrong-action' }]) {
    const f = fixture(); f.click('add'); f.node('mfa-password').value = 'synthetic'; f.node('mfa-label').value = 'Device'
    f.setTransport(() => f.reply('password', { reauthenticationId: randomUUID(), expiresAt: Date.now() + 300000, ...extra }))
    await f.submit()
    assert.equal(f.node('mfa-next').hidden, false)
    assert.match(f.node('mfa-notice').textContent, /couldn’t confirm/)
    await f.click('add'); await f.submit()
    assert.equal(f.requests.length, 1)
  }
})
test('double submit cannot create two password reservations or overlapping browser prompts', async () => {
  const f = fixture(), pending = deferred()
  f.click('add'); f.node('mfa-password').value = 'synthetic'; f.node('mfa-label').value = 'Device'
  f.setTransport(() => pending.promise)
  const first = f.submit()
  await f.submit(); await f.click('ceremony')
  assert.equal(f.requests.length, 1); assert.equal(f.ceremonies.length, 0)
  pending.resolve({ status: 400, json: async () => ({ code: 'incorrect_password' }) })
  await first
  assert.match(f.node('mfa-notice').textContent, /password was not correct/)
})
test('registration saves an unfinished factor and does not claim verified access', async () => {
  const f = fixture(); await startSetup(f)
  const factorId = randomUUID(), next = state()
  next.factors = [{ id: factorId, label: 'Device', status: 'pending', createdAt: Date.now(), lastUsedAt: null }]
  f.setTransport(request => f.reply('registration-finish', { receipt: { challengeId: request.payload.challengeId,
    securityVersion: 1, factorId, outcome: 'factor_pending', assurance: null } }, next))
  await f.click('ceremony')
  assert.match(f.node('mfa-notice').textContent, /Complete its verification/)
  assert.match(f.node('mfa-task-content').innerHTML, /Verify new passkey/)
  assert.doesNotMatch(f.node('mfa-summary').innerHTML, /This session is verified/)
})
test('wrong challenge receipt cannot complete registration', async () => {
  const f = fixture(); await startSetup(f)
  f.setTransport(() => f.reply('registration-finish', { receipt: { challengeId: randomUUID(), securityVersion: 1,
    factorId: randomUUID(), outcome: 'factor_pending', assurance: null } }))
  await f.click('ceremony')
  assert.equal(f.node('mfa-next').hidden, false)
  assert.match(f.node('mfa-notice').textContent, /couldn’t confirm/)
})
test('raw recovery codes are shown once and cleared on dismissal or page retirement', async () => {
  const current = state(); current.everEnabled = true; current.sessionVerified = true; current.manageVerified = true
  current.factors = [{ id: randomUUID(), label: 'Device', status: 'active', createdAt: Date.now(), lastUsedAt: Date.now() }]
  for (const retire of ['dismiss', 'pagehide']) {
    const f = fixture(current), codes = Array.from({ length: 10 }, (_, index) => `${index.toString(16).padStart(8, '0')}-aaaaaaaa-bbbbbbbb-cccccccc`)
    f.click('rotate'); f.node('mfa-password').value = 'synthetic'
    f.setTransport(request => request.payload.action === 'password'
      ? f.reply('password', { reauthenticationId: randomUUID(), expiresAt: Date.now() + 300000 }, current)
      : f.reply('rotate-recovery', { requestId: request.payload.requestId, codes }, { ...current, recoveryRemaining: 10 }))
    await f.submit()
    assert.equal(f.node('mfa-recovery-codes').hidden, false)
    assert.match(f.node('mfa-codes').textContent, /aaaaaaaa-bbbbbbbb/)
    if (retire === 'dismiss') f.click('dismiss-codes'); else f.hide()
    assert.equal(f.node('mfa-codes').textContent, '')
    assert.equal(f.node('mfa-recovery-codes').hidden, true)
  }
})
test('server-rendered page escapes staff labels and projects only public security fields', () => {
  const current = state()
  current.factors.push({ id: randomUUID(), label: '</script><script>danger()</script>', status: 'pending',
    createdAt: Date.now(), lastUsedAt: null, publicKey: 'must-not-leak', credentialId: 'must-not-leak-either' })
  const html = renderMfaPage({ principal: { userId: 'synthetic', sessionId: randomUUID(), username: '<operator>', displayName: '<Operator>' },
    state: current, nonce: 'synthetic-nonce', formToken: 'synthetic' }, '/* bundled client */')
  assert.ok(html.includes('&lt;Operator&gt;'))
  assert.ok(!html.includes('<script>danger()'))
  assert.ok(!html.includes('must-not-leak'))
  assert.ok(html.includes('min-height:48px'))
})

test('a recovery response arriving after page retirement cannot redisplay codes', async () => {
  const current = state(); current.everEnabled = true; current.sessionVerified = true; current.manageVerified = true
  current.factors = [{ id: randomUUID(), label: 'Device', status: 'active', createdAt: Date.now(), lastUsedAt: Date.now() }]
  const f = fixture(current), pending = deferred(), started = deferred()
  f.click('rotate'); f.node('mfa-password').value = 'synthetic'
  f.setTransport(request => {
    if (request.payload.action === 'password') return f.reply('password', { reauthenticationId: randomUUID(), expiresAt: Date.now() + 300000 }, current)
    started.resolve(request); return pending.promise
  })
  const submission = f.submit(), request = await started.promise
  f.hide()
  assert.equal(request.signal.aborted, true)
  pending.resolve(f.reply('rotate-recovery', { requestId: request.payload.requestId,
    codes: Array.from({ length: 10 }, (_, i) => `${i.toString(16).padStart(8, '0')}-aaaaaaaa-bbbbbbbb-cccccccc`) }, { ...current, recoveryRemaining: 10 }))
  await submission
  assert.equal(f.node('mfa-codes').textContent, '')
  assert.equal(f.node('mfa-recovery-codes').hidden, true)
  assert.equal(f.node('mfa-next').hidden, false)
})

test('a browser prompt completing after page retirement cannot submit its result', async () => {
  const f = fixture(), pending = deferred()
  await startSetup(f)
  f.callbacks.registration = () => pending.promise
  const ceremony = f.click('ceremony')
  f.hide(); pending.resolve({ id: 'late-synthetic-credential' })
  await ceremony
  assert.equal(f.requests.length, 2, 'No registration-finish request from a retired document')
  assert.equal(f.node('mfa-task').hidden, true)
})

test('a replacement can be completed when ten existing keys are present', () => {
  const current = state(); current.everEnabled = true
  current.factors = Array.from({ length: 11 }, (_, index) => ({ id: randomUUID(), label: `Device ${index}`,
    status: index === 10 ? 'pending' : 'active', createdAt: Date.now(), lastUsedAt: null }))
  const f = fixture(current)
  assert.match(f.node('mfa-factors').innerHTML, /Complete setup/)
  assert.doesNotMatch(f.node('mfa-notice').textContent, /could not be loaded/)
  current.factors[10].status = 'active'
  assert.match(fixture(current).node('mfa-notice').textContent, /could not be loaded/)
})
