import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { DatabaseConnection } from '../../src/database/connection.ts'

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

const safetySettings = `SELECT current_setting('search_path') search_path,
  current_setting('statement_timeout') statement_timeout,
  current_setting('lock_timeout') lock_timeout,
  current_setting('idle_in_transaction_session_timeout') idle_timeout`
const boundedSettings = { search_path: 'pg_catalog', statement_timeout: '10s', lock_timeout: '5s', idle_timeout: '15s' }
const inheritedSettings = { search_path: 'public', statement_timeout: '2min', lock_timeout: '0', idle_timeout: '0' }

async function withUnboundedPool(work) {
  // Model the hosted pooler's discarded startup options. These are dedicated
  // synthetic connections; inherited session defaults must not become authority.
  const connections = [db.app, db.auth].map(original => new DatabaseConnection({
    ...original.pool.options, password: original.pool.options.password, options: undefined, max: 1,
  }, original.role))
  try {
    for (const connection of connections) {
      const client = await connection.pool.connect()
      try {
        await client.query(`SELECT set_config('search_path','public',false),
          set_config('statement_timeout','120000',false),set_config('lock_timeout','0',false),
          set_config('idle_in_transaction_session_timeout','0',false)`)
        assert.deepEqual((await client.query(safetySettings)).rows[0], inheritedSettings)
      } finally { client.release() }
    }
    await work(connections)
  } finally { await Promise.all(connections.map(connection => connection.close())) }
}

test('both roles enforce local safety limits on every transaction despite inherited pooler defaults, without session leakage', async () => {
  await withUnboundedPool(async connections => {
    for (const connection of connections) {
      for (const fail of [false, true, false]) {
        const work = connection.transaction({ statement_timeout: '0', lock_timeout: '0' }, async client => {
          assert.deepEqual((await client.query(safetySettings)).rows[0], boundedSettings)
          // A trusted callback changing a LOCAL value cannot poison the next request.
          await client.query("SELECT set_config('lock_timeout','1',true)")
          if (fail) throw new Error('Synthetic rollback')
        })
        if (fail) await assert.rejects(work, /Synthetic rollback/)
        else await work
        const client = await connection.pool.connect()
        try { assert.deepEqual((await client.query(safetySettings)).rows[0], inheritedSettings) }
        finally { client.release() }
      }
    }
  })
})

test('actual statement deadlines cancel both roles and roll back an application mutation before a clean reuse', async () => {
  await withUnboundedPool(async connections => {
    await Promise.all(connections.map(async connection => {
      await assert.rejects(connection.transaction(connection.role === 'atrium_app' ? b1 : {}, async client => {
        if (connection.role === 'atrium_app') await client.query(`INSERT INTO atrium.operational_documents
          (organization_id,property_id,key,value) VALUES('organization-b','property-b1','timeout-rollback','{}')`)
        await client.query('SELECT pg_sleep(11)')
      }), { code: '57014' })
      assert.equal(await connection.transaction({}, async client => (await client.query('SELECT 1 n')).rows[0].n), 1)
    }))
    assert.equal((await db.admin.query("SELECT 1 FROM atrium.operational_documents WHERE key='timeout-rollback'")).rowCount, 0)
  })
})

test('actual lock deadlines bound both roles before the statement deadline, and leave reusable connections', async () => {
  await withUnboundedPool(async connections => {
    const key = 700065
    await db.admin.query('SELECT pg_advisory_lock($1)', [key])
    try {
      await Promise.all(connections.map(async connection => {
        await assert.rejects(connection.transaction({}, client => client.query('SELECT pg_advisory_xact_lock($1)', [key])), { code: '55P03' })
        assert.deepEqual(await connection.transaction({}, async client => (await client.query(safetySettings)).rows[0]), boundedSettings)
      }))
    } finally { await db.admin.query('SELECT pg_advisory_unlock($1)', [key]) }
  })
})

test('actual idle transaction deadline closes the abandoned backend and the next request uses a clean connection', async () => {
  await withUnboundedPool(async connections => {
    await Promise.all(connections.map(async connection => {
      await assert.rejects(connection.transaction({}, async client => {
        const failure = await new Promise((resolve, reject) => {
          const onError = error => { clearTimeout(timer); resolve(error) }
          const timer = setTimeout(() => { client.removeListener('error', onError); reject(new Error('Idle transaction deadline was not enforced')) }, 19000)
          client.once('error', onError)
        })
        assert.equal(failure.code, '25P03')
        throw failure
      }), { code: '25P03' })
      assert.deepEqual(await connection.transaction({}, async client => (await client.query(safetySettings)).rows[0]), boundedSettings)
    }))
  })
})
