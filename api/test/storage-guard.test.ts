import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import health from '../health.ts'
import leads from '../leads.ts'
import { documentStoreFromEnv } from '../../src/store/documents.ts'
import { withTenant } from '../../src/tenancy/context.ts'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const passcode = 'storage-guard-test-passcode'
beforeEach(() => {
  for (const key of ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
    'OPS_ACCOUNTS_JSON', 'VAPI_PRIVATE_KEY', 'VAPI_API_KEY']) delete process.env[key]
  process.env.OPS_DASHBOARD_PASSCODE = passcode
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

async function invoke(handler: (req: any, res: any) => unknown, body?: unknown) {
  const response: any = { code: 0, body: null, headers: {},
    setHeader(key: string, value: string) { this.headers[key] = value; return this },
    status(code: number) { this.code = code; return this },
    json(value: unknown) { this.body = value; return this } }
  await handler({ method: body ? 'POST' : 'GET', body, headers: { 'x-ops-passcode': passcode } }, response)
  return response
}

for (const runtime of [{ NODE_ENV: 'production' }, { VERCEL: '1', VERCEL_ENV: 'preview' }]) {
  for (const credentials of [{}, { KV_REST_API_URL: 'https://private-storage.test' }, { KV_REST_API_TOKEN: 'secret-storage-token' }]) {
    test(`health reports missing durable configuration: ${JSON.stringify({ ...runtime, fields: Object.keys(credentials) })}`, async () => {
      Object.assign(process.env, runtime, credentials)
      let requests = 0
      globalThis.fetch = async () => { requests++; throw new Error('Unexpected network request') }
      const response = await invoke(health)
      assert.equal(response.code, 503)
      assert.equal(response.body.ok, false)
      assert.equal(response.body.store, 'unconfigured')
      assert.equal(response.body.durable, false)
      assert.equal(response.body.code, 'storage_not_configured')
      assert.match(response.body.hint, /KV_REST_API_URL and KV_REST_API_TOKEN/)
      assert.doesNotMatch(JSON.stringify(response.body), /private-storage|secret-storage-token/)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(requests, 0)
    })
  }
}

test('health preserves an honest local preview response without requiring KV', async () => {
  const response = await invoke(health)
  assert.equal(response.code, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.store, 'memory')
  assert.equal(response.body.durable, false)
  assert.match(response.body.hint, /reset when the preview restarts/)
})

test('health verifies configured storage and reports reachability failure without private details', async () => {
  Object.assign(process.env, { NODE_ENV: 'production', KV_REST_API_URL: 'https://private-storage.test', KV_REST_API_TOKEN: 'secret-storage-token' })
  globalThis.fetch = async () => new Response(JSON.stringify({ result: null }))
  const ready = await invoke(health)
  assert.equal(ready.code, 200)
  assert.equal(ready.body.store, 'kv')
  assert.equal(ready.body.durable, true)
  globalThis.fetch = async () => { throw new Error('private-storage endpoint failed for secret-storage-token') }
  const failure = await invoke(health)
  assert.equal(failure.code, 503)
  assert.equal(failure.body.ok, false)
  assert.equal(failure.body.store, 'kv')
  assert.equal(failure.body.durable, false)
  assert.equal(failure.body.code, 'storage_unavailable')
  assert.match(failure.body.hint, /Check the Redis\/KV connection/)
  assert.doesNotMatch(JSON.stringify(failure.body), /private-storage|secret-storage-token/)
})

for (const runtime of [{ NODE_ENV: 'production' }, { VERCEL: '1', VERCEL_ENV: 'preview' }]) {
  test(`hosted bulk lead reset is rejected before reading or deleting data: ${JSON.stringify(runtime)}`, async () => {
    Object.assign(process.env, runtime, { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'test' })
    let requests = 0
    globalThis.fetch = async () => { requests++; throw new Error('Bulk reset must not access storage') }
    const response = await invoke(leads, { action: 'clear_leads' })
    assert.equal(response.code, 403)
    assert.match(response.body.error, /only available in local testing/)
    assert.equal(requests, 0)
    delete process.env.KV_REST_API_TOKEN
    assert.equal((await invoke(leads, { action: 'clear_leads' })).code, 403)
  })
}

test('local bulk lead reset still clears only lead and follow-up records', async () => {
  const store = documentStoreFromEnv()
  await withTenant('legacy', async () => {
    await store.set('lead:guard-test', { notes: [] })
    await store.set('followup:fu-guard-test', { status: 'scheduled' })
    await store.set('call:guard-test', { preserved: true })
  })
  const response = await invoke(leads, { action: 'clear_leads' })
  assert.equal(response.code, 200)
  await withTenant('legacy', async () => {
    assert.equal(await store.get('lead:guard-test'), null)
    assert.equal(await store.get('followup:fu-guard-test'), null)
    assert.deepEqual(await store.get('call:guard-test'), { preserved: true })
  })
})

test('production staff follow-up updates remain available with durable storage', async () => {
  Object.assign(process.env, { NODE_ENV: 'production', KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'test' })
  const existing = { id: 'fu-guard-test', status: 'scheduled' }
  const commands: string[][] = []
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body)) as string[]
    commands.push(command)
    return new Response(JSON.stringify({ result: command[0] === 'GET' ? JSON.stringify(existing) : 1 }))
  }
  const response = await invoke(leads, { action: 'followup_status', id: existing.id, status: 'done' })
  assert.equal(response.code, 200)
  assert.equal(response.body.followUp.status, 'done')
  assert.ok(commands.some(command => command[0] === 'EVAL'))
  assert.ok(!commands.some(command => command[0] === 'DEL'))
})
