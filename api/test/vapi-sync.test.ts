import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

const PASSCODE = 'sync-test-passcode'
let handler: (req: unknown, res: unknown) => Promise<void>
const realFetch = globalThis.fetch

before(async () => {
  process.env.OPS_DASHBOARD_PASSCODE = PASSCODE
  process.env.VAPI_API_KEY = 'sk-test'
  delete process.env.VAPI_PRIVATE_KEY
  handler = (await import('../vapi-sync.ts')).default
})
after(() => { delete process.env.OPS_DASHBOARD_PASSCODE; delete process.env.VAPI_API_KEY; globalThis.fetch = realFetch })

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
  test('writes the script and tools to the assistant, pointing at this deployment', async () => {
    const patches: Array<{ url: string; body: any }> = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') { patches.push({ url, body: JSON.parse(String(init!.body)) }); return new Response('{}', { status: 200 }) }
      if (url.endsWith('/assistant')) return new Response(JSON.stringify([{ id: 'a9', name: 'The Larkin — Leasing' }]), { status: 200 })
      return new Response(JSON.stringify({ id: 'a9', name: 'The Larkin — Leasing', model: { provider: 'anthropic', model: 'claude-sonnet-5' } }), { status: 200 })
    }) as unknown as typeof fetch
    const res = mockRes()
    await handler({ method: 'POST', headers: { 'x-ops-passcode': PASSCODE, 'x-forwarded-host': 'ghost-building.vercel.app', 'x-forwarded-proto': 'https' } }, res)
    assert.equal(res.code, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
    assert.equal(patches.length, 1)
    assert.equal(patches[0]!.body.server.url, 'https://ghost-building.vercel.app/api/vapi')
    assert.equal(patches[0]!.body.model.tools.length, 7)
  })
})
