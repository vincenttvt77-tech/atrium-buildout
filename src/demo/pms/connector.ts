import { hashJson } from '../../workflows/validation.ts'
import type { DispatchResult, JsonObject, VerificationResult, WorkflowAction, WorkflowConnector } from '../../workflows/model.ts'
import type { MockPropertyStore, MockScope } from './store.ts'

/**
 * A stand-in property-management system, plugged into the durable workflow engine.
 *
 * The engine in src/workflows has been finished and tested since 9 September and has never
 * had a connector registered against it, so nothing has ever run through it. This is the
 * first one. It is deliberately a fixture rather than a client system: there is no client
 * account to point at yet, and a demonstration that needs one is a demonstration that
 * cannot be given.
 *
 * Being fake is what makes it useful. A connector exercised only against a cooperative
 * target looks finished right up to the first timeout in front of an audience. This one can
 * be armed to fail in the specific ways that break naive integrations, and the engine's
 * behaviour under each is the thing worth showing.
 */

export const MOCK_CONNECTOR_ID = 'demo_mock_pms'

/** A lost response after the write landed. Indistinguishable from a write that never happened. */
class MockTimeout extends Error {
  constructor() {
    super('the stand-in property system did not respond')
    this.name = 'MockTimeout'
  }
}

const scopeOf = (action: WorkflowAction): MockScope =>
  ({ organizationId: action.organizationId, propertyId: action.propertyId })

const referenceFor = (action: WorkflowAction): string =>
  `mock-${action.operationKey.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, '-')}`

/**
 * What the target claims to have filed. Kept separate from the requested input so a drifted
 * record is a different object rather than a mutated one.
 */
const recordFor = (action: WorkflowAction, drift: boolean): JsonObject => drift
  ? { ...action.input, scheduled_for: 'a slot the target chose instead' }
  : { ...action.input }

export function mockPropertyConnector(store: MockPropertyStore): WorkflowConnector {
  return {
    id: MOCK_CONNECTOR_ID,
    // Honest, and load-bearing: the engine only permits a retry after an ambiguous result
    // when the target enforces the key itself. This one does, by primary key.
    idempotentWrites: true,

    async dispatch(action: WorkflowAction): Promise<DispatchResult> {
      const scope = scopeOf(action)
      const held = await store.find(scope, action.operationKey)
      // Already filed under this key. A provider that deduplicates answers from the record
      // rather than writing a second one, and so does this.
      if (held) return { status: 'accepted', providerReference: held.providerReference }

      const behavior = await store.takeBehavior(scope)
      if (behavior === 'reject') {
        return { status: 'rejected', code: 'mock_target_refused', retryable: false }
      }
      if (behavior === 'timeout') {
        // Nothing was written, but the caller cannot know that from here.
        return { status: 'unknown', code: 'mock_no_response' }
      }

      const drift = behavior === 'drift'
      const record = recordFor(action, drift)
      const stored = await store.insert({
        ...scope,
        operationKey: action.operationKey,
        providerReference: referenceFor(action),
        // A drifted record carries the digest of what was actually filed, which is what
        // lets read-back notice the difference. Echoing the requested digest would make
        // the target's own mistake invisible.
        inputSha256: drift ? hashJson(record) : action.inputSha256,
        record,
        hidden: behavior === 'invisible_once',
      })

      if (behavior === 'timeout_after_write') throw new MockTimeout()
      return { status: 'accepted', providerReference: stored.providerReference }
    },

    async verify(action: WorkflowAction): Promise<VerificationResult> {
      const scope = scopeOf(action)
      const held = await store.find(scope, action.operationKey)
      // Authoritative: this target knows its own contents, so absence is a fact about it.
      // The engine is entitled to act on that, and does, by permitting one safe re-send.
      if (!held) return { status: 'not_found', authoritative: true }

      if (held.hidden) {
        await store.reveal(scope, action.operationKey)
        // Accepted but not yet readable. Saying "definitely absent" here would invite a
        // second write against a record that exists, so the answer is an honest maybe.
        return { status: 'not_found', authoritative: false }
      }

      if (held.inputSha256 !== action.inputSha256) {
        return { status: 'mismatch', code: 'mock_record_differs_from_request' }
      }

      return {
        status: 'matched',
        operationKey: action.operationKey,
        inputSha256: held.inputSha256,
        providerReference: held.providerReference,
        evidence: held.record,
      }
    },
  }
}
