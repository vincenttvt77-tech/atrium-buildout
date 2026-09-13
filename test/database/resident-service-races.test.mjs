import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'
import {createDatabaseRuntime} from '../../src/application/runtime.ts'
import {PostgresResidentServicesRepository} from '../../src/database/resident-services.ts'
import {verifyMfaSession,TEST_AUTH_ORIGIN} from '../helpers/mfa-session.mjs'

let db,runtime,connection,owner,staff,password,ownerScope,staffScope
const tables=['service_events','service_commands','service_cases','resident_events','resident_sources','property_residents','organization_people']
const planningTables=['maintenance_commands','maintenance_plan_events','maintenance_decisions','maintenance_plans','maintenance_vendors','maintenance_policies']
before(async()=>{
 db=await createFoundationTestDatabase();({password}=await seedFoundationTestDatabase(db.admin));connection=db.createAppConnection()
 runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-resident-service-race-secret',authOrigin:TEST_AUTH_ORIGIN})
 for(const v of [1,2])await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
 VALUES('organization-a','property-a1',$1,'published',$2::jsonb,clock_timestamp(),'synthetic service race catalogue',clock_timestamp())`,
 [v,JSON.stringify({property:{id:'property-a1'},inventory:[{unitId:'synthetic-unit'}],floorplans:[],knowledge:[]})])
 for(const name of ['owner-a','staff-a']) {
  const principal=await runtime.sessions.start(await runtime.authorization.authenticatePassword(name,password),{label:'Synthetic service race'})
  await verifyMfaSession(runtime,principal,password)
  if(name==='owner-a')owner=principal;else staff=principal
 }
 ownerScope=await runtime.authorization.authorizeProperty(owner,'property-a1','configure');staffScope=await runtime.authorization.authorizeProperty(staff,'property-a1','operate')
})
beforeEach(async()=>{
 await db.admin.query(`TRUNCATE ${[...planningTables,...tables].map(t=>`atrium.${t}`).join(',')}`)
 await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
 await db.admin.query("UPDATE atrium.memberships SET status='active'")
 await db.admin.query("UPDATE atrium.property_grants SET status='active'")
})
after(async()=>{await connection?.close();await db?.close()})
const repo=(scope=ownerScope,c=db.app)=>new PostgresResidentServicesRepository(c,scope,{configurationVersion:1})
const source=(until=new Date(Date.now()+86400000).toISOString())=>({kind:'staff_review',reference:'Synthetic occupancy source',version:'1',observedAt:new Date(Date.now()-60000).toISOString(),validUntil:until})
const add=()=>({action:'add_resident',requestId:randomUUID(),reason:'Reviewed synthetic occupancy source',details:{unitId:'synthetic-unit',displayName:'Synthetic resident',relationship:'occupant',startsOn:'2020-01-01',endsOn:null,phone:null,email:null,source:source()}})
const intake=(residentId=null)=>({action:'create_request',requestId:randomUUID(),intake:{requestOrigin:'resident_report',location:{kind:'unit',unitId:'synthetic-unit'},residentId,
 summary:'Wardrobe handle loose',description:'Tighten the loose screw.',category:'other',reportedPriority:'routine',reporterName:null,reporterPhone:null,reporterEmail:null,accessNotes:''}})
const triage=(id)=>({action:'triage_request',requestId:randomUUID(),id,expectedVersion:1,state:'ready_for_planning',priority:'routine',note:'Reviewed planning prerequisites'})
const count=async(table)=>Number((await db.admin.query(`SELECT count(*) FROM atrium.${table}`)).rows[0].count)
async function blocked(query='execute_resident_service') {
 for(let i=0;i<150;i++) {
  await db.admin.query('SELECT pg_stat_clear_snapshot()')
  if((await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",[`%${query}%`])).rowCount)return
  await delay(10)
 }
 assert.fail('Command did not reach the expected native lock')
}

test('simultaneous identical admission commits one case/event/receipt and changed same-key manifest conflicts',async()=>{
 const command=intake(),results=await Promise.all([repo().execute(command),repo(ownerScope,connection).execute(command)])
 assert.equal(new Set(results.map(r=>r.id)).size,1);assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true])
 assert.equal(await count('service_cases'),1);assert.equal(await count('service_events'),1);assert.equal(await count('service_commands'),1)
 await assert.rejects(repo().execute({...command,intake:{...command.intake,summary:'Contradictory report'}}),{code:'service_request_conflict'})
})

test('same expected revision has one winner and no overwritten staff note',async()=>{
 const saved=await repo().execute(intake())
 const command=(note)=>({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:1,note})
 const results=await Promise.allSettled([repo().execute(command('First staff observation')),repo(ownerScope,connection).execute(command('Second staff observation'))])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'service_version_conflict')
 assert.equal((await repo().getCase(saved.id)).request.version,2);assert.equal(await count('service_events'),2);assert.equal(await count('service_commands'),2)
})

for(const action of ['add_resident','review_resident'])test(`${action} source expires during audit lock wait and rolls back every new row`,async()=>{
 let command=add(),baseline=0
 if(action==='review_resident') {
  const saved=await repo().execute(command);const {unitId,...details}=command.details
  command={action,requestId:randomUUID(),id:saved.id,expectedVersion:1,details,reason:'Renew source with short fixture validity'};baseline=1
 }
 command.details.source=source(new Date(Date.now()+600).toISOString())
 await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.resident_events IN ACCESS EXCLUSIVE MODE')
 const pending=repo().execute(command),rejected=assert.rejects(pending,{code:'service_invalid_input'})
 try {await blocked();await delay(650);await db.admin.query('COMMIT');await rejected}finally{await db.admin.query('ROLLBACK')}
 for(const t of ['organization_people','property_residents','resident_sources','resident_events','service_commands'])assert.equal(await count(t),baseline,t)
 if(baseline)assert.equal((await repo().getResident(command.id)).version,1)
})

test('planning context expires during event insertion wait and cannot commit stale readiness',async()=>{
 const command=add();command.details.source=source(new Date(Date.now()+900).toISOString())
 const resident=await repo().execute(command),saved=await repo().execute(intake(resident.id))
 await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.service_events IN ACCESS EXCLUSIVE MODE')
 const pending=repo().execute(triage(saved.id)),rejected=assert.rejects(pending,{code:'service_context_required'})
 try {await blocked();await delay(950);await db.admin.query('COMMIT');await rejected}finally{await db.admin.query('ROLLBACK')}
 assert.equal((await repo().getCase(saved.id)).request.state,'needs_triage');assert.equal(await count('service_events'),1);assert.equal(await count('service_commands'),2)
})

test('grant revocation while a case event waits rolls back the pending mutation and receipt',async()=>{
 const saved=await repo().execute(intake())
 await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.service_events IN ACCESS EXCLUSIVE MODE')
 const pending=repo(staffScope,connection).execute({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:1,note:'This staff edit must roll back.'})
 const rejected=assert.rejects(pending,{code:'forbidden'})
 try {await blocked();await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-staff-a'");await db.admin.query('COMMIT');await rejected}
 finally{await db.admin.query('ROLLBACK')}
 assert.equal((await repo().getCase(saved.id)).request.version,1);assert.equal(await count('service_events'),1);assert.equal(await count('service_commands'),1)
})

test('residency revocation winning its row lock prevents later unit planning',async()=>{
 const resident=await repo().execute(add()),saved=await repo().execute(intake(resident.id))
 await db.admin.query('BEGIN');await db.admin.query('SELECT 1 FROM atrium.property_residents WHERE id=$1 FOR UPDATE',[resident.id])
 const pending=repo(ownerScope,connection).execute(triage(saved.id)),rejected=assert.rejects(pending,{code:'service_context_required'})
 try {
  await blocked();await db.admin.query("UPDATE atrium.property_residents SET status='revoked',version=version+1 WHERE id=$1",[resident.id]);await db.admin.query('COMMIT');await rejected
 }finally{await db.admin.query('ROLLBACK')}
 assert.equal((await repo().getCase(saved.id)).request.state,'needs_triage')
})

test('session revocation follows admitted commit and rejects reuse of the captured repository',async()=>{
 const principal=await runtime.sessions.start(await runtime.authorization.authenticatePassword('owner-a',password),{label:'Synthetic revocation race'})
 await verifyMfaSession(runtime,principal,password)
 const scope=await runtime.authorization.authorizeProperty(principal,'property-a1','operate'),selected=repo(scope,connection)
 await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.service_events IN ACCESS EXCLUSIVE MODE')
 const pending=selected.execute(intake());let revoked=false
 try {
  await blocked();const revocation=runtime.sessions.revoke(owner,principal.sessionId).then(()=>{revoked=true})
  await blocked('revoke_user_sessions');assert.equal(revoked,false)
  await db.admin.query('COMMIT');await pending;await revocation
 }finally{await db.admin.query('ROLLBACK')}
 await assert.rejects(selected.listCases({limit:10}),{code:'forbidden'});assert.equal(await count('service_cases'),1)
})

test('two cases can swap scoped resident links without lock inversion and a competing context revision cannot overwrite',async()=>{
 const a=await repo().execute(add()),b=await repo().execute(add())
 const ca=await repo().execute(intake(a.id)),cb=await repo().execute(intake(b.id))
 const update=(id,residentId)=>({action:'update_context',requestId:randomUUID(),id,expectedVersion:1,location:{kind:'unit',unitId:'synthetic-unit'},residentId,note:'Staff clarified the linked property record.'})
 await Promise.all([repo().execute(update(ca.id,b.id)),repo(ownerScope,connection).execute(update(cb.id,a.id))])
 assert.equal((await repo().getCase(ca.id)).request.residentId,b.id);assert.equal((await repo().getCase(cb.id)).request.residentId,a.id)
 const commands=[{...update(ca.id,a.id),expectedVersion:2},{...update(ca.id,b.id),expectedVersion:2}]
 const result=await Promise.allSettled([repo().execute(commands[0]),repo(ownerScope,connection).execute(commands[1])])
 assert.equal(result.filter(row=>row.status==='fulfilled').length,1);assert.equal(result.find(row=>row.status==='rejected').reason.code,'service_version_conflict')
 assert.equal((await repo().getCase(ca.id)).events.length,3)
})

function afterFirstCaseRead(work) {
 let invoked=false
 return {role:db.app.role,transaction:(context,callback)=>db.app.transaction(context,client=>callback(new Proxy(client,{
  get(target,key) {
   if(key==='query')return async(...args)=>{
    const result=await target.query(...args)
    if(!invoked&&String(args[0]).startsWith('WITH selected_service_property')){invoked=true;await work()}
    return result
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }
 })))}
}

for(const change of ['note','context','source_review','source_revoke'])test(`detail refuses a mixed snapshot when ${change} commits after its first case read`,async()=>{
 const residentCommand=add(),resident=await repo().execute(residentCommand),saved=await repo().execute(intake(resident.id))
 await repo().execute(triage(saved.id))
 const concurrent=repo(ownerScope,connection)
 const observed=afterFirstCaseRead(async()=>{
  if(change==='note')await concurrent.execute({action:'add_note',requestId:randomUUID(),id:saved.id,expectedVersion:2,note:'Newer observation committed between reads.'})
  if(change==='context')await concurrent.execute({action:'update_context',requestId:randomUUID(),id:saved.id,expectedVersion:2,
   location:{kind:'common_area',label:'Revised staff location'},residentId:null,note:'Staff clarified a different location.'})
  if(change==='source_review') {
   const {unitId,...details}=residentCommand.details
   await concurrent.execute({action:'review_resident',requestId:randomUUID(),id:resident.id,expectedVersion:1,details:{...details,displayName:'Newer property observation'},reason:'Fresh source review between detail reads'})
  }
  if(change==='source_revoke')await concurrent.execute({action:'revoke_resident',requestId:randomUUID(),id:resident.id,expectedVersion:1,reason:'Source revoked between detail reads'})
 })
 await assert.rejects(repo(ownerScope,observed).getCase(saved.id),{code:'service_version_conflict'})
 const current=await repo().getCase(saved.id)
 if(change==='note'||change==='context')assert.equal(current.request.version,3)
 else assert.equal(current.resident.residentVersion,2)
})
