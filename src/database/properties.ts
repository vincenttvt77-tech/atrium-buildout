import type { AuthorizedScope } from '../auth/index.ts'
import { PropertyConfigurationError } from '../properties/index.ts'
import type { PropertyBundle, PropertyRepository, PublishedPropertyConfiguration } from '../properties/index.ts'
import type { DatabaseConnection } from './connection.ts'
import { propertyTransaction } from './scope.ts'

type Row = Record<string, unknown>
function invalid(field: string): never { throw new PropertyConfigurationError('property_configuration_invalid', field) }
function text(value: unknown, field: string): string { return typeof value === 'string' ? value : invalid(field) }
function version(value: unknown): number {
  const number = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) invalid('version')
  if (typeof value === 'string' && String(number) !== value) invalid('version')
  return number
}
function timestamp(value: unknown, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(field)
  return value.toISOString()
}

/** Read only: publication belongs to an explicitly authorized configuration workflow. */
export class PostgresPropertyRepository implements PropertyRepository {
  private connection: DatabaseConnection
  constructor(connection: DatabaseConnection) {
    if (connection.role !== 'atrium_app') throw new Error('Property configuration reads require the application database role.')
    this.connection = connection
  }

  async getPublishedConfiguration(scope: AuthorizedScope): Promise<PublishedPropertyConfiguration | null> {
    // The runtime provenance check and current DB permission check precede every read.
    return propertyTransaction(this.connection, scope, 'read', async client => {
      // One statement observes the pointer and its immutable content together; selecting
      // MAX(version) would accidentally expose a draft or an unpublished future version.
      const result = await client.query<Row>(`
        SELECT p.organization_id, p.id AS property_id, p.time_zone,
               c.version, c.schema_version, c.configuration, c.published_at,
               c.inventory_read_at, c.inventory_source
        FROM atrium.properties p
        JOIN atrium.property_configurations c
          ON c.organization_id = p.organization_id AND c.property_id = p.id
         AND c.version = p.published_configuration_version
        WHERE p.organization_id = $1 AND p.id = $2 AND c.status = 'published'
      `, [scope.organizationId, scope.propertyId])
      if (result.rows.length > 1) invalid('published_configuration')
      const row = result.rows[0]
      if (!row) return null
      if (row.schema_version !== 1) invalid('schemaVersion')
      return {
        organizationId: text(row.organization_id, 'organizationId'),
        propertyId: text(row.property_id, 'propertyId'),
        version: version(row.version), timeZone: text(row.time_zone, 'timeZone'),
        publishedAt: timestamp(row.published_at, 'publishedAt'),
        // Preserve the source read time; the application query time is not freshness.
        inventoryReadAt: timestamp(row.inventory_read_at, 'inventoryReadAt'),
        inventorySource: text(row.inventory_source, 'inventorySource'),
        bundle: row.configuration as PropertyBundle,
      }
    })
  }
}
