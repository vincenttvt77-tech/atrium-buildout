import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { hashPassword } from '../../src/ops/accounts.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

let db
before(async () => { db = await createFoundationTestDatabase(); await seedFoundationTestDatabase(db.admin) })
after(async () => { if (db) await db.close() })

const staffContext = { actorUserId: 'owner-a', credentialVersion: 1,
  organizationId: 'organization-a', propertyId: 'property-a1' }
const channelContext = { channelBindingId: 'channel-a', channelBindingVersion: 1,
  organizationId: 'organization-a', propertyId: 'property-a1' }

async function maintenance(work) {
  await db.admin.query('BEGIN')
  try {
    const result = await work(db.admin)
    await db.admin.query('COMMIT')
    return result
  } catch (error) { await db.admin.query('ROLLBACK'); throw error }
}

function bundle(propertyId = 'property-a1') {
  return { property: { id: propertyId }, inventory: [], floorplans: [], knowledge: [] }
}

async function insertConfiguration(client, version, { status = 'published', value = bundle() } = {}) {
  await client.query(`INSERT INTO atrium.property_configurations
    (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES('organization-a','property-a1',$1,$2,$3,'2026-09-01T12:00:00Z','synthetic-test-source',$4)`,
  [version, status, JSON.stringify(value), status === 'draft' ? null : '2026-09-09T12:00:00Z'])
}

async function allowed(context, permission = 'read') {
  return db.app.transaction(context, async client => (await client.query(
    'SELECT atrium.can_access_property($1,$2,$3) AS allowed',
    [context.organizationId, context.propertyId, permission])).rows[0].allowed)
}

test('schema objects have a separate owner, forced RLS, invoker-only functions and restricted real login roles', async () => {
  const roles = (await db.admin.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication
    FROM pg_roles WHERE rolname IN ('atrium_admin','atrium_app','atrium_authenticator') ORDER BY rolname`)).rows
  assert.equal(roles.length, 3)
  for (const role of roles) {
    for (const key of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication']) {
      assert.equal(role[key], false, `${role.rolname} must not have ${key}`)
    }
  }
  const tables = (await db.admin.query(`SELECT c.relname,r.rolname,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='atrium' AND c.relkind='r'`)).rows
  assert.equal(tables.length, 11)
  assert.ok(tables.every(row => row.rolname === 'atrium_admin' && row.relrowsecurity && row.relforcerowsecurity))
  const functions = (await db.admin.query(`SELECT p.proname,p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atrium'`)).rows
  assert.ok(functions.length > 0 && functions.every(row => !row.prosecdef))
  for (const [role, connection] of [['atrium_app', db.app], ['atrium_authenticator', db.auth]]) {
    const identity = await connection.transaction({}, async client => (await client.query(
      'SELECT current_user AS current_role,session_user AS login_role')).rows[0])
    assert.deepEqual(identity, { current_role: role, login_role: role })
    const memberships = await db.admin.query(`SELECT 1 FROM pg_auth_members am
      JOIN pg_roles r ON r.oid=am.member WHERE r.rolname=$1`, [role])
    assert.equal(memberships.rowCount, 0)
  }
  await assert.rejects(db.app.transaction(staffContext, client => client.query(
    "UPDATE atrium.memberships SET role='owner' WHERE id='member-staff-a'")), { code: '42501' })
  await assert.rejects(db.auth.transaction({ actorUserId: 'owner-a' }, client => client.query(
    'SELECT * FROM atrium.operational_documents')), { code: '42501' })
})

test('publication is atomic, requires a complete scoped bundle and preserves published history', async () => {
  await assert.rejects(maintenance(async client => {
    await insertConfiguration(client, 1, { status: 'draft', value: {} })
    await client.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  }), /Current property configuration must be published/)
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM atrium.property_configurations')).rows[0].count, 0)
  assert.equal((await db.admin.query("SELECT published_configuration_version FROM atrium.properties WHERE id='property-a1'")).rows[0].published_configuration_version, null)
  await assert.rejects(insertConfiguration(db.admin, 1, { value: {} }), { code: '23514' })
  await assert.rejects(insertConfiguration(db.admin, 1, { value: bundle('property-b1') }), { code: '23514' })
  await maintenance(async client => {
    await insertConfiguration(client, 1)
    await client.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  })
  const first = (await db.admin.query("SELECT configuration,inventory_read_at FROM atrium.property_configurations WHERE property_id='property-a1' AND version=1")).rows[0]
  await assert.rejects(db.admin.query("UPDATE atrium.property_configurations SET configuration=jsonb_set(configuration,'{property,name}','\"Changed\"') WHERE property_id='property-a1' AND version=1"), /immutable/)
  await assert.rejects(db.admin.query("UPDATE atrium.property_configurations SET inventory_read_at=now() WHERE property_id='property-a1' AND version=1"), /immutable/)
  await assert.rejects(db.admin.query("DELETE FROM atrium.property_configurations WHERE property_id='property-a1' AND version=1"), /cannot be deleted/)
  await assert.rejects(db.admin.query("UPDATE atrium.property_configurations SET status='retired' WHERE property_id='property-a1' AND version=1"), /must be published/)
  await maintenance(async client => {
    await insertConfiguration(client, 2, { value: { ...bundle(), inventory: [{ id: 'synthetic-unit-new' }] } })
    await client.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
    await client.query("UPDATE atrium.property_configurations SET status='retired' WHERE property_id='property-a1' AND version=1")
  })
  const history = (await db.admin.query("SELECT configuration,inventory_read_at,status FROM atrium.property_configurations WHERE property_id='property-a1' AND version=1")).rows[0]
  assert.deepEqual(history.configuration, first.configuration)
  assert.equal(history.inventory_read_at.getTime(), first.inventory_read_at.getTime())
  assert.equal(history.status, 'retired')
  const visible = await db.app.transaction(staffContext, async client => (await client.query('SELECT version FROM atrium.property_configurations')).rows)
  assert.deepEqual(visible.map(row => Number(row.version)), [2])
})

test('composite ownership constraints reject cross-organization grants, bindings, documents and audit actors', async () => {
  const statements = [
    "INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-owner-b','organization-a','property-a1','active')",
    "INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status) VALUES('wrong-channel','vapi','wrong-resource','organization-a','property-b1','active')",
    "INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-b1','same-provider-id','{}')",
    "INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES('organization-a','property-b1','{\"blocks\":[],\"bookings\":[]}')",
    "INSERT INTO atrium.audit_events(organization_id,property_id,id,operation,record_key,actor_channel_binding_id,request_id) VALUES('organization-b','property-b1','wrong-audit','calendar.update','calendar','channel-a','test-request')",
  ]
  for (const sql of statements) await assert.rejects(db.admin.query(sql), { code: '23503' })
  await assert.rejects(db.admin.query("UPDATE atrium.properties SET time_zone='Not/A_Real_Zone' WHERE id='property-a1'"), { code: '23514' })
  await assert.rejects(db.admin.query("UPDATE atrium.properties SET published_configuration_version=99 WHERE id='property-a2'"),
    error => ['23503', 'P0001'].includes(error.code))
})

test('channel scope requires current ownership, capability, version and active binding without borrowing a staff identity', async () => {
  assert.equal(await allowed(channelContext, 'operate'), true)
  assert.equal(await allowed({ ...channelContext, propertyId: 'property-a2' }), false)
  assert.equal(await allowed({ ...channelContext, actorUserId: 'owner-a', credentialVersion: 1 }), false)
  await db.app.transaction(channelContext, client => client.query(`INSERT INTO atrium.operational_documents
    (organization_id,property_id,key,value) VALUES('organization-a','property-a1','call:same-provider-id','{"origin":"synthetic-channel"}')`))
  await db.admin.query("UPDATE atrium.channel_bindings SET capabilities=ARRAY['read'],permission_version=2 WHERE id='channel-a'")
  assert.equal(await allowed(channelContext), false)
  const current = { ...channelContext, channelBindingVersion: 2 }
  assert.equal(await allowed(current), true)
  assert.equal(await allowed(current, 'operate'), false)
  const deniedUpdate = await db.app.transaction(current, client => client.query("UPDATE atrium.operational_documents SET value='{}'"))
  assert.equal(deniedUpdate.rowCount, 0)
  const retained = await db.app.transaction(current, async client => (await client.query(
    "SELECT value FROM atrium.operational_documents WHERE key='call:same-provider-id'")).rows)
  assert.deepEqual(retained, [{ value: { origin: 'synthetic-channel' } }])
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=3 WHERE id='channel-a'")
  assert.equal(await allowed({ ...current, channelBindingVersion: 3 }), false)
  assert.deepEqual(await db.app.transaction({ ...current, channelBindingVersion: 3 }, async client =>
    (await client.query('SELECT * FROM atrium.operational_documents')).rows), [])
})

test('password rotation and removal invalidate existing credential versions while hashes remain restricted to the selected login', async () => {
  const unrelated = await db.auth.transaction({ actorUserId: 'owner-a' }, async client =>
    (await client.query('SELECT * FROM atrium.user_credentials')).rows)
  assert.deepEqual(unrelated, [])
  const selected = await db.auth.transaction({ loginUsername: 'owner-a' }, async client =>
    (await client.query('SELECT user_id FROM atrium.user_credentials')).rows)
  assert.deepEqual(selected, [{ user_id: 'owner-a' }])
  const hash = await hashPassword(randomBytes(18).toString('base64url'))
  await db.admin.query("UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id='owner-a'", [hash])
  assert.equal(await allowed(staffContext), false)
  const current = { ...staffContext, credentialVersion: 2 }
  assert.equal(await allowed(current), true)
  await db.admin.query("UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id='owner-a'", [hash])
  assert.equal(await allowed(current), true, 'saving the same hash must not rotate the session version')
  await assert.rejects(db.admin.query("UPDATE atrium.user_credentials SET user_id='absent-user' WHERE user_id='owner-a'"), /cannot be reassigned/)
  await db.admin.query("DELETE FROM atrium.user_credentials WHERE user_id='owner-a'")
  assert.equal(await allowed(current), false)
  assert.deepEqual(await db.auth.transaction({ loginUsername: 'owner-a' }, async client =>
    (await client.query('SELECT user_id FROM atrium.user_credentials')).rows), [])
})
