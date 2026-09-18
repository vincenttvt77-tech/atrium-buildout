import type { JsonObject } from '../../workflows/model.ts'

/**
 * What the stand-in property system keeps, expressed as a port so the connector can be
 * tested without a database and run against one in the application.
 */

export type MockBehavior =
  | 'accept'
  | 'reject'
  | 'timeout'
  | 'timeout_after_write'
  | 'drift'
  | 'invisible_once'

export const MOCK_BEHAVIORS: readonly MockBehavior[] =
  ['accept', 'reject', 'timeout', 'timeout_after_write', 'drift', 'invisible_once']

export const isMockBehavior = (value: unknown): value is MockBehavior =>
  typeof value === 'string' && (MOCK_BEHAVIORS as readonly string[]).includes(value)

export interface MockRecord {
  readonly operationKey: string
  readonly providerReference: string
  readonly inputSha256: string
  readonly record: JsonObject
  readonly hidden: boolean
}

export interface MockScope {
  readonly organizationId: string
  readonly propertyId: string
}

export interface NewMockRecord extends MockScope {
  readonly operationKey: string
  readonly providerReference: string
  readonly inputSha256: string
  readonly record: JsonObject
  readonly hidden: boolean
}

export interface MockPropertyStore {
  /**
   * Reads the armed behaviour and returns the target to 'accept' in the same step, so one
   * armed failure affects one write. Anything else and a presenter arms a fault, moves on,
   * and spends the rest of the demonstration wondering why nothing works.
   */
  takeBehavior(scope: MockScope): Promise<MockBehavior>
  readBehavior(scope: MockScope): Promise<MockBehavior>
  armBehavior(scope: MockScope, behavior: MockBehavior): Promise<void>
  find(scope: MockScope, operationKey: string): Promise<MockRecord | null>
  /** Returns the existing row untouched when the key is already held, the way a provider that deduplicates would. */
  insert(record: NewMockRecord): Promise<MockRecord>
  reveal(scope: MockScope, operationKey: string): Promise<void>
  list(scope: MockScope, limit: number): Promise<MockRecord[]>
}
