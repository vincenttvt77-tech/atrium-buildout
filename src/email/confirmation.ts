import { render, type EmailTransport, type EmailMessage } from './render.ts'
import type { Booking } from '../booking/types.ts'

export interface ConfirmationContext {
  buildingName: string
  address: string
  leasingPhone: string
  leasingEmail: string
  managementCompany: string
  template: string
}

export interface ConfirmationOutcome {
  attempted: boolean
  sent: boolean
  reason: string
  /** Placeholders the template wanted that we could not fill. Surfaced, never hidden. */
  missing: string[]
  message: EmailMessage | null
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
})
const fmtTime = (d: Date) => d.toLocaleTimeString('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
})

/**
 * Sends the tour confirmation.
 *
 * Only ever called for a booking that read back as confirmed. Emailing a confirmation for
 * a booking that is merely "arranging" would put in writing the exact claim the read-back
 * discipline exists to prevent.
 */
export async function sendConfirmation(
  booking: Booking,
  ctx: ConfirmationContext,
  transport: EmailTransport,
  extras: { floorPlanName?: string; sqft?: number; bedrooms?: number; monthlyRent?: number } = {},
): Promise<ConfirmationOutcome> {
  if (booking.state.status !== 'confirmed') {
    return {
      attempted: false, sent: false,
      reason: `booking is "${booking.state.status}", not confirmed — nothing to confirm in writing`,
      missing: [], message: null,
    }
  }

  const req = booking.intent.request
  if (!req.prospectEmail) {
    return { attempted: false, sent: false, reason: 'no email address captured', missing: [], message: null }
  }

  const slot = booking.state.slot
  const { html, missing } = render(ctx.template, {
    prospectName: req.prospectName,
    buildingName: ctx.buildingName,
    address: ctx.address,
    leasingPhone: ctx.leasingPhone,
    leasingEmail: ctx.leasingEmail,
    managementCompany: ctx.managementCompany,
    tourDate: fmtDate(slot.startsAt),
    tourTime: fmtTime(slot.startsAt),
    unitId: req.unitId ?? '',
    floorPlanName: extras.floorPlanName ?? '',
    bedrooms: extras.bedrooms ?? '',
    sqft: extras.sqft ?? '',
    monthlyRent: extras.monthlyRent ? `$${extras.monthlyRent.toLocaleString('en-US')}` : '',
    confirmationCode: booking.state.externalId,
    rescheduleUrl: `tel:${ctx.leasingPhone.replace(/[^0-9+]/g, '')}`,
  })

  const message: EmailMessage = {
    to: req.prospectEmail,
    from: `${ctx.buildingName} <${ctx.leasingEmail}>`,
    replyTo: ctx.leasingEmail,
    subject: `Your tour at ${ctx.buildingName} — ${fmtDate(slot.startsAt)} at ${fmtTime(slot.startsAt)}`,
    html,
  }

  const result = await transport.send(message)
  return {
    attempted: true,
    sent: result.sent,
    reason: result.sent ? `sent (${result.id})` : result.reason,
    missing,
    message,
  }
}
