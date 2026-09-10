import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService, mintUserSession, hashPassword } from '../../src/auth/index.ts'
import { createPasswordChangeService } from '../../src/auth/password-change.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresPasswordChangeRepository } from '../../src/database/password-change.ts'

let db, authorization, repository, service, initialHash
const initialPassword = 'synthetic initial password for account tests'
const nextPassword = 'synthetic replacement password for account tests'
const now = new Date('2032-06-01T12:00:00Z')
before(async () => {
  db = await createFoundationTestDatabase()
  await seedFoundationTestDatabase(db.admin)
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  repository = new PostgresPasswordChangeRepository(db.auth)
  service = createPasswordChangeService(repository)
  initialHash = await hashPassword(initialPassword)
})
after(async () => { if (db) await db.close() })
async function user(prefix = 'password') {
  const id = `${prefix}-${randomBytes(6).toString('hex')}`
  await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,'Synthetic staff','active')", [id])
  await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [id, initialHash])
  const principal = await authorization.authenticatePassword(id, initialPassword)
  assert.ok(principal)
  return principal
}
const context = principal => ({ actorUserId: principal.userId, credentialVersion: principal.credentialVersion })
const credential = async principal => (await db.admin.query('SELECT u.credential_version,c.password_hash FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id WHERE u.id=$1', [principal.userId])).rows[0]
const events = async principal => (await db.admin.query('SELECT * FROM atrium.account_security_events WHERE user_id=$1', [principal.userId])).rows
const attempts = async principal => (await db.admin.query('SELECT * FROM atrium.password_change_attempts WHERE user_id=$1 ORDER BY reserved_at,id', [principal.userId])).rows

test('generated account-security migration matches reviewed source and has a restricted executor', async () => {
  assert.equal(await readFile(new URL('../../db/account-security.sql', import.meta.url), 'utf8'),
    await readFile(new URL('../../supabase/migrations/20260909231814_account_security.sql', import.meta.url), 'utf8'))
  const role = (await db.admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname='atrium_account_executor'")).rows[0]
  assert.ok(Object.values(role).every(value => value === false))
  assert.equal((await db.admin.query("SELECT has_schema_privilege('atrium_account_executor','atrium','CREATE') AS allowed")).rows[0].allowed, false)
  for (const runtime of ['atrium_app', 'atrium_authenticator']) {
    assert.equal((await db.admin.query("SELECT pg_has_role($1,'atrium_account_executor','MEMBER') AS member", [runtime])).rows[0].member, false)
  }
  const tables = (await db.admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('atrium.password_change_attempts'::regclass,'atrium.account_security_events'::regclass)")).rows
  assert.equal(tables.length, 2); assert.ok(tables.every(row => row.relrowsecurity && row.relforcerowsecurity))
})

test('personal change needs no property membership, rotates once and atomically saves a secret-free self audit', async () => {
  const principal = await user()
  const token = mintUserSession(principal, now, 'synthetic session secret for password tests')
  await service.changeOwnPassword(principal, { currentPassword: initialPassword, newPassword: nextPassword })
  const saved = await credential(principal), audit = await events(principal)
  assert.equal(saved.credential_version, '2'); assert.notEqual(saved.password_hash, initialHash)
  assert.equal(await authorization.authenticatePassword(principal.username, initialPassword), null)
  assert.ok(await authorization.authenticatePassword(principal.username, nextPassword))
  assert.equal(await authorization.authenticateSession(token, now, 'synthetic session secret for password tests'), null)
  assert.equal(audit.length, 1); assert.equal(audit[0].operation, 'password.changed')
  assert.deepEqual(Object.keys(audit[0]).sort(), ['id','user_id','operation','prior_credential_version','credential_version','created_at'].sort())
  assert.equal(audit[0].prior_credential_version, '1'); assert.equal(audit[0].credential_version, '2')
  assert.doesNotMatch(JSON.stringify(audit), /scrypt\$|synthetic initial password|synthetic replacement password/)
  const versions = (await db.admin.query('SELECT (SELECT xmin::text FROM atrium.user_credentials WHERE user_id=$1) AS credential,(SELECT xmin::text FROM atrium.users WHERE id=$1) AS identity,(SELECT xmin::text FROM atrium.account_security_events WHERE user_id=$1) AS audit', [principal.userId])).rows[0]
  assert.equal(new Set(Object.values(versions)).size, 1)
})

test('incorrect and unchanged passwords preserve credentials while consuming durable reservations', async () => {
  const principal = await user()
  await assert.rejects(service.changeOwnPassword(principal, { currentPassword: 'wrong synthetic password', newPassword: nextPassword }), { code: 'incorrect_password' })
  await assert.rejects(service.changeOwnPassword(principal, { currentPassword: initialPassword, newPassword: initialPassword }), { code: 'password_unchanged' })
  assert.equal((await attempts(principal)).length, 2)
  assert.deepEqual(await credential(principal), { credential_version: '1', password_hash: initialHash })
  assert.deepEqual(await events(principal), [])
})

test('independent service instances share a rolling ten-attempt DB-clock limit before scrypt', async () => {
  const principal = await user(), otherRepository = new PostgresPasswordChangeRepository(db.auth)
  const result = await Promise.allSettled(Array.from({ length: 14 }, (_, index) => (index % 2 ? repository : otherRepository).reserve(principal, randomUUID())))
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 10)
  const denied = result.filter(row => row.status === 'rejected')
  assert.equal(denied.length, 4)
  assert.ok(denied.every(row => row.reason.code === 'rate_limited' && row.reason.retryAfterSeconds >= 1 && row.reason.retryAfterSeconds <= 900))
  assert.equal((await attempts(principal)).length, 10)
  let hashes = 0
  const limited = createPasswordChangeService(otherRepository, { async verify() { hashes++; return false }, async hash() { hashes++; return initialHash } })
  await assert.rejects(limited.changeOwnPassword(principal, { currentPassword: initialPassword, newPassword: nextPassword }), { code: 'rate_limited' })
  assert.equal(hashes, 0)
  await db.admin.query("UPDATE atrium.password_change_attempts SET reserved_at=clock_timestamp()-interval '16 minutes' WHERE user_id=$1", [principal.userId])
  await repository.reserve(principal, randomUUID())
  assert.equal((await attempts(principal)).length, 1, 'only expired rate reservations are pruned')
})

test('concurrent verified changes commit one credential and audit; the loser cannot restore a stale hash', async () => {
  const principal = await user()
  const [a,b] = await Promise.all([repository.reserve(principal,randomUUID()),repository.reserve(principal,randomUUID())])
  const replacement = await hashPassword(nextPassword)
  const result = await Promise.allSettled([repository.commit(principal,a,replacement),repository.commit(principal,b,replacement)])
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1,
    result.filter(row => row.status === 'rejected').map(row => `${row.reason.code}: ${row.reason.message}`).join('; '))
  assert.equal(result.find(row => row.status === 'rejected').reason.code, 'unauthenticated')
  assert.equal((await credential(principal)).credential_version, '2'); assert.equal((await events(principal)).length, 1)
  await assert.rejects(repository.commit(principal,a,replacement), { code: 'unauthenticated' })
})

test('rotation or deactivation after verification and expired reservations stop the stale write', async () => {
  const replacement = await hashPassword(nextPassword)
  for (const mode of ['rotation','inactive','expired']) {
    const principal = await user(), reservation = await repository.reserve(principal,randomUUID())
    if (mode === 'rotation') await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2', [replacement,principal.userId])
    if (mode === 'inactive') await db.admin.query("UPDATE atrium.users SET status='inactive' WHERE id=$1", [principal.userId])
    if (mode === 'expired') await db.admin.query("UPDATE atrium.password_change_attempts SET reserved_at=clock_timestamp()-interval '16 minutes' WHERE id=$1", [reservation.attemptId])
    await assert.rejects(repository.commit(principal,reservation,replacement), { code: 'unauthenticated' })
    assert.deepEqual(await events(principal), [])
    assert.equal((await credential(principal)).password_hash, mode === 'rotation' ? replacement : initialHash)
  }
})

test('failed audit and version overflow roll back credential/consumption changes while keeping the earlier reservation', async () => {
  const principal = await user(), reservation = await repository.reserve(principal,randomUUID()), replacement = await hashPassword(nextPassword)
  await db.admin.query("CREATE FUNCTION atrium.synthetic_reject_password_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit outage'; END $$")
  await db.admin.query('CREATE TRIGGER synthetic_audit_outage BEFORE INSERT ON atrium.account_security_events FOR EACH ROW EXECUTE FUNCTION atrium.synthetic_reject_password_audit()')
  try { await assert.rejects(repository.commit(principal,reservation,replacement), /synthetic audit outage/) }
  finally { await db.admin.query('DROP TRIGGER synthetic_audit_outage ON atrium.account_security_events'); await db.admin.query('DROP FUNCTION atrium.synthetic_reject_password_audit()') }
  assert.deepEqual(await credential(principal), { credential_version: '1', password_hash: initialHash })
  assert.equal((await attempts(principal))[0].consumed_at, null); assert.deepEqual(await events(principal), [])
  await db.admin.query('UPDATE atrium.users SET credential_version=9007199254740991 WHERE id=$1', [principal.userId])
  const maximum = await authorization.authenticatePassword(principal.username, initialPassword), last = await repository.reserve(maximum,randomUUID())
  await assert.rejects(repository.commit(maximum,last,replacement))
  assert.equal((await credential(principal)).credential_version, '9007199254740991'); assert.deepEqual(await events(principal), [])
})

test('shared identity changes affect all its sessions without changing either organization membership or another user', async () => {
  const principal = await user(), other = await user()
  for (const org of ['organization-a','organization-b']) await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES($1,$2,$3,'viewer','organization','active')", [`member-${principal.userId}-${org}`,principal.userId,org])
  const old = await credential(other), memberships = (await db.admin.query('SELECT to_jsonb(m) AS value FROM atrium.memberships m WHERE user_id=$1 ORDER BY id',[principal.userId])).rows
  await service.changeOwnPassword(principal,{currentPassword:initialPassword,newPassword:nextPassword})
  assert.deepEqual((await db.admin.query('SELECT to_jsonb(m) AS value FROM atrium.memberships m WHERE user_id=$1 ORDER BY id',[principal.userId])).rows,memberships)
  assert.deepEqual(await credential(other),old)
  assert.deepEqual((await authorization.listAuthorizedProperties(await authorization.authenticatePassword(principal.username,nextPassword))).map(row=>row.organizationId),['organization-a','organization-a','organization-b','organization-b'])
})

test('runtime roles cannot write raw credentials, forge audit, use another user reservation or invoke with empty/channel context', async () => {
  const principal = await user(), other = await user(), reservation = await repository.reserve(principal,randomUUID())
  assert.throws(() => new PostgresPasswordChangeRepository(db.app), /authenticator/)
  for (const connection of [db.app,db.auth]) {
    await assert.rejects(connection.transaction(context(principal),client=>client.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2',[initialHash,principal.userId])), {code:'42501'})
    await assert.rejects(connection.transaction(context(principal),client=>client.query('UPDATE atrium.users SET credential_version=credential_version+1 WHERE id=$1',[principal.userId])), {code:'42501'})
    await assert.rejects(connection.transaction(context(principal),client=>client.query('DELETE FROM atrium.account_security_events WHERE user_id=$1',[principal.userId])), {code:'42501'})
    await assert.rejects(connection.transaction(context(principal),client=>client.query('SET LOCAL ROLE atrium_account_executor')), {code:'42501'})
  }
  await assert.rejects(db.app.transaction(context(principal),client=>client.query('SELECT * FROM atrium.reserve_password_change($1)',[randomUUID()])),{code:'42501'})
  await assert.rejects(repository.commit(other,reservation,await hashPassword(nextPassword)),{code:'unauthenticated'})
  for (const ctx of [{},{channelBindingId:'channel-a',channelBindingVersion:1},{...context(principal),channelProvider:'vapi'}]) {
    const result=await db.auth.transaction(ctx,client=>client.query('SELECT * FROM atrium.reserve_password_change($1)',[randomUUID()]))
    assert.equal(result.rows[0].outcome,'session_changed'); assert.equal(result.rows[0].password_hash,null)
  }
  assert.equal((await attempts(principal)).length,1); assert.deepEqual(await events(principal),[])
})

test('a misconfigured runtime role inheriting the account executor is refused before command admission', async () => {
  const principal = await user()
  for (const role of ['atrium_app','atrium_authenticator']) {
    await db.admin.query(`GRANT atrium_account_executor TO ${role}`)
    try {
      let ran = false
      await assert.rejects((role === 'atrium_app' ? db.app : db.auth).transaction(context(principal),async () => { ran = true }),
        { name: 'DatabaseConfigurationError' })
      assert.equal(ran,false)
    } finally { await db.admin.query(`REVOKE atrium_account_executor FROM ${role}`) }
  }
  assert.equal((await attempts(principal)).length,0)
})
