import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bookTour, idempotencyKey, sayableStatus } from '../book.ts'
import type { CalendarPort, BookingRequest, TourSlot, BookingIntent } from '../types.ts'
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
    readBooking: behaviour.readBooking ?? (async (id) => ({ externalId: id, slot: SLOT })),
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
    assert.equal(b.state.status, 'slot_taken')
  })

  test('the prospect is told "arranging", never "confirmed", when unverified', async () => {
    const b = await bookTour(req(), fakeCalendar({ readBooking: async () => null }), opts)
    const said = sayableStatus(b)
    assert.match(said, /getting that booked/i)
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
  test('total calendar failure queues for a human and says so honestly', async () => {
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { throw new Error('ECONNREFUSED') },
    }), opts)
    assert.equal(b.state.status, 'failed')
    assert.equal(b.state.status === 'failed' && b.state.queuedForHuman, true)
    const said = sayableStatus(b)
    assert.match(said, /someone will call you back/i)
    assert.match(said, /don't want to tell you it's booked/i)
  })

  test('a taken slot offers real alternatives rather than insisting', async () => {
    const alt: TourSlot = { slotId: 'slot-sat-1500', startsAt: new Date('2026-09-12T19:00:00Z'), endsAt: new Date('2026-09-12T19:30:00Z') }
    const b = await bookTour(req(), fakeCalendar({
      createBooking: async () => { throw new Error('slot already booked') },
      listSlots: async () => [alt],
    }), opts)
    assert.equal(b.state.status, 'slot_taken')
    assert.match(sayableStatus(b), /just went/i)
    assert.match(sayableStatus(b), /3:00/)
  })

  test('a transient error retries and can still confirm', async () => {
    let calls = 0
    const b = await bookTour(req(), fakeCalendar({
      readBooking: async (id) => {
        calls++
        return calls < 2 ? null : { externalId: id, slot: SLOT }
      },
    }), opts)
    assert.equal(b.state.status, 'confirmed')
    assert.equal(calls, 2, 'retried the read-back rather than re-creating the booking')
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
      readBooking: async (id) => { reads++; return reads < 3 ? null : { externalId: id, slot: SLOT } },
    }), opts)
    assert.equal(creates, 1, 'must not create a second calendar entry while retrying read-back')
  })
})
