import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import property from '../../data/property.json' with { type: 'json' }
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { sayableStatus } from '../../src/booking/book.ts'
import type { Booking, TourSlot } from '../../src/booking/types.ts'
import { propertyId, interactionId } from '../../src/domain/ids.ts'

const originalEnv = { ...process.env }
const config = property as Record<string, unknown>
const originalTimeZone = config.timeZone
const originallyHadZone = Object.hasOwn(config, 'timeZone')
const store = calendarStoreFromEnv()
let handler: (req: any, res: any) => Promise<void>
let pickSlots: typeof import('../vapi.ts').pickSlotsToOffer
let events: Array<Record<string, unknown>>
let nextCall = 0

before(async () => {
  for (const key of ['OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  // Invalid calendar configuration must not prevent the handler, especially its
  // emergency path, from loading at all.
  config.timeZone = 'invalid'
  const module = await import('../vapi.ts')
  handler = module.default; pickSlots = module.pickSlotsToOffer; events = module.eventLog
})
beforeEach(async () => {
  config.timeZone = 'America/Chicago'
  mock.timers.enable({ apis: ['Date'], now: new Date('2032-01-01T12:00:00Z') })
  await store.mutate(() => ({ bookings: [], blocks: [] }))
})
afterEach(() => mock.timers.reset())
after(() => {
  if (originallyHadZone) config.timeZone = originalTimeZone
  else delete config.timeZone
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

const tool = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args })
async function invoke(list: unknown[], callId = `timezone-voice-${++nextCall}`) {
  const res: any = { code: 0, body: null, setHeader() {},
    status(value: number) { this.code = value; return this },
    json(value: unknown) { this.body = value; return this },
  }
  await handler({ method: 'POST', headers: { 'x-time-zone': 'America/Los_Angeles' },
    body: { timeZone: 'America/Los_Angeles', message: { type: 'tool-calls', call: { id: callId }, toolCallList: list } },
  }, res)
  assert.equal(res.code, 200)
  return res.body.results as Array<{ toolCallId: string; result: string }>
}
const list = (preferredDate: string) => tool('list_tour_slots', { preferredDate, timeZone: 'America/Los_Angeles' })
const book = (slotId: string) => tool('book_tour', { slotId, prospectName: 'Timezone Visitor', unitId: '08E', timeZone: 'America/Los_Angeles' })
const tour = (iso: string): TourSlot => {
  const startsAt = new Date(iso)
  return { slotId: `slot-${startsAt.toISOString().slice(0, 16)}`, startsAt, endsAt: new Date(startsAt.getTime() + 1800000) }
}

test('Vapi offers Chicago office hours and confirms the same local time, ignoring caller timezone overrides', async () => {
  const offered = (await invoke([list('2032-06-01')]))[0]!.result
  assert.match(offered, /slot-2032-06-01T15:00 — Tuesday, June 1, 2032 at 10:00 AM/)
  assert.doesNotMatch(offered, /slot-2032-06-01T14:00/)
  const outsideHours = (await invoke([book('slot-2032-06-01T14:00')]))[0]!.result
  assert.match(outsideHours, /not on the calendar/)
  assert.equal((await store.read()).bookings.length, 0)
  const confirmed = (await invoke([book('slot-2032-06-01T15:00')]))[0]!.result
  assert.match(confirmed, /June 1, 2032 at 10:00 AM/)
  assert.match(confirmed, /tour is confirmed/)
  const saved = (await store.read()).bookings[0]!
  assert.equal(saved.startsAt, '2032-06-01T15:00:00.000Z')
  assert.equal(saved.endsAt, '2032-06-01T15:30:00.000Z')
  assert.ok(events.some(event => event.kind === 'tour_booked' && String(event.slot).includes('10:00 AM')))
})

test('preferred-date past checks use the building day on both sides of New York midnight', async () => {
  mock.timers.setTime(new Date('2032-06-01T04:30:00Z').getTime())
  const chicago = (await invoke([list('2032-05-31')]))[0]!.result
  assert.doesNotMatch(chicago, /date is in the past|date is invalid/)
  config.timeZone = 'America/New_York'
  const ny = (await invoke([list('2032-05-31')]))[0]!.result
  assert.match(ny, /date is in the past/)
})

test('minimum notice is elapsed time and is spoken in the building timezone', async () => {
  mock.timers.setTime(new Date('2032-06-01T14:30:00Z').getTime())
  const offered = (await invoke([list('2032-06-01')]))[0]!.result
  assert.match(offered, /slot-2032-06-01T16:30 — Tuesday, June 1, 2032 at 11:30 AM/)
  assert.doesNotMatch(offered, /slot-2032-06-01T16:00/)
})

test('Vapi Chicago DST dates skip nonexistent hours and choose one repeated label', async () => {
  await store.mutate(state => ({ ...state, settings: { ...defaultSettings(),
    minimumNoticeMinutes: 0, hours: { 0: { openHour: 0, closeHour: 4 } } } }))
  const spring = (await invoke([list('2032-03-14')]))[0]!.result
  assert.match(spring, /slot-2032-03-14T06:00 — Sunday, March 14, 2032 at 12:00 AM/)
  assert.match(spring, /slot-2032-03-14T08:00 — Sunday, March 14, 2032 at 3:00 AM/)
  assert.doesNotMatch(spring, / at 2:00 AM| at 2:30 AM/)
  const fall = (await invoke([list('2032-11-07')]))[0]!.result
  assert.match(fall, /slot-2032-11-07T06:30 — Sunday, November 7, 2032 at 1:30 AM/)
  assert.doesNotMatch(fall, /slot-2032-11-07T07:30/)
})

test('slot selection groups dates and morning/afternoon by the requested building timezone', () => {
  const times = ['2032-06-01T16:00:00Z', '2032-06-01T17:00:00Z', '2032-06-01T18:00:00Z'].map(tour)
  assert.deepEqual(pickSlots(times, undefined, 'America/Chicago').offered, [times[0], times[2]])
  assert.deepEqual(pickSlots(times).offered, [times[0], times[1]], 'legacy helper defaults to New York')
  const late = [tour('2032-06-01T04:30:00Z'), tour('2032-06-01T05:30:00Z')]
  assert.equal(pickSlots(late, '2032-05-31', 'America/Chicago').daysOpen, 2)
  assert.deepEqual(pickSlots(late, '2032-05-31', 'America/Chicago').offered, [late[0]])
  assert.equal(pickSlots(late).daysOpen, 1)
  assert.throws(() => pickSlots([], undefined, 'America/Miami'), /valid IANA timezone/)
})

test('invalid explicit property timezone blocks scheduling visibly, but emergency guidance remains available', async () => {
  for (const timeZone of [null, '', 'America/Miami', 'EST', 123]) {
    config.timeZone = timeZone
    const callId = `invalid-zone-${++nextCall}`
    const response = await invoke([list('2032-06-01'), book('slot-2032-06-01T15:00')], callId)
    for (const result of response) {
      assert.match(result.result, /tour calendar needs staff attention/)
      assert.doesNotMatch(result.result, /date is invalid|tour is confirmed/)
    }
    assert.ok(events.some(event => event.callId === callId && event.errorCode === 'property_timezone_invalid'))
  }
  assert.equal((await store.read()).bookings.length, 0)
  const emergency = await invoke([book('slot-2032-06-01T15:00'),
    tool('answer_question', { question: 'I smell gas in my apartment', topic: 'general_property_fact' })])
  for (const result of emergency) {
    assert.match(result.result, /outside.*call 911/i)
    assert.match(result.result, /have not contacted emergency services or building staff/i)
    assert.doesNotMatch(result.result, /tour calendar needs staff attention/)
  }
  assert.equal((await store.read()).bookings.length, 0)
})

test('legacy property without timezone retains New York Vapi hours', async () => {
  delete config.timeZone
  const offered = (await invoke([list('2032-06-01')]))[0]!.result
  assert.match(offered, /slot-2032-06-01T14:00 — Tuesday, June 1, 2032 at 10:00 AM/)
})

test('booking status formats confirmed times and conflict alternatives in the same explicit timezone', () => {
  const slot = tour('2032-06-01T15:00:00Z')
  const booking: Booking = {
    intent: { intentId: 'timezone-status', idempotencyKey: 'timezone-status', createdAt: new Date(), request: {
      propertyId: propertyId('timezone-property'), interactionId: interactionId('timezone-call'), personId: null,
      prospectName: 'Visitor', prospectPhone: '+12125550123', prospectEmail: null, slot, unitId: null, floorPlanId: null,
    } },
    state: { status: 'confirmed', slot, externalId: 'timezone-confirmed', verifiedAt: new Date() }, updatedAt: new Date(),
  }
  assert.match(sayableStatus(booking, 'America/Chicago'), /at 10:00 AM/)
  assert.match(sayableStatus(booking), /at 11:00 AM/)
  booking.state = { status: 'slot_taken', alternatives: [slot] }
  assert.match(sayableStatus(booking, 'America/Los_Angeles'), /at 8:00 AM/)
  assert.throws(() => sayableStatus(booking, 'invalid'), /valid IANA timezone/)
})
