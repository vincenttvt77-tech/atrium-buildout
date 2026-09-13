import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createFoundationTestDatabase,seedFoundationTestDatabase} from '../../scripts/lib/foundation-test.mjs'
import {PostgresMfaRepository} from '../../src/database/mfa.ts'
import {PostgresUserSessionRepository} from '../../src/database/user-sessions.ts'
import {PostgresPasswordChangeRepository} from '../../src/database/password-change.ts'
import {createPasswordChangeService} from '../../src/auth/password-change.ts'
import {DatabaseConnection} from '../../src/database/connection.ts'
import {issueAuthenticatedUser} from '../../src/auth/identity.ts'
import {createSessionManagementService} from '../../src/auth/session-management.ts'
import {createMfaService} from '../../src/auth/mfa.ts'
import {verifyWebAuthn} from '../../src/auth/webauthn.ts'
import {SoftwareAuthenticator} from '../helpers/software-authenticator.mjs'

const configuration={origin:'https://atrium.example.test',rpId:'atrium.example.test',rpName:'Atrium'}
let db,repo,other,otherRepo,service,sessions,password,hash
const digest=value=>createHash('sha256').update(value).digest('hex')
const context=p=>({actorUserId:p.userId,credentialVersion:p.credentialVersion,actorSessionId:p.sessionId})
before(async()=>{
 db=await createFoundationTestDatabase();({password}=await seedFoundationTestDatabase(db.admin))
 hash=(await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
 const options=db.auth.pool.options;other=new DatabaseConnection({...options,password:options.password,max:8},'atrium_authenticator')

 repo=new PostgresMfaRepository(db.auth,configuration);otherRepo=new PostgresMfaRepository(other,configuration)
 service=createMfaService(repo,configuration);sessions=createSessionManagementService(new PostgresUserSessionRepository(db.auth))
})
after(async()=>{if(other)await other.close();if(db)await db.close()})
async function user(role='owner'){
 const id=`mfa-${randomBytes(8).toString('hex')}`
 await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,'Synthetic test identity','active')",[id])
 await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)',[id,hash])
 if(role)await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES($1,$2,'organization-a',$3,'organization','active')",[`member-${id}`,id,role])
 const fresh=issueAuthenticatedUser({id,username:id,displayName:'Synthetic test identity',credentialVersion:1,status:'active'})
 return {fresh,principal:await sessions.start(fresh,{label:'Synthetic browser'})}
}
async function registration(p,grant=null,pw=null,device=new SoftwareAuthenticator()){
 pw??=await service.password(p,password)
 const options=await service.registrationOptions(p,{label:'Synthetic passkey',reauthenticationId:pw.id,recoveryGrantId:grant?.id??null})
 const response=device.registrationResponse({challenge:options.optionsJSON.challenge,...configuration})
 const pending=await service.finish(p,{kind:'registration',challengeId:options.challengeId,response})
 return {device,pending,options,response}
}
async function authentication(p,device,purpose='session_login',factorId=null,counter=0){
 const options=await service.authenticationOptions(p,{purpose,factorId})
 const response=device.authenticationResponse({challenge:options.optionsJSON.challenge,...configuration,counter})
 return {options,response,finish:()=>service.finish(p,{kind:'authentication',challengeId:options.challengeId,response})}
}
async function enroll(p){const value=await registration(p);await(await authentication(p,value.device,'session_login',value.pending.factorId)).finish();return value}
async function management(p,device){await(await authentication(p,device,'manage_factors')).finish();return service.password(p,password)}
async function claim(p,prepared,selected=repo){return selected.claimCeremony(p,{challengeId:prepared.options.challengeId,attemptId:randomUUID(),responseDigest:digest(JSON.stringify(prepared.response)),credentialId:prepared.response.id})}
const data=async(table,p)=>(await db.admin.query(`SELECT * FROM atrium.${table} WHERE user_id=$1`,[p.userId])).rows
async function gate(p){return db.app.transaction({...context(p),organizationId:'organization-a',propertyId:'property-a1'},async c=>(await c.query("SELECT atrium.hold_current_session() fence,atrium.can_access_property('organization-a','property-a1','read') allowed")).rows[0])}

test('migration exactness and finite role privileges exclude raw runtime MFA/credential mutation',async()=>{
 assert.equal(await readFile(new URL('../../db/mfa.sql',import.meta.url),'utf8'),await readFile(new URL('../../supabase/migrations/20260910020924_webauthn_mfa.sql',import.meta.url),'utf8'))
 const role=(await db.admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='atrium_mfa_executor'")).rows[0]
 assert.ok(Object.values(role).every(v=>v===false))
 const {principal:p}=await user()
 for(const connection of [db.app,db.auth])for(const query of ['SELECT * FROM atrium.mfa_factors',"UPDATE atrium.mfa_states SET ever_enabled=false",'DELETE FROM atrium.mfa_events'])await assert.rejects(connection.transaction(context(p),c=>c.query(query)),{code:'42501'})
 assert.equal((await db.admin.query("SELECT has_table_privilege('atrium_mfa_executor','atrium.user_credentials','UPDATE') v,has_schema_privilege('atrium_mfa_executor','atrium','CREATE') c")).rows[0].v,false)
 await assert.rejects(db.app.transaction(context(p),c=>c.query("SELECT atrium.mfa_read_state('{}',$1,$2,$3)",[configuration.origin,configuration.rpId,randomBytes(32).toString('base64url')])),{code:'42501'})
 await db.admin.query('GRANT atrium_mfa_executor TO atrium_authenticator')
 try{await assert.rejects(db.auth.transaction({},async()=>true),{name:'DatabaseConfigurationError'})}finally{await db.admin.query('REVOKE atrium_mfa_executor FROM atrium_authenticator')}
})

test('owner needs actual confirmed assertion; pending registration cannot unlock RLS or password change',async()=>{
 const {principal:p}=await user();assert.equal((await service.state(p)).required,true);assert.deepEqual(await gate(p),{fence:false,allowed:false})
 await assert.rejects(new PostgresPasswordChangeRepository(db.auth).reserve(p,randomUUID()),{code:'unauthenticated'})
 const {device,pending}=await registration(p);assert.equal(pending.outcome,'factor_pending');assert.deepEqual(await gate(p),{fence:false,allowed:false})
 assert.equal(await repo.currentProof(p,'organization_administration'),null)
 const proof=await(await authentication(p,device,'session_login',pending.factorId)).finish();assert.equal(proof.outcome,'verified')
 assert.deepEqual(await gate(p),{fence:true,allowed:true});const state=await service.state(p);assert.equal(state.everEnabled,true);assert.equal(state.securityVersion,2)
 assert.equal(state.assurances[0].expiresAt,p.sessionExpiresAt);assert.equal((await data('mfa_events',p)).some(e=>e.operation==='factor.activated'),true)
 const tx=(await db.admin.query('SELECT (SELECT xmin::text FROM atrium.mfa_factors WHERE id=$1) factor,(SELECT xmin::text FROM atrium.mfa_assurances WHERE id=$2) proof,(SELECT xmin::text FROM atrium.mfa_challenges WHERE id=$3) challenge',[pending.factorId,proof.assurance.id,proof.challengeId])).rows[0]
 assert.equal(tx.factor,tx.proof);assert.equal(tx.factor,tx.challenge)
})

test('viewer-only password session stays allowed until enrollment; staff membership requires MFA globally',async()=>{
 const {principal:p}=await user('viewer');assert.equal((await service.state(p)).required,false);assert.equal((await gate(p)).allowed,true)
 await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES($1,$2,'organization-b','staff','properties','active')",[`second-${p.userId}`,p.userId])
 assert.equal((await service.state(p)).required,true);assert.equal((await gate(p)).allowed,false)
 await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id=$1",[`second-${p.userId}`])
 await enroll(p);assert.equal((await service.state(p)).everEnabled,true)
 await sessions.revoke(p,'others');const fresh=issueAuthenticatedUser({id:p.userId,username:p.username,displayName:p.displayName,credentialVersion:1,status:'active'}),otherP=await sessions.start(fresh,{label:'Other browser'})
 assert.equal((await service.state(otherP)).required,true);assert.equal((await gate(otherP)).allowed,false)
})

test('password reservations are committed before hashing and shared 10-per-user budget is exact across connections',async()=>{
 const {principal:p,fresh}=await user();const second=await sessions.start(fresh,{label:'Second'})
 await assert.rejects(service.password(p,'wrong synthetic password'),{code:'incorrect_password'})
 const values=await Promise.allSettled(Array.from({length:15},(_,i)=>(i%2?otherRepo:repo).reservePassword(i%2?second:p,randomUUID())))
 assert.equal(values.filter(v=>v.status==='fulfilled').length,9);assert.equal(values.filter(v=>v.status==='rejected'&&v.reason.code==='rate_limited').length,6)
 const attempts=await data('mfa_attempts',p);assert.equal(attempts.filter(a=>a.kind==='password').length,10)
 const checks=await data('mfa_password_checks',p);assert.equal(checks.length,10);assert.ok(checks.every(c=>c.verified_at_ms===null))
 await db.admin.query("UPDATE atrium.mfa_attempts SET at_ms=at_ms-900001 WHERE user_id=$1",[p.userId]);assert.ok(await repo.reservePassword(p,randomUUID()))
 assert.throws(()=>repo.completePassword(p,{reservation:checks[0]}),{code:'reauthentication_required'})
})

test('challenge is exact session/realm bound and failed actual signature consumes its one attempt',async()=>{
 const {principal:p,fresh}=await user();const second=await sessions.start(fresh,{label:'Second'}),{device}=await enroll(p)
 const prepared=await authentication(p,device);await assert.rejects(claim(second,prepared),{code:'verification_failed'})
 const wrong=new SoftwareAuthenticator();prepared.response=wrong.authenticationResponse({challenge:prepared.options.optionsJSON.challenge,...configuration,credentialId:device.credentialId})
 await assert.rejects(service.finish(p,{kind:'authentication',challengeId:prepared.options.challengeId,response:prepared.response}),{code:'verification_failed'})
 await assert.rejects(claim(p,prepared),{code:'challenge_used'})
 const stored=(await data('mfa_challenges',p)).find(c=>c.id===prepared.options.challengeId);assert.equal(stored.status,'rejected')
 const otherRealm=new PostgresMfaRepository(db.auth,{origin:'https://other.example.test',rpId:'other.example.test',rpName:'Atrium'})
 await assert.rejects(otherRealm.readState(p),{code:'state_changed'})
})

test('zero-counter signed assertions require both consumed challenge and counterRevision CAS',async()=>{
 const {principal:p}=await user(),{device}=await enroll(p)
 const a=await authentication(p,device),b=await authentication(p,device)
 const ca=await claim(p,a),cb=await claim(p,b,otherRepo)
 const [va,vb]=await Promise.all([verifyWebAuthn(ca,a.response),verifyWebAuthn(cb,b.response)])
 const results=await Promise.allSettled([repo.finishCeremony(p,va),otherRepo.finishCeremony(p,vb)])
 assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.filter(v=>v.status==='rejected'&&v.reason.code==='state_changed').length,1)
 const winner=results[0].status==='fulfilled'?va:vb;const receipt=await repo.finishCeremony(p,winner)
 assert.equal(receipt.outcome,'verified');await assert.rejects(claim(p,results[0].status==='fulfilled'?a:b),{code:'challenge_used'})
})

test('later add requires password plus current manage proof; last active factor cannot be removed',async()=>{
 const {principal:p}=await user(),first=await enroll(p)
 const pw=await service.password(p,password)
 await assert.rejects(service.registrationOptions(p,{label:'Second',reauthenticationId:pw.id,recoveryGrantId:null}),{code:'mfa_required'})
 await(await authentication(p,first.device,'manage_factors')).finish()
 await assert.rejects(service.removeFactor(p,{factorId:first.pending.factorId,requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:pw.id}),{code:'last_factor'})
 const next=await registration(p,null,pw);await(await authentication(p,next.device,'session_login',next.pending.factorId)).finish()
 assert.equal((await service.state(p)).factors.length,2);assert.equal(await repo.currentProof(p,'manage_factors'),null)
 const currentPw=await management(p,next.device);const before=(await service.state(p)).securityVersion
 await service.removeFactor(p,{factorId:first.pending.factorId,requestId:randomUUID(),expectedSecurityVersion:before,reauthenticationId:currentPw.id})
 assert.equal((await service.state(p)).factors.length,1);assert.equal((await service.state(p)).securityVersion,before+1)
})

test('recovery returns only a restricted grant; replacement assertion atomically revokes old factors and other sessions',async()=>{
 const {principal:p,fresh}=await user(),first=await enroll(p);const pw=await management(p,first.device)
 const batch=await service.rotateRecovery(p,{requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:pw.id})
 const second=await sessions.start(fresh,{label:'Recovering browser'}),third=await sessions.start(fresh,{label:'Sibling browser'})
 const reauth=await service.password(second,password),requestId=randomUUID()
 const grant=await service.recover(second,{code:batch.codes[0],requestId,expectedSecurityVersion:2,reauthenticationId:reauth.id})
 assert.equal(await repo.currentProof(second,'session_login'),null);assert.equal(await repo.currentProof(second,'organization_administration'),null)
 assert.equal((await data('mfa_factors',p)).filter(f=>f.status==='active').length,1);assert.ok(await sessions.list(third))
 const replacement=await registration(second,grant,reauth)
 assert.ok(await sessions.list(third));assert.equal((await data('mfa_factors',p)).filter(f=>f.status==='active').length,1)
 const activation=await authentication(second,replacement.device,'session_login',replacement.pending.factorId)
 const recoveryClaim=await claim(second,activation),recoveryVerified=await verifyWebAuthn(recoveryClaim,activation.response)
 await db.admin.query('REVOKE INSERT ON atrium.user_session_events FROM atrium_mfa_executor')
 try{await assert.rejects(repo.finishCeremony(second,recoveryVerified),{code:'mfa_unavailable'})}finally{await db.admin.query('GRANT INSERT ON atrium.user_session_events TO atrium_mfa_executor')}
 assert.ok(await sessions.list(third));assert.equal((await data('mfa_factors',p)).filter(f=>f.status==='active').length,1)
 assert.equal((await service.state(second)).securityVersion,2)
 const done=await repo.finishCeremony(second,recoveryVerified);assert.equal(done.assurance.purpose,'session_login')
 await assert.rejects(sessions.list(p),{code:'unauthenticated'});await assert.rejects(sessions.list(third),{code:'unauthenticated'})
 const state=await service.state(second);assert.equal(state.factors.length,1);assert.equal(state.recoveryRemaining,0);assert.equal(state.securityVersion,3)
 assert.equal(await repo.currentProof(second,'organization_administration'),null)
})

test('ten active passkeys permit one recovery replacement only, including concurrent signed registrations and audit rollback',async()=>{
 const {principal:p,fresh}=await user(),original=[await enroll(p)]
 for(let i=1;i<10;i++){
  const approval=await management(p,original.at(-1).device),next=await registration(p,null,approval)
  await(await authentication(p,next.device,'session_login',next.pending.factorId)).finish();original.push(next)
 }
 assert.equal((await service.state(p)).factors.filter(f=>f.status==='active').length,10)
 // Only age this synthetic user's attempt window. Every factor above was enrolled
 // and activated through real password verification and signed WebAuthn responses.
 await db.admin.query("UPDATE atrium.mfa_attempts SET at_ms=at_ms-900001 WHERE user_id=$1 AND kind='password'",[p.userId])
 const approval=await management(p,original.at(-1).device),version=(await service.state(p)).securityVersion
 const batch=await service.rotateRecovery(p,{requestId:randomUUID(),expectedSecurityVersion:version,reauthenticationId:approval.id})
 const ordinary=await service.password(p,password)
 await assert.rejects(service.registrationOptions(p,{label:'Ordinary eleventh key',reauthenticationId:ordinary.id,recoveryGrantId:null}),{code:'factor_limit'})
 const recovering=await Promise.all(['Recovery browser A','Recovery browser B'].map(label=>sessions.start(fresh,{label})))
 const passwords=await Promise.all(recovering.map(actor=>service.password(actor,password)))
 const grants=await Promise.all(recovering.map((actor,i)=>service.recover(actor,{code:batch.codes[i],requestId:randomUUID(),expectedSecurityVersion:version,reauthenticationId:passwords[i].id})))
 assert.ok((await Promise.all(recovering.map(actor=>repo.currentProof(actor,'manage_factors')))).every(value=>value===null))
 const options=await Promise.all(recovering.map((actor,i)=>service.registrationOptions(actor,{label:'Lost-key replacement',reauthenticationId:passwords[i].id,recoveryGrantId:grants[i].id})))
 const devices=[new SoftwareAuthenticator(),new SoftwareAuthenticator()]
 const prepared=options.map((value,i)=>({options:value,response:devices[i].registrationResponse({challenge:value.optionsJSON.challenge,...configuration})}))
 const claims=await Promise.all(recovering.map((actor,i)=>claim(actor,prepared[i],i?otherRepo:repo)))
 const verified=await Promise.all(claims.map((value,i)=>verifyWebAuthn(value,prepared[i].response)))
 await db.admin.query('REVOKE INSERT ON atrium.mfa_events FROM atrium_mfa_executor')
 try{await assert.rejects(repo.finishCeremony(recovering[0],verified[0]),{code:'mfa_unavailable'})}
 finally{await db.admin.query('GRANT INSERT ON atrium.mfa_events TO atrium_mfa_executor')}
 assert.equal((await service.state(recovering[0])).factors.length,10)
 assert.ok((await data('mfa_recovery_grants',p)).every(grant=>grant.consumed_by===null))
 assert.ok((await data('mfa_challenges',p)).filter(c=>claims.some(claimed=>claimed.id===c.id)).every(c=>c.status==='claimed'))
 const outcomes=await Promise.allSettled(recovering.map((actor,i)=>(i?otherRepo:repo).finishCeremony(actor,verified[i])))
 assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1)
 assert.equal(outcomes.filter(value=>value.status==='rejected'&&value.reason.code==='factor_limit').length,1)
 const winning=outcomes.findIndex(value=>value.status==='fulfilled'),losing=1-winning
 const pending=outcomes[winning].value,state=await service.state(recovering[winning])
 assert.equal(state.factors.length,11);assert.equal(state.factors.filter(f=>f.status==='active').length,10)
 assert.equal(state.factors.filter(f=>f.status==='pending').length,1)
 assert.equal((await data('mfa_recovery_grants',p)).filter(grant=>grant.consumed_by!==null).length,1)
 await assert.rejects(service.registrationOptions(recovering[losing],{label:'Extra recovery replacement',reauthenticationId:passwords[losing].id,recoveryGrantId:grants[losing].id}),{code:'factor_limit'})
 await assert.rejects(service.registrationOptions(p,{label:'Ordinary key during recovery',reauthenticationId:ordinary.id,recoveryGrantId:null}),{code:'factor_limit'})
 const receipt=await(await authentication(recovering[winning],devices[winning],'session_login',pending.factorId)).finish()
 assert.equal(receipt.assurance.purpose,'session_login')
 const completed=await service.state(recovering[winning])
 assert.equal(completed.factors.length,1);assert.equal(completed.factors[0].status,'active');assert.equal(completed.factors[0].id,pending.factorId)
 assert.equal((await data('mfa_factors',p)).filter(f=>original.some(item=>item.pending.factorId===f.id)&&f.status==='revoked').length,10)
 await assert.rejects(sessions.list(p),{code:'unauthenticated'});await assert.rejects(sessions.list(recovering[losing]),{code:'unauthenticated'})
 assert.equal(await repo.currentProof(recovering[winning],'organization_administration'),null)
})

test('same recovery batch may retry exactly; another generated batch with same request cannot return false success',async()=>{
 const {principal:p}=await user(),{device}=await enroll(p),pw=await management(p,device)
 const input={requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:pw.id,codes:Array.from({length:10},()=>({id:randomUUID(),hash:digest(randomBytes(16))}))}
 const first=await repo.rotateRecoveryCodes(p,input);assert.deepEqual(await otherRepo.rotateRecoveryCodes(p,input),first)
 await assert.rejects(repo.rotateRecoveryCodes(p,{...input,codes:input.codes.map(c=>({...c,hash:digest(randomBytes(16))}))}),{code:'state_changed'})
 assert.equal((await data('mfa_recovery_codes',p)).length,10)
})

test('audit outage rolls back signed assertion activation and cannot issue a proof',async()=>{
 const {principal:p}=await user(),{device,pending}=await registration(p),prepared=await authentication(p,device,'session_login',pending.factorId)
 const claimed=await claim(p,prepared),verified=await verifyWebAuthn(claimed,prepared.response)
 await db.admin.query('REVOKE INSERT ON atrium.mfa_events FROM atrium_mfa_executor')
 try{await assert.rejects(repo.finishCeremony(p,verified),{code:'mfa_unavailable'})}finally{await db.admin.query('GRANT INSERT ON atrium.mfa_events TO atrium_mfa_executor')}
 assert.equal((await service.state(p)).everEnabled,false);assert.equal((await data('mfa_factors',p))[0].status,'pending');assert.equal((await data('mfa_assurances',p)).length,0)
 assert.equal((await data('mfa_challenges',p)).find(c=>c.id===claimed.id).status,'claimed');assert.equal((await repo.finishCeremony(p,verified)).outcome,'verified')
})

test('revocation and password rotation between real verification and commit refuse stale evidence',async()=>{
 const {principal:p,fresh}=await user(),{device}=await enroll(p),controller=await sessions.start(fresh,{label:'Controller'})
 const prepared=await authentication(p,device),claimed=await claim(p,prepared),verified=await verifyWebAuthn(claimed,prepared.response)
 await sessions.revoke(controller,p.sessionId);await assert.rejects(repo.finishCeremony(p,verified),{code:'unauthenticated'})
 const otherPrepared=await authentication(controller,device),otherClaim=await claim(controller,otherPrepared),otherVerified=await verifyWebAuthn(otherClaim,otherPrepared.response)
 await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2',[hash.replace(/.$/,hash.endsWith('0')?'1':'0'),p.userId])
 await assert.rejects(repo.finishCeremony(controller,otherVerified),{code:'unauthenticated'})
})

test('MFA-backed password change rotates once and audit succeeds across the credential trigger transition',async()=>{
 const {principal:p}=await user();await enroll(p)
 const changes=createPasswordChangeService(new PostgresPasswordChangeRepository(db.auth))
 await changes.changeOwnPassword(p,{currentPassword:password,newPassword:'Synthetic replacement long password'})
 const row=(await db.admin.query('SELECT credential_version FROM atrium.users WHERE id=$1',[p.userId])).rows[0];assert.equal(Number(row.credential_version),2)
 await assert.rejects(service.state(p),{code:'unauthenticated'});assert.equal((await data('account_security_events',p)).length,1)
})

// The administrator changes fixture time only; production commands cannot change
// immutable deadlines. No wall-clock sleep or persistent preview is involved.
async function ageFixture(table,trigger,id,fields){
 await db.admin.query('BEGIN')
 try{await db.admin.query(`ALTER TABLE atrium.${table} DISABLE TRIGGER ${trigger}`)
  await db.admin.query(`UPDATE atrium.${table} SET ${fields} WHERE id=$1`,[id])
  await db.admin.query(`ALTER TABLE atrium.${table} ENABLE TRIGGER ${trigger}`);await db.admin.query('COMMIT')
 }catch(error){await db.admin.query('ROLLBACK');throw error}
}

test('expired pending factor is retired and a fresh bootstrap can proceed without resetting enrollment history',async()=>{
 const {principal:p}=await user(),old=await registration(p)
 await ageFixture('mfa_factors','mfa_factor_history',old.pending.factorId,'created_at_ms=created_at_ms-300001,pending_expires_at_ms=pending_expires_at_ms-300001')
 assert.equal((await service.state(p)).factors.length,0)
 await assert.rejects(service.authenticationOptions(p,{purpose:'session_login',factorId:old.pending.factorId}),{code:'invalid_input'})
 const next=await enroll(p);assert.notEqual(next.pending.factorId,old.pending.factorId)
 const historical=await data('mfa_factors',p);assert.equal(historical.find(f=>f.id===old.pending.factorId).status,'expired')
 await assert.rejects(db.admin.query('UPDATE atrium.mfa_states SET ever_enabled=false WHERE user_id=$1',[p.userId]),{code:'23514'})
})

test('expired claim and reauthentication are refused against database clock without waiting',async()=>{
 const {principal:p}=await user(),pw=await service.password(p,password)
 await ageFixture('mfa_password_checks','mfa_password_history',pw.id,'created_at_ms=created_at_ms-300001,expires_at_ms=expires_at_ms-300001,verified_at_ms=verified_at_ms-300001')
 await assert.rejects(service.registrationOptions(p,{label:'Expired approval',reauthenticationId:pw.id,recoveryGrantId:null}),{code:'reauthentication_required'})
 const {device}=await enroll(p),prepared=await authentication(p,device)
 await ageFixture('mfa_challenges','mfa_ceremony_history',prepared.options.challengeId,'created_at_ms=created_at_ms-300001,expires_at_ms=expires_at_ms-300001')
 await assert.rejects(claim(p,prepared),{code:'challenge_expired'})
})

test('two simultaneous first registrations cannot establish competing bootstrap factors',async()=>{
 const {principal:p}=await user();const passwords=await Promise.all([service.password(p,password),service.password(p,password)])
 const preparations=await Promise.all(passwords.map(pw=>service.registrationOptions(p,{label:'Concurrent bootstrap',reauthenticationId:pw.id,recoveryGrantId:null})))
 const devices=[new SoftwareAuthenticator(),new SoftwareAuthenticator()]
 const prepared=preparations.map((options,i)=>({options,response:devices[i].registrationResponse({challenge:options.optionsJSON.challenge,...configuration})}))
 const claims=await Promise.all(prepared.map(value=>claim(p,value)))
 const verified=await Promise.all(claims.map((c,i)=>verifyWebAuthn(c,prepared[i].response)))
 const outcomes=await Promise.allSettled(verified.map((v,i)=>(i?otherRepo:repo).finishCeremony(p,v)))
 assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1)
 assert.equal(outcomes.filter(v=>v.status==='rejected'&&v.reason.code==='state_changed').length,1)
 assert.equal((await service.state(p)).factors.length,1);assert.equal((await service.state(p)).everEnabled,false)
})

test('concurrent removals preserve one active factor and reject stale expected security version',async()=>{
 const {principal:p}=await user(),first=await enroll(p)
 const pw=await management(p,first.device),second=await registration(p,null,pw)
 await(await authentication(p,second.device,'session_login',second.pending.factorId)).finish()
 await(await authentication(p,first.device,'manage_factors')).finish()
 const receipts=await Promise.all([service.password(p,password),service.password(p,password)])
 const version=(await service.state(p)).securityVersion
 const values=await Promise.allSettled([first,second].map((factor,i)=>(i?otherRepo:repo).revokeFactor(p,{requestId:randomUUID(),expectedSecurityVersion:version,reauthenticationId:receipts[i].id,factorId:factor.pending.factorId})))
 assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(values.filter(v=>v.status==='rejected'&&v.reason.code==='state_changed').length,1)
 assert.equal((await service.state(p)).factors.filter(f=>f.status==='active').length,1);assert.equal((await gate(p)).allowed,false)
})

test('ceremony admission shares exact sixty-attempt budget across two connection pools',async()=>{
 const {principal:p}=await user();await enroll(p)
 const count=(await data('mfa_attempts',p)).filter(a=>a.kind==='ceremony').length;assert.equal(count,2)
 const values=await Promise.allSettled(Array.from({length:65},(_,i)=>(i%2?otherRepo:repo).beginCeremony(p,{id:randomUUID(),challengeHash:digest(randomBytes(32)),kind:'authentication',intent:'verify',purpose:'session_login',expectedSecurityVersion:2,label:null,reauthenticationId:null,factorId:null,recoveryGrantId:null})))
 assert.equal(values.filter(v=>v.status==='fulfilled').length,58);assert.equal(values.filter(v=>v.status==='rejected'&&v.reason.code==='rate_limited').length,7)
 assert.equal((await data('mfa_attempts',p)).filter(a=>a.kind==='ceremony').length,60)
})

test('one recovery code cannot be redeemed twice across concurrent sessions; failed attempts retain durable reservations',async()=>{
 const {principal:p,fresh}=await user(),{device}=await enroll(p),pw=await management(p,device)
 const batch=await service.rotateRecovery(p,{requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:pw.id})
 const second=await sessions.start(fresh,{label:'Other recovery'}),r=await Promise.all([service.password(p,password),service.password(second,password)])
 const codeHash=digest(`atrium-recovery-v1:${p.userId}:${batch.codes[0].replaceAll('-','')}`)
 const inputs=r.map(v=>({requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:v.id,codeHash}))
 const values=await Promise.allSettled([repo.redeemRecoveryCode(p,inputs[0]),otherRepo.redeemRecoveryCode(second,inputs[1])])
 assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(values.filter(v=>v.status==='rejected'&&v.reason.code==='recovery_failed').length,1)
 assert.equal((await data('mfa_recovery_codes',p)).filter(c=>c.consumed_by).length,1)
 assert.equal((await data('mfa_attempts',p)).filter(c=>c.kind==='recovery').length,2)
 // Fill the remaining finite window with synthetic timestamps, never a live code.
 await db.admin.query("INSERT INTO atrium.mfa_attempts(id,user_id,kind,at_ms) SELECT gen_random_uuid(),$1,'recovery',floor(extract(epoch FROM clock_timestamp())*1000)::bigint FROM generate_series(1,8)",[p.userId])
 const next=await service.password(p,password)
 await assert.rejects(repo.redeemRecoveryCode(p,{requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:next.id,codeHash:digest('unknown synthetic code')}),{code:'rate_limited'})
 assert.equal((await data('mfa_attempts',p)).filter(c=>c.kind==='recovery').length,10)
})

test('privileged proof fence is session/purpose scoped and expiry never renews on read',async()=>{
 const {principal:p,fresh}=await user(),{device}=await enroll(p)
 const response=await(await authentication(p,device,'organization_administration')).finish(),proof=response.assurance
 assert.equal(proof.expiresAt-proof.verifiedAt,600000);assert.ok(await repo.currentProof(p,'session_login'))
 assert.equal((await db.app.transaction(context(p),async c=>(await c.query("SELECT atrium.mfa_hold_proof($1,'organization_administration') ok",[proof.id])).rows[0])).ok,true)
 const second=await sessions.start(fresh,{label:'Other browser'})
 assert.equal((await db.app.transaction(context(second),async c=>(await c.query("SELECT atrium.mfa_hold_proof($1,'organization_administration') ok",[proof.id])).rows[0])).ok,false)
 await ageFixture('mfa_assurances','mfa_assurance_immutable',proof.id,'verified_at_ms=verified_at_ms-600001,expires_at_ms=expires_at_ms-600001')
 assert.equal(await repo.currentProof(p,'organization_administration'),null);assert.ok(await repo.currentProof(p,'session_login'))
 assert.equal((await db.app.transaction(context(p),async c=>(await c.query("SELECT atrium.mfa_hold_proof($1,'organization_administration') ok",[proof.id])).rows[0])).ok,false)
})

test('challenge and credential authority fields cannot be rebound or reopened by a maintenance mistake',async()=>{
 const {principal:p}=await user(),{device,pending}=await enroll(p),prepared=await authentication(p,device)
 const c=await claim(p,prepared);await repo.rejectCeremony(p,c)
 for(const query of ["UPDATE atrium.mfa_challenges SET status='ready',attempt_id=NULL,response_digest=NULL WHERE id=$1","UPDATE atrium.mfa_challenges SET purpose='manage_factors' WHERE id=$1",'DELETE FROM atrium.mfa_challenges WHERE id=$1'])await assert.rejects(db.admin.query(query,[c.id]),{code:'23514'})
 for(const query of ["UPDATE atrium.mfa_factors SET user_id='owner-b' WHERE id=$1","UPDATE atrium.mfa_factors SET public_key='AAAA' WHERE id=$1",'DELETE FROM atrium.mfa_factors WHERE id=$1'])await assert.rejects(db.admin.query(query,[pending.factorId]),{code:'23514'})
 const receipt=await service.password(p,password)
 await assert.rejects(db.admin.query('UPDATE atrium.mfa_password_checks SET session_id=$1 WHERE id=$2',[randomUUID(),receipt.id]),{code:'23514'})
})

async function waitingForMfaLock(){
 for(let attempt=0;attempt<100;attempt++){
  const waiting=Number((await db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE usename='atrium_authenticator' AND wait_event_type='Lock'")).rows[0].count)
  if(waiting)return
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 assert.fail('Synthetic MFA mutation never reached its row-lock barrier')
}

test('an admitted property operation retains user/session fence until commit before factor revocation',async()=>{
 const {principal:p}=await user(),first=await enroll(p),pw=await management(p,first.device),second=await registration(p,null,pw)
 await(await authentication(p,second.device,'session_login',second.pending.factorId)).finish()
 const approval=await management(p,second.device),version=(await service.state(p)).securityVersion
 let release,admitted;const ready=new Promise(resolve=>{admitted=resolve}),hold=new Promise(resolve=>{release=resolve})
 const operation=db.app.transaction({...context(p),organizationId:'organization-a',propertyId:'property-a1'},async client=>{
  assert.equal((await client.query('SELECT atrium.hold_current_session() ok')).rows[0].ok,true)
  admitted();await hold
  await client.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-a1',$1,'{\"synthetic\":true}')",[`mfa-fence:${p.userId}`])
 })
 await ready;let finished=false
 const revocation=otherRepo.revokeFactor(p,{factorId:first.pending.factorId,requestId:randomUUID(),expectedSecurityVersion:version,reauthenticationId:approval.id}).then(value=>{finished=true;return value})
 try{await waitingForMfaLock();assert.equal(finished,false)}finally{release()}
 await operation;await revocation
 assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.operational_documents WHERE key=$1',[`mfa-fence:${p.userId}`])).rows[0].n,1)
 assert.deepEqual(await gate(p),{fence:false,allowed:false})
})

test('failed operation releases its fence and rolls back before waiting MFA mutation commits',async()=>{
 const {principal:p}=await user(),{device}=await enroll(p);await(await authentication(p,device,'manage_factors')).finish()
 const approval=await service.password(p,password)
 let release,admitted;const ready=new Promise(resolve=>{admitted=resolve}),hold=new Promise(resolve=>{release=resolve})
 const operation=db.app.transaction(context(p),async client=>{
  assert.equal((await client.query('SELECT atrium.hold_current_session() ok')).rows[0].ok,true)
  admitted();await hold;throw new Error('Synthetic rollback after admission')
 }).catch(error=>error)
 await ready
 const input={requestId:randomUUID(),expectedSecurityVersion:2,reauthenticationId:approval.id,codes:Array.from({length:10},()=>({id:randomUUID(),hash:digest(randomBytes(16))}))}
 const mutation=otherRepo.rotateRecoveryCodes(p,input)
 try{await waitingForMfaLock()}finally{release()}
 assert.match((await operation).message,/Synthetic rollback/);assert.equal((await mutation).count,10)
 assert.equal((await service.state(p)).recoveryRemaining,10)
})
