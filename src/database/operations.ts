import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AuthorizedScope } from '../auth/index.ts'
import type { DocumentStore } from '../store/documents.ts'
import type { CalendarStore, CalendarState } from '../calendar/types.ts'
import { emptyCalendar } from '../calendar/types.ts'
import type { DatabaseConnection } from './connection.ts'
import { propertyTransaction } from './scope.ts'
import { storeBackedCalendar } from '../calendar/port.ts'
import type { CalendarPort } from '../booking/types.ts'
import type { SlotOptions } from '../calendar/slots.ts'
import { AuthorizationError } from '../auth/index.ts'

export interface MutationAttribution { requestId: string; configurationVersion?: number }
const description = () => ({ kind: 'postgres' as const, durable: true,
  note: 'Stored in PostgreSQL with property authorization and an atomic mutation audit.' })
const keyValid = (key: string) => {
  if (typeof key !== 'string' || key.length < 1 || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('Invalid document key.')
}
function serialize(value: unknown): string {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    throw new Error('Operational mutations must return a synchronous JSON value.')
  }
  const text = JSON.stringify(value)
  if (text === undefined || text.length > 4 * 1024 * 1024) throw new Error('The operational record exceeds its supported size.')
  return text
}
function validateCalendar(state: CalendarState): CalendarState {
  if (!state || !Array.isArray(state.blocks) || !Array.isArray(state.bookings)) throw new Error('Calendar data is invalid; availability cannot be verified.')
  return state
}
async function lock(client: PoolClient, scope: AuthorizedScope, resource: string) {
  // Hash collisions only serialize unrelated work. Scope and row keys remain explicit.
  await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
    [JSON.stringify([scope.organizationId, scope.propertyId, resource])])
}
async function audit(client: PoolClient, scope: AuthorizedScope, attribution: MutationAttribution, operation: string, key: string) {
  // Contact-based document keys may contain personal data; audit stores only a digest.
  const digest = createHash('sha256').update(key).digest('hex')
  await client.query(`INSERT INTO atrium.audit_events
    (organization_id, property_id, id, operation, record_key, actor_user_id, actor_channel_binding_id, request_id, configuration_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [scope.organizationId, scope.propertyId, randomUUID(), operation, `sha256:${digest}`,
    scope.actor.kind === 'user' ? scope.actor.userId : null,
    scope.actor.kind === 'channel' ? scope.actor.bindingId : null,
    attribution.requestId, attribution.configurationVersion ?? null])
}

/** Transitional JSON repository: one row per scoped record, not a portfolio query API. */
export class PostgresDocumentStore implements DocumentStore {
  private connection: DatabaseConnection
  private scope: AuthorizedScope
  private attribution: MutationAttribution
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: MutationAttribution) {
    this.connection = connection; this.scope = scope; this.attribution = attribution
  }
  get<T>(key: string): Promise<T | null> {
    keyValid(key)
    return propertyTransaction(this.connection, this.scope, 'read', async client => {
      const row = (await client.query('SELECT value FROM atrium.operational_documents WHERE organization_id=$1 AND property_id=$2 AND key=$3',
        [this.scope.organizationId, this.scope.propertyId, key])).rows[0]
      return row ? row.value as T : null
    })
  }
  async set<T>(key: string, value: T): Promise<void> {
    keyValid(key)
    const serialized = serialize(value)
    await propertyTransaction(this.connection, this.scope, 'operate', async client => {
      await lock(client, this.scope, `document:${key}`)
      await this.write(client, key, serialized)
      await audit(client, this.scope, this.attribution, 'document.set', key)
    })
  }
  update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T> {
    keyValid(key)
    return propertyTransaction(this.connection, this.scope, 'operate', async client => {
      await lock(client, this.scope, `document:${key}`)
      const row = (await client.query('SELECT value FROM atrium.operational_documents WHERE organization_id=$1 AND property_id=$2 AND key=$3 FOR UPDATE',
        [this.scope.organizationId, this.scope.propertyId, key])).rows[0]
      const next = fn(row ? row.value as T : structuredClone(initial))
      const serialized = serialize(next)
      await this.write(client, key, serialized)
      await audit(client, this.scope, this.attribution, 'document.update', key)
      return JSON.parse(serialized) as T
    })
  }
  private async write(client: PoolClient, key: string, value: string): Promise<void> {
    await client.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT (organization_id,property_id,key) DO UPDATE SET value=EXCLUDED.value`,
    [this.scope.organizationId, this.scope.propertyId, key, value])
  }
  list(prefix: string): Promise<string[]> {
    if (typeof prefix !== 'string' || prefix.length > 512 || /[\u0000-\u001f\u007f]/.test(prefix)) throw new Error('Invalid document prefix.')
    const pattern = prefix.replace(/[\\%_]/g, '\\$&') + '%'
    return propertyTransaction(this.connection, this.scope, 'read', async client => {
      const rows = (await client.query<{ key: string }>(`SELECT key FROM atrium.operational_documents
        WHERE organization_id=$1 AND property_id=$2 AND key LIKE $3 ORDER BY key LIMIT 5001`,
      [this.scope.organizationId, this.scope.propertyId, pattern])).rows
      if (rows.length > 5000) throw new Error('This workspace requires a paginated operational query.')
      return rows.map(row => row.key)
    })
  }
  async delete(key: string): Promise<void> {
    keyValid(key)
    await propertyTransaction(this.connection, this.scope, 'operate', async client => {
      await lock(client, this.scope, `document:${key}`)
      await client.query('DELETE FROM atrium.operational_documents WHERE organization_id=$1 AND property_id=$2 AND key=$3',
        [this.scope.organizationId, this.scope.propertyId, key])
      await audit(client, this.scope, this.attribution, 'document.delete', key)
    })
  }
  describe = description
}

/** Property-wide lock preserves existing capacity and emergency admission rules atomically. */
export class PostgresCalendarStore implements CalendarStore {
  private connection: DatabaseConnection
  private scope: AuthorizedScope
  private attribution: MutationAttribution
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: MutationAttribution) {
    this.connection = connection; this.scope = scope; this.attribution = attribution
  }
  assertScope(scope: AuthorizedScope): void {
    if (scope !== this.scope) throw new AuthorizationError('forbidden')
  }
  read(): Promise<CalendarState> {
    return propertyTransaction(this.connection, this.scope, 'read', async client => {
      const row = (await client.query('SELECT state FROM atrium.calendars WHERE organization_id=$1 AND property_id=$2',
        [this.scope.organizationId, this.scope.propertyId])).rows[0]
      return validateCalendar(row ? row.state : emptyCalendar())
    })
  }
  mutate(fn: (state: CalendarState) => CalendarState): Promise<CalendarState> {
    return propertyTransaction(this.connection, this.scope, 'operate', async client => {
      await lock(client, this.scope, 'calendar')
      const row = (await client.query('SELECT state FROM atrium.calendars WHERE organization_id=$1 AND property_id=$2 FOR UPDATE',
        [this.scope.organizationId, this.scope.propertyId])).rows[0]
      const next = validateCalendar(fn(validateCalendar(row ? row.state : emptyCalendar())))
      const serialized = serialize(next)
      await client.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state`,
      [this.scope.organizationId, this.scope.propertyId, serialized])
      await audit(client, this.scope, this.attribution, 'calendar.update', 'calendar')
      return JSON.parse(serialized) as CalendarState
    })
  }
  describe = description
}

/** Domain property arguments must agree with the already authorized repository scope. */
export function propertyCalendar(store: PostgresCalendarStore, scope: AuthorizedScope, now: () => Date, options: SlotOptions): CalendarPort {
  store.assertScope(scope)
  const calendar = storeBackedCalendar(store, now, options)
  return {
    async listSlots(propertyId, from, to, unitId) {
      if (String(propertyId) !== scope.propertyId) throw new AuthorizationError('forbidden')
      return calendar.listSlots(propertyId, from, to, unitId)
    },
    async createBooking(intent) {
      if (String(intent.request.propertyId) !== scope.propertyId) throw new AuthorizationError('forbidden')
      return calendar.createBooking(intent)
    },
    readBooking: id => calendar.readBooking(id),
  }
}
