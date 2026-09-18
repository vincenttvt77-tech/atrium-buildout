import type { MockBehavior, MockPropertyStore, MockRecord, MockScope, NewMockRecord } from './store.ts'

/**
 * The stand-in system's filing cabinet, in memory. For tests and for a local preview that
 * has no database attached; the PostgreSQL implementation is what a demonstration uses,
 * because a fake target that forgets everything between requests cannot show a read-back.
 */
export function memoryMockStore(): MockPropertyStore & { readonly size: number } {
  const records = new Map<string, MockRecord>()
  const behaviors = new Map<string, MockBehavior>()
  const key = (scope: MockScope, operationKey: string) =>
    `${scope.organizationId}/${scope.propertyId}/${operationKey}`
  const scopeKey = (scope: MockScope) => `${scope.organizationId}/${scope.propertyId}`

  return {
    get size() { return records.size },

    async readBehavior(scope: MockScope): Promise<MockBehavior> {
      return behaviors.get(scopeKey(scope)) ?? 'accept'
    },

    async takeBehavior(scope: MockScope): Promise<MockBehavior> {
      const armed = behaviors.get(scopeKey(scope)) ?? 'accept'
      behaviors.set(scopeKey(scope), 'accept')
      return armed
    },

    async armBehavior(scope: MockScope, behavior: MockBehavior): Promise<void> {
      behaviors.set(scopeKey(scope), behavior)
    },

    async find(scope: MockScope, operationKey: string): Promise<MockRecord | null> {
      return records.get(key(scope, operationKey)) ?? null
    },

    async insert(input: NewMockRecord): Promise<MockRecord> {
      const id = key(input, input.operationKey)
      const held = records.get(id)
      if (held) return held
      const stored: MockRecord = {
        operationKey: input.operationKey,
        providerReference: input.providerReference,
        inputSha256: input.inputSha256,
        record: input.record,
        hidden: input.hidden,
      }
      records.set(id, stored)
      return stored
    },

    async reveal(scope: MockScope, operationKey: string): Promise<void> {
      const id = key(scope, operationKey)
      const held = records.get(id)
      if (held) records.set(id, { ...held, hidden: false })
    },

    async list(scope: MockScope, limit: number): Promise<MockRecord[]> {
      const prefix = `${scopeKey(scope)}/`
      return [...records.entries()]
        .filter(([id]) => id.startsWith(prefix))
        .slice(0, Math.max(0, limit))
        .map(([, value]) => value)
    },
  }
}
