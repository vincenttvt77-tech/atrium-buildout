import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { publishLocalDemoProvenance, LOCAL_ORGANIZATION, LOCAL_PROPERTY, LOCAL_SOURCE_AT } from '../../scripts/lib/local-database.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = 'Bundled fictional demo inventory; no PMS connection'
const original = {
  property: { id: LOCAL_PROPERTY, organizationId: LOCAL_ORGANIZATION, timeZone: 'America/New_York',
    buildingName: 'The Larkin', jurisdiction: 'NY',
    sourceNote: 'DEMO PROPERTY — FICTIONAL. The Larkin does not exist.', customStaffSetting: 'preserve me' },
  inventory: [], floorplans: [], knowledge: [], preservedExtension: { staffEdited: true },
}
let db, metadata
const key = [LOCAL_ORGANIZATION, LOCAL_PROPERTY]

async function publish(version, configuration, inventorySource = source, readAt = LOCAL_SOURCE_AT) {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,$3,'published',$4,$5,$6,$5)`, [...key, version, JSON.stringify(configuration), readAt, inventorySource])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2', [...key, version])
    await db.admin.query('COMMIT')
  } catch (error) { await db.admin.query('ROLLBACK'); throw error }
}
async function rows() {
  return (await db.admin.query('SELECT * FROM atrium.property_configurations WHERE organization_id=$1 AND property_id=$2 ORDER BY version', key)).rows
}
async function untouched() {
  const result = {}
  for (const table of ['users', 'user_credentials', 'memberships', 'property_grants', 'channel_bindings', 'calendars', 'operational_documents']) {
    result[table] = (await db.admin.query(`SELECT to_jsonb(row) AS value FROM atrium.${table} row ORDER BY to_jsonb(row)::text`)).rows
  }
  return result
}

before(async () => {
  db = await createFoundationTestDatabase()
  await seedFoundationTestDatabase(db.admin)
  metadata = JSON.parse(await readFile(new URL('../../data/inventory-source.json', import.meta.url), 'utf8'))
  await db.admin.query("INSERT INTO atrium.organizations(id,name,status) VALUES($1,'Local Demo','active')", [LOCAL_ORGANIZATION])
  await db.admin.query("INSERT INTO atrium.properties(id,organization_id,name,time_zone,status) VALUES($1,$2,'Local Demo','America/New_York','active')", [LOCAL_PROPERTY, LOCAL_ORGANIZATION])
  await db.admin.query('CREATE SCHEMA atrium_local AUTHORIZATION atrium_admin')
  await db.admin.query('CREATE TABLE atrium_local.imports(id text PRIMARY KEY,value jsonb NOT NULL)')
  await db.admin.query('INSERT INTO atrium_local.imports VALUES($1,$2)', ['legacy-demo-larkin-v1', JSON.stringify({ organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY, synthetic: true })])
  await db.admin.query('INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3)',
    [...key, JSON.stringify({ bookings: [{ bookingId: 'saved-tour' }], blocks: [{ id: 'saved-block' }], settings: { capacity: 3 } })])
  await publish(1, original)
})
after(async () => { if (db) await db.close() })

test('legacy local configuration publishes v2 once with original data, immutable history and actual publication time', async () => {
  const beforeRows = await rows()
  const beforeData = await untouched()
  const started = Date.now()
  assert.deepEqual(await publishLocalDemoProvenance(db.admin, root), { configurationPublished: true, configurationVersion: 2 })
  const history = await rows()
  assert.deepEqual(history[0], beforeRows[0])
  assert.deepEqual(history[1].configuration, { ...original, inventoryProvenance: metadata })
  assert.equal(history[1].inventory_read_at.toISOString(), LOCAL_SOURCE_AT)
  assert.equal(history[1].inventory_source, source)
  assert.ok(history[1].published_at.getTime() >= started && history[1].published_at.getTime() <= Date.now())
  assert.deepEqual(await untouched(), beforeData)
  assert.deepEqual(await publishLocalDemoProvenance(db.admin, root), { configurationPublished: false, configurationVersion: 2 })
  assert.deepEqual(await rows(), history)
  await assert.rejects(db.admin.query("UPDATE atrium.property_configurations SET configuration='{}' WHERE organization_id=$1 AND property_id=$2 AND version=1", key), /immutable/)
})

test('a later version with existing content keeps all staff changes when adding only provenance', async () => {
  const edited = { ...original, property: { ...original.property, customStaffSetting: 'new staff value' },
    inventory: [{ unitId: '4A', floorPlanId: 'one-bed', monthlyRent: 2500, availableFrom: '2026-11-01', status: 'available', custom: 'must remain' }],
    floorplans: [{ id: 'one-bed', bedrooms: 1, bathrooms: 1, sqft: 800 }] }
  await publish(3, edited)
  assert.deepEqual(await publishLocalDemoProvenance(db.admin, root), { configurationPublished: true, configurationVersion: 4 })
  const history = await rows()
  assert.deepEqual(history[2].configuration, edited)
  assert.deepEqual(history[3].configuration, { ...edited, inventoryProvenance: metadata })
})

test('different existing metadata fails closed and does not overwrite any published version', async () => {
  await publish(5, { ...original, inventoryProvenance: { ...metadata, catalogVersion: 'staff-chosen-version' } })
  const beforeRows = await rows()
  await assert.rejects(publishLocalDemoProvenance(db.admin, root), /provenance differs/)
  assert.deepEqual(await rows(), beforeRows)
  assert.equal((await db.admin.query('SELECT published_configuration_version FROM atrium.properties WHERE organization_id=$1 AND id=$2', key)).rows[0].published_configuration_version, '5')
})

test('a different source, timestamp or fictional identity cannot be silently relabelled a demo', async () => {
  let version = 5
  for (const [configuration, inventorySource, readAt] of [
    [original, 'PMS feed', LOCAL_SOURCE_AT],
    [original, source, '2026-09-02T00:00:00.000Z'],
    [{ ...original, property: { ...original.property, sourceNote: 'Real property' } }, source, LOCAL_SOURCE_AT],
  ]) {
    await publish(++version, configuration, inventorySource, readAt)
    const beforeRows = await rows()
    await assert.rejects(publishLocalDemoProvenance(db.admin, root), /differs from the original fictional local fixture/)
    assert.deepEqual(await rows(), beforeRows)
  }
})
