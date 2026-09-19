import type { EmergencyContact } from './policy.ts'
import type {
  EmergencyScope, EmergencyStore, EscalationRecord, EscalationStatus, StoredAttempt,
} from './store.ts'

/** In-memory escalations, for tests and for a preview with no database attached. */
export function memoryEmergencyStore(
  contactsByProperty: Readonly<Record<string, readonly EmergencyContact[]>> = {},
): EmergencyStore & { readonly all: EscalationRecord[]; readonly sent: StoredAttempt[] } {
  const escalations = new Map<string, EscalationRecord>()
  const attempts: StoredAttempt[] = []
  const scopeKey = (scope: EmergencyScope) => `${scope.organizationId}/${scope.propertyId}`

  return {
    get all() { return [...escalations.values()] },
    get sent() { return [...attempts] },

    async contacts(scope: EmergencyScope): Promise<EmergencyContact[]> {
      return [...(contactsByProperty[scopeKey(scope)] ?? [])]
    },

    async open(record): Promise<EscalationRecord> {
      const stored: EscalationRecord = {
        ...record, status: 'open', acknowledgedAtMs: null, acknowledgedBy: null,
      }
      escalations.set(stored.id, stored)
      return stored
    },

    async get(id: string): Promise<EscalationRecord | null> {
      return escalations.get(id) ?? null
    },

    async attempts(id: string): Promise<StoredAttempt[]> {
      return attempts.filter(attempt => attempt.escalationId === id)
    },

    async recordAttempt(attempt: StoredAttempt): Promise<void> {
      attempts.push(attempt)
    },

    async setStatus(id: string, status: EscalationStatus): Promise<void> {
      const held = escalations.get(id)
      // An acknowledged escalation is finished; nothing may push it back to another state.
      if (held && held.status !== 'acknowledged') escalations.set(id, { ...held, status })
    },

    async acknowledge(id: string, by: string, atMs: number): Promise<boolean> {
      const held = escalations.get(id)
      if (!held || held.acknowledgedAtMs !== null) return false
      escalations.set(id, { ...held, status: 'acknowledged', acknowledgedAtMs: atMs, acknowledgedBy: by })
      return true
    },

    async listOpen(scope: EmergencyScope, limit: number): Promise<EscalationRecord[]> {
      return [...escalations.values()]
        .filter(record => record.organizationId === scope.organizationId
          && record.propertyId === scope.propertyId && record.status !== 'acknowledged')
        .sort((left, right) => right.openedAtMs - left.openedAtMs)
        .slice(0, Math.max(0, limit))
    },
  }
}
