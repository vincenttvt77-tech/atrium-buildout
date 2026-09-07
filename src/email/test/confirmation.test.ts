import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sendConfirmation } from '../confirmation.ts'
import { NoopTransport } from '../render.ts'
import type { Booking, TourSlot } from '../../booking/types.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const SLOT: TourSlot = {
  slotId: 's1',
  startsAt: new Date('2026-09-12T18:00:00Z'),
  endsAt: new Date('2026-09-12T18:30:00Z'),
}

const ctx = {
  buildingName: 'The Larkin', address: '5-08 46th Avenue',
  leasingPhone: '+1 (516) 990-9252', leasingEmail: 'leasing@thelarkinlic.com',
  managementCompany: 'Halbrook Residential',
  template: '<p>Hi {{prospectName}}, {{tourDate}} at {{tourTime}}. Code {{confirmationCode}}. {{unitId}}</p>',
}

const booking = (status: Booking['state']['status'], email: string | null = 'dana@example.com'): Booking => ({
  intent: {
    intentId: 'i1', idempotencyKey: 'k1', createdAt: new Date(),
    request: {
      propertyId: propertyId('prop-demo'), interactionId: interactionId('int-1'), personId: null,
      prospectName: 'Dana', prospectPhone: '+15165551234', prospectEmail: email,
      slot: SLOT, unitId: '12A', floorPlanId: 'C1',
    },
  },
  state: status === 'confirmed'
    ? { status: 'confirmed', externalId: 'ext-9', verifiedAt: new Date(), slot: SLOT }
    : { status: 'arranging', externalId: 'ext-9', attempts: 3, lastError: 'timeout' },
  updatedAt: new Date(),
})

describe('confirmation email follows the read-back discipline', () => {
  test('an unverified booking is never confirmed in writing', async () => {
    const t = new NoopTransport()
    const r = await sendConfirmation(booking('arranging'), ctx, t)
    assert.equal(r.attempted, false)
    assert.equal(t.outbox.length, 0, 'nothing may be sent for an unverified booking')
    assert.match(r.reason, /not confirmed/)
  })

  test('a confirmed booking renders and sends', async () => {
    const t = new NoopTransport()
    const r = await sendConfirmation(booking('confirmed'), ctx, t)
    assert.equal(r.attempted, true)
    assert.equal(t.outbox.length, 1)
    assert.match(t.outbox[0]!.html, /Hi Dana/)
    assert.match(t.outbox[0]!.html, /Saturday, September 12/)
    assert.match(t.outbox[0]!.html, /2:00/)
    assert.match(t.outbox[0]!.subject, /The Larkin/)
  })

  test('no captured email means no send, reported honestly', async () => {
    const t = new NoopTransport()
    const r = await sendConfirmation(booking('confirmed', null), ctx, t)
    assert.equal(r.attempted, false)
    assert.match(r.reason, /no email address/)
  })

  test('with no provider it reports queued rather than sent', async () => {
    const r = await sendConfirmation(booking('confirmed'), ctx, new NoopTransport())
    assert.equal(r.sent, false)
    assert.match(r.reason, /no email provider/)
  })
})
