import type { InventorySnapshot, Unit, FloorPlan } from './types.ts'
import { validateInventoryProvenance } from './source.ts'

export interface LoadProblem {
  where: string
  problem: string
}

export interface LoadResult {
  snapshot: InventorySnapshot
  /** Records that failed validation and were excluded. Never silently dropped. */
  problems: LoadProblem[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function validFloorPlan(raw: unknown, i: number, problems: LoadProblem[]): FloorPlan | null {
  const p = raw as Partial<FloorPlan>
  const where = `floorPlans[${i}]${isStr(p?.id) ? ` (${p.id})` : ''}`
  if (!isStr(p?.id)) { problems.push({ where, problem: 'missing id' }); return null }
  if (!isNum(p.bedrooms) || !isNum(p.bathrooms) || !isNum(p.sqft)) {
    problems.push({ where, problem: 'bedrooms, bathrooms and sqft must all be numbers' })
    return null
  }
  return {
    id: p.id,
    name: isStr(p.name) ? p.name : p.id,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    sqft: p.sqft,
    description: isStr(p.description) ? p.description : '',
    features: Array.isArray(p.features) ? p.features.filter(isStr) : [],
    ...(Array.isArray(p.exposures) ? { exposures: p.exposures.filter(isStr) } : {}),
    ...(isStr(p.svgPath) ? { svgPath: p.svgPath } : {}),
  }
}

function validUnit(
  raw: unknown, i: number, plans: Map<string, FloorPlan>, problems: LoadProblem[],
): Unit | null {
  const u = raw as Partial<Unit>
  const where = `units[${i}]${isStr(u?.unitId) ? ` (${u.unitId})` : ''}`
  if (!isStr(u?.unitId)) { problems.push({ where, problem: 'missing unitId' }); return null }
  if (!isStr(u.floorPlanId) || !plans.has(u.floorPlanId)) {
    problems.push({ where, problem: `floorPlanId "${u.floorPlanId}" does not exist` })
    return null
  }
  if (!isNum(u.monthlyRent) || u.monthlyRent <= 0) {
    problems.push({ where, problem: 'monthlyRent must be a positive number' })
    return null
  }
  if (!isStr(u.availableFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(u.availableFrom) || Number.isNaN(Date.parse(u.availableFrom)) || new Date(u.availableFrom).toISOString().slice(0, 10) !== u.availableFrom) {
    problems.push({ where, problem: 'availableFrom must be an ISO date' })
    return null
  }

  const plan = plans.get(u.floorPlanId)!
  const beds = isNum(u.bedrooms) ? u.bedrooms : plan.bedrooms
  const baths = isNum(u.bathrooms) ? u.bathrooms : plan.bathrooms
  const sqft = isNum(u.sqft) ? u.sqft : plan.sqft

  // A unit that disagrees with its own floor plan is a data defect that would put a wrong
  // bedroom count in a prospect's ear. Surface it rather than picking a side silently.
  if (beds !== plan.bedrooms) {
    problems.push({ where, problem: `bedrooms ${beds} disagrees with plan ${plan.id} (${plan.bedrooms})` })
    return null
  }

  if (u.status !== undefined && !['available', 'pending', 'leased', 'off_market'].includes(u.status)) {
    problems.push({ where, problem: 'unknown inventory status' })
    return null
  }

  const status: Unit['status'] =
    u.status === 'pending' || u.status === 'leased' || u.status === 'off_market'
      ? u.status : 'available'

  return {
    unitId: u.unitId,
    floorPlanId: u.floorPlanId,
    floor: isNum(u.floor) ? u.floor : 0,
    bedrooms: beds,
    bathrooms: baths,
    sqft,
    monthlyRent: u.monthlyRent,
    availableFrom: u.availableFrom,
    status,
    ...(isStr(u.exposure) ? { exposure: u.exposure } : {}),
    ...(isStr(u.view) ? { view: u.view } : {}),
    ...(isStr(u.concession) ? { concession: u.concession } : {}),
    ...(Array.isArray(u.features) ? { features: u.features.filter(isStr) } : {}),
  }
}

/**
 * Builds a snapshot from raw parsed JSON, excluding anything that fails validation.
 *
 * Invalid records are excluded rather than coerced. A unit with an unparseable availability
 * date is not a unit the agent should be offering — better it does not exist than that it
 * gets offered with a date nobody can trust.
 */
export function loadInventory(
  rawUnits: unknown[], rawPlans: unknown[], readAt: Date, source: string,
  rawProvenance?: unknown, now = new Date(),
): LoadResult {
  const provenance = validateInventoryProvenance(rawProvenance, readAt, now)
  const problems: LoadProblem[] = []

  const floorPlans = rawPlans
    .map((p, i) => validFloorPlan(p, i, problems))
    .filter((p): p is FloorPlan => p !== null)

  const planMap = new Map(floorPlans.map((p) => [p.id, p]))

  const units = rawUnits
    .map((u, i) => validUnit(u, i, planMap, problems))
    .filter((u): u is Unit => u !== null)

  return { snapshot: { units, floorPlans, readAt: new Date(readAt), source,
    ...(provenance ? { provenance } : {}) }, problems }
}
