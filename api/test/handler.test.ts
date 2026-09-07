import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

/**
 * Drives the actual request handler the way Vapi does, against fixture data.
 *
 * The unit tests cover each guard in isolation; this covers the wiring — payload shapes,
 * webhook verification, per-call state, and the failure path. A guard that works perfectly
 * but is never reached because the tool name did not parse is still a broken product.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures')
let handler: (req: any, res: any) => Promise<void>
let originalCwd: string

/** The dashboard passcode these tests sign in with. Reading the log requires one. */
const OPS_PASSCODE = 'test-operations-passcode'

before(async () => {
  originalCwd = process.cwd()
  process.chdir(FIXTURES)
  process.env.OPS_DASHBOARD_PASSCODE = OPS_PASSCODE
  handler = (await import('../vapi.ts')).default
})

after(() => {
  process.chdir(originalCwd)
  delete process.env.OPS_DASHBOARD_PASSCODE
})

function mockRes() {
  const r: any = {
    code: 0, body: null, headers: {} as Record<string, string>,
    status(c: number) { r.code = c; return r },
    json(b: unknown) { r.body = b; return r },
    setHeader(k: string, v: string) { r.headers[k] = v; return r },
  }
  return r
}

/** Reads the operations log the way a signed-in operator does. */
async function readLog(headers: Record<string, string> = { 'x-ops-passcode': OPS_PASSCODE }) {
  const res = mockRes()
  await handler({ method: 'GET', headers }, res)
  return res
}

async function toolCall(name: string, args: Record<string, unknown>, callId: string, headers: Record<string, string> = {}) {
  const res = mockRes()
  await handler({
    method: 'POST', headers,
    body: { message: { type: 'tool-calls', call: { id: callId }, toolCallList: [{ id: 'tc1', name, arguments: args }] } },
  }, res)
  return { res, result: res.body?.results?.[0]?.result as string | undefined }
}

describe('webhook verification', () => {
  test('rejects an unsigned request when a secret is configured', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'test-secret'
    const { res } = await toolCall('check_availability', {}, 'auth-1')
    assert.equal(res.code, 401)
    delete process.env.VAPI_WEBHOOK_SECRET
  })

  test('accepts a correctly signed request', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'test-secret'
    const { res } = await toolCall('check_availability', {}, 'auth-2', { 'x-vapi-secret': 'test-secret' })
    assert.equal(res.code, 200)
    delete process.env.VAPI_WEBHOOK_SECRET
  })

  test('accepts requests when no secret is set, so a demo works before one is configured', async () => {
    const { res } = await toolCall('check_availability', {}, 'auth-3')
    assert.equal(res.code, 200)
  })
})

describe('payload shapes Vapi actually sends', () => {
  test('parses arguments delivered as a JSON string', async () => {
    const res = mockRes()
    await handler({
      method: 'POST', headers: {},
      body: { message: { type: 'tool-calls', call: { id: 'shape-1' },
        toolCallList: [{ id: 'tc1', function: { name: 'capture_signal',
          arguments: JSON.stringify({ signal: 'budget', value: '4000', excerpt: 'four thousand' }) } }] } },
    }, res)
    assert.equal(res.code, 200)
    assert.match(String(res.body.results[0].result), /Got it/)
  })

  test('parses a body delivered as a raw string', async () => {
    const res = mockRes()
    await handler({
      method: 'POST', headers: {},
      body: JSON.stringify({ message: { type: 'tool-calls', call: { id: 'shape-2' },
        toolCallList: [{ id: 'tc1', name: 'check_availability', arguments: {} }] } }),
    }, res)
    assert.equal(res.code, 200)
  })

  test('an unknown tool name does not crash the call', async () => {
    const { res, result } = await toolCall('no_such_tool', {}, 'shape-3')
    assert.equal(res.code, 200)
    assert.match(String(result), /Unknown tool/)
  })
})

describe('per-call state does not leak between callers', () => {
  test('one caller qualifying does not unlock quoting for another', async () => {
    await toolCall('capture_signal', { signal: 'bedrooms', value: '1', excerpt: 'one bed' }, 'leak-a')
    await toolCall('capture_signal', { signal: 'budget', value: '5000', excerpt: 'five thousand' }, 'leak-a')
    const a = await toolCall('check_availability', {}, 'leak-a')
    assert.match(String(a.result), /quote exactly these/)

    const b = await toolCall('check_availability', {}, 'leak-b')
    assert.match(String(b.result), /Do NOT state any rent/i,
      'a second caller must start unqualified')
  })
})

describe('the emergency path runs on caller transcripts, not just tool calls', () => {
  test('a gas mention on a transcript event is logged and escalated', async () => {
    const res = mockRes()
    await handler({
      method: 'POST', headers: {},
      body: { message: { type: 'transcript', role: 'user', transcript: 'hang on, I smell gas', call: { id: 'emerg-1' } } },
    }, res)
    assert.equal(res.code, 200)

    const g = await readLog()
    const events = g.body.events.filter((e: any) => e.callId === 'emerg-1')
    assert.ok(events.some((e: any) => e.kind === 'emergency' && e.emergencyKind === 'gas'))
    assert.ok(events.some((e: any) => e.kind === 'escalated'))
  })

  test('an agent transcript is not screened as if the caller said it', async () => {
    const res = mockRes()
    await handler({
      method: 'POST', headers: {},
      body: { message: { type: 'transcript', role: 'assistant', transcript: 'we do not allow gas grills', call: { id: 'emerg-2' } } },
    }, res)
    const g = await readLog()
    assert.ok(!g.body.events.some((e: any) => e.callId === 'emerg-2' && e.kind === 'emergency'))
  })
})

/**
 * The log holds prospect names, email addresses, budget ceilings and the caller's own
 * words. It shipped readable by anyone who guessed the URL; these tests are the boundary
 * that stops it going back.
 */
describe('the operations log is gated', () => {
  test('a signed-in operator gets the log, uncacheable and unindexable', async () => {
    const res = await readLog()
    assert.equal(res.code, 200)
    assert.ok(Array.isArray(res.body.events))
    assert.match(res.headers['cache-control'], /no-store/)
    assert.match(res.headers['x-robots-tag'], /noindex/)
  })

  test('an anonymous request gets 401 and no events at all', async () => {
    const res = await readLog({})
    assert.equal(res.code, 401)
    assert.equal(res.body.events, undefined, 'not even a redacted copy')
    assert.deepEqual(Object.keys(res.body), ['error'])
  })

  test('a wrong passcode is not close enough', async () => {
    const res = await readLog({ 'x-ops-passcode': `${OPS_PASSCODE}x` })
    assert.equal(res.code, 401)
    assert.equal(res.body.events, undefined)
  })

  test('the Vapi webhook secret does not open the log', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'machine-secret'
    const res = await readLog({ 'x-vapi-secret': 'machine-secret' })
    delete process.env.VAPI_WEBHOOK_SECRET
    assert.equal(res.code, 401)
  })

  test('no passcode configured closes the log rather than opening it', async () => {
    delete process.env.OPS_DASHBOARD_PASSCODE
    const res = await readLog({})
    process.env.OPS_DASHBOARD_PASSCODE = OPS_PASSCODE
    assert.equal(res.code, 503)
    assert.equal(res.body.events, undefined)
    assert.match(res.body.error, /OPS_DASHBOARD_PASSCODE/)
  })

  test('the personal fields are still there for an authorised reader', async () => {
    await toolCall('capture_signal',
      { signal: 'budget', value: '4200', excerpt: 'up to about forty-two hundred' }, 'gate-1')
    const res = await readLog()
    const captured = res.body.events.find(
      (e: any) => e.callId === 'gate-1' && e.kind === 'signal_captured')
    assert.equal(captured.excerpt, 'up to about forty-two hundred',
      'the gate protects the evidence trail, it does not delete it')
  })

  test('other methods are rejected', async () => {
    const res = mockRes()
    await handler({ method: 'DELETE', headers: {} }, res)
    assert.equal(res.code, 405)
  })
})

describe('failures never drop the call', () => {
  test('a malformed body returns 200 with something safe to say, not a 500', async () => {
    const res = mockRes()
    await handler({ method: 'POST', headers: {}, body: 'not json at all' }, res)
    assert.equal(res.code, 200, 'a 500 to Vapi drops the call on the caller')
    assert.match(String(res.body.results[0].result), /call them back/i)
  })
})
