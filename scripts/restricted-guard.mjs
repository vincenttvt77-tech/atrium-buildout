/**
 * Detects restricted-topic subject matter inside an article's body.
 *
 * Shared by the derivation script and the validator so the two cannot drift.
 *
 * The subject has to be absent from the body, not just off the title. An article titled
 * "What do I need to apply?" is filed under a PolicyTopic and looks harmless, and its body
 * can still answer source of income, criminal history and the income multiple. A caller
 * asking "do you take Section 8?" that classifies as application_requirements would then be
 * answered from the knowledge base with escalation bypassed — and those terms are rare in
 * the corpus, so IDF weighting pins the article at ceiling confidence.
 */

export const RESTRICTED_PATTERNS = [
  [/section 8|voucher|cityfheps|housing choice|source of income/i, 'housing vouchers and source of income'],
  [/emotional support|service animal|assistance animal|reasonable accommodation/i, 'reasonable accommodation'],
  [/criminal history|criminal record|conviction|housing court|tenant blacklist/i, 'criminal or housing court history'],
  [/\b(40|80)\s*(times|x)\b|times the monthly rent/i, 'the income eligibility test'],
]

/** Returns why the body is restricted, or null when it is clean. */
export function findRestrictedContent(answer) {
  const body = String(answer ?? '')
  for (const [pattern, why] of RESTRICTED_PATTERNS) {
    if (pattern.test(body)) return { why, matched: (pattern.exec(body) ?? [''])[0] }
  }
  return null
}
