import type { PoolClient } from 'pg'
import { assertAuthorizedScope, AuthorizationError } from '../auth/index.ts'
import type { AuthorizedScope, Permission } from '../auth/index.ts'
import type { ResidentRecord } from '../residents/model.ts'
import { parseResidentDetails, residentContext, recordId, isoTimestamp } from '../residents/validation.ts'
import type { ResidentServicesRepository, ResidentListQuery, CaseListQuery, ServiceListQuery, ServiceCase,
  ServiceCaseDetail, ServiceEvent, ServiceCommand, ServiceReceipt, ServiceErrorCode } from '../maintenance/model.ts'
import type { ServiceLocation } from '../maintenance/model.ts'
import { ServiceError } from '../maintenance/model.ts'
import { parseServiceCommand, validateServiceListQuery, serviceStates } from '../maintenance/validation.ts'
import { detectEmergency } from '../escalation/emergency.ts'
import type { DatabaseConnection } from './connection.ts'
import { propertyTransaction } from './scope.ts'

type Row = Record<string, any>
const failure = (code: ServiceErrorCode = 'service_unavailable'): never => {
  throw new ServiceError(code, code === 'service_invalid_input' ? 'Review the service details and try again.' : 'Resident services could not verify this operation. Reload before trying again.')
}
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : failure()
const version = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : failure()
const identifier = (value: unknown): string => recordId(value) ? value : failure()
const uuid = (value: string): string | null => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value) ? value : null
function checkedCursor<T extends ServiceListQuery>(query: T): T {
  if (query.before && !uuid(query.before.id)) failure('service_invalid_input')
  return query
}
const time = (value: unknown): string => { try { return isoTimestamp(value) } catch { return failure() } }
const knownErrors: readonly ServiceErrorCode[] = ['service_invalid_input','service_not_found','service_version_conflict','service_request_conflict',
  'service_context_required','service_emergency_hold','service_unavailable']
const emergencyKinds = ['gas','smoke_or_fire','carbon_monoxide','flooding','no_heat','injury','intruder','structural']
function location(value: unknown, residentId: unknown = null): ServiceLocation {
  try {
    const parsed = parseServiceCommand({action:'update_context',requestId:'projection',id:'projection',expectedVersion:1,
      location:value,residentId,note:'Validated projection'})
    if (parsed.action === 'update_context') return parsed.location
  } catch { /* Invalid stored projection is unavailable, not a new user-input error. */ }
  return failure()
}

// One joined statement derives current planning readiness, without rewriting triage history.
const contextNeedsReview = `(c.state='ready_for_planning' AND (c.location_kind='unknown' OR
  (c.location_kind='unit' AND (NOT c.unit_id=ANY(p.unit_ids) OR (c.request_origin<>'staff_observation' AND
   (r.id IS NULL OR s.id IS NULL OR r.status='revoked' OR s.valid_until<=clock_timestamp()
    OR (clock_timestamp() AT TIME ZONE p.time_zone)::date<s.starts_on
    OR (s.ends_on IS NOT NULL AND (clock_timestamp() AT TIME ZONE p.time_zone)::date>=s.ends_on)))))))`
const caseFrom = `FROM atrium.service_cases c
  JOIN selected_service_property p ON p.organization_id=c.organization_id AND p.id=c.property_id
  LEFT JOIN atrium.property_residents r ON r.organization_id=c.organization_id AND r.property_id=c.property_id AND r.id=c.resident_id
  LEFT JOIN atrium.resident_sources s ON s.organization_id=r.organization_id AND s.property_id=r.property_id AND s.id=r.source_id`
const caseSelect = `WITH selected_service_property AS MATERIALIZED (
  SELECT p.organization_id,p.id,p.time_zone,ARRAY(SELECT u->>'unitId' FROM jsonb_array_elements(cfg.configuration->'inventory') u) AS unit_ids
  FROM atrium.properties p JOIN atrium.property_configurations cfg ON cfg.organization_id=p.organization_id AND cfg.property_id=p.id
    AND cfg.version=p.published_configuration_version AND cfg.status='published'
  WHERE p.organization_id=$1 AND p.id=$2
) SELECT atrium.service_case_json(c)||jsonb_build_object('contextNeedsReview',${contextNeedsReview}) AS value,
  r.version::text AS "residentRevision" ${caseFrom}`

/** Staff-only normalized records. No external dispatch, caller verification, or global person edits. */
export class PostgresResidentServicesRepository implements ResidentServicesRepository {
  private readonly connection: DatabaseConnection
  private readonly scope: AuthorizedScope
  private readonly configurationVersion: number
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: { configurationVersion: number; requestId?: string }) {
    assertAuthorizedScope(scope, 'operate')
    if (connection.role !== 'atrium_app') failure()
    if (scope.actor.kind !== 'user' || !scope.actor.sessionId) throw new AuthorizationError('forbidden')
    this.connection = connection; this.scope = scope; this.configurationVersion = version(attribution?.configurationVersion)
  }
  private async run<T>(permission: Permission, work: (client: PoolClient) => Promise<T>): Promise<T> {
    assertAuthorizedScope(this.scope, permission)
    if (this.scope.actor.kind !== 'user' || !this.scope.actor.sessionId) throw new AuthorizationError('forbidden')
    try { return await propertyTransaction(this.connection, this.scope, permission, work, this.configurationVersion) }
    catch (error) {
      if (error instanceof AuthorizationError || error instanceof ServiceError) throw error
      const raw = error as { code?: unknown; message?: unknown }
      if (raw.code === 'property_configuration_changed' || (raw.code === 'P0001' && raw.message === 'property_configuration_changed')) {
        throw Object.assign(new Error('Property configuration changed. Reload this workspace.'), { code: 'property_configuration_changed' })
      }
      if (raw.code === 'P0001' && raw.message === 'forbidden') throw new AuthorizationError('forbidden')
      if (raw.code === 'P0001' && knownErrors.includes(raw.message as ServiceErrorCode)) return failure(raw.message as ServiceErrorCode)
      return failure()
    }
  }
  private resident(value: unknown): ResidentRecord {
    const row = object(value)
    let details
    try { details = parseResidentDetails({ unitId: row.unitId, displayName: row.displayName, relationship: row.relationship,
      startsOn: row.startsOn, endsOn: row.endsOn, phone: row.phone, email: row.email, source: row.source }) } catch { return failure() }
    if (row.organizationId !== this.scope.organizationId || row.propertyId !== this.scope.propertyId
      || !['active','revoked'].includes(row.status) || !['current','expired','revoked','not_started','ended'].includes(row.contextState)) failure()
    return { ...details, id: identifier(row.id), personId: identifier(row.personId), organizationId: row.organizationId, propertyId: row.propertyId,
      status: row.status, version: version(row.version), createdAt: time(row.createdAt), updatedAt: time(row.updatedAt),
      reviewedBy: identifier(row.reviewedBy), reviewedAt: time(row.reviewedAt), contextState: row.contextState }
  }
  private request(value: unknown): ServiceCase {
    const row = object(value)
    let parsed
    try { parsed = parseServiceCommand({ action: 'create_request', requestId: 'projection', intake: {
      requestOrigin: row.requestOrigin, location: row.location, residentId: row.residentId, summary: row.summary, description: row.description,
      category: row.category, reportedPriority: row.reportedPriority, reporterName: row.reporterName, reporterPhone: row.reporterPhone,
      reporterEmail: row.reporterEmail, accessNotes: row.accessNotes } }) } catch { return failure() }
    if (parsed.action !== 'create_request') return failure()
    if (row.organizationId !== this.scope.organizationId || row.propertyId !== this.scope.propertyId
      || !serviceStates.includes(row.state) || !['routine','urgent','emergency'].includes(row.priority)
      || !Array.isArray(row.emergencyKinds) || row.emergencyKinds.length > 8 || row.emergencyKinds.some((kind: unknown) => !emergencyKinds.includes(kind as string))
      || new Set(row.emergencyKinds).size !== row.emergencyKinds.length || typeof row.contextNeedsReview !== 'boolean'
      || row.dispatchStatus !== 'not_dispatched' || row.notificationStatus !== 'not_sent' || row.callerIdentityVerified !== false || row.entryAuthorized !== false
      || (row.residentIdAtIntake === null ? row.residentVersionAtIntake !== null || row.residentNameAtIntake !== null
        : !recordId(row.residentIdAtIntake) || !Number.isSafeInteger(row.residentVersionAtIntake) || row.residentVersionAtIntake < 1
          || typeof row.residentNameAtIntake !== 'string' || row.residentNameAtIntake.length > 120)) failure()
    return { ...parsed.intake, id: identifier(row.id), organizationId: row.organizationId, propertyId: row.propertyId, version: version(row.version),
      state: row.state, priority: row.priority, emergencyKinds: [...row.emergencyKinds], createdAt: time(row.createdAt), updatedAt: time(row.updatedAt),
      createdBy: identifier(row.createdBy), intakeLocation:location(row.intakeLocation,row.residentIdAtIntake), residentIdAtIntake:row.residentIdAtIntake,
      residentVersionAtIntake: row.residentVersionAtIntake, residentNameAtIntake: row.residentNameAtIntake,
      dispatchStatus: 'not_dispatched', notificationStatus: 'not_sent', callerIdentityVerified: false, entryAuthorized: false,
      contextNeedsReview: row.contextNeedsReview }
  }
  private event(value: unknown): ServiceEvent {
    const row = object(value)
    if (!['intake','note','triage','context'].includes(row.kind) || !serviceStates.includes(row.state) || !['routine','urgent','emergency'].includes(row.priority)
      || typeof row.note !== 'string' || row.note.length > 4000
      || (row.contextResidentId === null ? row.contextResidentVersion !== null || row.contextResidentName !== null
        : !recordId(row.contextResidentId) || !Number.isSafeInteger(row.contextResidentVersion) || row.contextResidentVersion < 1
          || typeof row.contextResidentName !== 'string' || row.contextResidentName.length > 120)) failure()
    return { id: identifier(row.id), caseId: identifier(row.caseId), caseVersion: version(row.caseVersion), kind: row.kind,
      actorUserId: identifier(row.actorUserId), createdAt: time(row.createdAt), note: row.note, state: row.state, priority: row.priority,
      contextLocation:location(row.contextLocation,row.contextResidentId),contextResidentId:row.contextResidentId,
      contextResidentVersion:row.contextResidentVersion,contextResidentName:row.contextResidentName }
  }
  async listResidents(input: ResidentListQuery): Promise<ResidentRecord[]> {
    const query = checkedCursor(validateServiceListQuery(input, 'residents'))
    return this.run('operate', async client => (await client.query(`SELECT atrium.resident_json(r) AS value FROM atrium.property_residents r
      WHERE organization_id=$1 AND property_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      AND ($5::text IS NULL OR unit_id=$5) AND ($6::text IS NULL OR status=$6) ORDER BY created_at DESC,id DESC LIMIT $7`,
    [this.scope.organizationId,this.scope.propertyId,query.before?.createdAt ?? null,query.before?.id ?? null,query.unitId ?? null,query.status ?? null,query.limit])).rows.map(row => this.resident(row.value)))
  }
  async getResident(id: string): Promise<ResidentRecord | null> {
    if (!recordId(id)) failure('service_invalid_input')
    return this.run('operate', async client => this.residentOnClient(client,id))
  }
  private async residentOnClient(client: PoolClient, id: string): Promise<ResidentRecord | null> {
    const rows = (await client.query('SELECT atrium.resident_json(r) AS value FROM atrium.property_residents r WHERE organization_id=$1 AND property_id=$2 AND id=$3::uuid',
      [this.scope.organizationId,this.scope.propertyId,uuid(id)])).rows
    return rows.length ? this.resident(rows[0].value) : null
  }
  async listCases(input: CaseListQuery): Promise<ServiceCase[]> {
    const query = checkedCursor(validateServiceListQuery(input, 'cases'))
    return this.run('operate', async client => (await client.query(`${caseSelect}
      WHERE c.organization_id=$1 AND c.property_id=$2 AND ($3::timestamptz IS NULL OR (c.created_at,c.id)<($3::timestamptz,$4::uuid))
      AND ($5::text IS NULL OR c.unit_id=$5) AND ($6::text[] IS NULL OR c.state=ANY($6::text[]) OR ($7::boolean AND ${contextNeedsReview}))
      ORDER BY c.created_at DESC,c.id DESC LIMIT $8`,
    [this.scope.organizationId,this.scope.propertyId,query.before?.createdAt ?? null,query.before?.id ?? null,query.unitId ?? null,
      query.states ?? null,query.includeContextReview ?? false,query.limit])).rows.map(row => this.request(row.value)))
  }
  private async eventsOnClient(client: PoolClient, id: string, query: ServiceListQuery): Promise<ServiceEvent[]> {
    return (await client.query(`SELECT atrium.service_event_json(e) AS value FROM atrium.service_events e
      WHERE organization_id=$1 AND property_id=$2 AND case_id=$3::uuid AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $6`,[this.scope.organizationId,this.scope.propertyId,uuid(id),query.before?.createdAt ?? null,query.before?.id ?? null,query.limit])).rows.map(row => this.event(row.value))
  }
  async listEvents(id: string, input: ServiceListQuery): Promise<ServiceEvent[]> {
    if (!recordId(id)) failure('service_invalid_input')
    const query = checkedCursor(validateServiceListQuery(input,'events'))
    return this.run('operate',client=>this.eventsOnClient(client,id,query))
  }
  async getCase(id: string): Promise<ServiceCaseDetail | null> {
    if (!recordId(id)) failure('service_invalid_input')
    return this.run('operate', async client => {
      const rows = (await client.query(`${caseSelect} WHERE c.organization_id=$1 AND c.property_id=$2 AND c.id=$3::uuid`,
        [this.scope.organizationId,this.scope.propertyId,uuid(id)])).rows
      if (!rows.length) return null
      const request = this.request(rows[0].value)
      const resident = residentContext(request.residentId ? await this.residentOnClient(client,request.residentId) : null)
      const foundEvents = await this.eventsOnClient(client,id,{limit:26}), events = foundEvents.slice(0,25)
      const related = request.location.kind === 'unit' ? (await client.query(`SELECT id,summary,state,priority,atrium.service_iso(created_at) AS "createdAt"
        FROM atrium.service_cases WHERE organization_id=$1 AND property_id=$2 AND unit_id=$3 AND id<>$4::uuid ORDER BY created_at DESC,id DESC LIMIT 11`,
      [this.scope.organizationId,this.scope.propertyId,request.location.unitId,id])).rows : []
      // READ COMMITTED permits each statement to see a newer snapshot. Refuse a
      // mixed detail/history rather than present a previous location with later events.
      const final = (await client.query(`${caseSelect} WHERE c.organization_id=$1 AND c.property_id=$2 AND c.id=$3::uuid`,
        [this.scope.organizationId,this.scope.propertyId,uuid(id)])).rows[0]
      if (!final || final.value.version !== request.version || final.residentRevision !== rows[0].residentRevision
        || final.value.contextNeedsReview !== request.contextNeedsReview) failure('service_version_conflict')
      return { request, resident, events, eventsTruncated: foundEvents.length > 25,
        nextEventsCursor: foundEvents.length > 25 ? {createdAt:events.at(-1)!.createdAt,id:events.at(-1)!.id} : null,
        related: related.slice(0,10).map(row=>({id:identifier(row.id),summary:row.summary,state:row.state,priority:row.priority,createdAt:time(row.createdAt)})),
        relatedTruncated:related.length>10 }
    })
  }
  async execute(input: ServiceCommand): Promise<ServiceReceipt> {
    const command = parseServiceCommand(input)
    const permission = ['add_resident','review_resident','revoke_resident'].includes(command.action) ? 'configure' : 'operate'
    const text = command.action === 'create_request' ? [command.intake.summary,command.intake.description,command.intake.accessNotes].join('\n')
      : command.action === 'add_note' || command.action === 'triage_request' || command.action === 'update_context' ? command.note : ''
    const kinds = detectEmergency(text).map(signal=>signal.kind)
    return this.run(permission,async client=>{
      const row = object((await client.query('SELECT atrium.execute_resident_service($1::jsonb,$2::bigint,$3::text[]) AS value',
        [JSON.stringify(command),this.configurationVersion,kinds])).rows[0]?.value)
      if (row.requestId !== command.requestId || row.action !== command.action || row.resource !== (permission === 'configure' ? 'resident' : 'request')
        || typeof row.replayed !== 'boolean' || ('id' in command && row.id !== command.id)
        || row.version !== ('expectedVersion' in command ? command.expectedVersion+1 : 1)) failure()
      return { requestId:row.requestId,action:command.action,resource:row.resource,id:identifier(row.id),version:version(row.version),
        committedAt:time(row.committedAt),replayed:row.replayed }
    })
  }
}
