import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import handler, { pickSlotsToOffer } from '../vapi.ts'
import property from '../../data/property.json' with { type: 'json' }
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import type { TourSlot } from '../../src/booking/types.ts'

const originalEnv = { ...process.env }, originalZone = property.timeZone
const store = calendarStoreFromEnv()
let sequence = 0
before(() => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'OPS_ACCOUNTS_JSON',
    'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
})
beforeEach(async () => {
  property.timeZone = 'America/New_York'
  mock.timers.enable({ apis: ['Date'], now: new Date('2032-06-01T12:00:00Z') })
  await store.mutate(() => ({ blocks: [], bookings: [], settings: { ...defaultSettings(), minimumNoticeMinutes: 0 } }))
})
afterEach(() => mock.timers.reset())
after(() => {
  property.timeZone = originalZone
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})
async function tool(name: string, args: Record<string, unknown>, callId = `preferred-time-${++sequence}`): Promise<string> {
  const res: any = { code: 0, body: null, setHeader() {}, status(value: number) { this.code = value; return this }, json(value: unknown) { this.body = value; return this } }
  await handler({ method: 'POST', headers: {}, body: { message: { type: 'tool-calls', call: { id: callId },
    toolCallList: [{ id: `tool-${sequence}`, name, arguments: args }] } } }, res)
  assert.equal(res.code, 200)
  return String(res.body.results[0].result)
}
const list = (args: Record<string, unknown> = {}) => tool('list_tour_slots', { preferredDate: '2032-06-02', preferredTime: '16:00', ...args })
const slots = (response: string) => [...response.matchAll(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)].map(match => match[0])

test('a Wednesday 4 PM request returns its actual slot first even when the first six starts are in the morning', async () => {
  const result = await list()
  assert.equal(slots(result)[0], 'slot-2032-06-02T20:00')
  assert.match(result, /Wednesday, June 2, 2032 at 4:00 PM/)
  assert.equal(slots(result).length, 6)
  assert.doesNotMatch(result, /No tour starts/)
  const booked = await tool('book_tour', { slotId: slots(result)[0], unitId: '09F', prospectName: 'Time Test' })
  assert.match(booked, /June 2, 2032 at 4:00 PM.*tour is confirmed/)
  assert.equal((await store.read()).bookings[0]!.startsAt, '2032-06-02T20:00:00.000Z')
})

test('an unavailable exact time offers nearest real starts and never invents an off-grid appointment', async () => {
  await store.mutate(state => ({ ...state, blocks: [{ target: 'slot-2032-06-02T20:00', reason: 'Staff unavailable',
    blockedAt: '2032-06-01T12:00:00Z', startsAt: '2032-06-02T20:00:00Z', endsAt: '2032-06-02T20:30:00Z' }] }))
  const blocked = await list()
  assert.match(blocked, /No tour starts at 16:00 on 2032-06-02; these are the nearest available times on that date/)
  assert.deepEqual(slots(blocked).slice(0, 2), ['slot-2032-06-02T19:30', 'slot-2032-06-02T20:30'])
  assert.ok(!slots(blocked).includes('slot-2032-06-02T20:00'))
  const offGrid = await list({ preferredTime: '16:10' })
  assert.equal(slots(offGrid)[0], 'slot-2032-06-02T20:30')
  assert.ok(!slots(offGrid).includes('slot-2032-06-02T20:10'))
})

test('exact-time search honors the building timezone instead of model timezone overrides', async () => {
  property.timeZone = 'America/Chicago'
  const result = await list({ timeZone: 'America/Los_Angeles' })
  assert.equal(slots(result)[0], 'slot-2032-06-02T21:00')
  assert.match(result, /June 2, 2032 at 4:00 PM/)
  const booked = await tool('book_tour', { slotId: slots(result)[0], unitId: '09F', prospectName: 'Chicago Time Test' })
  assert.match(booked, /at 4:00 PM/)
  assert.equal((await store.read()).bookings[0]!.startsAt, '2032-06-02T21:00:00.000Z')
})

test('exact-time search preserves apartment exclusivity and staff capacity', async () => {
  const slotId = 'slot-2032-06-02T20:00'
  assert.match(await tool('book_tour', { slotId, unitId: '09F', prospectName: 'First Visitor' }), /all set/)
  assert.ok(!slots(await list({ unitId: '09F' })).includes(slotId), 'occupied apartment is not offered')
  assert.equal(slots(await list({ unitId: '08E' }))[0], slotId, 'second staff member can show another apartment')
  assert.match(await tool('book_tour', { slotId, unitId: '08E', prospectName: 'Second Visitor' }), /all set/)
  assert.ok(!slots(await list()).includes(slotId), 'full staff capacity is not offered')
  assert.equal((await store.read()).bookings.length, 2)
})

test('a closed requested date is labeled as unavailable and alternatives retain the preferred clock time', async () => {
  await store.mutate(state => ({ ...state, blocks: [{ target: '2032-06-02', reason: 'Office closed', blockedAt: '2032-06-01T12:00:00Z' }] }))
  const result = await list()
  assert.match(result, /No times are open on 2032-06-02; these are alternatives on other dates/)
  assert.equal(slots(result)[0], 'slot-2032-06-03T20:00')
  assert.ok(slots(result).every(id => !id.startsWith('slot-2032-06-02')))
})

test('malformed preferred times and missing dates are rejected without scheduling', async () => {
  for (const preferredTime of ['', '4 PM', '4:00', '24:00', '16:60', 1600, null, ['16:00']]) {
    assert.match(await list({ preferredTime }), /time is invalid/)
  }
  assert.match(await tool('list_tour_slots', { preferredTime: '16:00' }), /Ask which date/)
  assert.deepEqual((await store.read()).bookings, [])
})

test('selection ranks only actual DST starts and refuses malformed pure-helper requests', () => {
  const tour = (value: string): TourSlot => { const startsAt = new Date(value); return {
    startsAt, endsAt: new Date(startsAt.getTime() + 1800000), slotId: `slot-${startsAt.toISOString().slice(0, 16)}`,
  } }
  const real = ['2032-03-14T06:30:00Z', '2032-03-14T07:00:00Z', '2032-03-14T07:30:00Z'].map(tour)
  const result = pickSlotsToOffer(real, '2032-03-14', 'America/New_York', '02:30')
  assert.equal(result.offered[0]!.slotId, 'slot-2032-03-14T07:00', 'nonexistent 2:30 AM chooses real 3 AM')
  assert.ok(result.offered.every(slot => real.includes(slot)))
  assert.throws(() => pickSlotsToOffer(real, '2032-03-14', 'America/New_York', '24:00'), /HH:mm/)
  assert.throws(() => pickSlotsToOffer(real, undefined, 'America/New_York', '16:00'), /preferredDate/)
})

test('availability widening accepts only explicit typed options', async () => {
  for (const options of [{ sortBy: 'random' }, { includeOutsideMoveIn: 'true' }, { includeOutsideMoveIn: null }, { ignoreBudget: 1 }, { ignoreBudget: 'false' }]) {
    assert.match(await tool('check_availability', { ...options, bedrooms: '3', budget: '8000', moveIn: 'within three months' }), /Invalid availability search options/)
  }
})

test('bundled demo quotes preserve their original catalogue date across later requests', async () => {
  const callId = `catalogue-source-${++sequence}`
  const first = await tool('check_availability', { bedrooms: '3', budget: 'up to 12000', moveIn: '2032-07-01' }, callId)
  assert.match(first, /Inventory source: fictional demo catalogue/)
  assert.match(first, /as of September 1, 2026; version larkin-demo-v1/)
  assert.match(first, /never live\/PMS data/)
  assert.match(first, /\$[\d,]+/)
  mock.timers.tick(16 * 60_000)
  const later = await tool('check_availability', {}, callId)
  assert.match(later, /as of September 1, 2026; version larkin-demo-v1/)
  assert.doesNotMatch(later, /as of June 1, 2032/)
})
