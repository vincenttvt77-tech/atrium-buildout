import { createHash, randomUUID } from 'node:crypto'
import { createAuthorizationService, AuthorizationError } from '../auth/index.ts'
import type { AuthenticatedUser, AuthorizedScope, Permission } from '../auth/index.ts'
import { DatabaseConnection, databasePoolConfig } from '../database/connection.ts'
import { DatabaseConfigurationError } from '../database/errors.ts'
import { isPostgresRuntime } from '../database/mode.ts'
import { PgAuthorizationRepository } from '../database/authorization.ts'
import { PostgresPropertyRepository } from '../database/properties.ts'
import { PostgresDocumentStore, PostgresCalendarStore, propertyCalendar } from '../database/operations.ts'
import { propertyTransaction } from '../database/scope.ts'
import { loadPublishedProperty, PropertyConfigurationError } from '../properties/index.ts'
import type { PropertySnapshot } from '../properties/index.ts'
import type { CalendarPort } from '../booking/types.ts'
import { validateSettings } from '../calendar/settings.ts'
import type { TourSettings } from '../calendar/settings.ts'
import { parseCookies, OPS_COOKIE } from '../ops/session.ts'

export { isPostgresRuntime } from '../database/mode.ts'
export { runWithPropertyRuntime, currentPropertyRuntime } from '../database/request.ts'
export interface PropertyResponseScope {
  organizationId: string
  propertyId: string
  configurationVersion: number
  permissionVersion: string
}
export interface ResolvedPropertyRuntime {
  readonly scope: AuthorizedScope
  readonly snapshot: PropertySnapshot
  readonly documents: PostgresDocumentStore
  readonly calendarStore: PostgresCalendarStore
  readonly tourSettings: TourSettings
  readonly assistantIds: string[]
  readonly bindingFingerprint: string
  readonly requestId: string
  readonly responseScope: PropertyResponseScope
  calendar(now: Date): CalendarPort
  /** Recheck after an external wait before returning property data. */
  revalidate(): Promise<void>
}
export class RuntimeRequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
type Headers = Record<string, string | string[] | undefined>
const header = (headers: Headers, key: string): string | undefined => {
  const value = headers[key]
  if (Array.isArray(value)) throw new RuntimeRequestError(400, 'ambiguous_property_scope', 'Use one property selection per request.')
  return value
}

export class DatabaseRuntime {
  readonly authorization: ReturnType<typeof createAuthorizationService>
  readonly sessionSecret: string
  readonly app: DatabaseConnection
  readonly auth: DatabaseConnection
  readonly properties: PostgresPropertyRepository
  constructor(options: {app: DatabaseConnection; auth: DatabaseConnection; sessionSecret: string}) {
    if (options.sessionSecret.trim().length < 32) throw new DatabaseConfigurationError()
    this.app = options.app; this.auth = options.auth; this.sessionSecret = options.sessionSecret
    this.authorization = createAuthorizationService(new PgAuthorizationRepository(options.auth))
    this.properties = new PostgresPropertyRepository(options.app)
  }
  authenticate(headers: Headers, now: Date): Promise<AuthenticatedUser | null> {
    return this.authorization.authenticateSession(parseCookies(headers.cookie)[OPS_COOKIE], now, this.sessionSecret)
  }
  async loadUserProperty(principal: AuthenticatedUser, selected: {organizationId: unknown; propertyId: unknown},
    permission: Permission, requestId: string = randomUUID()): Promise<ResolvedPropertyRuntime> {
    if (typeof selected.organizationId !== 'string' || typeof selected.propertyId !== 'string' || !selected.organizationId || !selected.propertyId) {
      throw new RuntimeRequestError(428, 'property_selection_required', 'Choose a property before opening this workspace.')
    }
    const scope = await this.authorization.authorizeProperty(principal, selected.propertyId, permission)
    if (scope.organizationId !== selected.organizationId) throw new AuthorizationError('forbidden')
    return this.resolve(scope, requestId, permission)
  }
  async loadChannel(provider: string, externalId: string, requestId: string = randomUUID()): Promise<ResolvedPropertyRuntime> {
    const scope = await this.authorization.authorizeChannel(provider, externalId, 'operate')
    return this.resolve(scope, requestId)
  }
  private async resolve(scope: AuthorizedScope, requestId: string, permission: Permission = 'operate'): Promise<ResolvedPropertyRuntime> {
    const snapshot = await loadPublishedProperty(this.properties, scope)
    let tourSettings: TourSettings
    try { tourSettings = validateSettings(snapshot.property.tourSettings) }
    catch { throw new PropertyConfigurationError('property_configuration_invalid', 'property.tourSettings') }
    const readBindings = () => propertyTransaction(this.app, scope, 'read', async client => {
      return (await client.query<{id:string; external_id:string; permission_version:string}>(
        `SELECT id,external_id,permission_version FROM atrium.channel_bindings
         WHERE organization_id=$1 AND property_id=$2 AND provider='vapi' AND status='active' ORDER BY id`,
      [scope.organizationId,scope.propertyId])).rows
    }, snapshot.version)
    const bindings = await readBindings()
    const fingerprint = (value: typeof bindings) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const bindingFingerprint = fingerprint(bindings)
    const attribution = {requestId, configurationVersion:snapshot.version}
    const documents = new PostgresDocumentStore(this.app, scope, attribution)
    const calendarStore = new PostgresCalendarStore(this.app, scope, attribution, permission === 'configure' ? 'configure' : 'operate')
    const responseScope = Object.freeze({organizationId:scope.organizationId, propertyId:scope.propertyId,
      configurationVersion:snapshot.version, permissionVersion:scope.permissionVersion})
    return Object.freeze({scope,snapshot,documents,calendarStore,tourSettings,requestId,responseScope,
      assistantIds:bindings.map(binding => binding.external_id),
      bindingFingerprint,
      revalidate:async () => {
        if (fingerprint(await readBindings()) !== bindingFingerprint) {
          throw new RuntimeRequestError(409, 'property_scope_mismatch', 'This property voice connection changed. Reload the workspace.')
        }
      },
      calendar:(now:Date) => propertyCalendar(calendarStore,scope,()=>now,{...tourSettings,timeZone:snapshot.timeZone,
        unitIds:snapshot.inventory.units.map(unit=>String(unit.unitId))}),
    })
  }
}

export function createDatabaseRuntime(options: {app:DatabaseConnection;auth:DatabaseConnection;sessionSecret:string}): DatabaseRuntime {
  return new DatabaseRuntime(options)
}
let cached: {key:string;runtime:DatabaseRuntime} | undefined
export function getDatabaseRuntime(env: NodeJS.ProcessEnv = process.env): DatabaseRuntime {
  if (!isPostgresRuntime(env)) throw new DatabaseConfigurationError()
  const secret = env.OPS_SESSION_SECRET ?? ''
  if (secret.trim().length < 32) throw new DatabaseConfigurationError()
  const appConfig = databasePoolConfig('atrium_app',env), authConfig = databasePoolConfig('atrium_authenticator',env)
  const key = JSON.stringify([appConfig,authConfig,secret])
  if (cached?.key === key) return cached.runtime
  if (cached) { void cached.runtime.app.close().catch(() => {}); void cached.runtime.auth.close().catch(() => {}) }
  const runtime = createDatabaseRuntime({app:new DatabaseConnection(appConfig,'atrium_app'),auth:new DatabaseConnection(authConfig,'atrium_authenticator'),sessionSecret:secret})
  cached = {key,runtime}
  return runtime
}
export function runtimeForRequest(req: any): DatabaseRuntime {
  if (req.atriumRuntime !== undefined) {
    if (!(req.atriumRuntime instanceof DatabaseRuntime)) throw new DatabaseConfigurationError()
    return req.atriumRuntime
  }
  return getDatabaseRuntime()
}
export async function resolveOpsRuntime(req: any, permission: Permission, now = new Date()): Promise<ResolvedPropertyRuntime> {
  const runtime = runtimeForRequest(req)
  const headers: Headers = req.headers ?? {}
  const principal = await runtime.authenticate(headers,now)
  if (!principal) throw new AuthorizationError('unauthenticated')
  const selected = {organizationId:header(headers,'x-atrium-organization-id'),propertyId:header(headers,'x-atrium-property-id')}
  const version = header(headers,'x-atrium-config-version')
  if (version === undefined) throw new RuntimeRequestError(428,'property_selection_required','Reload the property workspace before continuing.')
  if (!/^[1-9][0-9]{0,15}$/.test(version) || !Number.isSafeInteger(Number(version))) throw new RuntimeRequestError(400,'invalid_property_version','The property configuration version is invalid.')
  const resolved = await runtime.loadUserProperty(principal,selected,permission,req.atriumRequestId ?? randomUUID())
  if (resolved.snapshot.version !== Number(version)) throw new RuntimeRequestError(409,'property_configuration_changed','This property configuration changed. Reload the property workspace.')
  return resolved
}
export async function resolveVerifiedChannelRuntime(provider: string, externalId: string, _now: Date, requestId: string,
  injected?: DatabaseRuntime): Promise<ResolvedPropertyRuntime> {
  return (injected ?? getDatabaseRuntime()).loadChannel(provider,externalId,requestId)
}
export function readRuntimeError(error: unknown): {status:number;body:{error:string;code:string}} {
  if (error instanceof RuntimeRequestError) return {status:error.status,body:{error:error.message,code:error.code}}
  if (error instanceof AuthorizationError && error.code !== 'invalid_record') return {
    status:error.code === 'unauthenticated' ? 401 : 403,body:{error:error.message,code:error.code},
  }
  if (error instanceof Error && 'code' in error && error.code === 'property_configuration_changed') return {
    status:409,body:{error:'This property configuration changed. Reload the property workspace.',code:'property_configuration_changed'},
  }
  return {status:503,body:{error:'The property workspace is temporarily unavailable. Your request was not confirmed.',
    code:error instanceof PropertyConfigurationError ? error.code : 'workspace_unavailable'}}
}
