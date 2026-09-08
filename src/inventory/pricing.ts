import type { Unit } from './types.ts'

/**
 * What a rent means here, so the phone and the website say the same number.
 *
 * `monthlyRent` is the net effective rent — the figure the website prints first and the
 * one a caller with the site open is comparing against. The lease itself carries a higher
 * figure when a concession applies: one month free on a fourteen-month lease means the
 * lease says 14/13 of the net figure. Quoting only one of the two is how "the website said
 * fifty-eight seventy-five and the phone said something else" happens; the agent says the
 * net figure first and the lease figure after it, the same order as the site.
 */
export interface ConcessionTerms { freeMonths: number; termMonths: number }

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
}

/** "One month free on a 14-month lease, signed by December 31, 2026" → { 1, 14 }. */
export function concessionTerms(text: string | null | undefined): ConcessionTerms | null {
  if (!text) return null
  const m = /(\w+)\s+(month|months|week|weeks)\s+free\s+on\s+an?\s+(\d+)[- ]month\s+lease/i.exec(text)
  if (!m) return null
  const qty = WORDS[m[1]!.toLowerCase()] ?? Number(m[1])
  if (!Number.isFinite(qty) || qty <= 0) return null
  const freeMonths = /week/i.test(m[2]!) ? qty / 4 : qty
  const termMonths = Number(m[3])
  if (!(termMonths > freeMonths)) return null
  return { freeMonths, termMonths }
}

/** The figure on the lease: net effective grossed back up over the term. */
export function leaseRent(unit: Pick<Unit, 'monthlyRent' | 'concession'>): number {
  const t = concessionTerms(unit.concession)
  if (!t) return unit.monthlyRent
  return Math.round(unit.monthlyRent * t.termMonths / (t.termMonths - t.freeMonths))
}

/** The deadline on the offer, if the concession text carries one. */
export function concessionDeadline(text: string | null | undefined): string | null {
  const m = /signed by ([A-Za-z]+ \d{1,2}(?:, \d{4})?)/i.exec(text ?? '')
  return m ? m[1]! : null
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const below100 = (n: number) => n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`
const below1000 = (n: number) => {
  const h = Math.floor(n / 100), r = n % 100
  return [h ? `${ONES[h]} hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ') || 'zero'
}

/**
 * A rent the way a leasing agent says it out loud: "fifty-four forty", not "$5,440".
 *
 * The voice reads digits with a comma as separate numbers — a caller heard "five, four
 * hundred, forty" for 5,440 — so every figure the tool hands the model carries its spoken
 * form, and the prompt tells the model to say that form and never the digits.
 */
/** Plain full words — "five thousand four hundred forty dollars" — the form nobody mishears. */
export function spokenMoney(n: number): string {
  n = Math.round(Math.abs(n))
  const words = n < 1000
    ? below1000(n)
    : `${below1000(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${below1000(n % 1000)}` : ''}`
  return `${words} dollars`
}

/** "$5,440/month — say "five thousand four hundred forty dollars a month"". */
export const sayableRent = (n: number) => `${money(n)}/month — say "${spokenMoney(n)} a month"`

/** One phrase that prices a residence the way the website does: net first, lease after. */
export function rentPhrase(unit: Pick<Unit, 'monthlyRent' | 'concession'>): string {
  const t = concessionTerms(unit.concession)
  if (!t) return sayableRent(unit.monthlyRent)
  const free = t.freeMonths === 1 ? 'one month free'
    : Number.isInteger(t.freeMonths) ? `${t.freeMonths} months free`
    : `${t.freeMonths * 4} weeks free`
  const deadline = concessionDeadline(unit.concession)
  const lease = leaseRent(unit)
  return `${sayableRent(unit.monthlyRent)} net effective with ${free} on a ${t.termMonths}-month lease` +
    `${deadline ? ` if signed by ${deadline}` : ''} (${money(lease)}/month on the lease itself — say "${spokenMoney(lease)}")`
}
