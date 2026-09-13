import type { InventoryProvenance, InventorySnapshot } from './types.ts'

export class InventorySourceError extends Error {
  readonly code = 'inventory_source_invalid'
  constructor() {
    super('Inventory source metadata is invalid.')
    this.name = 'InventorySourceError'
  }
}

function invalid(): never { throw new InventorySourceError() }

/** Validate source declarations without deriving them from names, request data or age. */
export function validateInventoryProvenance(
  value: unknown, readAt: Date, now = new Date(),
): InventoryProvenance | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (input.sourceMode === 'live') {
    if (Object.keys(input).some(key => key !== 'sourceMode')) return invalid()
    return Object.freeze({ sourceMode: 'live' })
  }
  if (input.sourceMode !== 'demo' || input.fictional !== true
    || Object.keys(input).some(key => !['sourceMode', 'catalogAsOf', 'catalogVersion', 'fictional'].includes(key))) return invalid()
  if (typeof input.catalogVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.catalogVersion)) return invalid()
  if (typeof input.catalogAsOf !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.catalogAsOf)) return invalid()
  const asOf = new Date(input.catalogAsOf)
  if (!Number.isFinite(asOf.getTime())
    || asOf.toISOString().replace('.000Z', 'Z') !== input.catalogAsOf.replace('.000Z', 'Z')
    || !(readAt instanceof Date) || asOf.getTime() !== readAt.getTime()
    || !Number.isFinite(now.getTime()) || asOf > now) return invalid()
  return Object.freeze({ sourceMode: 'demo', catalogAsOf: asOf.toISOString(),
    catalogVersion: input.catalogVersion, fictional: true })
}

/** Actual source freshness, including for demo snapshots. This never exempts old data. */
export function inventoryIsFresh(snapshot: InventorySnapshot, now: Date, maxAgeMs = 15 * 60_000): boolean {
  const age = now.getTime() - snapshot.readAt.getTime()
  return Number.isFinite(age) && age >= 0 && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && age <= maxAgeMs
}

/** A dated fictional catalogue may support sample quotes; live quotes require freshness. */
export function inventoryIsQuotable(snapshot: InventorySnapshot, now: Date, maxAgeMs = 15 * 60_000): boolean {
  let provenance: InventoryProvenance | undefined
  try { provenance = validateInventoryProvenance(snapshot.provenance, snapshot.readAt, now) }
  catch { return false }
  if (provenance?.sourceMode === 'demo') return true
  return inventoryIsFresh(snapshot, now, maxAgeMs)
}

/** Prefix sample prices and dates with their actual scope; never describe them as live. */
export function inventoryDemoDisclosure(snapshot: InventorySnapshot, now = new Date()): string | null {
  let provenance: InventoryProvenance | undefined
  try { provenance = validateInventoryProvenance(snapshot.provenance, snapshot.readAt, now) }
  catch { return null }
  if (provenance?.sourceMode !== 'demo') return null
  const date = new Date(provenance.catalogAsOf).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
  return `[Inventory source: fictional demo catalogue; as of ${date}; version ${provenance.catalogVersion}; sample rents, concessions and availability only, never live/PMS data. Internal metadata, do not read aloud. Briefly frame answers as "In this demo" or "sample availability"; do not recite catalogue date/version.]`
}
