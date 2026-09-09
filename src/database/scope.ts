import type { PoolClient } from 'pg'
import { assertAuthorizedScope, AuthorizationError } from '../auth/index.ts'
import type { AuthorizedScope, Permission } from '../auth/index.ts'
import type { DatabaseConnection, DatabaseContext } from './connection.ts'

export function scopeContext(scope: AuthorizedScope): DatabaseContext {
  assertAuthorizedScope(scope)
  return {
    organizationId: scope.organizationId, propertyId: scope.propertyId,
    ...(scope.actor.kind === 'user'
      ? { actorUserId: scope.actor.userId, credentialVersion: scope.actor.credentialVersion }
      : { channelBindingId: scope.actor.bindingId, channelBindingVersion: scope.actor.bindingVersion,
        channelProvider: scope.actor.provider, channelExternalId: scope.actor.externalId }),
  }
}

/** A scope is short-lived evidence, not a bypass for membership changes since issuance. */
export async function propertyTransaction<T>(connection: DatabaseConnection, scope: AuthorizedScope,
  permission: Permission, work: (client: PoolClient) => Promise<T>): Promise<T> {
  assertAuthorizedScope(scope, permission)
  return connection.transaction(scopeContext(scope), async client => {
    const recheck = async () => {
      const allowed = await client.query<{ allowed: boolean }>('SELECT atrium.can_access_property($1, $2, $3) AS allowed',
        [scope.organizationId, scope.propertyId, permission])
      if (allowed.rows[0]?.allowed !== true) throw new AuthorizationError('forbidden')
    }
    await recheck()
    const result = await work(client)
    // Revocation between admission and a later RLS-filtered read must not become
    // an empty/new calendar. A failed exit check also rolls back writes and audit.
    await recheck()
    return result
  })
}
