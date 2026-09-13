import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { PostgresUserSessionRepository } from '../../src/database/user-sessions.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { issueAuthenticatedUser } from '../../src/auth/identity.ts'
import { hashPassword } from '../../src/auth/index.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { TEST_AUTH_ORIGIN } from '../helpers/mfa-session.mjs'
import { SoftwareAuthenticator } from '../helpers/software-authenticator.mjs'

let db,repo,other,otherRepo,pooled,hash,password,runtime
before(async()=>{
  db=await createFoundationTestDatabase();({password}=await seedFoundationTestDatabase(db.admin))
  hash=(await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
  const options=db.auth.pool.options
  other=new DatabaseConnection({...options,password:options.password,max:8},'atrium_authenticator')
  pooled=new DatabaseConnection({...options,password:options.password,max:1},'atrium_authenticator')
  repo=new PostgresUserSessionRepository(db.auth);otherRepo=new PostgresUserSessionRepository(other)
  runtime=createDatabaseRuntime({app:db.app,auth:db.auth,authOrigin:TEST_AUTH_ORIGIN,sessionSecret:randomBytes(40).toString('base64url')})
})
after(async()=>{if(other)await other.close();if(pooled)await pooled.close();if(db)await db.close()})
function p(id,audience,row){return issueAuthenticatedUser({id,username:id,displayName:id,status:'active',credentialVersion:1},row?{id:row.id,expiresAt:row.expiresAt}:undefined,audience)}
async function user(){const id=`audience-race-${randomBytes(5).toString('hex')}`;await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')",[id]);await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)',[id,hash]);return id}
const start=(id,audience,selected=repo)=>selected.start(p(id,audience),{id:randomUUID(),label:'Synthetic concurrent browser',audience})
const claims=r=>({userId:r.userId,credentialVersion:r.credentialVersion,sessionId:r.id,expiresAt:r.expiresAt,audience:r.audience})
const context=r=>({actorUserId:r.userId,credentialVersion:r.credentialVersion,actorSessionId:r.id,sessionAudience:r.audience})
async function waiting(count=1){for(let n=0;n<200;n++){const actual=Number((await db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE usename='atrium_authenticator' AND wait_event_type='Lock'")).rows[0].count);if(actual>=count)return;await new Promise(r=>setTimeout(r,5))}assert.fail('Expected real PostgreSQL lock wait was not reached')}
async function lock(id){await db.admin.query('BEGIN');await db.admin.query('SELECT id FROM atrium.users WHERE id=$1 FOR UPDATE',[id])}
const settled=promise=>promise.then(value=>({value}),error=>({error}))

test('independent connections concurrently enforce twenty active sessions in each audience',async()=>{
 const id=await user()
 const rows=await Promise.all(Array.from({length:50},(_,i)=>start(id,i%2?'staff':'resident',i%3?repo:otherRepo)))
 const groups=(await db.admin.query('SELECT audience,count(*)::int AS count FROM atrium.user_sessions WHERE user_id=$1 AND revoked_at_ms IS NULL GROUP BY audience ORDER BY audience',[id])).rows
 assert.deepEqual(groups,[{audience:'resident',count:20},{audience:'staff',count:20}])
 const revoked=(await db.admin.query("SELECT s.audience,count(*)::int AS count FROM atrium.user_sessions s JOIN atrium.user_session_events e ON e.session_id=s.id AND e.operation='revoked' WHERE s.user_id=$1 GROUP BY s.audience ORDER BY s.audience",[id])).rows
 assert.deepEqual(revoked,[{audience:'resident',count:5},{audience:'staff',count:5}]);assert.equal(rows.length,50)
})

test('queued resident registration then resident revoke-others follows lock order without revoking staff',async()=>{
 const id=await user(),controller=await start(id,'resident'),staff=await start(id,'staff')
 await lock(id)
 const registering=settled(start(id,'resident',otherRepo));await waiting()
 const revoking=settled(repo.revoke(p(id,'resident',controller),'others'));await waiting(2)
 await db.admin.query('COMMIT')
 const created=await registering,result=await revoking
 assert.ok(created.value);assert.deepEqual(result.value,{revokedIds:[created.value.id],currentRevoked:false})
 assert.equal(await repo.resolve(claims(created.value)),null);assert.ok(await repo.resolve(claims(staff)))
})

test('queued staff registration survives a resident revoke-others command',async()=>{
 const id=await user(),controller=await start(id,'resident'),otherResident=await start(id,'resident')
 await lock(id)
 const registering=settled(start(id,'staff',otherRepo));await waiting()
 const revoking=settled(repo.revoke(p(id,'resident',controller),'others'));await waiting(2)
 await db.admin.query('COMMIT')
 const created=await registering,result=await revoking
 assert.ok(created.value);assert.deepEqual(result.value,{revokedIds:[otherResident.id],currentRevoked:false})
 assert.ok(await repo.resolve(claims(created.value)))
})

for(const audience of ['staff','resident'])test(`${audience} registration waiting behind credential rotation cannot use the old password principal`,async()=>{
 const id=await user(),newHash=await hashPassword('Synthetic global credential rotation password')
 await lock(id);const pending=settled(start(id,audience,otherRepo))
 try{await waiting();await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2',[newHash,id]);await db.admin.query('COMMIT')}
 catch(error){await db.admin.query('ROLLBACK');throw error}
 assert.equal((await pending).error?.code,'unauthenticated')
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.user_sessions WHERE user_id=$1',[id])).rows[0].count),0)
 assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.user_session_events WHERE user_id=$1',[id])).rows[0].count),0)
})

for(const audience of ['staff','resident'])test(`${audience} list queued behind current-session revocation refuses after the lock wait`,async()=>{
 const id=await user(),target=await start(id,audience),controller=await start(id,audience)
 await lock(id)
 const revoke=settled(otherRepo.revoke(p(id,audience,controller),target.id));await waiting()
 const read=settled(repo.list(p(id,audience,target)));await waiting(2)
 await db.admin.query('COMMIT')
 assert.deepEqual((await revoke).value,{revokedIds:[target.id],currentRevoked:false})
 assert.equal((await read).error?.code,'unauthenticated')
})

for(const audience of ['staff','resident'])test(`${audience} session expiry during a real user-lock wait is rechecked using database time`,async()=>{
 const id=await user(),now=Number((await db.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now),expiry=now+500,key=randomUUID()
 // A new historical fixture row represents an eight-hour session nearing expiry.
 // Existing session or assurance history is never edited to manufacture time.
 await db.admin.query(`INSERT INTO atrium.user_sessions(id,user_id,credential_version,label,created_at_ms,last_seen_at_ms,expires_at_ms,audience)
 VALUES($1,$2,1,'Synthetic historical expiry',$3,$3,$4,$5)`,[key,id,expiry-28800000,expiry,audience])
 const row={id:key,userId:id,credentialVersion:1,expiresAt:expiry,audience}
 await lock(id);const pending=settled(otherRepo.list(p(id,audience,row)))
 try{
  await waiting()
  while(Number((await db.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now)<expiry)await new Promise(r=>setTimeout(r,10))
  await db.admin.query('COMMIT')
 }catch(error){await db.admin.query('ROLLBACK');throw error}
 assert.equal((await pending).error?.code,'unauthenticated');assert.equal(await repo.resolve(claims(row)),null)
})

test('pooled transaction context resets after resident work and rollback; omission never follows prior audience',async()=>{
 const id=await user(),staff=await start(id,'staff'),resident=await start(id,'resident')
 const query=async c=>(await c.query("SELECT current_setting('atrium.session_audience',true) AS audience,atrium.session_context_valid() AS valid,(SELECT count(*)::int FROM atrium.user_sessions) AS count")).rows[0]
 assert.deepEqual(await pooled.transaction(context(resident),query),{audience:'resident',valid:true,count:1})
 await assert.rejects(pooled.transaction(context(resident),async c=>{await query(c);throw new Error('Synthetic rollback')}),/Synthetic rollback/)
 assert.deepEqual(await pooled.transaction({},query),{audience:'',valid:true,count:0})
 const omitted=context(resident);delete omitted.sessionAudience
 assert.deepEqual(await pooled.transaction(omitted,query),{audience:'',valid:false,count:0})
 assert.deepEqual(await pooled.transaction(context(staff),query),{audience:'staff',valid:true,count:1})
})

test('real recovery activation from a resident session revokes both audiences while keeping replacement resident-only',async()=>{
 const id=await user(),staff=await start(id,'staff'),resident=await start(id,'resident'),s=p(id,'staff',staff),r=p(id,'resident',resident)
 const configuration={origin:TEST_AUTH_ORIGIN,rpId:new URL(TEST_AUTH_ORIGIN).hostname}
 async function register(principal,device,grant=null,reauth=null){
  reauth??=await runtime.mfa.password(principal,password)
  const options=await runtime.mfa.registrationOptions(principal,{label:'Synthetic recovery fixture',reauthenticationId:reauth.id,recoveryGrantId:grant?.id??null})
  return runtime.mfa.finish(principal,{kind:'registration',challengeId:options.challengeId,response:device.registrationResponse({challenge:options.optionsJSON.challenge,...configuration})})
 }
 async function sign(principal,device,purpose='session_login',factorId=null){
  const state=await runtime.mfa.state(principal),options=await runtime.mfa.authenticationOptions(principal,{purpose,factorId})
  return runtime.mfa.finish(principal,{kind:'authentication',challengeId:options.challengeId,response:device.authenticationResponse({challenge:options.optionsJSON.challenge,...configuration,userHandle:state.userHandle})})
 }
 const original=new SoftwareAuthenticator(),pending=await register(s,original)
 await sign(s,original,'session_login',pending.factorId);await sign(s,original,'manage_factors')
 const check=await runtime.mfa.password(s,password),state=await runtime.mfa.state(s)
 const batch=await runtime.mfa.rotateRecovery(s,{requestId:randomUUID(),expectedSecurityVersion:state.securityVersion,reauthenticationId:check.id})
 const sibling=await start(id,'resident'),checkRecovery=await runtime.mfa.password(r,password)
 const grant=await runtime.mfa.recover(r,{code:batch.codes[0],requestId:randomUUID(),expectedSecurityVersion:state.securityVersion,reauthenticationId:checkRecovery.id})
 assert.ok(await repo.resolve(claims(staff)));assert.ok(await repo.resolve(claims(sibling)))
 const replacement=new SoftwareAuthenticator(),replacementPending=await register(r,replacement,grant,checkRecovery)
 assert.ok(await repo.resolve(claims(staff)),'pending replacement must not revoke before signed activation')
 const result=await sign(r,replacement,'session_login',replacementPending.factorId)
 assert.equal(result.assurance.purpose,'session_login');assert.equal(result.assurance.sessionId,resident.id)
 assert.equal(await repo.resolve(claims(staff)),null);assert.equal(await repo.resolve(claims(sibling)),null);assert.ok(await repo.resolve(claims(resident)))
 assert.equal((await runtime.mfa.state(r)).assurances.some(a=>a.purpose==='organization_administration'),false)
 const allowed=await db.app.transaction({...context(resident),organizationId:'organization-a',propertyId:'property-a1'},async c=>(await c.query('SELECT atrium.staff_context() AS staff,atrium.hold_current_session() AS held')).rows[0])
 assert.deepEqual(allowed,{staff:false,held:false})
})
