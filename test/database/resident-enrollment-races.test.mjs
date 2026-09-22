import { consentTables } from '../helpers/consent-tables.mjs'
import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createEnrollmentFixture } from '../helpers/resident-enrollment.mjs'
import { PostgresResidentEnrollmentRepository } from '../../src/database/resident-enrollment.ts'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { hashEnrollmentToken } from '../../src/residents/enrollment-tokens.ts'
import { hashPassword } from '../../src/ops/accounts.ts'
let f, repository, scope, proof, passwordHash, replacementHash
const tables=['resident_enrollment_events','resident_enrollment_commands','resident_enrollment_attempts','resident_account_bindings','resident_enrollment_invites','resident_enrollment_policies','resident_enrollment_budgets']
const digest=()=>randomBytes(32).toString('hex')
before(async()=>{
 f=await createEnrollmentFixture();repository=new PostgresResidentEnrollmentRepository(f.db.app,f.db.auth)
 scope=(await f.runtime.loadUserProperty(f.actors['owner-a'].principal,{organizationId:'organization-a',propertyId:'property-a1'},'configure')).scope
 proof=(await f.runtime.mfa.administrationAuthentication(f.actors['owner-a'].principal).verifyCurrentSession(f.actors['owner-a'].principal)).verificationId
 passwordHash=await hashPassword('synthetic-resident-chosen-password');replacementHash=await hashPassword('synthetic-rotated-resident-password')
},{timeout:120_000})
beforeEach(async()=>{
 await f.db.admin.query(`TRUNCATE ${[...consentTables,...tables].map(t=>`atrium.${t}`).join(',')}`)
 await f.db.admin.query("UPDATE atrium.memberships SET status='active'")
 await f.publish(f.residents['property-a1'][0])
})
after(async()=>{await f?.close()})
const issue=(i=0)=>f.issue(f.residents['property-a1'][i])
const input=(invitation,changes={})=>({requestId:randomUUID(),tokenHash:hashEnrollmentToken(invitation.token),browserHash:digest(),clientKey:digest(),mode:'new',expectedInvitationVersion:1,username:`resident-${randomUUID()}`,displayName:'Synthetic chosen account',...changes})
const reserve=(value,principal=null)=>repository.reserveAcceptance(principal,value)
const accept=value=>repository.acceptNew(value,{passwordHash})
const settled=p=>p.then(value=>({value}),error=>({error}))
async function blocked(fragment='enrollment_resident',minimum=1){
 for(let i=0;i<200;i++){
  await f.db.admin.query('SELECT pg_stat_clear_snapshot()')
  const n=Number((await f.db.admin.query("SELECT count(*) n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",[`%${fragment}%`])).rows[0].n)
  if(n>=minimum)return
  await delay(10)
 }
 assert.fail(`Expected ${minimum} native lock wait(s) in ${fragment}`)
}
async function noAccount(value){assert.equal((await f.db.admin.query('SELECT 1 FROM atrium.users WHERE id=$1',[value.userId])).rowCount,0)}

test('two accounts race one invitation: one atomic winner and no orphan losing account or receipt',async()=>{
 const invitation=await issue(),a=await reserve(input(invitation)),b=await reserve(input(invitation))
 const results=await Promise.all([settled(accept(a)),settled(accept(b))])
 assert.equal(results.filter(r=>r.value).length,1)
 assert.equal(results.find(r=>r.error).error.code,'enrollment_invitation_unavailable')
 const winner=results.find(r=>r.value).value;await noAccount(winner.userId===a.userId?b:a)
 const counts=(await f.db.admin.query(`SELECT (SELECT count(*)::int FROM atrium.resident_account_bindings) b,
 (SELECT count(*)::int FROM atrium.resident_enrollment_attempts WHERE completed_at IS NOT NULL) r,
 (SELECT count(*)::int FROM atrium.resident_enrollment_events WHERE operation='binding.activated') e`)).rows[0]
 assert.deepEqual(counts,{b:1,r:1,e:1})
})
test('same incomplete request racing itself requires reconciliation, then exact verified replay returns one saved result',async()=>{
 const request=input(await issue()),saved=await reserve(request)
 const results=await Promise.all([settled(accept(saved)),settled(accept(saved))])
 assert.equal(results.filter(r=>r.value).length,1);assert.equal(results.find(r=>r.error).error.code,'enrollment_reconcile_required')
 const current=await reserve(request),replay=await repository.acceptNew(current,{passwordHash:current.passwordHash})
 assert.equal(replay.replayed,true);assert.equal(replay.bindingId,results.find(r=>r.value).value.bindingId)
})
test('concurrent equal usernames across properties never upsert or bind the losing invitation to the winning identity',async()=>{
 await f.publish(f.residents['property-a2'][0],{property:'property-a2'})
 const aInvite=await issue(),bInvite=await f.issue(f.residents['property-a2'][0],{property:'property-a2'})
 const username=`same-${randomUUID()}`,a=await reserve(input(aInvite,{username})),b=await reserve(input(bInvite,{username}))
 const results=await Promise.all([settled(accept(a)),settled(accept(b))])
 assert.equal(results.filter(r=>r.value).length,1);assert.equal(results.find(r=>r.error).error.code,'enrollment_username_unavailable')
 const winner=results.find(r=>r.value).value,loser=winner.userId===a.userId?b:a;await noAccount(loser)
 assert.equal((await f.db.admin.query('SELECT consumed_at FROM atrium.resident_enrollment_invites WHERE id=$1',[loser.invitationId])).rows[0].consumed_at,null)
 assert.equal((await f.db.admin.query('SELECT count(*)::int n FROM atrium.resident_account_bindings WHERE user_id=$1',[winner.userId])).rows[0].n,1)
})
test('own binding read queued behind a real staff revocation returns the committed revoked revision',async()=>{
 const value=input(await issue()),saved=await reserve(value),accepted=await accept(saved)
 const principal=await f.runtime.signInResident(value.username,'synthetic-resident-chosen-password','127.0.0.61')
 await f.db.admin.query('BEGIN');await f.db.admin.query("SELECT 1 FROM atrium.properties WHERE id='property-a1' FOR UPDATE")
 const revoke=settled(repository.executeStaff(scope,1,proof,{action:'revoke_binding',requestId:randomUUID(),id:accepted.bindingId,expectedVersion:1,reason:'Resident requested removal during queued read'}))
 let read
 try {
  await blocked('enrollment_staff')
  read=settled(repository.ownBindings(principal,{limit:10}));await blocked('enrollment_resident')
  await f.db.admin.query('COMMIT')
  const revoked=await revoke,own=await read
  assert.equal(revoked.error,undefined);assert.equal(own.error,undefined)
  assert.equal(own.value.items[0].state,'revoked');assert.equal(own.value.items[0].version,2)
 } finally {await f.db.admin.query('ROLLBACK');await revoke;if(read)await read}
})
test('completed-new receipt replay waits on its real user lock and refuses a concurrently committed password rotation',async()=>{
 const value=input(await issue()),saved=await reserve(value);await accept(saved)
 const replay=await reserve(value)
 await f.db.admin.query('BEGIN');await f.db.admin.query('UPDATE atrium.user_credentials SET password_hash=$2 WHERE user_id=$1',[saved.userId,replacementHash])
 const pending=settled(repository.acceptNew(replay,{passwordHash:replay.passwordHash}))
 try {await blocked();await f.db.admin.query('COMMIT');assert.equal((await pending).error.code,'enrollment_reconcile_required')}
 finally {await f.db.admin.query('ROLLBACK');await pending}
 assert.equal((await f.db.admin.query('SELECT count(*)::int n FROM atrium.resident_enrollment_events WHERE operation=$1',['binding.activated'])).rows[0].n,1)
})
for(const waitAt of ['property','audit'])test(`recipient-check expiry while activation waits at ${waitAt} rolls back newly inserted identity and binding`,async()=>{
 const residentId=f.residents['property-a1'][1],state=await repository.staffState(scope,1,residentId),token=randomBytes(32).toString('base64url')
 // Genuine staff issuance with an almost-24-hour-old check yields a real short
 // DB deadline; no immutable invitation, proof or source history is rewritten.
 const command={action:'issue_invitation',requestId:randomUUID(),residentId,expectedResidentVersion:state.resident.version,expectedPolicyVersion:state.policy.version,replaces:null,
 checkedAt:new Date(Date.now()-86400000+1300).toISOString(),evidenceReference:'Synthetic check nearing its real deadline',protocolCompleted:true,reason:'Time-bound recipient review'}
 await repository.executeStaff(scope,1,proof,command,{id:randomUUID(),tokenHash:hashEnrollmentToken(token)})
 const saved=await reserve(input({token}))
 await f.db.admin.query('BEGIN')
 if(waitAt==='property')await f.db.admin.query("SELECT 1 FROM atrium.properties WHERE id='property-a1' FOR UPDATE")
 else await f.db.admin.query('LOCK TABLE atrium.resident_enrollment_events IN ACCESS EXCLUSIVE MODE')
 const pending=settled(accept(saved))
 try {await blocked();await delay(Math.max(0,Date.parse(saved.expiresAt)-Date.now()+40));await f.db.admin.query('COMMIT');assert.equal((await pending).error.code,'enrollment_invitation_unavailable')}
 finally {await f.db.admin.query('ROLLBACK');await pending}
 await noAccount(saved)
 assert.equal((await f.db.admin.query('SELECT count(*)::int n FROM atrium.resident_account_bindings')).rows[0].n,0)
 assert.equal((await f.db.admin.query('SELECT completed_at FROM atrium.resident_enrollment_attempts WHERE id=$1',[saved.id])).rows[0].completed_at,null)
})
test('issuer permission revoked during password work refuses activation and leaves the global account absent',async()=>{
 const saved=await reserve(input(await issue()))
 await f.db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE user_id='owner-a' AND organization_id='organization-a'")
 await assert.rejects(accept(saved),{code:'enrollment_invitation_unavailable'});await noAccount(saved)
})
test('existing resident logout between password reservation and activation cannot consume the invitation',async()=>{
 const invitation=await issue(),principal=await f.runtime.signInResident('owner-a',f.password,'127.0.0.62')
 await verifyOrganizationSession(f.runtime,principal,f.password,{purpose:'session_login'})
 const saved=await reserve(input(invitation,{mode:'existing',username:principal.username,displayName:principal.displayName}),principal)
 await f.runtime.sessions.revoke(principal,principal.sessionId)
 await assert.rejects(repository.acceptExisting(principal,saved),{code:'enrollment_unauthenticated'})
 assert.equal((await f.db.admin.query('SELECT consumed_at FROM atrium.resident_enrollment_invites WHERE id=$1',[saved.invitationId])).rows[0].consumed_at,null)
})
test('simultaneous reservations across pooled transactions have an exact ten-token bound and leave all accepted requests durable',async()=>{
 const invitation=await issue(),results=await Promise.all(Array.from({length:16},()=>settled(reserve(input(invitation)))))
 assert.equal(results.filter(r=>r.value).length,10)
 assert.ok(results.filter(r=>r.error).every(r=>r.error.code==='enrollment_rate_limited'))
 assert.equal((await f.db.admin.query('SELECT count(*)::int n FROM atrium.resident_enrollment_attempts')).rows[0].n,10)
 assert.equal((await f.db.admin.query("SELECT cardinality(attempts) n FROM atrium.resident_enrollment_budgets WHERE kind='token'")).rows[0].n,10)
 const cleared=await f.db.auth.transaction({},c=>c.query("SELECT atrium.context('enrollment_token_hash') t,atrium.context('enrollment_new_user_id') u,atrium.context('organization_id') o,atrium.context('session_audience') a"))
 assert.deepEqual(cleared.rows[0],{t:null,u:null,o:null,a:null})
})
