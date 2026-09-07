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
