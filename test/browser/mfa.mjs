/**
 * Actual Chromium WebAuthn + HTTP + disposable PostgreSQL. No real browser
 * profile, authenticator, credentials, application data or remote services.
 * Run with Node 22; ATRIUM_PLAYWRIGHT_MODULE can name an installed Playwright
 * index.mjs, and ATRIUM_CHROME_EXECUTABLE can select an installed Chrome binary.
 * Virtual user verification proves browser integration, not physical biometrics.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { buildAuthClient } from '../../scripts/build-auth.mjs'

const playwrightModule = process.env.ATRIUM_PLAYWRIGHT_MODULE
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright')
await buildAuthClient()
const routes = new Map(await Promise.all(['dashboard', 'mfa', 'account', 'properties', 'calendar', 'leads', 'vapi', 'health']
  .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
const originalFetch = globalThis.fetch
const oldMode = process.env.ATRIUM_RUNTIME_MODE
let db, server, browser, runtime, origin
const errors = [], failures = [], checks = []
const artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
try {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  const bundle = { property: { id: 'property-a1', organizationId: 'organization-a', buildingName: 'Synthetic browser building',
    timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings() }, inventory: [], floorplans: [], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES('organization-a','property-a1',1,'published',$1,now(),'synthetic-browser',now())`, [JSON.stringify(bundle)])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin)
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
      const handler = routes.get(url.pathname)
      if (!handler) { res.statusCode = 404; res.end('Not found'); return }
      req.atriumRuntime = runtime
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 70000) throw new Error('Oversized test request') }
      req.body = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : body
      req.query = Object.fromEntries(url.searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
      await handler(req, res)
    } catch (error) { errors.push({ name: error.name, code: error.code }); res.statusCode = 500; res.end('Synthetic handler failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('base64url'), authOrigin: origin })
  globalThis.fetch = async () => { throw new Error('External services are unavailable in the browser fixture') }
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  // Do not load even fonts from outside the ephemeral local server.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204, body: '' }))
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push({ name: error.name, message: error.message }))
  page.on('console', message => { if (message.type() === 'error') errors.push({ console: message.text() }) })
  page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 500) failures.push(response.status()) })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  async function visible(selector) { await page.locator(selector).waitFor({ state: 'visible' }) }
  async function hasText(selector, expected) {
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent.includes(expected), { selector, expected })
  }
  async function signIn() {
    await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
    await page.getByLabel('Username', { exact: true }).fill('owner-a')
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in to workspace' }).click()
    await page.waitForURL('**/api/mfa')
    await hasText('#mfa-summary', 'Verify to continue')
  }
  async function openPrompt() {
    await page.getByRole('button', { name: 'Open passkey prompt', exact: true }).click()
  }
  await signIn()
  checks.push('Password sign-in reaches mandatory verification')
  await page.getByRole('button', { name: 'Set up a passkey', exact: true }).click()
  await page.getByLabel('Passkey name', { exact: true }).fill('Synthetic browser key')
  await page.getByLabel('Current password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Create passkey on this device', exact: true }).click()
  await page.getByRole('button', { name: 'Verify new passkey', exact: true }).waitFor({ state: 'visible' })
  assert.match(await page.locator('#mfa-summary').innerText(), /Verify to continue/)
  await page.getByRole('button', { name: 'Verify new passkey', exact: true }).click()
  await openPrompt()
  await hasText('#mfa-summary', 'This session is verified')
  checks.push('Native navigator.credentials create/get activates the pending factor after a real signed assertion')
  await page.getByRole('button', { name: 'Verify security changes', exact: true }).click()
  await openPrompt()
  await hasText('#mfa-notice', 'verified for security changes')
  await page.getByRole('button', { name: 'Create recovery codes', exact: true }).click()
  await page.getByLabel('Current password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create new recovery codes', exact: true }).click()
  await visible('#mfa-recovery-codes')
  assert.equal((await page.locator('#mfa-codes').innerText()).trim().split('\n').length, 10)
  await page.getByRole('button', { name: 'I saved these codes', exact: true }).click()
  assert.equal(await page.locator('#mfa-codes').textContent(), '')
  checks.push('Fresh signed step-up plus password creates ten recovery codes; dismissal removes plaintext')
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `MFA has no overflow at ${width}`)
    if (artifacts) await page.screenshot({ path: `${artifacts}/mfa-${width}.png`, fullPage: true })
  }
  checks.push('Passkey screen renders without horizontal overflow at 390 and 1280 pixels')
  // New cookie/session must verify again even though the authenticator is unchanged.
  await signIn()
  await page.getByRole('button', { name: 'Verify this sign-in', exact: true }).click()
  await openPrompt()
  await hasText('#mfa-summary', 'This session is verified')
  const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
  assert.equal(credentials.credentials.length, 1)
  assert.ok(credentials.credentials[0].signCount >= 3)
  const proof = await db.admin.query("SELECT count(*)::int n FROM atrium.mfa_assurances WHERE user_id='owner-a'")
  assert.ok(proof.rows[0].n >= 3)
  checks.push('Fresh sign-in requires and accepts another native signed assertion')
  assert.deepEqual(failures, [], 'No local HTTP 5xx responses')
  assert.deepEqual(errors, [], 'No browser console/page or server errors')
  console.log(JSON.stringify({ status: 'passed', checks, physicalAuthenticatorVerified: false, hostedVerified: false }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  await browser?.close()
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  if (oldMode === undefined) delete process.env.ATRIUM_RUNTIME_MODE; else process.env.ATRIUM_RUNTIME_MODE = oldMode
}
