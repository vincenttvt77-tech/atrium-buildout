import type { PropertyId, PersonId, InteractionId } from '../domain/ids.ts'
import type { EmergencySignal } from './emergency.ts'
import type { RestrictedTopic } from '../knowledge/topics.ts'

export type EscalationTrigger =
  | { kind: 'emergency'; signal: EmergencySignal }
  | { kind: 'restricted_topic'; topic: RestrictedTopic }
  | { kind: 'human_requested' }
  | { kind: 'low_confidence'; confidence: number; threshold: number }
  | { kind: 'repeated_failure'; attempts: number }
  | { kind: 'authority_exceeded'; action: string }

export type Priority = 'emergency' | 'urgent' | 'standard'

export interface TranscriptTurn {
  speaker: 'caller' | 'agent'
  text: string
  at: Date
}

/**
 * SOW 10: every escalation carries identity, property context, conversation history,
 * completed steps, the pending task, priority, an SLA clock and a recommended next action.
 *
 * The requirement that matters most is the last line of that section: the human must never
 * need the person to repeat the story. Everything here exists to make that true.
 */
export interface Escalation {
  trigger: EscalationTrigger
  priority: Priority
  propertyId: PropertyId
  interactionId: InteractionId
  personId: PersonId | null
  callerNumber: string | null
  unitId: string | null
  /** The full conversation so far. Not a summary — the human reads what was actually said. */
  transcript: TranscriptTurn[]
  /** What the agent already did, so the human does not repeat it. */
  completedSteps: string[]
  /** What still needs doing. */
  pendingTask: string
  recommendedNextAction: string
  /** When a human must have responded by. */
  respondBy: Date
  createdAt: Date
}

const SLA_MS: Record<Priority, number> = {
  emergency: 2 * 60_000,
  urgent: 30 * 60_000,
  standard: 4 * 60 * 60_000,
}

export function priorityFor(trigger: EscalationTrigger): Priority {
  switch (trigger.kind) {
    case 'emergency':
      return 'emergency'
    case 'restricted_topic':
      // Accommodation and eligibility carry legal clocks; the rest are same-day.
      return trigger.topic === 'reasonable_accommodation' || trigger.topic === 'eligibility_or_denial'
        ? 'urgent' : 'standard'
    case 'authority_exceeded':
    case 'repeated_failure':
      return 'urgent'
    case 'human_requested':
    case 'low_confidence':
      return 'standard'
  }
}

function recommendation(trigger: EscalationTrigger): string {
  switch (trigger.kind) {
    case 'emergency':
      return `Confirm the resident is safe and that emergency services were called. Dispatch the on-call vendor for ${trigger.signal.kind.replace(/_/g, ' ')}. Do not close until the resident confirms resolution.`
    case 'restricted_topic':
      switch (trigger.topic) {
        case 'reasonable_accommodation':
          return 'Route to the Fair Housing contact. Do not evaluate the request. Acknowledge receipt to the resident within the statutory window and log the date received.'
        case 'eligibility_or_denial':
          return 'Route to the leasing manager. Any adverse action requires the documented review process and written notice.'
        case 'money_movement':
          return 'Route to the property accountant. Atrium holds no funds and must not discuss balances beyond read-only status.'
        case 'dispute':
          return 'Route to the property manager with the full transcript. Do not offer remedies or admit fault.'
        case 'legal_question':
          return 'Route to management. Do not interpret the lease or state legal positions.'
        case 'fair_housing':
        case 'protected_class_inquiry':
          return 'Route to the Fair Housing contact immediately. Do not answer, redirect, or characterise the inquiry.'
      }
    // falls through by exhaustiveness
    case 'human_requested':
      return 'The caller asked for a person. Call back on the number captured, with the transcript already read.'
    case 'low_confidence':
      return `The agent was ${Math.round(trigger.confidence * 100)}% confident against a ${Math.round(trigger.threshold * 100)}% threshold. Answer the question and, if it recurs, add it to the knowledge base.`
    case 'repeated_failure':
      return `The workflow failed ${trigger.attempts} times. Complete it manually and check the connector before the next caller hits the same path.`
    case 'authority_exceeded':
      return `The action "${trigger.action}" is above the configured authority tier. Approve, modify, or decline it.`
  }
}

export interface EscalationInput {
  trigger: EscalationTrigger
  propertyId: PropertyId
  interactionId: InteractionId
  personId?: PersonId | null
  callerNumber?: string | null
  unitId?: string | null
  transcript: TranscriptTurn[]
  completedSteps: string[]
  pendingTask: string
  now: Date
}

export function buildEscalation(input: EscalationInput): Escalation {
  const priority = priorityFor(input.trigger)
  return {
    trigger: input.trigger,
    priority,
    propertyId: input.propertyId,
    interactionId: input.interactionId,
    personId: input.personId ?? null,
    callerNumber: input.callerNumber ?? null,
    unitId: input.unitId ?? null,
    transcript: input.transcript,
    completedSteps: input.completedSteps,
    pendingTask: input.pendingTask,
    recommendedNextAction: recommendation(input.trigger),
    respondBy: new Date(input.now.getTime() + SLA_MS[priority]),
    createdAt: input.now,
  }
}
