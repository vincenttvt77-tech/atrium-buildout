import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mintAccountSession, OPS_COOKIE } from '../../src/ops/session.ts'
import type { OpsAccount } from '../../src/ops/accounts.ts'
import { VOICE_CONTRACT } from '../../src/vapi/contract.ts'

const PASSCODE = 'sync-test-passcode'
let handler: (req: unknown, res: unknown) => Promise<void>
const realFetch = globalThis.fetch
const envKeys = ['OPS_DASHBOARD_PASSCODE', 'OPS_ACCOUNTS_JSON', 'OPS_SESSION_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'VAPI_ASSISTANT_ID', 'VAPI_SERVER_BASE_URL', 'VAPI_SYNC_TENANT_ID', 'VAPI_WEBHOOK_SECRET', 'VAPI_WEBHOOK_CREDENTIAL_ID', 'VERCEL_ENV', 'VERCEL', 'NODE_ENV'] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

before(async () => {
  handler = (await import('../vapi-sync.ts')).default
})
beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
  process.env.OPS_DASHBOARD_PASSCODE = PASSCODE
  process.env.VAPI_API_KEY = 'sk-test'
  process.env.VAPI_SERVER_BASE_URL = 'https://ghost-building.vercel.app'
  process.env.VAPI_WEBHOOK_SECRET = 'test-only-webhook-secret'
  process.env.VAPI_WEBHOOK_CREDENTIAL_ID = 'test-webhook-credential'
  globalThis.fetch = realFetch
})
after(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  globalThis.fetch = realFetch
})

function mockRes() {
  const r: any = { code: 0, body: null, status(c: number) { r.code = c; return r }, json(b: unknown) { r.body = b; return r }, setHeader() { return r } }
  return r
}

describe('updating the phone assistant from the dashboard', () => {
  test('needs the passcode', async () => {
    const res = mockRes()
    await handler({ method: 'POST', headers: {} }, res)
    assert.equal(res.code, 401)
  })
  test('writes and verifies the assistant using the configured origin, ignoring forwarded host headers', async () => {
    const patches: Array<{ url: string; body: any }> = []
    let saved: Record<string, unknown> = { id: 'a9', name: 'The Larkin — Leasing', model: { provider: 'anthropic', model: 'claude-sonnet-5' } }
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, durable: true, voiceContract: VOICE_CONTRACT }))
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') { const body = JSON.parse(String(init!.body)); patches.push({ url, body }); saved = { ...saved, ...body }; return new Response('{}', { status: 200 }) }
      if (url.endsWith('/assistant')) return new Response(JSON.stringify([{ id: 'a9', name: 'The Larkin — Leasing' }]), { status: 200 })
      return new Response(JSON.stringify(saved), { status: 200 })
    }) as unknown as typeof fetch
    const res = mockRes()
    process.env.VERCEL_ENV = 'production'
    await handler({ method: 'POST', headers: { 'x-ops-passcode': PASSCODE, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } }, res)
    assert.equal(res.code, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
    assert.equal(patches.length, 1)
    assert.equal(patches[0]!.body.server.url, 'https://ghost-building.vercel.app/api/vapi')
    assert.equal(patches[0]!.body.server.credentialId, 'test-webhook-credential')
    assert.ok(!JSON.stringify(patches).includes('test-only-webhook-secret'), 'webhook secret stays in credentials, not the assistant payload')
    assert.equal(patches[0]!.body.model.tools.length, 7)
  })

  test('preview environments cannot reroute an assistant', async () => {
    let requests = 0
    globalThis.fetch = (async () => { requests++; throw new Error('must not fetch') }) as typeof fetch
    process.env.VERCEL_ENV = 'preview'
    const res = mockRes()
    await handler({ method: 'POST', headers: { 'x-ops-passcode': PASSCODE } }, res)
    assert.equal(res.code, 409)
    assert.match(res.body.error, /preview/)
    assert.equal(requests, 0)
  })

  test('production requires an explicit HTTPS origin without paths, credentials or request-header fallback', async () => {
    let requests = 0
    globalThis.fetch = (async () => { requests++; throw new Error('must not fetch') }) as typeof fetch
    process.env.NODE_ENV = 'production'
    for (const origin of ['', 'http://production.example', 'https://example.com/api', 'https://example.com?target=x', 'https://user:secret@example.com', 'https://localhost:4300']) {
      process.env.VAPI_SERVER_BASE_URL = origin
      const res = mockRes()
      await handler({ method: 'POST', headers: { 'x-ops-passcode': PASSCODE, host: 'production.example' } }, res)
      assert.equal(res.code, 503, origin)
      assert.match(res.body.error, /VAPI_SERVER_BASE_URL/)
    }
    assert.equal(requests, 0)
  })
})

function account(tenantId: string, assistantIds: string[]): OpsAccount {
  return {
    username: tenantId, tenantId, displayName: tenantId, assistantIds,
    passwordHash: `scrypt$65536$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
  }
}

function accountHeaders(accounts: OpsAccount[], selected: OpsAccount) {
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
  process.env.OPS_SESSION_SECRET = 'test-session-secret-with-more-than-32-characters'
  return { cookie: `${OPS_COOKIE}=${mintAccountSession(new Date(), selected)}` }
}

describe('workspace assistant publishing', () => {
  test('only the configured property owner can publish, using its session binding instead of a body or global assistant ID', async () => {
    const larkin = account('larkin', ['larkin-assistant'])
    const other = account('other', ['other-assistant'])
    process.env.VAPI_SYNC_TENANT_ID = 'larkin'
    process.env.VAPI_ASSISTANT_ID = 'other-assistant'
    const urls: string[] = []
    let saved: Record<string, unknown> = { id: 'larkin-assistant', name: 'Larkin', model: { provider: 'anthropic' } }
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, durable: true, voiceContract: VOICE_CONTRACT }))
      urls.push(url)
      if (init?.method === 'PATCH') saved = { ...saved, ...JSON.parse(String(init.body)) }
      return new Response(JSON.stringify(saved))
    }) as unknown as typeof fetch
    const owner = mockRes()
    await handler({ method: 'POST', headers: accountHeaders([larkin, other], larkin), body: { assistantId: 'other-assistant', tenantId: 'other' } }, owner)
    assert.equal(owner.code, 200, JSON.stringify(owner.body))
    assert.equal(urls.length, 3)
    assert.ok(urls.every((url) => url === 'https://api.vapi.ai/assistant/larkin-assistant'))
    const denied = mockRes()
    await handler({ method: 'POST', headers: accountHeaders([larkin, other], other), body: { tenantId: 'larkin' } }, denied)
    assert.equal(denied.code, 403)
    assert.equal(urls.length, 3, 'another workspace cannot cause any Vapi request')
  })

  test('named workspaces need an explicit property owner binding and exactly one assistant', async () => {
    let requests = 0
    globalThis.fetch = (async () => { requests++; throw new Error('must not fetch') }) as typeof fetch
    const bound = account('larkin', ['larkin-assistant'])
    const missingOwner = mockRes()
    await handler({ method: 'POST', headers: accountHeaders([bound], bound) }, missingOwner)
    assert.equal(missingOwner.code, 403)
    process.env.VAPI_SYNC_TENANT_ID = 'larkin'
    for (const ids of [[], ['one', 'two']]) {
      const member = account('larkin', ids)
      const res = mockRes()
      await handler({ method: 'POST', headers: accountHeaders([member], member) }, res)
      assert.equal(res.code, 409)
    }
    assert.equal(requests, 0)
  })

  test('a failed saved-state check is returned as failure, not a successful publish', async () => {
    const larkin = account('larkin', ['larkin-assistant'])
    process.env.VAPI_SYNC_TENANT_ID = 'larkin'
    globalThis.fetch = (async (url) => String(url).endsWith('/api/health')
      ? new Response(JSON.stringify({ ok: true, durable: true, voiceContract: VOICE_CONTRACT }))
      : new Response('{"id":"larkin-assistant","name":"Larkin","model":{"messages":[]}}')) as typeof fetch
    const res = mockRes()
    await handler({ method: 'POST', headers: accountHeaders([larkin], larkin) }, res)
    assert.equal(res.code, 502)
    assert.equal(res.body.ok, false)
    assert.match(res.body.error, /saved assistant did not match/)
  })
})

test('publishing refuses an old backend, unavailable storage, or unconfigured webhook authentication before any Vapi write', async () => {
  for (const failure of ['old-contract', 'storage', 'secret', 'credential']) {
    let vapiRequests = 0
    if (failure === 'secret') delete process.env.VAPI_WEBHOOK_SECRET
    if (failure === 'credential') delete process.env.VAPI_WEBHOOK_CREDENTIAL_ID
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('/api/health')) {
        assert.equal(init?.redirect, 'error')
        assert.deepEqual(init?.headers, { accept: 'application/json', 'cache-control': 'no-store' }, 'no key or user cookie goes to the probe')
        return new Response(JSON.stringify({ ok: true, durable: failure !== 'storage',
          voiceContract: failure === 'old-contract' ? { version: 0 } : VOICE_CONTRACT }))
      }
      vapiRequests++
      throw new Error('Must not reach Vapi')
    }) as typeof fetch
    const res = mockRes()
    await handler({ method: 'POST', headers: { 'x-ops-passcode': PASSCODE } }, res)
    assert.equal(res.body.ok, false, failure)
    assert.equal(vapiRequests, 0, failure)
    assert.match(res.body.code, /voice_(backend_contract_mismatch|authentication_not_configured)/)
    process.env.VAPI_WEBHOOK_SECRET = 'test-only-webhook-secret'
    process.env.VAPI_WEBHOOK_CREDENTIAL_ID = 'test-webhook-credential'
  }
})
