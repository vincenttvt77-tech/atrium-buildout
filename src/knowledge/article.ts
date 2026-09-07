import type { ArticleId, PropertyId, PersonId } from '../domain/ids.ts'
import type { PolicyTopic } from './topics.ts'

/**
 * Knowledge base governance per SOW 7.3: content ownership, source/version, property
 * scope, jurisdiction scope, publication status, review date, human approval.
 *
 * An AI-generated answer cannot become approved policy. `approvedBy` is a PersonId and
 * there is deliberately no way to set it to a machine actor.
 */
export interface KnowledgeArticle {
  id: ArticleId
  topic: PolicyTopic
  question: string
  answer: string

  /** Empty array means portfolio-wide; otherwise the article applies only to these. */
  propertyScope: PropertyId[]
  /** Empty array means no jurisdictional limit. e.g. ['NY', 'NY-NYC'] */
  jurisdictionScope: string[]

  status: 'draft' | 'in_review' | 'published' | 'retired'
  version: number
  /** Where the content came from — a lease addendum, a manager, a policy PDF. */
  source: string
  ownerId: PersonId
  /** Null until a human approves. AI proposals never populate this. */
  approvedBy: PersonId | null
  approvedAt: Date | null
  /** After this date the article is stale and must not be served. */
  reviewBy: Date
}

/** A gap the agent hit. Becomes a human review task, never an auto-published answer. */
export interface ProposedArticle {
  topic: PolicyTopic
  question: string
  propertyId: PropertyId
  /** How many times this gap has been hit — drives review priority (SOW 7.3). */
  timesAsked: number
  status: 'proposed'
}

export interface ArticleRef {
  id: ArticleId
  version: number
}

/**
 * An article is servable only if published, in scope for this property, in scope for the
 * jurisdiction, and not past review. Any one failure means we do not have an answer.
 */
export function isServable(
  article: KnowledgeArticle,
  property: PropertyId,
  jurisdiction: string,
  now: Date,
): boolean {
  if (article.status !== 'published') return false
  if (article.approvedBy === null) return false
  if (article.reviewBy.getTime() <= now.getTime()) return false
  if (article.propertyScope.length > 0 && !article.propertyScope.includes(property)) return false
  if (article.jurisdictionScope.length > 0 && !article.jurisdictionScope.includes(jurisdiction)) return false
  return true
}
