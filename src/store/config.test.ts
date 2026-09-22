import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { StorageConfigurationError } from './config.ts'
import { documentStoreFromEnv } from './documents.ts'
import { calendarStoreFromEnv } from '../calendar/store.ts'
import { withTenant } from '../tenancy/context.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

for (const runtime of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test', VERCEL: '1', VERCEL_ENV: 'preview' }]) {
  for (const credentials of [{}, { KV_REST_API_URL: 'https://private-kv.test' }, { KV_REST_API_TOKEN: 'private-token' },
    { KV_REST_API_URL: '  ', KV_REST_API_TOKEN: 'private-token' }]) {
    test(`hosted stores reject missing or partial KV: ${JSON.stringify({ ...runtime, fields: Object.keys(credentials) })}`, async () => {
      const env = { ...runtime, ...credentials }
      const docs = documentStoreFromEnv(env)
      const calendar = calendarStoreFromEnv(env)
      let requests = 0
      globalThis.fetch = async () => { requests++; throw new Error('Unexpected network request') }
      await withTenant('guard-tenant', async () => {
        for (const operation of [() => docs.get('lead:one'), () => docs.set('lead:one', {}),
          () => docs.update('lead:one', {}, () => ({})), () => docs.list('lead:'), () => docs.delete('lead:one'),
          () => calendar.read(), () => calendar.mutate(state => state)]) {
          await assert.rejects(async () => operation(), StorageConfigurationError)
        }
        assert.throws(() => docs.describe(), StorageConfigurationError)
        assert.throws(() => calendar.describe(), StorageConfigurationError)
      })
      assert.equal(requests, 0)
    })
  }
}

for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test', KV_REST_API_TOKEN: 'partial' }]) {
  test(`local and test previews retain shared tenant memory: ${JSON.stringify(env)}`, async () => {
    const tenant = `guard-local-${env.NODE_ENV ?? 'unset'}`
    await withTenant(tenant, async () => {
      const docs = documentStoreFromEnv(env)
      await docs.set('lead:one', { name: 'Preview' })
      assert.deepEqual(await documentStoreFromEnv(env).get('lead:one'), { name: 'Preview' })
      assert.equal(docs.describe().kind, 'memory')
      const calendar = calendarStoreFromEnv(env)
      await calendar.mutate(state => ({ ...state, settingsRevision: 2 }))
      assert.equal((await calendarStoreFromEnv(env).read()).settingsRevision, 2)
      assert.equal(calendar.describe().durable, false)
    })
  })
}

test('a factory created in local mode rejects a later production runtime instead of retaining memory', async () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' }
  const docs = documentStoreFromEnv(env)
  const calendar = calendarStoreFromEnv(env)
  await withTenant('guard-transition', async () => {
    await docs.set('lead:one', { saved: 'local' })
    await calendar.mutate(state => ({ ...state, settingsRevision: 1 }))
    env.NODE_ENV = 'production'
    await assert.rejects(async () => docs.get('lead:one'), StorageConfigurationError)
    await assert.rejects(async () => calendar.read(), StorageConfigurationError)
  })
})

test('complete production config uses current tenant KV keys and rejects removed credentials', async () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', KV_REST_API_URL: ' https://kv.test ', KV_REST_API_TOKEN: ' token ' }
  const commands: string[][] = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://kv.test')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer token')
    const command = JSON.parse(String(init?.body)) as string[]
    commands.push(command)
    return new Response(JSON.stringify({ result: null }))
  }
  const docs = documentStoreFromEnv(env)
  const calendar = calendarStoreFromEnv(env)
  for (const tenant of ['guard-alpha', 'guard-bravo']) await withTenant(tenant, async () => {
    await docs.get('lead:one')
    await calendar.read()
    assert.equal(docs.describe().durable, true)
    assert.equal(calendar.describe().kind, 'kv')
  })
  assert.deepEqual(commands.map(command => command[1]), [
    'atrium:tenant:guard-alpha:lead:one', 'atrium:tenant:guard-alpha:calendar',
    'atrium:tenant:guard-bravo:lead:one', 'atrium:tenant:guard-bravo:calendar',
  ])
  delete env.KV_REST_API_TOKEN
  await withTenant('guard-alpha', async () => {
    await assert.rejects(async () => docs.get('lead:one'), StorageConfigurationError)
    await assert.rejects(async () => calendar.read(), StorageConfigurationError)
  })
  assert.equal(commands.length, 4)
})

test('configured storage failures never switch production operations to memory', async () => {
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 })
  const env = { NODE_ENV: 'production', KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'token' }
  await withTenant('guard-unreachable', async () => {
    const docs = documentStoreFromEnv(env)
    const calendar = calendarStoreFromEnv(env)
    await assert.rejects(docs.set('lead:one', {}), /KV HTTP 503/)
    await assert.rejects(calendar.read(), /KV HTTP 503/)
    assert.equal(docs.describe().kind, 'kv')
    assert.equal(docs.describe().durable, false)
    assert.equal(calendar.describe().durable, false)
  })
})
