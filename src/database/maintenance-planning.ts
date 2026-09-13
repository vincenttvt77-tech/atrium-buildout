import type { PoolClient } from 'pg'
import { assertAuthorizedScope, AuthorizationError } from '../auth/index.ts'
import type { AuthorizedScope, Permission, Role } from '../auth/index.ts'
import type { DatabaseConnection } from './connection.ts'
import { propertyTransaction, assertCurrentPropertyAccess } from './scope.ts'
import type { MaintenancePlanningRepository, MaintenancePlanningCommand, MaintenancePlanningReceipt, MaintenancePolicy, MaintenanceVendor,
  MaintenancePlan, MaintenanceDecision, MaintenancePlanDetail, MaintenancePlanHistoryEntry, MaintenancePlanningOverview, MaintenancePlanningErrorCode,
  MaintenanceInboxQuery, MaintenanceInboxPage, MaintenanceInboxItem } from '../maintenance/planning-model.ts'
import { MaintenancePlanningError } from '../maintenance/planning-model.ts'
import { parsePlanningCommand, parsePolicyDetails, parseVendorDetails, parsePlanDetails } from '../maintenance/planning-validation.ts'
import { evaluateMaintenancePlan } from '../maintenance/authority.ts'
import { validateMaintenanceInboxQuery, projectMaintenanceInboxItem, canDecideMaintenancePlan, maintenanceInboxScanLimit } from '../maintenance/planning-inbox.ts'
import type { MaintenanceInboxActor } from '../maintenance/planning-inbox.ts'
import { parseServiceCommand, validateServiceListQuery, serviceStates } from '../maintenance/validation.ts'
import type { ServiceCase, ServiceCursor } from '../maintenance/model.ts'
import { parseResidentDetails, recordId, isoTimestamp } from '../residents/validation.ts'
import type { ResidentContext } from '../residents/model.ts'

type Row = Record<string, any>
const bad = (code: MaintenancePlanningErrorCode = 'planning_unavailable'): never => {
  throw new MaintenancePlanningError(code, 'The maintenance plan could not be verified. Reload the current details before trying again.')
}
const obj = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : bad()
const ver = (v: unknown): number => Number.isSafeInteger(v) && Number(v)>0 ? Number(v) : bad()
const id = (v: unknown): string => recordId(v) ? v : bad()
const uuid = (v: unknown): v is string => typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)
const date = (v: unknown): string => { try { return isoTimestamp(v) } catch { return bad() } }
const emergencyKinds = ['gas','smoke_or_fire','carbon_monoxide','flooding','no_heat','injury','intruder','structural']
const hazards = (v: unknown): MaintenancePlan['emergencyKinds'] => {
  if (!Array.isArray(v) || v.length>8 || v.some(k=>!emergencyKinds.includes(k)) || new Set(v).size!==v.length) return bad()
  return [...v]
}
const errors: MaintenancePlanningErrorCode[] = ['planning_invalid_input','planning_not_found','planning_version_conflict','planning_request_conflict','planning_not_ready','planning_mfa_required','planning_unavailable']
const currentCase = `jsonb_build_object('contextNeedsReview',c.state='ready_for_planning' AND (c.location_kind='unknown' OR (c.location_kind='unit' AND
  (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.configuration->'inventory') u WHERE u->>'unitId'=c.unit_id)
    OR (c.request_origin<>'staff_observation' AND (r.id IS NULL OR atrium.resident_context_state(r) IS DISTINCT FROM 'current'))))))`
const dataQuery = `SELECT atrium.service_case_json(c)||${currentCase} AS request,
 CASE WHEN r.id IS NULL THEN NULL ELSE atrium.resident_json(r) END AS resident,
 CASE WHEN pol.version IS NULL THEN NULL ELSE atrium.maintenance_policy_json(pol) END AS policy,
 CASE WHEN pl.id IS NULL THEN NULL ELSE atrium.maintenance_plan_json(pl) END AS plan,
 CASE WHEN v.id IS NULL THEN NULL ELSE atrium.maintenance_vendor_json(v) END AS vendor,
 CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'planId',d.plan_id,'planVersion',d.plan_version,
  'decision',d.decision,'actorUserId',d.actor_user_id,'actorRole',d.actor_role,'reason',d.reason,'decidedAt',atrium.service_iso(d.decided_at))
  ||atrium.maintenance_decision_authority(d.id) END AS decision,
 atrium.maintenance_actor_role() AS role,atrium.can_access_property($1,$2,'configure') AS configure,
 atrium.service_iso(clock_timestamp()) AS now
 FROM atrium.service_cases c JOIN atrium.properties prop ON prop.organization_id=c.organization_id AND prop.id=c.property_id
 JOIN atrium.property_configurations cfg ON cfg.organization_id=prop.organization_id AND cfg.property_id=prop.id AND cfg.version=prop.published_configuration_version AND cfg.status='published'
 LEFT JOIN atrium.property_residents r ON r.organization_id=c.organization_id AND r.property_id=c.property_id AND r.id=c.resident_id
 LEFT JOIN LATERAL(SELECT * FROM atrium.maintenance_policies WHERE organization_id=c.organization_id AND property_id=c.property_id ORDER BY version DESC LIMIT 1) pol ON true
 LEFT JOIN LATERAL(SELECT * FROM atrium.maintenance_plans WHERE organization_id=c.organization_id AND property_id=c.property_id AND case_id=c.id ORDER BY version DESC LIMIT 1) pl ON true
 LEFT JOIN LATERAL(SELECT * FROM atrium.maintenance_vendors WHERE organization_id=c.organization_id AND property_id=c.property_id AND id=pl.vendor_id ORDER BY version DESC LIMIT 1) v ON true
 LEFT JOIN atrium.maintenance_decisions d ON d.organization_id=pl.organization_id AND d.property_id=pl.property_id AND d.plan_id=pl.id AND d.plan_version=pl.version
 WHERE c.organization_id=$1 AND c.property_id=$2 AND c.id=$3::uuid`

// This is a bounded candidate scan, not a prefiltered result page. Common facts and
// each distinct approver are resolved once; no per-case history or authorization RPC.
const inboxQuery = `WITH inbox_clock AS MATERIALIZED (SELECT clock_timestamp() AS stamp),
 inbox_property AS MATERIALIZED (
  SELECT p.organization_id,p.id,p.time_zone,p.published_configuration_version,
   ARRAY(SELECT u->>'unitId' FROM jsonb_array_elements(cfg.configuration->'inventory') u) AS unit_ids
  FROM atrium.properties p JOIN atrium.property_configurations cfg ON cfg.organization_id=p.organization_id AND cfg.property_id=p.id
   AND cfg.version=p.published_configuration_version AND cfg.status='published' WHERE p.organization_id=$1 AND p.id=$2
 ), inbox_common AS MATERIALIZED (
  SELECT p.*,atrium.maintenance_actor_role() AS role,atrium.can_access_property($1,$2,'configure') AS configure,
   (SELECT atrium.maintenance_policy_json(pol) FROM atrium.maintenance_policies pol WHERE organization_id=$1 AND property_id=$2 ORDER BY version DESC LIMIT 1) AS policy
  FROM inbox_property p
 ), inbox_cases AS MATERIALIZED (
  SELECT c.* FROM atrium.service_cases c WHERE c.organization_id=$1 AND c.property_id=$2
   AND ($5::text IS NULL OR c.unit_id=$5)
   AND (($7::uuid[] IS NULL AND ($3::timestamptz IS NULL OR (c.created_at,c.id)<($3::timestamptz,$4::uuid))) OR c.id=ANY($7::uuid[]))
  ORDER BY c.created_at DESC,c.id DESC LIMIT $6
 ), inbox_plans AS MATERIALIZED (
  SELECT c.id AS candidate_id,pl::atrium.maintenance_plans AS plan_record,pl.id,pl.version,pl.organization_id,pl.property_id,pl.vendor_id
  FROM inbox_cases c LEFT JOIN LATERAL(
   SELECT p.* FROM atrium.maintenance_plans p WHERE p.organization_id=$1 AND p.property_id=$2 AND p.case_id=c.id ORDER BY p.version DESC LIMIT 1
  ) pl ON true
 ), inbox_decisions AS MATERIALIZED (
  SELECT d.* FROM atrium.maintenance_decisions d JOIN inbox_plans pl ON pl.organization_id=d.organization_id AND pl.property_id=d.property_id AND pl.id=d.plan_id AND pl.version=d.plan_version
  WHERE d.organization_id=$1 AND d.property_id=$2
 ), inbox_representatives AS MATERIALIZED (
  SELECT DISTINCT ON(actor_user_id) actor_user_id,id FROM inbox_decisions ORDER BY actor_user_id,id
 ), inbox_approvers AS MATERIALIZED (
  SELECT actor_user_id,atrium.maintenance_decision_authority(id) AS authority FROM inbox_representatives
 ), inbox_residents AS MATERIALIZED (
  SELECT r.id,r.version,r.unit_id,r.status,r.source_id,s.display_name,s.starts_on,s.ends_on,s.valid_until,
   s.starts_on::timestamp AT TIME ZONE p.time_zone AS starts_at,s.ends_on::timestamp AT TIME ZONE p.time_zone AS ends_at,
   CASE WHEN r.status='revoked' THEN 'revoked' WHEN (t.stamp AT TIME ZONE p.time_zone)::date<s.starts_on THEN 'not_started'
    WHEN s.ends_on IS NOT NULL AND (t.stamp AT TIME ZONE p.time_zone)::date>=s.ends_on THEN 'ended'
    WHEN s.valid_until<=t.stamp THEN 'expired' ELSE 'current' END AS context_state
  FROM atrium.property_residents r JOIN atrium.resident_sources s ON s.organization_id=r.organization_id AND s.property_id=r.property_id AND s.id=r.source_id
  CROSS JOIN inbox_property p CROSS JOIN inbox_clock t
  WHERE r.organization_id=$1 AND r.property_id=$2 AND r.id IN (SELECT resident_id FROM inbox_cases)
 ), inbox_graph AS MATERIALIZED (
  SELECT c.id,c.created_at,atrium.service_case_json(c)||jsonb_build_object('contextNeedsReview',c.state='ready_for_planning' AND
   (c.location_kind='unknown' OR (c.location_kind='unit' AND (NOT c.unit_id=ANY(common.unit_ids) OR
    (c.request_origin<>'staff_observation' AND (r.id IS NULL OR r.context_state<>'current')))))) AS request,
   CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'version',r.version,'unitId',r.unit_id,'displayName',r.display_name,
    'contextState',r.context_state,'sourceId',r.source_id,'status',r.status,'startsOn',r.starts_on,'endsOn',r.ends_on,
    'startsAt',atrium.service_iso(r.starts_at),'endsAt',atrium.service_iso(r.ends_at),'validUntil',atrium.service_iso(r.valid_until)) END AS resident,
   CASE WHEN pl.id IS NULL THEN NULL ELSE atrium.maintenance_plan_json(pl.plan_record) END AS plan,
   CASE WHEN v.id IS NULL THEN NULL ELSE atrium.maintenance_vendor_json(v) END AS vendor,
   CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'planId',d.plan_id,'planVersion',d.plan_version,'decision',d.decision,
    'actorUserId',d.actor_user_id,'actorRole',d.actor_role,'reason',d.reason,'decidedAt',atrium.service_iso(d.decided_at))||a.authority END AS decision
  FROM inbox_cases c CROSS JOIN inbox_common common
  LEFT JOIN inbox_plans pl ON pl.candidate_id=c.id
  LEFT JOIN inbox_residents r ON r.id=c.resident_id
  LEFT JOIN LATERAL(SELECT * FROM atrium.maintenance_vendors WHERE organization_id=$1 AND property_id=$2 AND id=pl.vendor_id ORDER BY version DESC LIMIT 1) v ON true
  LEFT JOIN inbox_decisions d ON d.plan_id=pl.id AND d.plan_version=pl.version
  LEFT JOIN inbox_approvers a ON a.actor_user_id=d.actor_user_id
 ) SELECT jsonb_build_object('role',common.role,'configure',common.configure,'configurationVersion',common.published_configuration_version,
   'timeZone',common.time_zone,'unitIds',common.unit_ids,'policy',common.policy) AS metadata,
   atrium.service_iso(t.stamp) AS now,
   coalesce((SELECT jsonb_agg(jsonb_build_object('request',g.request,'resident',g.resident,'plan',g.plan,'vendor',g.vendor,'decision',g.decision) ORDER BY g.created_at DESC,g.id DESC) FROM inbox_graph g),'[]'::jsonb) AS candidates
  FROM inbox_common common CROSS JOIN inbox_clock t`

/** Immutable local decisions only. This repository cannot contact or commit a vendor. */
export class PostgresMaintenancePlanningRepository implements MaintenancePlanningRepository {
  private readonly connection: DatabaseConnection
  private readonly scope: AuthorizedScope
  private readonly configurationVersion: number
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: { configurationVersion: number }) {
    assertAuthorizedScope(scope,'operate')
    if (connection.role!=='atrium_app') bad()
    if (scope.actor.kind!=='user' || !scope.actor.sessionId) throw new AuthorizationError('forbidden')
    this.connection=connection;this.scope=scope;this.configurationVersion=ver(attribution?.configurationVersion)
  }
  private async run<T>(permission: Permission, fn: (client: PoolClient)=>Promise<T>): Promise<T> {
    assertAuthorizedScope(this.scope,permission)
    try { return await propertyTransaction(this.connection,this.scope,permission,fn,this.configurationVersion) }
    catch(error) {
      if (error instanceof AuthorizationError || error instanceof MaintenancePlanningError) throw error
      const raw=error as {code?:unknown;message?:unknown}
      if (raw.code==='property_configuration_changed' || raw.message==='property_configuration_changed') throw Object.assign(new Error('Property configuration changed. Reload this workspace.'),{code:'property_configuration_changed'})
      if (raw.code==='P0001' && raw.message==='forbidden') throw new AuthorizationError('forbidden')
      if (raw.code==='P0001' && errors.includes(raw.message as MaintenancePlanningErrorCode)) return bad(raw.message as MaintenancePlanningErrorCode)
      return bad()
    }
  }
  private scoped(row: Row): void { if(row.organizationId!==this.scope.organizationId || row.propertyId!==this.scope.propertyId) bad() }
  private policy(value: unknown): MaintenancePolicy | null {
    if(value===null)return null
    const r=obj(value);this.scoped(r)
    let details
    try { details=parsePolicyDetails(Object.fromEntries(['currency','automaticLimitCents','managerLimitCents','ownerLimitCents','automaticCategories','excludedCategories','requireResidentApproval','requireIndependentApprover','sourceReference','observedAt','validUntil'].map(k=>[k,r[k]]))) } catch { return bad() }
    return {...details,organizationId:r.organizationId,propertyId:r.propertyId,version:ver(r.version),publishedBy:id(r.publishedBy),publishedAt:date(r.publishedAt)}
  }
  private vendor(value: unknown): MaintenanceVendor | null {
    if(value===null)return null
    const r=obj(value);this.scoped(r)
    let details
    try { details=parseVendorDetails(Object.fromEntries(['name','categories','status','phone','email','serviceArea','hours','emergencyCoverage','availability','availabilityObservedAt','availabilityValidUntil','expectedPricing','responseTargetMinutes','preference','restrictions','sourceReference','observedAt','validUntil'].map(k=>[k,r[k]]))) } catch { return bad() }
    return {...details,id:id(r.id),organizationId:r.organizationId,propertyId:r.propertyId,version:ver(r.version),reviewedBy:id(r.reviewedBy),reviewedAt:date(r.reviewedAt),createdAt:date(r.createdAt)}
  }
  private plan(value: unknown): MaintenancePlan | null {
    if(value===null)return null
    const r=obj(value);this.scoped(r)
    let details
    try { details=parsePlanDetails(Object.fromEntries(['route','vendorId','vendorVersion','internalTeam','scopeOfWork','currency','maximumCents','includesAllCharges','accessRequirement','restrictions','reason'].map(k=>[k,r[k]]))) } catch { return bad() }
    if((r.residentId===null)!==(r.residentVersion===null))bad()
    return {...details,id:id(r.id),caseId:id(r.caseId),organizationId:r.organizationId,propertyId:r.propertyId,version:ver(r.version),
      caseVersion:ver(r.caseVersion),configurationVersion:ver(r.configurationVersion),residentId:r.residentId===null?null:id(r.residentId),
      residentVersion:r.residentVersion===null?null:ver(r.residentVersion),policyVersion:ver(r.policyVersion),preparedBy:id(r.preparedBy),
      preparedAt:date(r.preparedAt),createdAt:date(r.createdAt),withdrawnAt:r.withdrawnAt===null?null:date(r.withdrawnAt),emergencyKinds:hazards(r.emergencyKinds)}
  }
  private request(value: unknown): ServiceCase {
    const r=obj(value);this.scoped(r)
    let parsed
    try { parsed=parseServiceCommand({action:'create_request',requestId:'projection',intake:Object.fromEntries(['requestOrigin','location','residentId','summary','description','category','reportedPriority','reporterName','reporterPhone','reporterEmail','accessNotes'].map(k=>[k,r[k]]))}) } catch { return bad() }
    if(parsed.action!=='create_request')return bad()
    if(!serviceStates.includes(r.state) || !['routine','urgent','emergency'].includes(r.priority)
      || typeof r.contextNeedsReview!=='boolean' || r.dispatchStatus!=='not_dispatched' || r.notificationStatus!=='not_sent' || r.callerIdentityVerified!==false || r.entryAuthorized!==false)bad()
    let original
    try { original=parseServiceCommand({action:'update_context',requestId:'projection',id:'projection',expectedVersion:1,location:r.intakeLocation,residentId:r.residentIdAtIntake,note:'Projection'}) } catch {return bad()}
    if(original.action!=='update_context')return bad()
    if((r.residentIdAtIntake===null ? r.residentNameAtIntake!==null || r.residentVersionAtIntake!==null : typeof r.residentNameAtIntake!=='string'))bad()
    return {...parsed.intake,id:id(r.id),organizationId:r.organizationId,propertyId:r.propertyId,version:ver(r.version),state:r.state,priority:r.priority,
      emergencyKinds:hazards(r.emergencyKinds),createdAt:date(r.createdAt),updatedAt:date(r.updatedAt),createdBy:id(r.createdBy),
      intakeLocation:original.location,residentIdAtIntake:r.residentIdAtIntake,residentNameAtIntake:r.residentNameAtIntake,
      residentVersionAtIntake:r.residentVersionAtIntake===null?null:ver(r.residentVersionAtIntake),contextNeedsReview:r.contextNeedsReview,
      dispatchStatus:'not_dispatched',notificationStatus:'not_sent',callerIdentityVerified:false,entryAuthorized:false}
  }
  private resident(value: unknown): ResidentContext {
    if(value===null)return {state:'not_established',residentId:null,residentVersion:null,displayName:null,unitId:null,callerIdentityVerified:false,entryAuthorized:false}
    const r=obj(value);this.scoped(r)
    try {parseResidentDetails(Object.fromEntries(['unitId','displayName','relationship','startsOn','endsOn','phone','email','source'].map(k=>[k,r[k]])))}catch{return bad()}
    if(!['current','expired','revoked','not_started','ended'].includes(r.contextState))bad()
    return {state:r.contextState,residentId:id(r.id),residentVersion:ver(r.version),displayName:r.displayName,unitId:id(r.unitId),callerIdentityVerified:false,entryAuthorized:false}
  }
  private decision(value: unknown): MaintenanceDecision | null {
    if(value===null)return null
    const r=obj(value)
    if(!['approve','reject'].includes(r.decision) || !['owner','admin'].includes(r.actorRole) || !['owner','admin',null].includes(r.currentRole)
      || typeof r.authorityCurrent!=='boolean' || r.authorityCurrent!==(r.currentRole!==null) || typeof r.reason!=='string' || r.reason.length>1000)bad()
    return {id:id(r.id),planId:id(r.planId),planVersion:ver(r.planVersion),decision:r.decision,actorUserId:id(r.actorUserId),actorRole:r.actorRole,
      currentRole:r.currentRole,authorityCurrent:r.authorityCurrent,reason:r.reason,decidedAt:date(r.decidedAt)}
  }
  async overview(): Promise<MaintenancePlanningOverview> {
    return this.run('operate',async c=>{
      const r=(await c.query(`SELECT atrium.maintenance_actor_role() AS role,atrium.can_access_property($1,$2,'configure') AS configure,
        (SELECT atrium.maintenance_policy_json(p) FROM atrium.maintenance_policies p WHERE organization_id=$1 AND property_id=$2 ORDER BY version DESC LIMIT 1) AS policy`,[this.scope.organizationId,this.scope.propertyId])).rows[0]
      if(!['owner','admin','staff'].includes(r.role) || typeof r.configure!=='boolean')bad()
      return {policy:this.policy(r.policy),actorRole:r.role as Role,canPublishPolicy:r.role==='owner' && r.configure,canManageVendors:r.configure}
    })
  }
  private inboxActor(metadata: Row): MaintenanceInboxActor {
    if(this.scope.actor.kind!=='user')return bad()
    if(!['owner','admin','staff'].includes(metadata.role) || typeof metadata.configure!=='boolean')bad()
    if(metadata.configurationVersion!==this.configurationVersion) {
      throw Object.assign(new Error('Property configuration changed. Reload this workspace.'),{code:'property_configuration_changed'})
    }
    return {userId:this.scope.actor.userId,role:metadata.role,configure:metadata.configure}
  }
  private inboxResident(value: unknown): ResidentContext {
    if(value===null)return {state:'not_established',residentId:null,residentVersion:null,displayName:null,unitId:null,callerIdentityVerified:false,entryAuthorized:false}
    const r=obj(value)
    if(!['current','expired','revoked','not_started','ended'].includes(r.contextState) || typeof r.displayName!=='string' || r.displayName.length>120
      || !uuid(r.sourceId) || !['active','revoked'].includes(r.status))bad()
    date(r.validUntil)
    return {state:r.contextState,residentId:id(r.id),residentVersion:ver(r.version),displayName:r.displayName,unitId:id(r.unitId),callerIdentityVerified:false,entryAuthorized:false}
  }
  async listInbox(input: MaintenanceInboxQuery): Promise<MaintenanceInboxPage> {
    const query=validateMaintenanceInboxQuery(input)
    return this.run('operate',async client=>{
      const parameters=[this.scope.organizationId,this.scope.propertyId,query.before?.createdAt??null,query.before?.id??null,
        query.unitId??null,maintenanceInboxScanLimit+1,null]
      const readGraph=async(values:unknown[])=>{
        const rows=(await client.query(inboxQuery,values)).rows
        if(rows.length!==1) {
          await assertCurrentPropertyAccess(client,this.scope,'operate',this.configurationVersion)
          return bad()
        }
        return obj(rows[0])
      }
      const first=await readGraph(parameters)
      if(!Array.isArray(first.candidates) || first.candidates.length>maintenanceInboxScanLimit+1)bad()
      this.inboxActor(obj(first.metadata))
      const candidateIds=first.candidates.map((candidate:unknown)=>{
        const key=obj(obj(candidate).request).id
        if(!uuid(key))bad()
        return key
      })
      if(new Set(candidateIds).size!==candidateIds.length)bad()
      // Validate all fetched rows, including nonmatches and lookahead. Otherwise a
      // concurrent change could turn an excluded row into a match behind the cursor.
      const final=await readGraph([...parameters.slice(0,6),candidateIds])
      const metadata=obj(final.metadata),actor=this.inboxActor(metadata)
      if(JSON.stringify(first.metadata)!==JSON.stringify(final.metadata) || JSON.stringify(first.candidates)!==JSON.stringify(final.candidates))bad('planning_version_conflict')
      const policy=this.policy(metadata.policy)
      const evaluatedAt=date(final.now),now=new Date(evaluatedAt),items:MaintenanceInboxItem[]=[]
      let refreshAt:string|null=null
      const boundary=(value:unknown)=>{
        if(value===null || value===undefined)return
        const stamp=date(value)
        if(stamp>evaluatedAt && (refreshAt===null || stamp<refreshAt))refreshAt=stamp
      }
      boundary(policy?.observedAt);boundary(policy?.validUntil)
      for(const value of final.candidates as unknown[]) {
        const row=obj(value)
        if(row.resident!==null)for(const key of ['validUntil','startsAt','endsAt'])boundary(obj(row.resident)[key])
        if(row.vendor!==null)for(const key of ['observedAt','validUntil','availabilityObservedAt','availabilityValidUntil'])boundary(obj(row.vendor)[key])
      }
      let scannedCount=0,last:ServiceCursor|null=null
      for(const value of final.candidates as unknown[]) {
        if(scannedCount===maintenanceInboxScanLimit || items.length===query.limit)break
        const row=obj(value),request=this.request(row.request),resident=this.inboxResident(row.resident)
        if(request.residentId!==resident.residentId)bad()
        const item=projectMaintenanceInboxItem({request,resident,policy,plan:this.plan(row.plan),vendor:this.vendor(row.vendor),
          decision:this.decision(row.decision),configurationVersion:this.configurationVersion},actor,now)
        scannedCount++;last={createdAt:request.createdAt,id:request.id}
        if(query.filter==='all' || item.group===query.filter)items.push(item)
      }
      const nextCursor=scannedCount<final.candidates.length?last:null
      return {items,nextCursor,evaluatedAt,scannedCount,scanIncomplete:nextCursor!==null && items.length<query.limit,
        policyVersion:policy?.version??null,policyValidUntil:policy?.validUntil??null,refreshAt}
    })
  }
  private query(input: {limit:number;before?:ServiceCursor}) {
    let q
    try {q=validateServiceListQuery(input,'events')}catch{return bad('planning_invalid_input')}
    if(q.before && !uuid(q.before.id))bad('planning_invalid_input')
    return q
  }
  async listVendors(input: {limit:number;before?:ServiceCursor;status?:'approved'|'suspended'}): Promise<MaintenanceVendor[]> {
    if(!input || Object.keys(input).some(k=>!['limit','before','status'].includes(k)) || input.status!==undefined && !['approved','suspended'].includes(input.status))bad('planning_invalid_input')
    const q=this.query({limit:input.limit,...(input.before?{before:input.before}:{})})
    return this.run('operate',async c=>(await c.query(`SELECT atrium.maintenance_vendor_json(v) AS value FROM
      (SELECT DISTINCT ON(id) * FROM atrium.maintenance_vendors WHERE organization_id=$1 AND property_id=$2 ORDER BY id,version DESC) v
      WHERE ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) AND ($5::text IS NULL OR status=$5)
      ORDER BY created_at DESC,id DESC LIMIT $6`,[this.scope.organizationId,this.scope.propertyId,q.before?.createdAt??null,q.before?.id??null,input.status??null,q.limit])).rows.map(r=>this.vendor(r.value)!))
  }
  async getVendor(vendorId: string): Promise<MaintenanceVendor|null> {
    if(!recordId(vendorId))bad('planning_invalid_input')
    return this.run('operate',async c=>this.vendor((await c.query(`SELECT atrium.maintenance_vendor_json(v) AS value FROM atrium.maintenance_vendors v
      WHERE organization_id=$1 AND property_id=$2 AND id=$3::uuid ORDER BY version DESC LIMIT 1`,[this.scope.organizationId,this.scope.propertyId,uuid(vendorId)?vendorId:null])).rows[0]?.value??null))
  }
  private async history(c: PoolClient,caseId: string,q:{limit:number;before?:ServiceCursor}): Promise<MaintenancePlanHistoryEntry[]> {
    return (await c.query(`SELECT e.id,e.plan_id AS "planId",e.plan_version::float8 AS "planVersion",e.kind,e.actor_user_id AS "actorUserId",atrium.service_iso(e.created_at) AS "createdAt",e.reason,
      p.scope_of_work AS "scopeOfWork",p.maximum_cents::float8 AS "maximumCents",p.currency,v.name AS "vendorName",p.policy_version::float8 AS "policyVersion",p.case_version::float8 AS "caseVersion"
      FROM atrium.maintenance_plan_events e JOIN atrium.maintenance_plans p ON p.organization_id=e.organization_id AND p.property_id=e.property_id AND p.id=e.plan_id AND p.version=e.plan_version
      LEFT JOIN atrium.maintenance_vendors v ON v.organization_id=p.organization_id AND v.property_id=p.property_id AND v.id=p.vendor_id AND v.version=p.vendor_version
      WHERE e.organization_id=$1 AND e.property_id=$2 AND p.case_id=$3::uuid AND ($4::timestamptz IS NULL OR (e.created_at,e.id)<($4::timestamptz,$5::uuid))
      ORDER BY e.created_at DESC,e.id DESC LIMIT $6`,[this.scope.organizationId,this.scope.propertyId,uuid(caseId)?caseId:null,q.before?.createdAt??null,q.before?.id??null,q.limit])).rows.map(r=>{
        if(!['prepared','approved','rejected','withdrawn','safety_hold'].includes(r.kind) || r.currency!=='USD' || typeof r.reason!=='string' || typeof r.scopeOfWork!=='string'
          || (r.maximumCents!==null && (!Number.isSafeInteger(r.maximumCents) || r.maximumCents<0 || r.maximumCents>1e9)) || r.vendorName!==null && typeof r.vendorName!=='string')bad()
        return {...r,id:id(r.id),planId:id(r.planId),planVersion:ver(r.planVersion),actorUserId:id(r.actorUserId),createdAt:date(r.createdAt),policyVersion:ver(r.policyVersion),caseVersion:ver(r.caseVersion)} as MaintenancePlanHistoryEntry
      })
  }
  async listPlanHistory(caseId: string,input:{limit:number;before?:ServiceCursor}): Promise<MaintenancePlanHistoryEntry[]> {
    if(!recordId(caseId))bad('planning_invalid_input')
    const q=this.query(input)
    return this.run('operate',async c=>{
      if(!(await c.query('SELECT 1 FROM atrium.service_cases WHERE organization_id=$1 AND property_id=$2 AND id=$3::uuid',[this.scope.organizationId,this.scope.propertyId,uuid(caseId)?caseId:null])).rowCount)bad('planning_not_found')
      return this.history(c,caseId,q)
    })
  }
  async getPlan(caseId: string): Promise<MaintenancePlanDetail|null> {
    if(!recordId(caseId))bad('planning_invalid_input')
    return this.run('operate',async c=>{
      const parameters=[this.scope.organizationId,this.scope.propertyId,uuid(caseId)?caseId:null]
      const first=(await c.query(dataQuery,parameters)).rows[0]
      if(!first)return null
      const request=this.request(first.request),resident=this.resident(first.resident),policy=this.policy(first.policy),plan=this.plan(first.plan),vendor=this.vendor(first.vendor),decision=this.decision(first.decision)
      const history=await this.history(c,caseId,{limit:26}),shown=history.slice(0,25),last=shown.at(-1)
      const final=(await c.query(dataQuery,parameters)).rows[0]
      const stable=(r:Row)=>JSON.stringify({...r,now:undefined})
      if(!final || stable(first)!==stable(final))bad('planning_version_conflict')
      const assessment=evaluateMaintenancePlan({request,resident,policy,plan,vendor,decision,configurationVersion:this.configurationVersion},new Date(date(final.now)))
      if(this.scope.actor.kind!=='user')return bad()
      if(!['owner','admin','staff'].includes(final.role) || typeof final.configure!=='boolean')bad()
      const canDecide=canDecideMaintenancePlan({request,resident,policy,plan,vendor,decision,configurationVersion:this.configurationVersion},assessment,
        {userId:this.scope.actor.userId,role:final.role,configure:final.configure})
      return {request,resident,policy,plan,vendor,decision,assessment,canDecide,history:shown,nextHistoryCursor:history.length>25 && last?{id:last.id,createdAt:last.createdAt}:null}
    })
  }
  async execute(input: MaintenancePlanningCommand,proofId?:string): Promise<MaintenancePlanningReceipt> {
    const command=parsePlanningCommand(input),protectedAction=['publish_policy','save_vendor','decide_plan'].includes(command.action)
    if(protectedAction && !uuid(proofId))bad('planning_mfa_required')
    return this.run(protectedAction?'configure':'operate',async c=>{
      const r=obj((await c.query('SELECT atrium.execute_maintenance_planning($1::jsonb,$2::bigint,$3::uuid) AS value',[JSON.stringify(command),this.configurationVersion,protectedAction?proofId:null])).rows[0]?.value)
      if(r.requestId!==command.requestId || r.action!==command.action || !['policy','vendor','plan'].includes(r.resource) || typeof r.replayed!=='boolean'
        || !['saved','emergency_held'].includes(r.outcome))bad()
      return {requestId:r.requestId,action:r.action,resource:r.resource,id:id(r.id),version:ver(r.version),committedAt:date(r.committedAt),replayed:r.replayed,outcome:r.outcome}
    })
  }
}
