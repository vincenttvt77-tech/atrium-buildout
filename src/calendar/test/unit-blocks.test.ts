import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addUnitBlock, prepareUnitBlock, removeUnitBlock } from '../unit-blocks.ts'
import { canBook, generateSlots, statusOf } from '../slots.ts'
import { MemoryCalendarStore } from '../store.ts'
import { storeBackedCalendar } from '../port.ts'
import type { CalendarState } from '../types.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const now = new Date('2032-06-01T10:00:00Z')
const options = { timeZone: 'America/New_York', unitIds: ['12A', '12B'], minimumNoticeMinutes: 0, capacity: 3, startIntervalMinutes: 15 }
const slot = generateSlots(now, { ...options, from: new Date('2032-06-01T14:00Z'), to: new Date('2032-06-01T15:00Z') })[0]!
const input = (overrides = {}) => ({ requestId: 'block-request-one', unitId: '12A', date: '2032-06-01', allDay: false, startTime: '10:00', endTime: '11:00', reason: 'Painting', ...overrides })
const blocked = (overrides = {}): CalendarState => addUnitBlock({ blocks: [], bookings: [] }, prepareUnitBlock(input(overrides), options.unitIds, options.timeZone, now))

test('apartment blackout affects only its apartment and leaves the staff calendar open', () => {
  const state = blocked()
  assert.equal(canBook(slot, state, options, '12A'), false)
  assert.equal(canBook(slot, state, options, '12B'), true)
  assert.equal(canBook(slot, state, options), true)
  assert.equal(statusOf(slot, state, 3, options), 'open')
  assert.deepEqual(state.blocks, [])
})

test('a generic offer is refused when all inventory apartments are unavailable', () => {
  const state = addUnitBlock(blocked(), prepareUnitBlock(input({ requestId: 'block-request-two', unitId: '12B' }), options.unitIds, options.timeZone, now))
  assert.equal(canBook(slot, state, options), false)
  const { unitIds: _ids, ...withoutInventory } = options
  assert.equal(canBook(slot, state, withoutInventory), false, 'missing inventory cannot establish another apartment is open')
})

test('apartment blackout overlap honors tour duration, buffers and exclusive end boundaries', () => {
  const state = blocked({ endTime: '10:00', startTime: '09:00' })
  assert.equal(canBook(slot, state, options, '12A'), true)
  assert.equal(canBook(slot, state, { ...options, bufferMinutes: 10 }, '12A'), false)
  const overlapsEnd = blocked({ startTime: '10:20', endTime: '10:40' })
  assert.equal(canBook(slot, overlapsEnd, options, '12A'), false)
})

test('all-day and multiday blackouts store exact local midnight boundaries across DST', () => {
  for (const [date, hours] of [['2032-03-14', 23], ['2032-11-07', 25]] as const) {
    const block = prepareUnitBlock(input({ date, allDay: true }), options.unitIds, options.timeZone, now)
    assert.equal((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 3600000, hours)
  }
  const block = prepareUnitBlock(input({ date: '2032-06-01', endDate: '2032-06-03', allDay: true }), options.unitIds, options.timeZone, now)
  assert.equal(block.startsAt, '2032-06-01T04:00:00.000Z')
  assert.equal(block.endsAt, '2032-06-04T04:00:00.000Z')
})

test('missing/repeated wall times, invalid ranges and foreign apartments are refused', () => {
  for (const values of [
    { date: '2032-03-14', startTime: '02:30', endTime: '03:30' },
    { date: '2032-11-07', startTime: '01:30', endTime: '02:30' },
    { date: '2032-02-30' }, { endDate: '2034-01-01' }, { unitId: 'OTHER-PROPERTY' },
    { startTime: '11:00', endTime: '10:00' }, { allDay: 'true' },
  ]) assert.throws(() => prepareUnitBlock(input(values), options.unitIds, options.timeZone, now))
})

test('blackout retries retain identity and a late creation retry cannot undo removal', () => {
  const block = prepareUnitBlock(input(), options.unitIds, options.timeZone, now)
  const state = addUnitBlock({ blocks: [], bookings: [] }, block)
  assert.deepEqual(addUnitBlock(state, { ...block, blockedAt: new Date().toISOString() }), state)
  assert.throws(() => addUnitBlock(state, { ...block, unitId: '12B' }), /already used/)
  const removed = removeUnitBlock(state, block.id, 0, now)
  assert.deepEqual(addUnitBlock(removed, block), removed)
  assert.deepEqual(removeUnitBlock(removed, block.id, 0, now), removed)
  assert.throws(() => removeUnitBlock(state, block.id, 5, now), /changed/)
})

test('adding a blackout preserves an existing reservation while new bookings respect the same store', async () => {
  const store = new MemoryCalendarStore()
  const calendar = storeBackedCalendar(store, () => now, options)
  const intent = { intentId: 'test-intent', idempotencyKey: 'original-tour', createdAt: now, request: {
    propertyId: propertyId('calendar-property'), interactionId: interactionId('calendar-call'), personId: null,
    prospectName: 'Synthetic tour', prospectEmail: null, prospectPhone: '+12025550101', slot, unitId: '12A', floorPlanId: null,
  } }
  await calendar.createBooking(intent)
  const original = (await store.read()).bookings[0]
  await store.mutate(state => addUnitBlock(state, prepareUnitBlock(input(), options.unitIds, options.timeZone, now)))
  assert.deepEqual((await store.read()).bookings, [original])
  assert.equal((await calendar.listSlots(propertyId('calendar-property'), slot.startsAt, slot.endsAt, '12A')).length, 0)
  assert.ok((await calendar.listSlots(propertyId('calendar-property'), slot.startsAt, slot.endsAt, '12B')).length > 0)
  await assert.rejects(calendar.createBooking({ ...intent, idempotencyKey: 'new-tour',
    request: { ...intent.request, prospectPhone: '+12025550102' } }), /blocked/)
})
