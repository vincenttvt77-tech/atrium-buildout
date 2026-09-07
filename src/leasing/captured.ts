import type { InteractionId } from '../domain/ids.ts'

/**
 * SOW 6.3 requires the prospect record to distinguish raw source conversation from
 * AI-extracted fields and from later human corrections. Provenance is therefore attached
 * to every captured value rather than tracked alongside it — retrofitting this later
 * means going back through every field and guessing where it came from.
 */
export type Provenance =
  /** The agent inferred it from what was said. Carries extraction confidence. */
  | 'ai_extracted'
  /** Staff corrected the agent. Outranks extraction and is never overwritten by it. */
  | 'human_corrected'
  /** Captured from a structured input — a web form field, a CRM record. */
  | 'structured_input'

export interface Captured<T> {
  value: T
  provenance: Provenance
  /** 0..1. Always 1 for human corrections and structured input. */
  confidence: number
  /** The interaction this came from, so the claim can be traced to its conversation. */
  interactionId: InteractionId
  /** The words that justified it. Required — an extracted field with no supporting
   *  excerpt is exactly the kind of claim this record exists to prevent. */
  excerpt: string
  at: Date
}

export function extracted<T>(
  value: T, confidence: number, interactionId: InteractionId, excerpt: string, at: Date,
): Captured<T> {
  return { value, provenance: 'ai_extracted', confidence, interactionId, excerpt, at }
}

export function corrected<T>(
  value: T, interactionId: InteractionId, excerpt: string, at: Date,
): Captured<T> {
  return { value, provenance: 'human_corrected', confidence: 1, interactionId, excerpt, at }
}

/**
 * A human correction always wins, regardless of recency or the model's confidence.
 * Between two AI extractions the later one wins — people revise what they want mid-call.
 */
export function reconcile<T>(existing: Captured<T> | undefined, incoming: Captured<T>): Captured<T> {
  if (!existing) return incoming
  if (existing.provenance === 'human_corrected' && incoming.provenance !== 'human_corrected') {
    return existing
  }
  if (incoming.provenance === 'human_corrected') return incoming
  return incoming.at.getTime() >= existing.at.getTime() ? incoming : existing
}
