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

before(async () => {
  originalCwd = process.cwd()
  process.chdir(FIXTURES)
  handler = (await import('../vapi.ts')).default
})

after(() => { process.chdir(originalCwd) })

function mockRes() {
  const r: any = {
    code: 0, body: null, headers: {} as Record<string, string>,
    status(c: number) { r.code = c; return r },
    json(b: unknown) { r.body = b; return r },
    setHeader(k: string, v: string) { r.headers[k] = v; return r },
  }
  return r
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
    assert.match(String(a.result), /Verified availability/)

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

    const g = mockRes()
    await handler({ method: 'GET', headers: {} }, g)
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
    const g = mockRes()
    await handler({ method: 'GET', headers: {} }, g)
    assert.ok(!g.body.events.some((e: any) => e.callId === 'emerg-2' && e.kind === 'emergency'))
  })
})

describe('the dashboard endpoint', () => {
  test('GET returns the event log and forbids caching', async () => {
    const res = mockRes()
    await handler({ method: 'GET', headers: {} }, res)
    assert.equal(res.code, 200)
    assert.ok(Array.isArray(res.body.events))
    assert.equal(res.headers['cache-control'], 'no-store')
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
