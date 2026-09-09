import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The calendar API must accept the slot ids it hands out. It rejected them for a day:
 * ids gained minute precision and the validation pattern here still expected hours, so
 * the dashboard could block whole days but never a single time — and said so honestly,
 * which is how the reviewers caught it.
 */
const OPS_PASSCODE = 'test-operations-passcode'
let handler: (req: any, res: any) => Promise<void>

before(async () => {
  process.env.OPS_DASHBOARD_PASSCODE = OPS_PASSCODE
  handler = (await import('../calendar.ts')).default
})
after(() => { delete process.env.OPS_DASHBOARD_PASSCODE })

function mockRes() {
  const r: any = {
    code: 0, body: null, headers: {} as Record<string, string>,
    status(c: number) { r.code = c; return r },
    json(b: unknown) { r.body = b; return r },
    setHeader(k: string, v: string) { r.headers[k] = v; return r },
  }
  return r
}
const headers = { 'x-ops-passcode': OPS_PASSCODE }
async function call(method: string, body?: unknown) {
  const res = mockRes()
  if (method === 'POST' && body && typeof body === 'object') body = { expectedTimeZone: 'America/New_York', ...body }
  await handler({ method, headers, body }, res)
  return res
}

describe('the calendar accepts the slot ids it hands out', () => {
  test('a single time can be blocked and reopened by its own id', async () => {
    const list = await call('GET')
    assert.equal(list.code, 200)
    const open = (list.body.slots as Array<{ slotId: string; status: string }>).find((s) => s.status === 'open')
    assert.ok(open, 'the calendar offers at least one open time')
    assert.match(open!.slotId, /^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)

    const blocked = await call('POST', { action: 'block', target: open!.slotId, reason: 'Painting' })
    assert.equal(blocked.code, 200, JSON.stringify(blocked.body))
    const after = (blocked.body.slots as Array<{ slotId: string; status: string }>).find((s) => s.slotId === open!.slotId)
    assert.equal(after?.status, 'blocked')

    const reopened = await call('POST', { action: 'unblock', target: open!.slotId })
    assert.equal(reopened.code, 200)
    const again = (reopened.body.slots as Array<{ slotId: string; status: string }>).find((s) => s.slotId === open!.slotId)
    assert.equal(again?.status, 'open')
  })

  test('anything that is not a slot id or a date is still refused', async () => {
    const bad = await call('POST', { action: 'block', target: 'slot-2026-09-08', reason: 'x' })
    assert.equal(bad.code, 400)
    const worse = await call('POST', { action: 'block', target: '<script>', reason: 'x' })
    assert.equal(worse.code, 400)
  })
})
