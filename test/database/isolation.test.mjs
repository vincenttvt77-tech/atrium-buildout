import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'

let db
before(async () => { db = await createFoundationTestDatabase(); await seedFoundationTestDatabase(db.admin) })
after(async () => { if (db) await db.close() })
const a1 = { actorUserId: 'owner-a', credentialVersion: 1, organizationId: 'organization-a', propertyId: 'property-a1' }
const a2 = { ...a1, propertyId: 'property-a2' }
const b1 = { actorUserId: 'owner-b', credentialVersion: 1, organizationId: 'organization-b', propertyId: 'property-b1' }
const b2 = { ...b1, propertyId: 'property-b2' }

test('real application role has forced row policies and cannot read credentials or assume maintenance', async () => {
  const tables = (await db.admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='atrium' AND relkind='r'")).rows
  assert.ok(tables.length >= 11)
  assert.ok(tables.every(t => t.relrowsecurity && t.relforcerowsecurity))
  await assert.rejects(db.app.transaction(a1, client => client.query('SELECT * FROM atrium.user_credentials')), { code: '42501' })
  await assert.rejects(db.app.transaction(a1, client => client.query('SET ROLE atrium_admin')), { code: '42501' })
})

test('same contact and provider record IDs remain separate in four properties across two organizations', async () => {
  for (const context of [a1,a2,b1,b2]) {
    await db.app.transaction(context, client => client.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value)
      VALUES($1,$2,'lead:same-contact',$3)`, [context.organizationId,context.propertyId,JSON.stringify({ property: context.propertyId, providerId: 'same-provider-id', unit: '1A' })]))
  }
  for (const context of [a1,a2,b1,b2]) {
    const rows = await db.app.transaction(context, async client => (await client.query('SELECT * FROM atrium.operational_documents')).rows)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value.property, context.propertyId)
  }
  await assert.rejects(db.app.transaction(a1, client => client.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-b','property-b1','foreign-write','{}')")), { code: '42501' })
  await assert.rejects(db.admin.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-b1','bad-ownership','{}')"), { code: '23503' })
})

test('missing scope, wrong property grants, and viewer writes fail closed', async () => {
  const rows = await db.app.transaction({}, async client => (await client.query('SELECT * FROM atrium.operational_documents')).rows)
  assert.deepEqual(rows, [])
  const staff = { ...a2, actorUserId: 'staff-a' }
  assert.equal(await db.app.transaction(staff, async client => (await client.query("SELECT atrium.can_access_property('organization-a','property-a2','read') allowed")).rows[0].allowed), false)
  await assert.rejects(db.app.transaction({ ...a1, actorUserId: 'viewer-a' }, client => client.query("INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES('organization-a','property-a1','{\"blocks\":[],\"bookings\":[]}'::jsonb)")), { code: '42501' })
})

test('pool reuse clears context on success and failure; an old credential or membership stops working', async () => {
  await db.app.transaction(a1, async client => assert.equal((await client.query("SELECT current_setting('atrium.property_id',true) id")).rows[0].id, 'property-a1'))
  const connection = await db.app.pool.connect()
  try { assert.ok(!(await connection.query("SELECT current_setting('atrium.property_id',true) id")).rows[0].id) } finally { connection.release() }
  await assert.rejects(db.app.transaction(b1, async () => { throw new Error('synthetic failure') }), /synthetic failure/)
  assert.deepEqual(await db.app.transaction({}, async client => (await client.query('SELECT * FROM atrium.operational_documents')).rows), [])
  await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id='member-owner-a'")
  assert.deepEqual(await db.app.transaction(a1, async client => (await client.query('SELECT * FROM atrium.operational_documents')).rows), [])
  await db.admin.query("UPDATE atrium.memberships SET status='active',permission_version=permission_version+1 WHERE id='member-owner-a'")
  await db.admin.query("UPDATE atrium.users SET credential_version=credential_version+1 WHERE id='owner-a'")
  assert.deepEqual(await db.app.transaction(a1, async client => (await client.query('SELECT * FROM atrium.operational_documents')).rows), [])
})
