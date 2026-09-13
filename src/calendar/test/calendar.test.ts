import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateSlots, openSlots, statusOf, slotDate, slotIdFor } from '../slots.ts'
import { MemoryCalendarStore, KvCalendarStore, calendarStoreFromEnv } from '../store.ts'
import { storeBackedCalendar } from '../port.ts'
import { emptyCalendar } from '../types.ts'
import { bookTour } from '../../booking/book.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T14:00:00Z')
const TWO_WEEKS = new Date('2026-09-21T14:00:00Z')

describe('slots come from business hours, not from thin air', () => {
  test('generates slots across the window', () => {
    assert.ok(generateSlots(NOW).length > 100)
  })

  test('nothing inside the notice period is offered', () => {
    const soonest = generateSlots(NOW)[0]!
    assert.ok(soonest.startsAt.getTime() >= NOW.getTime() + 120 * 60_000,
      'a tour two minutes from now is not a tour anyone can staff')
  })

  test('closed days produce no slots', () => {
    const closedSundays = generateSlots(NOW, { hours: { 1: { openHour: 10, closeHour: 12 } } })
    assert.ok(closedSundays.every((s) => {
      const local = new Date(s.startsAt.getTime() - 4 * 3_600_000)
      return local.getUTCDay() === 1
    }), 'only the configured day should appear')
  })
})

describe('blocking is what proves the agent reads a real calendar', () => {
  test('a blocked slot stops being offered', () => {
    const all = generateSlots(NOW)
    const victim = all[3]!
    const state = { ...emptyCalendar(), blocks: [{ target: victim.slotId, reason: 'held', blockedAt: '' }] }
    assert.equal(statusOf(victim, state), 'blocked')
    assert.ok(!openSlots(NOW, state).some((s) => s.slotId === victim.slotId))
  })

  test('blocking a date removes that whole day and nothing else', () => {
    const all = generateSlots(NOW)
    const date = slotDate(all[0]!.startsAt)
    const state = { ...emptyCalendar(), blocks: [{ target: date, reason: 'staff training', blockedAt: '' }] }
    const open = openSlots(NOW, state)
    assert.ok(open.every((s) => slotDate(s.startsAt) !== date))
    assert.ok(open.length > 0, 'other days must survive')
  })

  test('a booked slot is not offered again', () => {
    const victim = generateSlots(NOW)[2]!
    const state = {
      blocks: [],
      bookings: [{ slotId: victim.slotId, externalId: 'x', prospectName: 'D',
                   prospectEmail: null, prospectPhone: '+1', unitId: null, bookedAt: '' }],
    }
    assert.equal(statusOf(victim, state), 'booked')
    assert.ok(!openSlots(NOW, state).some((s) => s.slotId === victim.slotId))
  })
})

describe('booking through the store', () => {
  const req = (slot: ReturnType<typeof generateSlots>[number]) => ({
    propertyId: propertyId('prop-demo'), interactionId: interactionId('i1'), personId: null,
    prospectName: 'Dana', prospectPhone: '+15165551234', prospectEmail: 'd@e.com',
    slot, unitId: '12A', floorPlanId: 'A1',
  })

  test('a booking is confirmed and the slot disappears', async () => {
    const store = new MemoryCalendarStore()
    const cal = storeBackedCalendar(store, () => NOW)
    const slot = (await cal.listSlots(propertyId('p'), NOW, TWO_WEEKS))[0]!
    const b = await bookTour(req(slot), cal, { now: NOW, makeIntentId: () => 'i' })
    assert.equal(b.state.status, 'confirmed')
    assert.ok(!(await cal.listSlots(propertyId('p'), NOW, TWO_WEEKS)).some((s) => s.slotId === slot.slotId))
  })

  test('booking a blocked slot fails rather than writing anyway', async () => {
    const store = new MemoryCalendarStore()
    const cal = storeBackedCalendar(store, () => NOW)
    const slot = (await cal.listSlots(propertyId('p'), NOW, TWO_WEEKS))[0]!
    await store.mutate((s) => ({ ...s, blocks: [{ target: slot.slotId, reason: 'held', blockedAt: '' }] }))
    const b = await bookTour(req(slot), cal, { now: NOW, makeIntentId: () => 'i' })
    assert.notEqual(b.state.status, 'confirmed')
  })

  test('a retry does not create a second tour', async () => {
    const store = new MemoryCalendarStore()
    const cal = storeBackedCalendar(store, () => NOW)
    const slot = (await cal.listSlots(propertyId('p'), NOW, TWO_WEEKS))[0]!
    await bookTour(req(slot), cal, { now: NOW, makeIntentId: () => 'i' })
    await bookTour(req(slot), cal, { now: NOW, makeIntentId: () => 'i' })
    assert.equal((await store.read()).bookings.length, 1)
  })
})

describe('the store degrades honestly', () => {
  test('memory says outright that it does not persist', () => {
    const d = new MemoryCalendarStore().describe()
    assert.equal(d.durable, false)
    assert.match(d.note, /not survive|invisible/i)
  })

  test('KV is selected only when both variables are present', () => {
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
    assert.equal(calendarStoreFromEnv(env({})).describe().kind, 'memory')
    assert.equal(calendarStoreFromEnv(env({ KV_REST_API_URL: 'x' })).describe().kind, 'memory')
    assert.equal(
      calendarStoreFromEnv(env({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' })).describe().kind,
      'kv')
  })

  test('an unreachable KV refuses availability instead of opening every blocked time', async () => {
    const store = new KvCalendarStore('https://x', 't', {
      fetchImpl: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
    })
    await assert.rejects(store.read(), /ECONNRESET/)
    assert.equal(store.describe().durable, false)
  })
})

describe('slot identity', () => {
  test('a half-hour slot has its own id, not the hour\'s', () => {
    const two = slotIdFor(new Date('2026-09-08T18:00:00Z'))
    const half = slotIdFor(new Date('2026-09-08T18:30:00Z'))
    assert.notEqual(two, half)
    const ids = generateSlots(NOW, { days: 1 }).map((s) => s.slotId)
    assert.equal(new Set(ids).size, ids.length, 'every generated slot id is distinct')
  })
})

describe('two tours can share a time, one apartment cannot', () => {
  const at = new Date('2026-09-09T18:00:00Z')
  const slot = { slotId: slotIdFor(at), startsAt: at, endsAt: new Date(at.getTime() + 30 * 60_000) }
  const booked = (n: number, unit = (i: number) => `1${i}A`) => ({
    blocks: [], bookings: Array.from({ length: n }, (_, i) => ({
      slotId: slot.slotId, externalId: `b${i}`, prospectName: `P${i}`, prospectEmail: null, prospectPhone: '+1', unitId: unit(i), bookedAt: at.toISOString(),
    })),
  })
  test('with capacity two, one booking leaves the time open and two fill it', () => {
    assert.equal(statusOf(slot, booked(1), 2), 'open')
    assert.equal(statusOf(slot, booked(2), 2), 'booked')
    assert.equal(statusOf(slot, booked(1), 1), 'booked', 'the default is still one tour per time')
  })
  test('the booking port refuses the same apartment twice at one time', async () => {
    const store = new MemoryCalendarStore()
    const cal = storeBackedCalendar(store, () => NOW, { capacity: 2 })
    const intent = (key: string, name: string, unitId: string | null) => ({
      idempotencyKey: key, request: { propertyId: propertyId('prop-demo'), interactionId: interactionId(`i-${key}`), personId: null,
        prospectName: name, prospectPhone: { Ana: '+15550000001', Ben: '+15550000002', Cy: '+15550000003' }[name], prospectEmail: null, slot, unitId, floorPlanId: null },
    })
    await cal.createBooking(intent('k1', 'Ana', '13L') as never)
    await assert.rejects(cal.createBooking(intent('k2', 'Ben', '13L') as never), /already being shown/)
    await cal.createBooking(intent('k3', 'Ben', '21B') as never)
    await assert.rejects(cal.createBooking(intent('k4', 'Cy', '26B') as never), /already booked/, 'the time is full at two')
  })
})
