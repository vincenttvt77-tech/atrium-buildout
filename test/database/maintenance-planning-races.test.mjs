import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'
import {createDatabaseRuntime} from '../../src/application/runtime.ts'
import {PostgresMaintenancePlanningRepository} from '../../src/database/maintenance-planning.ts'
import {PostgresResidentServicesRepository} from '../../src/database/resident-services.ts'
import {scopeContext} from '../../src/database/scope.ts'
import {verifyOrganizationSession} from '../helpers/organization-session.mjs'
import {TEST_AUTH_ORIGIN} from '../helpers/mfa-session.mjs'
let db,runtime,password,other
const scopes=new Map(),principals=new Map(),proofs=new Map()
const tables=['maintenance_plan_events','maintenance_decisions','maintenance_plans','maintenance_vendors','maintenance_policies','maintenance_commands','service_events','service_commands','service_cases','resident_events','resident_sources','property_residents','organization_people']
before(async()=>{
 db=await createFoundationTestDatabase();other=db.createAppConnection();({password}=await seedFoundationTestDatabase(db.admin))
 await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES('admin-a','admin-a','Synthetic administrator','active')")
 await db.admin.query("INSERT INTO atrium.user_credentials SELECT 'admin-a',password_hash,clock_timestamp() FROM atrium.user_credentials WHERE user_id='owner-a'")
 await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,status,access) VALUES('member-admin-a','admin-a','organization-a','admin','active','properties')")
 await db.admin.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-admin-a','organization-a','property-a1','active')")
 runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-maintenance-planning-session-secret',authOrigin:TEST_AUTH_ORIGIN})
 for(const [org,prop] of [['organization-a','property-a1'],['organization-a','property-a2'],['organization-b','property-b1']]) {
  for(const version of [1,2])await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
   VALUES($1,$2,$3,'published',$4::jsonb,clock_timestamp(),'synthetic planning catalogue',clock_timestamp())`,[org,prop,version,JSON.stringify({property:{id:prop},inventory:[{unitId:'shared-unit'}],floorplans:[],knowledge:[]})])
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1',[prop])
 }
 for(const user of ['owner-a','owner-b','admin-a','staff-a','viewer-a']) {
  const principal=await runtime.sessions.start(await runtime.authorization.authenticatePassword(user,password),{label:'Synthetic maintenance planner'})
  await verifyOrganizationSession(runtime,principal,password);principals.set(user,principal)
  proofs.set(user,(await runtime.mfa.administrationAuthentication(principal).verifyCurrentSession(principal)).verificationId)
  scopes.set(user,await runtime.authorization.authorizeProperty(principal,user==='owner-b'?'property-b1':'property-a1','read'))
 }
 scopes.set('sibling',await runtime.authorization.authorizeProperty(principals.get('owner-a'),'property-a2','operate'));proofs.set('sibling',proofs.get('owner-a'))
})
beforeEach(async()=>{
 await db.admin.query(`TRUNCATE ${tables.map(t=>'atrium.'+t).join(',')}`)
 await db.admin.query("UPDATE atrium.memberships SET status='active',access=CASE WHEN user_id IN ('staff-a','admin-a') THEN 'properties' ELSE 'organization' END,role=CASE user_id WHEN 'owner-a' THEN 'owner' WHEN 'owner-b' THEN 'owner' WHEN 'admin-a' THEN 'admin' WHEN 'viewer-a' THEN 'viewer' ELSE 'staff' END")
 await db.admin.query("UPDATE atrium.property_grants SET status='active'")
 await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1,status='active' WHERE id IN ('property-a1','property-a2','property-b1')")
})
after(async()=>{await other?.close();await db?.close()})
const repo=(user='owner-a',connection=db.app,configurationVersion=1)=>new PostgresMaintenancePlanningRepository(connection,scopes.get(user),{configurationVersion})
const services=(user='owner-a',connection=db.app,configurationVersion=1)=>new PostgresResidentServicesRepository(connection,scopes.get(user),{configurationVersion})
const dates=()=>({observedAt:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()})
const policy=(extra={})=>({currency:'USD',automaticLimitCents:10000,managerLimitCents:50000,ownerLimitCents:100000,automaticCategories:['other'],excludedCategories:[],requireResidentApproval:false,requireIndependentApprover:true,sourceReference:'Synthetic owner authority register',...dates(),...extra})
const publish=(details=policy(),expectedVersion=0,user='owner-a')=>repo(user).execute({action:'publish_policy',requestId:randomUUID(),expectedVersion,details,reason:'Owner reviewed per-job authority'},proofs.get(user))
const vendor=(extra={})=>({name:'Synthetic local repair company',categories:['other'],status:'approved',phone:'+12025550100',email:null,serviceArea:'This property',hours:'Weekdays by arrangement',emergencyCoverage:false,availability:'unknown',availabilityObservedAt:null,availabilityValidUntil:null,expectedPricing:'Quote required',responseTargetMinutes:null,preference:1,restrictions:'',sourceReference:'Synthetic staff vendor review',...dates(),...extra})
const saveVendor=(details=vendor(),user='owner-a',id=null,expectedVersion=0)=>repo(user).execute({action:'save_vendor',requestId:randomUUID(),id,expectedVersion,details,reason:'Administrator reviewed vendor'},proofs.get(user))
const details=(extra={})=>({route:'internal',vendorId:null,vendorVersion:null,internalTeam:'Property maintenance',scopeOfWork:'Tighten and align cabinet hinge.',currency:'USD',maximumCents:25000,includesAllCharges:true,accessRequirement:'no_unit_entry',restrictions:[],reason:'Staff inspected reported issue',...extra})
const create=async(extra={},user='staff-a')=>{
 const result=await services(user).execute({action:'create_request',requestId:randomUUID(),intake:{requestOrigin:'staff_observation',location:{kind:'unit',unitId:'shared-unit'},residentId:null,summary:'Cabinet hinge loose',description:'Cupboard hinge needs adjustment',category:'other',reportedPriority:'routine',reporterName:null,reporterPhone:null,reporterEmail:null,accessNotes:'',...extra}})
 if(extra.reportedPriority!=='emergency')await services(user).execute({action:'triage_request',requestId:randomUUID(),id:result.id,expectedVersion:1,state:'ready_for_planning',priority:'routine',note:'Reviewed by property staff'})
 return result.id
}
const prepare=(caseId,extra={},user='staff-a')=>repo(user).execute({action:'prepare_plan',requestId:randomUUID(),caseId,expectedCaseVersion:2,expectedPlanVersion:0,policyVersion:1,details:details(),...extra})
const decision=(caseId,planId,extra={})=>({action:'decide_plan',requestId:randomUUID(),caseId,planId,expectedPlanVersion:1,decision:'approve',reason:'Within the configured per-job allowance',...extra})
const count=async()=>{const result={};for(const t of tables.slice(0,6))result[t]=Number((await db.admin.query('SELECT count(*) FROM atrium.'+t)).rows[0].count);return result}

async function blocked(fragment='execute_maintenance_planning') {
 for(let i=0;i<200;i++) {
  await db.admin.query('SELECT pg_stat_clear_snapshot()')
  if((await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",['%'+fragment+'%'])).rowCount)return
  await delay(10)
 }
 assert.fail('Finite planning command did not reach the intended PostgreSQL lock')
}
async function clockUntil(ms=1800) {
 return new Date(Number((await db.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms')).rows[0].ms)+ms).toISOString()
}
async function expire(until){await delay(Math.max(0,Date.parse(until)-Date.now()+80))}
async function waitOnAudit(command,expectedCode,{user='owner-a',proof=proofs.get(user),until,change}={}) {
 await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.maintenance_plan_events IN SHARE MODE')
 const pending=repo(user,other).execute(command,proof),rejected=assert.rejects(pending,{code:expectedCode})
 try {await blocked();if(change)await change();if(until)await expire(until);await db.admin.query('COMMIT');await rejected}
 finally{await db.admin.query('ROLLBACK')}
}

test('simultaneous exact prepare commits one immutable plan event and command in one transaction',async()=>{
 await publish();const caseId=await create()
 const command={action:'prepare_plan',requestId:randomUUID(),caseId,expectedCaseVersion:2,expectedPlanVersion:0,policyVersion:1,details:details()}
 const results=await Promise.all([repo('staff-a').execute(command),repo('staff-a',other).execute(command)])
 assert.equal(new Set(results.map(r=>r.id)).size,1);assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true])
 const xids=(await db.admin.query(`SELECT xmin::text AS xid FROM atrium.maintenance_plans UNION SELECT xmin::text FROM atrium.maintenance_plan_events UNION SELECT xmin::text FROM atrium.maintenance_commands WHERE action='prepare_plan'`)).rows
 assert.equal(xids.length,1)
 const counts=await count();assert.equal(counts.maintenance_plans,1);assert.equal(counts.maintenance_plan_events,1)
})

test('opposite decisions from independent connections have one winner and cannot overwrite approval evidence',async()=>{
 await publish();const caseId=await create(),plan=await prepare(caseId)
 const result=await Promise.allSettled([repo().execute(decision(caseId,plan.id),proofs.get('owner-a')),
  repo('admin-a',other).execute(decision(caseId,plan.id,{decision:'reject'}),proofs.get('admin-a'))])
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
 assert.equal(result.find(r=>r.status==='rejected').reason.code,'planning_version_conflict')
 assert.equal((await count()).maintenance_decisions,1);assert.equal((await count()).maintenance_plan_events,2)
 const current=await repo('staff-a').getPlan(caseId);assert.ok(['approve','reject'].includes(current.decision.decision))
})

test('policy publication and competing approval serialize without letting old limits authorize the new policy',async()=>{
 await publish();const caseId=await create(),plan=await prepare(caseId)
 const changed={action:'publish_policy',requestId:randomUUID(),expectedVersion:1,details:policy({managerLimitCents:10000}),reason:'Owner reduced the manager allowance'}
 const result=await Promise.allSettled([repo().execute(changed,proofs.get('owner-a')),repo('admin-a',other).execute(decision(caseId,plan.id),proofs.get('admin-a'))])
 assert.equal(result[0].status,'fulfilled')
 if(result[1].status==='rejected')assert.equal(result[1].reason.code,'planning_not_ready')
 const detail=await repo('staff-a').getPlan(caseId);assert.equal(detail.policy.version,2);assert.equal(detail.assessment.readiness,'stale_plan');assert.equal(detail.assessment.spendingAuthorized,false)
})

for(const kind of ['policy','vendor'])test(`${kind} evidence expires after append begins and rolls back its revision and receipt`,async()=>{
 const until=await clockUntil(),command=kind==='policy'?{action:'publish_policy',requestId:randomUUID(),expectedVersion:0,details:policy({validUntil:until}),reason:'Short-lived synthetic owner review'}:
  {action:'save_vendor',requestId:randomUUID(),id:null,expectedVersion:0,details:vendor({validUntil:until}),reason:'Short-lived synthetic vendor review'}
 // SHARE allows the initial receipt SELECT but blocks the later INSERT.
 await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.maintenance_commands IN SHARE MODE')
 const rejected=assert.rejects(repo().execute(command,proofs.get('owner-a')),{code:'planning_invalid_input'})
 try{await blocked();await expire(until);await db.admin.query('COMMIT');await rejected}finally{await db.admin.query('ROLLBACK')}
 const counts=await count();assert.equal(counts.maintenance_policies,0);assert.equal(counts.maintenance_vendors,0);assert.equal(counts.maintenance_commands,0)
})

for(const kind of ['policy','vendor','resident'])test(`approval refuses ${kind} expiry during final event insertion wait`,async()=>{
 const until=await clockUntil(2400)
 await publish(policy(kind==='policy'?{validUntil:until}:{}))
 let residentId=null
 if(kind==='resident') {
  const saved=await services().execute({action:'add_resident',requestId:randomUUID(),reason:'Synthetic occupancy review',details:{unitId:'shared-unit',displayName:'Synthetic current resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:null,phone:null,email:null,
   source:{kind:'staff_review',reference:'Synthetic reviewed lease',version:'1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:until}}})
  residentId=saved.id
 }
 const v=kind==='vendor'?await saveVendor(vendor({validUntil:until})):null
 const caseId=await create(residentId?{requestOrigin:'resident_report',residentId}:{}),plan=await prepare(caseId,{details:details(v?{route:'vendor',vendorId:v.id,vendorVersion:1,internalTeam:null}:{})})
 const before=await count()
 await waitOnAudit(decision(caseId,plan.id),'planning_not_ready',{until})
 assert.deepEqual(await count(),before)
 const detail=await repo().getPlan(caseId);assert.equal(detail.decision,null);assert.equal(detail.assessment.spendingAuthorized,false)
})

for(const place of ['new_decision','duplicate'])test(`exact session-bound proof expiry while ${place} waits refuses a success receipt`,async()=>{
 await publish();const caseId=await create(),plan=await prepare(caseId),command=decision(caseId,plan.id)
 if(place==='duplicate')await repo().execute(command,proofs.get('owner-a'))
 const before=await count(),proof=randomUUID(),until=await clockUntil()
 // DB-time fixture copies a genuinely signed binding into a new short-lived proof;
 // no existing ceremony, factor or immutable evidence is changed.
 await db.admin.query(`INSERT INTO atrium.mfa_assurances SELECT (jsonb_populate_record(NULL::atrium.mfa_assurances,to_jsonb(a)||jsonb_build_object('id',$1::text,'expires_at_ms',$2::bigint))).* FROM atrium.mfa_assurances a WHERE a.id=$3::uuid`,[proof,Date.parse(until),proofs.get('owner-a')])
 if(place==='new_decision')await waitOnAudit(command,'planning_mfa_required',{proof,until})
 else {
  await db.admin.query('BEGIN');await db.admin.query("SELECT 1 FROM atrium.properties WHERE id='property-a1' FOR UPDATE")
  const rejected=assert.rejects(repo('owner-a',other).execute(command,proof),{code:'planning_mfa_required'})
  try{await blocked();await expire(until);await db.admin.query('COMMIT');await rejected}finally{await db.admin.query('ROLLBACK')}
 }
 assert.deepEqual(await count(),before)
})

for(const revoked of ['role','grant'])test(`approver ${revoked} revocation during audit wait rolls back decision and receipt`,async()=>{
 await publish();const caseId=await create(),plan=await prepare(caseId),before=await count()
 await waitOnAudit(decision(caseId,plan.id),'forbidden',{user:'admin-a',change:()=>db.admin.query(revoked==='role'?
  "UPDATE atrium.memberships SET role='staff' WHERE user_id='admin-a'":"UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-admin-a'")})
 assert.deepEqual(await count(),before);assert.equal((await repo().getPlan(caseId)).decision,null)
})

function afterFirstRead(work) {
 let invoked=false
 return {role:db.app.role,transaction:(context,fn)=>db.app.transaction(context,client=>fn(new Proxy(client,{
  get(target,key){if(key==='query')return async(...args)=>{const result=await target.query(...args);if(!invoked&&String(args[0]).startsWith('SELECT atrium.service_case_json')){invoked=true;await work()}return result};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}
 })))}
}
for(const change of ['case','policy','vendor','decision','resident'])test(`plan detail refuses a mixed snapshot after concurrent ${change} mutation`,async()=>{
 await publish();const v=await saveVendor()
 const resident=await services().execute({action:'add_resident',requestId:randomUUID(),reason:'Review synthetic property occupancy',details:{unitId:'shared-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:null,phone:null,email:null,source:{kind:'staff_review',reference:'Synthetic source',version:'1',...dates()}}})
 const caseId=await create({requestOrigin:'resident_report',residentId:resident.id}),plan=await prepare(caseId,{details:details({route:'vendor',vendorId:v.id,vendorVersion:1,internalTeam:null})})
 const connection=afterFirstRead(async()=>{
  if(change==='case')await services('owner-a',other).execute({action:'add_note',requestId:randomUUID(),id:caseId,expectedVersion:2,note:'Newer case context from staff'})
  if(change==='policy')await repo('owner-a',other).execute({action:'publish_policy',requestId:randomUUID(),expectedVersion:1,details:policy(),reason:'Owner revised the policy'},proofs.get('owner-a'))
  if(change==='vendor')await repo('admin-a',other).execute({action:'save_vendor',requestId:randomUUID(),id:v.id,expectedVersion:1,details:vendor({status:'suspended'}),reason:'Vendor review withdrawn'},proofs.get('admin-a'))
  if(change==='decision')await repo('admin-a',other).execute(decision(caseId,plan.id),proofs.get('admin-a'))
  if(change==='resident')await services('owner-a',other).execute({action:'revoke_resident',requestId:randomUUID(),id:resident.id,expectedVersion:1,reason:'Source no longer current'})
 })
 await assert.rejects(repo('owner-a',connection).getPlan(caseId),{code:'planning_version_conflict'})
})
