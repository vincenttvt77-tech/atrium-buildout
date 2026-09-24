import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vapiReleaseProvider } from '../release-provider.ts'
import { assistantPatch } from '../sync.ts'
import { demoAssistantConfig } from '../config.ts'
const base = demoAssistantConfig({ buildingName: 'Synthetic building' }, 'https://synthetic.example')
const patch = assistantPatch({}, { ...base, server: { ...base.server, credentialId: 'synthetic-credential' } } as typeof base)

test('official SDK writes once on provider 500 or lost reply, with fixed origin and redirects disabled', async () => {
  for (const mode of ['500', 'lost', '302']) {
    let attempts = 0
    const provider = vapiReleaseProvider('synthetic-key', { fetch: async (url, init) => {
      attempts++; assert.equal(url, 'https://api.vapi.ai/assistant/synthetic-assistant')
      assert.equal(init?.method, 'PATCH'); assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key')
      assert.ok(init?.signal); assert.deepEqual(JSON.parse(String(init?.body)), patch)
      if (mode === 'lost') throw new Error('private-provider-response')
      return new Response('private-provider-response', { status: Number(mode) })
    } })
    await assert.rejects(provider.patch('synthetic-assistant', patch), error => {
      assert.doesNotMatch(String(error), /private-provider-response|synthetic-key/); return true
    })
    assert.equal(attempts, 1)
  }
})

test('provider reads one exact ID; path tricks never reach transport', async () => {
  let attempts = 0
  const provider = vapiReleaseProvider('synthetic-key', { fetch: async (url, init) => {
    attempts++; assert.equal(url, 'https://api.vapi.ai/assistant/synthetic-assistant'); assert.equal(init?.method, 'GET')
    return Response.json({ id: 'synthetic-assistant', orgId: 'synthetic-org' })
  } })
  assert.equal((await provider.read('synthetic-assistant')).id, 'synthetic-assistant')
  for (const value of ['', '../other', 'a?key=secret', 'a/b', 'a%2fb']) await assert.rejects(provider.read(value))
  assert.equal(attempts, 1)
})

test('bounded streaming replies reject oversized, malformed and stalled responses', async () => {
  for (const mode of ['size', 'invalid', 'stall']) {
    const provider = vapiReleaseProvider('synthetic-key', { timeoutMs: 25, fetch: async () => {
      if (mode === 'size') return new Response('x'.repeat(512 * 1024 + 1))
      if (mode === 'invalid') return new Response('this is not JSON', { headers: { 'content-type': 'application/json' } })
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])) } }))
    } })
    // Keep the test process alive while Node's unref'ed abort timers enforce the bound.
    const hold = setTimeout(() => {}, 500)
    try { await assert.rejects(provider.read('synthetic-assistant')) } finally { clearTimeout(hold) }
  }
})
