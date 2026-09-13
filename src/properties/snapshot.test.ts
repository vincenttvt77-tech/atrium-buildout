import test from 'node:test'
import assert from 'node:assert/strict'
import rawProperty from '../../data/property.json' with { type: 'json' }
import rawInventory from '../../data/inventory.json' with { type: 'json' }
import rawPlans from '../../data/floorplans.json' with { type: 'json' }
import rawKnowledge from '../../data/knowledge.json' with { type: 'json' }
import { createAuthorizationService, AuthorizationError } from '../auth/index.ts'
import type { AuthorizationRepository, AuthorizedScope } from '../auth/index.ts'
import { isServable } from '../knowledge/article.ts'
import { propertyId } from '../domain/ids.ts'
import { inventoryDemoDisclosure, inventoryIsFresh, inventoryIsQuotable } from '../inventory/source.ts'
import { PropertyConfigurationError, validatePublishedProperty, loadPublishedProperty,
  withProperty, currentProperty, propertyContext } from './index.ts'
import type { PublishedPropertyConfiguration, PropertySnapshot } from './index.ts'

const NOW = new Date('2026-09-09T16:00:00.000Z')

/** Real authorization issuance; structural casts cannot mint a scope under test. */
async function scope(organizationId = 'org-one', property = 'property-one'): Promise<AuthorizedScope> {
  const repository: AuthorizationRepository = {
    findCredentialByUsername: async () => null, resolveSession: async () => null,
    getUser: async () => null,
    getOrganization: async () => ({ id: organizationId, name: 'Organization', status: 'active', permissionVersion: 1 }),
    getProperty: async () => ({ id: property, organizationId, name: 'Building', timeZone: 'America/Chicago', status: 'active', permissionVersion: 1 }),
    getMembership: async () => null,
    listMemberships: async () => [], listProperties: async () => [], listPropertyGrants: async () => [],
    findChannelBinding: async () => ({ id: `binding-${property}`, provider: 'vapi', externalId: 'assistant',
      organizationId, propertyId: property, status: 'active', capabilities: ['read', 'operate'], permissionVersion: 1 }),
  }
  return createAuthorizationService(repository).authorizeChannel('vapi', 'assistant', 'read')
}

function configuration(authority: AuthorizedScope): PublishedPropertyConfiguration {
  return {
    organizationId: authority.organizationId, propertyId: authority.propertyId, version: 2,
    timeZone: 'America/Chicago', publishedAt: '2026-09-09T12:00:00.000Z',
    inventoryReadAt: '2026-09-08T09:00:00.000Z', inventorySource: 'fixture:reviewed-inventory-v1',
    bundle: {
      property: { id: authority.propertyId, organizationId: authority.organizationId,
        buildingName: 'Building One', timeZone: 'America/Chicago', jurisdiction: 'IL', tourCapacityPerSlot: 2 },
      inventory: [{ unitId: '4A', propertyId: authority.propertyId, floorPlanId: 'one-bed', floor: 4,
        monthlyRent: 2400, availableFrom: '2026-10-01', status: 'available' }],
      floorplans: [{ id: 'one-bed', bedrooms: 1, bathrooms: 1, sqft: 750 }],
      knowledge: [{ id: 'article-hours', topic: 'hours', question: 'When are you open?', answer: 'Weekdays.\nAsk staff for holiday hours.',
        propertyScope: [authority.propertyId], jurisdictionScope: ['IL'], status: 'published', version: 1,
        source: 'Manager-approved hours', ownerId: 'person-owner', approvedBy: 'person-reviewer',
        approvedAt: '2026-09-01T12:00:00Z', reviewBy: '2027-09-01T12:00:00Z', keywords: ['hours'] }],
    },
  }
}

function rejects(config: PublishedPropertyConfiguration, authority: AuthorizedScope): void {
  assert.throws(() => validatePublishedProperty(config, authority, NOW), PropertyConfigurationError)
}

test('loads the exact published property and preserves the inventory source time', async () => {
  const authority = await scope()
  let seen: AuthorizedScope | undefined
  const snapshot = await loadPublishedProperty({ getPublishedConfiguration: async requested => {
    seen = requested
    return configuration(authority)
  } }, authority, NOW)
  assert.equal(seen, authority)
  assert.equal(snapshot.propertyId, authority.propertyId)
  assert.equal(snapshot.organizationId, authority.organizationId)
  assert.equal(snapshot.timeZone, 'America/Chicago')
  assert.equal(snapshot.jurisdiction, 'IL')
  assert.equal(snapshot.inventory.readAt.toISOString(), '2026-09-08T09:00:00.000Z')
  assert.notEqual(snapshot.inventory.readAt.getTime(), NOW.getTime())
  assert.equal(snapshot.inventory.units[0]?.bedrooms, 1)
  assert.equal(snapshot.bundle.inventory.length, 1)
  assert.equal(snapshot.articles[0]?.approvedAt?.toISOString(), '2026-09-01T12:00:00.000Z')
})

test('a missing published configuration fails without any bundled-property fallback', async () => {
  const authority = await scope()
  await assert.rejects(loadPublishedProperty({ getPublishedConfiguration: async () => null }, authority, NOW),
    { code: 'property_configuration_missing' })
})

test('deserialized scope is refused before repository access or context creation', async () => {
  const authority = await scope()
  const forged = JSON.parse(JSON.stringify(authority)) as AuthorizedScope
  let reads = 0
  await assert.rejects(loadPublishedProperty({ getPublishedConfiguration: async () => { reads++; return configuration(authority) } }, forged, NOW), AuthorizationError)
  assert.equal(reads, 0)
  const snapshot = validatePublishedProperty(configuration(authority), authority, NOW)
  assert.throws(() => withProperty(forged, snapshot, () => undefined), AuthorizationError)
})

test('outer record, property and embedded resource ownership must match authorized scope', async () => {
  const authority = await scope()
  const mutations: Array<(config: PublishedPropertyConfiguration) => void> = [
    config => { config.organizationId = 'other-org' },
    config => { config.propertyId = 'other-property' },
    config => { config.bundle.property.id = 'other-property' },
    config => { config.bundle.property.organizationId = 'other-org' },
    config => { (config.bundle.inventory[0] as Record<string, unknown>).propertyId = 'other-property' },
    config => { (config.bundle.floorplans[0] as Record<string, unknown>).organizationId = 'other-org' },
    config => { (config.bundle.knowledge[0] as Record<string, unknown>).propertyScope = [authority.propertyId, 'other-property'] },
    config => { (config.bundle.knowledge[0] as Record<string, unknown>).sourceId = '' },
  ]
  for (const mutate of mutations) { const config = configuration(authority); mutate(config); rejects(config, authority) }
})

test('timezone must be explicit and agree with the property row; jurisdiction is not inferred', async () => {
  const authority = await scope()
  for (const zone of [undefined, null, '', 'EST', 'Not/A_Zone', 'America/New_York']) {
    const config = configuration(authority)
    if (zone === undefined) delete config.bundle.property.timeZone
    else config.bundle.property.timeZone = zone
    rejects(config, authority)
  }
  const config = configuration(authority)
  delete config.bundle.property.jurisdiction
  rejects(config, authority)
})

test('empty arrays are explicit empty data, while missing arrays or excluded records fail publication validation', async () => {
  const authority = await scope()
  const empty = configuration(authority)
  empty.bundle.inventory = []; empty.bundle.floorplans = []; empty.bundle.knowledge = []
  assert.equal(validatePublishedProperty(empty, authority, NOW).inventory.units.length, 0)
  const missing = configuration(authority)
  delete (missing.bundle as Partial<typeof missing.bundle>).inventory
  rejects(missing, authority)
  const orphan = configuration(authority)
  ;(orphan.bundle.inventory[0] as Record<string, unknown>).floorPlanId = 'other-plan'
  rejects(orphan, authority)
  const badDate = configuration(authority)
  ;(badDate.bundle.inventory[0] as Record<string, unknown>).availableFrom = '2026-02-30'
  rejects(badDate, authority)
})

test('duplicate apartment, plan and knowledge IDs cannot overwrite one another', async () => {
  const authority = await scope()
  for (const key of ['inventory', 'floorplans', 'knowledge'] as const) {
    const config = configuration(authority)
    config.bundle[key].push(structuredClone(config.bundle[key][0]))
    if (key === 'inventory') (config.bundle.inventory[1] as Record<string, unknown>).unitId = '4a'
    rejects(config, authority)
  }
})

test('invalid versions, timestamps, source and property capacity are refused rather than defaulted', async () => {
  const authority = await scope()
  const mutations: Array<(config: PublishedPropertyConfiguration) => void> = [
    config => { config.version = 0 },
    config => { config.version = Number.MAX_SAFE_INTEGER + 1 },
    config => { config.publishedAt = '2026-02-30T00:00:00Z' },
    config => { config.publishedAt = '2030-01-01T00:00:00Z' },
    config => { config.inventoryReadAt = '2026-09-09T13:00:00Z' },
    config => { config.inventorySource = '' },
    config => { config.bundle.property.tourCapacityPerSlot = '2' },
    config => { config.bundle.property.tourCapacityPerSlot = 0 },
  ]
  for (const mutate of mutations) { const config = configuration(authority); mutate(config); rejects(config, authority) }
})

test('knowledge metadata cannot silently create approval or legal-topic authority', async () => {
  const authority = await scope()
  for (const patch of [
    { approvedBy: null, approvedAt: null }, { approvedAt: 'invalid' }, { reviewBy: '2027-02-30T00:00:00Z' },
    { ownerId: '' }, { source: '' }, { topic: 'legal_question' }, { topic: ['hours'] }, { status: ['published'] },
    { jurisdictionScope: ['garbage'] }, { version: 0 },
  ]) {
    const config = configuration(authority)
    Object.assign(config.bundle.knowledge[0] as object, patch)
    rejects(config, authority)
  }
})

test('expired and in-review knowledge remain unservable under existing domain gates', async () => {
  const authority = await scope()
  for (const patch of [{ reviewBy: '2026-09-08T12:00:00Z' }, { status: 'in_review', approvedBy: null, approvedAt: null }]) {
    const config = configuration(authority)
    Object.assign(config.bundle.knowledge[0] as object, patch)
    const snapshot = validatePublishedProperty(config, authority, NOW)
    assert.equal(isServable(snapshot.articles[0]!, propertyId(authority.propertyId), snapshot.jurisdiction, NOW), false)
  }
})

test('published snapshots detach raw objects and mutable Date instances', async () => {
  const authority = await scope()
  const config = configuration(authority)
  const snapshot = validatePublishedProperty(config, authority, NOW)
  config.bundle.property.buildingName = 'Changed after load'
  assert.equal(snapshot.property.buildingName, 'Building One')
  assert.throws(() => { snapshot.property.buildingName = 'Mutated by handler' }, TypeError)
  snapshot.inventory.readAt.setFullYear(2040)
  snapshot.inventory.units[0]!.monthlyRent = 1
  snapshot.articles[0]!.reviewBy.setFullYear(1900)
  assert.equal(snapshot.inventory.readAt.toISOString(), '2026-09-08T09:00:00.000Z')
  assert.equal(snapshot.inventory.units[0]?.monthlyRent, 2400)
  assert.equal(snapshot.articles[0]?.reviewBy.getUTCFullYear(), 2027)
})

test('JSON-incompatible values are rejected, including cycles and prototype objects', async () => {
  const authority = await scope()
  for (const value of [undefined, () => 1, new Date(), Number.NaN]) {
    const config = configuration(authority)
    config.bundle.property.extra = value
    rejects(config, authority)
  }
  const cyclic = configuration(authority)
  cyclic.bundle.property.extra = cyclic.bundle.property
  rejects(cyclic, authority)
})

test('request-local property contexts remain isolated across interleaved asynchronous work', async () => {
  const [first, second] = await Promise.all([scope(), scope('org-two', 'property-two')])
  const a = validatePublishedProperty(configuration(first), first, NOW)
  const b = validatePublishedProperty(configuration(second), second, NOW)
  assert.equal(propertyContext(), undefined)
  assert.throws(currentProperty, /authorized property context/)
  let release: () => void = () => undefined
  const wait = new Promise<void>(resolve => { release = resolve })
  await Promise.all([
    withProperty(first, a, async () => { await wait; assert.equal(currentProperty().snapshot, a); assert.equal(currentProperty().scope, first) }),
    withProperty(second, b, async () => { assert.equal(currentProperty().snapshot, b); release(); await Promise.resolve(); assert.equal(currentProperty().scope, second) }),
  ])
  assert.equal(propertyContext(), undefined)
  assert.throws(() => withProperty(first, b, () => undefined), PropertyConfigurationError)
  assert.throws(() => withProperty(first, { ...a } as PropertySnapshot, () => undefined), PropertyConfigurationError)
})

test('existing Larkin content validates only after explicit jurisdiction and property-ID migration', async () => {
  const authority = await scope('larkin-org', 'larkin-property')
  const config = configuration(authority)
  config.timeZone = rawProperty.timeZone
  config.bundle = {
    property: { ...structuredClone(rawProperty), id: authority.propertyId, jurisdiction: 'NY' },
    inventory: structuredClone(rawInventory), floorplans: structuredClone(rawPlans),
    knowledge: structuredClone(rawKnowledge).map(article => ({ ...article,
      propertyScope: article.propertyScope.map(id => {
        assert.equal(id, rawProperty.id)
        return authority.propertyId
      }),
    })),
  }
  const snapshot = validatePublishedProperty(config, authority, NOW)
  assert.equal(snapshot.articles.length, rawKnowledge.length)
  assert.equal(snapshot.inventory.units.length, rawInventory.length)
  assert.equal(snapshot.propertyId, authority.propertyId)
  assert.equal(snapshot.timeZone, 'America/New_York')
})

test('published demo provenance survives loading without rejuvenating the inventory source', async () => {
  const authority = await scope()
  const config = configuration(authority)
  config.bundle.inventoryProvenance = { sourceMode: 'demo', catalogAsOf: config.inventoryReadAt,
    catalogVersion: 'sample-catalogue-v2', fictional: true }
  const snapshot = validatePublishedProperty(config, authority, NOW)
  assert.equal(snapshot.inventory.readAt.toISOString(), config.inventoryReadAt)
  assert.equal(inventoryIsFresh(snapshot.inventory, NOW), false)
  assert.equal(inventoryIsQuotable(snapshot.inventory, NOW), true)
  assert.match(inventoryDemoDisclosure(snapshot.inventory, NOW)!, /fictional demo catalogue/)
  assert.match(inventoryDemoDisclosure(snapshot.inventory, NOW)!, /sample-catalogue-v2/)
  assert.throws(() => { (snapshot.bundle.inventoryProvenance as { catalogVersion: string }).catalogVersion = 'other' }, TypeError)
})

test('invalid or inconsistent published source provenance fails the property configuration explicitly', async () => {
  const authority = await scope()
  for (const provenance of [null, {}, { sourceMode: 'other' },
    { sourceMode: 'demo', catalogAsOf: '2026-09-08T09:00:00.000Z', catalogVersion: 'v1', fictional: false },
    { sourceMode: 'demo', catalogAsOf: NOW.toISOString(), catalogVersion: 'v1', fictional: true },
  ]) {
    const config = configuration(authority)
    Object.assign(config.bundle, { inventoryProvenance: provenance })
    assert.throws(() => validatePublishedProperty(config, authority, NOW), {
      code: 'property_configuration_invalid', field: 'bundle.inventoryProvenance',
    })
  }
})

test('a source name containing demo does not change a published live inventory into sample data', async () => {
  const authority = await scope()
  const config = configuration(authority)
  config.inventorySource = 'Fictional demo in an untyped source name'
  const snapshot = validatePublishedProperty(config, authority, NOW)
  assert.equal(snapshot.inventory.provenance, undefined)
  assert.equal(inventoryIsQuotable(snapshot.inventory, NOW), false)
})
