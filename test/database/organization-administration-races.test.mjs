import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresOrganizationAdministrationRepository } from '../../src/database/organization-administration.ts'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { TEST_AUTH_ORIGIN } from '../helpers/mfa-session.mjs'

let db,runtime,repository,otherConnection,otherRepository,password
const principals=new Map(),proofs=new Map()
before(async()=>{
  db=await createFoundationTestDatabase();({password}=await seedFoundationTestDatabase(db.admin))
  await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,status,access) VALUES('second-owner-a','owner-b','organization-a','owner','active','organization')")
  runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-organization-race-test-secret',authOrigin:TEST_AUTH_ORIGIN})
  repository=new PostgresOrganizationAdministrationRepository(db.app)
  otherConnection=db.createAppConnection();otherRepository=new PostgresOrganizationAdministrationRepository(otherConnection)
  for(const id of ['owner-a','owner-b']) {
    const principal=await runtime.sessions.start(await runtime.authorization.authenticatePassword(id,password),{label:'Synthetic owner race'})
    principals.set(id,principal)
  }
})
beforeEach(async()=>{
  await db.admin.query('TRUNCATE atrium.organization_events,atrium.organization_commands')
  await db.admin.query("UPDATE atrium.memberships SET status='active',permission_version=1,role=CASE WHEN user_id IN ('owner-a','owner-b') THEN 'owner' WHEN user_id='viewer-a' THEN 'viewer' ELSE 'staff' END,access=CASE WHEN user_id='staff-a' THEN 'properties' ELSE 'organization' END")
  await db.admin.query("UPDATE atrium.property_grants SET status='active',permission_version=1")
  for(const [id,principal] of principals) {
    await verifyOrganizationSession(runtime,principal,password)
    proofs.set(id,(await runtime.mfa.administrationAuthentication(principal).verifyCurrentSession(principal)).verificationId)
  }
})
after(async()=>{await otherConnection?.close();await db?.close()})
const actor=()=>principals.get('owner-a'), proof=()=>proofs.get('owner-a')
const command=(overrides={})=>({organizationId:'organization-a',membershipId:'member-staff-a',expectedVersion:1,requestId:'race-request',role:'viewer',status:'active',access:'properties',propertyIds:['property-a1'],...overrides})
const counts=async()=>({commands:Number((await db.admin.query('SELECT count(*) FROM atrium.organization_commands')).rows[0].count),events:Number((await db.admin.query('SELECT count(*) FROM atrium.organization_events')).rows[0].count)})
async function blocked(queryPart) {
  for(let attempt=0;attempt<100;attempt++) {
    await db.admin.query('SELECT pg_stat_clear_snapshot()')
    const waiting=await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",[`%${queryPart}%`])
    if(waiting.rowCount)return
    await delay(10)
  }
  assert.fail('Synthetic command did not reach the expected database lock')
}
async function holdOrganization() {
  await db.admin.query('BEGIN')
  await db.admin.query("SELECT 1 FROM atrium.organizations WHERE id='organization-a' FOR UPDATE")
}

test('two owners cannot both demote themselves and remove the last active owner',async()=>{
  const results=await Promise.allSettled([
    repository.replaceMember(actor(),command({membershipId:'member-owner-a',access:'organization',propertyIds:[],requestId:'self-a'}),proof()),
    otherRepository.replaceMember(principals.get('owner-b'),command({membershipId:'second-owner-a',access:'organization',propertyIds:[],requestId:'self-b'}),proofs.get('owner-b')),
  ])
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
  assert.equal(results.find(row=>row.status==='rejected').reason.code,'last_owner')
  assert.equal(Number((await db.admin.query("SELECT count(*) FROM atrium.memberships m JOIN atrium.users u ON u.id=m.user_id WHERE organization_id='organization-a' AND m.role='owner' AND m.status='active' AND u.status='active'")).rows[0].count),1)
  assert.deepEqual(await counts(),{commands:1,events:1})
})

test('opposite-direction owner edits acquire sorted users without deadlock and revoke the losing actor authority',async()=>{
  const results=await Promise.allSettled([
    repository.replaceMember(actor(),command({membershipId:'second-owner-a',access:'organization',propertyIds:[],requestId:'cross-a'}),proof()),
    otherRepository.replaceMember(principals.get('owner-b'),command({membershipId:'member-owner-a',access:'organization',propertyIds:[],requestId:'cross-b'}),proofs.get('owner-b')),
  ])
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
  assert.equal(results.find(row=>row.status==='rejected').reason.code,'forbidden')
  assert.deepEqual(await counts(),{commands:1,events:1})
})

for(const change of ['actor','grant','target'])test(`${change} changes committed during the organization lock wait are rechecked before mutation`,async()=>{
  if(change==='grant') {
    await db.admin.query("UPDATE atrium.memberships SET access='properties' WHERE id='member-owner-a'")
    await db.admin.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-owner-a','organization-a','property-a1','active') ON CONFLICT(membership_id,property_id) DO UPDATE SET status='active'")
  }
  await holdOrganization()
  const pending=repository.replaceMember(actor(),command(),proof())
  const rejected=assert.rejects(pending,{code:change==='target'?'version_conflict':'forbidden'})
  try {
    await blocked('replace_organization_member')
    if(change==='actor')await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
    if(change==='grant')await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-owner-a'")
    if(change==='target')await db.admin.query("UPDATE atrium.memberships SET permission_version=2 WHERE id='member-staff-a'")
    await db.admin.query('COMMIT')
    await rejected
  } finally {await db.admin.query('ROLLBACK')}
  assert.deepEqual(await counts(),{commands:0,events:0})
})

for(const operation of ['replace','duplicate','directory','catalogue'])test(`${operation} refuses proof expiry after admission and before returning a privileged result`,async()=>{
  if(operation==='duplicate')await repository.replaceMember(actor(),command(),proof())
  const before=await counts()
  // Disposable DB-time fixture: copy a genuinely verified binding into a new,
  // short-lived assurance. The original signed ceremony evidence stays immutable.
  const expiringProof=randomUUID()
  await db.admin.query(`INSERT INTO atrium.mfa_assurances
    (id,user_id,session_id,credential_version,security_version,factor_id,purpose,verified_at_ms,expires_at_ms)
    SELECT $1,user_id,session_id,credential_version,security_version,factor_id,purpose,
      floor(extract(epoch FROM clock_timestamp())*1000)-1000,
      floor(extract(epoch FROM clock_timestamp())*1000)+800
    FROM atrium.mfa_assurances WHERE id=$2`,[expiringProof,proof()])
  if(operation==='catalogue') {
    await db.admin.query('BEGIN');await db.admin.query('LOCK TABLE atrium.organizations IN ACCESS EXCLUSIVE MODE')
  } else await holdOrganization()
  const pending=operation==='directory'?repository.directory(actor(),'organization-a',expiringProof,{limit:10})
    :operation==='catalogue'?repository.listOrganizations(actor(),expiringProof):repository.replaceMember(actor(),command(),expiringProof)
  const rejected=assert.rejects(pending,{code:'mfa_required'})
  try {
    await blocked(operation==='directory'?'organization_directory':operation==='catalogue'?'list_administrable_organizations':'replace_organization_member')
    await delay(900)
    await db.admin.query('COMMIT')
    await rejected
  } finally {await db.admin.query('ROLLBACK')}
  assert.deepEqual(await counts(),before)
})

test('session revocation waits for admitted member change, and later requests are refused',async()=>{
  const fresh=await runtime.sessions.start(await runtime.authorization.authenticatePassword('owner-a',password),{label:'Synthetic revoked owner session'})
  await verifyOrganizationSession(runtime,fresh,password)
  const freshProof=(await runtime.mfa.administrationAuthentication(fresh).verifyCurrentSession(fresh)).verificationId
  await holdOrganization()
  const pending=repository.replaceMember(fresh,command(),freshProof)
  let revoked=false
  let revocation
  try {
    await blocked('replace_organization_member')
    revocation=runtime.sessions.revoke(actor(),fresh.sessionId).then(result=>{revoked=true;return result})
    await blocked('revoke_user_sessions')
    assert.equal(revoked,false)
    await db.admin.query('COMMIT')
    assert.equal((await pending).version,2)
    await revocation
  } finally {await db.admin.query('ROLLBACK')}
  await assert.rejects(repository.directory(fresh,'organization-a',freshProof,{limit:10}),{code:'mfa_required'})
  assert.deepEqual(await counts(),{commands:1,events:1})
})
