import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { PostgresLoginProtectionRepository, LoginProtectionRepositoryError } from '../../src/database/login-protection.ts'

let db, other, a, b
const key = label => createHash('sha256').update(`synthetic-login-test:${label}`).digest('hex')
const fresh = () => key(randomBytes(12).toString('hex'))
const unavailable = error => error instanceof LoginProtectionRepositoryError && error.message === 'Sign-in protection is unavailable.'
before(async () => {
  db = await createFoundationTestDatabase()
  other = new DatabaseConnection({ ...db.auth.pool.options, password:db.auth.pool.options.password, max: 8 }, 'atrium_authenticator')
  a = new PostgresLoginProtectionRepository(db.auth); b = new PostgresLoginProtectionRepository(other)
})
after(async () => { if (other) await other.close(); if (db) await db.close() })
const bucket = async (kind, k) => (await db.admin.query('SELECT * FROM atrium.login_attempt_buckets WHERE bucket_kind=$1 AND bucket_key=$2', [kind,k])).rows[0]
async function prefill(kind, k, count, interval = '0 seconds') {
  await db.admin.query(`INSERT INTO atrium.login_attempt_buckets(bucket_kind,bucket_key,attempt_times,last_reserved_at)
    SELECT $1,$2,array_fill(clock_timestamp()+$4::interval,ARRAY[$3::int]),clock_timestamp()+$4::interval`, [kind,k,count,interval])
}

test('new migration and exact function owner isolate hashed buckets from all account/credential privileges', async () => {
  assert.equal(await readFile(new URL('../../db/login-protection.sql',import.meta.url),'utf8'),
    await readFile(new URL('../../supabase/migrations/20260910003107_login_protection.sql',import.meta.url),'utf8'))
  const role = (await db.admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='atrium_login_executor'")).rows[0]
  assert.ok(Object.values(role).every(value => value === false))
  assert.equal((await db.admin.query("SELECT has_schema_privilege('atrium_login_executor','atrium','CREATE') AS allowed")).rows[0].allowed,false)
  for (const table of ['users','user_credentials','organizations','memberships','property_grants','password_change_attempts','account_security_events']) {
    const p=(await db.admin.query("SELECT has_table_privilege('atrium_login_executor',$1,'SELECT,INSERT,UPDATE,DELETE') AS allowed", [`atrium.${table}`])).rows[0]
    assert.equal(p.allowed,false,table)
  }
  const fn=(await db.admin.query(`SELECT p.prosecdef,p.proconfig,r.rolname owner,
    has_function_privilege('atrium_app',p.oid,'EXECUTE') app_execute,
    has_function_privilege('atrium_authenticator',p.oid,'EXECUTE') auth_execute,
    EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='atrium.reserve_login_attempt(text,text)'::regprocedure`)).rows[0]
  assert.deepEqual(fn,{prosecdef:true,proconfig:['search_path=pg_catalog'],owner:'atrium_login_executor',app_execute:false,auth_execute:true,public_execute:false})
  const table=(await db.admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='atrium.login_attempt_buckets'::regclass")).rows[0]
  assert.deepEqual(table,{relrowsecurity:true,relforcerowsecurity:true})
})

test('two independent connections admit exactly twenty concurrent attempts for the same username', async () => {
  const usernameKey=fresh(), clientKey=fresh()
  const results=await Promise.all(Array.from({length:30},(_,i)=>(i%2?a:b).reserve({usernameKey,clientKey})))
  assert.equal(results.filter(x=>x.allowed).length,20)
  assert.equal(results.filter(x=>!x.allowed).length,10)
  assert.ok(results.every(x=>x.allowed ? x.retryAfterSeconds===0 : x.retryAfterSeconds>=1 && x.retryAfterSeconds<=900))
  assert.equal((await bucket('username',usernameKey)).attempt_times.length,20)
  assert.equal((await bucket('client',clientKey)).attempt_times.length,30)
  const columns=Object.keys(await bucket('username',usernameKey)).sort()
  assert.deepEqual(columns,['bucket_key','bucket_kind','attempt_times','last_reserved_at'].sort())
})

test('client budget allows exactly one hundred distinct usernames and denied clients allocate no username buckets', async () => {
  const clientKey=fresh(), users=Array.from({length:115},()=>fresh())
  const results=await Promise.all(users.map((usernameKey,i)=>(i%2?a:b).reserve({usernameKey,clientKey})))
  assert.equal(results.filter(x=>x.allowed).length,100)
  assert.equal((await bucket('client',clientKey)).attempt_times.length,100)
  for (let i=0;i<users.length;i++) assert.equal(!!await bucket('username',users[i]),results[i].allowed)
  const original=await bucket('client',clientKey)
  await a.reserve({usernameKey:fresh(),clientKey})
  assert.deepEqual(await bucket('client',clientKey),original,'client denial never extends its own time window')
})

test('username denial consumes only client budget and repeated denials never extend the username window', async () => {
  const usernameKey=fresh(), clientKey=fresh()
  await prefill('username',usernameKey,20)
  const original=await bucket('username',usernameKey)
  for(let i=0;i<100;i++) assert.equal((await (i%2?a:b).reserve({usernameKey,clientKey})).allowed,false)
  assert.deepEqual(await bucket('username',usernameKey),original)
  assert.equal((await bucket('client',clientKey)).attempt_times.length,100)
  const nextUsername=fresh()
  assert.equal((await b.reserve({usernameKey:nextUsername,clientKey})).allowed,false)
  assert.equal(await bucket('username',nextUsername),undefined)
})

test('expiry prunes only old entries, preserves the rolling boundary and allows a new reservation without waiting', async () => {
  const usernameKey=fresh(), clientKey=fresh()
  await prefill('username',usernameKey,20,'-16 minutes')
  await prefill('client',clientKey,100,'-16 minutes')
  assert.deepEqual(await a.reserve({usernameKey,clientKey}),{allowed:true,retryAfterSeconds:0})
  assert.equal((await bucket('username',usernameKey)).attempt_times.length,1)
  assert.equal((await bucket('client',clientKey)).attempt_times.length,1)
  await db.admin.query(`UPDATE atrium.login_attempt_buckets SET attempt_times = array_fill(clock_timestamp()-interval '16 minutes',ARRAY[19])
    || ARRAY[clock_timestamp()],last_reserved_at=clock_timestamp() WHERE bucket_kind='username' AND bucket_key=$1`,[usernameKey])
  assert.equal((await a.reserve({usernameKey,clientKey})).allowed,true)
  assert.equal((await bucket('username',usernameKey)).attempt_times.length,2)
})

test('future reservations survive clock rollback, return honest retries beyond900 and overflow refuses safely', async () => {
  const usernameKey=fresh(), clientKey=fresh()
  await prefill('username',usernameKey,20,'2 minutes')
  const saved=await bucket('username',usernameKey), result=await a.reserve({usernameKey,clientKey})
  assert.equal(result.allowed,false); assert.ok(result.retryAfterSeconds>900 && result.retryAfterSeconds<=1020)
  assert.deepEqual(await bucket('username',usernameKey),saved)
  const future=fresh(), client=fresh()
  await prefill('username',future,1,'2 minutes')
  assert.equal((await a.reserve({usernameKey:future,clientKey:client})).allowed,true)
  const queue=(await bucket('username',future)).attempt_times
  assert.ok(queue[1].getTime()>=queue[0].getTime(),'new attempts do not move backwards in time')
  const overflow=fresh(), unused=fresh()
  await prefill('username',overflow,20,'100 years')
  await assert.rejects(a.reserve({usernameKey:overflow,clientKey:unused}),unavailable)
  assert.equal(await bucket('client',unused),undefined,'overflow rolls back the client reservation too')
})

test('cleanup is bounded, runs on client denial, and skips another transaction locked expired bucket', async () => {
  const clientKey=fresh(), usernameKey=fresh()
  await prefill('client',clientKey,100)
  const stale=Array.from({length:121},()=>fresh())
  for(const k of stale) await prefill('username',k,1,'-20 minutes')
  // A separate synthetic maintenance connection holds the row; runtime privileges stay denied.
  const admin=new (await import('pg')).default.Client({...db.admin.connectionParameters,password:db.admin.connectionParameters.password})
  await admin.connect()
  try {
    await admin.query('BEGIN')
    await admin.query("SELECT bucket_key FROM atrium.login_attempt_buckets WHERE bucket_kind='username' AND bucket_key=$1 FOR UPDATE",[stale[0]])
    const before=(await db.admin.query('SELECT count(*)::int n FROM atrium.login_attempt_buckets WHERE bucket_key=ANY($1)',[stale])).rows[0].n
    assert.equal((await a.reserve({usernameKey,clientKey})).allowed,false)
    const after=(await db.admin.query('SELECT count(*)::int n FROM atrium.login_attempt_buckets WHERE bucket_key=ANY($1)',[stale])).rows[0].n
    assert.equal(before-after,50)
    assert.ok(await bucket('username',stale[0]),'locked stale row was skipped')
    assert.equal(await bucket('username',usernameKey),undefined)
    assert.equal((await b.reserve({usernameKey,clientKey})).allowed,false)
    assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.login_attempt_buckets WHERE bucket_key=ANY($1)',[stale])).rows[0].n,21)
  } finally { await admin.query('ROLLBACK'); await admin.end() }
})

test('later SQL failure rolls back both budgets, and missing privileges/schema return only unavailable', async () => {
  const usernameKey=fresh(),clientKey=fresh()
  await db.admin.query(`CREATE FUNCTION atrium.synthetic_login_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.bucket_kind='username' THEN RAISE EXCEPTION 'synthetic private SQL failure'; END IF; RETURN NEW; END $$`)
  await db.admin.query('CREATE TRIGGER synthetic_login_failure BEFORE UPDATE ON atrium.login_attempt_buckets FOR EACH ROW EXECUTE FUNCTION atrium.synthetic_login_failure()')
  try { await assert.rejects(a.reserve({usernameKey,clientKey}),unavailable) }
  finally {
    await db.admin.query('DROP TRIGGER synthetic_login_failure ON atrium.login_attempt_buckets')
    await db.admin.query('DROP FUNCTION atrium.synthetic_login_failure()')
  }
  assert.equal(await bucket('client',clientKey),undefined);assert.equal(await bucket('username',usernameKey),undefined)
  await db.admin.query('REVOKE UPDATE ON atrium.login_attempt_buckets FROM atrium_login_executor')
  try { await assert.rejects(a.reserve({usernameKey,clientKey}),unavailable) }
  finally { await db.admin.query('GRANT UPDATE ON atrium.login_attempt_buckets TO atrium_login_executor') }
  assert.equal(await bucket('client',clientKey),undefined)
  await db.admin.query('ALTER TABLE atrium.login_attempt_buckets RENAME TO synthetic_hidden_login_buckets')
  try { await assert.rejects(a.reserve({usernameKey,clientKey}),unavailable) }
  finally { await db.admin.query('ALTER TABLE atrium.synthetic_hidden_login_buckets RENAME TO login_attempt_buckets') }
  assert.deepEqual(await a.reserve({usernameKey,clientKey}),{allowed:true,retryAfterSeconds:0})
})

test('raw runtime DML/read, app execute, executor inheritance and inherited identity/channel context are denied', async () => {
  assert.throws(()=>new PostgresLoginProtectionRepository(db.app),/authenticator/)
  for(const connection of [db.app,db.auth]) {
    for(const statement of ['SELECT * FROM atrium.login_attempt_buckets',"DELETE FROM atrium.login_attempt_buckets",'SET LOCAL ROLE atrium_login_executor']) {
      await assert.rejects(connection.transaction({},client=>client.query(statement)),{code:'42501'})
    }
  }
  await assert.rejects(db.app.transaction({},client=>client.query('SELECT * FROM atrium.reserve_login_attempt($1,$2)',[fresh(),fresh()])),{code:'42501'})
  for(const context of [{actorUserId:'user'},{credentialVersion:1},{organizationId:'org'},{propertyId:'prop'},{loginUsername:'user'},
    {channelProvider:'vapi'},{channelExternalId:'call'},{channelBindingId:'binding'},{channelBindingVersion:1}]) {
    await assert.rejects(db.auth.transaction(context,client=>client.query('SELECT * FROM atrium.reserve_login_attempt($1,$2)',[fresh(),fresh()])),{code:'42501'})
  }
  for(const [role,connection] of [['atrium_app',db.app],['atrium_authenticator',db.auth]]) {
    await db.admin.query(`GRANT atrium_login_executor TO ${role}`)
    try {
      let invoked=false
      await assert.rejects(connection.transaction({},async()=>{invoked=true}),{name:'DatabaseConfigurationError'})
      assert.equal(invoked,false)
    } finally { await db.admin.query(`REVOKE atrium_login_executor FROM ${role}`) }
  }
})

test('malformed inputs and bucket constraints refuse unsafe data without leaking query details', async () => {
  for(const usernameKey of [null,undefined,1,'raw@example.test','a'.repeat(63),'A'.repeat(64)]) {
    await assert.rejects(a.reserve({usernameKey,clientKey:fresh()}),unavailable)
    if(usernameKey!==undefined) await assert.rejects(db.auth.transaction({},client=>client.query('SELECT * FROM atrium.reserve_login_attempt($1,$2)',[usernameKey,fresh()])),{code:'22023'})
  }
  await assert.rejects(a.reserve({usernameKey:fresh(),clientKey:fresh(),password:'synthetic-never-stored'}),unavailable)
  for(const [kind,queue] of [['username',Array(21).fill(NOW())],['client',Array(101).fill(NOW())],['username',[null]]]) {
    await assert.rejects(db.admin.query('INSERT INTO atrium.login_attempt_buckets(bucket_kind,bucket_key,attempt_times,last_reserved_at) VALUES($1,$2,$3,clock_timestamp())',[kind,fresh(),queue]),{code:'23514'})
  }
})
function NOW() { return new Date().toISOString() }

test('closed connection is unavailable with no memory admission fallback', async () => {
  const connection=new DatabaseConnection({...db.auth.pool.options,password:db.auth.pool.options.password,max:1},'atrium_authenticator')
  const repository=new PostgresLoginProtectionRepository(connection)
  await connection.close()
  await assert.rejects(repository.reserve({usernameKey:fresh(),clientKey:fresh()}),unavailable)
})

test('concurrent cleanup between conflict check and row lock is recovered for both bucket kinds', async () => {
  const definition=(await db.admin.query("SELECT pg_get_functiondef('atrium.reserve_login_attempt(text,text)'::regprocedure) AS definition")).rows[0].definition
  const admin=new (await import('pg')).default.Client({...db.admin.connectionParameters,password:db.admin.connectionParameters.password})
  const connection=new DatabaseConnection({...db.auth.pool.options,password:db.auth.pool.options.password,max:1},'atrium_authenticator')
  const repository=new PostgresLoginProtectionRepository(connection)
  await admin.connect()
  try {
    for(const kind of ['client','username']) {
      const usernameKey=fresh(),clientKey=fresh(),expiredKey=kind==='client'?clientKey:usernameKey
      await prefill(kind,expiredKey,1,'-20 minutes')
      const target=definition.split('\n').find(line=>line.includes(`SELECT attempt_times, last_reserved_at INTO v_${kind}_times, v_last`))
      assert.ok(target)
      // Test-only barrier in the real finite function, after conflict detection and before row locking.
      const paused=definition.replace(target,`IF p_client_key='${clientKey}' AND v_lock_attempt=1 THEN
        PERFORM pg_advisory_xact_lock(77123001);
      END IF;\n${target}`)
      await db.admin.query(paused)
      await admin.query('SELECT pg_advisory_lock(77123001)')
      const pid=await connection.transaction({},async client=>(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const pending=repository.reserve({usernameKey,clientKey}).then(result=>({result}),error=>({error}))
      try {
        let waiting=false
        for(let attempt=0;attempt<100;attempt++) {
          waiting=(await db.admin.query("SELECT lower(wait_event)='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true
          if(waiting) break
          await new Promise(resolve=>setTimeout(resolve,5))
        }
        assert.equal(waiting,true,'reservation reached the deterministic post-insert barrier')
        assert.equal((await b.reserve({usernameKey:fresh(),clientKey:fresh()})).allowed,true)
        assert.equal(await bucket(kind,expiredKey),undefined,'other request deleted the expired conflicting row')
      } finally { await admin.query('SELECT pg_advisory_unlock(77123001)') }
      const outcome=await pending
      assert.equal(outcome.error,undefined)
      assert.deepEqual(outcome.result,{allowed:true,retryAfterSeconds:0})
      assert.equal((await bucket(kind,expiredKey)).attempt_times.length,1,'reacquisition charged once')
      await db.admin.query(definition)
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock_all()')
    await connection.close()
    await db.admin.query(definition)
    await admin.end()
  }
})
