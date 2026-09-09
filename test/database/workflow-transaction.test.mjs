import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'

let db, authorization, password
const properties=[['organization-a','property-a1'],['organization-a','property-a2'],['organization-b','property-b1'],['organization-b','property-b2']]
const tables=['inbox_events','action_intents','outbox_messages','workflow_events','operational_documents','audit_events']
before(async () => {
  db=await createFoundationTestDatabase()
  ;({password}=await seedFoundationTestDatabase(db.admin))
  authorization=createAuthorizationService(new PgAuthorizationRepository(db.auth))
  for (const [org,property] of properties) for (const version of [1,2]) {
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,$3,'published',$4::jsonb,now(),'synthetic workflow transaction fixture',now())`,
    [org,property,version,JSON.stringify({property:{id:property},inventory:[],floorplans:[],knowledge:[]})])
  }
})
beforeEach(async () => {
  await db.admin.query(`TRUNCATE ${tables.map(table=>`atrium.${table}`).join(',')}`)
  await db.admin.query("UPDATE atrium.memberships SET status='active'")
  await db.admin.query("UPDATE atrium.property_grants SET status='active'")
  await db.admin.query("UPDATE atrium.properties SET status='active',published_configuration_version=1")
})
after(async () => { await db?.close() })
async function scope(user='owner-a',property='property-a1',permission='operate') {
  const principal=await authorization.authenticatePassword(user,password)
  assert.ok(principal)
  return authorization.authorizeProperty(principal,property,permission)
}
const repo=(selected,connection=db.app)=>new PostgresWorkflowRepository(connection,selected,{requestId:'workflow-unit',configurationVersion:1})
const receipt=(overrides={})=>({source:'synthetic',eventId:'ended-one',payload:{callId:'synthetic-call'},
  actions:[{kind:'call.project',connector:'local',operationKey:'project-one',input:{callId:'synthetic-call'},maxAttempts:2}],...overrides})
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,Number((await db.admin.query(`SELECT count(*) FROM atrium.${table}`)).rows[0].count)])))
const assertEmpty=async()=>assert.deepEqual(await counts(),Object.fromEntries(tables.map(table=>[table,0])))
const documents=async()=>(await db.admin.query('SELECT organization_id,property_id,key,value FROM atrium.operational_documents ORDER BY organization_id,property_id,key')).rows
function observe(connection,beforeQuery=async()=>{},afterQuery=async()=>{}) {
  const state={transactions:0}
  return {state,transaction:(context,work)=>{
    state.transactions++
    return connection.transaction(context,client=>work(new Proxy(client,{
      get(target,key) {
        if(key==='query')return async(...args)=>{await beforeQuery(target,args[0],args[1]);const result=await target.query(...args);await afterQuery(target,args[0],args[1]);return result}
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
      }
    })))
  }}
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}

test('normalized workflow intake and call document/audit commit together on exactly one max-one pool transaction',async()=>{
  const observed=observe(db.app),repository=repo(await scope(),observed)
  const accepted=await repository.transaction(async unit=>{
    assert.equal(Object.isFrozen(unit),true)
    assert.equal(Object.isFrozen(unit.documents),true)
    assert.equal(Object.isFrozen(unit.workflows),true)
    await unit.documents.set('call:synthetic-call',{ended:false})
    const result=await unit.workflows.accept(receipt({actions:[receipt().actions[0],{...receipt().actions[0],operationKey:'second-action'}]}))
    await unit.documents.update('call:synthetic-call',{},value=>({...value,ended:true,receiptId:result.receiptId}))
    assert.deepEqual((await unit.workflows.list()).map(action=>action.id).sort(),result.actions.map(action=>action.id).sort())
    assert.equal((await unit.workflows.get(result.actions[0].id)).receiptId,result.receiptId)
    return result
  })
  assert.equal(observed.state.transactions,1)
  assert.equal(db.app.pool.options.max,1)
  assert.equal((await documents())[0].value.receiptId,accepted.receiptId)
  assert.deepEqual(await counts(),{inbox_events:1,action_intents:2,outbox_messages:2,workflow_events:2,operational_documents:1,audit_events:2})
  const xids=(await db.admin.query(tables.map(table=>`SELECT xmin::text AS xid FROM atrium.${table}`).join(' UNION '))).rows
  assert.equal(xids.length,1)
})

test('callback throw rolls back receipt/actions/outbox/events plus documents/audits',async()=>{
  await assert.rejects(repo(await scope()).transaction(async unit=>{
    await unit.workflows.accept(receipt())
    await unit.documents.set('call:synthetic-call',{ended:true})
    throw new Error('synthetic callback failure')
  }),/synthetic callback failure/)
  await assertEmpty()
})

test('a real SQL audit failure after intake rolls back the complete unit',async()=>{
  const observed=observe(db.app,async(client,text)=>{
    if(String(text).startsWith('INSERT INTO atrium.audit_events'))await client.query('SELECT 1 / 0')
  })
  await assert.rejects(repo(await scope(),observed).transaction(async unit=>{
    await unit.workflows.accept(receipt())
    await unit.documents.set('call:synthetic-call',{ended:true})
  }),{code:'22012'})
  await assertEmpty()
})

test('caught workflow validation errors poison document changes instead of permitting partial commit',async()=>{
  const repository=repo(await scope())
  for(const fail of [unit=>unit.workflows.accept(receipt({actions:[]})),unit=>unit.workflows.get(''),
    unit=>unit.workflows.list({limit:101}),unit=>unit.workflows.list({states:['unknown']}),
    unit=>unit.workflows.list({before:{createdAt:'invalid',id:'valid'}})]) {
    await assert.rejects(repository.transaction(async unit=>{
      await unit.documents.set('must-rollback',{ended:true})
      try{await fail(unit)}catch{}
    }),{code:'workflow_invalid_input'})
    await assertEmpty()
  }
})

test('duplicate receipt conflicts roll back accompanying document edits and retain original normalized rows',async()=>{
  const repository=repo(await scope())
  const first=await repository.transaction(async unit=>{
    const accepted=await unit.workflows.accept(receipt())
    await unit.documents.set('call:synthetic-call',{receiptId:accepted.receiptId,original:true})
    return accepted
  })
  const originalCounts=await counts(),originalDocuments=await documents()
  await assert.rejects(repository.transaction(async unit=>{
    await unit.documents.update('call:synthetic-call',{},value=>({...value,original:false}))
    await unit.workflows.accept(receipt({payload:{callId:'changed-call'}}))
  }),{code:'workflow_receipt_conflict'})
  assert.deepEqual(await counts(),originalCounts)
  assert.deepEqual(await documents(),originalDocuments)
  assert.equal((await repository.get(first.actions[0].id)).state,'queued')
})

test('captured ports expire without exposing nested transactions, raw clients or mutable scope',async()=>{
  const observed=observe(db.app),repository=repo(await scope(),observed)
  let unit,get
  await repository.transaction(async active=>{unit=active;get=active.workflows.get})
  for(const port of [unit.documents,unit.workflows])for(const key of ['transaction','connection','scope','client'])assert.equal(key in port,false)
  for(const call of [()=>unit.documents.get('call:x'),()=>unit.documents.set('call:x',{}),()=>unit.documents.list(''),
    ()=>unit.workflows.accept(receipt()),()=>get('unknown-action'),()=>unit.workflows.list({limit:0}),
    ()=>unit.workflows.claim({workerId:'worker',leaseMs:1000}),()=>unit.workflows.startDispatch({}),
    ()=>unit.workflows.startVerification({}),()=>unit.workflows.settle({},{}),
    ()=>unit.workflows.replay('unknown-action','reason'),()=>unit.workflows.cancel('unknown-action','reason')]) {
    await assert.rejects(call(),{code:'workflow_transaction_closed'})
  }
  assert.throws(()=>unit.documents.describe(),{code:'workflow_transaction_closed'})
  assert.equal(observed.state.transactions,1)
  await assertEmpty()
})

test('unfinished intake is drained before rollback and closed ports cannot enqueue later document writes',async()=>{
  const entered=deferred(),release=deferred()
  const observed=observe(db.app,async(_client,text)=>{
    if(String(text).startsWith('INSERT INTO atrium.inbox_events')){entered.resolve();await release.promise}
  })
  let unit
  const pending=repo(await scope(),observed).transaction(async active=>{unit=active;void active.workflows.accept(receipt())})
  const rejected=assert.rejects(pending,{code:'workflow_transaction_incomplete'})
  await entered.promise
  await assert.rejects(unit.documents.set('late',{}),{code:'workflow_transaction_closed'})
  release.resolve()
  await rejected
  await assertEmpty()
})

test('mixed Promise.all operations serialize original-actor checks and document mutations on the same client',async()=>{
  const staff=repo(await scope('staff-a'))
  const accepted=await staff.accept(receipt())
  const documentActors=[]
  const observed=observe(db.app,async()=>{},async(client,text)=>{
    if(String(text).includes('atrium.operational_documents')) {
      documentActors.push((await client.query("SELECT current_setting('atrium.actor_user_id',true) AS actor")).rows[0].actor)
    }
  })
  const worker=repo(await scope(),observed)
  const claim=await worker.claim({workerId:'owner-worker',leaseMs:30000})
  observed.state.transactions=0
  await worker.transaction(async unit=>{
    const results=await Promise.all([
      unit.workflows.startDispatch(claim),
      unit.documents.set('worker-note',{owner:true}),
      unit.documents.update('counter',{count:0},value=>({count:value.count+1})),
      unit.workflows.get(accepted.actions[0].id),
      unit.documents.update('counter',{count:0},value=>({count:value.count+1})),
    ])
    assert.equal(results[0].status,'ready')
    assert.equal(results[3].origin.userId,'staff-a')
    assert.deepEqual(results[4],{count:2})
  })
  assert.equal(observed.state.transactions,1)
  assert.ok(documentActors.length>=5)
  assert.ok(documentActors.every(actor=>actor==='owner-a'))
  assert.ok((await db.admin.query('SELECT actor_user_id FROM atrium.audit_events')).rows.every(row=>row.actor_user_id==='owner-a'))
})

test('two organizations and two properties cannot see each other through either composed port',async()=>{
  const accepted=[]
  for(const [org,property] of properties) {
    const repository=repo(await scope(org==='organization-a'?'owner-a':'owner-b',property))
    accepted.push(await repository.transaction(async unit=>{
      await unit.documents.set('same-call',{property})
      const result=await unit.workflows.accept(receipt())
      assert.equal((await unit.workflows.list()).length,1)
      assert.deepEqual(await unit.documents.get('same-call'),{property})
      if(accepted.length)assert.equal(await unit.workflows.get(accepted[0].actions[0].id),null)
      return result
    }))
  }
  assert.equal(new Set(accepted.map(result=>result.actions[0].operationKey)).size,4)
  assert.equal((await documents()).length,4)
})

test('document prefix escaping and maximum result bounds survive composed ports',async()=>{
  const repository=repo(await scope())
  await repository.transaction(async unit=>{
    await unit.documents.set('literal%_key',{})
    await unit.documents.set('literal-other',{})
    assert.deepEqual(await unit.documents.list('literal%_'),['literal%_key'])
  })
  await db.admin.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value)
    SELECT 'organization-a','property-a1','bulk:'||generate_series(1,5001),'{}'::jsonb`)
  const baseline=await counts()
  await assert.rejects(repository.transaction(async unit=>{
    await unit.workflows.accept(receipt())
    await unit.documents.list('bulk:')
  }),/paginated operational query/)
  assert.deepEqual(await counts(),baseline)
})

test('viewer cannot enter a write unit and operate-only staff cannot replay or cancel through it',async()=>{
  let called=false
  await assert.rejects(repo(await scope('viewer-a','property-a1','read')).transaction(async()=>{called=true}),{code:'forbidden'})
  assert.equal(called,false)
  const staff=repo(await scope('staff-a')),accepted=await staff.accept(receipt())
  const baseline=await counts()
  for(const method of ['replay','cancel']) {
    await assert.rejects(staff.transaction(async unit=>{
      await unit.documents.set('unauthorized',{})
      try{await unit.workflows[method](accepted.actions[0].id,'reviewed')}catch{}
    }),{code:'forbidden'})
    assert.deepEqual(await counts(),baseline)
    assert.equal((await staff.get(accepted.actions[0].id)).state,'queued')
  }
})

for(const [name,sql,code] of [
  ['membership',"UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'",'forbidden'],
  ['property',"UPDATE atrium.properties SET status='inactive' WHERE id='property-a1'",'forbidden'],
  ['configuration',"UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'",'property_configuration_changed'],
])test(`${name} changes before the exit gate roll back all six record families`,async()=>{
  await assert.rejects(repo(await scope()).transaction(async unit=>{
    await unit.workflows.accept(receipt())
    await unit.documents.set('call:synthetic-call',{ended:true})
    await db.admin.query(sql)
  }),{code})
  await assertEmpty()
})
