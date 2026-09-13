import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import leads from '../leads.ts'
import { hashPassword, type OpsAccount } from '../../src/ops/accounts.ts'
import { mintAccountSession, OPS_COOKIE } from '../../src/ops/session.ts'
import { documentStoreFromEnv } from '../../src/store/documents.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { withTenant } from '../../src/tenancy/context.ts'
import { recordTourChangeRequest } from '../../src/leads/tour-change.ts'

const original = { ...process.env }
let accounts: OpsAccount[]
before(async () => {
  for (const key of Object.keys(process.env)) if (/^(ATRIUM_|KV_|UPSTASH_|OPS_|VAPI_|VERCEL)/.test(key)) delete process.env[key]
  delete process.env.NODE_ENV
  process.env.OPS_SESSION_SECRET = randomBytes(36).toString('base64url')
  const passwordHash = await hashPassword(randomBytes(20).toString('base64url'))
  accounts = ['request-a', 'request-b'].map(id => ({ username: id, tenantId: id, displayName: id, passwordHash, assistantIds: [] }))
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
const seed = (account: number, callId: string, excerpt = 'Please move my tour.') => withTenant(accounts[account]!.tenantId,
  () => recordTourChangeRequest(documentStoreFromEnv(), { callId, at: new Date('2026-09-09T20:00:00Z'), reason: 'caller_requested', excerpt }))

test('same call identifier stays isolated per workspace and anonymous requests remain visible', async () => {
  const records = await Promise.all([seed(0, 'same-call', 'Workspace A request'), seed(1, 'same-call', 'Workspace B request')])
  assert.equal(records[0]!.id, records[1]!.id)
  for (const i of [0, 1]) {
    const result = await request(i)
    assert.equal(result.code, 200)
    assert.equal(result.body.tourChangeRequests.length, 1)
    assert.equal(result.body.tourChangeRequests[0].excerpts[0], `Workspace ${i === 0 ? 'A' : 'B'} request`)
    assert.equal(result.body.tourChangeRequests[0].phone, null)
    assert.equal(result.body.profiles.length, 0, 'no artificial lead is required to surface the request')
  }
})

test('review records only server-authenticated review and exact retry preserves original time/revision', async () => {
  const record = await seed(0, 'review-call')
  const calendar = () => withTenant(accounts[0]!.tenantId, () => calendarStoreFromEnv().read())
  const beforeCalendar = await calendar()
  const body = { action: 'review_tour_change', id: record.id, expectedRevision: record.revision, note: 'Checked the request; identity still needs verification.' }
  const result = await request(0, body)
  assert.equal(result.code, 200)
  const saved = result.body.tourChangeRequest
  assert.equal(saved.status, 'reviewed')
  assert.equal(saved.review.actorId, accounts[0]!.username)
  assert.equal(saved.identityVerified, false)
  assert.equal(saved.notificationStatus, 'not_sent')
  assert.deepEqual((await request(0, body)).body.tourChangeRequest, saved, 'lost-response retry is the same review')
  assert.deepEqual(await calendar(), beforeCalendar, 'review cannot change, cancel or release a booking hold')
  const changed = await request(0, {...body, note: 'A different review'})
  assert.equal(changed.code, 409)
  await seed(0, 'review-call', 'New evidence: I want to cancel my tour instead.')
  assert.equal((await request(0, body)).code, 409, 'new caller evidence cannot be hidden by a stale review')
})

test('review rejects unauthenticated, stale-tab, forged actor and malformed revision requests before writes', async () => {
  const record = await seed(0, 'auth-call')
  const body = { action: 'review_tour_change', id: record.id, expectedRevision: record.revision }
  assert.equal((await request(0, body, false)).code, 401)
  assert.equal((await request(0, body, true, null)).code, 428)
  assert.equal((await request(1, body, true, accounts[0]!.tenantId)).body.code, 'portal_tenant_changed')
  assert.equal((await request(0, body, true, '')).code, 409)
  assert.equal((await request(1, body)).code, 404)
  for (const extra of [{ actorId: 'invented' }, { at: '2032-01-01' }, { identityVerified: true }, { expectedRevision: '0' }, { expectedRevision: -1 }, { note: 'x'.repeat(1001) }, { note: null }]) {
    assert.equal((await request(0, {...body, ...extra})).code, 400)
  }
  assert.equal((await request(0, {...body, expectedRevision: 99})).code, 409)
  const current = (await request(0)).body.tourChangeRequests.find((r: any) => r.id === record.id)
  assert.equal(current.status, 'pending')
  assert.equal(current.revision, record.revision)
})
