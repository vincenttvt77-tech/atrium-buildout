import { readFile, lstat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { databasePoolConfig, DatabaseConnection } from '../src/database/connection.ts'
import { createDatabaseRuntime } from '../src/application/runtime.ts'
import { mfaConfiguration } from '../src/auth/mfa-config.ts'
import { bootstrapHostedDemoDatabase, validateHostedDemoInput, HostedDemoBootstrapError } from './lib/hosted-demo-database.mjs'

const invalid = () => new Error('Invalid private hosted-demo configuration. See docs/hosted-demo.md.')
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value)

/** Only an explicitly selected Supabase project; never infer a host from its region. */
export function hostedDemoConfiguration(input) {
  if (!input || typeof input !== 'object' || input.version !== 1
    || !/^[a-z]{20}$/.test(input.projectRef ?? '')
    || !secret(input.appPassword) || !secret(input.authPassword) || !secret(input.sessionSecret)
    || new Set([input.appPassword, input.authPassword, input.sessionSecret]).size !== 3) throw invalid()
  try { validateHostedDemoInput(input) } catch { throw invalid() }
  let url, origin, maintenancePassword
  try {
    url = new URL(input.maintenanceUrl); origin = mfaConfiguration(input.origin).origin
    maintenancePassword = decodeURIComponent(url.password)
  }
  catch { throw invalid() }
  if ([input.appPassword, input.authPassword, input.sessionSecret].includes(maintenancePassword)) throw invalid()
  if (origin !== input.origin || !origin.startsWith('https://')
    || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.password
    || url.pathname !== '/postgres' || url.search || url.hash || (url.port && url.port !== '5432')) throw invalid()
  const pooled = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)
  if (pooled ? url.username !== `postgres.${input.projectRef}`
    : url.hostname !== `db.${input.projectRef}.supabase.co` || url.username !== 'postgres') throw invalid()
  if (input.ca !== undefined && (typeof input.ca !== 'string'
    || !input.ca.includes('-----BEGIN CERTIFICATE-----') || input.ca.length > 65536)) throw invalid()
  const runtimeUrl = (role, password) => {
    const runtime = new URL(url)
    runtime.username = pooled ? `${role}.${input.projectRef}` : role
    runtime.password = password
    runtime.port = pooled ? '6543' : '5432'
    return runtime.href
  }
  const env = {
    ATRIUM_RUNTIME_MODE: 'postgres',
    ATRIUM_DATABASE_URL: runtimeUrl('atrium_app', input.appPassword),
    ATRIUM_AUTH_DATABASE_URL: runtimeUrl('atrium_authenticator', input.authPassword),
    OPS_SESSION_SECRET: input.sessionSecret,
    ATRIUM_AUTH_ORIGIN: origin,
    ...(input.ca ? { ATRIUM_DATABASE_CA: input.ca } : {}),
  }
  // Shared parser forbids TLS weakening and session-context injection.
  const maintenance = databasePoolConfig('atrium_app', { ...env, VERCEL: '1', ATRIUM_DATABASE_URL: url.href })
  maintenance.application_name = 'atrium-hosted-demo-maintenance'
  maintenance.options = '-c search_path=pg_catalog -c statement_timeout=120000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=120000'
  return { input, env, maintenance, connectionMode: pooled ? 'session' : 'direct', projectRef: input.projectRef, origin }
}

export async function readHostedDemoConfiguration(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 131072) throw invalid()
  return hostedDemoConfiguration(JSON.parse(await readFile(path, 'utf8')))
}

export async function provisionHostedDemo(configuration) {
  const { input, env, maintenance } = configuration
  const client = new pg.Client(maintenance)
  let app, auth
  try {
    await client.connect()
    const result = await bootstrapHostedDemoDatabase({ client, connectionMode: configuration.connectionMode, appPassword: input.appPassword,
      authPassword: input.authPassword, account: input.account, bindings: input.bindings })
    app = new DatabaseConnection(databasePoolConfig('atrium_app', { ...env, VERCEL: '1' }), 'atrium_app')
    auth = new DatabaseConnection(databasePoolConfig('atrium_authenticator', { ...env, VERCEL: '1' }), 'atrium_authenticator')
    const runtime = createDatabaseRuntime({ app, auth, sessionSecret: input.sessionSecret, authOrigin: input.origin })
    await Promise.all([
      app.transaction({}, async connection => {
        const rows = await connection.query('SELECT organization_id FROM atrium.calendars')
        if (rows.rows.length) throw new Error('Unscoped application access was not refused.')
      }),
      auth.transaction({}, async connection => {
        const rows = await connection.query('SELECT user_id FROM atrium.user_credentials')
        if (rows.rows.length) throw new Error('Unscoped credential access was not refused.')
      }),
    ])
    for (const binding of input.bindings) {
      const property = await runtime.loadChannel('vapi', binding.externalId)
      if (property.snapshot.property.id !== 'prop-demo' || property.scope.organizationId !== 'org-demo-larkin') {
        throw new Error('The voice channel did not resolve to the selected demo property.')
      }
    }
    return { result, env }
  } finally {
    await Promise.allSettled([app?.close(), auth?.close(), client.end()])
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/hosted-demo.mjs --check|--apply PRIVATE_CONFIG_JSON NEW_PRIVATE_ENV_JSON\nSee docs/hosted-demo.md. No credentials are accepted on the command line.')
    return
  }
  if (args.length !== 3 || !['--check', '--apply'].includes(args[0])) {
    throw new Error('Usage: node scripts/hosted-demo.mjs --check|--apply PRIVATE_CONFIG_JSON NEW_PRIVATE_ENV_JSON')
  }
  const configuration = await readHostedDemoConfiguration(resolve(args[1]))
  const output = resolve(args[2])
  try { await lstat(output); throw new Error('Output already exists; choose a new private output file.') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (args[0] === '--check') {
    console.log(JSON.stringify({ configuration: 'valid', projectRef: configuration.projectRef,
      origin: configuration.origin, applied: false }))
    return
  }
  const { result, env } = await provisionHostedDemo(configuration)
  await writeFile(output, JSON.stringify(env, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ provisioned: true, projectRef: configuration.projectRef,
    origin: configuration.origin, runtimeRolesVerified: true, voiceBindingsVerified: true,
    environmentFile: output, seeded: result.seeded }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // PostgreSQL errors can include credentials or SQL parameters. Never echo them.
    console.error('Hosted demo setup did not complete. Configuration and database records were not reset. Inspect the private setup and documented prerequisites before retrying.')
    if (error instanceof HostedDemoBootstrapError) console.error(JSON.stringify({ code: error.code, stage: error.stage }))
    process.exitCode = 1
  })
}
