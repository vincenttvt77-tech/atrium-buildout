import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAssistant, assistantPatch, syncAssistant } from '../sync.ts'
import { demoAssistantConfig } from '../config.ts'
import property from '../../../data/property.json' with { type: 'json' }

const config = demoAssistantConfig(property as Record<string, unknown>, 'https://example.vercel.app', new Date('2026-09-08T12:00:00Z'))

describe('which assistant is updated', () => {
  const list = [{ id: 'a1', name: 'The Larkin — Leasing' }, { id: 'a2', name: 'Scratch' }]
  test('by id when one is configured, by exact name otherwise, or the only one there is', () => {
    assert.deepEqual(chooseAssistant(list, { id: 'a2', name: 'The Larkin — Leasing' }), { assistant: list[1] })
    assert.deepEqual(chooseAssistant(list, { name: 'The Larkin — Leasing' }), { assistant: list[0] })
    assert.deepEqual(chooseAssistant([list[1]!], { name: 'Nope' }), { assistant: list[1] })
  })
  test('never guesses between several', () => {
    const r = chooseAssistant([...list, { id: 'a3', name: 'The Larkin — Leasing' }], { name: 'The Larkin — Leasing' })
    assert.ok('error' in r && /VAPI_ASSISTANT_ID/.test(r.error))
    const none = chooseAssistant(list, { name: 'Other' })
    assert.ok('error' in none && none.candidates.length === 2)
  })
})

describe('what the update writes and what it leaves alone', () => {
  test('preserves webhook credentials when changing the server URL', () => {
    const patch = assistantPatch({ server: { url: 'https://old.example/api/vapi', credentialId: 'credential-existing', headers: { 'x-custom': 'value' }, secret: 'test-only-secret' } }, config)
    assert.equal(patch.server.credentialId, 'credential-existing')
    assert.equal(patch.server.secret, 'test-only-secret')
    assert.deepEqual(patch.server.headers, { 'x-custom': 'value' })
    assert.equal(patch.server.url, config.server.url)
  })
  test('saved assistants resolve the date on the call, not on the last deployment', () => {
    assert.match(config.model.messages[0]!.content, /\{\{"now" \| date:/)
    assert.match(config.model.messages[0]!.content, /America\/New_York/)
  })
  test('script, tools, server and opening line go in; voice, transcriber and model settings stay', () => {
    const existing = {
      id: 'a1', name: 'The Larkin — Leasing',
      voice: { provider: '11labs', voiceId: 'someone-else', stability: 0.3 },
      transcriber: { provider: 'deepgram', model: 'nova-2', endpointing: 120 },
      startSpeakingPlan: { waitSeconds: 0.9 },
      model: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.7, maxTokens: 300, toolIds: ['tool-x'], messages: [{ role: 'system', content: 'old' }] },
    }
    const patch = assistantPatch(existing, config)
    assert.ok(!('voice' in patch) && !('transcriber' in patch) && !('startSpeakingPlan' in patch), 'tuned-in-Vapi settings are not sent')
    assert.equal(patch.model.provider, 'anthropic')
    assert.equal(patch.model.temperature, 0.7, 'the assistant keeps its own temperature')
    assert.equal(patch.model.maxTokens, 300)
    assert.deepEqual(patch.model.toolIds, [], 'separately attached tools are detached')
    assert.match(String((patch.model.messages as Array<{ content: string }>)[0]!.content), /You answer the leasing line at The Larkin/)
    assert.equal((patch.model.tools as unknown[]).length, 7)
    assert.equal(patch.server.url, 'https://example.vercel.app/api/vapi')
  })
})

describe('the round trip to Vapi', () => {
  test('lists, reads, then patches the chosen assistant with the key', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: String((init?.headers as Record<string, string>)?.authorization) })
      if (method === 'GET' && url.endsWith('/assistant')) return new Response(JSON.stringify([{ id: 'a1', name: 'The Larkin — Leasing' }]), { status: 200 })
      if (method === 'GET') return new Response(JSON.stringify({ id: 'a1', name: 'The Larkin — Leasing', model: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.4 } }), { status: 200 })
      return new Response(JSON.stringify({ id: 'a1' }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await syncAssistant({ apiKey: 'sk-test', config, fetchImpl })
    assert.equal(r.ok, true)
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET https://api.vapi.ai/assistant', 'GET https://api.vapi.ai/assistant/a1', 'PATCH https://api.vapi.ai/assistant/a1'])
    assert.equal(calls[2]!.auth, 'Bearer sk-test')
    assert.equal((calls[2]!.body as { model: { temperature: number } }).model.temperature, 0.4)
    assert.match(r.updated!.join(' '), /7 tools/)
  })
  test('a refused key is said plainly', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const r = await syncAssistant({ apiKey: 'pk-public', config, fetchImpl })
    assert.equal(r.ok, false)
    assert.match(r.error!, /401.*private key/)
  })
})
