/** Real Chrome, scoped HTTP and temporary PostgreSQL; synthetic callers only. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createTourChangeResolutionFixture } from '../helpers/tour-change-resolution-fixture.mjs'
import { reviewTourChangeRequest } from '../../src/leads/tour-change.ts'
import { buildAuthClient } from '../../scripts/build-auth.mjs'
const {chromium}=await import(process.env.ATRIUM_PLAYWRIGHT_MODULE?pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href:'playwright')
await buildAuthClient()
let f,browser,page
const originalFetch=globalThis.fetch,checks=[],errors=[],artifacts=process.env.ATRIUM_BROWSER_ARTIFACTS
if(artifacts)await mkdir(artifacts,{recursive:true})
try {
  f=await createTourChangeResolutionFixture()
  globalThis.fetch=async()=>{throw new Error('External services disabled in synthetic browser fixture')}
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  const [name,value]=f.cookies['owner-a'].split('=');await context.addCookies([{name,value,url:f.origin,httpOnly:true,sameSite:'Lax'}])
  let dropReply=false
  const commands=[]
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin!==f.origin){await route.fulfill({status:204,body:''});return}
    if(url.pathname==='/api/tour-change-resolutions'&&request.method()==='POST'){
      commands.push(request.postDataJSON())
      if(dropReply){dropReply=false;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();await route.abort('connectionreset');return}
    }
    await route.continue()
  })
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
  const dashboard=`${f.origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1`
  async function load(route='today') {
    await page.goto(dashboard+'#/'+route);await page.reload()
    await page.waitForFunction(()=>{const s=window.Atrium?.state;return s&&['calendar','leads','calls'].every(k=>s.loaded[k]&&!s.errors[k])})
  }
  async function open() {
    await page.locator('.view:not([hidden]) [data-action="resolve-tour-change"]').first().click()
    const d=page.getByRole('dialog',{name:'Record tour-change outcome',exact:true});await d.locator('#tour-outcome').waitFor();return d
  }
  async function choose(d,outcome='no_change') {
    await d.locator('#tour-outcome').selectOption(outcome);await d.locator('#tour-outcome-note').fill('Verified the caller and selected the correct tour outcome')
    await d.locator('#tour-outcome-verified').press('Space');await d.locator('.dlg-primary').press('Enter')
  }
  for(const width of [320,390,1280]) {
    await f.reset();await f.cancel()
    const c=await f.context(),request=await c.documents.get(f.id)
    await reviewTourChangeRequest(c.documents,{id:f.id,expectedRevision:request.revision,at:new Date(),actorId:'owner-a',note:'Reviewing the caller request'})
    await page.setViewportSize({width,height:900});await load(width===390?'leads':'today')
    await page.locator('.view:not([hidden])').getByText('Reviewed · needs outcome',{exact:true}).waitFor()
    const card=page.locator('.view:not([hidden]) .tour-change-row').first()
    assert.ok(await card.locator('.row-body').evaluate(el=>el.getBoundingClientRect().width>200),'caller instructions must not collapse into the workbench icon column')
    assert.ok(await card.evaluate(el=>el.getBoundingClientRect().height<800),'request text remains readable without an excessively tall card')
    const d=await open();assert.equal(await d.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    await d.locator('#tour-outcome').selectOption('0');await d.locator('#tour-outcome-note').fill('Verified caller and cancelled reservation')
    assert.equal(await d.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    assert.match(await d.innerText(),/Cancellation saved/)
    assert.ok(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    if(artifacts&&width!==390)await page.screenshot({path:`${artifacts}/tour-outcome-${width}.png`,fullPage:true})
    await d.locator('#tour-outcome-verified').press('Space');await d.locator('.dlg-primary').press('Enter')
    await d.getByText('Outcome recorded. This request is closed.',{exact:false}).waitFor()
    await d.locator('.dlg-secondary').click()
    await page.waitForFunction(()=>window.Atrium.state.leads.tourChangeRequests[0]?.status==='resolved')
    assert.equal(await page.locator('.view:not([hidden]) [data-action="resolve-tour-change"]').count(),0)
    await page.evaluate(()=>window.Atrium.navigate('leads'))
    await page.locator('.view:not([hidden])').getByText('Recorded tour-change outcomes',{exact:true}).waitFor()
    assert.equal(f.requests.length,0);assert.equal((await f.calendar()).bookings.length,0)
    checks.push(`${width}px: reviewed request stays open, exact saved cancellation, required staff verification, keyboard save, closure/history and no overflow`)
  }
  await f.reset();await f.reschedule();await load();let d=await open();await choose(d,'0')
  await d.getByText('Outcome recorded. This request is closed.',{exact:false}).waitFor();assert.equal((await f.calendar()).bookings[0].revision,1)
  await d.locator('.dlg-secondary').click();checks.push('actual reschedule links to saved outcome without another calendar write')
  await f.reset();await load();d=await open();await choose(d)
  await d.getByText('Outcome recorded. This request is closed.',{exact:false}).waitFor();assert.equal((await f.calendar()).bookings.length,1)
  await d.locator('.dlg-secondary').click();checks.push('no-change closure records staff reason and preserves the existing tour')

  await f.reset();await load();d=await open();dropReply=true;commands.length=0;await choose(d)
  await d.getByRole('button',{name:'Check saved outcome',exact:true}).waitFor()
  assert.equal(await d.locator('#tour-outcome-note').isDisabled(),true)
  await f.evidence('Please cancel instead; these are new caller instructions.')
  await d.locator('.dlg-primary').click();await d.getByText('Newer caller details still need follow-up.',{exact:false}).waitFor()
  assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);await d.locator('.dlg-secondary').click()
  await page.locator('.view:not([hidden]) [data-action="resolve-tour-change"]').waitFor()
  checks.push('lost saved reply uses the identical frozen command; new caller instructions remain open with the previous decision retained')

  await f.reset();await f.cancel();await load();d=await open()
  const state=await f.calendar();state.cancelledBookings[0].booking.prospectPhone='+12025550999';await f.saveCalendar(state)
  await choose(d,'0');await d.getByRole('button',{name:'Reload request',exact:true}).waitFor()
  assert.match(await d.innerText(),/no longer current/);await d.locator('.dlg-primary').click()
  await d.locator('#tour-outcome:not([disabled])').waitFor();assert.equal(await d.locator('#tour-outcome').inputValue(),'')
  assert.equal(await d.locator('.dlg-primary').getAttribute('aria-disabled'),'true');await d.locator('.dlg-secondary').click()
  checks.push('changed saved evidence refuses closure and forces fresh review/attestation')

  await f.reset();await load();d=await open();commands.length=0
  let releaseSlow,finishedSlow
  const slowGate=new Promise(r=>releaseSlow=r),slowDone=new Promise(r=>finishedSlow=r)
  await page.route('**/api/tour-change-resolutions',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return}
    const response=await route.fetch();assert.equal(response.status(),200);await slowGate
    await route.fulfill({response});await response.dispose();finishedSlow()
  })
  await choose(d);await d.getByRole('button',{name:'Check saved outcome',exact:true}).waitFor({timeout:20000})
  assert.match(await d.innerText(),/has not responded yet/)
  releaseSlow();await slowDone;await page.unroute('**/api/tour-change-resolutions')
  await d.locator('.dlg-primary').click();await d.getByText('This request is closed.',{exact:false}).waitFor()
  assert.equal((await (await f.context()).documents.get(f.id)).resolutions.length,1)
  await d.locator('.dlg-secondary').click();checks.push('real 15-second timeout recovers the saved decision without duplication')

  await f.reset();await load()
  let release,started;const hold=new Promise(r=>release=r),began=new Promise(r=>started=r)
  await page.route('**/api/tour-change-resolutions?*',async route=>{started();await hold;await route.continue()})
  await page.locator('.view:not([hidden]) [data-action="resolve-tour-change"]').first().click();await began
  await page.evaluate(()=>window.Atrium.navigate('calendar'));assert.equal(await page.getByRole('dialog',{name:'Record tour-change outcome'}).count(),0)
  const response=page.waitForResponse(r=>r.url().includes('/api/tour-change-resolutions?'));release();await response
  await page.unroute('**/api/tour-change-resolutions?*');assert.equal(await page.getByRole('dialog',{name:'Record tour-change outcome'}).count(),0)
  checks.push('late read after navigation cannot reopen or populate the retired request')
  assert.deepEqual(errors,[]);assert.deepEqual(f.errors,[]);assert.equal(f.requests.length,0)
  console.log(JSON.stringify({ok:true,checks,realProviderCalls:0},null,2))
} finally {
  globalThis.fetch=originalFetch;await browser?.close();await f?.close()
}
