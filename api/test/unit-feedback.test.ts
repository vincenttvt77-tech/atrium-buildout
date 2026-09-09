import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import leads from '../leads.ts'
import vapi from '../vapi.ts'
import { hashPassword, type OpsAccount } from '../../src/ops/accounts.ts'
import { mintAccountSession, OPS_COOKIE } from '../../src/ops/session.ts'

const original = { ...process.env }
let accounts: OpsAccount[]
before(async () => {
  for (const key of Object.keys(process.env)) if (/^(ATRIUM_|KV_|UPSTASH_|OPS_|VAPI_|VERCEL)/.test(key)) delete process.env[key]
  delete process.env.NODE_ENV
  process.env.OPS_SESSION_SECRET = randomBytes(36).toString('base64url')
  const passwordHash = await hashPassword(randomBytes(20).toString('base64url'))
  accounts = ['feedback-a', 'feedback-b'].map(id => ({ username: id, tenantId: id, displayName: id, passwordHash, assistantIds: [] }))
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
})
async function request(account = 0, body?: Record<string, unknown>, authenticated = true, selectedTenant: string | null = accounts[account]!.tenantId) {
  const res: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this }, json(value: unknown) { this.body = value; return this } }
  await leads({ method: body ? 'POST' : 'GET', headers: authenticated ? { cookie: `${OPS_COOKIE}=${mintAccountSession(new Date(), accounts[account]!)}`,
    ...(selectedTenant === null ? {} : { 'x-atrium-tenant-id': selectedTenant }) } : {}, body }, res)
  return res
}
const entry = (extra = {}) => ({ action: 'unit_feedback_add', idempotencyKey: randomUUID(), unitId: '06F', sentiment: 'positive', category: 'layout', note: 'Synthetic feedback.', observedDate: '2026-09-09', ...extra })

test('existing named legacy accounts isolate identical retry keys and expose only scoped observations', async () => {
  const key = randomUUID()
  const writes = await Promise.all([0, 1].map(account => request(account, entry({ idempotencyKey: key, note: `Workspace ${account}` }))))
  assert.ok(writes.every(result => result.code === 200))
  assert.notEqual(writes[0].body.unitFeedback.id, writes[1].body.unitFeedback.id)
  for (const account of [0, 1]) {
    const read = await request(account)
    assert.equal(read.body.unitFeedback.length, 1)
    assert.equal(read.body.unitFeedback[0].note, `Workspace ${account}`)
    assert.equal(read.body.unitFeedback[0].createdBy.id, accounts[account]!.username)
    assert.ok(read.body.feedbackUnits.some((unit: any) => unit.unitId === '06F'))
    assert.equal(read.body.feedbackInventory.fictional, true)
    assert.equal(read.body.feedbackInventory.readAt, '2026-09-01T00:00:00.000Z')
  }
  const forbidden = await request(1, { action: 'unit_feedback_edit', id: writes[0].body.unitFeedback.id, expectedRevision: 1, idempotencyKey: randomUUID(), sentiment: 'negative', category: 'other', observedDate: '2026-09-09' })
  assert.equal(forbidden.code, 404)
})

test('feedback actions require authentication and refuse invented inventory, prospects and browser actor/scope fields', async () => {
  assert.equal((await request(0, entry(), false)).code, 401)
  assert.equal((await request(0, entry({ unitId: '999-Z' }))).code, 404)
  assert.equal((await request(0, entry({ leadPhone: '+12125550999' }))).code, 404)
  assert.equal((await request(0, entry({ tenantId: accounts[1]!.tenantId }))).code, 400)
  assert.equal((await request(0, entry({ createdBy: { id: 'owner' } }))).code, 400)
  assert.equal((await request(0, entry({ observedDate: '2099-01-01' }))).code, 400)
  assert.equal((await request(0)).body.unitFeedback.length, 1)
})

test('a cookie switch cannot read or write the workspace frozen into an older tab', async () => {
  for (const body of [undefined, entry(), { action: 'note', phone: '+12125550123', text: 'must not reach the new workspace' }]) {
    const result = await request(1, body, true, accounts[0]!.tenantId)
    assert.equal(result.code, 409); assert.equal(result.body.code, 'portal_tenant_changed')
  }
  const missing = await request(0, entry(), true, null)
  assert.equal(missing.code, 428); assert.equal(missing.body.code, 'portal_tenant_required')
  assert.equal((await request(0, undefined, true, null)).code, 200, 'older read clients remain compatible')
  assert.equal((await request(1)).body.unitFeedback.length, 1)
  const history: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this }, json(value: unknown) { this.body = value; return this } }
  await vapi({ method: 'GET', headers: { cookie: `${OPS_COOKIE}=${mintAccountSession(new Date(), accounts[1]!)}`,
    'x-atrium-tenant-id': accounts[0]!.tenantId } }, history)
  assert.equal(history.code, 409); assert.equal(history.body.code, 'portal_tenant_changed')
})
