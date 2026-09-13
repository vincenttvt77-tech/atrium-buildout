import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'
import {createDatabaseRuntime} from '../../src/application/runtime.ts'
import {PostgresResidentServicesRepository} from '../../src/database/resident-services.ts'
import {scopeContext} from '../../src/database/scope.ts'
import {verifyMfaSession,TEST_AUTH_ORIGIN} from '../helpers/mfa-session.mjs'

let db,runtime,password
const principals=new Map(),scopes=new Map()
const tables=['service_events','service_commands','service_cases','resident_events','resident_sources','property_residents','organization_people']
const planningTables=['maintenance_commands','maintenance_plan_events','maintenance_decisions','maintenance_plans','maintenance_vendors','maintenance_policies']
before(async()=>{
 db=await createFoundationTestDatabase();({password}=await seedFoundationTestDatabase(db.admin))
 runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-resident-services-session-secret',authOrigin:TEST_AUTH_ORIGIN})
 for(const [org,property] of [['organization-a','property-a1'],['organization-a','property-a2'],['organization-b','property-b1']]) {
  for(const v of [1,2])await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
   VALUES($1,$2,$3,'published',$4::jsonb,clock_timestamp(),'synthetic service catalogue',clock_timestamp())`,
  [org,property,v,JSON.stringify({property:{id:property},inventory:[{unitId:'shared-unit'},{unitId:'second-unit'}],floorplans:[],knowledge:[]})])
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1',[property])
 }
 for(const name of ['owner-a','owner-b','staff-a','viewer-a']) {
  const principal=await runtime.sessions.start(await runtime.authorization.authenticatePassword(name,password),{label:'Synthetic service operator'})
  await verifyMfaSession(runtime,principal,password);principals.set(name,principal)
  scopes.set(name,await runtime.authorization.authorizeProperty(principal,name==='owner-b'?'property-b1':'property-a1','read'))
 }
 scopes.set('sibling',await runtime.authorization.authorizeProperty(principals.get('owner-a'),'property-a2','operate'))
})
beforeEach(async()=>{
 await db.admin.query(`TRUNCATE ${[...planningTables,...tables].map(t=>`atrium.${t}`).join(',')}`)
 await db.admin.query("UPDATE atrium.memberships SET status='active'")
 await db.admin.query("UPDATE atrium.property_grants SET status='active'")
 await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id IN ('property-a1','property-a2','property-b1')")
})
after(async()=>{await db?.close()})
const repo=(name='owner-a',connection=db.app,configurationVersion=1)=>new PostgresResidentServicesRepository(connection,scopes.get(name),{configurationVersion})
const source=(extra={})=>({kind:'staff_review',reference:'Synthetic staff occupancy register',version:'review-1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString(),...extra})
const add=(extra={})=>({action:'add_resident',requestId:randomUUID(),reason:'Staff reviewed a synthetic occupancy record',details:{unitId:'shared-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:null,phone:'+12025550100',email:'resident@example.test',source:source()},...extra})
const intake=(extra={})=>({requestOrigin:'resident_report',location:{kind:'unit',unitId:'shared-unit'},residentId:null,summary:'Kitchen cabinet hinge loose',description:'The cupboard door needs adjustment.',category:'other',reportedPriority:'routine',reporterName:null,reporterPhone:null,reporterEmail:null,accessNotes:'',...extra})
const create=(extra={})=>({action:'create_request',requestId:randomUUID(),intake:intake(extra)})
const triage=(id,expectedVersion=1,extra={})=>({action:'triage_request',requestId:randomUUID(),id,expectedVersion,state:'ready_for_planning',priority:'routine',note:'Staff reviewed the reported issue.',...extra})
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,Number((await db.admin.query(`SELECT count(*) FROM atrium.${t}`)).rows[0].count)])))

test('configure records normalized property occupancy with exact replay and immutable source/event history',async()=>{
 const command=add(),receipt=await repo().execute(command),record=await repo().getResident(receipt.id)
 assert.equal(record.displayName,command.details.displayName);assert.equal(record.contextState,'current');assert.equal(record.version,1)
 assert.notEqual(record.id,record.personId);assert.equal(record.reviewedBy,'owner-a');assert.deepEqual(record.source,command.details.source)
 assert.equal((await repo().execute(command)).replayed,true)
 await assert.rejects(repo().execute({...command,reason:'Contradictory receipt'}),{code:'service_request_conflict'})
 assert.deepEqual(await counts(),{service_events:0,service_commands:1,service_cases:0,resident_events:1,resident_sources:1,property_residents:1,organization_people:1})
 const transactions=(await db.admin.query(['organization_people','property_residents','resident_sources','resident_events','service_commands'].map(t=>`SELECT xmin::text xid FROM atrium.${t}`).join(' UNION '))).rows
 assert.equal(transactions.length,1)
 const {unitId,...details}=command.details
 await repo().execute({action:'review_resident',requestId:randomUUID(),id:record.id,expectedVersion:1,details:{...details,displayName:'Staff corrected name',source:source({version:'review-2'})},reason:'Corrected property observation'})
 assert.equal((await repo().getResident(record.id)).displayName,'Staff corrected name')
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.resident_sources')).rows[0].count),2)
 await assert.rejects(db.admin.query('UPDATE atrium.resident_sources SET display_name=$1',['Forged']),/immutable/i)
})

test('staff intake and triage preserve unverified reporter and never imply dispatch, entry or notification',async()=>{
 const resident=await repo().execute(add())
 const saved=await repo('staff-a').execute(create({residentId:resident.id})),detail=await repo('staff-a').getCase(saved.id)
 assert.equal(detail.request.residentVersionAtIntake,1);assert.equal(detail.request.residentNameAtIntake,'Synthetic resident')
 assert.equal(detail.resident.state,'current');assert.equal(detail.request.callerIdentityVerified,false);assert.equal(detail.request.entryAuthorized,false)
 assert.equal(detail.request.dispatchStatus,'not_dispatched');assert.equal(detail.request.notificationStatus,'not_sent')
 assert.equal(detail.events.length,1);assert.equal(detail.events[0].kind,'intake')
 await repo('staff-a').execute(triage(saved.id))
 assert.equal((await repo().getCase(saved.id)).request.state,'ready_for_planning')
 await assert.rejects(repo('staff-a').execute(add()),{code:'forbidden'})
})

test('people/contact observations and direct reads never cross organization or sibling property',async()=>{
 const a=await repo().execute(add()),b=await repo('owner-b').execute(add()),sibling=await repo('sibling').execute(add())
 assert.equal(new Set((await db.admin.query('SELECT person_id FROM atrium.property_residents')).rows.map(r=>r.person_id)).size,3)
 assert.equal(await repo().getResident(b.id),null);assert.equal(await repo().getResident(sibling.id),null)
 assert.deepEqual((await repo().listResidents({limit:100})).map(r=>r.id),[a.id])
 await assert.rejects(repo().execute(create({residentId:b.id})),{code:'service_invalid_input'})
 await assert.rejects(repo().execute(create({residentId:a.id,location:{kind:'unit',unitId:'second-unit'}})),{code:'service_invalid_input'})
 const seen=await db.app.transaction(scopeContext(scopes.get('owner-a')),async c=>(await c.query('SELECT organization_id,property_id FROM atrium.property_residents')).rows)
 assert.deepEqual(seen,[{organization_id:'organization-a',property_id:'property-a1'}])
 const people=await db.app.transaction(scopeContext(scopes.get('owner-a')),async c=>(await c.query('SELECT id FROM atrium.organization_people')).rows)
 assert.equal(people.length,1);assert.equal(people[0].id,(await repo().getResident(a.id)).personId)
})

test('viewer/channel/sessionless contexts refuse repository and raw scoped records',async()=>{
 await repo().execute(add())
 assert.throws(()=>repo('viewer-a'),{code:'forbidden'})
 const channel=await runtime.authorization.authorizeChannel('vapi','synthetic-assistant-a','operate')
 assert.throws(()=>new PostgresResidentServicesRepository(db.app,channel,{configurationVersion:1}),{code:'forbidden'})
 const internal=await runtime.authorization.authorizeProperty(await runtime.authorization.authenticatePassword('owner-a',password),'property-a1','operate')
 assert.throws(()=>new PostgresResidentServicesRepository(db.app,internal,{configurationVersion:1}),{code:'forbidden'})
 for(const scope of [scopes.get('viewer-a'),channel,internal]) {
  assert.equal((await db.app.transaction(scopeContext(scope),c=>c.query('SELECT * FROM atrium.property_residents'))).rowCount,0)
 }
 for(const sql of ["SELECT * FROM atrium.service_commands","INSERT INTO atrium.organization_people(organization_id,id) VALUES('organization-a',gen_random_uuid())",
  'UPDATE atrium.property_residents SET status=\'revoked\'','SET ROLE atrium_resident_services_executor'])await assert.rejects(db.app.transaction(scopeContext(scopes.get('owner-a')),c=>c.query(sql)),{code:'42501'})
})

test('current occupancy gates resident planning, while staff observations and common areas need no fabricated resident',async()=>{
 const unknown=await repo().execute(create())
 await assert.rejects(repo().execute(triage(unknown.id)),{code:'service_context_required'})
 const vacant=await repo().execute(create({requestOrigin:'staff_observation'}))
 await repo().execute(triage(vacant.id))
 const common=await repo().execute(create({location:{kind:'common_area',label:'Lobby'}}))
 await repo().execute(triage(common.id))
 const noLocation=await repo().execute(create({requestOrigin:'staff_observation',location:{kind:'unknown',label:'Needs location'}}))
 await assert.rejects(repo().execute(triage(noLocation.id)),{code:'service_context_required'})
 const resident=await repo().execute(add()),request=await repo().execute(create({residentId:resident.id}))
 await repo().execute(triage(request.id))
 await repo().execute({action:'revoke_resident',requestId:randomUUID(),id:resident.id,expectedVersion:1,reason:'Staff revoked the occupancy evidence'})
 const detail=await repo().getCase(request.id)
 assert.equal(detail.request.state,'ready_for_planning');assert.equal(detail.request.version,2);assert.equal(detail.request.contextNeedsReview,true)
 assert.equal(detail.resident.state,'revoked');assert.equal(detail.request.residentVersionAtIntake,1)
 const attention=await repo().listCases({limit:100,states:['needs_triage'],includeContextReview:true})
 assert.ok(attention.some(r=>r.id===request.id));assert.ok(!attention.some(r=>r.id===vacant.id||r.id===common.id))
})

test('emergency at intake, note or triage stays held and cannot be downgraded',async()=>{
 const saved=await repo().execute(create({description:'I smell gas in the kitchen.'}))
 let detail=await repo().getCase(saved.id)
 assert.equal(detail.request.state,'emergency_review');assert.deepEqual(detail.request.emergencyKinds,['gas'])
 await assert.rejects(repo().execute(triage(saved.id)),{code:'service_emergency_hold'})
 await repo().execute({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:1,note:'Staff is reviewing the saved report.'})
 detail=await repo().getCase(saved.id);assert.equal(detail.request.priority,'emergency');assert.equal(detail.events.length,2)
 for(const action of ['add_note','triage_request']) {
  const ordinary=await repo().execute(create({requestOrigin:'staff_observation'}))
  await repo().execute(action==='add_note'?{action,requestId:randomUUID(),id:ordinary.id,expectedVersion:1,note:'There is smoke coming from the room.'}:triage(ordinary.id,1,{note:'There is smoke coming from the room.'}))
  assert.equal((await repo().getCase(ordinary.id)).request.state,'emergency_review')
 }
})

test('failed audit and stale revisions roll back normalized changes and exact receipt insertion',async()=>{
 const saved=await repo().execute(create()),before=await counts()
 await db.admin.query('REVOKE INSERT ON atrium.service_events FROM atrium_resident_services_executor')
 try {await assert.rejects(repo().execute({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:1,note:'This must roll back.'}),{code:'service_unavailable'})}
 finally {await db.admin.query('GRANT INSERT ON atrium.service_events TO atrium_resident_services_executor')}
 assert.deepEqual(await counts(),before);assert.equal((await repo().getCase(saved.id)).request.version,1)
 await repo().execute({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:1,note:'A committed staff note.'})
 await assert.rejects(repo().execute(triage(saved.id)),{code:'service_version_conflict'})
 assert.equal((await repo().getCase(saved.id)).events.length,2)
})

test('source dates/freshness and scoped unit/config validation refuse fabricated active context',async()=>{
 const past=add();past.details.source=source({observedAt:'2020-01-01T00:00:00.000Z',validUntil:'2020-01-02T00:00:00.000Z'})
 await assert.rejects(repo().execute(past),{code:'service_invalid_input'})
 const short=add();short.details.source=source({validUntil:new Date(Date.now()+350).toISOString()})
 const shortReceipt=await repo().execute(short)
 await delay(360)
 assert.equal((await repo().getResident(shortReceipt.id)).contextState,'expired')
 assert.equal((await repo().execute(short)).replayed,true)
 const {unitId,...expiredDetails}=past.details
 await assert.rejects(repo().execute({action:'review_resident',requestId:randomUUID(),id:shortReceipt.id,expectedVersion:1,details:expiredDetails,reason:'Expired evidence must refuse'}),{code:'service_invalid_input'})
 const ended=add();ended.details.endsOn='2020-02-01'
 assert.equal((await repo().getResident((await repo().execute(ended)).id)).contextState,'ended')
 const future=add();future.details.startsOn='2099-01-01'
 assert.equal((await repo().getResident((await repo().execute(future)).id)).contextState,'not_started')
 const fabricated=add();fabricated.details.source=source({observedAt:new Date(Date.now()+86400000).toISOString(),validUntil:new Date(Date.now()+172800000).toISOString()})
 await assert.rejects(repo().execute(fabricated),{code:'service_invalid_input'})
 const wrongUnit=add();wrongUnit.details.unitId='foreign-unit';await assert.rejects(repo().execute(wrongUnit),{code:'service_invalid_input'})
 await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
 await assert.rejects(repo().execute(create()),{code:'property_configuration_changed'})
})

test('case and resident cursors are bounded and retain exact equal-millisecond ordering',async()=>{
 const first=await repo().execute(create({requestOrigin:'staff_observation'})),resident=await repo().execute(add())
 // Controlled pagination fixture copies validated synthetic rows with a common DB timestamp.
 await db.admin.query(`INSERT INTO atrium.service_cases SELECT (jsonb_populate_record(NULL::atrium.service_cases,
   to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'created_at','2020-01-01T00:00:00.123Z'))).*
   FROM atrium.service_cases c CROSS JOIN generate_series(1,6) WHERE c.id=$1`,[first.id])
 let before,all=[]
 do {
  const page=await repo().listCases({limit:2,...(before?{before}:{})});all.push(...page.map(row=>row.id))
  before=page.length?{createdAt:page.at(-1).createdAt,id:page.at(-1).id}:null
 }while(before)
 assert.equal(all.length,7);assert.equal(new Set(all).size,7)
 assert.deepEqual(all,(await db.admin.query('SELECT id FROM atrium.service_cases ORDER BY created_at DESC,id DESC')).rows.map(row=>row.id))
 assert.equal((await repo().listResidents({limit:1}))[0].id,resident.id)
 assert.deepEqual(await repo().listResidents({limit:1,before:{createdAt:(await repo().getResident(resident.id)).createdAt,id:resident.id}}),[])
 for(const query of [{limit:0},{limit:102},{limit:3,before:{createdAt:'2020-01-01T00:00:00.123Z',id:'not-a-uuid'}}]) {
  await assert.rejects(repo().listCases(query),{code:'service_invalid_input'})
 }
})

test('initial case history has 25 events plus a continuation and attention filtering precedes its page limit',async()=>{
 const residency=await repo().execute(add()),saved=await repo().execute(create({residentId:residency.id}))
 for(let version=1;version<=26;version++)await repo().execute({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:version,note:`Synthetic history observation ${version}`})
 let detail=await repo().getCase(saved.id)
 assert.equal(detail.events.length,25);assert.equal(detail.eventsTruncated,true);assert.ok(detail.nextEventsCursor)
 const remainder=await repo().listEvents(saved.id,{limit:25,before:detail.nextEventsCursor})
 assert.equal(remainder.length,2);assert.equal(new Set([...detail.events,...remainder].map(row=>row.id)).size,27)
 await repo().execute(triage(saved.id,27))
 for(let i=0;i<4;i++) {const other=await repo().execute(create({requestOrigin:'staff_observation'}));await repo().execute(triage(other.id))}
 await repo().execute({action:'revoke_resident',requestId:randomUUID(),id:residency.id,expectedVersion:1,reason:'Residency source was revoked'})
 assert.deepEqual((await repo().listCases({limit:1,states:['needs_triage'],includeContextReview:true})).map(row=>row.id),[saved.id])
 assert.equal((await repo().getCase(saved.id)).request.version,28)
})

test('staff can clarify unknown intake and link reviewed occupancy without changing original report or granting entry',async()=>{
 const added=add(),resident=await repo().execute(added)
 const saved=await repo().execute(create({requestOrigin:'unknown',location:{kind:'unknown',label:'Location not yet known'}}))
 const command={action:'update_context',requestId:randomUUID(),id:saved.id,expectedVersion:1,location:{kind:'unit',unitId:'shared-unit'},residentId:resident.id,note:'Staff matched the report to the reviewed property record.'}
 await repo('staff-a').execute(command)
 assert.equal((await repo('staff-a').execute(command)).replayed,true)
 let detail=await repo().getCase(saved.id)
 assert.deepEqual(detail.request.location,command.location);assert.equal(detail.request.residentId,resident.id)
 assert.deepEqual(detail.request.intakeLocation,{kind:'unknown',label:'Location not yet known'});assert.equal(detail.request.residentIdAtIntake,null)
 assert.equal(detail.request.residentNameAtIntake,null);assert.equal(detail.request.requestOrigin,'unknown');assert.equal(detail.request.state,'needs_triage')
 const event=detail.events.find(row=>row.kind==='context')
 assert.deepEqual(event.contextLocation,command.location);assert.equal(event.contextResidentId,resident.id)
 assert.equal(event.contextResidentVersion,1);assert.equal(event.contextResidentName,added.details.displayName)
 await repo('staff-a').execute(triage(saved.id,2))
 await repo('staff-a').execute({...command,requestId:randomUUID(),expectedVersion:3,location:{kind:'common_area',label:'Lobby'},residentId:null})
 detail=await repo().getCase(saved.id)
 assert.equal(detail.request.state,'needs_triage');assert.equal(detail.resident.state,'not_established');assert.equal(detail.request.residentId,null)
 assert.equal(detail.request.callerIdentityVerified,false);assert.equal(detail.request.entryAuthorized,false)
 const {unitId,...details}=added.details
 await repo().execute({action:'review_resident',requestId:randomUUID(),id:resident.id,expectedVersion:1,details:{...details,displayName:'Later name correction'},reason:'Updated source observation'})
 assert.equal((await repo().getCase(saved.id)).events.find(row=>row.caseVersion===2).contextResidentName,added.details.displayName)
 await assert.rejects(repo('staff-a').execute({...command,requestId:randomUUID()}),{code:'service_version_conflict'})
})

test('context changes reject foreign or wrong-unit links, preserve emergency, and roll back on audit failure',async()=>{
 const own=await repo().execute(add()),foreign=await repo('owner-b').execute(add()),saved=await repo().execute(create({residentId:own.id}))
 const command={action:'update_context',requestId:randomUUID(),id:saved.id,expectedVersion:1,location:{kind:'unit',unitId:'shared-unit'},residentId:own.id,note:'Staff reviewed the property context.'}
 await assert.rejects(repo().execute({...command,residentId:foreign.id}),{code:'service_invalid_input'})
 await assert.rejects(repo().execute({...command,location:{kind:'unit',unitId:'second-unit'}}),{code:'service_invalid_input'})
 const before=await counts()
 await db.admin.query('REVOKE INSERT ON atrium.service_events FROM atrium_resident_services_executor')
 try {await assert.rejects(repo().execute({...command,residentId:null,location:{kind:'common_area',label:'Lobby'}}),{code:'service_unavailable'})}
 finally {await db.admin.query('GRANT INSERT ON atrium.service_events TO atrium_resident_services_executor')}
 assert.deepEqual(await counts(),before);assert.equal((await repo().getCase(saved.id)).request.residentId,own.id)
 await repo().execute({...command,note:'I smell gas in this unit.'})
 let detail=await repo().getCase(saved.id)
 assert.equal(detail.request.state,'emergency_review');assert.deepEqual(detail.request.emergencyKinds,['gas'])
 await repo().execute({...command,requestId:randomUUID(),expectedVersion:2,residentId:null,location:{kind:'common_area',label:'Hallway'}})
 detail=await repo().getCase(saved.id)
 assert.equal(detail.request.state,'emergency_review');assert.equal(detail.request.residentIdAtIntake,own.id)
 assert.equal(detail.request.residentNameAtIntake,'Synthetic resident');assert.deepEqual(detail.request.intakeLocation,{kind:'unit',unitId:'shared-unit'})
})

test('direct finite commands reject malformed envelopes and cannot mutate identity or source snapshots',async()=>{
 const valid=add()
 for(const input of [null,[],{...valid,requestId:null},{...valid,requestId:123},{...valid,unexpected:true},
  {...valid,details:{...valid.details,source:{...valid.details.source,kind:'pms'}}}]) {
  await assert.rejects(db.app.transaction(scopeContext(scopes.get('owner-a')),c=>c.query('SELECT atrium.execute_resident_service($1::jsonb,1,$2::text[])',[JSON.stringify(input),[]])),{code:'P0001'})
 }
 assert.equal((await counts()).organization_people,0)
 const saved=await repo().execute(create())
 await assert.rejects(db.admin.query("UPDATE atrium.service_cases SET request_origin='staff_observation' WHERE id=$1",[saved.id]),/immutable/i)
 await assert.rejects(db.admin.query("UPDATE atrium.service_cases SET intake_location_label='Changed' WHERE id=$1",[saved.id]),/immutable/i)
 await assert.rejects(db.admin.query('DELETE FROM atrium.service_events WHERE case_id=$1',[saved.id]),/immutable/i)
})

test('removed inventory units make historical planning attention-worthy even for staff observations before pagination',async()=>{
 const saved=await repo().execute(create({requestOrigin:'staff_observation'}));await repo().execute(triage(saved.id))
 for(let i=0;i<3;i++) {
  const current=await repo().execute(create({requestOrigin:'staff_observation',location:{kind:'unit',unitId:'second-unit'}}))
  await repo().execute(triage(current.id))
 }
 await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
   VALUES('organization-a','property-a1',3,'published',$1::jsonb,clock_timestamp(),'synthetic reduced unit catalogue',clock_timestamp())`,
 [JSON.stringify({property:{id:'property-a1'},inventory:[{unitId:'second-unit'}],floorplans:[],knowledge:[]})])
 await db.admin.query("UPDATE atrium.properties SET published_configuration_version=3 WHERE id='property-a1'")
 const current=repo('owner-a',db.app,3),detail=await current.getCase(saved.id)
 assert.equal(detail.request.state,'ready_for_planning');assert.equal(detail.request.version,2);assert.equal(detail.request.contextNeedsReview,true)
 assert.deepEqual(detail.request.location,{kind:'unit',unitId:'shared-unit'})
 assert.deepEqual((await current.listCases({limit:1,states:['needs_triage'],includeContextReview:true})).map(row=>row.id),[saved.id])
 await assert.rejects(current.execute(triage(saved.id,2)),{code:'service_context_required'})
})
