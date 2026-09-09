import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createSimulationSandbox } from '../sandbox.ts'
import { simulationEnvironment } from '../isolation.ts'
import { VapiBridge } from '../bridge.ts'
import { runScenario } from '../runner.ts'
import { anthropicModel } from '../anthropic.ts'
import type { Model, Webhook } from '../types.ts'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

test('live-configured parent cannot make real handler simulations access operational endpoints', async () => {
  const endpoint = 'http://127.0.0.1:1'
  Object.assign(process.env, { NODE_ENV: 'production', VERCEL: '1', KV_REST_API_URL: endpoint,
    KV_REST_API_TOKEN: 'configured-operation-token', VAPI_API_KEY: 'configured-vapi-key', VAPI_PRIVATE_KEY: 'configured-private-key',
    VAPI_SERVER_BASE_URL: endpoint, VAPI_WEBHOOK_SECRET: 'configured-live-secret', VAPI_ASSISTANT_ID: 'configured-live-assistant',
    OPS_ACCOUNTS_JSON: 'invalid-live-account-config', OPS_SESSION_SECRET: 'configured-live-session-secret',
    ANTHROPIC_API_KEY: 'configured-model-key', SMTP_URL: endpoint, RESEND_API_KEY: 'configured-email-key', DATABASE_URL: endpoint })
  const saved = { ...process.env }
  const sandboxes = []
  try {
    const a = await createSimulationSandbox(), b = await createSimulationSandbox()
    sandboxes.push(a, b)
    assert.notEqual(a.tenantId, b.tenantId)
    const callId = 'same-call-in-independent-sessions'
    const bridgeA = new VapiBridge(a.webhook), bridgeB = new VapiBridge(b.webhook)
    for (const [bridge, name] of [[bridgeA, 'Alpha'], [bridgeB, 'Bravo']] as const) {
      const result = await bridge.toolCalls(callId, [{ id: 'contact', name: 'capture_contact',
        input: { name, phone: '+15165550123', excerpt: `My name is ${name} and my number is 516 555 0123.` } }])
      assert.doesNotMatch(result.get('contact')!, /could not verify/i)
    }
    const slots = await bridgeA.toolCalls(callId, [{ id: 'slots', name: 'list_tour_slots', input: {} }])
    const slotId = slots.get('slots')!.match(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)?.[0]
    assert.ok(slotId, slots.get('slots'))
    const booking = await bridgeA.toolCalls(callId, [{ id: 'booking', name: 'book_tour', input: { slotId, prospectName: 'Alpha' } }])
    assert.match(booking.get('booking')!, /all set/)
    await bridgeA.endOfCall(callId, new Date(Date.now() - 60_000), new Date())
    let first = await a.inspect(), second = await b.inspect()
    assert.equal(first.storage.kind, 'memory')
    assert.equal(first.calendar.bookings.length, 1)
    assert.equal(second.calendar.bookings.length, 0)
    assert.equal((first.documents[`call-receipt:${callId}`] as any).status, 'complete')
    assert.equal(second.documents[`call-receipt:${callId}`], undefined)
    await bridgeB.endOfCall(callId, new Date(Date.now() - 60_000), new Date())
    second = await b.inspect()
    assert.equal((first.documents['lead:+15165550123'] as any).name, 'Alpha')
    assert.equal((second.documents['lead:+15165550123'] as any).name, 'Bravo')
    assert.ok(first.events.some(event => event.kind === 'tour_booked'))
    assert.ok(!second.events.some(event => event.kind === 'tour_booked'))
    assert.equal(first.networkAttempts + second.networkAttempts, 0)
    const c = await createSimulationSandbox()
    sandboxes.push(c)
    assert.deepEqual((await c.inspect()).documents, {})
    const changedKeys = [...new Set([...Object.keys(process.env), ...Object.keys(saved)])]
      .filter(key => process.env[key] !== saved[key])
    assert.deepEqual(changedKeys, [], 'the worker must not mutate the live parent environment')
  } finally {
    await Promise.all(sandboxes.map(sandbox => sandbox.close()))
  }
})

test('a scripted off-phone scenario completes through the isolated real handler and receipt path', async () => {
  const sandbox = await createSimulationSandbox()
  let round = 0
  const assistant: Model = { create: async () => ++round === 1 ? {
    content: [{ type: 'tool_use', id: 'contact', name: 'capture_contact', input: { name: 'Test Visitor', phone: '+15165550124', excerpt: 'I am Test Visitor, 516 555 0124.' } }], stop_reason: 'tool_use',
  } : { content: [{ type: 'text', text: 'Thanks. Goodbye.' }], stop_reason: 'end_turn' } }
  const caller: Model = { create: async () => ({ content: [{ type: 'text', text: 'I am Test Visitor, 516 555 0124.' }], stop_reason: 'end_turn' }) }
  try {
    const run = await runScenario({ scenario: { id: 'isolated-test', title: 'Scripted fixture', goal: 'capture contact', persona: 'test', expect: {} },
      assistant, caller, assistantModel: 'scripted', callerModel: 'scripted', system: 'fixture', tools: [], firstMessage: 'Hello.', webhook: sandbox.webhook })
    assert.equal(run.endedBy, 'assistant')
    assert.equal((await sandbox.inspect()).documents[`call-receipt:${run.callId}`] && true, true)
  } finally { await sandbox.close() }
  await assert.rejects(sandbox.inspect(), /CLOSED/)
})

test('network guards block actual KV/Vapi clients and Node network transports before any request', async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { denyOperationalNetwork } = await import(workerData.isolation);
      const guard = denyOperationalNetwork();
      const { KvDocumentStore } = await import(workerData.documents);
      const { fetchCalls } = await import(workerData.calls);
      const blocked = [];
      for (const [name, fn] of [
        ['kv', () => new KvDocumentStore('http://127.0.0.1:1', 'test').set('lead:x', {})],
        ['fetch', () => fetch('http://127.0.0.1:1')],
        ['http', () => require('node:http').get('http://127.0.0.1:1')],
        ['https', () => require('node:https').request('https://127.0.0.1:1')],
        ['net', () => require('node:net').connect(1, '127.0.0.1')],
        ['socket', () => new (require('node:net').Socket)().connect(1, '127.0.0.1')],
        ['tls', () => require('node:tls').connect(1, '127.0.0.1')],
        ['dgram', () => require('node:dgram').createSocket('udp4')],
      ]) { try { await fn(); } catch (error) { blocked.push([name, error.message]); } }
      const vapi = await fetchCalls({ apiKey: 'test', assistantIds: ['test-assistant'] });
      parentPort.postMessage({ blocked, vapiOk: vapi.ok, attempts: guard.attempts() });
    })().catch(() => parentPort.postMessage({ error: true }));
  `, { eval: true, env: simulationEnvironment(), execArgv: ['--experimental-strip-types'], workerData: {
    isolation: new URL('../isolation.ts', import.meta.url).href,
    documents: new URL('../../store/documents.ts', import.meta.url).href,
    calls: new URL('../../ops/vapi-calls.ts', import.meta.url).href,
  } })
  try {
    const result: any = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    assert.equal(result.error, undefined)
    assert.equal(result.blocked.length, 8)
    assert.ok(result.blocked.every(([, error]: string[]) => error === 'SIMULATION_NETWORK_DENIED'))
    assert.equal(result.vapiOk, false)
    assert.equal(result.attempts, 9)
  } finally { await worker.terminate() }
})

test('worker refuses inherited operational environment instead of importing the handler', async () => {
  const worker = new Worker(new URL('../sandbox-worker.ts', import.meta.url), { env: { ...simulationEnvironment(), KV_REST_API_TOKEN: 'unsafe' },
    execArgv: ['--experimental-strip-types'] })
  try {
    const error = await new Promise<Error>(resolve => worker.once('error', resolve))
    assert.match(error.message, /SIMULATION_UNSAFE_ENVIRONMENT/)
  } finally { await worker.terminate() }
})

test('bridge treats rejected transcripts, missing tool answers and failed receipts as failed simulations', async () => {
  for (const status of [401, 403, 500, 503]) {
    const failure: Webhook = async (_req, res) => { res.status(status); res.json({ error: 'private payload' }) }
    const bridge = new VapiBridge(failure)
    await assert.rejects(bridge.transcript('x', 'hello'), new RegExp(`HTTP ${status}`))
    await assert.rejects(bridge.toolCalls('x', [{ id: 'x', name: 'test', input: {} }]), new RegExp(`HTTP ${status}`))
    await assert.rejects(bridge.endOfCall('x', new Date(), new Date()), new RegExp(`HTTP ${status}`))
  }
  const empty: Webhook = async (_req, res) => { res.status(200); res.json({ results: [] }) }
  await assert.rejects(new VapiBridge(empty).toolCalls('x', [{ id: 'x', name: 'test', input: {} }]), /omitted a tool result/)
})

test('preflight works without model credentials, preserves scenario listing and refuses unknown scenarios', async () => {
  const run = promisify(execFile)
  const cli = new URL('../../../scripts/simulate-calls.mjs', import.meta.url)
  const env = { ...process.env, ANTHROPIC_API_KEY: '', NODE_ENV: 'production', VERCEL: '1', KV_REST_API_TOKEN: 'configured-operation-token' }
  for (const flag of ['--preflight', '--dry-run']) {
    const result = await run(process.execPath, [cli.pathname, flag, '--scenario', 'evan'], { env })
    assert.match(result.stdout, /memory; operational network attempts: 0/)
    assert.match(result.stdout, /evan/)
    assert.match(result.stdout, /Model conversations and grading were not run/)
    assert.doesNotMatch(result.stdout + result.stderr, /configured-operation-token/)
  }
  const list = await run(process.execPath, [cli.pathname, '--list'], { env })
  assert.match(list.stdout, /gas-smell/)
  await assert.rejects(run(process.execPath, [cli.pathname, '--preflight', '--scenario', 'unknown'], { env }), { code: 2 })
})

test('model adapter pins its endpoint, strips alternate auth and suppresses sensitive provider errors', async () => {
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'model-test-key', ANTHROPIC_AUTH_TOKEN: 'unused-token', ANTHROPIC_LOG: 'debug' })
  let count = 0
  globalThis.fetch = async (input, init) => {
    count++
    assert.equal(new URL(String(input)).origin, 'https://api.anthropic.com')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-api-key'), 'model-test-key')
    assert.equal(headers.get('authorization'), null)
    assert.equal(init?.redirect, 'error')
    return new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
  }
  const model = anthropicModel()
  assert.equal((await model.create({ model: 'scripted', max_tokens: 5, messages: [] })).content[0]?.type, 'text')
  assert.equal(count, 1)
  process.env.ANTHROPIC_BASE_URL = 'https://untrusted.invalid'
  assert.throws(() => anthropicModel(), /endpoint overrides/)
  delete process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-sensitive: do-not-forward'
  assert.throws(() => anthropicModel(), /custom headers/)
  const failing = anthropicModel({ messages: { create: async () => { throw new Error('secret-provider-details') } } } as any)
  await assert.rejects(failing.create({ model: 'scripted', max_tokens: 5, messages: [] }), error =>
    error instanceof Error && !error.message.includes('secret-provider-details') && error.message.includes('model request failed'))
})
