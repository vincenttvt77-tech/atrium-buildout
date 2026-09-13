/** Actual Chromium + HTTP + disposable PostgreSQL; signed synthetic MFA, no providers. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'
const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
await buildAuthClient()
const routes = new Map(await Promise.all(['dashboard', 'mfa', 'account', 'organizations']
  .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
const oldMode = process.env.ATRIUM_RUNTIME_MODE, oldFetch = globalThis.fetch
let db, server, runtime, browser, origin
const checks = [], errors = [], artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
try {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  for (let i = 0; i < 54; i++) {
    const id = `synthetic-team-${String(i).padStart(2, '0')}`
    await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$2,'active')", [id, `Synthetic Leasing Colleague ${i + 1}`])
    await db.admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES($1,$2,'organization-a','viewer','organization','active')", [`member-${id}`, id])
  }
  // No published property or provider configuration is needed for this staff workflow.
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin)
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
      const handler = routes.get(url.pathname)
      if (!handler) { res.statusCode = 404; res.end(); return }
      req.atriumRuntime = runtime
      let raw = ''; for await (const chunk of req) raw += chunk
      req.body = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw
      req.query = Object.fromEntries(url.searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = body => { res.end(body); return res }
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
      await handler(req, res)
    } catch (error) { errors.push(error.message); res.statusCode = 500; res.end('Synthetic handler failure') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('base64url'), authOrigin: origin })
  globalThis.fetch = async () => { throw new Error('Outbound transport denied in synthetic browser fixture') }
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204, body: '' }))
  const page = await context.newPage(); page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
  await page.getByLabel('Username', { exact: true }).fill('owner-a')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in to workspace' }).click()
  await page.waitForURL('**/api/mfa')
  const cookie = (await context.cookies(origin)).map(value => `${value.name}=${value.value}`).join('; ')
  const principal = await runtime.authenticate({ cookie }, new Date())
  await verifyOrganizationSession(runtime, principal, password)
  await page.goto(`${origin}/api/organizations`)
  await page.locator('[data-member="member-staff-a"]').waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-member]').count(), 50)
  assert.doesNotMatch(await page.locator('#team-root').innerText(), /owner-b|organization-b/)
  await page.locator('#team-more').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('[data-member]').length === 57)
  assert.equal(new Set(await page.locator('[data-member]').evaluateAll(nodes => nodes.map(node => node.dataset.member))).size, 57)
  await page.waitForFunction(() => document.activeElement?.matches('[data-member]'))
  checks.push('Real scoped directory and keyboard pagination work without published property configuration')
  await page.locator('#team-members').evaluate(element => { element.scrollTop = element.scrollHeight })
  const scroll = await page.locator('#team-members').evaluate(element => element.scrollTop)
  await page.locator('[data-member]').last().click()
  assert.equal(await page.locator('#team-members').evaluate(element => element.scrollTop), scroll)
  checks.push('Selecting a member preserves the inner directory scroll position')
  await page.locator('[data-member="member-staff-a"]').click()
  await page.getByRole('button', { name: 'Edit access', exact: true }).click()
  await page.getByLabel('Role', { exact: true }).selectOption('viewer')
  await page.locator('[data-property="property-a1"]').uncheck()
  await page.locator('[data-property="property-a2"]').check()
  await page.getByRole('button', { name: 'Review access change' }).click()
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}`)
    assert.equal(await page.getByRole('button', { name: 'Save access change' }).isEnabled(), true)
    if (artifacts) await page.screenshot({ path: `${artifacts}/team-review-${width}.png`, fullPage: true })
  }
  await page.getByRole('button', { name: 'Save access change' }).click()
  await page.waitForFunction(() => document.querySelector('#team-notice')?.textContent.includes('latest saved access'))
  const saved = (await db.admin.query("SELECT role,permission_version FROM atrium.memberships WHERE id='member-staff-a'")).rows[0]
  assert.deepEqual(saved, { role: 'viewer', permission_version: '2' })
  assert.deepEqual((await db.admin.query("SELECT property_id FROM atrium.property_grants WHERE membership_id='member-staff-a' AND status='active'")).rows.map(value => value.property_id), ['property-a2'])
  checks.push('Reviewed complete role/property replacement commits through HTTP at mobile and desktop widths')
  // Drop only the first successful save response after the server has committed it.
  let loseNext = true; const commands = []
  await page.route('**/api/organizations', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return }
    commands.push(route.request().postDataJSON())
    if (loseNext) { loseNext = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed') }
    else await route.fallback()
  })
  await page.locator('[data-member="member-staff-a"]').click()
  await page.getByRole('button', { name: 'Edit access', exact: true }).click()
  await page.getByLabel('Role', { exact: true }).selectOption('staff')
  await page.getByRole('button', { name: 'Review access change' }).click()
  await page.getByRole('button', { name: 'Save access change' }).click()
  await page.getByRole('button', { name: 'Check this saved change' }).waitFor({ state: 'visible' })
  assert.equal((await db.admin.query("SELECT permission_version FROM atrium.memberships WHERE id='member-staff-a'")).rows[0].permission_version, '3')
  assert.equal(await page.locator('#team-refresh').isDisabled(), true)
  await page.getByRole('button', { name: 'Check this saved change' }).click()
  await page.waitForFunction(() => document.querySelector('#team-notice')?.textContent.includes('latest saved access'))
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1])
  assert.equal((await db.admin.query("SELECT permission_version FROM atrium.memberships WHERE id='member-staff-a'")).rows[0].permission_version, '3')
  assert.equal((await db.admin.query("SELECT count(*)::int n FROM atrium.organization_events WHERE membership_id='member-staff-a'")).rows[0].n, 2)
  checks.push('Lost response requires explicit identical retry, returns one receipt and never duplicates mutation/audit')
  await page.unroute('**/api/organizations')
  await page.getByRole('link', { name: 'Account security', exact: true }).click()
  await page.waitForURL('**/api/account')
  await page.goBack()
  await page.locator('[data-member="member-staff-a"]').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#team-refresh').isEnabled(), true)
  checks.push('Back navigation restores a fresh usable Team directory')
  await page.locator('[data-member="member-staff-a"]').click()
  await page.getByRole('button', { name: 'Edit access', exact: true }).click()
  await page.getByLabel('Role', { exact: true }).selectOption('viewer')
  await page.getByRole('button', { name: 'Review access change' }).click()
  await db.admin.query("UPDATE atrium.memberships SET permission_version=permission_version+1 WHERE id='member-staff-a'")
  await page.getByRole('button', { name: 'Save access change' }).click()
  await page.waitForFunction(() => document.querySelector('#team-notice')?.textContent.includes('Refresh the directory'))
  assert.equal((await db.admin.query("SELECT role FROM atrium.memberships WHERE id='member-staff-a'")).rows[0].role, 'staff')
  assert.equal(await page.getByRole('button', { name: 'Save access change' }).count(), 0)
  checks.push('Concurrent member change refuses stale browser save and requires refresh')
  await runtime.sessions.revoke(principal, principal.sessionId)
  await page.locator('#team-refresh').click()
  await page.getByRole('heading', { name: 'Check your access' }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-member]').count(), 0)
  checks.push('Revoked session clears directory and retires access controls')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: checks.length, checks, errors, artifacts: artifacts ?? null }, null, 2))
} finally {
  globalThis.fetch = oldFetch
  await browser?.close()
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  oldMode === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = oldMode
}
