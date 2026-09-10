/**
 * Actual dev-ops CLI boot, default fixture import, password login and mandatory
 * MFA gate in a disposable application copy. No existing account or local DB is
 * copied. The only shared path is the installed, read-only dependency tree.
 * Run with Node 22. This is HTTP/CLI acceptance, not a browser passkey ceremony.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = fileURLToPath(new URL('../../', import.meta.url))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const execFileAsync = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), 'atrium-startup-'))
const copy = join(temporary, 'app')
const checks = []
let child, childExit, admin, log, cleanupPromise

async function waitFor(predicate, message, milliseconds = 120000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(message)
}
async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function unusedPort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  assert.notEqual(port, 4300, 'Never use the existing preview port')
  return port
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    if (admin) { await admin.end(); admin = null }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([childExit, delay(15000)])
      if (child.exitCode === null && child.signalCode === null) throw new Error('Disposable CLI did not finish graceful shutdown; its private files were retained')
    }
    // A failure before dev-ops installs its own signal handlers can leave a
    // PostgreSQL process. Signal only the PID whose own data-dir marker and
    // process command both match this newly created disposable directory.
    const data = join(copy, '.atrium-local', 'data'), pidFile = join(data, 'postmaster.pid')
    if (await exists(pidFile)) {
      const [rawPid, recordedDirectory] = (await readFile(pidFile, 'utf8')).split('\n')
      const pid = Number(rawPid)
      assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Unexpected disposable PostgreSQL PID')
      assert.equal(await realpath(recordedDirectory), await realpath(data), 'PostgreSQL data directory does not match the test')
      try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
        assert.ok(stdout.includes('postgres') && stdout.includes(data), 'Refusing to signal an unrelated process')
        process.kill(pid, 'SIGINT')
        await waitFor(async () => !(await exists(pidFile)), 'Disposable PostgreSQL did not shut down; its files were retained', 15000)
      } catch (error) {
        if (error.code !== 'ESRCH' && error.code !== 1) throw error
      }
    }
    await log?.close()
    await rm(temporary, { recursive: true, force: true })
  })()
  return cleanupPromise
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cleanup().then(() => process.exit(1), () => { console.error('Disposable startup cleanup needs attention'); process.exit(1) })
})

try {
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Run this acceptance script with Node 22')
  await mkdir(copy, { mode: 0o700 })
  // Explicit allowlist: never copy root .env*, .atrium-local, private account
  // files, Git, browser profiles, reports, or the real account's credentials.
  const paths = ['api', 'src', 'data', 'ops/src', 'scripts', 'supabase/migrations', 'package.json', 'package-lock.json']
  for (const path of paths) {
    await mkdir(dirname(join(copy, path)), { recursive: true, mode: 0o700 })
    await cp(join(root, path), join(copy, path), { recursive: true, filter: async source => {
      if (basename(source).startsWith('.')) return false
      return !(await lstat(source)).isSymbolicLink()
    } })
  }
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir')
  assert.equal(await exists(join(copy, '.env.demo-account.json')), false)
  assert.equal(await exists(join(copy, '.atrium-local')), false)
  assert.equal(await exists(join(copy, 'ops', 'dashboard.page.json')), false, 'Exercise the real first-start build')
  checks.push('Fresh copy contains no existing account, database or generated dashboard')

  const port = await unusedPort(), origin = `http://localhost:${port}`, address = `http://127.0.0.1:${port}`
  // Do not inherit provider, database, runtime or session credentials. The CLI
  // itself disables operational fetch before invoking the actual seed handlers.
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: temporary, LANG: 'en_US.UTF-8', NODE_ENV: 'development' }
  log = await open(join(temporary, 'private-cli.log'), 'wx', 0o600)
  child = spawn(process.execPath, [join(copy, 'scripts', 'dev-ops.mjs'), '--port', String(port)], {
    cwd: copy, env, stdio: ['ignore', log.fd, log.fd],
  })
  childExit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject) })
  const request = (path, options = {}) => fetch(address + path, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { host: `localhost:${port}`, ...options.headers },
  })
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The disposable dev-ops CLI exited before becoming ready')
    try { return (await request('/')).status === 401 } catch { return false }
  }, 'The disposable dev-ops CLI did not reach its login page')
  let output = await readFile(join(temporary, 'private-cli.log'), 'utf8')
  const credentials = /Created local demo account\. Username: (larkin)\. Password: ([A-Za-z0-9_-]{32,})/.exec(output)
  assert.ok(credentials, 'Fresh startup must generate the initial demo account once')
  let password = credentials[2]
  assert.ok(/Seeded\s+\d+ leads/.test(output), 'Default startup must finish the fixture import before accepting requests')
  output = ''
  checks.push('Actual dev-ops CLI completes default fixture import and serves the login page')

  const config = JSON.parse(await readFile(join(copy, '.atrium-local', 'config.json'), 'utf8'))
  const pidFile = (await readFile(join(copy, '.atrium-local', 'data', 'postmaster.pid'), 'utf8')).split('\n')
  admin = new pg.Client({ host: '127.0.0.1', port: Number(pidFile[3]), user: 'postgres', password: config.adminPassword,
    database: 'postgres', connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on -c statement_timeout=5000' })
  await admin.connect()
  const imported = (await admin.query("SELECT value FROM atrium_local.imports WHERE id='synthetic-calls-v1'")).rows[0]?.value
  const fixture = JSON.parse(await readFile(join(copy, 'scripts', 'dev-fixtures', 'calls.json'), 'utf8'))
  assert.equal(imported?.status, 'complete', 'Default fixture checkpoint must commit')
  assert.equal(imported?.synthetic, true)
  assert.equal(imported?.fixture?.calls?.length, fixture.calls.length)
  const progress = (await admin.query("SELECT value FROM atrium_local.imports WHERE id='synthetic-calls-progress-v1'")).rows[0]?.value
  assert.ok(progress && !progress.inFlight && Object.keys(progress.completed).length > 0, 'No uncertain seed operation may remain')
  const counts = (await admin.query(`SELECT
    (SELECT count(*)::integer FROM atrium.operational_documents WHERE key LIKE 'lead:%') AS prospects,
    (SELECT count(*)::integer FROM atrium.operational_documents WHERE key LIKE 'followup:%') AS followups,
    (SELECT coalesce(sum(jsonb_array_length(state->'bookings')),0)::integer FROM atrium.calendars) AS bookings,
    (SELECT count(*)::integer FROM atrium.mfa_factors) AS factors,
    (SELECT count(*)::integer FROM atrium.user_sessions) AS sessions`)).rows[0]
  assert.ok(counts.prospects > 0 && counts.followups > 0 && counts.bookings > 0, 'Imported leasing records must exist durably')
  assert.equal(counts.factors, 0, 'Fixture import must never enroll a staff passkey')
  assert.equal(counts.sessions, 0, 'Fixture import must not impersonate a signed-in staff user')
  const configurationVersion = String((await admin.query("SELECT published_configuration_version FROM atrium.properties WHERE organization_id='org-demo-larkin' AND id='prop-demo'")).rows[0].published_configuration_version)
  checks.push('Committed fixture records exist without synthetic staff sessions or passkeys')

  const initial = await request('/'), loginHtml = await initial.text()
  assert.equal(initial.status, 401)
  assert.ok(loginHtml.includes('name="username"') && loginHtml.includes('name="password"'), 'Real username/password form required')
  assert.ok(!loginHtml.includes('window.ATRIUM_PROPERTY='), 'Unauthenticated response must not contain the dashboard bootstrap')
  const signedIn = await request('/api/dashboard', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'larkin', password }).toString() })
  password = ''
  assert.equal(signedIn.status, 303, 'Generated credential must sign in through the actual HTTP handler')
  const rawCookie = signedIn.headers.get('set-cookie')
  assert.ok(rawCookie && /a4\./.test(rawCookie), 'Password sign-in must issue a registered session cookie')
  const cookie = rawCookie.split(';')[0]
  const dashboard = await request(signedIn.headers.get('location'), { headers: { cookie } })
  assert.equal(dashboard.status, 303)
  assert.equal(dashboard.headers.get('location'), '/api/mfa', 'Owner must verify before seeing property data')
  const mfaPage = await request('/api/mfa', { headers: { cookie } }), html = await mfaPage.text()
  assert.equal(mfaPage.status, 200)
  const match = /window\.ATRIUM_MFA=(\{[^\n]*\});<\/script>/.exec(html)
  assert.ok(match, 'MFA page must carry its real public state')
  const bootstrap = JSON.parse(match[1])
  assert.equal(bootstrap.userId, 'user-demo-larkin')
  assert.equal(bootstrap.state.required, true)
  assert.equal(bootstrap.state.sessionVerified, false)
  assert.equal(bootstrap.state.everEnabled, false)
  assert.deepEqual(bootstrap.state.factors, [])
  assert.ok(!html.includes(config.adminPassword) && !html.includes(config.sessionSecret), 'Private startup credentials must not reach the page')
  checks.push('Generated account signs in through HTTP and reaches mandatory unenrolled MFA')

  for (const path of ['/api/properties', '/api/calendar', '/api/leads', '/api/vapi']) {
    const response = await request(path, { headers: { cookie, 'x-atrium-organization-id': 'org-demo-larkin', 'x-atrium-property-id': 'prop-demo', 'x-atrium-config-version': configurationVersion } })
    assert.equal(response.status, 403, `${path} must refuse password-only property access`)
    const body = await response.json()
    assert.equal(body.code, 'mfa_required', `${path} must enforce MFA before serving imported data`)
    assert.ok(!('profiles' in body) && !('calls' in body) && !('bookings' in body), 'Denied response must not contain fixture records')
  }
  const stateRows = (await admin.query('SELECT (SELECT count(*)::integer FROM atrium.user_sessions) sessions,(SELECT count(*)::integer FROM atrium.mfa_factors) factors')).rows[0]
  assert.equal(stateRows.sessions, 1)
  assert.equal(stateRows.factors, 0)
  checks.push('Imported workspace remains inaccessible before real passkey verification')
  await cleanup()
  assert.equal(await exists(temporary), false, 'All disposable data must be removed after shutdown')
  console.log(JSON.stringify({ ok: true, checks, fixture: { calls: fixture.calls.length, prospects: counts.prospects, followups: counts.followups, bookings: counts.bookings }, cleanup: 'complete' }, null, 2))
} catch (error) {
  // Never print child output, generated passwords, cookies, config or HTTP bodies.
  console.error(`Local-startup acceptance failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
} finally {
  try { await cleanup() } catch { console.error('Disposable startup cleanup needs attention; private temporary data was retained'); process.exitCode = 1 }
}
