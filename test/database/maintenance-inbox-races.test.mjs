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

// Intercept only after a completed real projection statement. Independent writes
// commit on a second connection before the repository's final graph read.
function afterFirstInboxRead(work) {
 let invoked=false
 return {role:db.app.role,transaction:(context,fn)=>db.app.transaction(context,client=>fn(new Proxy(client,{
  get(target,key){
   if(key==='query')return async(...args)=>{const result=await target.query(...args);if(!invoked&&String(args[0]).startsWith('WITH inbox_clock')){invoked=true;await work(result.rows[0])}return result}
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }
 })))}
}
const residentDetails=(extra={})=>({unitId:'shared-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:null,phone:null,email:null,
 source:{kind:'staff_review',reference:'Synthetic occupancy register',version:'1',...dates()},...extra})
async function addResident(details=residentDetails()) {
 return services().execute({action:'add_resident',requestId:randomUUID(),reason:'Review synthetic occupancy evidence',details})
}
for(const change of ['case','policy','vendor','decision','resident'])test(`inbox refuses a mixed graph after concurrent ${change} mutation`,async()=>{
 await publish();const v=await saveVendor(),resident=await addResident()
 const caseId=await create({requestOrigin:'resident_report',residentId:resident.id}),plan=await prepare(caseId,{details:details({route:'vendor',vendorId:v.id,vendorVersion:1,internalTeam:null})})
 const connection=afterFirstInboxRead(async()=>{
  if(change==='case')await services('owner-a',other).execute({action:'add_note',requestId:randomUUID(),id:caseId,expectedVersion:2,note:'Newer context from property staff'})
  if(change==='policy')await repo('owner-a',other).execute({action:'publish_policy',requestId:randomUUID(),expectedVersion:1,details:policy(),reason:'Owner revised authority rules'},proofs.get('owner-a'))
  if(change==='vendor')await repo('admin-a',other).execute({action:'save_vendor',requestId:randomUUID(),id:v.id,expectedVersion:1,details:vendor({status:'suspended'}),reason:'Vendor review withdrawn'},proofs.get('admin-a'))
  if(change==='decision')await repo('admin-a',other).execute(decision(caseId,plan.id),proofs.get('admin-a'))
  if(change==='resident')await services('owner-a',other).execute({action:'revoke_resident',requestId:randomUUID(),id:resident.id,expectedVersion:1,reason:'Occupancy source withdrawn'})
 })
 await assert.rejects(repo('owner-a',connection).listInbox({limit:25,filter:'all'}),{code:'planning_version_conflict'})
})
for(const change of ['approver_role','approver_grant','requester_role','requester_grant','configuration'])test(`inbox rechecks ${change} even when the change does not update the case`,async()=>{
 await publish();const caseId=await create(),plan=await prepare(caseId)
 await repo('admin-a').execute(decision(caseId,plan.id),proofs.get('admin-a'))
 const original=(await repo().getPlan(caseId)).request.updatedAt
 const actor=change==='requester_role'?'owner-a':'staff-a'
 const connection=afterFirstInboxRead(async()=>{
  if(change==='approver_role')await db.admin.query("UPDATE atrium.memberships SET role='staff' WHERE user_id='admin-a'")
  if(change==='approver_grant')await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-admin-a'")
  if(change==='requester_role')await db.admin.query("UPDATE atrium.memberships SET role='admin' WHERE user_id='owner-a'")
  if(change==='requester_grant')await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-staff-a'")
  if(change==='configuration')await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
 })
 await assert.rejects(repo(actor,connection).listInbox({limit:25,filter:'attention'}),{code:change==='requester_grant'?'forbidden':change==='configuration'?'property_configuration_changed':'planning_version_conflict'})
 assert.equal((await db.admin.query('SELECT atrium.service_iso(updated_at) AS at FROM atrium.service_cases WHERE id=$1',[caseId])).rows[0].at,original)
 if(change.startsWith('approver')){
  const current=await repo('staff-a').listInbox({limit:25,filter:'attention'})
  assert.equal(current.items[0].assessment.readiness,'stale_plan')
 }
})
test('a change to the unconsumed lookahead is refused before publishing a full first page',async()=>{
 await publish();const seed=await create()
 // Additional immutable synthetic intake rows establish a 201-row candidate graph.
 await db.admin.query(`INSERT INTO atrium.service_cases SELECT (jsonb_populate_record(NULL::atrium.service_cases,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'created_at','2020-01-01T00:00:00.123Z'))).*
  FROM atrium.service_cases c CROSS JOIN generate_series(1,200) WHERE c.id=$1`,[seed])
 const connection=afterFirstInboxRead(async row=>{
  assert.equal(row.candidates.length,201)
  const last=row.candidates.at(-1).request
  await services('owner-a',other).execute({action:'add_note',requestId:randomUUID(),id:last.id,expectedVersion:last.version,note:'Changed after the first graph read'})
 })
 await assert.rejects(repo('owner-a',connection).listInbox({limit:1,filter:'all'}),{code:'planning_version_conflict'})
})
test('resident source expiry between projections refuses a page and refresh derives current attention',async()=>{
 await publish()
 const until=new Date(Date.now()+1500).toISOString(),resident=await addResident(residentDetails({source:{kind:'staff_review',reference:'Short-lived synthetic source',version:'1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:until}}))
 const caseId=await create({requestOrigin:'resident_report',residentId:resident.id});await prepare(caseId,{details:details({maximumCents:10000})})
 const connection=afterFirstInboxRead(async row=>{
  assert.equal(row.candidates[0].resident.contextState,'current')
  await delay(Math.max(0,Date.parse(until)-Date.now())+40)
 })
 await assert.rejects(repo('owner-a',connection).listInbox({limit:25,filter:'attention'}),{code:'planning_version_conflict'})
 const page=await repo().listInbox({limit:25,filter:'attention'}),detail=await repo().getPlan(caseId)
 assert.equal(detail.resident.state,'expired');assert.equal(page.items[0].assessment.readiness,'needs_context')
 assert.deepEqual(page.items[0].assessment,detail.assessment);assert.equal(page.items[0].nextStep.kind,'review_context')
 assert.equal(page.items[0].caseVersion,2)
})
for(const boundary of ['policy','vendor_review','availability'])test(`all inbox items use final database time after ${boundary} expiry`,async()=>{
 const until=new Date(Date.now()+1500).toISOString()
 await publish(policy(boundary==='policy'?{validUntil:until}:{}))
 let v
 if(boundary!=='policy')v=await saveVendor(vendor({availability:'available',availabilityObservedAt:new Date(Date.now()-60000).toISOString(),availabilityValidUntil:boundary==='availability'?until:new Date(Date.now()+86400000).toISOString(),...(boundary==='vendor_review'?{validUntil:until}:{})}))
 const caseIds=[]
 for(let n=0;n<2;n++){
  const caseId=await create();caseIds.push(caseId)
  await prepare(caseId,{details:details({maximumCents:10000,...(v?{route:'vendor',vendorId:v.id,vendorVersion:1,internalTeam:null}:{})})})
 }
 const connection=afterFirstInboxRead(async()=>{await delay(Math.max(0,Date.parse(until)-Date.now())+40)})
 const page=await repo('owner-a',connection).listInbox({limit:25,filter:'all'})
 assert.equal(page.items.length,2);assert.ok(Date.parse(page.evaluatedAt)>=Date.parse(until))
 const expected=boundary==='policy'?'needs_policy':boundary==='vendor_review'?'management_review':'awaiting_vendor'
 for(const item of page.items){assert.equal(item.assessment.readiness,expected);assert.deepEqual(item.assessment,(await repo().getPlan(item.id)).assessment)}
 assert.notEqual(page.refreshAt,until)
})
