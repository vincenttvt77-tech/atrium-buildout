import type { CalendarState, CalendarStore } from './types.ts'
import { primaryEmergency, type EmergencySignal } from '../escalation/emergency.ts'

const KINDS = new Set(['gas', 'smoke_or_fire', 'carbon_monoxide', 'flooding', 'no_heat', 'injury', 'intruder', 'structural'])

/** Preserve the known safety signal even if a later storage read fails. */
export class CalendarInteractionPausedError extends Error {
  readonly signal: EmergencySignal
  constructor(signal: EmergencySignal) {
    super('CALENDAR_INTERACTION_PAUSED')
    this.signal = signal
  }
}

/** No caller words are duplicated into the calendar's booking-admission guard. */
export function heldEmergency(state: CalendarState, interactionId: string): EmergencySignal | null {
  const holds = state.emergencyHolds ?? []
  if (!Array.isArray(holds) || holds.some(hold => !hold || typeof hold.interactionId !== 'string'
    || !hold.interactionId || !KINDS.has(hold.kind) || !Number.isFinite(Date.parse(hold.recordedAt)))) {
    throw new Error('Calendar safety holds are invalid; booking cannot be verified')
  }
  return primaryEmergency(holds.filter(hold => hold.interactionId === interactionId).map(hold => ({
    kind: hold.kind, matched: 'previously reported during this call',
    callEmergencyServices: !['flooding', 'no_heat', 'structural'].includes(hold.kind),
  })))
}

/** The same atomic calendar update orders an emergency pause against a new booking. */
export async function holdEmergency(
  store: CalendarStore, interactionId: string, signal: EmergencySignal, now: Date,
): Promise<EmergencySignal> {
  if (!interactionId || !Number.isFinite(now.getTime())) throw new Error('Invalid emergency hold')
  const saved = await store.mutate(state => {
    const selected = primaryEmergency([heldEmergency(state, interactionId), signal].filter((item): item is EmergencySignal => Boolean(item)))!
    const existing = state.emergencyHolds?.find(hold => hold.interactionId === interactionId)
    return { ...state, emergencyHolds: [
      ...(state.emergencyHolds ?? []).filter(hold => hold.interactionId !== interactionId),
      { interactionId, kind: selected.kind, recordedAt: existing?.recordedAt ?? now.toISOString() },
    ] }
  })
  const signalSaved = heldEmergency(saved, interactionId)
  if (!signalSaved) throw new Error('Emergency hold was not saved')
  return signalSaved
}
