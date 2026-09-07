import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sendConfirmation } from '../confirmation.ts'
import { NoopTransport, placeholdersIn } from '../render.ts'
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

describe('the concession is never hardcoded into the confirmation', () => {
  /** The file that actually gets sent, not a stand-in. */
  const TEMPLATE = readFileSync(new URL('../../../emails/tour-confirmation.html', import.meta.url), 'utf8')
  const realCtx = { ...ctx, template: TEMPLATE }

  /**
   * Every placeholder the shipped template asks for. The concession three are the point:
   * delete one from the template and hardcode the sentence back, and this fails.
   */
  const PLACEHOLDERS = [
    'address', 'bedrooms', 'buildingName',
    'concessionDisclaimer', 'concessionLine', 'concessionSentence',
    'confirmationCode', 'floorPlanName', 'leasingEmail', 'leasingPhone',
    'managementCompany', 'monthlyRent', 'prospectName', 'rescheduleUrl',
    'sqft', 'tourDate', 'tourTime', 'unitId',
  ]

  const send = async (extras: Parameters<typeof sendConfirmation>[3]) => {
    const t = new NoopTransport()
    const outcome = await sendConfirmation(booking('confirmed'), realCtx, t, extras)
    return { outcome, html: t.outbox[0]!.html }
  }

  test('the template asks for exactly what sendConfirmation supplies', async () => {
    assert.deepEqual(placeholdersIn(TEMPLATE).sort(), PLACEHOLDERS)
    const { outcome } = await send({ floorPlanName: 'Three Bedroom', bedrooms: 3, sqft: 1512, monthlyRent: 12980, concession: null })
    assert.deepEqual(outcome.missing, [], 'a placeholder the sender does not fill blanks a sentence in a sent email')
  })

  test('the template states no lease terms of its own', () => {
    assert.ok(
      !/net effective|month free|weeks free|14-month|18-month/i.test(TEMPLATE),
      'concession language belongs to the residence, not to the template',
    )
  })

  test('a residence with no concession is never promised a free month', async () => {
    const { html } = await send({ floorPlanName: 'Three Bedroom', bedrooms: 3, sqft: 1512, monthlyRent: 12980, concession: null })
    assert.ok(!/month free/i.test(html), '33A has no concession and must not be told it has one')
    assert.ok(!/14-month/.test(html))
    assert.match(html, /No concession on this residence/)
    assert.match(html, /gross rent/)
    assert.match(html, /\$12,980/)
  })

  test('a residence on other terms gets its own terms, not the house default', async () => {
    const { html } = await send({ monthlyRent: 7410, concession: 'Six weeks free on an 18-month lease' })
    assert.match(html, /Net effective\. Six weeks free on an 18-month lease\. \$8,084 on the lease\./)
    assert.match(html, /reflects six weeks free on an 18-month lease/)
    assert.ok(!/14-month/.test(html), '15D is on eighteen months, not fourteen')
  })

  test('the house terms still read the way they always did', async () => {
    const { html } = await send({ monthlyRent: 7190, concession: 'One month free on a 14-month lease' })
    assert.match(html, /Net effective\. One month free on a 14-month lease\./)
    assert.match(html, /Gross rent is higher/)
  })

  test('an unknown concession promises nothing', async () => {
    const { html } = await send({ monthlyRent: 7190 })
    assert.ok(!/month free/i.test(html), 'a concession nobody supplied is not a concession we put in writing')
    assert.ok(!/14-month/.test(html))
    assert.match(html, /which concession applies to this residence/)
  })
})
