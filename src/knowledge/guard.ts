/**
 * Question-level guards that run before the topic the model chose is trusted.
 *
 * The topic is an argument the model supplies, so routing safety through it alone means a
 * misclassification becomes a Fair Housing incident. A caller who says "I have a German
 * Shepherd service dog" and gets classified as `pet_policy` would be read the breed
 * restriction — a denial on the basis of a disability, from a product whose whole claim is
 * that it does not do that.
 *
 * These patterns override the topic. They cost false escalations, which are cheap: a human
 * reads a transcript and answers a pet question. The other direction is not cheap.
 */
import type { RestrictedTopic } from './topics.ts'

interface Guard {
  topic: RestrictedTopic
  patterns: RegExp[]
}

const GUARDS: Guard[] = [
  {
    topic: 'reasonable_accommodation',
    patterns: [
      /\bservice (?:animal|dog)\b/i,
      /\bemotional support (?:animal|dog|cat)\b/i,
      /\b(?:esa|assistance animal)\b/i,
      /\bcomfort animal\b/i,
      /\bguide dog\b/i,
      /\breasonable accommodation\b/i,
      /\baccommodation (?:request|for my)\b/i,
      /\b(?:wheelchair|mobility|disabilit|handicap)\w*\b/i,
      /\bADA\b/,
    ],
  },
  {
    topic: 'protected_class_inquiry',
    patterns: [
      /\bsource of income\b/i,
      /\b(?:section 8|section eight)\b/i,
      /\bhousing (?:voucher|choice)\b/i,
      /\bcityfheps\b/i,
      /\bhasa\b/i,
      /\bkids? (?:are|is) (?:allowed|okay)\b/i,
      /\bfamilial status\b/i,
    ],
  },
  {
    topic: 'eligibility_or_denial',
    patterns: [
      /\bwill I (?:qualify|get approved|be approved)\b/i,
      /\b(?:my |a )?credit score\b/i,
      /\bbeen (?:denied|rejected)\b/i,
      /\beviction (?:on my record|history)\b/i,
      /\bcriminal (?:record|history|background)\b/i,
      /\bbankrupt\w*\b/i,
    ],
  },
  {
    topic: 'legal_question',
    patterns: [
      /\bis (?:that|this|it)\s+(?:\w+\s+)?legal\b/i,
      /\bagainst the law\b/i,
      /\bmy (?:lawyer|attorney)\b/i,
      /\bsue\b/i,
      /\bbreak (?:my|the) lease\b/i,
      /\brent stabiliz\w*\b/i,
    ],
  },
]

/**
 * Returns the restricted topic a question must be routed to regardless of the topic the
 * model supplied, or null when the question is safe to answer normally.
 */
export function guardTopic(question: string): { topic: RestrictedTopic; matched: string } | null {
  for (const guard of GUARDS) {
    for (const pattern of guard.patterns) {
      const m = pattern.exec(question)
      if (m) return { topic: guard.topic, matched: m[0] }
    }
  }
  return null
}
