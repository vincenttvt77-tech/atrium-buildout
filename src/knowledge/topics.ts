/**
 * Every question a prospect or resident asks falls into exactly one class, and the
 * class — not the retrieved content — decides whether Atrium may answer it at all.
 *
 * This is the spine of the "never guess" rule in SOW 5.2(3), 6.2 and 7.1.
 */

/**
 * Facts that change without anyone updating a document: price, availability, a lease
 * balance, whether a slot is still open. These may never be answered from the knowledge
 * base even when an article exists and looks current, because an article that was true
 * last Tuesday is how a prospect gets quoted a rent that is no longer offered.
 */
export type VolatileTopic =
  | 'unit_availability'
  | 'pricing'
  | 'tour_slot_availability'
  | 'application_status'
  | 'account_status'
  | 'work_order_status'

/**
 * Stable, property-approved policy. Safe to answer from a published article that is in
 * scope for the property and has not passed its review date.
 */
export type PolicyTopic =
  | 'pet_policy'
  | 'parking'
  | 'amenities'
  | 'hours'
  | 'utilities'
  | 'application_requirements'
  | 'building_access'
  | 'move_logistics'
  | 'general_property_fact'

/**
 * Never answered by Atrium under any confidence, from any source. These carry legal or
 * Fair Housing exposure and go to a human with full context (SOW 3.2, 5.2(7), 10).
 */
export type RestrictedTopic =
  | 'fair_housing'
  | 'reasonable_accommodation'
  | 'eligibility_or_denial'
  | 'legal_question'
  | 'dispute'
  | 'money_movement'
  | 'protected_class_inquiry'

export type Topic = VolatileTopic | PolicyTopic | RestrictedTopic

const VOLATILE = new Set<string>([
  'unit_availability', 'pricing', 'tour_slot_availability',
  'application_status', 'account_status', 'work_order_status',
])

const RESTRICTED = new Set<string>([
  'fair_housing', 'reasonable_accommodation', 'eligibility_or_denial',
  'legal_question', 'dispute', 'money_movement', 'protected_class_inquiry',
])

export const isVolatile = (t: Topic): t is VolatileTopic => VOLATILE.has(t)
export const isRestricted = (t: Topic): t is RestrictedTopic => RESTRICTED.has(t)
export const isPolicy = (t: Topic): t is PolicyTopic => !isVolatile(t) && !isRestricted(t)

/** The live system that owns each volatile topic. Nothing else may answer for it. */
export const liveSourceFor = (t: VolatileTopic) => ({
  unit_availability: 'inventory',
  pricing: 'inventory',
  tour_slot_availability: 'tour_calendar',
  application_status: 'application_system',
  account_status: 'account_system',
  work_order_status: 'work_order_system',
} as const)[t]

export type LiveSource = ReturnType<typeof liveSourceFor>
