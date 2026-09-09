import { before, after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import calendar from '../calendar.ts'
import vapi from '../vapi.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'

const originalEnv = { ...process.env }
const passcode = 'calendar-settings-test-password'
const store = calendarStoreFromEnv()
before(() => {
  delete process.env.OPS_ACCOUNTS_JSON
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  delete process.env.VAPI_WEBHOOK_SECRET
  delete process.env.NODE_ENV
  process.env.OPS_DASHBOARD_PASSCODE = passcode
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})
beforeEach(async () => { await store.mutate(() => ({ bookings: [], blocks: [] })) })
async function invoke(handler: typeof calendar | typeof vapi, req: any) {
  const res: any = { code: 0, body: null, setHeader() {}, status(c: number) { this.code = c; return this }, json(body: unknown) { this.body = body; return this } }
  await handler(req, res)
  return res
}
const call = (method: string, body?: unknown, query?: Record<string, string>) => invoke(calendar, { method, body, query, headers: { 'x-ops-passcode': passcode } })
const tool = async (name: string, args: Record<string, unknown>, id: string) => {
  const response = await invoke(vapi, { method: 'POST', headers: {}, body: { message: { type: 'tool-calls', call: { id }, toolCallList: [{ id: `tool-${id}`, name, arguments: args }] } } })
  assert.equal(response.code, 200)
  return String(response.body.results[0].result)
}
const range = { from: '2032-06-01', to: '2032-06-07' }

test('staff can page years ahead, while notice and booking window stay separate', async () => {
  const future = await call('GET', undefined, range)
  assert.equal(future.code, 200)
  assert.deepEqual(future.body.range, range)
  assert.ok(future.body.slots.length > 50)
  assert.ok(future.body.slots.every((s: any) => s.date >= range.from && s.date <= range.to))
  assert.equal(future.body.settings.bookingWindowDays, null)
  const updated = await call('POST', { action: 'settings', settings: { ...defaultSettings(), bookingWindowDays: 30 }, settingsRevision: 0, ...range })
  assert.equal(updated.code, 200)
  assert.ok(updated.body.slots.every((s: any) => s.status === 'unavailable'))
  assert.ok(updated.body.slots.length > 50, 'future calendar still displays when booking is restricted')
})

test('malformed dates, ranges, settings, and impossible block times return 400 without writes', async () => {
  for (const query of [{ from: '2032-02-30', to: '2032-03-01' }, { from: '2032-01-01', to: '2033-01-01' }, { from: '2032-02-02', to: '2032-02-01' }]) assert.equal((await call('GET', undefined, query)).code, 400)
  for (const target of ['2032-02-30', 'slot-2032-02-30T12:00', 'slot-2032-03-01T24:00', 'slot-2032-03-01T12:90']) assert.equal((await call('POST', { action: 'block', target })).code, 400)
  for (const capacity of [0, 51, '3', null]) assert.equal((await call('POST', { action: 'settings', settings: { ...defaultSettings(), capacity }, settingsRevision: 0 })).code, 400)
  assert.equal((await store.read()).settings, undefined)
  assert.deepEqual((await store.read()).blocks, [])
  assert.equal((await call('POST', '{broken')).code, 400)
})

test('settings use revision checks so concurrent editors cannot silently overwrite each other', async () => {
  const results = await Promise.all([3, 4].map(capacity => call('POST', { action: 'settings', settings: { ...defaultSettings(), capacity }, settingsRevision: 0 })))
  assert.deepEqual(results.map(r => r.code).sort(), [200, 409])
  assert.equal((await store.read()).settingsRevision, 1)
})

test('Vapi and portal use the same far-future capacity, duration and apartment availability', async () => {
  const settings = { ...defaultSettings(), capacity: 3, slotMinutes: 45, startIntervalMinutes: 15 }
  assert.equal((await call('POST', { action: 'settings', settings, settingsRevision: 0 })).code, 200)
  const listed = await tool('list_tour_slots', { preferredDate: range.from, unitId: '09F' }, 'list-settings')
  const slotId = listed.match(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)?.[0]
  assert.ok(slotId)
  for (const [i, unitId] of ['09F', '06F', '13L'].entries()) {
    const result = await tool('book_tour', { slotId, unitId, prospectName: `Visitor ${i}` }, `settings-book-${i}`)
    assert.match(result, /all set/)
  }
  const state = await store.read()
  assert.equal(state.bookings.length, 3)
  assert.equal(Date.parse(state.bookings[0]!.endsAt!) - Date.parse(state.bookings[0]!.startsAt!), 45 * 60000)
  const full = await tool('list_tour_slots', { preferredDate: range.from }, 'list-full')
  assert.ok(!full.includes(slotId), 'full time is not offered')
  const fourth = await tool('book_tour', { slotId, prospectName: 'Fourth visitor' }, 'settings-book-fourth')
  assert.doesNotMatch(fourth, /all set/)
  assert.equal((await store.read()).bookings.length, 3)
  // Changing hours and duration cannot alter or hide the saved tours in the staff calendar.
  await call('POST', { action: 'settings', settings: { ...settings, hours: {}, slotMinutes: 60 }, settingsRevision: 1 })
  const view = await call('GET', undefined, range)
  const booked = view.body.slots.find((s: any) => s.slotId === slotId)
  assert.ok(booked)
  assert.equal(booked.bookings.length, 3)
  assert.equal(Date.parse(booked.endsAt) - Date.parse(booked.startsAt), 45 * 60000)
})

test('Vapi validates dates and apartments and does not claim requested closed days are available', async () => {
  assert.match(await tool('list_tour_slots', { preferredDate: '2032-02-30' }, 'bad-date'), /invalid/)
  assert.match(await tool('list_tour_slots', { unitId: 'imaginary' }, 'bad-unit'), /not in the building inventory/)
  await call('POST', { action: 'block', target: range.from })
  assert.match(await tool('list_tour_slots', { preferredDate: range.from }, 'closed-date'), /No times are open on 2032-06-01; these are alternatives/)
})

test('production cannot bulk-clear tour reservations', async () => {
  process.env.NODE_ENV = 'production'
  try { assert.equal((await call('POST', { action: 'clear_bookings' })).code, 403) }
  finally { delete process.env.NODE_ENV }
})

test('restoring a removed block preserves its original duration after settings change', async () => {
  const target = 'slot-2032-06-01T14:00'
  await call('POST', { action: 'block', target, reason: 'Staff meeting', ...range })
  const saved = (await store.read()).blocks[0]!
  await call('POST', { action: 'settings', settings: { ...defaultSettings(), slotMinutes: 60 }, settingsRevision: 0 })
  await call('POST', { action: 'unblock', target })
  const restored = await call('POST', { action: 'block', ...saved, ...range })
  assert.equal(restored.code, 200)
  assert.equal((await store.read()).blocks[0]!.endsAt, saved.endsAt)
  const invalid = await call('POST', { action: 'block', target: 'slot-2032-06-01T15:00', startsAt: saved.startsAt, endsAt: saved.endsAt })
  assert.equal(invalid.code, 400)
})
