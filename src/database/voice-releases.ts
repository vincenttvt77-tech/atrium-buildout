import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { assertAuthorizedScope, AuthorizationError } from '../auth/index.ts'
import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { DocumentStore } from '../store/documents.ts'
import type { DatabaseConnection } from './connection.ts'
import { propertyTransaction } from './scope.ts'
import { createTransactionDocumentStore } from './operations.ts'

/** Configure-only journal admission; recheck the exact voice binding before and after work. */
export function voiceReleaseStore(connection: DatabaseConnection, runtime: ResolvedPropertyRuntime): Pick<DocumentStore, 'get' | 'update'> {
  assertAuthorizedScope(runtime.scope, 'configure')
  if (runtime.scope.actor.kind !== 'user' || !runtime.scope.actor.sessionId || runtime.assistantIds.length !== 1) {
    throw new AuthorizationError('forbidden')
  }
  const key = `voice-release:${runtime.assistantIds[0]}`
  const assertBinding = async (client: PoolClient) => {
    const rows = (await client.query<{ id: string; external_id: string; permission_version: string }>(
      `SELECT id,external_id,permission_version FROM atrium.channel_bindings
       WHERE organization_id=$1 AND property_id=$2 AND provider='vapi' AND status='active' ORDER BY id`,
    [runtime.scope.organizationId, runtime.scope.propertyId])).rows
    if (createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== runtime.bindingFingerprint) {
      throw Object.assign(new Error('This property voice connection changed. Reload the workspace.'), { code: 'property_scope_mismatch' })
    }
  }
  const run = <T>(requested: string, work: (documents: DocumentStore) => Promise<T>): Promise<T> => {
    if (requested !== key) throw new AuthorizationError('forbidden')
    return propertyTransaction(connection, runtime.scope, 'configure', async client => {
      await assertBinding(client)
      const unit = createTransactionDocumentStore(client, runtime.scope,
        { requestId: runtime.requestId, configurationVersion: runtime.snapshot.version })
      try {
        const value = await work(unit.documents)
        await unit.close()
        await assertBinding(client)
        return value
      } catch (error) {
        try { await unit.close() } catch { /* Preserve the original failure; outer transaction rolls back. */ }
        throw error
      }
    }, runtime.snapshot.version)
  }
  return Object.freeze({
    get: <T>(requested: string) => run(requested, documents => documents.get<T>(requested)),
    update: <T>(requested: string, initial: T, change: (current: T) => T) => run(requested, documents => documents.update(requested, initial, change)),
  })
}
