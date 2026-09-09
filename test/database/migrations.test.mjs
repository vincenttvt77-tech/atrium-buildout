import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { applyDatabaseMigrations, migrationsDirectory } from '../../scripts/lib/database-migrations.mjs'

const tables = ['users','user_credentials','organizations','properties','memberships','property_grants',
  'property_configurations','channel_bindings','operational_documents','calendars','audit_events']

// Synthetic test data only. This is restore evidence for the schema, not a production backup tool.
async function snapshot(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const result = {}
    for (const table of tables) {
      result[table] = (await client.query(`SELECT to_jsonb(record) AS row FROM atrium.${table} record`)).rows
        .map(value => value.row).sort((left,right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }
    await client.query('COMMIT')
    return result
  } catch(error) { await client.query('ROLLBACK'); throw error }
}
async function restore(client, data) {
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL ROLE atrium_admin')
    for (const table of tables) {
      await client.query(`INSERT INTO atrium.${table} SELECT * FROM jsonb_populate_recordset(NULL::atrium.${table}, $1::jsonb)`, [JSON.stringify(data[table])])
    }
    await client.query('COMMIT')
  } catch(error) { await client.query('ROLLBACK'); throw error }
}

test('generated migration applies once and refuses checksum drift without changing data', async () => {
  const db = await createFoundationTestDatabase()
  const directory = await mkdtemp(join(tmpdir(), 'atrium-migration-check-'))
  try {
    const names = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort()
    assert.equal(names.length, 1)
    const sql = await readFile(join(migrationsDirectory, names[0]), 'utf8')
    assert.equal(sql, await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    assert.deepEqual(await applyDatabaseMigrations(db.admin), [])
    assert.equal((await db.admin.query('SELECT count(*) FROM atrium_migrations.history')).rows[0].count, '1')
    await writeFile(join(directory, names[0]), sql + '\n-- Deliberate test-only checksum mismatch\n')
    await assert.rejects(applyDatabaseMigrations(db.admin,directory), /checksum mismatch/)
    assert.equal((await db.admin.query('SELECT count(*) FROM atrium_migrations.history')).rows[0].count, '1')
    await writeFile(join(directory, names[0]), sql)
    // Intentionally misordered fixture, derived from the CLI-generated filename.
    await writeFile(join(directory, names[0].replace(/^2026/,'2025')), '-- Should never be applied after a later migration\n')
    await assert.rejects(applyDatabaseMigrations(db.admin,directory), /not a prefix/)
  } finally { await db.close(); await rm(directory,{recursive:true,force:true}) }
})

test('synthetic two-organization snapshot restores exact credentials, ownership, and booking intervals into a fresh database', async () => {
  const source = await createFoundationTestDatabase()
  const target = await createFoundationTestDatabase()
  const invalidTarget = await createFoundationTestDatabase()
  try {
    await seedFoundationTestDatabase(source.admin)
    await source.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES
      ('organization-a','property-a1',$1::jsonb),('organization-b','property-b1',$2::jsonb)`,
    [JSON.stringify({ blocks: [], bookings: [{ externalId: 'same-provider-id', unitId:'1A', startsAt:'2026-11-01T05:30:00.000Z',endsAt:'2026-11-01T06:00:00.000Z',occupiedStartsAt:'2026-11-01T05:20:00.000Z',occupiedEndsAt:'2026-11-01T06:10:00.000Z' }] }),
      JSON.stringify({blocks:[],bookings:[{externalId:'same-provider-id',unitId:'1A',startsAt:'2026-11-01T09:30:00.000Z',endsAt:'2026-11-01T10:00:00.000Z'}]})])
    for (const [org, property] of [['organization-a','property-a1'],['organization-b','property-b1']]) {
      await source.admin.query('INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4::jsonb)',
        [org,property,'same-contact',JSON.stringify({name:'Synthetic prospect',unit:'1A'})])
    }
    const exported = await snapshot(source.admin)
    await restore(target.admin, exported)
    assert.deepEqual(await snapshot(target.admin), exported)
    const invalid = structuredClone(exported)
    invalid.operational_documents[0].property_id = 'unknown-property'
    await assert.rejects(restore(invalidTarget.admin, invalid), {code:'23503'})
    assert.ok(Object.values(await snapshot(invalidTarget.admin)).every(rows => rows.length === 0), 'a bad ownership reference rolls back the entire restore')
  } finally { await source.close(); await target.close(); await invalidTarget.close() }
})
