import type { PoolClient } from 'pg'
import { assertAuthorizedScope, AuthorizationError } from '../auth/index.ts'
import type { AuthorizedScope, Permission } from '../auth/index.ts'
import type { DatabaseConnection, DatabaseContext } from './connection.ts'

export function scopeContext(scope: AuthorizedScope): DatabaseContext {
  assertAuthorizedScope(scope)
  return {
    organizationId: scope.organizationId, propertyId: scope.propertyId,
    ...(scope.actor.kind === 'user'
      ? { actorUserId: scope.actor.userId, credentialVersion: scope.actor.credentialVersion,
        ...(scope.actor.sessionId ? { actorSessionId: scope.actor.sessionId } : {}) }
      : { channelBindingId: scope.actor.bindingId, channelBindingVersion: scope.actor.bindingVersion,
        channelProvider: scope.actor.provider, channelExternalId: scope.actor.externalId }),
  }
}

/** Recheck an issued scope on the client already owned by this property transaction. */
export async function assertCurrentPropertyAccess(client: PoolClient, scope: AuthorizedScope,
  permission: Permission, expectedConfigurationVersion?: number): Promise<void> {
  assertAuthorizedScope(scope, permission)
  const allowed = await client.query<{ allowed: boolean }>('SELECT atrium.can_access_property($1, $2, $3) AS allowed',
    [scope.organizationId, scope.propertyId, permission])
  if (allowed.rows[0]?.allowed !== true) throw new AuthorizationError('forbidden')
  if (expectedConfigurationVersion !== undefined) {
    const configuration = await client.query('SELECT published_configuration_version FROM atrium.properties WHERE organization_id=$1 AND id=$2',
      [scope.organizationId,scope.propertyId])
    if (Number(configuration.rows[0]?.published_configuration_version) !== expectedConfigurationVersion) {
      throw Object.assign(new Error('Property configuration changed during this request.'), {code:'property_configuration_changed'})
    }
  }
}

/** A scope is short-lived evidence, not a bypass for membership changes since issuance. */
export async function propertyTransaction<T>(connection: DatabaseConnection, scope: AuthorizedScope,
  permission: Permission, work: (client: PoolClient) => Promise<T>, expectedConfigurationVersion?: number): Promise<T> {
  assertAuthorizedScope(scope, permission)
  return connection.transaction(scopeContext(scope), async client => {
    if (scope.actor.kind === 'user' && scope.actor.sessionId) {
      // Acquire the user/session fence before any property locks. Revocation waits
      // for admitted work; work admitted after revocation commits is refused.
      const held = await client.query<{ allowed: boolean }>('SELECT atrium.hold_current_session() AS allowed')
      if (held.rows[0]?.allowed !== true) throw new AuthorizationError('forbidden')
    }
    await assertCurrentPropertyAccess(client, scope, permission, expectedConfigurationVersion)
    const result = await work(client)
    // Grant/configuration changes during work must not become an empty/new
    // calendar. A failed exit check also rolls back writes and audit.
    await assertCurrentPropertyAccess(client, scope, permission, expectedConfigurationVersion)
    return result
  })
}
