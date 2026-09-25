/** Actual HTTP/PG/MFA and Chromium; provider effects stay on a synthetic loopback server. */
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {createVoiceReleaseFixture} from '../helpers/voice-release-fixture.mjs'
import {buildAuthClient} from '../../scripts/build-auth.mjs'
const {chromium}=await import(process.env.ATRIUM_PLAYWRIGHT_MODULE?pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href:'playwright')
await buildAuthClient()
let f,browser
const errors=[],checks=[],artifacts=process.env.ATRIUM_BROWSER_ARTIFACTS
if(artifacts)await mkdir(artifacts,{recursive:true})
try {
  f=await createVoiceReleaseFixture()
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  const [name,value]=f.cookies['owner-a'].split('=');await context.addCookies([{name,value,url:f.origin,httpOnly:true,sameSite:'Lax'}])
  let lose=false
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url())
    if(url.origin!==f.origin){await route.fulfill({status:204,body:''});return}
    if(lose&&url.pathname==='/api/vapi-sync'&&req.method()==='POST'&&req.postDataJSON()?.action==='publish'){
      lose=false;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();await route.abort('connectionreset');return
    }
    await route.continue()
  })
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message))
  const url=f.origin+'/api/dashboard?organizationId=organization-a&propertyId=property-a1#/status'
  const dialog=()=>page.getByRole('dialog',{name:'Property phone assistant',exact:true})
  const writes=()=>f.voiceRequests.filter(r=>r.method==='PATCH').length
  async function open(){await page.goto(url);await page.getByRole('button',{name:'Review phone assistant',exact:true}).press('Enter');await dialog().getByRole('button',{name:'Prepare review',exact:true}).waitFor()}
  async function prepare(){await dialog().getByRole('button',{name:'Prepare review',exact:true}).click();await dialog().getByText('Ready for review',{exact:true}).waitFor()}
  for(const width of [320,390,1280]){
    await f.reset();await page.setViewportSize({width,height:900});await open();await prepare()
    const d=dialog();assert.equal(await d.getByRole('button',{name:'Publish reviewed release',exact:true}).isDisabled(),true)
    assert.match(await d.innerText(),/property’s approved knowledge in Atrium/)
    assert.match(await d.innerText(),/detaches earlier provider knowledge attachments/)
    assert.doesNotMatch(await d.innerText(),/synthetic-other-property-file/)
    await d.locator('summary').filter({hasText:'Opening message and leasing script'}).click()
    assert.match(await d.innerText(),/America\/New_York/);assert.doesNotMatch(await d.innerText(),/The Larkin/)
    assert.ok(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    if(artifacts&&width!==390)await page.screenshot({path:artifacts+'/voice-review-'+width+'.png',fullPage:true})
    await d.locator('[data-reviewed]').check();await d.getByRole('button',{name:'Publish reviewed release',exact:true}).press('Enter')
    await d.getByText('Saved configuration verified',{exact:true}).first().waitFor();assert.equal(writes(),1)
    assert.equal(Object.hasOwn(f.saved.get('synthetic-release-assistant-a').model,'knowledgeBase'),false)
    await d.locator('.dlg-secondary').click();checks.push(width+'px keyboard review, protected publish, exact saved result and no horizontal overflow')
  }
  await f.reset();await open();await prepare();await dialog().locator('[data-reviewed]').check();lose=true
  await dialog().getByRole('button',{name:'Publish reviewed release',exact:true}).click()
  await dialog().getByRole('button',{name:'Check saved result',exact:true}).waitFor();assert.equal(writes(),1)
  await dialog().getByRole('button',{name:'Check saved result',exact:true}).click()
  await dialog().getByText('Saved configuration verified',{exact:true}).first().waitFor();assert.equal(writes(),1)
  await dialog().locator('.dlg-secondary').click();checks.push('lost committed HTTP reply recovers without another provider write')
  await f.reset();await open();await prepare();f.voiceFlags.wrongRoute=true
  await dialog().locator('[data-reviewed]').check();await dialog().getByRole('button',{name:'Publish reviewed release',exact:true}).click()
  await dialog().getByText('Update unconfirmed',{exact:true}).first().waitFor()
  assert.equal(await dialog().locator('[data-new-review]').count(),0)
  await dialog().locator('.dlg-secondary').click();await page.getByRole('button',{name:'Review phone assistant',exact:true}).click()
  await dialog().getByRole('button',{name:'Check provider result',exact:true}).waitFor()
  await dialog().getByRole('button',{name:'Check provider result',exact:true}).click();assert.equal(writes(),1)
  await dialog().locator('.dlg-secondary').click();checks.push('reopening discovers unresolved release and offers verification instead of new publication')
  await f.reset();await open();await prepare();f.voiceFlags.wrongKnowledge=true
  await dialog().locator('[data-reviewed]').check();await dialog().getByRole('button',{name:'Publish reviewed release',exact:true}).click()
  await dialog().getByText('Update unconfirmed',{exact:true}).first().waitFor()
  assert.equal(await dialog().getByText('Saved configuration verified',{exact:true}).count(),0)
  await dialog().getByRole('button',{name:'Check provider result',exact:true}).click();assert.equal(writes(),1)
  await dialog().locator('.dlg-secondary').click();checks.push('retained foreign property knowledge stays visibly unconfirmed without a second write')
  await f.reset();await open();await prepare()
  await dialog().locator('[data-cancel-review]').click();await dialog().getByText('Review cancelled',{exact:true}).first().waitFor();assert.equal(writes(),0)
  await dialog().locator('.dlg-secondary').click();checks.push('unsubmitted review cancellation saves history without a provider write')
  await f.reset();await open();await prepare();f.saved.get('synthetic-release-assistant-a').model.temperature=0.6
  await dialog().locator('[data-reviewed]').check();await dialog().getByRole('button',{name:'Publish reviewed release',exact:true}).click()
  await dialog().getByRole('button',{name:'Reload releases',exact:true}).waitFor();assert.equal(writes(),0)
  await dialog().locator('[data-new-review]').click();await dialog().getByRole('button',{name:'Reload releases',exact:true}).click()
  await dialog().getByRole('button',{name:'Prepare review',exact:true}).click();await dialog().getByText('Ready for review',{exact:true}).waitFor()
  assert.equal(await dialog().getByRole('button',{name:'Publish reviewed release',exact:true}).isDisabled(),true)
  await dialog().locator('.dlg-secondary').click();checks.push('provider edit refuses the stale release and requires a newly checked review')
  await f.reset();await open();await prepare()
  let releaseSlow,finishSlow
  const gate=new Promise(resolve=>releaseSlow=resolve),finished=new Promise(resolve=>finishSlow=resolve)
  await page.route('**/api/vapi-sync',async route=>{
    if(route.request().method()!=='POST'||route.request().postDataJSON()?.action!=='publish'){await route.fallback();return}
    await gate
    try{const response=await route.fetch();await route.fulfill({response});await response.dispose()}finally{finishSlow()}
  })
  await dialog().locator('[data-reviewed]').check();await dialog().getByRole('button',{name:'Publish reviewed release',exact:true}).click()
  await dialog().getByRole('button',{name:'Check saved result',exact:true}).waitFor({timeout:20000});assert.equal(writes(),0)
  await dialog().getByRole('button',{name:'Check saved result',exact:true}).click()
  await dialog().getByRole('button',{name:'Check saved result',exact:true}).waitFor();assert.equal(writes(),0)
  releaseSlow();await finished
  await dialog().getByRole('button',{name:'Check saved result',exact:true}).click()
  await dialog().getByText('Saved configuration verified',{exact:true}).first().waitFor();assert.equal(writes(),1)
  await page.evaluate(()=>window.Atrium.navigate('today'));await dialog().waitFor({state:'detached'})
  checks.push('actual 15-second timeout keeps the pending command, recovers the later result once and retires on navigation')
  assert.deepEqual(errors,[]);assert.deepEqual(f.errors,[])
  console.log(JSON.stringify({checks,realProviderRequests:0,browserErrors:errors},null,2))
}finally{await browser?.close();await f?.close()}
