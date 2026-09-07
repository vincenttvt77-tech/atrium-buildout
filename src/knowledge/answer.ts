import type { PropertyId } from '../domain/ids.ts'
import type { Topic, LiveSource, RestrictedTopic } from './topics.ts'
import { isRestricted, isVolatile, liveSourceFor } from './topics.ts'
import type { KnowledgeArticle, ArticleRef, ProposedArticle } from './article.ts'
import { isServable } from './article.ts'

export type RefusalReason = 'no_approved_answer' | 'below_confidence_threshold'

export type AnswerDecision =
  /** Safe to say. Always carries the sources that justified it. */
  | { kind: 'answer'; text: string; sources: ArticleRef[]; confidence: number }
  /** Must be resolved from a live system and verified before it is said aloud. */
  | { kind: 'defer_to_live_source'; source: LiveSource; topic: Topic }
  /** Goes to a human with full context. Never answered by the agent. */
  | { kind: 'escalate'; trigger: RestrictedTopic }
  /** We do not know. Say so, offer a human, and file the gap for review. */
  | { kind: 'refuse'; reason: RefusalReason; propose: ProposedArticle }

export interface AnswerRequest {
  question: string
  topic: Topic
  propertyId: PropertyId
  jurisdiction: string
  /** Candidate articles from retrieval. May be empty. */
  candidates: KnowledgeArticle[]
  /** Retrieval/classification confidence, 0..1. */
  confidence: number
  /** Per-property, configurable per SOW 15.3. */
  confidenceThreshold: number
  now: Date
  /** Prior occurrences of this unanswered question, for review priority. */
  timesAsked?: number
}

/**
 * Decides whether Atrium may answer, and if not, what happens instead.
 *
 * The order of these checks is itself a safety property and is covered by tests:
 * restricted topics escalate before anything else is considered, and volatile topics
 * defer to a live system even when a perfectly good article exists — because a stale
 * price is worse than no price.
 */
export function decideAnswer(req: AnswerRequest): AnswerDecision {
  // 1. Restricted. No confidence level and no article makes these answerable.
  if (isRestricted(req.topic)) {
    return { kind: 'escalate', trigger: req.topic }
  }

  // 2. Volatile. Only the owning live system may answer, and only after read-back.
  if (isVolatile(req.topic)) {
    return { kind: 'defer_to_live_source', source: liveSourceFor(req.topic), topic: req.topic }
  }

  // 3. Policy. Needs a published, in-scope, unexpired, human-approved article.
  const servable = req.candidates.filter((a) =>
    isServable(a, req.propertyId, req.jurisdiction, req.now),
  )

  const propose = (): ProposedArticle => ({
    topic: req.topic as ProposedArticle['topic'],
    question: req.question,
    propertyId: req.propertyId,
    timesAsked: (req.timesAsked ?? 0) + 1,
    status: 'proposed',
  })

  if (servable.length === 0) {
    return { kind: 'refuse', reason: 'no_approved_answer', propose: propose() }
  }

  // 4. Confidence gate, configured per property.
  if (req.confidence < req.confidenceThreshold) {
    return { kind: 'refuse', reason: 'below_confidence_threshold', propose: propose() }
  }

  const best = servable[0]!
  return {
    kind: 'answer',
    text: best.answer,
    sources: servable.map((a) => ({ id: a.id, version: a.version })),
    confidence: req.confidence,
  }
}
