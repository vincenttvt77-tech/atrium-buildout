/** Real Chrome, scoped HTTP handlers and temporary PostgreSQL. No live provider. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createCancellationEmailFixture } from '../helpers/cancellation-email-fixture.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'
const {chromium}=await import(process.env.ATRIUM_PLAYWRIGHT_MODULE?pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href:'playwright')
await buildAuthClient()
let f,browser,page
const originalFetch=globalThis.fetch,checks=[],errors=[]
const artifacts=process.env.ATRIUM_BROWSER_ARTIFACTS
if(artifacts)await mkdir(artifacts,{recursive:true})
try {
  f=await createCancellationEmailFixture()
  globalThis.fetch=async()=>{throw new Error('External services disabled in synthetic browser fixture')}
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  const [name,value]=f.cookies['owner-a'].split('=');await context.addCookies([{name,value,url:f.origin,httpOnly:true,sameSite:'Lax'}])
  let dropReply=null
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin!==f.origin){await route.fulfill({status:204,body:''});return}
    if(dropReply&&url.pathname==='/api/tour-cancellation-emails'&&request.method()==='POST'&&request.postDataJSON().action===dropReply){
      dropReply=null;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();await route.abort('connectionreset');return
    }
    await route.continue()
  })
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
  const calendarUrl=`${f.origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1#/calendar?date=${f.booking.startsAt.slice(0,10)}`
  async function load(){await page.goto(calendarUrl);await page.reload();await page.waitForFunction(()=>{const s=window.Atrium?.state;return s&&['calendar','leads','calls'].every(k=>s.loaded[k]&&!s.errors[k])})}
  async function open(){
    await page.getByRole('button',{name:'Cancellations',exact:true}).click()
    await page.getByRole('dialog',{name:'Recent cancellations',exact:true}).locator('[data-cancel-history]').click()
    await page.getByRole('button',{name:'Review cancellation email',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'Cancellation email',exact:true});await dialog.locator('.tour-email-preview').waitFor();return dialog
  }
  async function send(dialog){await dialog.getByLabel('The prospect agreed',{exact:false}).press('Space');await dialog.locator('.dlg-primary').press('Enter')}
  for(const width of [320,390,1280]){
    await f.reset();await page.setViewportSize({width,height:900});await load();const dialog=await open()
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    assert.match(await dialog.innerText(),/visitor@example.test/);assert.doesNotMatch(await dialog.innerText(),/Internal staff reason/)
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    await send(dialog);await dialog.getByText('Delivery is not yet verified.',{exact:false}).waitFor()
    assert.equal(f.requests.filter(r=>r.method==='POST').length,1);await f.due()
    await dialog.getByRole('button',{name:'Check delivery',exact:true}).press('Enter')
    await dialog.getByText('The provider reports delivery of the cancellation email.',{exact:false}).waitFor()
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    if(artifacts&&width!==390)await page.screenshot({path:`${artifacts}/cancellation-email-${width}.png`,fullPage:true})
    await dialog.locator('.dlg-secondary').click();const reopened=await open()
    await reopened.getByText('The provider reports delivery of the cancellation email.',{exact:false}).waitFor()
    assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.equal((await f.calendar()).bookings.length,0)
    await reopened.locator('.dlg-secondary').click();checks.push(`${width}px: actual cancellation history, permission, one send, exact verified delivery, reopen and no overflow`)
  }
  await f.reset();f.flags.configured=false;await load();let dialog=await open()
  assert.match(await dialog.innerText(),/not configured/);assert.equal(await dialog.locator('[name="emailPermission"]').count(),0)
  assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true');await dialog.locator('.dlg-secondary').click()
  checks.push('unconfigured property shows a truthful disabled send')
  for(const action of ['queue','process']){
    await f.reset();await load();dialog=await open();dropReply=action;await send(dialog)
    await dialog.getByRole('button',{name:'Reload cancellation email',exact:true}).waitFor();await dialog.locator('.dlg-primary').click()
    if(action==='queue')await dialog.getByRole('button',{name:'Send saved cancellation email',exact:true}).waitFor()
    else await dialog.getByRole('button',{name:'Check delivery',exact:true}).waitFor()
    await f.due();await dialog.locator('.dlg-primary').click()
    if(action==='queue'){await dialog.getByText('Delivery is not yet verified.',{exact:false}).waitFor();await f.due();await dialog.locator('.dlg-primary').click()}
    await dialog.getByText('The provider reports delivery of the cancellation email.',{exact:false}).waitFor()
    assert.equal(f.requests.filter(r=>r.method==='POST').length,1);await dialog.locator('.dlg-secondary').click()
    checks.push(`lost ${action} reply: committed work recovered without repeated permission or duplicate send`)
  }
  await f.reset();await load();dialog=await open()
  let releaseSlow,finishedSlow
  const slowGate=new Promise(r=>releaseSlow=r),slowDone=new Promise(r=>finishedSlow=r)
  await page.route('**/api/tour-cancellation-emails',async route=>{
    const request=route.request()
    if(request.method()!=='POST'||request.postDataJSON().action!=='queue'){await route.continue();return}
    const response=await route.fetch();assert.equal(response.status(),200);await slowGate
    await route.fulfill({response});await response.dispose();finishedSlow()
  })
  await send(dialog);await dialog.getByRole('button',{name:'Reload cancellation email',exact:true}).waitFor({timeout:20000})
  assert.match(await dialog.innerText(),/has not responded yet/);assert.equal(f.requests.length,0)
  releaseSlow();await slowDone;await page.unroute('**/api/tour-cancellation-emails')
  await dialog.locator('.dlg-primary').click();await dialog.getByRole('button',{name:'Send saved cancellation email',exact:true}).waitFor()
  await dialog.locator('.dlg-primary').click();await dialog.getByText('Delivery is not yet verified.',{exact:false}).waitFor();await f.due()
  await dialog.locator('.dlg-primary').click();await dialog.getByText('The provider reports delivery of the cancellation email.',{exact:false}).waitFor()
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1);await dialog.locator('.dlg-secondary').click()
  checks.push('15-second request timeout exposes recovery; late saved reply cannot auto-send or duplicate the email')
  await f.reset();await load();dialog=await open();await send(dialog);await dialog.getByText('Delivery is not yet verified.',{exact:false}).waitFor();await dialog.locator('.dlg-secondary').click()
  const state=await f.calendar();state.cancelledBookings[0].booking.prospectEmail='updated@example.test';await f.saveCalendar(state)
  dialog=await open();assert.match(await dialog.innerText(),/Earlier email · visitor@example.test/)
  assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
  await dialog.getByRole('button',{name:'Review saved email',exact:true}).click();await page.waitForURL(url=>url.hash.startsWith('#/workflows?'))
  assert.equal(await page.getByRole('dialog',{name:'Cancellation email',exact:true}).count(),0)
  checks.push('changed recipient directs to exact earlier email rather than creating another send')
  await f.reset();await load()
  let release,started;const hold=new Promise(r=>release=r),began=new Promise(r=>started=r)
  await page.route('**/api/tour-cancellation-emails?*',async route=>{started();await hold;await route.continue()})
  await page.getByRole('button',{name:'Cancellations',exact:true}).click();await page.getByRole('dialog',{name:'Recent cancellations',exact:true}).locator('[data-cancel-history]').click()
  await page.getByRole('button',{name:'Review cancellation email',exact:true}).click();await began
  await page.evaluate(()=>window.Atrium.navigate('leads'));assert.equal(await page.getByRole('dialog',{name:'Cancellation email',exact:true}).count(),0)
  const response=page.waitForResponse(r=>r.url().includes('/api/tour-cancellation-emails?'));release();await response
  await page.unroute('**/api/tour-cancellation-emails?*');assert.equal(await page.getByRole('dialog',{name:'Cancellation email',exact:true}).count(),0)
  checks.push('route changes retire in-flight email previews')
  await f.reset();await load()
  await page.route('**/api/tour-cancellation-emails?*',async route=>{const response=await route.fetch(),body=await response.json();body.scope.propertyId='foreign-property';await route.fulfill({response,json:body});await response.dispose()})
  await page.getByRole('button',{name:'Cancellations',exact:true}).click();await page.getByRole('dialog',{name:'Recent cancellations',exact:true}).locator('[data-cancel-history]').click()
  await page.getByRole('button',{name:'Review cancellation email',exact:true}).click();await page.getByText('The property or your access changed.',{exact:false}).waitFor()
  assert.equal(await page.getByRole('dialog',{name:'Cancellation email',exact:true}).count(),0);assert.equal(await page.locator('.view:not([hidden])').count(),0)
  checks.push('foreign property response clears the dialog and cached workspace')
  assert.deepEqual(errors,[]);assert.deepEqual(f.errors,[])
  console.log(JSON.stringify({status:'passed',checks,realEmailsSent:0},null,2))
}catch(error){if(page){console.log((await page.locator('body').innerText()).slice(-6000));if(artifacts)await page.screenshot({path:artifacts+'/failure.png',fullPage:true})}throw error}
finally{globalThis.fetch=originalFetch;await browser?.close();await f?.close()}
