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
export function findRestrictedContent(answer, topic) {
  const body = String(answer ?? '')

  /*
   * A pet-policy article MUST mention service and assistance animals: a breed list or a
   * pet fee stated without the exemption is the Fair Housing exposure, not the other way
   * round. What it may not do is adjudicate. It may say they are not pets, that the rules
   * do not apply, and that the office handles it — routing language. A caller who brings
   * up a service animal is escalated by the question guard before any article is read,
   * so the article never answers the accommodation question itself.
   */
  if (topic === 'pet_policy') {
    const routing = /(not pets|are not pets|do not apply|does not apply|none of the pet rules|handled by the (?:leasing )?office|office handles)/i
    const mentions = /(service|assistance) animal|emotional support/i
    if (mentions.test(body) && routing.test(body)) {
      const scrubbed = body.replace(/[^.!?]*(?:service|assistance) animal[^.!?]*[.!?]/gi, '')
                           .replace(/[^.!?]*emotional support[^.!?]*[.!?]/gi, '')
      return findRestrictedContent(scrubbed)
    }
  }

  for (const [pattern, why] of RESTRICTED_PATTERNS) {
    if (pattern.test(body)) return { why, matched: (pattern.exec(body) ?? [''])[0] }
  }
  return null
}
