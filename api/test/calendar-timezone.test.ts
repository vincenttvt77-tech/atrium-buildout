import { before, after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createCalendarHandler } from '../calendar.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { hashPassword } from '../../src/ops/accounts.ts'
import { mintAccountSession, OPS_COOKIE } from '../../src/ops/session.ts'
import { withTenant } from '../../src/tenancy/context.ts'
import { propertyTimeZone } from '../../src/config/property.ts'

const originalEnv = { ...process.env }
const now = new Date('2032-06-01T04:30:00Z')
const store = calendarStoreFromEnv()
let accounts: Array<{ username: string; tenantId: string; displayName: string; passwordHash: string; assistantIds: string[] }>
before(async () => {
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  process.env.OPS_SESSION_SECRET = 'timezone-api-test-independent-signing-key'
  const passwordHash = await hashPassword('timezone-test-password-only')
  accounts = ['ny', 'chicago'].map(city => ({ username: `timezone-${city}`, tenantId: `timezone-${city}`, displayName: city, passwordHash, assistantIds: [] }))
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
})
beforeEach(async () => {
  for (const account of accounts) await withTenant(account.tenantId, () => store.mutate(() => ({ blocks: [], bookings: [] })))
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

async function call(city: 'ny' | 'chicago', method: string, body?: unknown, query?: Record<string, string>, property?: Record<string, unknown>) {
  const account = accounts[city === 'ny' ? 0 : 1]!
  if (method === 'POST' && body && typeof body === 'object') body = {
    expectedTimeZone: property?.timeZone ?? (city === 'ny' ? 'America/New_York' : 'America/Chicago'), ...body,
  }
  const handler = createCalendarHandler({ property: property ?? { timeZone: city === 'ny' ? 'America/New_York' : 'America/Chicago' }, now: () => now })
  const res: any = { code: 0, body: null, setHeader() {}, status(value: number) { this.code = value; return this }, json(value: unknown) { this.body = value; return this } }
  await handler({ method, body, query, headers: { cookie: `${OPS_COOKIE}=${mintAccountSession(new Date(), account)}`, 'x-time-zone': 'America/Los_Angeles' } }, res)
  return res
}

test('calendar API uses authoritative Chicago hours and dates and ignores client timezone overrides', async () => {
  const query = { from: '2032-06-01', to: '2032-06-01', timeZone: 'America/New_York' }
  const chicago = await call('chicago', 'GET', undefined, query)
  const ny = await call('ny', 'GET', undefined, query)
  assert.equal(chicago.code, 200)
  assert.equal(chicago.body.timeZone, 'America/Chicago')
  assert.equal(chicago.body.slots[0].startsAt, '2032-06-01T15:00:00.000Z')
  assert.equal(ny.body.slots[0].startsAt, '2032-06-01T14:00:00.000Z')
  assert.equal((await call('chicago', 'GET')).body.range.from, '2032-05-31')
  assert.equal((await call('ny', 'GET')).body.range.from, '2032-06-01')
  const changed = await call('chicago', 'POST', { action: 'settings', settings: { ...chicago.body.settings, timeZone: 'America/New_York' }, settingsRevision: 0, ...query })
  assert.equal(changed.code, 200)
  assert.equal(changed.body.timeZone, 'America/Chicago')
  assert.equal(changed.body.slots[0].startsAt, '2032-06-01T15:00:00.000Z')
  const stale = await call('chicago', 'POST', { action: 'block', target: '2032-06-01', expectedTimeZone: 'America/New_York' })
  assert.equal(stale.code, 409)
  assert.deepEqual((await call('chicago', 'GET')).body.blocks, [], 'stale page timezone cannot change an all-day block before the response detects the mismatch')
})

test('whole-day Chicago blocks persist exact local boundaries, stay tenant-scoped and survive undo', async () => {
  for (const [date, start, end, hours] of [
    ['2032-06-01', '2032-06-01T05:00:00.000Z', '2032-06-02T05:00:00.000Z', 24],
    ['2032-11-07', '2032-11-07T05:00:00.000Z', '2032-11-08T06:00:00.000Z', 25],
    ['2032-03-14', '2032-03-14T06:00:00.000Z', '2032-03-15T05:00:00.000Z', 23],
  ] as const) {
    const blocked = await call('chicago', 'POST', { action: 'block', target: date, reason: 'Office closed', from: date, to: date })
    assert.equal(blocked.code, 200)
    const block = blocked.body.blocks.find((candidate: any) => candidate.target === date)
    assert.equal(block.startsAt, start)
    assert.equal(block.endsAt, end)
    assert.equal(Date.parse(end) - Date.parse(start), hours * 3600000)
    assert.ok(blocked.body.slots.every((slot: any) => slot.status === 'blocked'))
    assert.equal((await call('ny', 'GET', undefined, { from: date, to: date })).body.blocks.length, 0)
    assert.equal((await call('chicago', 'POST', { action: 'unblock', target: date })).code, 200)
    const restored = await call('chicago', 'POST', { action: 'block', ...block })
    assert.equal(restored.code, 200)
    assert.equal(restored.body.blocks.find((candidate: any) => candidate.target === date).endsAt, end)
  }
})

test('calendar changes require an acknowledged property timezone before any write', async () => {
  for (const action of ['block', 'unblock', 'clear_blocks', 'clear_bookings', 'settings']) {
    const missing = await call('chicago', 'POST', { action, target: '2032-06-01', expectedTimeZone: undefined })
    assert.equal(missing.code, 428, action)
    const stale = await call('chicago', 'POST', { action, target: '2032-06-01', expectedTimeZone: 'America/New_York' })
    assert.equal(stale.code, 409, action)
  }
  assert.deepEqual(await withTenant(accounts[1]!.tenantId, () => store.read()), { blocks: [], bookings: [] })
})

test('retained all-day UTC bounds display partial coverage and restore exactly after timezone correction', async () => {
  const date = '2032-06-02', range = { from: date, to: date }
  const initial = await call('chicago', 'GET', undefined, range)
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { openHour: 0, closeHour: 24 }]))
  await call('chicago', 'POST', { action: 'settings', settings: { ...initial.body.settings, hours, minimumNoticeMinutes: 0 }, settingsRevision: 0 })
  const blocked = await call('chicago', 'POST', { action: 'block', target: date, ...range })
  const original = blocked.body.blocks[0]
  assert.deepEqual(original.wholeDayDates, [date])
  const property = { timeZone: 'America/Los_Angeles' }
  const corrected = await call('chicago', 'GET', undefined, range, property)
  assert.equal(corrected.body.blocks[0].startsAt, original.startsAt)
  assert.equal(corrected.body.blocks[0].endsAt, original.endsAt)
  assert.deepEqual(corrected.body.blocks[0].wholeDayDates, [])
  assert.equal(corrected.body.slots.filter((s: any) => s.status === 'open').length, 4)
  assert.ok(corrected.body.slots.filter((s: any) => s.status === 'blocked').every((s: any) => s.block.wholeDay === false))

  const ui = await portal(property.timeZone)
  const calendarSource = await readFile(new URL('../../ops/src/calendar.js', import.meta.url), 'utf8')
  // Expose the private pure projection only inside the test VM; execute real source.
  runInNewContext(calendarSource.replace("A.register('calendar', view)", "window.testCalendarModel = buildModel; A.register('calendar', view)"), ui.context)
  const model = ui.context.window.testCalendarModel({ calendar: corrected.body }, { date, view: 'day' })
  const day = model.dayModel(date)
  assert.equal(day.dayBlock, null)
  assert.equal(day.items.filter((item: any) => item.kind === 'open').length, 4, 'real late openings must remain visible')
  assert.ok(!day.items.some((item: any) => item.kind === 'dayband'))

  assert.equal((await call('chicago', 'POST', { action: 'unblock', target: date }, undefined, property)).code, 200)
  const restored = await call('chicago', 'POST', { action: 'block', ...original, ...range }, undefined, property)
  assert.equal(restored.code, 200)
  assert.equal(restored.body.blocks[0].startsAt, original.startsAt)
  assert.equal(restored.body.blocks[0].endsAt, original.endsAt)
  assert.equal(restored.body.slots.filter((s: any) => s.status === 'open').length, 4)

  const extended = await call('chicago', 'POST', { action: 'block', target: date, ...range }, undefined, property)
  assert.equal(extended.code, 200)
  assert.equal(extended.body.blocks[0].startsAt, original.startsAt, 'old coverage remains reserved')
  assert.equal(extended.body.blocks[0].endsAt, '2032-06-03T07:00:00.000Z')
  assert.deepEqual(extended.body.blocks[0].wholeDayDates, [date])
  assert.ok(extended.body.slots.every((s: any) => s.status === 'blocked'), 'explicit whole-day action must not be a no-op')
  const expectedBlock = { startsAt: extended.body.blocks[0].startsAt, endsAt: extended.body.blocks[0].endsAt }
  const undone = await call('chicago', 'POST', { action: 'block', ...original, expectedBlock, ...range }, undefined, property)
  assert.equal(undone.code, 200)
  assert.equal(undone.body.blocks[0].startsAt, original.startsAt)
  assert.equal(undone.body.blocks[0].endsAt, original.endsAt, 'Undo of extension must preserve the earlier reservation')
  assert.equal(undone.body.slots.filter((s: any) => s.status === 'open').length, 4)
  const staleUndo = await call('chicago', 'POST', { action: 'block', ...original, expectedBlock, ...range }, undefined, property)
  assert.equal(staleUndo.code, 409, 'stale undo must not overwrite later block changes')
})

test('restored date blocks reject malformed, unrelated and unbounded intervals without writes', async () => {
  for (const [startsAt, endsAt] of [
    ['invalid', '2032-06-02T05:00:00.000Z'],
    ['2032-06-01T05:00:00.000Z', '2032-06-01T04:00:00.000Z'],
    ['2032-06-01T05:00:00.000Z', '2032-06-04T05:00:00.000Z'],
    ['2032-06-10T05:00:00.000Z', '2032-06-11T05:00:00.000Z'],
    ['June 1, 2032', '2032-06-02T05:00:00.000Z'],
  ]) {
    const response = await call('chicago', 'POST', { action: 'block', target: '2032-06-01', startsAt, endsAt })
    assert.equal(response.code, 400)
  }
  assert.deepEqual((await call('chicago', 'GET')).body.blocks, [])
})

test('bookings around UTC midnight belong to the property day while stored instants remain unchanged', async () => {
  const booking = { slotId: 'slot-2032-06-02T04:30', externalId: 'late-tour', startsAt: '2032-06-02T04:30:00.000Z',
    endsAt: '2032-06-02T05:00:00.000Z', prospectName: 'Test Visitor', prospectPhone: '+15165550125', prospectEmail: null, unitId: null, bookedAt: now.toISOString() }
  for (const account of accounts) await withTenant(account.tenantId, () => store.mutate(state => ({ ...state, bookings: [booking] })))
  const query = { from: '2032-06-01', to: '2032-06-01' }
  const chicago = await call('chicago', 'GET', undefined, query)
  const ny = await call('ny', 'GET', undefined, query)
  const row = chicago.body.slots.find((slot: any) => slot.slotId === booking.slotId)
  assert.equal(row.date, '2032-06-01')
  assert.equal(row.bookings[0].startsAt, booking.startsAt)
  assert.ok(!ny.body.slots.some((slot: any) => slot.slotId === booking.slotId))
})

test('missing legacy timezone defaults to New York; invalid explicit configuration closes API reads and writes', async () => {
  assert.equal(propertyTimeZone({}), 'America/New_York')
  assert.equal((await call('ny', 'GET', undefined, undefined, {})).body.timeZone, 'America/New_York')
  for (const timeZone of [null, '', 'EST', 'America/Miami', ' Mars/Olympus', 123]) {
    const property = { timeZone }
    assert.equal((await call('chicago', 'GET', undefined, undefined, property)).code, 503)
    const result = await call('chicago', 'POST', { action: 'block', target: '2032-06-01' }, undefined, property)
    assert.equal(result.code, 503)
    assert.equal(result.body.code, 'property_timezone_invalid')
    assert.match(result.body.error, /timezone is invalid/)
  }
  assert.deepEqual(await withTenant(accounts[1]!.tenantId, () => store.read()), { blocks: [], bookings: [] })
})

async function portal(timeZone?: unknown) {
  const source = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
  const window: any = timeZone === undefined ? {} : { ATRIUM_PROPERTY: { timeZone } }
  const document = { readyState: 'loading', addEventListener() {}, body: { textContent: '' } }
  let payload: any = { timeZone: timeZone ?? 'America/New_York', slots: [], blocks: [], bookings: [] }
  const requests: Array<{ path: string; body?: string }> = []
  const context = { window, document, Intl, Date: class extends Date { static now() { return now.getTime() } },
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false }),
    fetch: async (path: string, init: { body?: string }) => { requests.push({ path, ...init }); return { ok: true, status: 200, json: async () => payload } } }
  runInNewContext(source, context)
  return { app: window.Atrium, context, document, requests, respond: (data: unknown) => { payload = data } }
}

test('portal formatting, Today and calendar response checks use the bootstrapped property timezone', async () => {
  const chicago = await portal('America/Chicago'), ny = await portal()
  assert.equal(chicago.app.property.timeZone, 'America/Chicago')
  assert.equal(chicago.app.fmt.time('2032-06-01T15:00:00Z'), '10:00 AM')
  assert.equal(ny.app.fmt.time('2032-06-01T15:00:00Z'), '11:00 AM')
  assert.equal(chicago.app.fmt.nyNow().ymd, '2032-05-31')
  assert.equal(ny.app.fmt.nyNow().ymd, '2032-06-01')
  const state = { calendar: { slots: [], bookings: [{ slotId: 'slot-2032-06-01T04:30', startsAt: now.toISOString(), prospectName: 'Late visitor' }] }, leads: { profiles: [] } }
  assert.equal(chicago.app.derive.toursOn(state, '2032-05-31').length, 1)
  assert.equal(ny.app.derive.toursOn(state, '2032-05-31').length, 0)
  assert.equal((await chicago.app.api.get('/api/calendar')).timeZone, 'America/Chicago')
  await chicago.app.api.post('/api/calendar', { action: 'block', target: '2032-06-01' })
  assert.equal(JSON.parse(chicago.requests.at(-1)!.body!).expectedTimeZone, 'America/Chicago')
  chicago.respond({ timeZone: 'America/New_York' })
  await assert.rejects(chicago.app.api.get('/api/calendar'), /timezone changed/)
  chicago.respond({ timeZone: 'invalid' })
  await assert.rejects(chicago.app.api.get('/api/calendar'), /invalid property timezone/)
  const invalid = await portal('America/Miami')
  assert.equal(invalid.app, undefined)
  assert.match(invalid.document.body.textContent, /timezone is invalid/)
})
