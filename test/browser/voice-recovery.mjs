/** Real Chromium against the generated dashboard and intercepted synthetic fixtures.
 * No server, account, database, provider or real caller data is used. This verifies
 * rendered behavior, not authentication or live phone delivery.
 * Set ATRIUM_PLAYWRIGHT_MODULE, ATRIUM_CHROME_EXECUTABLE and ATRIUM_BROWSER_ARTIFACTS.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
const html = await readFile(new URL('../../ops/dashboard.html', import.meta.url), 'utf8')
assert.ok(html.includes('Tour booking needs verification'), 'Build current dashboard artifacts before browser acceptance')
const origin = 'https://atrium.test'
const artifacts = resolve(process.env.ATRIUM_BROWSER_ARTIFACTS || '/tmp/atrium-voice-recovery-browser')
await mkdir(artifacts, { recursive: true })
const at = new Date().toISOString(), tourAt = new Date(Date.now() + 86400000).toISOString()
const scope = { organizationId: 'org-synthetic', propertyId: 'building-synthetic', configurationVersion: 1, permissionVersion: 'synthetic-one' }
const property = { ...scope, buildingName: 'The Larkin · Synthetic QA', locationLabel: 'Synthetic fixture',
  timeZone: 'America/New_York', permissions: ['read', 'operate'], hours: {} }
const callback = (callId, value, name) => ({ value, excerpt: `${name} requested this callback number.`, callId, at, confidence: 1 })
const prospect = (callId, name, value) => ({ phone: 'unknown', name, email: null, stage: 'new', firstSeenAt: at, lastSeenAt: at,
  calls: [{ callId, at, durationSeconds: 45, outcome: 'Enquired', toolsCalled: [] }], bookings: [], signals: {},
  escalations: [], notes: [], unitsDiscussed: [], callbackPhone: callback(callId, value, name) })
const followUp = (callId, id) => ({ id, phone: 'unknown', kind: 'nurture', status: 'scheduled', channel: 'call',
  dueAt: at, createdAt: at, createdFromCall: callId, reason: 'Synthetic follow-up' })
const review = { id: 'booking-review:call-review', version: 1, callId: 'call-review', kind: 'booking_review', durable: true,
  needsReview: true, at, updatedAt: at, sourceRevision: 4, phone: '+13125550101', name: 'Dana Sample', email: 'dana@example.test',
  callbackPhone: callback('call-review', '+13125550102', 'Dana'), notificationStatus: 'not_sent',
  booking: { slotId: 'slot-synthetic', startsAt: tourAt, unitId: '19A', status: 'arranging' } }
const leads = { scope, profiles: [prospect('call-ana', 'Ana Sample', '+13125550103'), prospect('call-ben', 'Ben Sample', '+13125550104')],
  followUps: [followUp('call-ana', 'task-ana'), followUp('call-ben', 'task-ben')], tourChangeRequests: [], outboundEnabled: false,
  store: { kind: 'postgres', durable: true, note: 'Synthetic fixture only' } }
const errors = [], unexpected = [], checks = [], screenshots = []
let browser
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' })
    await context.addInitScript(({ property }) => {
      window.ATRIUM_RUNTIME_MODE = 'postgres'
      window.ATRIUM_PROPERTY = property
      window.ATRIUM_ACCOUNT = { username: 'synthetic-operator', displayName: 'Synthetic Operator', userId: 'synthetic-user' }
    }, { property })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      if (request.method() !== 'GET') {
        unexpected.push({ method: request.method(), path: url.pathname })
        return route.fulfill({ status: 405, body: '' })
      }
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html })
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' })
      let data
      if (url.pathname === '/api/vapi') data = { scope, calls: [], events: [review], callsConfigured: true }
      else if (url.pathname === '/api/leads') data = leads
      else if (url.pathname === '/api/calendar') data = { scope, slots: [], bookings: [], blocks: [], units: [], unitBlocks: [],
        timeZone: property.timeZone, store: { kind: 'postgres', durable: true },
        range: { from: url.searchParams.get('from'), to: url.searchParams.get('to') } }
      else if (url.pathname === '/api/health') data = { ok: true, store: 'postgres', durable: true, callHistory: true }
      else { unexpected.push({ method: request.method(), path: url.pathname }); return route.fulfill({ status: 404, body: '' }) }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push({ width, type: 'pageerror', message: error.message }))
    page.on('console', message => { if (message.type() === 'error') errors.push({ width, type: 'console', message: message.text() }) })
    const noOverflow = async label => {
      const measurement = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
      assert.ok(measurement.scrollWidth <= measurement.width, `${label} at${width}: ${JSON.stringify(measurement)}`)
    }
    const screenshot = async name => {
      const path = resolve(artifacts, `${name}-${width}.png`)
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path, fullPage: true })
      screenshots.push(path)
    }

    await page.goto(`${origin}/#/calls?id=call-review`)
    const calls = page.locator('.calls-view'), callPanel = calls.locator('.call-panel')
    await callPanel.getByRole('heading', { name: 'Tour booking needs verification', exact: true }).waitFor()
    assert.match(await callPanel.innerText(), /Requested callback: \(312\) 555-0102/)
    assert.match(await callPanel.innerText(), /Check the existing reservation before arranging another tour/)
    assert.doesNotMatch(await callPanel.innerText(), /Tour booked|someone would call back|couldn't be booked/)
    assert.equal(await callPanel.locator('[data-action="handled"]').count(), 0)
    await noOverflow('Calls recovery detail')
    await screenshot('calls-recovery')
    checks.push(`${width}: Calls recovery details preserve uncertainty and callback, with no horizontal overflow`)

    await page.goto(`${origin}/#/today`)
    const todayReview = page.locator('[data-key="np:call-review"]')
    await todayReview.waitFor({ state: 'visible' })
    assert.match(await todayReview.innerText(), /Verify Dana Sample.s tour/)
    assert.match(await todayReview.innerText(), /No notification has been sent/)
    const reviewBody = await todayReview.locator('.row-body').boundingBox()
    assert.ok(reviewBody && reviewBody.width >= 180, `Today review text needs a readable column at${width}: ${JSON.stringify(reviewBody)}`)
    await noOverflow('Today durable review')
    await screenshot('today-review')
    await todayReview.getByRole('link', { name: 'Review call', exact: true }).press('Enter')
    await page.waitForURL('**/#/calls?id=call-review')
    await page.locator('.call-panel').getByRole('heading', { name: 'Tour booking needs verification', exact: true }).waitFor()
    checks.push(`${width}: Today shows durable review and keyboard Review call opens its exact detail`)

    await page.goto(`${origin}/#/leads?tab=all`)
    const leadView = page.locator('.leads-view')
    const benRow = leadView.locator('.lead-row[data-call="call-ben"]')
    await benRow.waitFor({ state: 'visible' })
    await benRow.focus(); await benRow.press('Enter')
    await page.waitForURL('**/#/leads?tab=all&phone=unknown&call=call-ben')
    const leadPanel = leadView.locator('.lead-panel')
    await leadPanel.getByRole('heading', { name: 'Ben Sample', exact: true }).waitFor()
    assert.match(await leadPanel.innerText(), /Ben Sample requested this callback number/)
    assert.doesNotMatch(await leadPanel.innerText(), /Ana Sample/)
    assert.equal(await leadPanel.locator('[data-fu="task-ben"]').count(), 2)
    assert.equal(await leadPanel.locator('[data-fu="task-ana"]').count(), 0)
    assert.equal(await leadPanel.locator('[data-action="setname"], [data-action="savenote"]').count(), 0)
    assert.equal(await leadPanel.locator('a.lead-call').getAttribute('href'), 'tel:+13125550104')
    assert.equal(await leadPanel.locator('h2').evaluate(el => el === document.activeElement), true)
    await noOverflow('Anonymous lead callback detail')
    await screenshot('anonymous-callback')
    await leadPanel.locator('[data-action="close"]:visible').first().click()
    await benRow.waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-key') === 'lead:call:call-ben')
    await leadView.locator('.lead-row[data-call="call-ana"]').click()
    await leadPanel.getByRole('heading', { name: 'Ana Sample', exact: true }).waitFor()
    assert.equal(await leadPanel.locator('a.lead-call').getAttribute('href'), 'tel:+13125550103')
    assert.equal(await leadPanel.locator('[data-fu="task-ben"]').count(), 0)
    checks.push(`${width}: Keyboard selects exact hidden caller, focus returns to origin, callbacks/tasks stay separate`)
    await context.close()
  }
  assert.deepEqual(unexpected, [], 'All browser requests must be explicitly intercepted fixtures')
  assert.deepEqual(errors, [], 'No browser errors are expected')
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ checks, errors, unexpected, screenshots,
    limitation: 'Synthetic intercepted browser fixtures; not authentication, provider delivery or production verification.' }, null, 2) + '\n')
  console.log(JSON.stringify({ checks, errors, unexpected, screenshots }, null, 2))
} finally {
  await browser?.close()
}
