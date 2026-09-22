import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bookTour, idempotencyKey, sayableStatus } from '../book.ts'
import type { CalendarPort, BookingRequest, TourSlot, BookingIntent } from '../types.ts'
import { BookingConflictError, BookingWriteFailure } from '../types.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const SLOT: TourSlot = {
  slotId: 'slot-sat-1400',
  startsAt: new Date('2026-09-12T18:00:00Z'),
  endsAt: new Date('2026-09-12T18:30:00Z'),
}

const req = (over: Partial<BookingRequest> = {}): BookingRequest => ({
  propertyId: propertyId('prop-demo'),
  interactionId: interactionId('int-1'),
  personId: null,
  prospectName: 'Dana',
  prospectPhone: '+15165551234',
  prospectEmail: 'dana@example.com',
  slot: SLOT,
  unitId: '12A',
  floorPlanId: 'A1',
  ...over,
})

const opts = { now: NOW, makeIntentId: () => 'intent-1' }

/** A calendar that behaves however a test needs it to. */
function fakeCalendar(behaviour: Partial<CalendarPort> & { creates?: BookingIntent[] } = {}): CalendarPort {
  return {
    listSlots: behaviour.listSlots ?? (async () => []),
    createBooking: behaviour.createBooking ?? (async () => ({ externalId: 'ext-1' })),
    readBooking: behaviour.readBooking ?? (async (id) => ({ externalId: id, slot: SLOT, unitId: '12A' })),
  }
}

describe('a booking is only confirmed after it is read back', () => {
  test('write then successful read-back confirms', async () => {
    const b = await bookTour(req(), fakeCalendar(), opts)
    assert.equal(b.state.status, 'confirmed')
    assert.equal(b.state.status === 'confirmed' && b.state.externalId, 'ext-1')
  })

  test('a write that reads back as nothing is NOT confirmed', async () => {
    const b = await bookTour(req(), fakeCalendar({ readBooking: async () => null }), opts)
    assert.notEqual(b.state.status, 'confirmed')
    assert.equal(b.state.status, 'arranging', 'we wrote something, so it may yet land')
  })

  test('a read-back with a different slot is never reported as confirmed', async () => {
    const wrongSlot: TourSlot = { ...SLOT, slotId: 'slot-sun-1000', startsAt: new Date('2026-09-13T14:00:00Z') }
    const b = await bookTour(req(), fakeCalendar({
      readBooking: async (id) => ({ externalId: id, slot: wrongSlot }),
      listSlots: async () => [wrongSlot],
    }), opts)
    assert.equal(b.state.status, 'arranging')
  })

  test('a read-back with a different unit or external id never confirms', async () => {
    for (const readBack of [
      { externalId: 'ext-1', slot: SLOT, unitId: '12B' },
      { externalId: 'some-other-booking', slot: SLOT, unitId: '12A' },
      { externalId: 'ext-1', slot: SLOT },
    ]) {
      const b = await bookTour(req(), fakeCalendar({ readBooking: async () => readBack }), opts)
      assert.equal(b.state.status, 'arranging')
    }
  })

  test('the prospect is told "arranging", never "confirmed", when unverified', async () => {
    const b = await bookTour(req(), fakeCalendar({ readBooking: async () => null }), opts)
    const said = sayableStatus(b)
    assert.match(said, /isn't confirmed/i)
    assert.doesNotMatch(said, /within the hour|will confirm/i)
    assert.ok(!/all set|confirmed for/i.test(said), `must not claim confirmation: "${said}"`)
  })

  test('a confirmed booking says the actual booked time back', async () => {
    const b = await bookTour(req(), fakeCalendar(), opts)
    const said = sayableStatus(b)
    assert.match(said, /Saturday/)
    assert.match(said, /2:00/)
  })
})

describe('failure never becomes a false promise', () => {
  test('definitive no-write failures say help is needed without claiming a human was queued', async () => {
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { throw new BookingWriteFailure('ECONNREFUSED before write', 'not_created') },
    }), opts)
    assert.equal(b.state.status, 'failed')
    assert.equal(b.state.status === 'failed' && b.state.attempts, 3)
    assert.equal(Object.hasOwn(b.state, 'queuedForHuman'), false)
    const said = sayableStatus(b)
    assert.match(said, /couldn't confirm a tour/i)
    assert.match(said, /leasing team will need to help/i)
    assert.doesNotMatch(said, /will call you back|flagged|within the hour/i)
  })

  test('a taken slot offers real alternatives rather than insisting', async () => {
    const alt: TourSlot = { slotId: 'slot-sat-1500', startsAt: new Date('2026-09-12T19:00:00Z'), endsAt: new Date('2026-09-12T19:30:00Z') }
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { throw new BookingConflictError('slot already booked') },
      listSlots: async () => [alt],
    }), opts)
    assert.equal(b.state.status, 'slot_taken')
    assert.match(sayableStatus(b), /isn't available/i)
    assert.match(sayableStatus(b), /3:00/)
  })

  test('a transient error retries and can still confirm', async () => {
    let calls = 0
    const b = await bookTour(req(), fakeCalendar({
      readBooking: async (id) => {
        calls++
        return calls < 2 ? null : { externalId: id, slot: SLOT, unitId: '12A' }
      },
    }), opts)
    assert.equal(b.state.status, 'confirmed')
    assert.equal(calls, 2, 'retried the read-back rather than re-creating the booking')
  })

  test('alternatives request the selected unit and omit the just-conflicted start', async () => {
    const alt: TourSlot = { ...SLOT, slotId: 'slot-later', startsAt: new Date('2026-09-12T19:00:00Z'), endsAt: new Date('2026-09-12T19:30:00Z') }
    let selectedUnit: string | null | undefined
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { throw new BookingConflictError('booking conflict') },
      listSlots: async (_property, _from, _to, unitId) => {
        selectedUnit = unitId
        return [SLOT, { ...SLOT, slotId: 'duplicate-time' }, alt]
      },
    }), opts)
    assert.equal(selectedUnit, '12A')
    assert.deepEqual(b.state, { status: 'slot_taken', alternatives: [alt] })
  })

  test('ordinary provider errors never prove absence or authorize another create', async () => {
    for (const message of ['ECONNREFUSED', 'calendar unavailable', 'provider conflict', 'slot already booked']) {
      let creates = 0
      let reads = 0
      let alternatives = 0
      const b = await bookTour(req(), fakeCalendar({
        createBooking: async () => { creates++; throw new Error(message) },
        readBooking: async () => { reads++; return null },
        listSlots: async () => { alternatives++; return [SLOT] },
      }), opts)
      assert.equal(b.state.status, 'arranging', message)
      assert.equal(b.state.status === 'arranging' && b.state.externalId, null)
      assert.equal(creates, 1)
      assert.equal(reads, 0, 'an unknown provider identifier cannot be guessed')
      assert.equal(alternatives, 0, 'the original might exist; do not offer another booking')
    }
  })

  test('a proven pre-write error may retry and later confirm', async () => {
    let creates = 0
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => {
        if (++creates === 1) throw new BookingWriteFailure('initial read failed', 'not_created')
        return { externalId: 'ext-1' }
      },
    }), opts)
    assert.equal(b.state.status, 'confirmed')
    assert.equal(creates, 2)
  })

  test('an adapter identifier recovers a lost write response using only read-back', async () => {
    let creates = 0
    let reads = 0
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { creates++; throw new BookingWriteFailure('lost write response', 'unknown', 'ext-1') },
      readBooking: async id => { reads++; return { externalId: id, slot: SLOT, unitId: '12A' } },
    }), opts)
    assert.equal(b.state.status, 'confirmed')
    assert.equal(creates, 1)
    assert.equal(reads, 1)
  })

  test('a failed verification that says unavailable remains uncertain', async () => {
    let creates = 0
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { creates++; return { externalId: 'ext-1' } },
      readBooking: async () => { throw new Error('calendar unavailable') },
    }), opts)
    assert.equal(b.state.status, 'arranging')
    assert.equal(creates, 1)
  })
})

describe('retries cannot double-book', () => {
  test('the same prospect and slot produce the same idempotency key', () => {
    assert.equal(idempotencyKey(req()), idempotencyKey(req({ prospectName: 'Dana R.' })))
  })

  test('a different slot produces a different key', () => {
    const other = { ...SLOT, slotId: 'slot-sun-1000' }
    assert.notEqual(idempotencyKey(req()), idempotencyKey(req({ slot: other })))
  })

  test('a retry after a failed read-back reuses the external id rather than creating again', async () => {
    let creates = 0
    let reads = 0
    await bookTour(req(), fakeCalendar({
      createBooking: async () => { creates++; return { externalId: 'ext-1' } },
      readBooking: async (id) => { reads++; return reads < 3 ? null : { externalId: id, slot: SLOT, unitId: '12A' } },
    }), opts)
    assert.equal(creates, 1, 'must not create a second calendar entry while retrying read-back')
  })
})
