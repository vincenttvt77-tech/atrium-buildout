export interface FloorPlan {
  id: string
  name: string
  bedrooms: number
  bathrooms: number
  sqft: number
  description: string
  features: string[]
  exposures?: string[]
  svgPath?: string
}

export type UnitStatus = 'available' | 'pending' | 'leased' | 'off_market'

export interface Unit {
  unitId: string
  floorPlanId: string
  floor: number
  bedrooms: number
  bathrooms: number
  sqft: number
  monthlyRent: number
  /** ISO date. A unit is not offerable before this date. */
  availableFrom: string
  exposure?: string
  view?: string
  status: UnitStatus
  concession?: string | null
  features?: string[]
}

/** Server-owned source metadata. Demo catalogues never establish live availability. */
export type InventoryProvenance =
  | { readonly sourceMode: 'live' }
  | { readonly sourceMode: 'demo'; readonly catalogAsOf: string; readonly catalogVersion: string; readonly fictional: true }

/**
 * Inventory as read from the source of record, stamped with when it was read.
 *
 * The stamp is not decoration. SOW 6.2 requires the agent never claim an option it cannot
 * verify, and an inventory snapshot with no read time cannot be reasoned about — the agent
 * has no way to know whether it is quoting something that was true an hour ago or a week ago.
 */
export interface InventorySnapshot {
  units: Unit[]
  floorPlans: FloorPlan[]
  readAt: Date
  source: string
  /** Omitted metadata retains the strict live-source freshness rule. */
  provenance?: InventoryProvenance
}
