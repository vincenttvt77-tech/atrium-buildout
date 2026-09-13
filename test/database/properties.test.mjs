import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService, AuthorizationError } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresPropertyRepository } from '../../src/database/properties.ts'
import { loadPublishedProperty, PropertyConfigurationError } from '../../src/properties/index.ts'

let db, auth, repository, credentials
const NOW = new Date('2026-09-09T16:00:00.000Z')
const READ_AT = '2026-09-08T09:00:00.000Z'
const PUBLISHED_AT = '2026-09-09T12:00:00.000Z'
const BUILDINGS = [
  ['organization-a', 'property-a1', 'America/New_York', 'NY'],
  ['organization-a', 'property-a2', 'America/Chicago', 'IL'],
  ['organization-b', 'property-b1', 'America/Los_Angeles', 'CA'],
]

function bundle(organizationId, propertyId, timeZone, jurisdiction, revision = 1) {
  return {
    property: { id: propertyId, organizationId, buildingName: propertyId, timeZone, jurisdiction, tourCapacityPerSlot: 2 },
    inventory: [{ unitId: '4A', propertyId, floorPlanId: 'one-bed', floor: 4,
      monthlyRent: 2400 + revision, availableFrom: '2026-10-01', status: 'available' }],
    floorplans: [{ id: 'one-bed', bedrooms: 1, bathrooms: 1, sqft: 750 }],
    knowledge: [{ id: 'hours', propertyId, topic: 'hours', question: 'When can I call?', answer: `${propertyId} hours version ${revision}`,
      propertyScope: [propertyId], jurisdictionScope: [jurisdiction], status: 'published', version: revision,
      source: 'Synthetic test policy', ownerId: 'test-owner', approvedBy: 'test-reviewer',
      approvedAt: '2026-09-01T00:00:00Z', reviewBy: '2027-09-01T00:00:00Z' }],
  }
}

async function publish(building, version, payload = bundle(...building, version), schemaVersion = 1) {
  const [organizationId, propertyId] = building
  await db.admin.query('BEGIN')
  try {
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id, property_id, version, schema_version, status, configuration, inventory_read_at, inventory_source, published_at)
      VALUES ($1,$2,$3,$4,'published',$5,$6,$7,$8)`,
    [organizationId, propertyId, version, schemaVersion, JSON.stringify(payload), READ_AT, `source:${propertyId}:v${version}`, PUBLISHED_AT])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2',
      [organizationId, propertyId, version])
    await db.admin.query('COMMIT')
  } catch (error) { await db.admin.query('ROLLBACK'); throw error }
}

before(async () => {
  db = await createFoundationTestDatabase()
  credentials = await seedFoundationTestDatabase(db.admin)
  auth = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  repository = new PostgresPropertyRepository(db.app)
  for (const building of BUILDINGS) await publish(building, 1)
})
after(async () => { if (db) await db.close() })

async function userScope(username, propertyId) {
  const principal = await auth.authenticatePassword(username, credentials.password)
  assert.ok(principal)
  return auth.authorizeProperty(principal, propertyId, 'read')
}

test('real property repository returns exact scoped published content and source timestamps', async () => {
  for (const building of BUILDINGS) {
    const [organizationId, propertyId, timeZone, jurisdiction] = building
    const authority = await userScope(organizationId === 'organization-a' ? 'owner-a' : 'owner-b', propertyId)
    const snapshot = await loadPublishedProperty(repository, authority, NOW)
    assert.equal(snapshot.organizationId, organizationId)
    assert.equal(snapshot.propertyId, propertyId)
    assert.equal(snapshot.timeZone, timeZone)
    assert.equal(snapshot.jurisdiction, jurisdiction)
    assert.equal(snapshot.articles[0].propertyId, propertyId)
    assert.equal(snapshot.inventory.readAt.toISOString(), READ_AT)
    assert.equal(snapshot.inventory.source, `source:${propertyId}:v1`)
    assert.equal(snapshot.publishedAt, PUBLISHED_AT)
  }
})

test('higher draft version is invisible until a valid published pointer changes', async () => {
  const authority = await userScope('owner-a', 'property-a1')
  await db.admin.query(`INSERT INTO atrium.property_configurations
    (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source)
    VALUES('organization-a','property-a1',99,'draft',$1,$2,'draft-source')`,
  [JSON.stringify(bundle(...BUILDINGS[0], 99)), READ_AT])
  assert.equal((await loadPublishedProperty(repository, authority, NOW)).version, 1)
  await publish(BUILDINGS[0], 2)
  const updated = await loadPublishedProperty(repository, authority, NOW)
  assert.equal(updated.version, 2)
  assert.equal(updated.inventory.units[0].monthlyRent, 2402)
  assert.equal(updated.inventory.readAt.toISOString(), READ_AT)
})

test('a property with no publication stays unconfigured rather than borrowing another building', async () => {
  const authority = await userScope('owner-b', 'property-b2')
  await assert.rejects(loadPublishedProperty(repository, authority, NOW), { code: 'property_configuration_missing' })
})

test('forged scopes and the authenticator DB role cannot read property content', async () => {
  const authority = await userScope('owner-a', 'property-a1')
  await assert.rejects(repository.getPublishedConfiguration({ ...authority, propertyId: 'property-b1' }), AuthorizationError)
  assert.throws(() => new PostgresPropertyRepository(db.auth), /application database role/)
})

test('a previously issued scope is refused after its property grant is revoked', async () => {
  const authority = await userScope('staff-a', 'property-a1')
  assert.ok(await repository.getPublishedConfiguration(authority))
  await db.admin.query("UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1 WHERE membership_id='member-staff-a' AND property_id='property-a1'")
  try { await assert.rejects(repository.getPublishedConfiguration(authority), AuthorizationError) }
  finally { await db.admin.query("UPDATE atrium.property_grants SET status='active',permission_version=permission_version+1 WHERE membership_id='member-staff-a' AND property_id='property-a1'") }
})

test('channel reads stay in their binding and an old binding scope fails after revocation', async () => {
  const authority = await auth.authorizeChannel('vapi', 'synthetic-assistant-a', 'read')
  assert.equal((await loadPublishedProperty(repository, authority, NOW)).propertyId, 'property-a1')
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=permission_version+1 WHERE id='channel-a'")
  try { await assert.rejects(repository.getPublishedConfiguration(authority), AuthorizationError) }
  finally { await db.admin.query("UPDATE atrium.channel_bindings SET status='active',permission_version=permission_version+1 WHERE id='channel-a'") }
})

test('published JSON with foreign unit ownership is rejected even though the DB envelope is valid', async () => {
  const data = bundle(...BUILDINGS[1], 2)
  data.inventory[0].propertyId = 'property-b1'
  await publish(BUILDINGS[1], 2, data)
  const authority = await userScope('owner-a', 'property-a2')
  await assert.rejects(loadPublishedProperty(repository, authority, NOW), PropertyConfigurationError)
  await publish(BUILDINGS[1], 3)
})

test('unsupported configuration schema versions fail explicitly', async () => {
  await publish(BUILDINGS[2], 2, bundle(...BUILDINGS[2], 2), 2)
  const authority = await userScope('owner-b', 'property-b1')
  await assert.rejects(loadPublishedProperty(repository, authority, NOW), { code: 'property_configuration_invalid', field: 'schemaVersion' })
  await publish(BUILDINGS[2], 3)
})

test('the typed property timezone must agree with published JSON; a JSON override cannot choose it', async () => {
  const data = bundle(...BUILDINGS[0], 3)
  data.property.timeZone = 'America/Chicago'
  // Current DB constraints may reject this at publication; if not, the application
  // validator is still required to reject it before the configuration is used.
  let rejectedByDatabase = false
  try { await publish(BUILDINGS[0], 3, data) }
  catch (error) { if (error.code !== '23514') throw error; rejectedByDatabase = true }
  if (!rejectedByDatabase) {
    const authority = await userScope('owner-a', 'property-a1')
    await assert.rejects(loadPublishedProperty(repository, authority, NOW), PropertyConfigurationError)
    await publish(BUILDINGS[0], 4)
  }
})
