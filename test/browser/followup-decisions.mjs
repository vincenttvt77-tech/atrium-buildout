/** Actual Chrome + HTTP + PostgreSQL, synthetic records and no external providers. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createFollowUpDecisionsFixture } from '../helpers/followup-decisions-fixture.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'
const {chromium}=await import(process.env.ATRIUM_PLAYWRIGHT_MODULE?pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href:'playwright')
await buildAuthClient()
let f,browser,page
const originalFetch=globalThis.fetch,errors=[],checks=[],commands=[],artifacts=process.env.ATRIUM_BROWSER_ARTIFACTS
if(artifacts)await mkdir(artifacts,{recursive:true})
try {
  f=await createFollowUpDecisionsFixture()
  globalThis.fetch=async()=>{throw new Error('External services disabled in follow-up browser test')}
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  const [name,value]=f.cookies['owner-a'].split('=');await context.addCookies([{name,value,url:f.origin,httpOnly:true,sameSite:'Lax'}])
  let dropReply=false
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url())
    if(url.origin!==f.origin){await route.fulfill({status:204,body:''});return}
    if(url.pathname==='/api/leads'&&req.method()==='POST'){
      commands.push(req.postDataJSON())
      if(dropReply){dropReply=false;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();await route.abort('connectionreset');return}
    }
    await route.continue()
  })
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
  const dashboard=`${f.origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1`
  async function load(route='leads') {
    await page.goto(dashboard+'#/'+route);await page.reload()
    await page.waitForFunction(()=>{const s=window.Atrium?.state;return s&&['calendar','leads','calls'].every(k=>s.loaded[k]&&!s.errors[k])})
  }
  const row=()=>page.locator('.view:not([hidden]) [data-key="fu:'+f.row.id+'"]')
  const dialog=()=>page.getByRole('dialog',{name:'Update follow-up',exact:true})
  async function open(button='Done') {await row().getByRole('button',{name:button,exact:true}).press('Enter');await dialog().waitFor();return dialog()}
  async function close(){await dialog().locator('.dlg-secondary').click()}
  for(const width of [320,390,1280]) {
    await f.reset();if(width===390)await f.save({...f.row,dueAt:new Date(Date.now()+7*86400000).toISOString()});await page.setViewportSize({width,height:900});await load()
    const d=await open();assert.match(await d.innerText(),/does not place a call/)
    assert.ok(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    if(artifacts&&width!==390)await page.screenshot({path:`${artifacts}/followup-decision-${width}.png`,fullPage:true})
    await d.getByRole('button',{name:'Mark handled',exact:true}).press('Enter')
    await d.getByText('Your decision is saved.',{exact:false}).waitFor();assert.match(await d.innerText(),/Staff decisions/)
    assert.equal((await f.raw()).staffDecisions.length,1);await close()
    await page.locator('#toasts .toast-close').first().click()
    await page.locator('.view:not([hidden]) .done-list summary').first().click()
    await row().getByText('Last recorded by',{exact:false}).waitFor()
    await open('Put back');await dialog().getByRole('button',{name:'Put back',exact:true}).click()
    await dialog().getByText('Current status: Open.',{exact:false}).waitFor();await close()
    assert.equal((await f.raw()).staffDecisions.length,2)
    checks.push(`${width}px: real completion, visible actor/history, keyboard, safe reopen and no overflow`)
  }
  await f.reset();await load('today')
  await page.locator('.view:not([hidden]) [data-action="handled"]').first().click()
  await dialog().getByRole('button',{name:'Mark handled',exact:true}).click();await dialog().getByText('Your decision is saved.',{exact:false}).waitFor();await close()
  assert.equal((await f.request({user:'staff-a',body:f.command(await f.current(),'skipped')})).status,200)
  await page.getByRole('button',{name:'Undo',exact:true}).click()
  await dialog().getByRole('button',{name:'Put back',exact:true}).click()
  await dialog().getByRole('button',{name:'Reload follow-up',exact:true}).waitFor()
  assert.equal((await f.raw()).status,'skipped');assert.equal((await f.raw()).staffDecisions.length,2)
  await dialog().locator('.dlg-primary').click();await dialog().getByText('Not needed',{exact:true}).first().waitFor();await close()
  checks.push('Today completion and stale Undo preserve another staff member’s newer decision')

  await f.reset();await load();await open();dropReply=true;commands.length=0
  await dialog().getByRole('button',{name:'Mark handled',exact:true}).click()
  await dialog().getByRole('button',{name:'Check saved decision',exact:true}).waitFor()
  assert.match(await dialog().innerText(),/may already be saved/);assert.doesNotMatch(await dialog().innerText(),/Nothing changed/)
  assert.equal((await f.request({user:'staff-a',body:f.command(await f.current(),'skipped')})).status,200)
  await dialog().locator('.dlg-primary').click();await dialog().getByText('A newer change is also on record; it has been preserved.',{exact:false}).waitFor()
  assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);assert.equal((await f.raw()).staffDecisions.length,2);await close()
  checks.push('lost committed reply recovers exactly and displays newer current state without overwriting it')

  await f.reset();await load();await open();await f.save({...await f.raw(),reason:'New callback instructions'})
  await dialog().getByRole('button',{name:'Mark handled',exact:true}).click()
  await dialog().getByRole('button',{name:'Reload follow-up',exact:true}).click()
  await dialog().getByText('New callback instructions',{exact:true}).waitFor()
  assert.equal((await f.raw()).staffDecisions,undefined);await close()
  checks.push('changed caller context requires fresh review before saving')

  await f.reset();await load();await open()
  let releaseSlow,finishedSlow
  const slowGate=new Promise(r=>releaseSlow=r),slowDone=new Promise(r=>finishedSlow=r)
  await page.route('**/api/leads',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return}
    const response=await route.fetch();assert.equal(response.status(),200);await slowGate
    await route.fulfill({response});await response.dispose();finishedSlow()
  })
  await dialog().getByRole('button',{name:'Mark handled',exact:true}).click()
  await dialog().getByRole('button',{name:'Check saved decision',exact:true}).waitFor({timeout:20000})
  assert.match(await dialog().innerText(),/has not responded yet/)
  releaseSlow();await slowDone;await page.unroute('**/api/leads')
  await dialog().locator('.dlg-primary').click();await dialog().getByText('Your decision is saved.',{exact:false}).waitFor()
  assert.equal((await f.raw()).staffDecisions.length,1);await close();checks.push('real 15-second timeout keeps the exact recoverable command')

  await f.reset();await load();await open()
  let release,started,finished;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r),done=new Promise(r=>finished=r)
  await page.route('**/api/leads',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return}
    const response=await route.fetch();assert.equal(response.status(),200);started();await gate
    await route.fulfill({response});await response.dispose();finished()
  })
  await dialog().getByRole('button',{name:'Mark handled',exact:true}).click();await began
  await page.evaluate(()=>window.Atrium.navigate('calendar'));await dialog().waitFor({state:'hidden'})
  release();await done;await page.unroute('**/api/leads')
  assert.equal(await dialog().count(),0);assert.equal((await f.raw()).staffDecisions.length,1)
  checks.push('navigation retires the form; delayed saved reply cannot reopen it')
  assert.deepEqual(errors,[]);assert.equal(f.requests.length,0)
  console.log(JSON.stringify({status:'passed',checks,realProviderCalls:0},null,2))
}catch(error){
  if(page){try{console.error('Browser failure state',await page.evaluate(()=>({route:location.hash,dialogs:document.querySelectorAll('[role=dialog]').length,active:document.activeElement?.outerHTML,completed:[...document.querySelectorAll('.done-list')].map(el=>({open:el.open,text:el.textContent.slice(0,500)}))})));if(artifacts)await page.screenshot({path:artifacts+'/failure.png',fullPage:true,timeout:5000})}catch{}}
  throw error
}finally{globalThis.fetch=originalFetch;await browser?.close();await f?.close()}
