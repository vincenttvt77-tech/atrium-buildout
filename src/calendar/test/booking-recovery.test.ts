import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookTour, idempotencyKey } from '../../booking/book.ts'
import type { BookingRequest } from '../../booking/types.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'
import { storeBackedCalendar } from '../port.ts'
import { KvCalendarStore } from '../store.ts'
import { generateSlots } from '../slots.ts'
import type { CalendarState } from '../types.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const options = { minimumNoticeMinutes: 0, capacity: 2, unitIds: ['12A', '12B'] }
const slot = generateSlots(NOW, { ...options,
  from: new Date('2026-09-08T14:00:00Z'), to: new Date('2026-09-08T15:00:00Z'),
})[0]!
const request: BookingRequest = {
  propertyId: propertyId('property-recovery-test'), interactionId: interactionId('call-recovery-test'),
  personId: null, prospectName: 'Calendar recovery test', prospectPhone: '+15555550101',
  prospectEmail: null, slot, unitId: '12A', floorPlanId: null,
}
const bookOptions = { now: NOW, makeIntentId: () => 'intent-recovery-test' }

/** Exercise the actual KV create/CAS path without network access or live records. */
function harness(fault: {
  failedReadsFrom?: number
  loseWriteResponse?: boolean
  delayWrite?: boolean
  rewrite?: (state: CalendarState) => CalendarState
} = {}) {
  let raw: string | null = null
  let pending: string | null = null
  const calls = { reads: 0, writes: 0 }
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const parts = JSON.parse(String(init?.body)) as string[]
    if (parts[0] === 'GET') {
      calls.reads++
      if (fault.failedReadsFrom !== undefined && calls.reads >= fault.failedReadsFrom) throw new Error('KV unavailable')
      return Response.json({ result: raw })
    }
    assert.equal(parts[0], 'EVAL')
    calls.writes++
    if ((parts[4] === 'missing' && raw !== null) || (parts[4] === 'present' && raw !== parts[5])) {
      return Response.json({ result: 0 })
    }
    const next = fault.rewrite ? JSON.stringify(fault.rewrite(JSON.parse(parts[6]!) as CalendarState)) : parts[6]!
    if (fault.delayWrite) pending = next
    else raw = next
    if (fault.loseWriteResponse) throw new Error('KV write response lost')
    return Response.json({ result: 1 })
  }) as typeof fetch
  const store = new KvCalendarStore('https://kv.invalid', 'synthetic-test-token', { fetchImpl })
  return {
    calendar: storeBackedCalendar(store, () => NOW, options), calls,
    state: (): CalendarState => raw === null ? { blocks: [], bookings: [] } : JSON.parse(raw) as CalendarState,
    completeDelayedWrite: () => { raw = pending; pending = null },
  }
}

test('a committed KV booking with a lost response recovers by exact read-back without another write', async () => {
  const fixture = harness({ loseWriteResponse: true })
  const result = await bookTour(request, fixture.calendar, bookOptions)
  assert.equal(result.state.status, 'confirmed')
  assert.equal(result.state.status === 'confirmed' && result.state.externalId, idempotencyKey(request))
  assert.equal(fixture.calls.writes, 1)
  assert.equal(fixture.calls.reads, 2, 'one initial CAS read and one authoritative recovery read')
  assert.equal(fixture.state().bookings.length, 1)

  const retry = await bookTour(request, fixture.calendar, bookOptions)
  assert.equal(retry.state.status, 'confirmed')
  assert.equal(fixture.state().bookings.length, 1, 'same-key invocation preserves the original reservation')
})

test('a failed initial KV read is a definite no-write failure and may be retried', async () => {
  const fixture = harness({ failedReadsFrom: 1 })
  const result = await bookTour(request, fixture.calendar, bookOptions)
  assert.equal(result.state.status, 'failed')
  assert.equal(result.state.status === 'failed' && result.state.attempts, 3)
  assert.equal(fixture.calls.writes, 0)
  assert.equal(fixture.calls.reads, 3)
  assert.equal(fixture.state().bookings.length, 0)
})

test('a lost KV write response and persistent verification outage stay uncertain', async () => {
  const fixture = harness({ loseWriteResponse: true, failedReadsFrom: 2 })
  const result = await bookTour(request, fixture.calendar, bookOptions)
  assert.equal(result.state.status, 'arranging')
  assert.equal(result.state.status === 'arranging' && result.state.externalId, idempotencyKey(request))
  assert.equal(fixture.calls.writes, 1)
  assert.equal(fixture.calls.reads, 3)
  assert.equal(fixture.state().bookings.length, 1, 'the booking exists even though its response could not be verified')
})

test('absent reads after an uncertain KV write never claim no booking or start another write', async () => {
  const fixture = harness({ loseWriteResponse: true, delayWrite: true })
  const result = await bookTour(request, fixture.calendar, bookOptions)
  assert.equal(result.state.status, 'arranging')
  assert.equal(fixture.calls.writes, 1)
  assert.equal(fixture.calls.reads, 3)
  assert.equal(fixture.state().bookings.length, 0)
  fixture.completeDelayedWrite()
  assert.equal(fixture.state().bookings.length, 1, 'the earlier request may arrive after a read reported absence')
})

test('recovery finding a different apartment preserves uncertainty and does not offer another tour', async () => {
  const fixture = harness({ loseWriteResponse: true, rewrite: state => ({ ...state,
    bookings: state.bookings.map(booking => ({ ...booking, unitId: '12B' })),
  }) })
  const result = await bookTour(request, fixture.calendar, bookOptions)
  assert.equal(result.state.status, 'arranging')
  assert.match(result.state.status === 'arranging' ? result.state.lastError ?? '' : '', /did not match/)
  assert.equal(fixture.calls.writes, 1)
  assert.equal(fixture.calls.reads, 2)
  assert.equal(fixture.state().bookings.length, 1)
})

test('changing an existing reservation requests a tour change without offering a second booking', async () => {
  const fixture = harness()
  assert.equal((await bookTour(request, fixture.calendar, bookOptions)).state.status, 'confirmed')
  await assert.rejects(bookTour({ ...request, unitId: '12B' }, fixture.calendar, bookOptions),
    { message: 'TOUR_CHANGE_REQUIRED', reason: 'existing_future_tour' })
  assert.equal(fixture.state().bookings.length, 1)
  assert.equal(fixture.state().bookings[0]!.unitId, '12A')
})
