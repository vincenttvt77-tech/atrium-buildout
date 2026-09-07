import { render, type EmailTransport, type EmailMessage } from './render.ts'
import { concessionTerms, leaseRent } from '../inventory/pricing.ts'
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

export interface ConcessionCopy {
  /** Sub-line under the rent in the detail card. */
  line: string
  /** Body sentence in "What to expect". */
  sentence: string
  /** Footer disclosure, ahead of the standing listing disclaimer. */
  disclaimer: string
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/**
 * Concession language for one residence. The template carries none of its own.
 *
 * A hardcoded "one month free on a 14-month lease" is wrong for six of the thirty
 * residences: four are on six weeks free over eighteen months, and 29E and 33A carry
 * nothing at all. Putting a free month in writing to someone touring a $12,980 home that
 * has none is the same failure as confirming a slot that was never held.
 *
 * Three states, because "nobody told us" is not the same claim as "there is none":
 * a string is quoted verbatim, null says plainly that there is no concession, and
 * undefined promises nothing and points at the leasing office.
 */
export function concessionCopy(concession: string | null | undefined, monthlyRent?: number): ConcessionCopy {
  if (concession === undefined) {
    return {
      line: 'Ask the leasing office which concession applies to this residence.',
      sentence: 'We have not confirmed which concession applies to this residence. Ask on the tour and we will give you the net effective rent and the gross rent, both figures, on the spot.',
      disclaimer: 'Concessions vary by residence. Where one applies the advertised rent is net effective and the gross rent is higher. Ask the leasing office for both figures for this residence.',
    }
  }

  const terms = (concession ?? '').trim().replace(/\.\s*$/, '')
  if (!terms) {
    return {
      line: 'No concession on this residence. This is the gross rent.',
      sentence: 'This residence carries no concession, so the rent we quote you is the gross rent. Where a residence does carry one, we quote net effective and give you the gross figure alongside it.',
      disclaimer: 'The advertised rent for this residence is the gross rent; this residence carries no concession. Concessions vary by residence, and where one applies the advertised rent is net effective. Ask the leasing office for both figures.',
    }
  }

  // The figure on the lease itself, when the terms parse and the rent is known — the same
  // arithmetic the website and the phone use, so all three say one number.
  const lease = monthlyRent && concessionTerms(terms) ? leaseRent({ monthlyRent, concession: terms }) : null
  return {
    line: `Net effective. ${terms}.${lease ? ` $${lease.toLocaleString('en-US')} on the lease.` : ''}`,
    sentence: `The rent we quote you for this residence is net effective and reflects ${lowerFirst(terms)}. Ask for the gross figure and we will give you both, on the spot.`,
    disclaimer: `The advertised rent for this residence is net effective and reflects ${lowerFirst(terms)}. Gross rent is higher; ask the leasing office for both figures. Concessions vary by residence.`,
  }
}

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
  extras: {
    floorPlanName?: string; sqft?: number; bedrooms?: number; monthlyRent?: number
    /** The residence's own terms. `null` means it has none; omit it only when unknown. */
    concession?: string | null
  } = {},
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
  const concession = concessionCopy(extras.concession, extras.monthlyRent)
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
    concessionLine: concession.line,
    concessionSentence: concession.sentence,
    concessionDisclaimer: concession.disclaimer,
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
