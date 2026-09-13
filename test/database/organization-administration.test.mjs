import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresOrganizationAdministrationRepository } from '../../src/database/organization-administration.ts'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { TEST_AUTH_ORIGIN } from '../helpers/mfa-session.mjs'

let db, runtime, repository, password
const principals=new Map(), proofs=new Map()
before(async()=>{
  db=await createFoundationTestDatabase()
  ;({password}=await seedFoundationTestDatabase(db.admin))
  for(const [id,role,access] of [['admin-a','admin','properties'],['limited-owner','owner','properties']]) {
    await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')",[id])
    await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) SELECT $1,password_hash FROM atrium.user_credentials WHERE user_id=\'owner-a\'',[id])
    await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,status,access) VALUES($1,$2,'organization-a',$3,'active',$4)",[`member-${id}`,id,role,access])
    await db.admin.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES($1,'organization-a','property-a1','active')",[`member-${id}`])
  }
  runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-organization-administration-test-secret',authOrigin:TEST_AUTH_ORIGIN})
  repository=new PostgresOrganizationAdministrationRepository(db.app)
  for(const id of ['owner-a','owner-b','admin-a','limited-owner']) {
    const user=await runtime.authorization.authenticatePassword(id,password)
    const principal=await runtime.sessions.start(user,{label:'Synthetic organization test'})
    await verifyOrganizationSession(runtime,principal,password)
    principals.set(id,principal)
    proofs.set(id,(await runtime.mfa.administrationAuthentication(principal).verifyCurrentSession(principal)).verificationId)
  }
})
beforeEach(async()=>{
  await db.admin.query('TRUNCATE atrium.organization_events,atrium.organization_commands')
  await db.admin.query("UPDATE atrium.memberships SET status='active',access=CASE WHEN user_id IN ('owner-a','owner-b','viewer-a') THEN 'organization' ELSE 'properties' END,role=CASE user_id WHEN 'owner-a' THEN 'owner' WHEN 'owner-b' THEN 'owner' WHEN 'admin-a' THEN 'admin' WHEN 'limited-owner' THEN 'owner' WHEN 'viewer-a' THEN 'viewer' ELSE 'staff' END,permission_version=1")
  await db.admin.query("UPDATE atrium.property_grants SET status=CASE WHEN property_id='property-a1' THEN 'active' ELSE 'revoked' END,permission_version=1")
  await db.admin.query("UPDATE atrium.properties SET status='active',published_configuration_version=NULL")
})
after(async()=>{await db?.close()})
const owner=()=>principals.get('owner-a'), proof=()=>proofs.get('owner-a')
const input=(overrides={})=>({organizationId:'organization-a',membershipId:'member-staff-a',expectedVersion:1,requestId:'synthetic-change',role:'staff',status:'active',access:'properties',propertyIds:['property-a2'],...overrides})
const directory=(id='owner-a',options={limit:100})=>repository.directory(principals.get(id),'organization-a',proofs.get(id),options)
const counts=async()=>({commands:Number((await db.admin.query('SELECT count(*) FROM atrium.organization_commands')).rows[0].count),events:Number((await db.admin.query('SELECT count(*) FROM atrium.organization_events')).rows[0].count)})

test('real managed proof lists only own organizations and directory needs no published property configuration',async()=>{
  assert.deepEqual(await repository.listOrganizations(owner(),proof()),[{id:'organization-a',name:'organization-a'}])
  const result=await directory()
  assert.equal(result.organization.id,'organization-a')
  assert.equal(result.actor.userId,'owner-a')
  assert.equal(result.members.length,5)
  assert.ok(result.members.every(member=>member.userId!=='owner-b'))
  assert.deepEqual(result.properties.map(property=>property.id),['property-a1','property-a2'])
  assert.equal(result.nextCursor,null)
  await assert.rejects(repository.directory(owner(),'organization-b',proof(),{limit:20}),{code:'forbidden'})
})

test('directory keyset pagination is bounded and property-limited administrators see only fully delegated targets',async()=>{
  const all=await directory(), pages=[]
  let beforeMembershipId
  do {
    const page=await directory('owner-a',{limit:2,...(beforeMembershipId?{beforeMembershipId}:{})})
    pages.push(...page.members);beforeMembershipId=page.nextCursor
  } while(beforeMembershipId)
  assert.deepEqual(pages.map(row=>row.membershipId),all.members.map(row=>row.membershipId))
  const limited=await directory('admin-a')
  assert.deepEqual(limited.properties.map(row=>row.id),['property-a1'])
  assert.deepEqual(limited.members.map(row=>row.userId),['admin-a','staff-a'])
  assert.equal(limited.members.find(row=>row.userId==='admin-a').canManage,false)
  await assert.rejects(directory('owner-a',{limit:101}),{code:'invalid_input'})
  await db.admin.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-staff-a','organization-a','property-a2','active')")
  assert.deepEqual((await directory('admin-a')).members.map(row=>row.userId),['admin-a'])
  await assert.rejects(repository.replaceMember(principals.get('admin-a'),input({propertyIds:['property-a1']}),proofs.get('admin-a')),{code:'forbidden'})
})

test('inactive retained grants remain visible as metadata without expanding delegated authority',async()=>{
  await db.admin.query("UPDATE atrium.properties SET status='inactive' WHERE id='property-a1'")
  const result=await directory('limited-owner')
  assert.deepEqual(result.actor.propertyIds,[])
  assert.deepEqual(result.properties.map(row=>[row.id,row.status]),[['property-a1','inactive']])
  assert.deepEqual(result.members.map(row=>row.userId),['limited-owner'])
  assert.deepEqual(result.members[0].propertyIds,['property-a1'])
  assert.equal(result.members[0].canManage,false)
  await assert.rejects(repository.replaceMember(principals.get('limited-owner'),input({propertyIds:['property-a1']}),proofs.get('limited-owner')),{code:'forbidden'})
})

test('full access replacement advances aggregate version once and atomically records grants receipt audit and no global identity changes',async()=>{
  // One stable person belongs to both organizations, with independent membership.
  await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,status,access) VALUES('shared-staff-b','staff-a','organization-b','viewer','active','organization') ON CONFLICT(id) DO NOTHING")
  const identityBefore=(await db.admin.query("SELECT md5(to_jsonb(u)::text||to_jsonb(c)::text) digest FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id WHERE u.id='staff-a'")).rows[0].digest
  const result=await repository.replaceMember(owner(),input(),proof())
  assert.equal(result.version,2);assert.equal(result.duplicate,false)
  assert.deepEqual(result.propertyIds,['property-a2'])
  const grants=(await db.admin.query("SELECT property_id,status FROM atrium.property_grants WHERE membership_id='member-staff-a' ORDER BY property_id")).rows
  assert.deepEqual(grants,[{property_id:'property-a1',status:'revoked'},{property_id:'property-a2',status:'active'}])
  assert.deepEqual(await counts(),{commands:1,events:1})
  const xids=(await db.admin.query("SELECT xmin::text xid FROM atrium.memberships WHERE id='member-staff-a' UNION SELECT xmin::text FROM atrium.property_grants WHERE membership_id='member-staff-a' UNION SELECT xmin::text FROM atrium.organization_commands UNION SELECT xmin::text FROM atrium.organization_events")).rows
  assert.equal(xids.length,1)
  const other=(await db.admin.query("SELECT role,status,access,permission_version FROM atrium.memberships WHERE id='shared-staff-b'")).rows[0]
  assert.deepEqual(other,{role:'viewer',status:'active',access:'organization',permission_version:'1'})
  assert.equal((await db.admin.query("SELECT md5(to_jsonb(u)::text||to_jsonb(c)::text) digest FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id WHERE u.id='staff-a'")).rows[0].digest,identityBefore)
  const duplicate=await repository.replaceMember(owner(),input(),proof())
  assert.deepEqual(duplicate,{...result,duplicate:true});assert.deepEqual(await counts(),{commands:1,events:1})
  await assert.rejects(repository.replaceMember(owner(),input({role:'viewer'}),proof()),{code:'version_conflict'})
})

test('current delegation, target version, inactive properties and last active owner all fail without partial effects',async()=>{
  await assert.rejects(repository.replaceMember(principals.get('admin-a'),input({role:'admin',propertyIds:['property-a1']}),proofs.get('admin-a')),{code:'forbidden'})
  await assert.rejects(repository.replaceMember(principals.get('limited-owner'),input({access:'organization',propertyIds:[]}),proofs.get('limited-owner')),{code:'forbidden'})
  await assert.rejects(repository.replaceMember(owner(),input({expectedVersion:2}),proof()),{code:'version_conflict'})
  await db.admin.query("UPDATE atrium.properties SET status='inactive' WHERE id='property-a2'")
  await assert.rejects(repository.replaceMember(owner(),input(),proof()),{code:'forbidden'})
  await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-limited-owner'")
  await assert.rejects(repository.replaceMember(owner(),input({membershipId:'member-owner-a',role:'viewer',access:'organization',propertyIds:[]}),proof()),{code:'last_owner'})
  assert.deepEqual(await counts(),{commands:0,events:0})
})

test('intentional owner self-demotion permits only exact own receipt recovery, including a fresh verified session',async()=>{
  const command=input({membershipId:'member-owner-a',role:'viewer',access:'organization',propertyIds:[]})
  const result=await repository.replaceMember(owner(),command,proof())
  assert.equal(result.actorAccessChanged,true)
  await assert.rejects(directory(),{code:'forbidden'})
  assert.equal((await repository.replaceMember(owner(),command,proof())).duplicate,true)
  const fresh=await runtime.sessions.start(await runtime.authorization.authenticatePassword('owner-a',password),{label:'Synthetic fresh receipt session'})
  await verifyOrganizationSession(runtime,fresh,password)
  const currentProof=(await runtime.mfa.administrationAuthentication(fresh).verifyCurrentSession(fresh)).verificationId
  assert.equal((await repository.replaceMember(fresh,command,currentProof)).duplicate,true)
  await assert.rejects(repository.replaceMember(fresh,{...command,requestId:'different-request'},currentProof),{code:'forbidden'})
  await runtime.sessions.revoke(fresh,fresh.sessionId)
  await assert.rejects(repository.replaceMember(fresh,command,currentProof))
  assert.deepEqual(await counts(),{commands:1,events:1})
})

test('native audit denial rolls back access and command receipt; version overflow is refused',async()=>{
  await db.admin.query('REVOKE INSERT ON atrium.organization_events FROM atrium_organization_executor')
  try { await assert.rejects(repository.replaceMember(owner(),input(),proof()),{code:'administration_unavailable'}) }
  finally { await db.admin.query('GRANT INSERT ON atrium.organization_events TO atrium_organization_executor') }
  assert.deepEqual(await counts(),{commands:0,events:0})
  assert.equal((await directory()).members.find(row=>row.userId==='staff-a').version,1)
  await db.admin.query("UPDATE atrium.memberships SET permission_version=9007199254740991 WHERE id='member-staff-a'")
  await assert.rejects(repository.replaceMember(owner(),input({expectedVersion:Number.MAX_SAFE_INTEGER}),proof()),{code:'invalid_record'})
  assert.deepEqual(await counts(),{commands:0,events:0})
})

test('raw runtime roles cannot read or mutate administrative storage, assume executor, or bypass required current proof',async()=>{
  const context={actorUserId:owner().userId,credentialVersion:owner().credentialVersion,actorSessionId:owner().sessionId,organizationId:'organization-a'}
  for(const query of ["UPDATE atrium.memberships SET role='owner' WHERE id='member-staff-a'",'SELECT * FROM atrium.organization_commands','SELECT * FROM atrium.organization_events','SET ROLE atrium_organization_executor','SELECT atrium.organization_actor()']) {
    await assert.rejects(db.app.transaction(context,client=>client.query(query)),{code:'42501'})
  }
  await assert.rejects(db.auth.transaction(context,client=>client.query('SELECT atrium.organization_directory($1,$2::uuid,10,NULL)',['organization-a',proof()])),{code:'42501'})
  await assert.rejects(repository.directory(owner(),'organization-a',proofs.get('owner-b'),{limit:20}),{code:'mfa_required'})
  await assert.rejects(db.app.transaction({...context,channelBindingId:'channel-a'},client=>client.query('SELECT atrium.organization_directory($1,$2::uuid,10,NULL)',['organization-a',proof()])),{code:'P0001'})
  for(const malformed of [null,[],{...input(),role:null},{...input(),membershipId:123},{...input(),propertyIds:null},{...input(),propertyIds:[123]}]) {
    await assert.rejects(db.app.transaction(context,client=>client.query('SELECT atrium.replace_organization_member($1::jsonb,$2::uuid)',[JSON.stringify(malformed),proof()])),{code:'P0001',message:'invalid_input'})
  }
  const pending=await runtime.sessions.start(await runtime.authorization.authenticatePassword('owner-a',password),{label:'Synthetic unverified session'})
  await assert.rejects(repository.directory(pending,'organization-a',proof(),{limit:20}),{code:'mfa_required'})
})
