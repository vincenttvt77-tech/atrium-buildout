import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { callbackFixture } from '../helpers/callback-fixture.mjs'
const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
const f = await callbackFixture(), errors = [], checks = []
let browser
try {
  browser = await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:390,height:900},reducedMotion:'reduce'})
  let loseResponse=false
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin===f.binding.origin){
      const response=await f.originalFetch(f.origin+url.pathname+url.search,{method:request.method(),headers:{...request.headers(),host:new URL(f.origin).host,origin:f.binding.origin},...(request.postData()?{body:request.postData()}:{})})
      const body=Buffer.from(await response.arrayBuffer())
      if(loseResponse&&request.postData()?.includes('"action":"request"')){loseResponse=false;await route.abort('failed');return}
      const headers=Object.fromEntries(response.headers);for(const h of ['transfer-encoding','connection','content-length'])delete headers[h]
      await route.fulfill({status:response.status,headers,body});return
    }
    if(url.origin==='https://challenges.cloudflare.com'){
      await route.fulfill({contentType:'text/javascript',body:"window.turnstile={render(el,options){el.textContent='Synthetic verification passed';setTimeout(()=>options.callback('synthetic-challenge'),0);return 'synthetic-widget'},reset(){}}"});return
    }
    if(url.origin===f.origin){await route.continue();return}
    await route.fulfill({status:204,body:''})
  })
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000)
  await page.goto(f.binding.origin)
  await page.getByRole('button',{name:'Call me',exact:true}).waitFor()
  for(const width of [320,390,768,1280]){
    await page.setViewportSize({width,height:900});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`visitor form fits ${width}`)
  }
  checks.push('Visitor form fits 320/390/768/1280 widths')
  if(process.env.ATRIUM_BROWSER_ARTIFACTS){await mkdir(process.env.ATRIUM_BROWSER_ARTIFACTS,{recursive:true});await page.screenshot({path:process.env.ATRIUM_BROWSER_ARTIFACTS+'/callback-form.png',fullPage:true})}
  await page.setViewportSize({width:390,height:900})
  await page.getByLabel('Your name',{exact:true}).fill('Browser Visitor')
  await page.getByLabel('Phone number',{exact:true}).fill('2125550123')
  await page.getByRole('button',{name:'Call me',exact:true}).click()
  assert.equal(f.state.posts,0,'unchecked permission prevents a call')
  const consent=page.getByRole('checkbox');await consent.focus();await page.keyboard.press('Space');assert.equal(await consent.isChecked(),true)
  await page.getByRole('button',{name:'Call me',exact:true}).focus();await page.keyboard.press('Enter')
  await page.getByText('The calling service has queued your call.',{exact:false}).waitFor()
  assert.equal(f.state.posts,1);checks.push('Keyboard consent and submission initiate exactly one synthetic call')
  await page.reload();await page.getByRole('button',{name:'Check this request',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Call me',exact:true}).count(),0)
  assert.equal(f.state.posts,1);checks.push('Reload preserves the receipt and cannot redial')
  await context.addCookies([{name:f.cookies['staff-a'].split('=')[0],value:f.cookies['staff-a'].slice(f.cookies['staff-a'].indexOf('=')+1),url:f.origin}])
  const staff=await context.newPage();staff.on('pageerror',e=>errors.push(e.message));staff.setDefaultTimeout(15000)
  await staff.goto(f.origin+'/api/dashboard?organizationId=organization-a&propertyId=property-a1#/workflows')
  const queue=staff.locator('.wq-view');await queue.waitFor({state:'visible'})
  await queue.getByRole('button',{name:'All work',exact:true}).click()
  await queue.getByRole('heading',{name:'Browser Visitor',exact:true}).waitFor()
  const call=[...f.state.effects.values()][0];call.status='ringing'
  await f.db.admin.query("DELETE FROM atrium.operational_documents WHERE key LIKE 'callback-observation:%'")
  await queue.getByRole('button',{name:'Check call status',exact:true}).click()
  await queue.getByLabel('Selected action',{exact:true}).getByText('The calling service reports that the prospect’s phone is ringing.',{exact:true}).waitFor()
  assert.equal(f.state.posts,1);checks.push('Staff sees the visitor and verifies ringing without another call')
  for(const width of [320,390,768,1280]){
    await staff.setViewportSize({width,height:900});await staff.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    assert.ok(await staff.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`staff callback fits ${width}`)
  }
  checks.push('Staff callback detail fits all four widths')
  const artifacts=process.env.ATRIUM_BROWSER_ARTIFACTS
  if(artifacts){await mkdir(artifacts,{recursive:true});await page.screenshot({path:artifacts+'/callback-mobile.png',fullPage:true});await staff.screenshot({path:artifacts+'/callback-staff.png',fullPage:true})}
  // New isolated browser receipt/number; drop the HTTP response only after the
  // actual handler has persisted and the synthetic provider accepted its call.
  await page.evaluate(()=>sessionStorage.clear());await page.reload()
  await page.getByLabel('Your name',{exact:true}).fill('Response Lost');await page.getByLabel('Phone number',{exact:true}).fill('2125550124')
  await page.getByRole('checkbox').check();loseResponse=true;await page.getByRole('button',{name:'Call me',exact:true}).click()
  await page.getByText('Your request may have been saved.',{exact:false}).waitFor();assert.equal(f.state.posts,2)
  await page.getByRole('button',{name:'Check this request',exact:true}).click();await page.getByText('The calling service has queued your call.',{exact:false}).waitFor()
  await page.reload();await page.getByRole('button',{name:'Check this request',exact:true}).waitFor();assert.equal(f.state.posts,2)
  checks.push('Lost HTTP acknowledgement recovers the saved receipt, including reload, with zero duplicate calls')
  assert.deepEqual(errors,[]);assert.deepEqual(f.state.errors,[])
  console.log(JSON.stringify({passed:checks.length,checks,syntheticCalls:f.state.posts,realCalls:0},null,2))
}finally{await browser?.close();await f.close()}
