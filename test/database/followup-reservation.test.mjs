import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'
import {createAuthorizationService} from '../../src/auth/index.ts'
import {PgAuthorizationRepository} from '../../src/database/authorization.ts'
import {PostgresDocumentStore} from '../../src/database/operations.ts'
import {consolidateCall,listFollowUps,followUpKey} from '../../src/leads/consolidate.ts'
import {emptyQualification} from '../../src/leasing/qualification.ts'

let db,authorization,password
const original={callId:'original-call',phone:'+12025550101',at:new Date('2032-06-01T14:00:00Z'),durationSeconds:60,
  qualification:emptyQualification(),name:'Synthetic visitor',email:null,unitsDiscussed:['4A'],
  booking:{externalId:'reservation-a',slotId:'slot-2032-06-05T21:00',startsAt:'2032-06-05T21:00:00.000Z',unitId:'4A',status:'confirmed'},
  lossReason:null,escalation:null,toolsCalled:['book_tour']}
before(async()=>{
  db=await createFoundationTestDatabase();db.app.pool.options.max=3
  ;({password}=await seedFoundationTestDatabase(db.admin))
  authorization=createAuthorizationService(new PgAuthorizationRepository(db.auth))
  for(const [org,property] of [['organization-a','property-a1'],['organization-a','property-a2'],['organization-b','property-b1']]){
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,now(),'synthetic follow-up fixture',now())`,[org,property,JSON.stringify({property:{id:property},inventory:[],floorplans:[],knowledge:[]})])
  }
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id IN ('property-a1','property-a2','property-b1')")
})
beforeEach(async()=>{await db.admin.query('TRUNCATE atrium.operational_documents,atrium.audit_events')})
after(async()=>{await db?.close()})
async function store(property='property-a1',user='owner-a'){
  const principal=await authorization.authenticatePassword(user,password)
  const scope=await authorization.authorizeProperty(principal,property,'operate')
  return new PostgresDocumentStore(db.app,scope,{requestId:'followup-identity-test',configurationVersion:1})
}
const project=(s,call=original)=>s.transaction(unit=>consolidateCall(unit,call))
const saved=()=>db.admin.query('SELECT organization_id,property_id,key,value FROM atrium.operational_documents ORDER BY organization_id,property_id,key').then(result=>result.rows)
function prior(row){
  const b=row.source.booking,key=createHash('sha256').update(JSON.stringify([row.phone.replace(/\D/g,''),row.kind,'booking',JSON.stringify([b.slotId,b.startsAt,b.unitId])])).digest('hex')
  return {...row,id:'fu-v2-'+key,source:{...row.source,key},status:'done',reason:'Staff decision retained',dueAt:'2032-06-04T16:07:00.000Z'}
}
async function legacy(s){const first=await project(s),old=first.followUps.map(prior)
  await s.transaction(async unit=>{for(const row of first.followUps)await unit.delete(followUpKey(row.id));for(const row of old)await unit.set(followUpKey(row.id),row)})
  return old
}

test('real persisted same-time reservations retain separate work through parallel retries and property boundaries',async()=>{
  const a=await store(),b=await store('property-a2'),foreign=await store('property-b1','owner-b')
  await project(b);await project(foreign)
  const before=(await saved()).filter(row=>row.property_id!=='property-a1')
  const second={...original,callId:'second-call',at:new Date('2032-06-01T14:10:00Z'),booking:{...original.booking,externalId:'reservation-b'}}
  await Promise.all([project(a),project(a,second)]);await Promise.all([project(a),project(a,second)])
  assert.ok(db.app.pool.totalCount>=2,'parallel projections must use multiple real database connections')
  const rows=await a.transaction(listFollowUps);assert.equal(rows.length,8)
  for(const id of ['reservation-a','reservation-b'])assert.equal(rows.filter(row=>row.source.booking.externalId===id).length,4)
  assert.deepEqual((await saved()).filter(row=>row.property_id!=='property-a1'),before)
})

test('persisted old v2 task IDs and staff decisions survive upgrade and concurrent replay',async()=>{
  const s=await store(),old=await legacy(s)
  await Promise.all([project(s),project(s)]);await project(s)
  const rows=await s.transaction(listFollowUps);assert.equal(rows.length,old.length)
  for(const item of old){const next=rows.find(row=>row.id===item.id);assert.ok(next);assert.notEqual(next.source.key,item.source.key);assert.deepEqual({...next,source:item.source},item)}
})

test('failed atomic identity upgrade rolls back profile, tasks and audit; retry recovers original decisions',async()=>{
  const s=await store(),old=await legacy(s),before=await saved()
  const audits=(await db.admin.query('SELECT count(*)::int count FROM atrium.audit_events')).rows[0].count
  await assert.rejects(s.transaction(async unit=>{
    let n=0
    return consolidateCall({...unit,update:async(key,initial,fn)=>{
      if(key.startsWith('followup:')&&++n===2)throw new Error('injected upgrade failure')
      return unit.update(key,initial,fn)
    }},original)
  }),/injected upgrade failure/)
  assert.deepEqual(await saved(),before)
  assert.equal((await db.admin.query('SELECT count(*)::int count FROM atrium.audit_events')).rows[0].count,audits)
  await project(s);const rows=await s.transaction(listFollowUps)
  assert.equal(rows.length,old.length);assert.ok(rows.every(row=>row.status==='done'&&row.reason==='Staff decision retained'))
})
