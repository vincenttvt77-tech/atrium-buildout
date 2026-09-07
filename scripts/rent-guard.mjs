/**
 * Decides whether a knowledge article's answer contains a RENT figure.
 *
 * Shared by the derivation script and the validator so the two cannot drift — when they
 * disagreed, one of them was wrong, and it was not obvious which.
 *
 * Magnitude alone is the wrong test. A $300,000 renters-insurance minimum and a $2,500
 * package value cap are stable policy facts that belong in an article. "$4,860 net
 * effective" is a stale quote waiting to happen: it changes per residence and per week,
 * and frozen in an article nobody revisits it will eventually be said to a caller who
 * then finds out otherwise. So the test is a money figure sitting next to rent language.
 */

const RENT_CONTEXT = /(rent|net effective|per month|a month|\/month|monthly|lease reads|advertis)/i
const WINDOW = 45
const FLOOR = 1000

/** Returns the offending amount and its surrounding text, or null when the answer is clean. */
export function findRentFigure(answer) {
  const text = String(answer ?? '')
  for (const m of text.matchAll(/\$\s?([\d,]+)/g)) {
    const amount = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(amount) || amount < FLOOR) continue
    const start = Math.max(0, m.index - WINDOW)
    const around = text.slice(start, m.index + m[0].length + WINDOW)
    if (RENT_CONTEXT.test(around)) {
      return { amount, matched: m[0], context: around.trim() }
    }
  }
  return null
}
