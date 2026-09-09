import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {randomBytes} from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import calendar from '../../api/calendar.ts'
import leads from '../../api/leads.ts'
import health from '../../api/health.ts'
import {createDatabaseRuntime,runWithPropertyRuntime} from '../../src/application/runtime.ts'
import {documentStoreFromEnv} from '../../src/store/documents.ts'
import {calendarStoreFromEnv} from '../../src/calendar/store.ts'
import {emptyProfile} from '../../src/leads/profile.ts'
import {profileKey} from '../../src/leads/consolidate.ts'
import {PostgresCalendarStore,PostgresDocumentStore} from '../../src/database/operations.ts'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'

const keys=['ATRIUM_RUNTIME_MODE','ATRIUM_DATABASE_URL','ATRIUM_AUTH_DATABASE_URL','ATRIUM_SIMULATION','OPS_SESSION_SECRET']
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]))
const phone='+12125550123'
const settings={capacity:3,slotMinutes:45,startIntervalMinutes:15,bufferMinutes:10,minimumNoticeMinutes:0,bookingWindowDays:null,sameUnitPolicy:'exclusive',hours:{1:{openHour:8,closeHour:19},2:{openHour:8,closeHour:19},3:{openHour:8,closeHour:19},4:{openHour:8,closeHour:19},5:{openHour:8,closeHour:19}}}
const buildings=[['organization-a','property-a1','America/New_York','NY'],['organization-a','property-a2','America/Chicago','IL'],['organization-b','property-b1','America/Los_Angeles','CA']]
let db,runtime,server,origin,credentials,inject=true
const cookies={}
async function publish([org,id,zone,jurisdiction],version=1){
  const bundle={property:{id,organizationId:org,buildingName:id,timeZone:zone,jurisdiction,tourSettings:{...settings,capacity:id==='property-a2'?1:3}},inventory:[],floorplans:[],knowledge:[]}
  await db.admin.query('BEGIN')
  try {
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,$3,'published',$4,'2026-09-09T12:00:00Z','synthetic-ops-http','2026-09-09T12:00:00Z')`,[org,id,version,JSON.stringify(bundle)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2',[org,id,version])
    await db.admin.query('COMMIT')
  }catch(error){await db.admin.query('ROLLBACK');throw error}
}
before(async()=>{
  for(const key of keys)delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE='postgres'
  db=await createFoundationTestDatabase();credentials=await seedFoundationTestDatabase(db.admin)
  runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:randomBytes(36).toString('base64url')})
  for(const building of buildings){
    await publish(building)
    const profile={...emptyProfile(phone,new Date()),name:building[1]}
    await db.admin.query('INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4)',[building[0],building[1],profileKey(phone),JSON.stringify(profile)])
  }
  server=createServer(async(req,res)=>{
    try{
      if(inject)req.atriumRuntime=runtime
      let raw='';for await(const chunk of req)raw+=chunk
      try{req.body=JSON.parse(raw)}catch{req.body=raw}
      const url=new URL(req.url,'http://localhost');req.query=Object.fromEntries(url.searchParams)
      res.status=code=>{res.statusCode=code;return res}
      res.send=body=>{res.end(body);return res}
      res.json=body=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(body));return res}
      await ({'/api/dashboard':dashboard,'/api/calendar':calendar,'/api/leads':leads,'/api/health':health}[url.pathname])(req,res)
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:'test-server-failed'}))}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`
  for(const username of ['owner-a','owner-b','staff-a','viewer-a']){
    const response=await fetch(`${origin}/api/dashboard`,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password:credentials.password})})
    assert.equal(response.status,303);cookies[username]=response.headers.get('set-cookie').split(';')[0];await response.text()
  }
})
after(async()=>{
  if(server){server.close();server.closeAllConnections();await once(server,'close')}
  if(db)await db.close()
  for(const key of keys)original[key]===undefined?delete process.env[key]:process.env[key]=original[key]
})
async function request(path,{user='owner-a',property='property-a1',org='organization-a',version=1,body,headers={}}={}){
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[user],
    'x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':String(version),
    ...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})})
  return {status:response.status,body:await response.json()}
}
const range='/api/calendar?from=2032-01-01&to=2032-01-07'

test('calendar uses published hours and capacity without a two-week navigation limit',async()=>{
  const [a,b]=await Promise.all([request(range),request(range,{property:'property-a2'})])
  assert.equal(a.status,200);assert.equal(b.status,200)
  assert.equal(a.body.capacity,3);assert.equal(b.body.capacity,1)
  assert.equal(a.body.settings.slotMinutes,45);assert.equal(a.body.timeZone,'America/New_York');assert.equal(b.body.timeZone,'America/Chicago')
  assert.ok(a.body.slots.length>0);assert.equal(a.body.range.from,'2032-01-01')
  assert.equal(a.body.store.kind,'postgres');assert.equal(a.body.store.durable,true)
  assert.equal(a.body.scope.propertyId,'property-a1');assert.equal(b.body.scope.propertyId,'property-a2')
})

test('same contact and concurrent notes remain isolated across two tabs and two organizations',async()=>{
  const selections=[{}, {property:'property-a2'}, {user:'owner-b',org:'organization-b',property:'property-b1'}]
  const responses=await Promise.all(selections.map((selection,i)=>request('/api/leads',{...selection,body:{action:'note',phone,text:`Synthetic note ${i}`}})))
  assert.ok(responses.every(response=>response.status===200))
  const reads=await Promise.all(selections.map(selection=>request('/api/leads',selection)))
  for(const [i,response] of reads.entries()){
    assert.equal(response.body.profiles.length,1)
    assert.equal(response.body.profiles[0].name,['property-a1','property-a2','property-b1'][i])
    assert.equal(response.body.profiles[0].notes.length,1)
    assert.match(response.body.profiles[0].notes[0],new RegExp(`Synthetic note ${i}$`))
  }
})

test('a time block in one building cannot close the same date in another building',async()=>{
  const result=await request('/api/calendar',{body:{action:'block',target:'2032-01-05',reason:'Synthetic inspection',from:'2032-01-01',to:'2032-01-07',expectedTimeZone:'America/New_York'}})
  assert.equal(result.status,200);assert.equal(result.body.blocks.length,1)
  assert.deepEqual((await request(range,{property:'property-a2'})).body.blocks,[])
  assert.equal((await request('/api/calendar',{body:{action:'block',target:'2032-01-05',expectedTimeZone:'America/Chicago'}})).status,409)
})

test('staff and viewers cannot change showing configuration, and viewers cannot write notes or blocks',async()=>{
  for(const user of ['staff-a','viewer-a']){
    const result=await request('/api/calendar',{user,body:{action:'settings',settings:{...settings,capacity:50},settingsRevision:0,expectedTimeZone:'America/New_York'}})
    assert.equal(result.status,403)
  }
  assert.equal((await request('/api/leads',{user:'viewer-a'})).status,200)
  assert.equal((await request('/api/leads',{user:'viewer-a',body:{action:'note',phone,text:'not allowed'}})).status,403)
  assert.equal((await request('/api/calendar',{user:'viewer-a',body:{action:'block',target:'2032-01-06',expectedTimeZone:'America/New_York'}})).status,403)
  const changed=await request('/api/calendar',{body:{action:'settings',settings:{...settings,capacity:4},settingsRevision:0,expectedTimeZone:'America/New_York'}})
  assert.equal(changed.status,200);assert.equal(changed.body.capacity,4)
  const conflict=await request('/api/calendar',{body:{action:'settings',settings,settingsRevision:0,expectedTimeZone:'America/New_York'}})
  assert.equal(conflict.status,409)
})

test('missing or foreign selection and stale versions fail before mutation, while durable resets are forbidden',async()=>{
  for(const path of ['/api/calendar','/api/leads']){
    assert.equal((await request(path,{headers:{'x-atrium-config-version':''}})).status,400)
    assert.equal((await request(path,{org:'organization-b',property:'property-b1'})).status,403)
    assert.equal((await request(path,{org:'organization-b'})).status,403)
    assert.equal((await request(path,{user:'staff-a',property:'property-a2'})).status,403)
    const stale=await request(path,{version:999});assert.equal(stale.status,409);assert.equal(stale.body.code,'property_configuration_changed')
    const noScope=await fetch(origin+path,{headers:{cookie:cookies['owner-a']}});assert.equal(noScope.status,428);await noScope.text()
  }
  assert.equal((await request('/api/leads',{body:{action:'clear_leads'}})).status,403)
  assert.equal((await request('/api/calendar',{body:{action:'clear_bookings',expectedTimeZone:'America/New_York'}})).status,403)
})

test('module-level stores select each current runtime and refuse an unscoped database operation',async()=>{
  const documents=documentStoreFromEnv(),store=calendarStoreFromEnv()
  assert.throws(()=>documents.get(profileKey(phone)),/authorized database property/)
  assert.throws(()=>store.read(),/authorized database property/)
  const principal=await runtime.authorization.authenticatePassword('owner-a',credentials.password)
  const scopes=await Promise.all(['property-a1','property-a2'].map(propertyId=>runtime.loadUserProperty(principal,{organizationId:'organization-a',propertyId},'read')))
  const rows=await Promise.all(scopes.map(scope=>runWithPropertyRuntime(scope,()=>documents.get(profileKey(phone)))))
  assert.deepEqual(rows.map(row=>row.name),['property-a1','property-a2'])
})

test('configuration publication during a mutation rolls back data and audit before returning',async()=>{
  const principal=await runtime.authorization.authenticatePassword('owner-a',credentials.password)
  const resolved=await runtime.loadUserProperty(principal,{organizationId:'organization-a',propertyId:'property-a1'},'operate')
  let published=false
  const connection={transaction(context,work){return db.app.transaction(context,client=>work(new Proxy(client,{get(target,key){
    if(key!=='query')return Reflect.get(target,key)
    return async(...args)=>{const result=await client.query(...args);if(!published&&String(args[0]).includes('INSERT INTO atrium.audit_events')){published=true;await publish(buildings[0],2)}return result}
  }})))}}
  const documents=new PostgresDocumentStore(connection,resolved.scope,{requestId:'configuration-race',configurationVersion:1})
  await assert.rejects(documents.set('must-rollback',{changed:true}),{code:'property_configuration_changed'})
  assert.equal(published,true)
  assert.equal((await db.admin.query("SELECT 1 FROM atrium.operational_documents WHERE key='must-rollback'")).rowCount,0)
  assert.equal((await db.admin.query("SELECT 1 FROM atrium.audit_events WHERE request_id='configuration-race'")).rowCount,0)
  const response=await request('/api/leads');assert.equal(response.status,409)
  assert.equal((await request('/api/leads',{version:2})).status,200)
})

test('an admin demoted during showing configuration cannot finish with only staff permissions',async()=>{
  const principal=await runtime.authorization.authenticatePassword('owner-a',credentials.password)
  const resolved=await runtime.loadUserProperty(principal,{organizationId:'organization-a',propertyId:'property-a1'},'configure')
  let demoted=false
  const connection={transaction(context,work){return db.app.transaction(context,client=>work(new Proxy(client,{get(target,key){
    if(key!=='query')return Reflect.get(target,key)
    return async(...args)=>{const result=await client.query(...args);if(!demoted&&String(args[0]).includes('INSERT INTO atrium.audit_events')){demoted=true;await db.admin.query("UPDATE atrium.memberships SET role='staff',permission_version=permission_version+1 WHERE id='member-owner-a'")}return result}
  }})))}}
  const before=(await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state
  try{
    const store=new PostgresCalendarStore(connection,resolved.scope,{requestId:'configuration-role-race',configurationVersion:2},'configure')
    await assert.rejects(store.mutate(state=>({...state,settings:{...settings,capacity:40}})),{code:'forbidden'})
    assert.equal(demoted,true)
    assert.deepEqual((await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state,before)
  }finally{await db.admin.query("UPDATE atrium.memberships SET role='owner',permission_version=permission_version+1 WHERE id='member-owner-a'")}
})

test('database health is unscoped and outages cannot silently reopen memory storage',async()=>{
  const result=await request('/api/health');assert.equal(result.status,200);assert.equal(result.body.store,'postgres');assert.equal(result.body.durable,true)
  assert.equal(JSON.stringify(result.body).includes('organization-a'),false)
  inject=false
  try{for(const path of ['/api/calendar','/api/leads','/api/health']){const result=await request(path);assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.body),/postgres:\/\/|password|property-a1/)}}
  finally{inject=true}
})
