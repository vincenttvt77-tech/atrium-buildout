import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AuthorizedScope, Permission } from '../auth/index.ts'
import type { DocumentStore } from '../store/documents.ts'
import type { CalendarStore, CalendarState } from '../calendar/types.ts'
import { emptyCalendar } from '../calendar/types.ts'
import type { DatabaseConnection } from './connection.ts'
import { propertyTransaction } from './scope.ts'
import { storeBackedCalendar } from '../calendar/port.ts'
import type { CalendarPort } from '../booking/types.ts'
import type { SlotOptions } from '../calendar/slots.ts'
import { assertAuthorizedScope, AuthorizationError } from '../auth/index.ts'
import { TransactionQueue } from './transaction-queue.ts'

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

/** Private client adapter. Only the owning transaction can create or use it. */
function documentsOnClient(client: PoolClient, scope: AuthorizedScope, attribution: MutationAttribution): DocumentStore {
  const ids = [scope.organizationId, scope.propertyId]
  const write = async (key: string, value: string): Promise<void> => {
    await client.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT (organization_id,property_id,key) DO UPDATE SET value=EXCLUDED.value`, [...ids, key, value])
  }
  return {
    async get<T>(key: string): Promise<T | null> {
      keyValid(key)
      const row = (await client.query('SELECT value FROM atrium.operational_documents WHERE organization_id=$1 AND property_id=$2 AND key=$3',
        [...ids, key])).rows[0]
      return row ? row.value as T : null
    },
    async set<T>(key: string, value: T): Promise<void> {
      keyValid(key)
      const serialized = serialize(value)
      await lock(client, scope, `document:${key}`)
      await write(key, serialized)
      await audit(client, scope, attribution, 'document.set', key)
    },
    async update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T> {
      keyValid(key)
      await lock(client, scope, `document:${key}`)
      const row = (await client.query('SELECT value FROM atrium.operational_documents WHERE organization_id=$1 AND property_id=$2 AND key=$3 FOR UPDATE',
        [...ids, key])).rows[0]
      const next = fn(row ? row.value as T : structuredClone(initial))
      const serialized = serialize(next)
      await write(key, serialized)
      await audit(client, scope, attribution, 'document.update', key)
      return JSON.parse(serialized) as T
    },
    async list(prefix: string): Promise<string[]> {
      if (typeof prefix !== 'string' || prefix.length > 512 || /[\u0000-\u001f\u007f]/.test(prefix)) throw new Error('Invalid document prefix.')
      const pattern = prefix.replace(/[\\%_]/g, '\\$&') + '%'
      const rows = (await client.query<{ key: string }>(`SELECT key FROM atrium.operational_documents
        WHERE organization_id=$1 AND property_id=$2 AND key LIKE $3 ORDER BY key LIMIT 5001`, [...ids, pattern])).rows
      if (rows.length > 5000) throw new Error('This workspace requires a paginated operational query.')
      return rows.map(row => row.key)
    },
    async delete(key: string): Promise<void> {
      keyValid(key)
      await lock(client, scope, `document:${key}`)
      await client.query('DELETE FROM atrium.operational_documents WHERE organization_id=$1 AND property_id=$2 AND key=$3', [...ids, key])
      await audit(client, scope, attribution, 'document.delete', key)
    },
    describe: description,
  }
}

const transactionError = (code: 'document_transaction_closed' | 'document_transaction_incomplete') =>
  Object.assign(new Error(code === 'document_transaction_closed'
    ? 'The document transaction is closed.' : 'Every document operation must finish before the transaction callback returns.'), { code })

/** @internal Database-owned composition only, after propertyTransaction admission.
 * Call close before committing, including cleanup after callback failure. No raw
 * client or scope-changing method is exposed through the returned document port.
 */
export function createTransactionDocumentStore(client: PoolClient, scope: AuthorizedScope,
  attribution: MutationAttribution): { documents: DocumentStore; close(): Promise<void> } {
  assertAuthorizedScope(scope, 'operate')
  const documents = documentsOnClient(client, scope, { ...attribution })
  let accepting = true
  let failed = false
  let failure: unknown
  let tail: Promise<void> = Promise.resolve()
  const pending = new Set<Promise<unknown>>()
  const run = <U>(operation: () => Promise<U>): Promise<U> => {
    if (!accepting) return Promise.reject(transactionError('document_transaction_closed'))
    // One client, including read/modify/write callbacks, in invocation order.
    const result = tail.then(() => {
      if (failed) throw failure
      return operation()
    })
    pending.add(result)
    tail = result.then(() => { pending.delete(result) }, error => {
      pending.delete(result)
      if (!failed) { failed = true; failure = error }
    })
    return result
  }
  const scoped: DocumentStore = Object.freeze({
    get: <U>(key: string) => run(() => documents.get<U>(key)),
    set: <U>(key: string, value: U) => run(() => documents.set(key, value)),
    update: <U>(key: string, initial: U, fn: (current: U) => U) => run(() => documents.update(key, initial, fn)),
    list: (prefix: string) => run(() => documents.list(prefix)),
    delete: (key: string) => run(() => documents.delete(key)),
    describe: () => {
      if (!accepting) throw transactionError('document_transaction_closed')
      return description()
    },
  })
  let closing: Promise<void> | undefined
  return Object.freeze({
    documents: scoped,
    close(): Promise<void> {
      if (closing) return closing
      // Close admission first, then drain before any owning transaction releases its client.
      accepting = false
      const incomplete = pending.size > 0
      closing = (async () => {
        await tail
        if (failed) throw failure
        if (incomplete) throw transactionError('document_transaction_incomplete')
      })()
      return closing
    },
  })
}

/** Transitional JSON repository: one row per scoped record, not a portfolio query API. */
export class PostgresDocumentStore implements DocumentStore {
  private readonly connection: DatabaseConnection
  private readonly scope: AuthorizedScope
  private readonly attribution: MutationAttribution
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: MutationAttribution) {
    this.connection = connection; this.scope = scope; this.attribution = { ...attribution }
  }
  private single<T>(permission: Permission, work: (documents: DocumentStore) => Promise<T>): Promise<T> {
    return propertyTransaction(this.connection, this.scope, permission,
      client => work(documentsOnClient(client, this.scope, this.attribution)), this.attribution.configurationVersion)
  }
  get<T>(key: string): Promise<T | null> { return this.single('read', documents => documents.get<T>(key)) }
  set<T>(key: string, value: T): Promise<void> { return this.single('operate', documents => documents.set(key, value)) }
  update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T> {
    return this.single('operate', documents => documents.update(key, initial, fn))
  }
  list(prefix: string): Promise<string[]> { return this.single('read', documents => documents.list(prefix)) }
  delete(key: string): Promise<void> { return this.single('operate', documents => documents.delete(key)) }

  /** All operations and their audits commit together under the same property scope.
   * Await each operation (or Promise.all). The callback handle expires on return,
   * and any failed or unfinished operation makes the whole unit roll back.
   */
  transaction<T>(work: (documents: DocumentStore) => Promise<T>): Promise<T> {
    if (typeof work !== 'function') throw new Error('A document transaction callback is required.')
    return propertyTransaction(this.connection, this.scope, 'operate', async client => {
      const unit = createTransactionDocumentStore(client, this.scope, this.attribution)
      try {
        const value = await work(unit.documents)
        await unit.close()
        return value
      } catch (error) {
        try { await unit.close() } catch { /* The original callback/close error remains authoritative. */ }
        throw error
      }
    }, this.attribution.configurationVersion)
  }
  describe = description
}

/** Property-wide lock preserves existing capacity and emergency admission rules atomically. */
export class PostgresCalendarStore implements CalendarStore {
  private mutationPermission: Permission
  private connection: DatabaseConnection
  private scope: AuthorizedScope
  private attribution: MutationAttribution
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: MutationAttribution, mutationPermission: Permission = 'operate') {
    this.connection = connection; this.scope = scope; this.attribution = attribution; this.mutationPermission = mutationPermission
  }
  assertScope(scope: AuthorizedScope): void {
    if (scope !== this.scope) throw new AuthorizationError('forbidden')
  }
  read(): Promise<CalendarState> {
    return propertyTransaction(this.connection, this.scope, 'read', async client => {
      const row = (await client.query('SELECT state FROM atrium.calendars WHERE organization_id=$1 AND property_id=$2',
        [this.scope.organizationId, this.scope.propertyId])).rows[0]
      return validateCalendar(row ? row.state : emptyCalendar())
    }, this.attribution.configurationVersion)
  }
  mutate(fn: (state: CalendarState) => CalendarState): Promise<CalendarState> {
    return propertyTransaction(this.connection, this.scope, this.mutationPermission, async client => {
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
    }, this.attribution.configurationVersion)
  }
  /** Calendar replacement and associated lead/reminder changes share one protected
   * transaction. Only scoped ports escape to the callback, and both use one queue.
   * No external connector/network operation belongs inside this callback.
   */
  transaction<T>(work: (unit: { calendar: CalendarStore; documents: DocumentStore }) => Promise<T>): Promise<T> {
    if (typeof work !== 'function') throw new Error('A calendar transaction callback is required.')
    return propertyTransaction(this.connection, this.scope, this.mutationPermission, async client => {
      assertAuthorizedScope(this.scope, 'operate')
      const queue = new TransactionQueue()
      const rawDocuments = documentsOnClient(client, this.scope, this.attribution)
      const readCalendar = async (): Promise<CalendarState> => {
        const row = (await client.query('SELECT state FROM atrium.calendars WHERE organization_id=$1 AND property_id=$2',
          [this.scope.organizationId, this.scope.propertyId])).rows[0]
        return validateCalendar(row ? row.state : emptyCalendar())
      }
      const describe = () => { queue.assertOpen(); return description() }
      const calendar: CalendarStore = Object.freeze({
        read: () => queue.run(readCalendar),
        mutate: (fn: (state: CalendarState) => CalendarState) => queue.run(async () => {
          await lock(client, this.scope, 'calendar')
          const current = await readCalendar()
          const serialized = serialize(validateCalendar(fn(current)))
          await client.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3::jsonb)
            ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state`,
          [this.scope.organizationId, this.scope.propertyId, serialized])
          await audit(client, this.scope, this.attribution, 'calendar.update', 'calendar')
          return JSON.parse(serialized) as CalendarState
        }), describe,
      })
      const documents: DocumentStore = Object.freeze({
        get: <U>(key: string) => queue.run(() => rawDocuments.get<U>(key)),
        set: <U>(key: string, value: U) => queue.run(() => rawDocuments.set(key, value)),
        update: <U>(key: string, initial: U, fn: (value: U) => U) => queue.run(() => rawDocuments.update(key, initial, fn)),
        delete: (key: string) => queue.run(() => rawDocuments.delete(key)),
        list: (prefix: string) => queue.run(() => rawDocuments.list(prefix)), describe,
      })
      try {
        const result = await work({ calendar, documents })
        await queue.close()
        return result
      } catch (error) {
        try { await queue.close() } catch { /* Preserve the original failure, after draining queued operations. */ }
        throw error
      }
    }, this.attribution.configurationVersion)
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
