import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresCalendarStore, PostgresDocumentStore } from '../../src/database/operations.ts'

let db, scope
before(async () => {
  db = await createFoundationTestDatabase()
  const credentials = await seedFoundationTestDatabase(db.admin)
  const authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  const principal = await authorization.authenticatePassword('owner-a', credentials.password)
  scope = await authorization.authorizeProperty(principal, 'property-a1', 'operate')
  await db.admin.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value)
    VALUES('organization-a','property-a1','retained-record','{"count":7}')`)
  await db.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state)
    VALUES('organization-a','property-a1','{"blocks":[{"target":"2026-09-10","reason":"Synthetic closed day","blockedAt":"2026-09-09T12:00:00Z"}],"bookings":[]}')`)
})
beforeEach(async () => {
  await db.admin.query("UPDATE atrium.memberships SET status='active',permission_version=permission_version+1 WHERE id='member-owner-a'")
})
after(async () => { if (db) await db.close() })

/** Uses the real app connection. Only scheduling is controlled: the admin commits a
 * revocation at a deterministic boundary between real SQL statements. */
function revokeAfter(matches) {
  let revoked = false
  return {
    get revoked() { return revoked },
    transaction(context, work) {
      return db.app.transaction(context, client => work(new Proxy(client, {
        get(target, key) {
          if (key !== 'query') return Reflect.get(target, key)
          return async (...args) => {
            const result = await client.query(...args)
            if (!revoked && matches(String(args[0]), result)) {
              revoked = true
              await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id='member-owner-a'")
            }
            return result
          }
        },
      })))
    },
  }
}

const initialPermission = (sql, result) => sql.includes('can_access_property') && result.rows[0]?.allowed === true
const afterAudit = sql => sql.includes('INSERT INTO atrium.audit_events')

test('calendar read cannot turn a mid-request revocation into an empty/open calendar', async () => {
  const connection = revokeAfter(initialPermission)
  const calendar = new PostgresCalendarStore(connection, scope, { requestId: 'read-race-calendar' })
  await assert.rejects(calendar.read(), { code: 'forbidden' })
  assert.equal(connection.revoked, true)
  const stored = (await db.admin.query('SELECT state FROM atrium.calendars')).rows[0].state
  assert.equal(stored.blocks.length, 1)
})

test('document get cannot report an existing record missing after mid-request revocation', async () => {
  const connection = revokeAfter(initialPermission)
  const documents = new PostgresDocumentStore(connection, scope, { requestId: 'read-race-document' })
  await assert.rejects(documents.get('retained-record'), { code: 'forbidden' })
  assert.equal(connection.revoked, true)
})

test('document listing cannot turn mid-request revocation into an empty workspace', async () => {
  const connection = revokeAfter(initialPermission)
  const documents = new PostgresDocumentStore(connection, scope, { requestId: 'read-race-list' })
  await assert.rejects(documents.list('retained'), { code: 'forbidden' })
  assert.equal(connection.revoked, true)
})

test('revocation after a document write and audit append rolls both back before returning success', async () => {
  const connection = revokeAfter(afterAudit)
  const documents = new PostgresDocumentStore(connection, scope, { requestId: 'write-race-document' })
  const before = (await db.admin.query('SELECT count(*)::int AS count FROM atrium.audit_events')).rows[0].count
  await assert.rejects(documents.set('retained-record', { count: 999 }), { code: 'forbidden' })
  assert.equal(connection.revoked, true, 'revocation must happen after the actual audit INSERT')
  assert.deepEqual((await db.admin.query("SELECT value FROM atrium.operational_documents WHERE key='retained-record'")).rows[0].value, { count: 7 })
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM atrium.audit_events')).rows[0].count, before)
})

test('revocation after calendar mutation and audit append preserves the old schedule and audit count', async () => {
  const connection = revokeAfter(afterAudit)
  const calendar = new PostgresCalendarStore(connection, scope, { requestId: 'write-race-calendar' })
  const before = (await db.admin.query('SELECT count(*)::int AS count FROM atrium.audit_events')).rows[0].count
  const oldState = (await db.admin.query('SELECT state FROM atrium.calendars')).rows[0].state
  await assert.rejects(calendar.mutate(() => ({ blocks: [], bookings: [] })), { code: 'forbidden' })
  assert.equal(connection.revoked, true)
  assert.deepEqual((await db.admin.query('SELECT state FROM atrium.calendars')).rows[0].state, oldState)
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM atrium.audit_events')).rows[0].count, before)
})
