import type { AuthenticatedUser, AuthorizedScope } from '../auth/model.ts'
import { assertAuthorizedScope } from '../auth/authorization.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { validId, validVersion } from '../auth/validation.ts'
import { EnrollmentError } from '../residents/enrollment-model.ts'
import type { ResidentEnrollmentRepository, EnrollmentErrorCode, EnrollmentStaffCommand, EnrollmentStaffState, EnrollmentStaffReceipt,
  EnrollmentPolicy, EnrollmentInvitation, ResidentAccountBinding, EnrollmentPreview, EnrollmentReservation, EnrollmentReservationInput,
  EnrollmentAcceptanceReceipt, OwnResidentBindings } from '../residents/enrollment-model.ts'
import { enrollmentId, enrollmentDigest, enrollmentUsername, parseEnrollmentPolicy, parseEnrollmentStaffCommand, supportedResidentHash } from '../residents/enrollment-validation.ts'
import { boundedText, isoTimestamp } from '../residents/validation.ts'
import { DatabaseConnection } from './connection.ts'
import { propertyTransaction } from './scope.ts'

const codes: EnrollmentErrorCode[] = ['enrollment_invalid_input','enrollment_unavailable','enrollment_unauthenticated','enrollment_forbidden','enrollment_changed',
  'enrollment_invitation_unavailable','enrollment_username_unavailable','enrollment_request_conflict','enrollment_rate_limited','enrollment_reconcile_required','enrollment_password_incorrect']
const fail = (code: EnrollmentErrorCode='enrollment_unavailable'): never => { throw new EnrollmentError(code) }
function check(value: unknown): asserts value { if (!value) fail() }
const object = (value: any): Record<string, any> => { check(value && typeof value==='object' && !Array.isArray(value)); return value }
const id = (value: unknown): string => { check(validId(value));return value }
const version = (value: unknown): number => { check(validVersion(value));return value }
const time = (value: unknown): string => { try { return isoTimestamp(value) } catch { return fail() } }
function resident(principal: AuthenticatedUser): void {
  try { assertManagedSession(principal) } catch { fail('enrollment_unauthenticated') }
  if(principal.audience!=='resident')fail('enrollment_forbidden')
}
function error(raw: unknown): never {
  if(raw instanceof EnrollmentError)throw raw
  const value=raw as {code?: string;message?: string}
  if(value?.code==='P0001' && codes.includes(value.message as EnrollmentErrorCode))fail(value.message as EnrollmentErrorCode)
  if(value?.code==='forbidden')fail('enrollment_forbidden')
  if(value?.code==='property_configuration_changed')fail('enrollment_changed')
  if(['22023','22P02','22007','22008'].includes(value?.code??''))fail('enrollment_invalid_input')
  return fail()
}
function policy(raw: unknown): EnrollmentPolicy | null {
  if(raw===null)return null
  const v=object(raw),details=parseEnrollmentPolicy({enabled:v.enabled,method:v.method,protocol:v.protocol,invitationLifetimeMinutes:v.invitationLifetimeMinutes,sourceReference:v.sourceReference,observedAt:v.observedAt,validUntil:v.validUntil})
  check(typeof v.current==='boolean')
  return {...details,organizationId:id(v.organizationId),propertyId:id(v.propertyId),version:version(v.version),publishedBy:id(v.publishedBy),publishedAt:time(v.publishedAt),current:v.current}
}
function invitation(raw: unknown): EnrollmentInvitation | null {
  if(raw===null)return null
  const v=object(raw);check(['pending','expired','revoked','consumed','stale'].includes(v.state) && v.deliveryStatus==='not_sent')
  return {id:enrollmentId(v.id),version:version(v.version),organizationId:id(v.organizationId),propertyId:id(v.propertyId),residentId:enrollmentId(v.residentId),
    residentVersion:version(v.residentVersion),policyVersion:version(v.policyVersion),configurationVersion:version(v.configurationVersion),state:v.state,
    createdAt:time(v.createdAt),expiresAt:time(v.expiresAt),checkedAt:time(v.checkedAt),checkedBy:id(v.checkedBy),evidenceReference:boundedText(v.evidenceReference,3,240),deliveryStatus:'not_sent'}
}
function binding(raw: unknown): ResidentAccountBinding {
  const v=object(raw);check(['current','revoked','policy_changed','context_changed','account_unavailable'].includes(v.state))
  return {id:enrollmentId(v.id),version:version(v.version),organizationId:id(v.organizationId),propertyId:id(v.propertyId),residentId:enrollmentId(v.residentId),residentVersion:version(v.residentVersion),
    policyVersion:version(v.policyVersion),userId:id(v.userId),invitationId:enrollmentId(v.invitationId),unitId:id(v.unitId),activatedAt:time(v.activatedAt),revokedAt:v.revokedAt===null?null:time(v.revokedAt),state:v.state}
}
function staffReceipt(raw: unknown): EnrollmentStaffReceipt {
  const v=object(raw);check(['publish_policy','issue_invitation','revoke_invitation','revoke_binding'].includes(v.action) && typeof v.replayed==='boolean')
  return {action:v.action,requestId:enrollmentId(v.requestId),organizationId:id(v.organizationId),propertyId:id(v.propertyId),actorUserId:id(v.actorUserId),id:id(v.id),version:version(v.version),
    residentId:v.residentId===null?null:enrollmentId(v.residentId),recordedAt:time(v.recordedAt),replayed:v.replayed}
}
function receipt(raw: unknown): EnrollmentAcceptanceReceipt {
  const v=object(raw);check(typeof v.replayed==='boolean')
  return {requestId:enrollmentId(v.requestId),invitationId:enrollmentId(v.invitationId),bindingId:enrollmentId(v.bindingId),bindingVersion:version(v.bindingVersion),
    organizationId:id(v.organizationId),propertyId:id(v.propertyId),residentId:enrollmentId(v.residentId),userId:id(v.userId),activatedAt:time(v.activatedAt),replayed:v.replayed}
}
function reservation(raw: unknown): EnrollmentReservation {
  const v=object(raw);check(['new','existing'].includes(v.mode) && (v.passwordHash===null || supportedResidentHash(v.passwordHash)))
  return {id:enrollmentId(v.id),requestId:enrollmentId(v.requestId),tokenHash:enrollmentDigest(v.tokenHash),browserHash:enrollmentDigest(v.browserHash),mode:v.mode,
    invitationId:enrollmentId(v.invitationId),invitationVersion:version(v.invitationVersion),userId:id(v.userId),username:enrollmentUsername(v.username),displayName:boundedText(v.displayName,1,200),
    credentialVersion:version(v.credentialVersion),sessionId:v.sessionId===null?null:enrollmentId(v.sessionId),passwordHash:v.passwordHash,expiresAt:time(v.expiresAt),completedReceipt:v.completedReceipt===null?null:receipt(v.completedReceipt)}
}

/** Finite scoped enrollment; private hashes/reservations never become public DTOs. */
export class PostgresResidentEnrollmentRepository implements ResidentEnrollmentRepository {
  private readonly app: DatabaseConnection
  private readonly auth: DatabaseConnection
  constructor(app: DatabaseConnection, auth: DatabaseConnection) {
    if(app.role!=='atrium_app' || auth.role!=='atrium_authenticator')fail()
    this.app=app;this.auth=auth
  }
  private async staff<T>(scope: AuthorizedScope, configurationVersion: number, action: string, input: unknown, proofId: string | null, validate: (v: unknown)=>T): Promise<T> {
    try {
      assertAuthorizedScope(scope,action==='execute'?'configure':'operate');version(configurationVersion)
      if(scope.actor.kind!=='user' || !scope.actor.sessionId)fail('enrollment_forbidden')
      return await propertyTransaction(this.app,scope,action==='execute'?'configure':'operate',async client=>{
        const rows=(await client.query('SELECT atrium.enrollment_staff($1,$2,$3,$4) AS value',[action,input,configurationVersion,proofId])).rows
        check(rows.length===1);return validate(rows[0].value)
      },configurationVersion)
    } catch(raw){return error(raw)}
  }
  private async own<T>(principal: AuthenticatedUser | null, action: string, input: unknown, validate:(v: unknown)=>T): Promise<T> {
    if(principal)resident(principal)
    try {
      const result=await this.auth.transaction(principal?{actorUserId:principal.userId,credentialVersion:principal.credentialVersion,actorSessionId:principal.sessionId!,sessionAudience:'resident'}:{},async client=>{
        const rows=(await client.query('SELECT atrium.enrollment_resident($1,$2) AS value',[action,input])).rows;check(rows.length===1)
        const value=rows[0].value
        // Expected reservation refusals commit the attempt budget before surfacing.
        if(value && typeof value==='object' && 'error' in value){check(codes.includes(value.error));return {error:value.error as EnrollmentErrorCode}}
        return {value:validate(value)}
      })
      if('error' in result)return fail(result.error)
      return result.value
    } catch(raw){return error(raw)}
  }
  async staffState(scope: AuthorizedScope, configurationVersion: number, residentId: string): Promise<EnrollmentStaffState> {
    return this.staff(scope,configurationVersion,'state',{residentId:enrollmentId(residentId)},null,raw=>{
      const v=object(raw),r=object(v.resident),p=policy(v.policy),i=invitation(v.invitation),b=v.binding===null?null:binding(v.binding)
      check(r.id===residentId && ['current','expired','revoked','not_started','ended'].includes(r.contextState) && typeof v.canManage==='boolean')
      for(const entry of [p,i,b])if(entry)check(entry.organizationId===scope.organizationId && entry.propertyId===scope.propertyId)
      if(i)check(i.residentId===residentId);if(b)check(b.residentId===residentId)
      return {policy:p,resident:{id:enrollmentId(r.id),version:version(r.version),displayName:boundedText(r.displayName,1,120),unitId:id(r.unitId),contextState:r.contextState},invitation:i,binding:b,canManage:v.canManage}
    })
  }
  async executeStaff(scope: AuthorizedScope, configurationVersion: number, proofId: string, command: EnrollmentStaffCommand, material?:{id:string;tokenHash:string}): Promise<EnrollmentStaffReceipt> {
    const parsed=parseEnrollmentStaffCommand(command)
    if(parsed.action==='issue_invitation' && !material)fail('enrollment_invalid_input')
    const generated=material?{id:enrollmentId(material.id),tokenHash:enrollmentDigest(material.tokenHash)}:null
    return this.staff(scope,configurationVersion,'execute',{command:parsed,material:generated},enrollmentId(proofId),raw=>{
      const value=staffReceipt(raw);check(value.organizationId===scope.organizationId && value.propertyId===scope.propertyId && scope.actor.kind==='user'
        && value.actorUserId===scope.actor.userId && value.requestId===parsed.requestId && value.action===parsed.action)
      return value
    })
  }
  async staffReceipt(scope: AuthorizedScope, configurationVersion: number, requestId:string): Promise<EnrollmentStaffReceipt|null> {
    return this.staff(scope,configurationVersion,'receipt',{requestId:enrollmentId(requestId)},null,raw=>{
      if(raw===null)return null;const value=staffReceipt(raw)
      check(value.organizationId===scope.organizationId && value.propertyId===scope.propertyId && scope.actor.kind==='user' && value.actorUserId===scope.actor.userId && value.requestId===requestId);return value
    })
  }
  async preview(tokenHash:string): Promise<EnrollmentPreview|null> {
    return this.own(null,'preview',{tokenHash:enrollmentDigest(tokenHash)},raw=>{
      if(raw===null)return null;const v=object(raw)
      return {invitationId:enrollmentId(v.invitationId),invitationVersion:version(v.invitationVersion),propertyName:boundedText(v.propertyName,1,200),unitId:id(v.unitId),recipientHint:boundedText(v.recipientHint,1,20),expiresAt:time(v.expiresAt)}
    })
  }
  async reserveAcceptance(principal: AuthenticatedUser|null,input:EnrollmentReservationInput): Promise<EnrollmentReservation> {
    if(!input || !['new','existing'].includes(input.mode) || ((input.mode==='existing')!==!!principal))fail('enrollment_invalid_input')
    const normalized={requestId:enrollmentId(input.requestId),tokenHash:enrollmentDigest(input.tokenHash),browserHash:enrollmentDigest(input.browserHash),clientKey:enrollmentDigest(input.clientKey),mode:input.mode,
      expectedInvitationVersion:version(input.expectedInvitationVersion),username:enrollmentUsername(input.username),displayName:boundedText(input.displayName,1,200)}
    check(normalized.username===input.username && normalized.displayName===input.displayName)
    return this.own(principal,'reserve',normalized,raw=>{
      const value=reservation(raw);check(value.requestId===normalized.requestId && value.tokenHash===normalized.tokenHash && value.browserHash===normalized.browserHash && value.mode===normalized.mode
        && value.invitationVersion===normalized.expectedInvitationVersion && value.username===normalized.username && value.displayName===normalized.displayName)
      if(principal)check(value.userId===principal.userId && value.sessionId===principal.sessionId && value.credentialVersion===principal.credentialVersion)
      else check(value.sessionId===null)
      return value
    })
  }
  async acceptNew(value: EnrollmentReservation,credentials:{passwordHash:string}): Promise<EnrollmentAcceptanceReceipt> {
    const saved=reservation(value);if(saved.mode!=='new' || !credentials || !supportedResidentHash(credentials.passwordHash))fail('enrollment_invalid_input')
    return this.own(null,'accept_new',{reservation:saved,passwordHash:credentials.passwordHash},raw=>this.acceptance(raw,saved))
  }
  async acceptExisting(principal:AuthenticatedUser,value:EnrollmentReservation): Promise<EnrollmentAcceptanceReceipt> {
    resident(principal);const saved=reservation(value)
    if(saved.mode!=='existing' || saved.userId!==principal.userId || saved.sessionId!==principal.sessionId || saved.credentialVersion!==principal.credentialVersion)fail('enrollment_unauthenticated')
    return this.own(principal,'accept_existing',{reservation:saved},raw=>this.acceptance(raw,saved))
  }
  private acceptance(raw:unknown,saved:EnrollmentReservation): EnrollmentAcceptanceReceipt {
    const value=receipt(raw);check(value.requestId===saved.requestId && value.userId===saved.userId && value.invitationId===saved.invitationId);return value
  }
  async ownBindings(principal:AuthenticatedUser,query:{limit:number;afterId?:string}): Promise<OwnResidentBindings> {
    resident(principal);if(!Number.isInteger(query?.limit)||query.limit<1||query.limit>50)fail('enrollment_invalid_input')
    return this.own(principal,'own_bindings',{limit:query.limit,afterId:query.afterId?enrollmentId(query.afterId):null},raw=>{
      const v=object(raw);check(Array.isArray(v.items) && v.items.length<=query.limit)
      const items=v.items.map((entry:unknown)=>{const b=binding(entry);check(b.userId===principal.userId);return {...b,propertyName:boundedText(object(entry).propertyName,1,200)}})
      check(new Set(items.map((b:ResidentAccountBinding)=>b.id)).size===items.length)
      return {items,nextId:v.nextId===null?null:enrollmentId(v.nextId)}
    })
  }
  async ownReceipt(principal:AuthenticatedUser,requestId:string): Promise<EnrollmentAcceptanceReceipt|null> {
    resident(principal)
    return this.own(principal,'own_receipt',{requestId:enrollmentId(requestId)},raw=>{if(raw===null)return null;const value=receipt(raw);check(value.userId===principal.userId && value.requestId===requestId);return value})
  }
}
