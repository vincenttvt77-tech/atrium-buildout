import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { calendarStoreFromEnv } from '../calendar/store.ts'
import { documentStoreFromEnv } from '../store/documents.ts'
import { currentTenantId, LEGACY_TENANT, tenantNamespace, validateTenantId, withTenant } from './context.ts'

const KV_ENV = { KV_REST_API_URL: 'https://tenant-isolation.invalid', KV_REST_API_TOKEN: 'test-only-redis-token' }
const TENANTS = ['tenant-a', 'tenant-b', LEGACY_TENANT] as const

/** A shared Redis server, including cursor pagination and atomic compare-and-set writes. */
function mockRedis() {
  const data = new Map<string, string>()
  const commands: string[][] = []
  const scanExtras: string[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(String(url), KV_ENV.KV_REST_API_URL)
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${KV_ENV.KV_REST_API_TOKEN}`)
    const command = JSON.parse(String(init?.body)) as string[]
    commands.push(command)
    let result: unknown
    const [operation, key] = command
    switch (operation) {
      case 'GET': result = data.get(key!) ?? null; break
      case 'SET': data.set(key!, command[2]!); result = 'OK'; break
      case 'DEL': result = Number(data.delete(key!)); break
      case 'EVAL': {
        assert.equal(command[2], '1', 'atomic updates must address exactly one Redis key')
        const [, , , target, presence, previous, next] = command
        const matches = presence === 'missing' ? !data.has(target!) : data.get(target!) === previous
        if (matches) data.set(target!, next!)
        result = Number(matches)
        break
      }
      case 'SCAN': {
        assert.equal(command[2], 'MATCH')
        const keys = [...data.keys()].sort()
        const start = Number(key)
        const finish = start + 2
        const glob = command[3]!
        assert.ok(glob.endsWith('*'))
        const prefix = glob.slice(0, -1)
        result = [finish >= keys.length ? '0' : String(finish),
          [...keys.slice(start, finish).filter((candidate) => candidate.startsWith(prefix)), ...scanExtras]]
        break
      }
      default: assert.fail(`Unexpected Redis command: ${operation}`)
    }
    // Requests genuinely suspend, allowing parallel tenant contexts to interleave.
    await nextTurn()
    return new Response(JSON.stringify({ result }))
  }
  return { data, commands, scanExtras, fetchImpl }
}

let redis: ReturnType<typeof mockRedis>
const originalFetch = globalThis.fetch
beforeEach(() => { redis = mockRedis(); globalThis.fetch = redis.fetchImpl })
afterEach(() => { globalThis.fetch = originalFetch })

describe('request-scoped tenancy against shared Redis', () => {
  test('the same call ID and calendar are stored at distinct actual Redis keys, including legacy', async () => {
    const docs = documentStoreFromEnv(KV_ENV)
    const calendar = calendarStoreFromEnv(KV_ENV)
    await Promise.all(TENANTS.map((tenant) => withTenant(tenant, async () => {
      await docs.set('call:identical-call-id', { tenant })
      await calendar.mutate((state) => ({ ...state, blocks: [{ target: '2026-10-01', reason: tenant, blockedAt: '2026-09-09T12:00:00Z' }] }))
      assert.deepEqual(await docs.get('call:identical-call-id'), { tenant })
      assert.equal((await calendar.read()).blocks[0]?.reason, tenant)
    })))
    assert.deepEqual([...redis.data.keys()].sort(), [
      'atrium:calendar', 'atrium:call:identical-call-id',
      'atrium:tenant:tenant-a:calendar', 'atrium:tenant:tenant-a:call:identical-call-id',
      'atrium:tenant:tenant-b:calendar', 'atrium:tenant:tenant-b:call:identical-call-id',
    ].sort())
    assert.equal(currentTenantId(), LEGACY_TENANT, 'parallel requests must restore the outer context')
  })

  test('updates, cursor-based listing, and deletes stay inside the selected tenant namespace', async () => {
    const docs = documentStoreFromEnv(KV_ENV)
    for (const tenant of TENANTS) await withTenant(tenant, async () => {
      await docs.set('call:one', { owner: tenant, revisions: 0 })
      await docs.set('call:two', { owner: tenant, revisions: 0 })
      await docs.set('lead:unrelated', { owner: tenant })
    })
    // A noisy SCAN response cannot cause another tenant's keys to be returned.
    redis.scanExtras.push('atrium:tenant:tenant-b:call:two', 'atrium:call:two', 'unrelated:call:two')
    for (const tenant of TENANTS) await withTenant(tenant, async () => {
      assert.deepEqual(await docs.list('call:'), ['call:one', 'call:two'])
    })
    const before = new Map(redis.data)
    const commandOffset = redis.commands.length
    await withTenant('tenant-a', async () => {
      await docs.update('call:one', { owner: '', revisions: 0 }, (value) => ({ ...value, revisions: value.revisions + 1 }))
      await docs.delete('call:two')
    })
    assert.deepEqual(JSON.parse(redis.data.get('atrium:tenant:tenant-a:call:one')!), { owner: 'tenant-a', revisions: 1 })
    assert.equal(redis.data.has('atrium:tenant:tenant-a:call:two'), false)
    for (const [key, value] of before) {
      if (!key.startsWith('atrium:tenant:tenant-a:call:')) assert.equal(redis.data.get(key), value, `unrelated key changed: ${key}`)
    }
    const writes = redis.commands.slice(commandOffset).filter((command) => command[0] === 'EVAL' || command[0] === 'DEL')
    assert.deepEqual(writes.map((command) => command[0] === 'EVAL' ? command[3] : command[1]), [
      'atrium:tenant:tenant-a:call:one', 'atrium:tenant:tenant-a:call:two',
    ])
    assert.ok(redis.commands.some((command) => command[0] === 'SCAN' && command[1] !== '0'), 'listing must actually traverse more than one Redis cursor page')
  })

  test('shared adapters resolve every operation from its asynchronous request, not their creation context', async () => {
    const docs = withTenant('tenant-a', () => documentStoreFromEnv(KV_ENV))
    const calendar = withTenant('tenant-b', () => calendarStoreFromEnv(KV_ENV))
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    await Promise.all(TENANTS.map((tenant) => withTenant(tenant, async () => {
      if (++arrived === TENANTS.length) release()
      await barrier
      assert.equal(currentTenantId(), tenant)
      for (let step = 1; step <= 3; step++) {
        await nextTurn()
        assert.equal(currentTenantId(), tenant)
        await docs.update('call:shared', { tenant, count: 0 }, (value) => {
          assert.equal(value.tenant, tenant)
          return { ...value, count: value.count + 1 }
        })
        await calendar.mutate((state) => ({ ...state, blocks: [...state.blocks, { target: `2026-10-0${step}`, reason: tenant, blockedAt: '' }] }))
      }
      assert.deepEqual(await docs.get('call:shared'), { tenant, count: 3 })
      assert.deepEqual((await calendar.read()).blocks.map((block) => block.reason), [tenant, tenant, tenant])
    })))
    assert.equal(currentTenantId(), LEGACY_TENANT)
    for (const tenant of TENANTS) {
      const key = `${tenantNamespace(tenant)}:call:shared`
      assert.deepEqual(JSON.parse(redis.data.get(key)!), { tenant, count: 3 })
    }
  })

  test('legacy broad listing does not expose named-workspace keys', async () => {
    const docs = documentStoreFromEnv(KV_ENV)
    await withTenant(LEGACY_TENANT, () => docs.set('call:own', { tenant: LEGACY_TENANT }))
    await withTenant('tenant-a', () => docs.set('call:private', { tenant: 'tenant-a' }))
    await withTenant('tenant-b', () => docs.set('call:private', { tenant: 'tenant-b' }))
    assert.deepEqual(await withTenant(LEGACY_TENANT, () => docs.list('')), ['call:own'])
    assert.deepEqual(await withTenant('tenant-a', () => docs.list('')), ['call:private'])
  })

  test('legacy logical keys cannot address the reserved named-tenant namespace', async () => {
    const docs = documentStoreFromEnv(KV_ENV)
    const privateValue = { tenant: 'tenant-a', private: true }
    await withTenant('tenant-a', () => docs.set('call:private', privateValue))
    const escapedKey = 'tenant:tenant-a:call:private'
    await withTenant(LEGACY_TENANT, async () => {
      await assert.rejects(() => docs.get(escapedKey))
      await assert.rejects(() => docs.set(escapedKey, { overwritten: true }))
      await assert.rejects(() => docs.update<Record<string, unknown>>(escapedKey, {}, () => ({ overwritten: true })))
      await assert.rejects(() => docs.delete(escapedKey))
    })
    assert.deepEqual(JSON.parse(redis.data.get('atrium:tenant:tenant-a:call:private')!), privateValue)
  })

  test('invalid runtime tenant identities are refused before any Redis operation', async () => {
    const docs = documentStoreFromEnv(KV_ENV)
    const invalid: unknown[] = ['', '../tenant-a', 'tenant:a', 'tenant a', 'tenant-a\n', 'TENANT-A', '*', 'a'.repeat(65), null, undefined, 123, {}, []]
    for (const value of invalid) {
      assert.throws(() => validateTenantId(value as string), /Invalid tenant identity/, `must reject ${JSON.stringify(value)}`)
      assert.throws(() => withTenant(value as string, () => docs.set('call:invalid', {})), /Invalid tenant identity/)
      // An omitted namespace argument intentionally resolves the active tenant.
      if (value !== undefined) assert.throws(() => tenantNamespace(value as string), /Invalid tenant identity/)
    }
    assert.equal(redis.commands.length, 0)
  })

  test('nested scopes and failed asynchronous work restore their previous tenant', async () => {
    assert.equal(tenantNamespace(), 'atrium')
    await withTenant('tenant-a', async () => {
      assert.equal(tenantNamespace(), 'atrium:tenant:tenant-a')
      await assert.rejects(withTenant('tenant-b', async () => {
        await nextTurn()
        assert.equal(currentTenantId(), 'tenant-b')
        throw new Error('a failed tenant request')
      }), /failed tenant request/)
      assert.equal(currentTenantId(), 'tenant-a')
    })
    assert.equal(currentTenantId(), LEGACY_TENANT)
  })
})

test('deployed requests cannot silently fall back to the legacy tenant', async () => {
  const previousNode = process.env.NODE_ENV
  const previousVercel = process.env.VERCEL
  try {
    for (const hosted of [{ NODE_ENV: 'production', VERCEL: '' }, { NODE_ENV: 'development', VERCEL: '1' }]) {
      Object.assign(process.env, hosted)
      assert.throws(() => currentTenantId(), /explicit tenant scope/)
      assert.equal(await withTenant('explicit-property', async () => {
        await Promise.resolve()
        return currentTenantId()
      }), 'explicit-property')
      assert.equal(withTenant('legacy', () => currentTenantId()), 'legacy')
    }
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel
  }
})
