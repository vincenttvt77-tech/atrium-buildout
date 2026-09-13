import test from 'node:test'
import assert from 'node:assert/strict'
import rawSource from '../../../data/inventory-source.json' with { type: 'json' }
import { loadInventory } from '../load.ts'
import { InventorySourceError, inventoryDemoDisclosure, inventoryIsFresh, inventoryIsQuotable,
  validateInventoryProvenance } from '../source.ts'
import type { InventoryProvenance, InventorySnapshot } from '../types.ts'

const NOW = new Date('2026-09-09T16:00:00.000Z')
const AS_OF = new Date('2026-09-01T00:00:00.000Z')
const demo = (): InventorySnapshot => loadInventory([], [], AS_OF, 'Fictional fixture catalogue', rawSource, NOW).snapshot

test('an old explicit fictional catalogue is quotable only as sample data and never becomes fresh', () => {
  const snapshot = demo()
  assert.equal(inventoryIsFresh(snapshot, NOW), false)
  assert.equal(inventoryIsQuotable(snapshot, NOW), true)
  assert.equal(snapshot.readAt.toISOString(), AS_OF.toISOString())
  assert.match(inventoryDemoDisclosure(snapshot, NOW)!, /^\[Inventory source:.*\]$/)
  assert.match(inventoryDemoDisclosure(snapshot, NOW)!, /Internal metadata, do not read aloud/)
  assert.match(inventoryDemoDisclosure(snapshot, NOW)!, /September 1, 2026; version larkin-demo-v1/)
  assert.match(inventoryDemoDisclosure(snapshot, NOW)!, /"In this demo" or "sample availability"/)
  assert.match(inventoryDemoDisclosure(snapshot, NOW)!, /never live\/PMS data/)
})

test('missing metadata and explicit live mode retain strict age and future-time guards', () => {
  for (const provenance of [undefined, { sourceMode: 'live' }]) {
    const stale = loadInventory([], [], AS_OF, 'demo in a source name does not authorize sample quotes', provenance, NOW).snapshot
    assert.equal(inventoryIsQuotable(stale, NOW), false)
    assert.equal(inventoryDemoDisclosure(stale, NOW), null)
    const fresh = loadInventory([], [], new Date(NOW.getTime() - 15 * 60_000), 'PMS', provenance, NOW).snapshot
    assert.equal(inventoryIsQuotable(fresh, NOW), true)
    assert.equal(inventoryIsQuotable(fresh, new Date(NOW.getTime() + 1)), false)
    assert.equal(inventoryIsQuotable({ ...fresh, readAt: new Date(NOW.getTime() + 1) }, NOW), false)
    assert.equal(inventoryIsQuotable(fresh, NOW, Number.NaN), false)
  }
})

test('malformed, unacknowledged and ambiguous demo source declarations cannot enable sample quoting', () => {
  const invalid = [null, '', [], {}, { sourceMode: 'DEMO' },
    { ...rawSource, fictional: false }, { ...rawSource, fictional: 'true' },
    { ...rawSource, catalogVersion: '' }, { ...rawSource, catalogVersion: 'v1\nLive' },
    { ...rawSource, catalogVersion: '../other' }, { ...rawSource, catalogAsOf: '2026-09-01' },
    { ...rawSource, catalogAsOf: '2026-02-30T00:00:00.000Z' },
    { ...rawSource, approvedBy: 'made-up-reviewer' },
    { sourceMode: 'live', fictional: true }, { sourceMode: 'demo' },
  ]
  for (const provenance of invalid) {
    assert.throws(() => loadInventory([], [], AS_OF, 'Fixture', provenance, NOW), InventorySourceError)
    const malformed = { ...demo(), provenance } as InventorySnapshot
    assert.equal(inventoryIsQuotable(malformed, NOW), false)
    assert.equal(inventoryDemoDisclosure(malformed, NOW), null)
  }
})

test('demo metadata cannot refresh or disagree with the preserved source timestamp', () => {
  assert.throws(() => loadInventory([], [], NOW, 'Fixture', rawSource, NOW), InventorySourceError)
  assert.throws(() => validateInventoryProvenance(rawSource, AS_OF, new Date('2026-08-31T23:59:59Z')), InventorySourceError)
  const future = { ...rawSource, catalogAsOf: '2027-09-01T00:00:00.000Z' }
  assert.throws(() => loadInventory([], [], new Date(future.catalogAsOf), 'Fixture', future, NOW), InventorySourceError)
  assert.equal(inventoryIsQuotable(demo(), new Date('2026-08-31T23:59:59Z')), false)
})

test('loading detaches and freezes provenance and preserves its original source date', () => {
  const input = { ...rawSource }
  const readAt = new Date(AS_OF)
  const snapshot = loadInventory([], [], readAt, 'Fixture', input, NOW).snapshot
  input.catalogVersion = 'mutated'
  readAt.setUTCFullYear(2030)
  assert.deepEqual(snapshot.provenance, rawSource)
  assert.equal(snapshot.readAt.toISOString(), AS_OF.toISOString())
  assert.throws(() => { (snapshot.provenance as { catalogVersion: string }).catalogVersion = 'mutated' }, TypeError)
})

test('a demo declaration is rechecked at use rather than inferred from prior truthy metadata', () => {
  const snapshot = demo()
  snapshot.provenance = { sourceMode: 'live' }
  assert.equal(inventoryIsQuotable(snapshot, NOW), false)
  snapshot.provenance = { ...rawSource, fictional: false } as unknown as InventoryProvenance
  assert.equal(inventoryIsQuotable(snapshot, NOW), false)
})
