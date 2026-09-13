import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'
import {createDatabaseRuntime} from '../../src/application/runtime.ts'
import {PostgresMaintenancePlanningRepository} from '../../src/database/maintenance-planning.ts'
import {PostgresResidentServicesRepository} from '../../src/database/resident-services.ts'
import {scopeContext} from '../../src/database/scope.ts'
import {verifyOrganizationSession} from '../helpers/organization-session.mjs'
import {TEST_AUTH_ORIGIN} from '../helpers/mfa-session.mjs'
let db,runtime,password
const scopes=new Map(),principals=new Map(),proofs=new Map()
const tables=['maintenance_plan_events','maintenance_decisions','maintenance_plans','maintenance_vendors','maintenance_policies','maintenance_commands','service_events','service_commands','service_cases','resident_events','resident_sources','property_residents','organization_people']
before(async()=>{
 db=await createFoundationTestDatabase();({password}=await seedFoundationTestDatabase(db.admin))
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
after(async()=>{await db?.close()})
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

test('policy owner proof and property vendor revisions commit with immutable receipts and history',async()=>{
 assert.equal((await repo('staff-a').overview()).canPublishPolicy,false)
 const p=await publish();assert.equal(p.id,'property-a1');assert.equal(p.version,1);assert.equal(p.outcome,'saved')
 const command={action:'save_vendor',requestId:randomUUID(),id:null,expectedVersion:0,details:vendor(),reason:'Reviewed synthetic vendor'}
 const v=await repo('admin-a').execute(command,proofs.get('admin-a'))
 assert.equal((await repo('admin-a').execute(command,proofs.get('admin-a'))).replayed,true)
 await assert.rejects(repo('admin-a').execute({...command,reason:'A conflicting second request'},proofs.get('admin-a')),{code:'planning_request_conflict'})
 await saveVendor(vendor({status:'suspended'}),'admin-a',v.id,1)
 assert.equal((await repo('staff-a').getVendor(v.id)).version,2);assert.equal((await repo().listVendors({limit:10})).length,1)
 await assert.rejects(publish(policy(),1,'admin-a'),{code:'forbidden'})
 await assert.rejects(repo().execute({action:'publish_policy',requestId:randomUUID(),expectedVersion:1,details:policy(),reason:'No proof provided'}),{code:'planning_mfa_required'})
 await assert.rejects(db.admin.query('UPDATE atrium.maintenance_policies SET owner_limit_cents=1'),/immutable/i)
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.maintenance_vendors')).rows[0].count),2)
})

test('independent current manager approval pins exact plan and never creates external dispatch or entry',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId)
 let detail=await repo('admin-a').getPlan(caseId)
 assert.equal(detail.assessment.readiness,'awaiting_manager');assert.equal(detail.canDecide,true);assert.equal(detail.plan.preparedBy,'staff-a')
 const command=decision(caseId,saved.id);await repo('admin-a').execute(command,proofs.get('admin-a'))
 detail=await repo('staff-a').getPlan(caseId)
 assert.equal(detail.decision.currentRole,'admin');assert.equal(detail.decision.authorityCurrent,true)
 assert.equal(detail.assessment.spendingAuthorized,true);assert.equal(detail.assessment.dispatchStatus,'not_dispatched');assert.equal(detail.assessment.entryAuthorized,false)
 assert.equal(detail.history.length,2);assert.equal(detail.assessment.readiness,'authorized_plan')
 assert.equal((await repo('admin-a').execute(command,proofs.get('admin-a'))).replayed,true)
 await assert.rejects(repo('owner-a').execute(decision(caseId,saved.id,{decision:'reject'}),proofs.get('owner-a')),{code:'planning_version_conflict'})
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.action_intents')).rows[0].count),0)
})

test('owner ceiling, independence and unknown all-in cost cannot be bypassed by direct SQL or a cheap restricted plan',async()=>{
 await publish();const caseId=await create()
 const initial=await prepare(caseId,{details:details({maximumCents:50001})})
 await assert.rejects(repo('admin-a').execute(decision(caseId,initial.id),proofs.get('admin-a')),{code:'planning_not_ready'})
 await repo('owner-a').execute(decision(caseId,initial.id),proofs.get('owner-a'))
 let version=1
 for(const extra of [{maximumCents:null},{maximumCents:100001},{includesAllCharges:false},{scopeOfWork:'Inspect asbestos remediation',maximumCents:1},{restrictions:['legal'],maximumCents:1}]) {
  await prepare(caseId,{expectedPlanVersion:version++,details:details(extra)})
  await assert.rejects(repo().execute(decision(caseId,initial.id,{expectedPlanVersion:version}),proofs.get('owner-a')),{code:'planning_not_ready'})
 }
 await prepare(caseId,{expectedPlanVersion:version++,details:details()},'owner-a')
 assert.equal((await repo().getPlan(caseId)).canDecide,false)
 await assert.rejects(repo().execute(decision(caseId,initial.id,{expectedPlanVersion:version}),proofs.get('owner-a')),{code:'planning_not_ready'})
 await repo('admin-a').execute(decision(caseId,initial.id,{expectedPlanVersion:version}),proofs.get('admin-a'))
})

test('automatic tier remains bounded by vendor review, resident approval, availability and revisions',async()=>{
 await publish();const v=await saveVendor(),caseId=await create()
 const saved=await prepare(caseId,{details:details({route:'vendor',vendorId:v.id,vendorVersion:1,internalTeam:null,maximumCents:10000})})
 let detail=await repo().getPlan(caseId);assert.equal(detail.assessment.tier,'automatic');assert.equal(detail.assessment.readiness,'awaiting_vendor');assert.equal(detail.assessment.spendingAuthorized,true)
 await saveVendor(vendor({availability:'available',availabilityObservedAt:new Date(Date.now()-1000).toISOString(),availabilityValidUntil:new Date(Date.now()+60000).toISOString()}),'admin-a',v.id,1)
 assert.equal((await repo().getPlan(caseId)).assessment.readiness,'stale_plan')
 await prepare(caseId,{expectedPlanVersion:1,details:details({route:'vendor',vendorId:v.id,vendorVersion:2,internalTeam:null,maximumCents:10000,accessRequirement:'unit_entry'})})
 detail=await repo().getPlan(caseId);assert.equal(detail.assessment.readiness,'awaiting_resident');assert.equal(detail.assessment.residentApprovalVerified,false)
 await saveVendor(vendor({status:'suspended'}),'owner-a',v.id,2)
 assert.equal((await repo().getPlan(caseId)).assessment.spendingAuthorized,false)
 assert.equal(saved.id,detail.plan.id)
})

test('policy, case, resident and inventory changes invalidate old evidence without changing history',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId)
 await repo('admin-a').execute(decision(caseId,saved.id),proofs.get('admin-a'))
 await publish(policy(),1);assert.equal((await repo().getPlan(caseId)).assessment.readiness,'stale_plan')
 await prepare(caseId,{expectedPlanVersion:1,policyVersion:2});await repo('admin-a').execute(decision(caseId,saved.id,{expectedPlanVersion:2}),proofs.get('admin-a'))
 await services().execute({action:'add_note',requestId:randomUUID(),id:caseId,expectedVersion:2,note:'Additional context from property inspection'})
 assert.equal((await repo().getPlan(caseId)).assessment.readiness,'stale_plan')
 await prepare(caseId,{expectedPlanVersion:2,expectedCaseVersion:3,policyVersion:2})
 await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
 await assert.rejects(repo().getPlan(caseId),{code:'property_configuration_changed'})
 assert.equal((await repo('owner-a',db.app,2).getPlan(caseId)).assessment.readiness,'stale_plan')
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.maintenance_decisions')).rows[0].count),2)
})

test('current approver role and grant are live while historical logout does not erase an approval',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId,{details:details({maximumCents:75000})})
 await repo().execute(decision(caseId,saved.id),proofs.get('owner-a'))
 await db.admin.query("UPDATE atrium.memberships SET role='admin' WHERE user_id='owner-a'")
 let detail=await repo('staff-a').getPlan(caseId);assert.equal(detail.decision.currentRole,'admin');assert.equal(detail.assessment.spendingAuthorized,false)
 await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE user_id='owner-a'")
 detail=await repo('staff-a').getPlan(caseId);assert.equal(detail.decision.authorityCurrent,false);assert.equal(detail.decision.currentRole,null)
 await db.admin.query("UPDATE atrium.memberships SET status='active',role='owner' WHERE user_id='owner-a'")
 assert.equal((await repo('staff-a').getPlan(caseId)).assessment.spendingAuthorized,true)
 await db.admin.query("UPDATE atrium.memberships SET access='properties' WHERE user_id='owner-a'")
 await db.admin.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-owner-a','organization-a','property-a1','revoked') ON CONFLICT(membership_id,property_id) DO UPDATE SET status='revoked'")
 assert.equal((await repo('staff-a').getPlan(caseId)).decision.authorityCurrent,false)
 await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-owner-a'")
 const secondary=await runtime.sessions.start(await runtime.authorization.authenticatePassword('owner-a',password),{label:'Synthetic historical approval session'})
 await verifyOrganizationSession(runtime,secondary,password)
 const secondaryScope=await runtime.authorization.authorizeProperty(secondary,'property-a1','configure')
 const secondaryRepo=new PostgresMaintenancePlanningRepository(db.app,secondaryScope,{configurationVersion:1})
 await prepare(caseId,{expectedPlanVersion:1,details:details({maximumCents:75000})})
 const secondaryProof=(await runtime.mfa.administrationAuthentication(secondary).verifyCurrentSession(secondary)).verificationId
 await secondaryRepo.execute(decision(caseId,saved.id,{expectedPlanVersion:2}),secondaryProof)
 await runtime.sessions.revoke(principals.get('owner-a'),secondary.sessionId)
 detail=await repo('staff-a').getPlan(caseId);assert.equal(detail.decision.authorityCurrent,true);assert.equal(detail.assessment.spendingAuthorized,true)
 const raw=await db.app.transaction(scopeContext(scopes.get('staff-a')),c=>c.query('SELECT atrium.maintenance_decision_authority($1::uuid) AS v',[detail.decision.id]))
 assert.equal(raw.rows[0].v.authorityCurrent,true)
 for(const command of ['SET ROLE atrium_maintenance_approval_reader','SELECT username FROM atrium.users WHERE id=\'owner-a\'','SELECT * FROM atrium.maintenance_commands']) {
  if(command.includes('username'))assert.equal((await db.app.transaction(scopeContext(scopes.get('staff-a')),c=>c.query(command))).rowCount,0)
  else await assert.rejects(db.app.transaction(scopeContext(scopes.get('staff-a')),c=>c.query(command)),{code:'42501'})
 }
})

test('hazardous attempted approval saves an explicit safety hold, exact retry, and sticky future revisions',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId),command=decision(caseId,saved.id,{reason:'Staff report: I smell gas near the cabinet.'})
 const receipt=await repo().execute(command,proofs.get('owner-a'))
 assert.equal(receipt.outcome,'emergency_held');assert.equal(receipt.version,2)
 assert.equal((await repo().execute(command,proofs.get('owner-a'))).replayed,true)
 let detail=await repo().getPlan(caseId);assert.equal(detail.decision,null);assert.equal(detail.assessment.tier,'emergency');assert.deepEqual(detail.plan.emergencyKinds,['gas'])
 assert.equal(detail.history[0].kind,'safety_hold')
 await repo().execute({action:'withdraw_plan',requestId:randomUUID(),caseId,planId:saved.id,expectedPlanVersion:2,reason:'Withdraw ordinary work pending emergency response'})
 detail=await repo().getPlan(caseId);assert.equal(detail.assessment.readiness,'emergency_review');assert.equal(detail.plan.version,3)
 await prepare(caseId,{expectedPlanVersion:3});assert.equal((await repo().getPlan(caseId)).assessment.readiness,'emergency_review')
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.maintenance_decisions')).rows[0].count),0)
})

test('hazard in rejection survives withdrawal and prior immutable decisions remain readable',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId)
 await repo().execute(decision(caseId,saved.id,{decision:'reject',reason:'There is smoke coming from that cabinet.'}),proofs.get('owner-a'))
 await repo('staff-a').execute({action:'withdraw_plan',requestId:randomUUID(),caseId,planId:saved.id,expectedPlanVersion:1,reason:'Withdraw the ordinary plan'})
 const detail=await repo().getPlan(caseId);assert.equal(detail.assessment.tier,'emergency');assert.ok(detail.plan.emergencyKinds.includes('smoke_or_fire'))
 assert.ok(detail.history.some(e=>e.kind==='rejected'))
})

test('scoped records, finite commands and current staff assurance refuse viewer, channel and foreign data',async()=>{
 await publish();const v=await saveVendor(),caseId=await create();await prepare(caseId)
 assert.equal(await repo('owner-b').getVendor(v.id),null);assert.equal(await repo('sibling').getPlan(caseId),null)
 await assert.rejects(repo('owner-b').listPlanHistory(caseId,{limit:10}),{code:'planning_not_found'})
 assert.throws(()=>repo('viewer-a'),{code:'forbidden'})
 const channel=await runtime.authorization.authorizeChannel('vapi','synthetic-assistant-a','operate')
 assert.throws(()=>new PostgresMaintenancePlanningRepository(db.app,channel,{configurationVersion:1}),{code:'forbidden'})
 const internal=await runtime.authorization.authorizeProperty(await runtime.authorization.authenticatePassword('owner-a',password),'property-a1','operate')
 assert.throws(()=>new PostgresMaintenancePlanningRepository(db.app,internal,{configurationVersion:1}),{code:'forbidden'})
 for(const scope of [scopes.get('viewer-a'),channel,internal])assert.equal((await db.app.transaction(scopeContext(scope),c=>c.query('SELECT * FROM atrium.maintenance_policies'))).rowCount,0)
 await assert.rejects(db.app.transaction(scopeContext(scopes.get('owner-a')),c=>c.query('DELETE FROM atrium.maintenance_plans')),{code:'42501'})
})

test('audit failure rolls back every plan/decision/receipt and malformed direct commands never create authority',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId),before=await count()
 await db.admin.query('REVOKE INSERT ON atrium.maintenance_plan_events FROM atrium_resident_services_executor')
 try {await assert.rejects(repo().execute(decision(caseId,saved.id),proofs.get('owner-a')),{code:'planning_unavailable'})}
 finally{await db.admin.query('GRANT INSERT ON atrium.maintenance_plan_events TO atrium_resident_services_executor')}
 assert.deepEqual(await count(),before)
 const good={action:'publish_policy',requestId:randomUUID(),expectedVersion:1,details:policy(),reason:'Invalid commands must refuse'}
 for(const input of [null,[],{...good,requestId:123},{...good,expectedVersion:null},{...good,details:{...good.details,ownerLimitCents:'100000'}},{...good,details:{...good.details,requireIndependentApprover:null}},{...good,details:{...good.details,automaticCategories:['other','other']}}]) {
  await assert.rejects(db.app.transaction(scopeContext(scopes.get('owner-a')),c=>c.query('SELECT atrium.execute_maintenance_planning($1::jsonb,1,$2::uuid)',[JSON.stringify(input),proofs.get('owner-a')])),{code:'P0001'})
 }
 assert.deepEqual(await count(),before)
})

test('vendor and history cursors preserve equal-millisecond order with 25-event initial detail',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId)
 for(let version=1;version<=26;version++)await prepare(caseId,{expectedPlanVersion:version})
 const detail=await repo().getPlan(caseId);assert.equal(detail.history.length,25);assert.ok(detail.nextHistoryCursor)
 const rest=await repo().listPlanHistory(caseId,{limit:25,before:detail.nextHistoryCursor});assert.equal(rest.length,2)
 assert.equal(new Set([...detail.history,...rest].map(e=>e.id)).size,27)
 const seed=await saveVendor()
 // Immutable, validated fixture copies deliberately share one millisecond; UUID breaks ties.
 await db.admin.query(`INSERT INTO atrium.maintenance_vendors SELECT (jsonb_populate_record(NULL::atrium.maintenance_vendors,to_jsonb(v)||jsonb_build_object('id',gen_random_uuid(),'created_at','2020-01-01T00:00:00.123Z'))).* FROM atrium.maintenance_vendors v CROSS JOIN generate_series(1,4) WHERE v.id=$1`,[seed.id])
 let before,ids=[]
 do {const page=await repo().listVendors({limit:2,...(before?{before}:{})});ids.push(...page.map(v=>v.id));before=page.length?{createdAt:page.at(-1).createdAt,id:page.at(-1).id}:null}while(before)
 assert.equal(ids.length,5);assert.equal(new Set(ids).size,5)
 assert.equal(saved.id,detail.plan.id)
})
