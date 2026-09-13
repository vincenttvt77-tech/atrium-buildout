import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createEnrollmentFixture } from '../helpers/resident-enrollment.mjs'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { PostgresResidentEnrollmentRepository } from '../../src/database/resident-enrollment.ts'
import { PostgresResidentServicesRepository } from '../../src/database/resident-services.ts'
import { hashEnrollmentToken } from '../../src/residents/enrollment-tokens.ts'
import { hashPassword, verifyPassword } from '../../src/ops/accounts.ts'
let f, repository, scope, proof, passwordHash
const tables = ['resident_enrollment_events','resident_enrollment_commands','resident_enrollment_attempts','resident_account_bindings','resident_enrollment_invites','resident_enrollment_policies','resident_enrollment_budgets']
const digest = () => randomBytes(32).toString('hex')
const username = () => `resident-${randomUUID()}`
before(async () => {
 f = await createEnrollmentFixture(); repository = new PostgresResidentEnrollmentRepository(f.db.app,f.db.auth)
 scope = (await f.runtime.loadUserProperty(f.actors['owner-a'].principal,{organizationId:'organization-a',propertyId:'property-a1'},'configure')).scope
 proof = (await f.runtime.mfa.administrationAuthentication(f.actors['owner-a'].principal).verifyCurrentSession(f.actors['owner-a'].principal)).verificationId
 passwordHash = await hashPassword('synthetic-resident-chosen-password')
}, {timeout:120_000})
beforeEach(async () => {
 await f.db.admin.query(`TRUNCATE ${tables.map(t=>`atrium.${t}`).join(',')}`)
 await f.publish(f.residents['property-a1'][0])
})
after(async () => { await f?.close() })
const issue = (i=0) => f.issue(f.residents['property-a1'][i])
function input(invite, changes={}) { return {requestId:randomUUID(),tokenHash:hashEnrollmentToken(invite.token),browserHash:digest(),clientKey:digest(),mode:'new',expectedInvitationVersion:1,username:username(),displayName:'Synthetic chosen account',...changes} }
const reserve = (value,principal=null) => repository.reserveAcceptance(principal,value)
const accept = async value => repository.acceptNew(await reserve(value),{passwordHash})
const counts = async () => (await f.db.admin.query(`SELECT (SELECT count(*)::int FROM atrium.users) AS users,(SELECT count(*)::int FROM atrium.user_credentials) AS credentials,
 (SELECT count(*)::int FROM atrium.resident_account_bindings) AS bindings,(SELECT count(*)::int FROM atrium.resident_enrollment_events WHERE operation='binding.activated') AS activations,
 (SELECT count(*)::int FROM atrium.resident_enrollment_attempts WHERE completed_at IS NOT NULL) AS receipts`)).rows[0]

test('new activation atomically creates a grantless account, binding, consumed invite and secret-free receipt; exact password-verified recovery creates nothing',async()=>{
 const invitation=await issue(),value=input(invitation),before=await counts(),saved=await reserve(value)
 assert.equal(saved.passwordHash,null);assert.equal(saved.completedReceipt,null)
 const result=await repository.acceptNew(saved,{passwordHash})
 assert.deepEqual(await counts(),{users:before.users+1,credentials:before.credentials+1,bindings:1,activations:1,receipts:1})
 assert.equal((await f.db.admin.query('SELECT count(*)::int n FROM atrium.memberships WHERE user_id=$1',[result.userId])).rows[0].n,0)
 const again=await reserve(value);assert.equal(again.completedReceipt.bindingId,result.bindingId)
 assert.ok(await verifyPassword('synthetic-resident-chosen-password',again.passwordHash))
 assert.equal((await repository.acceptNew(again,{passwordHash:again.passwordHash})).replayed,true)
 assert.deepEqual(await counts(),{users:before.users+1,credentials:before.credentials+1,bindings:1,activations:1,receipts:1})
 const principal=await f.runtime.signInResident(value.username,'synthetic-resident-chosen-password','127.0.0.41')
 const own=await repository.ownBindings(principal,{limit:1})
 assert.equal(own.items[0].state,'current');assert.equal(own.items[0].propertyName,'property-a1');assert.equal(own.nextId,null)
 assert.equal((await repository.ownReceipt(principal,value.requestId)).bindingId,result.bindingId)
 const persisted=(await f.db.admin.query('SELECT row_to_json(e)::text value FROM atrium.resident_enrollment_events e')).rows.map(r=>r.value).join('')
 for(const secret of [invitation.token,value.tokenHash,value.browserHash,passwordHash])assert.ok(!persisted.includes(secret))
 assert.equal((await f.db.admin.query('SELECT state FROM (SELECT CASE WHEN consumed_at IS NOT NULL THEN $1 END state FROM atrium.resident_enrollment_invites) x',['consumed'])).rows[0].state,'consumed')
})
test('existing dual-role account needs resident MFA; credentials and memberships stay byte-identical and binding revocation stays property-local',async()=>{
 const invitation=await issue(),staff=f.actors['owner-a'].principal
 await assert.rejects(repository.ownBindings(staff,{limit:5}),{code:'enrollment_forbidden'})
 const principal=await f.runtime.signInResident('owner-a',f.password,'127.0.0.42')
 const value=input(invitation,{mode:'existing',username:principal.username,displayName:principal.displayName})
 await assert.rejects(reserve(value,principal),{code:'enrollment_unauthenticated'})
 await verifyOrganizationSession(f.runtime,principal,f.password,{purpose:'session_login'})
 const snapshot=async()=>(await f.db.admin.query("SELECT (SELECT to_jsonb(c) FROM atrium.user_credentials c WHERE user_id='owner-a') c,(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM atrium.memberships m WHERE user_id='owner-a') m")).rows[0]
 const before=await snapshot(),saved=await reserve(value,principal),result=await repository.acceptExisting(principal,saved)
 assert.deepEqual(await snapshot(),before)
 await repository.executeStaff(scope,1,proof,{action:'revoke_binding',requestId:randomUUID(),id:result.bindingId,expectedVersion:1,reason:'Recipient requested scoped revocation'})
 assert.equal((await repository.ownBindings(principal,{limit:5})).items[0].state,'revoked')
 assert.deepEqual(await snapshot(),before)
 assert.ok(await f.runtime.authorization.authorizeProperty(staff,'property-a1','configure'))
 assert.equal((await repository.ownReceipt(principal,value.requestId)).bindingId,result.bindingId)
})
test('request/browser/manifests and existing usernames cannot link or modify a global account',async()=>{
 const invitation=await issue(),value=input(invitation),saved=await reserve(value)
 for(const patch of [{browserHash:digest()},{username:username()},{displayName:'Other selected name'}])await assert.rejects(reserve({...value,...patch}),{code:'enrollment_request_conflict'})
 await assert.rejects(repository.acceptNew({...saved,browserHash:digest()},{passwordHash}),{code:'enrollment_request_conflict'})
 const old=(await f.db.admin.query("SELECT to_jsonb(u) u FROM atrium.users u WHERE username='owner-a'")).rows[0]
 await assert.rejects(accept(input(invitation,{username:'owner-a'})),{code:'enrollment_username_unavailable'})
 assert.deepEqual((await f.db.admin.query("SELECT to_jsonb(u) u FROM atrium.users u WHERE username='owner-a'")).rows[0],old)
 assert.equal((await counts()).bindings,0)
})
test('a newly published policy prevents activation while authorized staff can still revoke the stale invitation',async()=>{
 const invitation=await issue(),value=input(invitation),saved=await reserve(value)
 await f.publish(f.residents['property-a1'][0])
 assert.equal((await repository.staffState(scope,1,f.residents['property-a1'][0])).invitation.state,'stale')
 await assert.rejects(repository.acceptNew(saved,{passwordHash}),{code:'enrollment_invitation_unavailable'})
 assert.equal((await f.db.admin.query('SELECT 1 FROM atrium.users WHERE id=$1',[saved.userId])).rowCount,0)
 await repository.executeStaff(scope,1,proof,{action:'revoke_invitation',requestId:randomUUID(),id:invitation.receipt.id,expectedVersion:1,reason:'Replace stale recipient enrollment'})
 assert.equal((await repository.staffState(scope,1,f.residents['property-a1'][0])).invitation.state,'revoked')
})
test('resident source revision invalidates existing binding dynamically without changing its historic version',async()=>{
 const invitation=await issue(),value=input(invitation),result=await accept(value)
 const services=new PostgresResidentServicesRepository(f.db.app,scope,{configurationVersion:1}),r=await services.getResident(f.residents['property-a1'][0])
 await services.execute({action:'review_resident',requestId:randomUUID(),id:r.id,expectedVersion:r.version,details:{displayName:r.displayName,relationship:r.relationship,startsOn:r.startsOn,endsOn:r.endsOn,phone:r.phone,email:r.email,
 source:{kind:'staff_review',reference:'New synthetic occupancy review',version:'review-2',observedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()}},reason:'Replace reviewed occupancy evidence'})
 const principal=await f.runtime.signInResident(value.username,'synthetic-resident-chosen-password','127.0.0.43')
 const b=(await repository.ownBindings(principal,{limit:5})).items[0]
 assert.equal(b.state,'context_changed');assert.equal(b.version,1);assert.equal(b.id,result.bindingId)
})
test('staff state and receipts remain scoped, missing policy is disabled, and raw command privileges are finite',async()=>{
 await f.db.admin.query(`TRUNCATE ${tables.map(t=>`atrium.${t}`).join(',')}`)
 assert.equal((await repository.staffState(scope,1,f.residents['property-a1'][0])).policy,null)
 await assert.rejects(repository.staffState(scope,1,f.residents['property-b1'][0]),{code:'enrollment_changed'})
 for(const connection of [f.db.app,f.db.auth])for(const table of ['resident_account_bindings','resident_enrollment_attempts','resident_enrollment_budgets']) {
  await assert.rejects(connection.transaction({},c=>c.query(`SELECT * FROM atrium.${table}`)),{code:'42501'})
  await assert.rejects(connection.transaction({},c=>c.query('SET ROLE atrium_enrollment_executor')),{code:'42501'})
 }
 await assert.rejects(f.db.app.transaction({},c=>c.query("SELECT atrium.enrollment_resident('preview',$1)",[{tokenHash:digest()}])),{code:'42501'})
 await assert.rejects(f.db.auth.transaction({},c=>c.query("SELECT atrium.enrollment_staff('state',$1,1,NULL)",[{residentId:f.residents['property-a1'][0]}])),{code:'42501'})
 for(const bad of [null,[],{tokenHash:23},{tokenHash:digest(),extra:true}])await assert.rejects(f.db.auth.transaction({},c=>c.query("SELECT atrium.enrollment_resident('preview',$1)",[bad])),{message:'enrollment_invalid_input'})
})
test('the recipient check cannot predate 24 hours or be future-dated, and invitation expiry is capped by check and source deadlines',async()=>{
 const r=f.residents['property-a1'][1],state=await repository.staffState(scope,1,r)
 const command={action:'issue_invitation',requestId:randomUUID(),residentId:r,expectedResidentVersion:state.resident.version,expectedPolicyVersion:state.policy.version,replaces:null,checkedAt:new Date(Date.now()-23.5*3600000).toISOString(),evidenceReference:'Synthetic completed in-person evidence',protocolCompleted:true,reason:'Recipient access request'}
 for(const checkedAt of [new Date(Date.now()-25*3600000).toISOString(),new Date(Date.now()+60000).toISOString()])await assert.rejects(repository.executeStaff(scope,1,proof,{...command,requestId:randomUUID(),checkedAt},{id:randomUUID(),tokenHash:digest()}),{code:'enrollment_changed'})
 await repository.executeStaff(scope,1,proof,command,{id:randomUUID(),tokenHash:digest()})
 const invitation=(await repository.staffState(scope,1,r)).invitation
 assert.ok(Date.parse(invitation.expiresAt)<=Date.parse(command.checkedAt)+86400000)
 assert.ok(Date.parse(invitation.expiresAt)<Date.now()+31*60000)
})
test('ten shared token reservations charge exact repeats; blocked attempts do not extend the token budget',async()=>{
 const invitation=await issue(),value=input(invitation)
 for(let i=0;i<10;i++)await reserve({...value,clientKey:digest()})
 const before=(await f.db.admin.query("SELECT attempts,last_reserved_at FROM atrium.resident_enrollment_budgets WHERE kind='token' AND key=$1",[value.tokenHash])).rows[0]
 await assert.rejects(reserve({...value,clientKey:digest()}),{code:'enrollment_rate_limited'})
 assert.deepEqual((await f.db.admin.query("SELECT attempts,last_reserved_at FROM atrium.resident_enrollment_budgets WHERE kind='token' AND key=$1",[value.tokenHash])).rows[0],before)
 assert.equal((await f.db.admin.query('SELECT count(*)::int n FROM atrium.resident_enrollment_attempts')).rows[0].n,1)
})
test('thirty unknown-token requests exhaust one client without username lookup or unbounded blocked token allocations; denied branch cleans stale buckets',async()=>{
 const clientKey=digest()
 for(let i=0;i<30;i++)await assert.rejects(reserve(input({token:randomBytes(32).toString('base64url')},{clientKey})),{code:'enrollment_invitation_unavailable'})
 await f.db.admin.query("INSERT INTO atrium.resident_enrollment_budgets(kind,key,last_reserved_at) VALUES('client',$1,clock_timestamp()-interval '16 minutes')",[digest()])
 const before=(await f.db.admin.query("SELECT count(*)::int n FROM atrium.resident_enrollment_budgets WHERE kind='token'")).rows[0].n
 await assert.rejects(reserve(input({token:randomBytes(32).toString('base64url')},{clientKey})),{code:'enrollment_rate_limited'})
 assert.equal((await f.db.admin.query("SELECT count(*)::int n FROM atrium.resident_enrollment_budgets WHERE kind='token'")).rows[0].n,before)
 assert.equal((await f.db.admin.query("SELECT count(*)::int n FROM atrium.resident_enrollment_budgets WHERE last_reserved_at<clock_timestamp()-interval '15 minutes'")).rows[0].n,0)
})
test('activation audit failure rolls back account, credential, binding, consumption and receipt together',async()=>{
 const saved=await reserve(input(await issue())),before=await counts()
 await f.db.admin.query('REVOKE INSERT ON atrium.resident_enrollment_events FROM atrium_enrollment_executor')
 try {await assert.rejects(repository.acceptNew(saved,{passwordHash}),{code:'enrollment_unavailable'})} finally {await f.db.admin.query('GRANT INSERT ON atrium.resident_enrollment_events TO atrium_enrollment_executor')}
 assert.deepEqual(await counts(),before)
 assert.equal((await f.db.admin.query('SELECT consumed_at FROM atrium.resident_enrollment_invites WHERE id=$1',[saved.invitationId])).rows[0].consumed_at,null)
 assert.equal((await repository.acceptNew(saved,{passwordHash})).replayed,false)
})
