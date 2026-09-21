import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkDemoReadiness, parseReadinessArgs, READINESS_PATHS } from '../../scripts/lib/demo-readiness.mjs'

const origin = 'https://atrium.example'
const expectedContract = { version: 1, toolSchemaSha256: 'a'.repeat(64) }
const health = () => ({ ok: true, store: 'kv', durable: true, callHistory: true, voiceContract: expectedContract })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
const html = (value, status = 200) => new Response(value, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const signIn = '<html><body><form method="post" action="/api/dashboard"><input name="passcode" type="password"></form></body></html>'
const success = (path) => path === '/' ? html('<html><body>Sample building</body></html>')
  : path === '/api/health' ? json(health()) : path === '/api/dashboard' ? html(signIn, 401) : json({ error: 'unauthorized' }, 401)
const run = (override, options = {}) => checkDemoReadiness({ origin, expectedContract,
  fetchImpl: async (url, init) => override?.(url.pathname, init) ?? success(url.pathname), ...options })
const check = (result, id) => result.checks.find(value => value.id === id)

test('successful preflight performs exactly six credential-free GETs and explicitly leaves voice/writes unverified', async () => {
  const requests = []
  const result = await run((path, init) => { requests.push({ path, init }) })
  assert.equal(result.status, 'read_only_checks_passed')
  assert.deepEqual(requests.map(value => value.path), [...READINESS_PATHS])
  for (const { init } of requests) {
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error')
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'cache-control'])
    assert.equal(init.body, undefined); assert.ok(init.signal instanceof AbortSignal)
  }
  assert.equal(result.checks.length, 8)
  assert.match(result.scope, /not full demo, phone/)
  assert.match(result.unverified.join(' '), /Authenticated sign-in.*Vapi credit.*phone audio.*Booking.*Future uptime/)
  assert.equal('body' in check(result, 'storage'), false)
})

test('invalid origins and options fail before any request without repeating secret-bearing input', async () => {
  let calls = 0
  for (const value of [undefined, '', 'http://localhost:4300', 'https://user:SECRET@atrium.example',
    'https://atrium.example/path', 'https://atrium.example?token=SECRET', 'https://atrium.example#SECRET',
    ' https://atrium.example', 'https://atrium.example/../', 'https://atrium.example/.', 'https://atrium.example/%2e/',
    'https:atrium.example', 'https://atrium.example\\@evil.example', 'https://atrium.example\n']) {
    await assert.rejects(run(null, { origin: value, fetchImpl: () => { calls++; assert.fail('No network for invalid input') } }), error => {
      assert.doesNotMatch(error.message, /SECRET/); return true
    })
  }
  for (const timeoutMs of [0, 99, 30001, 1.5, '100', NaN, Infinity]) {
    await assert.rejects(run(null, { timeoutMs, fetchImpl: () => { calls++ } }), /Timeout/)
  }
  await assert.rejects(run(null, { expectedContract: { version: 1, toolSchemaSha256: 'bad' }, fetchImpl: () => { calls++ } }), /contract/)
  assert.equal(calls, 0)
})

test('health requires durable known storage and the exact source contract', async () => {
  for (const patch of [{ ok: false }, { durable: false }, { durable: 'true' }, { store: 'memory' }, { store: 'unknown' }]) {
    const result = await run(path => path === '/api/health' ? json({ ...health(), ...patch }) : undefined)
    assert.equal(result.status, 'read_only_checks_failed'); assert.equal(check(result, 'storage').status, 'fail')
  }
  for (const voiceContract of [undefined, { version: 2, toolSchemaSha256: expectedContract.toolSchemaSha256 }, { version: 1, toolSchemaSha256: 'b'.repeat(64) }]) {
    const result = await run(path => path === '/api/health' ? json({ ...health(), voiceContract }) : undefined)
    assert.equal(check(result, 'storage').status, 'pass'); assert.equal(check(result, 'backend_tool_contract').status, 'fail')
  }
})

test('missing global history configuration never proves live voice and is qualified for PostgreSQL', async () => {
  for (const callHistory of [false, undefined, 'true']) {
    const result = await run(path => path === '/api/health' ? json({ ...health(), store: 'postgres', callHistory }) : undefined)
    assert.equal(check(result, 'storage').status, 'pass')
    assert.equal(check(result, 'history_configuration').status, 'warn')
    assert.equal(result.status, 'read_only_checks_need_attention')
    assert.match(check(result, 'history_configuration').detail, /property configuration/)
  }
})

test('API protection must be the expected application JSON401 without a data payload', async () => {
  for (const bad of [() => html('Protected by host', 401), () => json({ error: 'unauthorized', profiles: [{ name: 'SECRET' }] }, 401),
    () => json({ error: 'unauthorized', scope: { propertyId: 'SECRET' } }, 401), () => json({ message: 'unauthorized' }, 401),
    () => json({ error: 'unauthorized' }, 200), () => json({ error: 'unauthorized' }, 403), () => json({ error: 'unauthorized' }, 503)]) {
    const result = await run(path => path === '/api/leads' ? bad() : undefined)
    assert.equal(check(result, 'access_leads').status, 'fail'); assert.equal(result.status, 'read_only_checks_failed')
    assert.doesNotMatch(JSON.stringify(result), /SECRET|Protected by host/)
  }
  const managed = await run(path => path === '/api/leads' ? json({ error: 'Authentication is required.', code: 'unauthenticated' }, 401) : undefined)
  assert.equal(check(managed, 'access_leads').status, 'pass')
})

test('login-page checking rejects host protection, incorrect actions and public200 responses', async () => {
  for (const response of [() => html('<html><body>Sign in to the hosting provider</body></html>', 401),
    () => html(signIn, 200), () => html(signIn.replace('/api/dashboard', 'https://other.example'), 401),
    () => html(signIn.replace('password', 'text'), 401), () => json({ error: 'unauthorized' }, 401)]) {
    const result = await run(path => path === '/api/dashboard' ? response() : undefined)
    assert.equal(check(result, 'sign_in_page').status, 'fail')
  }
})

test('login markers in data attributes, duplicate attributes and inert content cannot pass', async () => {
  const normal = await run(path => path === '/api/dashboard'
    ? html(`<html><head><title>Sign in — Atrium Operations</title><style>input{color:black}</style></head><body>${signIn}</body></html>`, 401) : undefined)
  assert.equal(check(normal, 'sign_in_page').status, 'pass')
  for (const value of [
    '<form method="get" action="https://other.example" data-method="post" data-action="/api/dashboard"><input name="passcode" type="text" data-type="password"></form>',
    signIn.replace('method="post"', 'method="post" method="get"'),
    signIn.replace('action="/api/dashboard"', 'data-action="/api/dashboard"'),
    signIn.replace('type="password"', 'data-type="password"'),
    signIn.replace('type="password"', 'type="password" type="text"'),
    `<!-- ${signIn} -->`, `<script>const sample = '${signIn}'</script>`, `<textarea>${signIn}</textarea>`,
    `<template><template></template>${signIn}</template>`, `<script>${signIn}`,
  ]) {
    const result = await run(path => path === '/api/dashboard' ? html(value, 401) : undefined)
    assert.equal(check(result, 'sign_in_page').status, 'fail')
  }
})

test('redirects are refused without following a new destination', async () => {
  let redirectCalls = 0
  const result = await run((path, init) => {
    if (path === '/api/health') {
      assert.equal(init.redirect, 'error'); redirectCalls++
      return new Response(null, { status: 307, headers: { location: 'https://other.example/?SECRET' } })
    }
  })
  assert.equal(redirectCalls, 1); assert.equal(check(result, 'backend').code, 'redirect_refused')
  assert.doesNotMatch(JSON.stringify(result), /SECRET|other.example/)
})

test('malformed JSON, content types and network errors are failures without private diagnostics', async () => {
  for (const response of [() => html('<html>SECRET provider error</html>'),
    () => new Response('{"SECRET":', { headers: { 'content-type': 'application/json' } }), () => json(health(), 503)]) {
    const result = await run(path => path === '/api/health' ? response() : undefined)
    assert.equal(result.status, 'read_only_checks_failed'); assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
  const failed = await run(path => { if (path === '/api/health') throw new Error('SECRET provider token') })
  assert.equal(check(failed, 'backend').code, 'request_failed'); assert.doesNotMatch(JSON.stringify(failed), /SECRET/)
})

test('oversized chunked responses are cancelled and limits count bytes rather than characters', async () => {
  let cancelled = false
  const result = await run(path => path === '/api/health' ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('€'.repeat(24000))) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'application/json' } }) : undefined)
  assert.equal(check(result, 'backend').code, 'response_too_large'); assert.equal(cancelled, true)
})

test('deadline covers stalled response bodies and cancels them after successful headers', async () => {
  let cancelled = false, signal
  const started = performance.now()
  const result = await run((path, init) => {
    if (path === '/api/health') {
      signal = init.signal
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
        cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
    }
  }, { timeoutMs: 100 })
  assert.equal(check(result, 'backend').code, 'timeout'); assert.equal(check(result, 'backend').httpStatus, 200)
  assert.equal(signal.aborted, true); assert.equal(cancelled, true)
  assert.ok(performance.now() - started < 2000)
})

test('a transport that never returns headers cannot keep the preflight running indefinitely', async () => {
  let signal
  const result = await run((path, init) => {
    if (path === '/') { signal = init.signal; return new Promise(() => {}) }
  }, { timeoutMs: 100 })
  assert.equal(check(result, 'website').code, 'timeout'); assert.equal(signal.aborted, true)
})

test('CLI rejects duplicate and unknown flags, reports help, and never echoes invalid credentials', () => {
  for (const args of [['--origin', origin, '--origin', origin], ['--origin', origin, '--secret', 'SECRET'],
    ['--origin'], ['--origin', origin, '--timeout-ms', '1e4'], ['--origin', origin, '--timeout-ms', '-1'], ['--help', '--json']]) {
    assert.throws(() => parseReadinessArgs(args))
  }
  assert.deepEqual(parseReadinessArgs(['--origin', origin, '--json']), { origin, timeoutMs: 10000, json: true })
  const script = fileURLToPath(new URL('../../scripts/demo-readiness.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0); assert.match(help.stdout, /No credentials, writes, calls or paid tests/)
  const bad = spawnSync(process.execPath, [script, '--origin', 'https://user:SECRET@atrium.example'], { encoding: 'utf8' })
  assert.equal(bad.status, 2); assert.doesNotMatch(bad.stdout + bad.stderr, /SECRET/)
})
