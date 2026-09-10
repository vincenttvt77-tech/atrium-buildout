import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAssistant, assistantPatch, syncAssistant } from '../sync.ts'
import { demoAssistantConfig } from '../config.ts'
import property from '../../../data/property.json' with { type: 'json' }

const generated = demoAssistantConfig(property as Record<string, unknown>, 'https://example.vercel.app', new Date('2026-09-08T12:00:00Z'))
const config = { ...generated, server: { ...generated.server, credentialId: 'credential-configured' } }

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
  test('preserves a configured vault credential and unrelated headers on all seven explicit tool routes', () => {
    const patch = assistantPatch({ server: { url: 'https://old.example/api/vapi', credentialId: 'credential-existing', headers: { 'x-custom': 'value' } } }, generated)
    assert.equal(patch.server.credentialId, 'credential-existing')
    assert.deepEqual(patch.server.headers, { 'x-custom': 'value' })
    assert.equal(patch.server.url, config.server.url)
    const tools = patch.model.tools as Array<{ server: Record<string, unknown>; function: unknown; messages?: unknown }>
    assert.equal(tools.length, 7)
    for (const [index, tool] of tools.entries()) {
      assert.deepEqual(tool.server, patch.server)
      assert.notEqual(tool.server, patch.server)
      assert.deepEqual(tool.function, (config.model.tools as typeof tools)[index]!.function)
      assert.deepEqual(tool.messages, (config.model.tools as typeof tools)[index]!.messages)
    }
  })
  test('rejects competing legacy secrets and case-insensitive authentication headers without exposing their values', () => {
    for (const field of [{ secret: 'sensitive-marker' }, { secret: '' },
      ...['Authorization', 'authorization', 'X-Vapi-Secret', 'x-vapi-signature', 'Proxy-Authorization'].map(key => ({ headers: { [key]: 'sensitive-marker' } }))]) {
      assert.throws(() => assistantPatch({ server: field }, config), error => {
        assert.match((error as Error).message, /conflicts/)
        assert.doesNotMatch((error as Error).message, /sensitive-marker/)
        return true
      })
    }
    assert.throws(() => assistantPatch({}, generated), /authentication is missing/)
    assert.throws(() => assistantPatch({}, { ...config, server: { ...config.server, url: 'https://elsewhere.example/other' } }), /authentication/)
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
      startSpeakingPlan: { waitSeconds: 0.9, smartEndpointingPlan: { provider: 'livekit' } },
      model: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.7, maxTokens: 300, toolIds: ['tool-x'], messages: [{ role: 'system', content: 'old' }] },
    }
    const patch = assistantPatch(existing, config)
    assert.ok(!('voice' in patch) && !('transcriber' in patch), 'voice and transcriber are not replaced')
    assert.equal(patch.startSpeakingPlan.waitSeconds, 0.4)
    assert.deepEqual((patch.startSpeakingPlan as Record<string, unknown>).smartEndpointingPlan, { provider: 'livekit' })
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
  test('conflicting existing authentication refuses before PATCH', async () => {
    const methods: string[] = []
    const result = await syncAssistant({ apiKey: 'synthetic', assistantId: 'a1', config,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET')
        return Response.json({ id: 'a1', server: { headers: { 'X-Vapi-Secret': 'sensitive-marker' } } })
      }) as unknown as typeof fetch })
    assert.equal(result.ok, false)
    assert.deepEqual(methods, ['GET'])
    assert.match(result.error!, /no update was sent/)
    assert.doesNotMatch(result.error!, /sensitive-marker/)
  })

  test('readback rejects missing or changed tool routes and added competing auth despite a correct assistant server', async () => {
    for (const failure of ['tool-url', 'tool-credential', 'tool-missing-server', 'tool-secret', 'tool-auth-header', 'assistant-secret', 'assistant-auth-header']) {
      let saved: any, reads = 0, writes = 0
      const result = await syncAssistant({ apiKey: 'synthetic', assistantId: 'a1', config,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          if (init?.method === 'PATCH') { writes++; saved = JSON.parse(String(init.body)); return Response.json({}) }
          if (++reads === 1) return Response.json({ id: 'a1', name: 'Synthetic' })
          const tool = saved.model.tools[0]
          if (failure === 'tool-url') tool.server.url = 'https://wrong.example/api/vapi'
          if (failure === 'tool-credential') tool.server.credentialId = 'wrong-credential'
          if (failure === 'tool-missing-server') delete tool.server
          if (failure === 'tool-secret') tool.server.secret = 'sensitive-marker'
          if (failure === 'tool-auth-header') tool.server.headers = { 'X-Vapi-Signature': 'sensitive-marker' }
          if (failure === 'assistant-secret') saved.server.secret = 'sensitive-marker'
          if (failure === 'assistant-auth-header') saved.server.headers = { Authorization: 'sensitive-marker' }
          return Response.json({ id: 'a1', ...saved })
        }) as unknown as typeof fetch })
      assert.equal(result.ok, false, failure)
      assert.equal(writes, 1); assert.equal(reads, 2)
      assert.match(result.error!, /saved assistant did not match/)
      assert.doesNotMatch(result.error!, /sensitive-marker/)
    }
  })

  test('legacy mode lists, reads, patches and verifies the chosen assistant with the key', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = []
    let saved: Record<string, unknown> = { id: 'a1', name: 'The Larkin — Leasing', model: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.4 } }
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: String((init?.headers as Record<string, string>)?.authorization) })
      if (method === 'GET' && url.endsWith('/assistant')) return new Response(JSON.stringify([{ id: 'a1', name: 'The Larkin — Leasing' }]), { status: 200 })
      if (method === 'GET') return new Response(JSON.stringify(saved), { status: 200 })
      saved = { ...saved, ...JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ id: 'a1' }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await syncAssistant({ apiKey: 'sk-test', config, fetchImpl })
    assert.equal(r.ok, true)
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET https://api.vapi.ai/assistant', 'GET https://api.vapi.ai/assistant/a1', 'PATCH https://api.vapi.ai/assistant/a1', 'GET https://api.vapi.ai/assistant/a1'])
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

  test('an explicit assistant is read directly and success requires independent saved-state verification', async () => {
    const calls: string[] = []
    const signals = new Set<AbortSignal | null | undefined>()
    let saved = { id: 'tenant-assistant', name: 'Larkin', model: { provider: 'anthropic', model: 'claude-sonnet-5' } } as Record<string, unknown>
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      signals.add(init?.signal)
      assert.equal(url, 'https://api.vapi.ai/assistant/tenant-assistant')
      if (method === 'PATCH') {
        saved = { ...saved, ...JSON.parse(String(init?.body)) }
        return new Response('{}')
      }
      return new Response(JSON.stringify(saved))
    }) as unknown as typeof fetch
    const result = await syncAssistant({ apiKey: 'test', assistantId: 'tenant-assistant', config, fetchImpl })
    assert.equal(result.ok, true)
    assert.deepEqual(calls.map((call) => call.split(' ')[0]), ['GET', 'PATCH', 'GET'])
    assert.equal(signals.size, 1)
    assert.ok([...signals][0] instanceof AbortSignal)
  })

  test('does not patch or list other assistants when the configured ID is missing or mismatched', async () => {
    for (const response of [new Response('', { status: 404 }), new Response('{"id":"another-tenant","name":"Private"}')]) {
      let requests = 0
      const result = await syncAssistant({
        apiKey: 'test', assistantId: 'tenant-assistant', config,
        fetchImpl: (async (input: string, init?: RequestInit) => {
          requests++
          assert.equal(input, 'https://api.vapi.ai/assistant/tenant-assistant')
          assert.notEqual(init?.method, 'PATCH')
          return response
        }) as unknown as typeof fetch,
      })
      assert.equal(result.ok, false)
      assert.equal(requests, 1)
      assert.equal(result.candidates, undefined)
      assert.equal(result.assistant, undefined)
    }
  })

  test('a PATCH acknowledgement cannot hide a stale prompt, changed destination or missing tool', async () => {
    for (const failure of ['prompt', 'server', 'tools', 'timing']) {
      let reads = 0
      let patch: any
      const result = await syncAssistant({
        apiKey: 'test', assistantId: 'a1', config,
        fetchImpl: (async (_input: string, init?: RequestInit) => {
          if (init?.method === 'PATCH') { patch = JSON.parse(String(init.body)); return new Response('{}') }
          reads++
          if (reads === 1) return new Response('{"id":"a1","name":"Larkin","model":{"provider":"anthropic"}}')
          if (failure === 'prompt') patch.model.messages[0].content = 'stale prompt'
          if (failure === 'server') patch.server.url = 'https://wrong.example/api/vapi'
          if (failure === 'tools') patch.model.tools.pop()
          if (failure === 'timing') patch.startSpeakingPlan.waitSeconds = 9
          return new Response(JSON.stringify({ id: 'a1', ...patch }))
        }) as unknown as typeof fetch,
      })
      assert.equal(result.ok, false, failure)
      assert.match(result.error!, /saved assistant did not match/)
      assert.equal(reads, 2)
    }
  })

  test('failed readback states that the write was sent without claiming success or retrying', async () => {
    const methods: string[] = []
    const result = await syncAssistant({
      apiKey: 'test', assistantId: 'a1', config,
      fetchImpl: (async (_input: string, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET')
        if (methods.length === 1) return new Response('{"id":"a1","name":"Larkin"}')
        if (methods.length === 2) return new Response('{}')
        return new Response('', { status: 503 })
      }) as unknown as typeof fetch,
    })
    assert.equal(result.ok, false)
    assert.match(result.error!, /update was sent.*503/)
    assert.deepEqual(methods, ['GET', 'PATCH', 'GET'])
  })
})
