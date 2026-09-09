import type { AuthorizedScope } from '../auth/index.ts'
import type { InventorySnapshot } from '../inventory/types.ts'
import type { KnowledgeArticle } from '../knowledge/article.ts'

/** Published content only. Credentials and connector secrets belong in a separate repository. */
export interface PropertyBundle {
  property: Record<string, unknown>
  inventory: unknown[]
  floorplans: unknown[]
  knowledge: unknown[]
}

/** The adapter reads timeZone from the property row, not from the configuration JSON. */
export interface PublishedPropertyConfiguration {
  organizationId: string
  propertyId: string
  version: number
  timeZone: string
  publishedAt: string
  inventoryReadAt: string
  inventorySource: string
  bundle: PropertyBundle
}

/**
 * A DB adapter must select the current published version under the supplied scope and
 * recheck current authority in its transaction. No default-property or fixture fallback.
 */
export interface PropertyRepository {
  getPublishedConfiguration(scope: AuthorizedScope): Promise<PublishedPropertyConfiguration | null>
}

export interface PropertySnapshot {
  readonly organizationId: string
  readonly propertyId: string
  readonly version: number
  readonly timeZone: string
  readonly jurisdiction: string
  readonly publishedAt: string
  readonly inventoryReadAt: string
  readonly inventorySource: string
  /** Deeply frozen copies of the validated JSON, retained for explicit server projections. */
  readonly bundle: PropertyBundle
  readonly property: Record<string, unknown>
  /** Parsed values are detached on access, including mutable Date instances. */
  readonly inventory: InventorySnapshot
  readonly articles: KnowledgeArticle[]
}

export class PropertyConfigurationError extends Error {
  readonly code: 'property_configuration_missing' | 'property_configuration_invalid'
  readonly field: string | undefined
  constructor(code: PropertyConfigurationError['code'], field?: string) {
    super(code === 'property_configuration_missing'
      ? 'This property does not have a published configuration.'
      : `The published property configuration is invalid${field ? ` (${field})` : ''}.`)
    this.name = 'PropertyConfigurationError'
    this.code = code
    this.field = field
  }
}
