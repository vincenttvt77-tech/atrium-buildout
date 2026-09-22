import { assertAuthorizedScope } from '../auth/index.ts'
import type { AuthorizedScope } from '../auth/index.ts'
import { validateTimeZone } from '../calendar/time.ts'
import { loadInventory } from '../inventory/load.ts'
import { validateInventoryProvenance } from '../inventory/source.ts'
import type { KnowledgeArticle } from '../knowledge/article.ts'
import { PropertyConfigurationError } from './model.ts'
import type { PropertyBundle, PropertyRepository, PropertySnapshot, PublishedPropertyConfiguration } from './model.ts'

const snapshots = new WeakSet<object>()
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const JURISDICTION = /^[A-Z]{2}(?:-[A-Z0-9]{1,12}){0,3}$/
const TOPICS = new Set(['pet_policy', 'parking', 'amenities', 'hours', 'utilities',
  'application_requirements', 'building_access', 'move_logistics', 'general_property_fact'])
const STATUSES = new Set(['draft', 'in_review', 'published', 'retired'])

function invalid(field: string): never { throw new PropertyConfigurationError('property_configuration_invalid', field) }
const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
const prose = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function instant(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid(field)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) invalid(field)
  return date
}

/** Keep configuration JSON predictable; reject non-JSON values instead of dropping them. */
function cloneJson(value: unknown, field: string, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || !value || depth > 32 || ancestors.has(value)) return invalid(field)
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid(field)
  ancestors.add(value)
  const result: unknown = Array.isArray(value)
    ? value.map((item, i) => cloneJson(item, `${field}[${i}]`, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${field}.${key}`, ancestors, depth + 1)]))
  ancestors.delete(value)
  return result
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

function ownership(value: Record<string, unknown>, scope: AuthorizedScope, field: string): void {
  if (Object.hasOwn(value, 'organizationId') && value.organizationId !== scope.organizationId) invalid(`${field}.organizationId`)
  if (Object.hasOwn(value, 'propertyId') && value.propertyId !== scope.propertyId) invalid(`${field}.propertyId`)
  if (Object.hasOwn(value, 'sourceId') && !id(value.sourceId)) invalid(`${field}.sourceId`)
}

function rows(value: unknown, field: string, scope: AuthorizedScope): Record<string, unknown>[] {
  if (!Array.isArray(value)) invalid(field)
  return value.map((entry, i) => {
    if (!record(entry)) invalid(`${field}[${i}]`)
    ownership(entry, scope, `${field}[${i}]`)
    return entry
  })
}

function unique(rows: Record<string, unknown>[], key: string, field: string, normalize = (value: string) => value): void {
  const seen = new Set<string>()
  for (const [i, row] of rows.entries()) {
    const value = row[key]
    if (!id(value) || seen.has(normalize(value))) invalid(`${field}[${i}].${key}`)
    seen.add(normalize(value))
  }
}

function strings(value: unknown, field: string, check: (item: unknown) => boolean): string[] {
  if (!Array.isArray(value) || value.some(item => !check(item)) || new Set(value).size !== value.length) invalid(field)
  return value as string[]
}

function article(raw: Record<string, unknown>, index: number, scope: AuthorizedScope, publishedAt: Date): KnowledgeArticle {
  const field = `bundle.knowledge[${index}]`
  if (typeof raw.topic !== 'string' || !TOPICS.has(raw.topic)) invalid(`${field}.topic`)
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) invalid(`${field}.status`)
  if (!version(raw.version)) invalid(`${field}.version`)
  for (const key of ['question', 'answer', 'source']) if (!prose(raw[key])) invalid(`${field}.${key}`)
  if (!id(raw.ownerId)) invalid(`${field}.ownerId`)
  if (raw.approvedBy !== null && !id(raw.approvedBy)) invalid(`${field}.approvedBy`)
  const propertyScope = strings(raw.propertyScope, `${field}.propertyScope`, id)
  // Portfolio-wide articles remain bounded by this repository's organization. A scoped
  // bundle must not smuggle another building's IDs into a serving context.
  if (propertyScope.some(value => value !== scope.propertyId)) invalid(`${field}.propertyScope`)
  strings(raw.jurisdictionScope, `${field}.jurisdictionScope`, value => typeof value === 'string' && JURISDICTION.test(value))
  const approvedAt = raw.approvedAt === null ? null : instant(raw.approvedAt, `${field}.approvedAt`)
  const reviewBy = instant(raw.reviewBy, `${field}.reviewBy`)
  if ((raw.approvedBy === null) !== (approvedAt === null)) invalid(`${field}.approvedAt`)
  if (approvedAt && approvedAt > publishedAt) invalid(`${field}.approvedAt`)
  if (raw.status === 'published' && (!approvedAt || raw.approvedBy === null)) invalid(`${field}.approvedBy`)
  if (raw.keywords !== undefined) strings(raw.keywords, `${field}.keywords`, text)
  // Expired, retired and in-review articles stay identifiable. Existing isServable()
  // applies publication, approval, property, jurisdiction and review-date gates.
  return { ...raw, approvedAt, reviewBy } as unknown as KnowledgeArticle
}

/** Validate without coercing ownership, fixing IDs, publishing knowledge or refreshing data. */
export function validatePublishedProperty(
  value: PublishedPropertyConfiguration, scope: AuthorizedScope, now = new Date(),
): PropertySnapshot {
  assertAuthorizedScope(scope, 'read')
  if (!record(value)) invalid('configuration')
  if (value.organizationId !== scope.organizationId) invalid('organizationId')
  if (value.propertyId !== scope.propertyId) invalid('propertyId')
  if (!version(value.version)) invalid('version')
  if (!Number.isFinite(now.getTime())) invalid('now')
  const publishedAt = instant(value.publishedAt, 'publishedAt')
  const inventoryReadAt = instant(value.inventoryReadAt, 'inventoryReadAt')
  if (publishedAt > now) invalid('publishedAt')
  if (inventoryReadAt > publishedAt) invalid('inventoryReadAt')
  if (!text(value.inventorySource)) invalid('inventorySource')
  const bundle = cloneJson(value.bundle, 'bundle') as PropertyBundle
  if (!record(bundle) || !record(bundle.property)) invalid('bundle.property')
  ownership(bundle.property, scope, 'bundle.property')
  if (bundle.property.id !== scope.propertyId) invalid('bundle.property.id')
  if (!text(bundle.property.buildingName)) invalid('bundle.property.buildingName')
  if (Object.hasOwn(bundle.property, 'tourCapacityPerSlot') && (typeof bundle.property.tourCapacityPerSlot !== 'number'
    || !Number.isInteger(bundle.property.tourCapacityPerSlot) || bundle.property.tourCapacityPerSlot < 1
    || bundle.property.tourCapacityPerSlot > 50)) invalid('bundle.property.tourCapacityPerSlot')
  const jurisdiction = bundle.property.jurisdiction
  if (typeof jurisdiction !== 'string' || !JURISDICTION.test(jurisdiction)) invalid('bundle.property.jurisdiction')
  let timeZone: string
  try {
    timeZone = validateTimeZone(value.timeZone)
    if (!Object.hasOwn(bundle.property, 'timeZone') || validateTimeZone(bundle.property.timeZone) !== timeZone) invalid('bundle.property.timeZone')
  } catch { return invalid('timeZone') }
  const units = rows(bundle.inventory, 'bundle.inventory', scope)
  const plans = rows(bundle.floorplans, 'bundle.floorplans', scope)
  const knowledge = rows(bundle.knowledge, 'bundle.knowledge', scope)
  unique(units, 'unitId', 'bundle.inventory', value => value.toUpperCase())
  unique(plans, 'id', 'bundle.floorplans')
  unique(knowledge, 'id', 'bundle.knowledge')
  try { validateInventoryProvenance(bundle.inventoryProvenance, inventoryReadAt, publishedAt) }
  catch { return invalid('bundle.inventoryProvenance') }
  const inventory = loadInventory(units, plans, inventoryReadAt, value.inventorySource, bundle.inventoryProvenance, now)
  // The fixture loader excludes invalid records; a published customer configuration
  // cannot quietly turn a defective inventory into an empty or partial building.
  if (inventory.problems.length) invalid(`inventory:${inventory.problems[0]!.where}`)
  const articles = knowledge.map((item, index) => article(item, index, scope, publishedAt))
  freezeJson(bundle)
  const snapshot: PropertySnapshot = Object.freeze({
    organizationId: scope.organizationId, propertyId: scope.propertyId, version: value.version,
    timeZone, jurisdiction, publishedAt: publishedAt.toISOString(),
    inventoryReadAt: inventoryReadAt.toISOString(), inventorySource: value.inventorySource,
    bundle, property: bundle.property,
    get inventory() { return structuredClone(inventory.snapshot) },
    get articles() { return structuredClone(articles) },
  })
  snapshots.add(snapshot)
  return snapshot
}

export function assertPropertySnapshot(value: unknown, scope: AuthorizedScope): asserts value is PropertySnapshot {
  assertAuthorizedScope(scope, 'read')
  if (!value || typeof value !== 'object' || !snapshots.has(value)) invalid('snapshot')
  const snapshot = value as PropertySnapshot
  if (snapshot.organizationId !== scope.organizationId || snapshot.propertyId !== scope.propertyId) invalid('snapshot.scope')
}

export async function loadPublishedProperty(repository: PropertyRepository, scope: AuthorizedScope, now = new Date()): Promise<PropertySnapshot> {
  assertAuthorizedScope(scope, 'read')
  const configuration = await repository.getPublishedConfiguration(scope)
  if (configuration === null) throw new PropertyConfigurationError('property_configuration_missing')
  return validatePublishedProperty(configuration, scope, now)
}
