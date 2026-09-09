import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseCall, fetchCalls } from '../vapi-calls.ts'

const CALL = {
  id: 'call-1',
  startedAt: '2026-09-07T18:00:00.000Z',
  endedAt: '2026-09-07T18:04:30.000Z',
  endedReason: 'customer-ended-call',
  customer: { number: '+15165551234' },
  transcript: 'AI: Thanks for calling...\nUser: I need a studio',
  recordingUrl: 'https://example.com/rec.wav',
  cost: 0.42,
  messages: [
    {
      role: 'assistant',
      toolCalls: [
        { id: 'tc1', function: { name: 'capture_signal', arguments: '{"signal":"bedrooms","value":"studio","excerpt":"a studio"}' } },
      ],
    },
    { role: 'tool_call_result', toolCallId: 'tc1', result: 'Got it. Next, ask about their budget.' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'tc2', function: { name: 'check_availability', arguments: {} } }],
    },
    { role: 'tool_call_result', toolCallId: 'tc2', result: 'Verified availability — Unit 09F...' },
  ],
}

describe('a Vapi call becomes something the dashboard can show', () => {
  test('pairs each tool call with the result we returned', () => {
    const c = normaliseCall(CALL)
    assert.equal(c.toolCalls.length, 2)
    assert.equal(c.toolCalls[0]!.name, 'capture_signal')
    assert.equal(c.toolCalls[0]!.arguments.value, 'studio')
    // Without the pairing the log says what was asked but never what was answered, which
    // is the half that explains a bad call.
    assert.match(c.toolCalls[0]!.result!, /Next, ask about/)
    assert.match(c.toolCalls[1]!.result!, /Verified availability/)
  })

  test('parses arguments whether they arrive as a string or an object', () => {
    const c = normaliseCall(CALL)
    assert.deepEqual(c.toolCalls[1]!.arguments, {})
    assert.equal(c.toolCalls[0]!.arguments.signal, 'bedrooms')
  })

  test('computes duration', () => {
    assert.equal(normaliseCall(CALL).durationSeconds, 270)
  })

  test('a tool call with no result is surfaced as null, not dropped', () => {
    const c = normaliseCall({
      ...CALL,
      messages: [{ role: 'assistant', toolCalls: [{ id: 'x', function: { name: 'book_tour', arguments: {} } }] }],
    })
    assert.equal(c.toolCalls.length, 1)
    assert.equal(c.toolCalls[0]!.result, null,
      'a request with no result is exactly what a hung call looks like')
  })

  test('an empty or malformed call does not throw', () => {
    assert.doesNotThrow(() => normaliseCall({}))
    assert.doesNotThrow(() => normaliseCall(null))
    assert.equal(normaliseCall({}).toolCalls.length, 0)
  })
})

describe('fetching never throws', () => {
  test('says so plainly when no key is configured', async () => {
    const r = await fetchCalls({ apiKey: '' })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.configured, false)
    assert.match(r.ok === false ? r.reason : '', /VAPI_PRIVATE_KEY/)
  })

  test('a network failure is reported, not thrown', async () => {
    const r = await fetchCalls({
      apiKey: 'k',
      fetchImpl: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
    })
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.reason : '', /ECONNRESET/)
  })

  test('an upstream error status is reported', async () => {
    const r = await fetchCalls({
      apiKey: 'k',
      fetchImpl: (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
    })
    assert.match(r.ok === false ? r.reason : '', /401/)
  })

  test('unwraps a results envelope', async () => {
    const r = await fetchCalls({
      apiKey: 'k',
      fetchImpl: (async () => ({ ok: true, json: async () => ({ results: [CALL] }) })) as unknown as typeof fetch,
    })
    assert.equal(r.ok, true)
    assert.equal(r.ok === true ? r.calls[0]!.id : '', 'call-1')
  })
})

describe('workspace-scoped call history', () => {
  test('an unbound workspace cannot fetch organization history, even without a key', async () => {
    let requests = 0
    const result = await fetchCalls({ apiKey: '', assistantIds: [], fetchImpl: (async () => { requests++; throw new Error('must not fetch') }) as typeof fetch })
    assert.deepEqual(result, { ok: true, calls: [] })
    assert.equal(requests, 0)
  })

  test('queries every bound assistant and rejects unrelated or unidentifiable records before normalization', async () => {
    const urls: URL[] = []
    const result = await fetchCalls({
      apiKey: 'test', assistantIds: ['larkin-a', 'larkin-b', 'larkin-a'], limit: 2,
      fetchImpl: (async (input: string) => {
        const url = new URL(input)
        urls.push(url)
        const assistantId = url.searchParams.get('assistantId')
        return new Response(JSON.stringify([
          { ...CALL, id: 'other-secret', assistantId: 'other-tenant' },
          { ...CALL, id: 'missing-identity' },
          { ...CALL, id: 'call-1', assistantId, startedAt: '2026-09-07T18:00:00Z' },
          { ...CALL, id: `${assistantId}-call`, assistantId, startedAt: assistantId === 'larkin-a' ? '2026-09-08T18:00:00Z' : '2026-09-09T18:00:00Z' },
        ]))
      }) as unknown as typeof fetch,
    })
    assert.equal(urls.length, 2)
    assert.deepEqual(urls.map((url) => url.searchParams.get('assistantId')).sort(), ['larkin-a', 'larkin-b'])
    assert.ok(urls.every((url) => url.pathname === '/call' && url.searchParams.get('limit') === '2'))
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.calls.map((call) => call.id), ['larkin-b-call', 'larkin-a-call'])
  })

  test('deduplicates repeated call IDs after combining scoped lists', async () => {
    const result = await fetchCalls({
      apiKey: 'test', assistantIds: ['larkin'],
      fetchImpl: (async () => new Response(JSON.stringify([
        { ...CALL, assistantId: 'larkin' }, { ...CALL, assistantId: 'larkin' },
      ]))) as typeof fetch,
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.calls.length, 1)
  })

  test('bounds concurrent upstream requests and shares one deadline across the entire workspace', async () => {
    let active = 0
    let maximum = 0
    const signals = new Set<AbortSignal | null | undefined>()
    const ids = Array.from({ length: 12 }, (_, i) => `assistant-${i}`)
    const result = await fetchCalls({
      apiKey: 'test', assistantIds: ids,
      fetchImpl: (async (_input: string, init?: RequestInit) => {
        active++
        maximum = Math.max(maximum, active)
        signals.add(init?.signal)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return new Response('[]')
      }) as unknown as typeof fetch,
    })
    assert.equal(result.ok, true)
    assert.equal(maximum, 4)
    assert.equal(signals.size, 1)
    assert.ok([...signals][0] instanceof AbortSignal)
  })

  test('a failed assistant list produces an error instead of a misleading partial history', async () => {
    const result = await fetchCalls({
      apiKey: 'test', assistantIds: ['working', 'broken'],
      fetchImpl: (async (input: string) => input.includes('assistantId=broken')
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify([{ ...CALL, assistantId: 'working' }]))) as unknown as typeof fetch,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /503/)
  })

  test('invalid bindings and malformed list responses fail closed', async () => {
    let requests = 0
    const fetchImpl = (async () => { requests++; return new Response('{"results":{}}') }) as typeof fetch
    const invalid = await fetchCalls({ apiKey: 'test', assistantIds: [''], fetchImpl })
    assert.equal(invalid.ok, false)
    assert.equal(requests, 0)
    const malformed = await fetchCalls({ apiKey: 'test', assistantIds: ['larkin'], fetchImpl })
    assert.equal(malformed.ok, false)
    assert.equal(requests, 1)
  })
})
