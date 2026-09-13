import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostedDemoConfiguration, readHostedDemoConfiguration } from '../../scripts/hosted-demo.mjs'

function fixture() {
  return { version: 1, projectRef: 'abcdefghijklmnopqrst',
    maintenanceUrl: 'postgresql://postgres.abcdefghijklmnopqrst:synthetic-maintenance-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    origin: 'https://portal.example.test', appPassword: 'a'.repeat(48), authPassword: 'b'.repeat(48), sessionSecret: 'c'.repeat(48),
    account: { username: 'larkin', displayName: 'The Larkin · Demo', passwordHash: 'scrypt$65536$8$1$' + 'A'.repeat(22) + '$' + 'A'.repeat(43) },
    bindings: [{ id: 'channel-hosted-larkin', externalId: 'synthetic-test-assistant' }] }
}

test('hosted setup separates maintenance and both runtime logins on the verified pooler target', () => {
  const prepared = hostedDemoConfiguration(fixture())
  assert.equal(prepared.connectionMode, 'session')
  assert.equal(prepared.maintenance.port, 5432)
  assert.equal(prepared.maintenance.ssl.rejectUnauthorized, true)
  const app = new URL(prepared.env.ATRIUM_DATABASE_URL)
  const auth = new URL(prepared.env.ATRIUM_AUTH_DATABASE_URL)
  assert.equal(app.username, 'atrium_app.abcdefghijklmnopqrst')
  assert.equal(auth.username, 'atrium_authenticator.abcdefghijklmnopqrst')
  assert.equal(app.hostname, prepared.maintenance.host)
  assert.equal(app.port, '6543')
  assert.notEqual(app.password, auth.password)
  assert.equal(prepared.env.ATRIUM_AUTH_ORIGIN, 'https://portal.example.test')
  assert.equal(Object.values(prepared.env).some(value => value.includes('synthetic-maintenance-password')), false)
})

test('direct connections retain the exact project host without enabling a paid IPv4 option', () => {
  const input = fixture()
  input.maintenanceUrl = 'postgresql://postgres:synthetic-password@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'
  const prepared = hostedDemoConfiguration(input)
  assert.equal(prepared.connectionMode, 'direct')
  assert.equal(new URL(prepared.env.ATRIUM_DATABASE_URL).username, 'atrium_app')
  assert.equal(new URL(prepared.env.ATRIUM_DATABASE_URL).port, '5432')
})

test('maintenance credentials cannot be reused for an application role or the session signer', () => {
  for (const field of ['appPassword', 'authPassword', 'sessionSecret']) {
    const input = fixture()
    const maintenance = new URL(input.maintenanceUrl)
    // Percent encoding must not evade the same-value comparison.
    maintenance.password = input[field].replace(/^./, '%61')
    input[field] = 'a' + input[field].slice(1)
    input.maintenanceUrl = maintenance.href
    assert.throws(() => hostedDemoConfiguration(input), /Invalid private hosted-demo/)
  }
})

test('hosted configuration refuses foreign projects, unsafe origins, TLS overrides and shared secrets', () => {
  for (const mutate of [
    input => { input.maintenanceUrl = input.maintenanceUrl.replace('postgres.abcdefghijklmnopqrst', 'postgres.zzzzzzzzzzzzzzzzzzzz') },
    input => { input.maintenanceUrl = input.maintenanceUrl.replace('.supabase.com', '.supabase.com.evil.test') },
    input => { input.maintenanceUrl = input.maintenanceUrl.replace(':5432/', ':6543/') },
    input => { input.maintenanceUrl += '?sslmode=disable' },
    input => { input.maintenanceUrl += '#options' },
    input => { input.maintenanceUrl = input.maintenanceUrl.replace('/postgres', '/unrelated') },
    input => { input.origin = 'http://portal.example.test' },
    input => { input.origin = 'https://portal.example.test/account' },
    input => { input.origin = 'https://portal.example.test/' },
    input => { input.authPassword = input.appPassword },
    input => { input.sessionSecret = input.appPassword },
    input => { input.ca = 'untrusted certificate override' },
    input => { input.account.passwordHash = 'not-a-password-hash' },
    input => { input.bindings[0].externalId = '' },
    input => { input.bindings = [] },
  ]) {
    const input = fixture(); mutate(input)
    assert.throws(() => hostedDemoConfiguration(input), /Invalid private hosted-demo/)
  }
})

test('private setup cannot read a broadly readable, oversized or symbolic-link credential file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atrium-hosted-config-test-'))
  try {
    const privateFile = join(directory, 'private.json')
    await writeFile(privateFile, JSON.stringify(fixture()), { mode: 0o600 })
    assert.equal((await readHostedDemoConfiguration(privateFile)).projectRef, fixture().projectRef)
    const publicFile = join(directory, 'public.json')
    await writeFile(publicFile, JSON.stringify(fixture()), { mode: 0o644 })
    await assert.rejects(readHostedDemoConfiguration(publicFile))
    const link = join(directory, 'link.json')
    await symlink(privateFile, link)
    await assert.rejects(readHostedDemoConfiguration(link))
    const huge = join(directory, 'huge.json')
    await writeFile(huge, ' '.repeat(131073), { mode: 0o600 })
    await assert.rejects(readHostedDemoConfiguration(huge))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
