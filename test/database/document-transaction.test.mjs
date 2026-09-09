import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresDocumentStore, createTransactionDocumentStore } from '../../src/database/operations.ts'
import { propertyTransaction } from '../../src/database/scope.ts'

let db, authorization, password
const properties = [['organization-a','property-a1'],['organization-a','property-a2'],['organization-b','property-b1'],['organization-b','property-b2']]
before(async () => {
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  for (const [org, property] of properties) {
    for (const version of [1,2]) {
      await db.admin.query(`INSERT INTO atrium.property_configurations
        (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
        VALUES($1,$2,$3,'published',$4::jsonb,now(),'synthetic transaction fixture',now())`,
      [org,property,version,JSON.stringify({property:{id:property},inventory:[],floorplans:[],knowledge:[]})])
    }
  }
})
beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.audit_events,atrium.operational_documents')
  await db.admin.query("UPDATE atrium.memberships SET status='active'")
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1')
})
after(async () => { await db?.close() })
async function scope(user = 'owner-a', property = 'property-a1', permission = 'operate') {
  const principal = await authorization.authenticatePassword(user,password)
  assert.ok(principal)
  return authorization.authorizeProperty(principal,property,permission)
}
const store = (selected, connection = db.app, requestId = 'document-unit') =>
  new PostgresDocumentStore(connection,selected,{requestId,configurationVersion:1})
const records = async () => (await db.admin.query('SELECT organization_id,property_id,key,value FROM atrium.operational_documents ORDER BY organization_id,property_id,key')).rows
const audits = async () => (await db.admin.query('SELECT operation,record_key,request_id,configuration_version FROM atrium.audit_events ORDER BY operation')).rows
function observe(connection, onQuery = async () => {}) {
  const state = { transactions: 0 }
  return { state, transaction: (context,work) => {
    state.transactions++
    return connection.transaction(context,client => work(new Proxy(client,{
      get(target,key) {
        if (key === 'query') return async (...args) => { await onQuery(args[0],args[1]); return target.query(...args) }
        const value = Reflect.get(target,key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })))
  } }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve=done }); return {promise,resolve} }

test('multiple document operations and audits commit in one existing single-client transaction', async () => {
  const observed = observe(db.app), documents = store(await scope(),observed)
  assert.equal(db.app.pool.options.max,1)
  const answer = await documents.transaction(async unit => {
    assert.equal(Object.isFrozen(unit),true)
    assert.equal('transaction' in unit,false)
    assert.equal('connection' in unit,false)
    await unit.set('call:one',{ended:true})
    await unit.set('temporary',{discard:true})
    assert.deepEqual(await unit.update('lead:one',{calls:0},value => ({calls:value.calls+1})),{calls:1})
    assert.deepEqual(await unit.get('call:one'),{ended:true})
    await unit.delete('temporary')
    assert.deepEqual(await unit.list(''),['call:one','lead:one'])
    return 'committed'
  })
  assert.equal(answer,'committed')
  assert.equal(observed.state.transactions,1,'callback methods must not acquire nested pool connections')
  assert.deepEqual((await records()).map(row => row.key),['call:one','lead:one'])
  const audit = await audits()
  assert.equal(audit.length,4)
  assert.ok(audit.every(row => /^sha256:[a-f0-9]{64}$/.test(row.record_key) && row.request_id==='document-unit' && row.configuration_version==='1'))
  const xids = (await db.admin.query(`SELECT xmin::text AS xid FROM atrium.operational_documents
    UNION SELECT xmin::text AS xid FROM atrium.audit_events`)).rows
  assert.equal(xids.length,1,'every surviving document and audit must share the transaction')
})

test('callback failure rolls back earlier set/update/delete operations and their audit entries', async () => {
  const documents = store(await scope())
  await documents.set('existing',{count:1})
  const original = await records(), originalAudit = await audits()
  await assert.rejects(documents.transaction(async unit => {
    await unit.set('new',{count:9})
    await unit.update('existing',{},value => ({count:value.count+1}))
    await unit.delete('existing')
    throw new Error('synthetic callback failure')
  }),/synthetic callback failure/)
  assert.deepEqual(await records(),original)
  assert.deepEqual(await audits(),originalAudit)
})

test('audit failure rolls back the entire unit, including earlier document writes', async () => {
  const documents = store(await scope(),db.app,'invalid audit id')
  await assert.rejects(documents.transaction(async unit => {
    await unit.set('cannot-commit',{one:1})
    await unit.set('also-cannot-commit',{two:2})
  }),{code:'23514'})
  assert.deepEqual(await records(),[])
  assert.deepEqual(await audits(),[])
})

test('failed document operations poison the unit even when the callback catches them', async () => {
  const documents = store(await scope())
  for (const invalidOperation of [
    unit => unit.set('',{}),
    unit => unit.set('oversized',{value:'x'.repeat(4*1024*1024)}),
    unit => unit.update('invalid-update',{},async () => ({incorrect:true})),
  ]) {
    await assert.rejects(documents.transaction(async unit => {
      await unit.set('earlier-write',{valid:true})
      try { await invalidOperation(unit) } catch {}
      try { await unit.set('later-write',{valid:true}) } catch {}
    }))
    assert.deepEqual(await records(),[])
    assert.deepEqual(await audits(),[])
  }
})

test('transaction handles and captured methods refuse every operation after callback completion or rollback', async () => {
  const observed = observe(db.app), documents = store(await scope(),observed)
  let unit, capturedGet
  await documents.transaction(async active => { unit=active; capturedGet=active.get; await active.set('kept',{yes:true}) })
  for (const invoke of [() => unit.get('kept'),() => capturedGet('kept'),() => unit.set('late',{}),
    () => unit.update('kept',{},value => value),() => unit.list(''),() => unit.delete('kept')]) {
    await assert.rejects(invoke(),{code:'document_transaction_closed'})
  }
  assert.throws(() => unit.describe(),{code:'document_transaction_closed'})
  assert.equal(observed.state.transactions,1)
  let rolledBack
  await assert.rejects(documents.transaction(async active => { rolledBack=active; throw new Error('rollback') }),/rollback/)
  await assert.rejects(rolledBack.get('kept'),{code:'document_transaction_closed'})
  assert.deepEqual((await records()).map(row => row.key),['kept'])
})

test('unfinished operations are drained before rollback and cannot use a released client', async () => {
  const entered=deferred(),release=deferred()
  const observed=observe(db.app,async text => {
    if (String(text).startsWith('INSERT INTO atrium.operational_documents')) { entered.resolve(); await release.promise }
  })
  const documents=store(await scope(),observed)
  let unit
  const running=documents.transaction(async active => { unit=active; void active.set('unawaited',{value:1}) })
  const rejected=assert.rejects(running,{code:'document_transaction_incomplete'})
  await entered.promise
  await assert.rejects(unit.get('unawaited'),{code:'document_transaction_closed'})
  release.resolve()
  await rejected
  assert.deepEqual(await records(),[])
  assert.deepEqual(await audits(),[])
  await documents.set('after-rollback',{clean:true})
  assert.deepEqual((await records()).map(row => row.key),['after-rollback'])
})

test('parallel updates inside one unit are serialized without lost changes or nested-pool deadlock', async () => {
  const observed=observe(db.app),documents=store(await scope(),observed)
  const values=await documents.transaction(unit => Promise.all(Array.from({length:20},() =>
    unit.update('counter',{count:0},value => ({count:value.count+1})))))
  assert.deepEqual(values.map(value => value.count),Array.from({length:20},(_,index)=>index+1))
  assert.equal(observed.state.transactions,1)
  assert.deepEqual(await documents.get('counter'),{count:20})
  assert.equal((await audits()).length,20)
})

test('two organizations and two properties retain separate keys and immutable callback scopes', async () => {
  for (const [org,property] of properties) {
    const documents=store(await scope(org==='organization-a'?'owner-a':'owner-b',property))
    await documents.transaction(async unit => {
      await unit.set.call({organizationId:'organization-other',propertyId:'property-other'},'same-key',{property})
      assert.deepEqual(await unit.get('same-key'),{property})
      assert.deepEqual(await unit.list(''),['same-key'])
    })
  }
  assert.deepEqual((await records()).map(row=>[row.organization_id,row.property_id,row.value.property]),properties.map(([org,property])=>[org,property,property]))
  const forged={...(await scope()),propertyId:'property-b1'}
  await assert.rejects(store(forged).transaction(async unit=>unit.set('bypass',{})),{code:'forbidden'})
})

test('read-only membership cannot start a write unit and current permission is rechecked before commit', async () => {
  let called=false
  await assert.rejects(store(await scope('viewer-a','property-a1','read')).transaction(async () => { called=true }),{code:'forbidden'})
  assert.equal(called,false)
  const documents=store(await scope())
  await assert.rejects(documents.transaction(async unit => {
    await unit.set('revoked',{must:'rollback'})
    await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
  }),{code:'forbidden'})
  assert.deepEqual(await records(),[])
  assert.deepEqual(await audits(),[])
})

test('published configuration changes before exit roll back documents and audit together', async () => {
  const documents=store(await scope())
  await assert.rejects(documents.transaction(async unit => {
    await unit.set('old-config',{must:'rollback'})
    await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
  }),{code:'property_configuration_changed'})
  assert.deepEqual(await records(),[])
  assert.deepEqual(await audits(),[])
})

test('database-owned adapter composes on an admitted client and close is idempotent', async () => {
  const selected=await scope()
  let unit
  await propertyTransaction(db.app,selected,'operate',async client => {
    unit=createTransactionDocumentStore(client,selected,{requestId:'composed-unit',configurationVersion:1})
    await unit.documents.set('composed',{one:true})
    const closed=unit.close()
    assert.equal(unit.close(),closed)
    await closed
    await assert.rejects(unit.documents.get('composed'),{code:'document_transaction_closed'})
  },1)
  assert.deepEqual((await records()).map(row=>row.key),['composed'])
  assert.equal((await audits())[0].request_id,'composed-unit')
})

test('internal adapter cannot replace the admitted property context with another issued scope', async () => {
  const selected=await scope(),other=await scope('owner-b','property-b1')
  await assert.rejects(propertyTransaction(db.app,selected,'operate',async client => {
    const unit=createTransactionDocumentStore(client,other,{requestId:'mismatched-scope',configurationVersion:1})
    try { await unit.documents.set('cross-property',{}) } finally { await unit.close() }
  },1),{code:'42501'})
  assert.deepEqual(await records(),[])
  assert.deepEqual(await audits(),[])
})
