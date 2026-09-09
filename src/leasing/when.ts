/**
 * Parses move-in timing the way people actually say it on the phone.
 *
 * The first version called Date.parse() on whatever the caller said. "2 months" is NaN, so
 * nothing was captured, so the tool told the model to ask again — and the model asked the
 * same question, got the same answer, and the call hung with the caller listening to
 * ambience. Nobody answers "when are you looking to move?" with an ISO date.
 *
 * Everything resolves to a window rather than a point, because "sometime this spring" is
 * genuinely a range and pretending otherwise loses information the leasing team wants.
 */

export interface MoveInWindow {
  earliest: Date
  latest: Date | null
  /** How the caller put it, kept for the record. */
  said: string
}

const DAY = 86_400_000
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)

function addMonths(d: Date, n: number): Date {
  const out = new Date(d)
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + n)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

/**
 * Returns a window, or null when the text carries no timing at all. Null means "ask again";
 * everything else means the agent has what it needs and must move on.
 */
export function parseMoveIn(text: string, now: Date): MoveInWindow | null {
  const said = String(text ?? '').trim()
  if (said.length === 0) return null
  /*
   * Speech-to-text punctuates pauses: "within the next, uh, 2. Months." is what "two
   * months" arrives as. A full stop between the number and its unit read as the end of a
   * sentence, nothing parsed, and the caller was asked the same question twice. Strip
   * fillers and the punctuation between a number and the word after it before matching.
   */
  const s = said.toLowerCase()
    .replace(/\b(uh|um|umm|er|like|you know)\b,?/g, ' ')
    .replace(/,/g, ' ')
    .replace(/(\d)\.\s+(?=[a-z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()

  /*
   * An ISO date, checked first and anchored so a bare "2" in "2 months" is not read as a
   * year — but only trusted when it is not in the past.
   *
   * The model does the conversion from "the next 2 months" to a date, and it does not
   * reliably know today's date: on a real call it produced 2025-08-15 for "within the next
   * 2 months", thirteen months behind. Every residence was then filtered out as already
   * gone and the caller was told there was no availability when four homes matched. A
   * move-in date in the past is never what the caller meant, so fall through and read what
   * they actually said instead.
   */
  if (/^\d{4}-\d{2}(-\d{2})?/.test(said)) {
    const t = Date.parse(said)
    if (!Number.isNaN(t) && t >= now.getTime() - 2 * DAY) {
      return { earliest: new Date(t), latest: null, said }
    }
  }

  // Explicit "within/from now to" windows outrank the word "now". Otherwise
  // "within now to three months" incorrectly shrinks to the ASAP 30-day window.
  const bounded = /\b(?:within(?:\s+(?:now|today)\s+(?:to|through))?|from\s+(?:now|today)\s+(?:to|through)|between\s+(?:now|today)\s+and)\s+(?:the\s+next\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(day|week|month)s?\b/.exec(s)
  if (bounded) {
    const count = /^\d+$/.test(bounded[1]!) ? Number(bounded[1]) : NUMBER_WORDS[bounded[1]!]!
    return { earliest: now, latest: bounded[2] === 'month' ? addMonths(now, count)
      : addDays(now, count * (bounded[2] === 'week' ? 7 : 1)), said }
  }

  // "asap", "right away", "immediately", "now", "yesterday"
  if (/\b(asap|as soon as possible|right away|immediately|now|yesterday|today)\b/.test(s)) {
    return { earliest: now, latest: addDays(now, 30), said }
  }

  // "flexible", "no rush", "whenever" — a real answer, just a wide one.
  if (/\b(flexible|no rush|not in a rush|whenever|open|no specific|not sure yet)\b/.test(s)) {
    return { earliest: now, latest: addMonths(now, 6), said }
  }

  const count = (raw: string) => /^\d+$/.test(raw)
    ? Number(raw)
    : raw === 'couple' ? 2 : raw === 'few' ? 3 : raw === 'several' ? 4 : NUMBER_WORDS[raw] ?? 1
  const after = (n: number, unit: string) =>
    unit === 'day' ? addDays(now, n) : unit === 'week' ? addDays(now, n * 7) : addMonths(now, n)

  // "within the next 2 months", "over the next couple of weeks" — between now and then,
  // not two months from now: the caller would take something sooner.
  const within = /\b(?:within|over|in|during|sometime in)?\s*the\s+next\s+(\d+|a|couple|few|several|two|three|four|five|six)\s*(?:of\s+)?(day|week|month)s?\b/.exec(s)
  if (within) {
    return { earliest: now, latest: after(count(within[1]!), within[2]!), said }
  }

  // "in 2 months", "2-3 months", "60 days", "a couple of weeks", "next month"
  const rel = /\b(?:in\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|several)\s*(?:-|to|or)?\s*(\d+)?\s*(?:of\s+)?(day|week|month)s?\b/.exec(s)
  if (rel) {
    const low = count(rel[1]!)
    const high = rel[2] ? Number(rel[2]) : low
    const unit = rel[3]!
    const at = (n: number) => after(n, unit)
    return { earliest: at(low), latest: high > low ? at(high) : addDays(at(low), 30), said }
  }

  if (/\bnext month\b/.test(s)) {
    return { earliest: addMonths(now, 1), latest: addMonths(now, 2), said }
  }
  if (/\b(this month|end of the month)\b/.test(s)) {
    return { earliest: now, latest: addMonths(now, 1), said }
  }

  // A named month, with or without a year. Always resolves forward.
  const monthMatch = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(s))
  if (monthMatch >= 0) {
    const yearMatch = /\b(20\d{2})\b/.exec(s)
    const year = yearMatch ? Number(yearMatch[1]) : now.getUTCFullYear()
    const dayMatch = new RegExp(`\\b${MONTHS[monthMatch]}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s)
    const day = dayMatch ? Number(dayMatch[1]) : 1
    let earliest = new Date(Date.UTC(year, monthMatch, day))
    if (earliest.getUTCMonth() !== monthMatch) return null
    const end = dayMatch ? addDays(earliest, 1) : addMonths(earliest, 1)
    if (!yearMatch && end.getTime() <= now.getTime()) earliest = new Date(Date.UTC(year + 1, monthMatch, day))
    return { earliest, latest: dayMatch ? null : addMonths(earliest, 1), said }
  }

  // Seasons, which people use freely and which are a genuine three-month window.
  const SEASONS: Record<string, number> = { winter: 11, spring: 2, summer: 5, fall: 8, autumn: 8 }
  for (const [name, startMonth] of Object.entries(SEASONS)) {
    if (new RegExp(`\\b${name}\\b`).test(s)) {
      const year = /\b(20\d{2})\b/.exec(s)?.[1]
      let earliest = new Date(Date.UTC(year ? Number(year) : now.getUTCFullYear(), startMonth, 1))
      if (!year && addMonths(earliest, 3).getTime() <= now.getTime()) earliest = addMonths(earliest, 12)
      return { earliest, latest: addMonths(earliest, 3), said }
    }
  }

  // "end of the year", "by the holidays"
  if (/\b(end of (the )?year|holidays|christmas)\b/.test(s)) {
    const earliest = new Date(Date.UTC(now.getUTCFullYear(), 11, 1))
    return { earliest: earliest.getTime() < now.getTime() ? addMonths(earliest, 12) : earliest,
             latest: null, said }
  }

  // A last try at anything else parseable — "Oct 15", "10/15/2026". Past dates are
  // rejected here too, for the same reason.
  const t = Date.parse(said)
  if (!Number.isNaN(t) && t >= now.getTime() - 2 * DAY) {
    return { earliest: new Date(t), latest: null, said }
  }

  return null
}
