/** Generated dashboard acceptance with real Chromium and synthetic intercepted data.
 * No live server, credentials, database, provider or caller data is accessed.
 * Set ATRIUM_PLAYWRIGHT_MODULE, ATRIUM_CHROME_EXECUTABLE and ATRIUM_BROWSER_ARTIFACTS.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
const html = await readFile(new URL('../../ops/dashboard.html', import.meta.url), 'utf8')
assert.ok(html.includes('function reviewBooking('), 'Build current dashboard artifacts before acceptance')
const origin = 'https://atrium.test'
const artifacts = resolve(process.env.ATRIUM_BROWSER_ARTIFACTS || '/tmp/atrium-booking-review-browser')
await mkdir(artifacts, { recursive: true })
const at = new Date().toISOString(), checkedAt = new Date(Date.now() + 1000).toISOString()
const startsAt = new Date(Date.now() + 86400000).toISOString().slice(0, 16) + ':00.000Z'
const attempt = { externalId: 'booking-synthetic', slotId: 'slot-' + startsAt.slice(0, 16), startsAt,
  endsAt: new Date(Date.parse(startsAt) + 1800000).toISOString(), unitId: '19A' }
const scope = { organizationId: 'org-synthetic', propertyId: 'building-synthetic', configurationVersion: 1, permissionVersion: 'synthetic-one' }
const property = { ...scope, buildingName: 'The Larkin · Synthetic QA', timeZone: 'America/New_York', permissions: ['read', 'operate'], hours: {} }
const review = { id: 'booking-review:call-synthetic', version: 1, callId: 'call-synthetic', kind: 'booking_review', durable: true,
  needsReview: true, at, updatedAt: at, sourceRevision: 4, phone: 'unknown', name: 'Dana Sample', email: 'dana@example.test',
  callbackPhone: null, notificationStatus: 'not_sent', booking: { ...attempt, status: 'arranging' } }
const saved = (outcome = 'confirmed', projection = 'complete') => ({ ...review, needsReview: false, updatedAt: checkedAt,
  resolution: { requestId: 'canonical-synthetic-request', callId: review.callId, sourceRevision: 4, actorId: 'synthetic-operator', checkedAt,
    attempt, outcome, booking: outcome === 'confirmed' ? { ...attempt, revision: 0 } : null, projection } })
const response = bookingReview => ({ scope, timeZone: property.timeZone, bookingReview,
  status: bookingReview.resolution.projection === 'pending' ? 'pending_projection' : 'complete', notificationSent: false })
const errors = [], unexpected = [], checks = [], screenshots = []
let browser

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  for (const width of [320, 390, 1280]) {
    for (const scenario of ['unknown-retry', 'not-booked', 'pending-projection', 'conflict', 'malformed', 'viewer']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' })
      const bootstrap = { ...property, permissions: scenario === 'viewer' ? ['read'] : property.permissions }
      await context.addInitScript(({ bootstrap }) => {
        window.ATRIUM_RUNTIME_MODE = 'postgres'
        window.ATRIUM_PROPERTY = bootstrap
        window.ATRIUM_ACCOUNT = { username: 'synthetic-operator', displayName: 'Synthetic Operator', userId: 'synthetic-user' }
      }, { bootstrap })
      let current = structuredClone(review), releaseFirst = null, firstStarted
      const firstRequestReady = new Promise(resolve => { firstStarted = resolve })
      if (scenario === 'malformed') { current = saved(); current.resolution.attempt = { ...attempt, unitId: '20B' } }
      const posts = []
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url())
        if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
        if (request.method() === 'POST' && url.pathname === '/api/calendar') {
          const payload = request.postDataJSON()
          posts.push(payload)
          if (payload.action !== 'booking_review') { unexpected.push({ width, scenario, method: request.method(), path: url.pathname, action: payload.action }); return route.fulfill({ status: 405, body: '' }) }
          assert.equal(payload.callId, review.callId); assert.equal(payload.sourceRevision, 4)
          assert.equal(payload.expectedTimeZone, property.timeZone)
          const headers = request.headers()
          assert.equal(headers['x-atrium-property-id'], scope.propertyId)
          assert.equal(headers['x-atrium-organization-id'], scope.organizationId)
          if (scenario === 'unknown-retry' && posts.length === 1) {
            await new Promise(resolve => { releaseFirst = resolve; firstStarted() })
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scope, timeZone: property.timeZone }) })
          }
          if (scenario === 'conflict') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'booking_review_revision_conflict', error: 'Synthetic revision changed' }) })
          current = saved(scenario === 'not-booked' ? 'not_booked' : 'confirmed', scenario === 'pending-projection' && posts.length === 1 ? 'pending' : 'complete')
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response(current)) })
        }
        if (request.method() !== 'GET') { unexpected.push({ width, scenario, method: request.method(), path: url.pathname }); return route.fulfill({ status: 405, body: '' }) }
        if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html })
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' })
        let data
        if (url.pathname === '/api/vapi') data = { scope, calls: [{ id: review.callId, startedAt: at, customerNumber: null, durationSeconds: 45,
          toolCalls: [{ name: 'book_tour', arguments: { slotId: attempt.slotId, unitId: attempt.unitId }, result: "I'm getting that booked." }], transcript: '' }], events: [current], callsConfigured: true }
        else if (url.pathname === '/api/leads') data = { scope, profiles: [], followUps: [], tourChangeRequests: [], outboundEnabled: false, store: { kind: 'postgres', durable: true } }
        else if (url.pathname === '/api/calendar') data = { scope, timeZone: property.timeZone, slots: [], bookings: [], blocks: [], units: [], unitBlocks: [],
          range: { from: url.searchParams.get('from'), to: url.searchParams.get('to') }, store: { kind: 'postgres', durable: true } }
        else if (url.pathname === '/api/health') data = { ok: true, store: 'postgres', durable: true, callHistory: true }
        else { unexpected.push({ width, scenario, method: request.method(), path: url.pathname }); return route.fulfill({ status: 404, body: '' }) }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
      })
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', error => errors.push({ width, scenario, type: 'pageerror', message: error.message }))
      page.on('console', message => {
        // Chromium reports the deliberately intercepted conflict as a console HTTP error.
        if (message.type() === 'error' && !(scenario === 'conflict' && /409/.test(message.text()))) errors.push({ width, scenario, type: 'console', message: message.text() })
      })
      const noOverflow = async label => {
        const measurement = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
        assert.ok(measurement.scrollWidth <= measurement.width, `${label} at ${width}: ${JSON.stringify(measurement)}`)
      }
      const screenshot = async name => {
        const path = resolve(artifacts, `${name}-${width}.png`)
        if (!/retry|projection/.test(name)) await page.evaluate(() => scrollTo(0, 0))
        await page.screenshot({ path, fullPage: !/retry|projection/.test(name) }); screenshots.push(path)
      }
      await page.goto(`${origin}/#/calls?id=${review.callId}`)
      const panel = page.locator('.call-panel')
      await panel.getByRole('heading', { name: 'Tour booking needs verification', exact: true }).waitFor()
      await noOverflow('Unresolved review')
      const check = panel.getByRole('button', { name: 'Check reservation', exact: true })
      if (scenario === 'viewer' || scenario === 'malformed') {
        assert.equal(await check.count(), 0)
        assert.doesNotMatch(await panel.innerText(), /Reservation verified|No reservation found/)
        assert.equal(posts.length, 0)
        checks.push(`${width}: ${scenario} stays unverified and cannot invoke a write`)
        await context.close(); continue
      }
      await check.focus(); await check.press('Enter')
      let dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /does not create another reservation or send a notification/)
      await noOverflow('Review dialog')
      if (scenario === 'unknown-retry') {
        await dialog.press('Escape')
        await page.waitForFunction(() => document.activeElement?.dataset.action === 'review-booking')
        assert.equal(posts.length, 0)
        await check.press('Enter'); dialog = page.getByRole('dialog')
        const submit = dialog.getByRole('button', { name: 'Check reservation', exact: true })
        await submit.press('Enter')
        await page.waitForFunction(() => document.querySelector('.dlg-primary')?.getAttribute('aria-busy') === 'true')
        await firstRequestReady
        await dialog.locator('.dlg-primary').dispatchEvent('click')
        await dialog.press('Escape')
        assert.equal(await dialog.count(), 1)
        assert.equal(posts.length, 1)
        assert.ok(releaseFirst); releaseFirst()
        const retry = dialog.getByRole('button', { name: 'Retry verification', exact: true })
        await retry.waitFor()
        assert.match(await dialog.locator('[role="alert"]').innerText(), /may have been recorded/)
        await noOverflow('Uncertain retry dialog')
        await screenshot('uncertain-retry')
        await retry.press('Enter')
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(posts.length, 2)
        assert.deepEqual(posts[0], posts[1])
        checks.push(`${width}: keyboard dialog, focus return, busy duplicate protection and identical unknown-safe retry`)
      } else {
        await dialog.getByRole('button', { name: 'Check reservation', exact: true }).click()
        if (scenario === 'conflict') {
          const refresh = dialog.getByRole('button', { name: 'Close and refresh', exact: true })
          await refresh.waitFor()
          assert.match(await dialog.locator('[role="alert"]').innerText(), /No booking outcome is confirmed/)
          await refresh.press('Enter')
          assert.equal(posts.length, 1)
          checks.push(`${width}: stale conflict performs a read refresh without another mutation`)
          await context.close(); continue
        }
        if (scenario === 'pending-projection') {
          const retry = dialog.getByRole('button', { name: 'Retry verification', exact: true })
          await retry.waitFor()
          await panel.getByRole('heading', { name: 'Review updates are still pending', exact: true }).waitFor()
          assert.match(await dialog.locator('[role="alert"]').innerText(), /review updates are still pending/)
          assert.equal(await panel.getByRole('button', { name: 'Finish review', exact: true }).count(), 1)
          await screenshot('pending-projection')
          await retry.press('Enter')
          await dialog.waitFor({ state: 'hidden' })
          assert.equal(posts.at(-1).requestId, 'canonical-synthetic-request')
          checks.push(`${width}: pending projection remains actionable and resumes canonical receipt`)
        }
        await dialog.waitFor({ state: 'hidden' })
      }
      const title = scenario === 'not-booked' ? 'No reservation found' : 'Reservation verified'
      await panel.getByRole('heading', { name: title, exact: true }).waitFor()
      assert.match(await panel.innerText(), /Checked .*This records the result at that time/)
      assert.match(await panel.innerText(), /No notification was sent by this review/)
      assert.doesNotMatch(await panel.innerText(), /is arranging a tour|isn't confirmed yet|This booking has not been verified/)
      assert.equal(await panel.locator('[data-action="review-booking"]').count(), 0)
      assert.equal(await page.evaluate(() => document.activeElement === document.body), false)
      await noOverflow('Completed historical review')
      if (scenario === 'not-booked' || scenario === 'unknown-retry') await screenshot(scenario === 'not-booked' ? 'review-absent' : 'review-confirmed')
      await page.goto(`${origin}/#/today`)
      await page.waitForFunction(callId => window.Atrium?.state.loaded.calls && !window.Atrium.derive.needsPerson(window.Atrium.state).some(item => item.callId === callId), review.callId)
      assert.equal(await page.locator(`[data-key="np:${review.callId}"]`).count(), 0)
      checks.push(`${width}: ${scenario} shows truthful checked-at result and removes only completed booking work`)
      await context.close()
    }
  }
  assert.deepEqual(unexpected, [], 'All network requests must be synthetic approved fixtures')
  assert.deepEqual(errors, [], 'No unexpected browser errors')
  const result = { generatedHtmlSha256: createHash('sha256').update(html).digest('hex'), checks, errors, unexpected, screenshots,
    limitation: 'Synthetic intercepted browser fixtures only; not authentication, live provider delivery or production acceptance.' }
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser?.close() }
