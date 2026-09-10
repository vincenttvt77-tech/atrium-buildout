import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { PostgresUserSessionRepository } from '../../src/database/user-sessions.ts'
import { PostgresPasswordChangeRepository } from '../../src/database/password-change.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { issueAuthenticatedUser } from '../../src/auth/identity.ts'
import { createAuthorizationService, hashPassword } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { propertyTransaction } from '../../src/database/scope.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'

let db, repo, other, otherRepo, hash, password, runtime
before(async () => {
  db = await createFoundationTestDatabase(); ({ password } = await seedFoundationTestDatabase(db.admin))
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('base64url'), authOrigin: TEST_AUTH_ORIGIN })
  hash = (await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
  const options = db.auth.pool.options
  other = new DatabaseConnection({ ...options, password: options.password, max: 8 }, 'atrium_authenticator')
  repo = new PostgresUserSessionRepository(db.auth); otherRepo = new PostgresUserSessionRepository(other)
})
after(async () => { if (other) await other.close(); if (db) await db.close() })
async function user() {
  const id = `session-${randomBytes(6).toString('hex')}`
  await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,'Synthetic staff','active')", [id])
  await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [id,hash])
  return issueAuthenticatedUser({ id,username:id,displayName:'Synthetic staff',credentialVersion:1,status:'active' })
}
function managed(user, record) {
  return issueAuthenticatedUser({ id:user.userId,username:user.username,displayName:user.displayName,credentialVersion:user.credentialVersion,status:'active' }, { id:record.id,expiresAt:record.expiresAt })
}
const create = (user, selected=repo) => selected.start(user,{id:randomUUID(),label:'Synthetic browser'})
const claims = record => ({userId:record.userId,credentialVersion:record.credentialVersion,sessionId:record.id,expiresAt:record.expiresAt})
const context = principal => ({actorUserId:principal.userId,credentialVersion:principal.credentialVersion,actorSessionId:principal.sessionId})
const rows = async principal => (await db.admin.query('SELECT * FROM atrium.user_sessions WHERE user_id=$1 ORDER BY created_at_ms,id',[principal.userId])).rows
const audits = async principal => (await db.admin.query('SELECT * FROM atrium.user_session_events WHERE user_id=$1 ORDER BY at_ms,session_id,operation',[principal.userId])).rows
async function historical(principal,ageMs,expired=false) {
  const time=Number((await db.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now)
  const created=time-(expired?28800001:ageMs), id=randomUUID()
  await db.admin.query(`INSERT INTO atrium.user_sessions(id,user_id,credential_version,label,created_at_ms,last_seen_at_ms,expires_at_ms)
    VALUES($1,$2,1,'Synthetic historical browser',$3,$3,$4)`,[id,principal.userId,created,created+28800000])
  return {id,userId:principal.userId,credentialVersion:1,label:'Synthetic historical browser',createdAt:created,lastSeenAt:created,expiresAt:created+28800000,revokedAt:null}
}
async function waitingForLocks(expected=1) {
  for(let attempt=0;attempt<100;attempt++) {
    const count=Number((await db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE usename='atrium_authenticator' AND wait_event_type='Lock'")).rows[0].count)
    if(count>=expected)return
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.fail('Synthetic query did not reach the expected lock barrier')
}

test('new migration is exact and the finite executor has no credential access or raw runtime writes',async()=>{
  assert.equal(await readFile(new URL('../../db/user-sessions.sql',import.meta.url),'utf8'),await readFile(new URL('../../supabase/migrations/20260910010919_user_sessions.sql',import.meta.url),'utf8'))
  const role=(await db.admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='atrium_session_executor'")).rows[0]
  assert.ok(Object.values(role).every(value=>value===false))
  assert.deepEqual((await db.admin.query("SELECT has_table_privilege('atrium_session_executor','atrium.user_credentials','SELECT') AS read,has_table_privilege('atrium_session_executor','atrium.user_credentials','UPDATE') AS write,has_schema_privilege('atrium_session_executor','atrium','CREATE') AS create")).rows[0],{read:false,write:false,create:false})
  const u=await user(),r=await create(u),p=managed(u,r)
  for(const connection of [db.app,db.auth]) {
    await assert.rejects(connection.transaction(context(p),client=>client.query("UPDATE atrium.user_sessions SET revoked_at_ms=created_at_ms")),{code:'42501'})
    await assert.rejects(connection.transaction(context(p),client=>client.query('SELECT * FROM atrium.user_session_events')),{code:'42501'})
    const selected=await connection.transaction(context(p),async client=>(await client.query('SELECT id FROM atrium.user_sessions')).rows)
    assert.deepEqual(selected,[{id:r.id}])
    assert.deepEqual(await connection.transaction({},async client=>(await client.query('SELECT id FROM atrium.user_sessions')).rows),[])
  }
  await assert.rejects(db.app.transaction(context(p),client=>client.query("SELECT * FROM atrium.revoke_user_sessions('others')")),{code:'42501'})
  await assert.rejects(db.auth.transaction(context(p),client=>client.query('SELECT atrium.hold_current_session()')),{code:'42501'})
  await db.admin.query('GRANT atrium_session_executor TO atrium_authenticator')
  try { await assert.rejects(db.auth.transaction({},async()=>true),{name:'DatabaseConfigurationError'}) }
  finally { await db.admin.query('REVOKE atrium_session_executor FROM atrium_authenticator') }
})

test('registration uses the DB clock and one immutable session/audit commit without credential changes',async()=>{
  const u=await user(),r=await create(u),a=await audits(u)
  assert.equal(r.expiresAt-r.createdAt,28800000);assert.equal(r.createdAt,r.lastSeenAt);assert.equal(r.revokedAt,null)
  const dbNow=Number((await db.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now)
  assert.ok(dbNow>=r.createdAt && dbNow-r.createdAt<10000)
  assert.equal(a.length,1);assert.equal(a[0].operation,'created');assert.equal(a[0].reason,'sign_in')
  assert.deepEqual(Object.keys(a[0]).sort(),['session_id','user_id','operation','reason','at_ms','actor_session_id'].sort())
  const tx=(await db.admin.query('SELECT (SELECT xmin::text FROM atrium.user_sessions WHERE id=$1) AS session,(SELECT xmin::text FROM atrium.user_session_events WHERE session_id=$1) AS audit',[r.id])).rows[0]
  assert.equal(tx.session,tx.audit)
  assert.equal((await db.admin.query('SELECT password_hash FROM atrium.user_credentials WHERE user_id=$1',[u.userId])).rows[0].password_hash,hash)
  for(const sql of ["UPDATE atrium.user_sessions SET label='Replacement' WHERE id=$1","UPDATE atrium.user_sessions SET expires_at_ms=expires_at_ms+1 WHERE id=$1","DELETE FROM atrium.user_sessions WHERE id=$1","UPDATE atrium.user_session_events SET reason='session_limit' WHERE session_id=$1","DELETE FROM atrium.user_session_events WHERE session_id=$1"]) await assert.rejects(db.admin.query(sql,[r.id]),{code:'23514'})
  await assert.rejects(repo.start({...u},{id:randomUUID(),label:'Browser'}),{code:'unauthenticated'})
  await assert.rejects(repo.start(managed(u,r),{id:randomUUID(),label:'Browser'}),{code:'invalid_session'})
  await assert.rejects(repo.start(u,{id:randomUUID(),label:'\nInjected'}),{code:'invalid_session'})
})

test('grantless identity sees only own active sessions; foreign and repeated revokes disclose nothing',async()=>{
  const u=await user(),foreign=await user(),a=await create(u),b=await create(u),c=await create(foreign),p=managed(u,a)
  assert.deepEqual(new Set((await repo.list(p)).map(r=>r.id)),new Set([a.id,b.id]))
  await assert.rejects(repo.revoke(p,c.id),{code:'invalid_session'})
  await assert.rejects(repo.revoke(p,randomUUID()),{code:'invalid_session'})
  assert.ok(await otherRepo.resolve(claims(c)))
  assert.deepEqual(await otherRepo.revoke(p,b.id),{revokedIds:[b.id],currentRevoked:false})
  assert.deepEqual(await repo.revoke(p,b.id),{revokedIds:[],currentRevoked:false})
  assert.deepEqual(await repo.revoke(p,'others'),{revokedIds:[],currentRevoked:false})
  assert.deepEqual(await repo.revoke(p,a.id),{revokedIds:[a.id],currentRevoked:true})
  assert.equal(await repo.resolve(claims(a)),null)
  await assert.rejects(repo.list(p),{code:'unauthenticated'})
  await assert.rejects(repo.revoke(p,'others'),{code:'unauthenticated'})
  assert.equal((await audits(u)).filter(a=>a.operation==='revoked').length,2)
})

test('resolve matches exact expiry, identity and credential version and does not renew lifetime',async()=>{
  const u=await user(),r=await create(u)
  assert.deepEqual(await repo.resolve(claims(r)),r)
  for(const patch of [{expiresAt:r.expiresAt+1},{expiresAt:r.expiresAt-1},{credentialVersion:2},{userId:'owner-b'},{sessionId:randomUUID()},{sessionId:'malformed'}]) assert.equal(await repo.resolve({...claims(r),...patch}),null)
  const older=await historical(u,61000)
  const touched=await repo.resolve(claims(older));assert.ok(touched.lastSeenAt>older.lastSeenAt);assert.equal(touched.expiresAt,older.expiresAt)
  const xmin=(await db.admin.query('SELECT xmin::text FROM atrium.user_sessions WHERE id=$1',[older.id])).rows[0].xmin
  assert.deepEqual(await otherRepo.resolve(claims(older)),touched)
  assert.equal((await db.admin.query('SELECT xmin::text FROM atrium.user_sessions WHERE id=$1',[older.id])).rows[0].xmin,xmin,'minute-throttled reads do not write')
  const expired=await historical(u,0,true)
  assert.equal(await repo.resolve(claims(expired)),null)
  await assert.rejects(repo.list(managed(u,expired)),{code:'unauthenticated'})
  assert.ok(!(await repo.list(managed(u,r))).some(s=>s.id===expired.id))
})

test('concurrent independent logins preserve the maximum20 active sessions and audit every eviction',async()=>{
  const u=await user()
  const first=await historical(u,120000)
  const result=await Promise.all(Array.from({length:27},(_,i)=>create(u,i%2?repo:otherRepo)))
  assert.equal(result.length,27)
  const saved=await rows(u),active=saved.filter(r=>r.revoked_at_ms===null)
  assert.equal(saved.length,28);assert.equal(active.length,20)
  assert.notEqual(saved.find(r=>r.id===first.id).revoked_at_ms,null,'oldest active browser is evicted first')
  assert.equal(await repo.resolve(claims(first)),null)
  const events=await audits(u)
  assert.equal(events.filter(e=>e.operation==='created').length,27)
  assert.equal(events.filter(e=>e.operation==='revoked'&&e.reason==='session_limit').length,8)
})

test('password rotation winning the user lock rejects stale session registration without new audit',async()=>{
  const u=await user(),newHash=await hashPassword('synthetic rotated password for registry')
  await db.admin.query('BEGIN');await db.admin.query('SELECT id FROM atrium.users WHERE id=$1 FOR UPDATE',[u.userId])
  const pending=create(u).then(value=>({value}),error=>({error}))
  try {
    await waitingForLocks()
    await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2',[newHash,u.userId])
    await db.admin.query('COMMIT')
  } catch(e) {await db.admin.query('ROLLBACK');throw e}
  assert.equal((await pending).error?.code,'unauthenticated')
  assert.deepEqual(await rows(u),[]);assert.deepEqual(await audits(u),[])
})

test('revoke-all and registration obey user-first commit ordering across two connections',async()=>{
  const u=await user(),a=await create(u),p=managed(u,a)
  await db.admin.query('BEGIN');await db.admin.query('SELECT id FROM atrium.users WHERE id=$1 FOR UPDATE',[u.userId])
  const start=create(u,otherRepo)
  await waitingForLocks()
  const revoke=repo.revoke(p,'others')
  await waitingForLocks(2);await db.admin.query('COMMIT')
  const [created,result]=await Promise.all([start,revoke])
  assert.ok(result.revokedIds.includes(created.id));assert.equal(await repo.resolve(claims(created)),null)
  assert.ok(await repo.resolve(claims(a)))
})

test('audit failure rolls back both explicit revocation and cap eviction/new registration',async()=>{
  const u=await user(),all=[]
  for(let i=0;i<20;i++)all.push(await create(u))
  const p=managed(u,all.at(-1)),beforeRows=await rows(u),beforeAudit=await audits(u)
  await db.admin.query('REVOKE INSERT ON atrium.user_session_events FROM atrium_session_executor')
  try {
    await assert.rejects(repo.revoke(p,all[0].id),{code:'session_unavailable'})
    await assert.rejects(create(u),{code:'session_unavailable'})
  } finally {await db.admin.query('GRANT INSERT ON atrium.user_session_events TO atrium_session_executor')}
  assert.deepEqual(await rows(u),beforeRows);assert.deepEqual(await audits(u),beforeAudit)
})

async function propertyUser() {
  const u=await user(),a=await create(u),b=await create(u),p=managed(u,a),controller=managed(u,b)
  await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES($1,$2,'organization-a','owner','organization','active')",[`membership-${u.userId}`,u.userId])
  await verifyMfaSession(runtime,p,password)
  const authorization=createAuthorizationService(new PgAuthorizationRepository(db.auth))
  const scope=await authorization.authorizeProperty(p,'property-a1','operate')
  return {u,a,p,controller,scope}
}
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}

for(const rollback of [false,true]) test(`admitted property transaction ${rollback?'rolls back':'commits'} before a waiting revocation can finish`,async()=>{
  const {u,a,p,controller,scope}=await propertyUser(),admitted=deferred(),finish=deferred()
  const work=propertyTransaction(db.app,scope,'operate',async client=>{
    await client.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-a1',$1,'{}')",[`session-proof:${u.userId}`])
    admitted.resolve();await finish.promise
    if(rollback)throw new Error('Synthetic callback rollback')
  }).then(()=>({ok:true}),error=>({error}))
  await Promise.race([admitted.promise,work.then(result=>{throw result.error ?? new Error('Property callback completed without reaching the lock barrier')})])
  let revokeFinished=false
  const revoke=otherRepo.revoke(controller,a.id).then(result=>{revokeFinished=true;return result})
  await waitingForLocks();assert.equal(revokeFinished,false)
  finish.resolve();const completed=await work
  if(rollback)assert.equal(completed.error?.message,'Synthetic callback rollback');else assert.equal(completed.ok,true)
  assert.deepEqual(await revoke,{revokedIds:[a.id],currentRevoked:false})
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM atrium.operational_documents WHERE key=$1',[`session-proof:${u.userId}`])).rows[0].count,rollback?0:1)
  let ran=false
  await assert.rejects(propertyTransaction(db.app,scope,'operate',async()=>{ran=true}),{code:'forbidden'})
  assert.equal(ran,false)
  const visible=await db.auth.transaction(context(p),async client=>({users:(await client.query('SELECT id FROM atrium.users')).rows,memberships:(await client.query('SELECT id FROM atrium.memberships')).rows,properties:(await client.query('SELECT id FROM atrium.properties')).rows}))
  assert.deepEqual(visible,{users:[],memberships:[],properties:[]})
  assert.equal((await db.auth.transaction({loginUsername:u.username},client=>client.query('SELECT user_id FROM atrium.user_credentials'))).rowCount,1)
})

test('revocation taking the user lock first prevents the waiting property callback from running',async()=>{
  const {u,a,controller,scope}=await propertyUser()
  await db.admin.query('BEGIN');await db.admin.query('SELECT id FROM atrium.users WHERE id=$1 FOR UPDATE',[u.userId])
  const revoke=otherRepo.revoke(controller,a.id);await waitingForLocks()
  let ran=false
  const work=propertyTransaction(db.app,scope,'operate',async()=>{ran=true}).then(()=>({ok:true}),error=>({error}))
  await db.admin.query('COMMIT')
  assert.deepEqual(await revoke,{revokedIds:[a.id],currentRevoked:false})
  assert.equal((await work).error?.code,'forbidden');assert.equal(ran,false)
})

test('managed password rotation succeeds atomically then invalidates every old session',async()=>{
  const u=await user(),a=await create(u),b=await create(u),p=managed(u,a),passwords=new PostgresPasswordChangeRepository(db.auth)
  const reservation=await passwords.reserve(p,randomUUID())
  await passwords.commit(p,reservation,await hashPassword('synthetic new managed session password'))
  assert.equal(await repo.resolve(claims(a)),null);assert.equal(await repo.resolve(claims(b)),null)
  await assert.rejects(repo.list(p),{code:'unauthenticated'})
  await assert.rejects(create(u),{code:'unauthenticated'})
  const event=(await db.admin.query('SELECT * FROM atrium.account_security_events WHERE user_id=$1',[u.userId])).rows
  assert.equal(event.length,1);assert.equal(event[0].credential_version,'2')
})

test('revocation during password verification prevents the reserved credential mutation',async()=>{
  const u=await user(),a=await create(u),b=await create(u),p=managed(u,a),controller=managed(u,b)
  const passwords=new PostgresPasswordChangeRepository(db.auth),reservation=await passwords.reserve(p,randomUUID())
  await otherRepo.revoke(controller,a.id)
  await assert.rejects(passwords.commit(p,reservation,await hashPassword('synthetic replacement after revoked verification')),{code:'unauthenticated'})
  assert.equal((await db.admin.query('SELECT password_hash FROM atrium.user_credentials WHERE user_id=$1',[u.userId])).rows[0].password_hash,hash)
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM atrium.account_security_events WHERE user_id=$1',[u.userId])).rows[0].count,0)
  assert.ok(await repo.resolve(claims(b)))
})

test('inactive users, unavailable SQL and polluted login contexts fail closed and clear session context',async()=>{
  const u=await user(),r=await create(u),p=managed(u,r)
  await db.admin.query("UPDATE atrium.users SET status='inactive' WHERE id=$1",[u.userId])
  assert.equal(await repo.resolve(claims(r)),null);await assert.rejects(repo.list(p),{code:'unauthenticated'})
  await db.admin.query("UPDATE atrium.users SET status='active' WHERE id=$1",[u.userId])
  await db.admin.query('REVOKE EXECUTE ON FUNCTION atrium.resolve_user_session(bigint) FROM atrium_authenticator')
  try {await assert.rejects(repo.resolve(claims(r)),{code:'session_unavailable'})}
  finally {await db.admin.query('GRANT EXECUTE ON FUNCTION atrium.resolve_user_session(bigint) TO atrium_authenticator')}
  await assert.rejects(db.auth.transaction({actorSessionId:r.id},client=>client.query('SELECT * FROM atrium.reserve_login_attempt($1,$2)',['a'.repeat(64),'b'.repeat(64)])),{code:'42501'})
  assert.equal((await db.auth.transaction({},client=>client.query("SELECT atrium.context('session_id') AS session"))).rows[0].session,null)
  const options=db.auth.pool.options,closed=new DatabaseConnection({...options,password:options.password},'atrium_authenticator')
  await closed.close();await assert.rejects(new PostgresUserSessionRepository(closed).resolve(claims(r)),{code:'session_unavailable'})
})

test('a session identifier cannot be mixed into channel authority or inherited by pre-login commands',async()=>{
  const u=await user(),r=await create(u)
  const channel={channelBindingId:'channel-a',channelBindingVersion:1,channelProvider:'vapi',channelExternalId:'synthetic-assistant-a',organizationId:'organization-a',propertyId:'property-a1'}
  assert.equal((await db.app.transaction(channel,client=>client.query("SELECT atrium.can_access_property('organization-a','property-a1','operate') AS allowed"))).rows[0].allowed,true)
  assert.equal((await db.app.transaction({...channel,actorSessionId:r.id},client=>client.query("SELECT atrium.can_access_property('organization-a','property-a1','operate') AS allowed"))).rows[0].allowed,false)
  assert.deepEqual((await db.auth.transaction({...channel,actorSessionId:r.id},client=>client.query('SELECT id FROM atrium.channel_bindings'))).rows,[])
  assert.equal((await db.app.transaction({...context(managed(u,r)),actorSessionId:'malformed'},client=>client.query('SELECT atrium.session_context_valid() AS allowed'))).rows[0].allowed,false)
})

test('resolution rechecks DB expiry after waiting for the session row lock',async()=>{
  const u=await user(),r=await historical(u,28800000-500)
  await db.admin.query('BEGIN');await db.admin.query('SELECT id FROM atrium.user_sessions WHERE id=$1 FOR UPDATE',[r.id])
  const resolving=repo.resolve(claims(r))
  try {
    await waitingForLocks()
    // A short real database-clock boundary, not a host-clock override or expiry rewrite.
    await db.admin.query('SELECT pg_sleep(0.6)');await db.admin.query('COMMIT')
  } catch(error) {await db.admin.query('ROLLBACK');throw error}
  assert.equal(await resolving,null,'a pre-lock timestamp cannot keep an expired session current')
})
