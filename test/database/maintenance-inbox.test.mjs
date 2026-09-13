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


// Controlled bulk fixtures copy validated synthetic rows. They add no external work
// and preserve the production immutable-write rules; timestamps only exercise paging.
async function copies(caseId,amount,createdAt='2020-01-01T00:00:00.123Z',{planId=null,decisionId=null}={}) {
 const ids=(await db.admin.query(`INSERT INTO atrium.service_cases SELECT (jsonb_populate_record(NULL::atrium.service_cases,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'created_at',$2::text))).*
  FROM atrium.service_cases c CROSS JOIN generate_series(1,$3) WHERE c.id=$1 RETURNING id`,[caseId,createdAt,amount])).rows.map(r=>r.id)
 if(planId) {
  const plans=(await db.admin.query(`INSERT INTO atrium.maintenance_plans SELECT (jsonb_populate_record(NULL::atrium.maintenance_plans,to_jsonb(p)||jsonb_build_object('id',gen_random_uuid(),'case_id',item.id))).*
   FROM atrium.maintenance_plans p CROSS JOIN unnest($2::uuid[]) item(id) WHERE p.id=$1 AND p.version=1 RETURNING id`,[planId,ids])).rows.map(r=>r.id)
  if(decisionId)await db.admin.query(`INSERT INTO atrium.maintenance_decisions SELECT (jsonb_populate_record(NULL::atrium.maintenance_decisions,to_jsonb(d)||jsonb_build_object('id',gen_random_uuid(),'plan_id',item.id))).*
   FROM atrium.maintenance_decisions d CROSS JOIN unnest($2::uuid[]) item(id) WHERE d.id=$1`,[decisionId,plans])
 }
 return ids
}
function observe(connection,seen) {
 return {role:connection.role,transaction:(context,fn)=>connection.transaction(context,client=>fn(new Proxy(client,{
  get(target,key) {
   if(key==='query')return async(...args)=>{if(String(args[0]).startsWith('WITH inbox_clock'))seen.push(args);return target.query(...args)}
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }
 })))}
}

test('empty inbox reports checked scope metadata without fabricated totals or actions',async()=>{
 const page=await repo().listInbox({limit:25,filter:'attention'})
 assert.deepEqual(page.items,[]);assert.equal(page.scannedCount,0);assert.equal(page.scanIncomplete,false);assert.equal(page.nextCursor,null)
 assert.equal(page.policyVersion,null);assert.equal(page.policyValidUntil,null);assert.equal(page.refreshAt,null)
 assert.match(page.evaluatedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
 assert.equal('total' in page,false)
})

test('current readiness, next steps and decision capability match detail with minimal list fields',async()=>{
 await publish();const caseId=await create({reporterName:'Private contact',reporterPhone:'+12025550999',accessNotes:'Private access instruction'}),saved=await prepare(caseId)
 const page=await repo('admin-a').listInbox({limit:25,filter:'attention'}),detail=await repo('admin-a').getPlan(caseId),item=page.items[0]
 assert.equal(item.id,caseId);assert.equal(item.planId,saved.id);assert.deepEqual(item.assessment,detail.assessment);assert.equal(item.canDecide,detail.canDecide)
 assert.equal(item.nextStep.kind,'review_decision');assert.equal(item.nextStep.availableInPortal,true)
 const serialized=JSON.stringify(page)
 for(const forbidden of ['Private contact','+12025550999','Private access instruction','Tighten and align cabinet hinge.','reporterPhone','scopeOfWork','residentId'])assert.equal(serialized.includes(forbidden),false,forbidden)
 assert.equal(item.assessment.entryAuthorized,false);assert.equal(item.assessment.dispatchStatus,'not_dispatched')
 const own=await prepare(caseId,{expectedPlanVersion:1},'owner-a')
 const samePerson=await repo().listInbox({limit:25,filter:'attention'})
 assert.equal(samePerson.items[0].planId,own.id);assert.equal(samePerson.items[0].canDecide,false)
 assert.match(samePerson.items[0].nextStep.label,/another authorized approver/)
})

test('sparse scan continues through 200 nonmatching cases and eventually returns an older matching case',async()=>{
 await publish();const match=await create(),waiting=await create(),saved=await prepare(waiting,{details:details({maximumCents:10000})})
 const createdAt=(await repo().getPlan(waiting)).request.createdAt
 await copies(waiting,200,createdAt,{planId:saved.id})
 const first=await repo().listInbox({limit:25,filter:'attention'})
 assert.deepEqual(first.items,[]);assert.equal(first.scannedCount,200);assert.equal(first.scanIncomplete,true);assert.ok(first.nextCursor)
 const second=await repo().listInbox({limit:25,filter:'attention',before:first.nextCursor})
 assert.deepEqual(second.items.map(r=>r.id),[match]);assert.equal(second.scannedCount,2);assert.equal(second.scanIncomplete,false);assert.equal(second.nextCursor,null)
})

test('a full page advances only 25 consumed cases out of 201 fetched and never skips equal-time ties',async()=>{
 await publish();const seed=await create();await copies(seed,205)
 const expected=(await db.admin.query('SELECT id FROM atrium.service_cases ORDER BY created_at DESC,id DESC')).rows.map(r=>r.id)
 const all=[];let before
 do {
  const page=await repo().listInbox({limit:25,filter:'all',...(before?{before}:{})})
  assert.equal(page.scanIncomplete,false);assert.equal(page.scannedCount,page.items.length)
  if(page.nextCursor)assert.deepEqual(page.nextCursor,{id:page.items.at(-1).id,createdAt:page.items.at(-1).createdAt})
  all.push(...page.items.map(r=>r.id));before=page.nextCursor
 }while(before)
 assert.deepEqual(all,expected);assert.equal(new Set(all).size,206)
})

test('an exhausted nonmatching scan is distinguishable from a capped empty scan',async()=>{
 await publish();const seed=await create(),saved=await prepare(seed,{details:details({maximumCents:10000})})
 await copies(seed,200,'2020-01-01T00:00:00.123Z',{planId:saved.id})
 const first=await repo().listInbox({limit:25,filter:'attention'})
 assert.equal(first.scannedCount,200);assert.equal(first.scanIncomplete,true);assert.ok(first.nextCursor)
 const last=await repo().listInbox({limit:25,filter:'attention',before:first.nextCursor})
 assert.deepEqual(last.items,[]);assert.equal(last.scannedCount,1);assert.equal(last.nextCursor,null);assert.equal(last.scanIncomplete,false)
})

test('one joined projection per read reuses approval authority per actor and keeps graph work bounded',async()=>{
 await publish();const seed=await create(),saved=await prepare(seed)
 await repo('admin-a').execute(decision(seed,saved.id),proofs.get('admin-a'))
 const decisionId=(await repo().getPlan(seed)).decision.id
 await copies(seed,230,'2020-01-01T00:00:00.123Z',{planId:saved.id,decisionId})
 const seen=[],page=await repo('staff-a',observe(db.app,seen)).listInbox({limit:25,filter:'attention'})
 assert.equal(seen.length,2);assert.equal(page.scannedCount,200);assert.equal(page.scanIncomplete,true);assert.deepEqual(page.items,[])
 assert.equal(seen[0][1][5],201);assert.equal(seen[1][1][6].length,201)
 for(const [sql] of seen){assert.equal(sql.includes('resident_json('),false);assert.equal(sql.includes('resident_context_state('),false);assert.equal(sql.includes('maintenance_plan_events'),false)}
 const explained=await db.app.transaction(scopeContext(scopes.get('staff-a')),c=>c.query('EXPLAIN (ANALYZE,FORMAT JSON) '+seen[0][0],seen[0][1]))
 const nodes=[]
 const walk=v=>{if(!v||typeof v!=='object')return;nodes.push(v);for(const child of Object.values(v))if(Array.isArray(child))child.forEach(walk);else walk(child)}
 walk(explained.rows[0]['QUERY PLAN'])
 const actor=nodes.find(n=>n['Subplan Name']==='CTE inbox_approvers')
 assert.ok(actor,'materialized approver graph is visible in query plan');assert.equal(actor['Actual Loops'],1);assert.equal(actor['Actual Rows'],1)
})

test('property and unit filters run before scanning while viewer, channel and sessionless access stays denied',async()=>{
 await publish();const own=await create(),common=await create({location:{kind:'common_area',label:'Lobby'}})
 await create({},'owner-b');await create({},'sibling')
 const page=await repo().listInbox({limit:25,filter:'all',unitId:'shared-unit'})
 assert.deepEqual(page.items.map(r=>r.id),[own]);assert.equal(page.scannedCount,1)
 assert.equal((await repo().listInbox({limit:25,filter:'all'})).items.some(r=>r.id===common),true)
 assert.throws(()=>repo('viewer-a'),{code:'forbidden'})
 const channel=await runtime.authorization.authorizeChannel('vapi','synthetic-assistant-a','operate')
 assert.throws(()=>new PostgresMaintenancePlanningRepository(db.app,channel,{configurationVersion:1}),{code:'forbidden'})
 const internal=await runtime.authorization.authorizeProperty(await runtime.authorization.authenticatePassword('owner-a',password),'property-a1','operate')
 assert.throws(()=>new PostgresMaintenancePlanningRepository(db.app,internal,{configurationVersion:1}),{code:'forbidden'})
 for(const input of [{limit:51,filter:'all'},{limit:25,filter:'unknown'},{limit:25,filter:'all',before:{id:'invalid',createdAt:new Date().toISOString()}},{limit:25,filter:'all',complete:true}])await assert.rejects(repo().listInbox(input),{code:'planning_invalid_input'})
})

test('global policy and approver changes surface in a refreshed inbox without changing the request timestamp',async()=>{
 await publish();const caseId=await create(),saved=await prepare(caseId)
 await repo('admin-a').execute(decision(caseId,saved.id),proofs.get('admin-a'))
 const original=(await repo().getPlan(caseId)).request.updatedAt
 assert.equal((await repo().listInbox({limit:25,filter:'attention'})).items.length,0)
 await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-admin-a'")
 let page=await repo().listInbox({limit:25,filter:'attention'})
 assert.equal(page.items[0].assessment.readiness,'stale_plan');assert.equal(page.items[0].updatedAt,original);assert.equal(page.items[0].nextStep.kind,'revise_plan')
 await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-admin-a'")
 await publish(policy(),1)
 page=await repo().listInbox({limit:25,filter:'attention'})
 assert.equal(page.policyVersion,2);assert.equal(page.items[0].updatedAt,original);assert.equal(page.items[0].assessment.readiness,'stale_plan')
})

test('refresh deadline includes vendor availability, source expiry and property-local residency boundaries',async()=>{
 const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10)
 await publish(policy({validUntil:new Date(Date.now()+7*86400000).toISOString()}))
 const resident=await services().execute({action:'add_resident',requestId:randomUUID(),reason:'Synthetic occupancy source',details:{unitId:'shared-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:tomorrow,phone:null,email:null,
  source:{kind:'staff_review',reference:'Synthetic local date evidence',version:'1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+6*86400000).toISOString()}}})
 const caseId=await create({requestOrigin:'resident_report',residentId:resident.id});await prepare(caseId,{details:details({maximumCents:10000})})
 const midnight=(await db.admin.query("SELECT atrium.service_iso($1::date::timestamp AT TIME ZONE time_zone) AS stamp FROM atrium.properties WHERE id='property-a1'",[tomorrow])).rows[0].stamp
 assert.equal((await repo().listInbox({limit:25,filter:'all'})).refreshAt,midnight)
 const availabilityUntil=new Date(Date.now()+90000).toISOString()
 const v=await saveVendor(vendor({availability:'available',availabilityObservedAt:new Date(Date.now()-1000).toISOString(),availabilityValidUntil:availabilityUntil}))
 await prepare(caseId,{expectedPlanVersion:1,details:details({route:'vendor',vendorId:v.id,vendorVersion:1,internalTeam:null})})
 assert.equal((await repo().listInbox({limit:25,filter:'all'})).refreshAt,availabilityUntil)
})

test('distinct current approvers are evaluated twice for a 201-row graph rather than once per decision',async()=>{
 await publish()
 for(const user of ['owner-a','admin-a']){
  const caseId=await create(),plan=await prepare(caseId)
  await repo(user).execute(decision(caseId,plan.id),proofs.get(user))
  const decisionId=(await repo().getPlan(caseId)).decision.id
  await copies(caseId,110,'2020-01-01T00:00:00.123Z',{planId:plan.id,decisionId})
 }
 const seen=[],page=await repo('staff-a',observe(db.app,seen)).listInbox({limit:25,filter:'all'})
 assert.equal(page.items.length,25);assert.ok(page.items.every(r=>r.assessment.readiness==='authorized_plan'))
 const explained=await db.app.transaction(scopeContext(scopes.get('staff-a')),c=>c.query('EXPLAIN (ANALYZE,FORMAT JSON) '+seen[0][0],seen[0][1]))
 const nodes=[];const walk=v=>{if(!v||typeof v!=='object')return;nodes.push(v);for(const child of Object.values(v))if(Array.isArray(child))child.forEach(walk);else walk(child)}
 walk(explained.rows[0]['QUERY PLAN'])
 const grouped=nodes.find(n=>n['Subplan Name']==='CTE inbox_approvers')
 assert.equal(grouped['Actual Rows'],2);assert.equal(grouped['Actual Loops'],1)
 await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-admin-a'")
 const attention=await repo('staff-a').listInbox({limit:50,filter:'attention'})
 assert.equal(attention.items.length,50);assert.ok(attention.items.every(r=>r.assessment.readiness==='stale_plan'))
})

for(const state of ['not_started','ended'])test(`inbox residency ${state} agrees with detail and property-local exclusive dates`,async()=>{
 await publish(policy({validUntil:new Date(Date.now()+7*86400000).toISOString()}))
 const local=(await db.admin.query("SELECT ((clock_timestamp() AT TIME ZONE time_zone)::date)::text AS today,((clock_timestamp() AT TIME ZONE time_zone)::date+1)::text AS tomorrow FROM atrium.properties WHERE id='property-a1'")).rows[0]
 const startsOn=state==='not_started'?local.tomorrow:'2020-01-01',endsOn=state==='ended'?local.today:null
 const resident=await services().execute({action:'add_resident',requestId:randomUUID(),reason:'Review synthetic date-specific occupancy',details:{unitId:'shared-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn,endsOn,phone:null,email:null,
  source:{kind:'staff_review',reference:'Synthetic local occupancy dates',version:'1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+6*86400000).toISOString()}}})
 // Staff observations may be planned for an otherwise vacant unit; this does not
 // convert an ended or future occupancy into resident/entry authority.
 const caseId=await create({residentId:resident.id});await prepare(caseId,{details:details({maximumCents:10000})})
 const seen=[],page=await repo('owner-a',observe(db.app,seen)).listInbox({limit:25,filter:'all'}),detail=await repo().getPlan(caseId)
 const graph=await db.app.transaction(scopeContext(scopes.get('owner-a')),c=>c.query(...seen[0]))
 assert.equal(graph.rows[0].candidates[0].resident.contextState,state);assert.equal(detail.resident.state,state)
 assert.deepEqual(page.items[0].assessment,detail.assessment);assert.equal(page.items[0].assessment.entryAuthorized,false)
 if(state==='not_started'){
  const midnight=(await db.admin.query("SELECT atrium.service_iso($1::date::timestamp AT TIME ZONE time_zone) AS at FROM atrium.properties WHERE id='property-a1'",[startsOn])).rows[0].at
  assert.equal(page.refreshAt,midnight)
 }
})

test('source evidence expiration caps the page before a later policy deadline',async()=>{
 await publish(policy({validUntil:new Date(Date.now()+7*86400000).toISOString()}))
 const until=new Date(Date.now()+90000).toISOString()
 const resident=await services().execute({action:'add_resident',requestId:randomUUID(),reason:'Review synthetic source freshness',details:{unitId:'shared-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:null,phone:null,email:null,
  source:{kind:'staff_review',reference:'Synthetic short freshness record',version:'1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:until}}})
 const caseId=await create({requestOrigin:'resident_report',residentId:resident.id});await prepare(caseId,{details:details({maximumCents:10000})})
 const page=await repo().listInbox({limit:25,filter:'all'}),detail=await repo().getPlan(caseId)
 assert.equal(detail.resident.state,'current');assert.equal(page.refreshAt,until);assert.deepEqual(page.items[0].assessment,detail.assessment)
})
