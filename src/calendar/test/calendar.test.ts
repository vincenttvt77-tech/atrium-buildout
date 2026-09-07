import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateSlots, openSlots, statusOf, slotDate, slotIdFor } from '../slots.ts'
import { MemoryCalendarStore, KvCalendarStore, calendarStoreFromEnv } from '../store.ts'
import { storeBackedCalendar } from '../port.ts'
import { emptyCalendar } from '../types.ts'
import { bookTour } from '../../booking/book.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T14:00:00Z')

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
    const slot = (await cal.listSlots(propertyId('p'), NOW, NOW))[0]!
    const b = await bookTour(req(slot), cal, { now: NOW, makeIntentId: () => 'i' })
    assert.equal(b.state.status, 'confirmed')
    assert.ok(!(await cal.listSlots(propertyId('p'), NOW, NOW)).some((s) => s.slotId === slot.slotId))
  })

  test('booking a blocked slot fails rather than writing anyway', async () => {
    const store = new MemoryCalendarStore()
    const cal = storeBackedCalendar(store, () => NOW)
    const slot = (await cal.listSlots(propertyId('p'), NOW, NOW))[0]!
    await store.mutate((s) => ({ ...s, blocks: [{ target: slot.slotId, reason: 'held', blockedAt: '' }] }))
    const b = await bookTour(req(slot), cal, { now: NOW, makeIntentId: () => 'i' })
    assert.notEqual(b.state.status, 'confirmed')
  })

  test('a retry does not create a second tour', async () => {
    const store = new MemoryCalendarStore()
    const cal = storeBackedCalendar(store, () => NOW)
    const slot = (await cal.listSlots(propertyId('p'), NOW, NOW))[0]!
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

  test('an unreachable KV yields an empty calendar rather than taking the line down', async () => {
    const store = new KvCalendarStore('https://x', 't', {
      fetchImpl: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
    })
    const state = await store.read()
    assert.deepEqual(state, emptyCalendar())
  })
})
