/** Actual Chromium + HTTP + disposable PostgreSQL. Synthetic accounts only; no delivery/provider transport. */
import assert from 'node:assert/strict'
import { mkdir, chmod } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createEnrollmentFixture } from '../helpers/resident-enrollment.mjs'
const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
const artifacts=process.env.ATRIUM_BROWSER_ARTIFACTS,checks=[],errors=[],network=[],pages=[]
let f,browser
if(artifacts)await mkdir(artifacts,{recursive:true,mode:0o700})
const pauseLayout=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
const syntheticPassword='Synthetic resident browser password 2026!'
try {
  f=await createEnrollmentFixture()
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  async function context(){
    const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
    await context.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.origin)return route.continue()
      network.push(new URL(route.request().url()).origin)
      return route.fulfill({status:204,body:''})
    })
    return context
  }
  async function pageIn(context){const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));pages.push(page);return page}
  async function sizes(page,name){
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});await pauseLayout(page);await page.evaluate(()=>{const active=[document.getElementById('access-task'),document.getElementById('resident-task')].find(node=>node&&!node.hidden);if(active)active.scrollIntoView({block:'start'});else scrollTo(0,0)});await pauseLayout(page)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name}: no overflow at ${width}`)
      const targets=await page.locator('button:visible,input:visible:not([type=checkbox]),.button:visible').evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName,height:n.getBoundingClientRect().height})))
      assert.ok(targets.every(t=>t.height>=44),`${name}: controls have at least 44px height`)
      if(artifacts){const file=`${artifacts}/${name}-${width}.png`;await page.screenshot({path:file,fullPage:false});await chmod(file,0o600)}
    }
  }
  const staffContext=await context();await staffContext.addCookies([...f.actors['owner-a'].jar].map(([name,value])=>({name,value,url:f.origin,sameSite:'Strict'})))
  const staff=await pageIn(staffContext)
  const staffUrl=id=>`${f.origin}/api/resident-access?organizationId=organization-a&propertyId=property-a1&residentId=${id}`
  async function openStaff(id){await staff.goto(staffUrl(id));await staff.getByText('Current resident access loaded.',{exact:true}).waitFor()}
  async function reviewIssue(){
    await staff.locator('[data-access="issue"]').click()
    await staff.locator('#access-checked-at').fill(new Date(Date.now()-60000).toISOString().slice(0,16))
    await staff.locator('#access-evidence').fill('Synthetic in-person check completed for browser test')
    await staff.locator('#access-checked').check()
    await staff.locator('#access-reason').fill('Synthetic recipient requested access')
    await staff.getByRole('button',{name:'Review change',exact:true}).click()
    await staff.locator('[data-access="confirm"]').waitFor()
  }
  const first=f.residents['property-a1'][0]
  await openStaff(first);await reviewIssue();await sizes(staff,'staff-invitation-review')
  await staff.locator('[data-access="confirm"]').press('Enter')
  await staff.locator('#access-private-url').waitFor()
  const invitationUrl=await staff.locator('#access-private-url').inputValue()
  assert.equal(new URL(invitationUrl).origin,f.origin);assert.match(new URL(invitationUrl).hash,/^#invite=/)
  assert.match(await staff.locator('#access-link').innerText(),/No message has been sent/)
  checks.push('Staff reviews exact recipient protocol, creates a private invitation with keyboard confirmation, and sees no delivery claim')

  const lostIssue=f.residents['property-a1'][1]
  await openStaff(lostIssue);await reviewIssue()
  let issuedPosts=0
  await staff.route('**/api/resident-access',async route=>{
    if(route.request().method()!=='POST')return route.fallback()
    issuedPosts++;const response=await route.fetch();assert.equal(response.status(),200)
    return route.fulfill({response,body:'{"unreadable":true}',headers:{...response.headers(),'content-type':'application/json'}})
  })
  await staff.locator('[data-access="confirm"]').click();await staff.locator('[data-access="check"]').waitFor()
  assert.match(await staff.locator('#access-recovery').innerText(),/may have been saved/)
  await staff.unroute('**/api/resident-access');await staff.locator('[data-access="check"]').click()
  await staff.getByText(/Saved change confirmed from its receipt/).waitFor()
  assert.equal(issuedPosts,1);assert.equal(await staff.locator('#access-private-url').count(),0)
  await reviewIssue();assert.match(await staff.locator('#access-task').innerText(),/Will be revoked/)
  await staff.locator('[data-access="confirm"]').click();await staff.locator('#access-private-url').waitFor()
  const replaced=await f.staffState(lostIssue);assert.equal(replaced.state.invitation.state,'pending')
  await staff.locator('[data-access="dismiss-link"]').click()
  await staff.locator('[data-access="revoke_invitation"]').click();await staff.locator('#access-reason').fill('Synthetic invitation no longer needed')
  await staff.getByRole('button',{name:'Review change',exact:true}).click();await staff.locator('[data-access="confirm"]').click()
  await staff.locator('#access-task').waitFor({state:'hidden'});await staff.getByText('Change recorded. Review the current access below.',{exact:true}).waitFor()
  assert.equal((await f.staffState(lostIssue)).state.invitation.state,'revoked')
  await reviewIssue();assert.match(await staff.locator('#access-task').innerText(),/Previous invitation\s+None/);await staff.locator('[data-access="confirm"]').click();await staff.locator('#access-private-url').waitFor();await staff.locator('[data-access="dismiss-link"]').click()
  checks.push('Committed unreadable invitation response is recovered by receipt only, then explicitly replaced and revoked')

  const residentContext=await context(),resident=await pageIn(residentContext)
  await resident.goto(invitationUrl);await resident.locator('[data-resident="new"]').waitFor()
  assert.equal(new URL(resident.url()).hash,'')
  assert.doesNotMatch(await resident.locator('#resident-root').innerText(),/Synthetic in-person check|Synthetic approved protocol|Recipient check evidence reference/)
  await resident.locator('[data-resident="new"]').click()
  await resident.locator('#resident-display-name').fill('Synthetic Browser Resident')
  await resident.locator('#resident-username').fill('owner-a')
  await resident.locator('#resident-new-password').fill(syntheticPassword)
  await resident.locator('#resident-confirm-password').fill(syntheticPassword)
  await resident.locator('#resident-recipient-confirm').check()
  await resident.getByRole('button',{name:'Review activation',exact:true}).click();await sizes(resident,'resident-activation-review')
  await resident.locator('[data-resident="confirm"]').press('Enter')
  await resident.getByText(/That username is unavailable. The current invitation has been refreshed/).waitFor()
  assert.equal(await resident.evaluate(()=>sessionStorage.getItem('atrium.resident.activation-check.v1')),null)
  await resident.locator('#resident-display-name').fill('Synthetic Browser Resident');await resident.locator('#resident-username').fill('synthetic-browser-resident');await resident.locator('#resident-new-password').fill(syntheticPassword);await resident.locator('#resident-confirm-password').fill(syntheticPassword);await resident.locator('#resident-recipient-confirm').check();await resident.getByRole('button',{name:'Review activation',exact:true}).click();await resident.locator('[data-resident="confirm"]').click()
  await resident.getByRole('heading',{name:'Sign in to resident access',exact:true}).waitFor()
  assert.equal((await residentContext.cookies(f.origin)).some(c=>c.name==='atrium_resident_session'),false,'Activation does not mint a session')
  async function signIn(page,username,password){
    if(!await page.locator('#resident-username').count())await page.locator('[data-resident="sign-in"]').first().click()
    await page.locator('#resident-username').fill(username);await page.locator('#resident-password').fill(password)
    await page.locator('#resident-form').getByRole('button',{name:'Sign in',exact:true}).click()
    await page.waitForURL(url=>url.pathname==='/api/resident'&&!url.search&&!url.hash)
    await page.getByRole('heading',{name:'Your resident connections',exact:true}).waitFor()
  }
  await signIn(resident,'synthetic-browser-resident',syntheticPassword)
  assert.match(await resident.locator('#resident-content').innerText(),/Current resident access/)
  assert.match((await residentContext.cookies(f.origin)).find(c=>c.name==='atrium_resident_session').value,/^r1\./)
  checks.push('New resident chooses own credentials, reviews activation, receives no session from the invitation, and signs in through the separate resident audience')

  const other=await f.issue(f.residents['property-a2'][0],{property:'property-a2'})
  await resident.route('http://external.invalid/**',route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><a href="${other.invitationUrl}">Open property invitation</a>`}))
  let crossSiteAnonymous=false,exchangedWithIdentity=false
  resident.on('response',async response=>{
    if(response.request().isNavigationRequest()&&response.url().startsWith(f.origin+'/api/resident')){
      try{const body=await response.text();if(body.includes('"userId":null')&&body.includes('ATRIUM_RESIDENT_PORTAL'))crossSiteAnonymous=true}catch{}
    }
  })
  resident.on('request',request=>{if(request.method()==='POST'&&request.url()===f.origin+'/api/resident'){try{if(request.postDataJSON().action==='exchange')exchangedWithIdentity=Boolean(request.headers()['x-atrium-user-id'])}catch{}}})
  await resident.goto('http://external.invalid/open');await resident.getByRole('link',{name:'Open property invitation'}).click()
  await resident.locator('[data-resident="existing"]').waitFor();assert.equal(new URL(resident.url()).hash,'');assert.equal(exchangedWithIdentity,true)
  assert.equal(crossSiteAnonymous,true,'Actual Strict cookie is omitted on external navigation but same-origin identity recovers before exchange')
  await resident.locator('[data-resident="existing"]').click();await resident.locator('#resident-password').fill('Intentionally incorrect synthetic password');await resident.locator('#resident-recipient-confirm').check();await resident.getByRole('button',{name:'Review activation',exact:true}).click()
  let wrongRequestId
  resident.on('request',r=>{if(r.method()==='POST'){try{const body=r.postDataJSON();if(body.action==='activate_existing'&&!wrongRequestId)wrongRequestId=body.requestId}catch{}}})
  await resident.locator('[data-resident="confirm"]').click();await resident.getByText(/Correct the password and explicitly review the same activation request/).waitFor()
  assert.equal(await resident.evaluate(()=>JSON.parse(sessionStorage.getItem('atrium.resident.activation-check.v1')).requestId),wrongRequestId)
  await resident.locator('#resident-password').fill(syntheticPassword);await resident.locator('#resident-recipient-confirm').check();await resident.getByRole('button',{name:'Review activation',exact:true}).click();await resident.locator('[data-resident="confirm"]').click()
  await resident.getByText('Activation recorded. Check your current resident connection below.',{exact:true}).waitFor()
  assert.equal(await resident.locator('.list li').count(),2)
  checks.push('External Strict-cookie invitation navigation recovers current identity once; existing-account password correction preserves the reviewed activation reference')

  const unknownContext=await context(),unknown=await pageIn(unknownContext),unknownInvite=await f.issue(f.residents['property-a1'][2])
  await unknown.goto(unknownInvite.invitationUrl);await unknown.locator('[data-resident="new"]').click()
  await unknown.locator('#resident-display-name').fill('Synthetic Interrupted Resident');await unknown.locator('#resident-username').fill('synthetic-browser-interrupted');await unknown.locator('#resident-new-password').fill(syntheticPassword);await unknown.locator('#resident-confirm-password').fill(syntheticPassword);await unknown.locator('#resident-recipient-confirm').check();await unknown.getByRole('button',{name:'Review activation',exact:true}).click()
  let activatedPosts=0
  await unknown.route('**/api/resident',async route=>{
    if(route.request().method()!=='POST'||route.request().postDataJSON().action!=='activate_new')return route.fallback()
    activatedPosts++;const response=await route.fetch();assert.equal(response.status(),200);return route.fulfill({response,body:'{"unknown":true}',headers:{...response.headers(),'content-type':'application/json'}})
  })
  await unknown.locator('[data-resident="confirm"]').click();await unknown.locator('#resident-recovery').waitFor({state:'visible'});assert.match(await unknown.locator('#resident-recovery').innerText(),/may have been saved|earlier activation/)
  const marker=await unknown.evaluate(()=>JSON.parse(sessionStorage.getItem('atrium.resident.activation-check.v1')))
  assert.deepEqual(Object.keys(marker).sort(),['invitationId','requestId'])
  await unknown.unroute('**/api/resident');await signIn(unknown,'synthetic-browser-interrupted',syntheticPassword)
  await unknown.locator('[data-resident="check"]').click();await unknown.getByText('Saved activation confirmed for your account. Current resident access has been refreshed.',{exact:true}).waitFor()
  assert.equal(activatedPosts,1);assert.equal(await unknown.evaluate(()=>sessionStorage.getItem('atrium.resident.activation-check.v1')),null)
  checks.push('Actual committed activation with unreadable response survives sign-in reload and reconciles its own receipt without another activation POST')

  await openStaff(first);assert.equal(await staff.locator('[data-access="issue"]').count(),0)
  await staff.locator('[data-access="revoke_binding"]').click();await staff.locator('#access-reason').fill('Synthetic resident requested access removal');await staff.getByRole('button',{name:'Review change',exact:true}).click();await staff.locator('[data-access="confirm"]').click();await staff.locator('#access-task').waitFor({state:'hidden'});await staff.getByText('Change recorded. Review the current access below.',{exact:true}).waitFor()
  assert.equal((await f.staffState(first)).state.binding.state,'revoked')
  await reviewIssue();assert.match(await staff.locator('#access-task').innerText(),/Previous invitation\s+None/);await staff.locator('[data-access="confirm"]').click();await staff.locator('#access-private-url').waitFor();await staff.locator('[data-access="dismiss-link"]').click()
  await resident.reload();await resident.getByRole('heading',{name:'Your resident connections',exact:true}).waitFor();assert.match(await resident.locator('#resident-content').innerText(),/Access revoked/)
  await sizes(resident,'resident-connections')
  checks.push('Staff revokes the exact activated binding; resident reload shows revoked history without losing another property connection')

  await resident.locator('a[href="/api/resident?resource=mfa"]').click();await resident.getByRole('heading',{name:'Passkeys',exact:true}).waitFor()
  assert.doesNotMatch(await resident.locator('#mfa-root').innerText(),/Verify administrator access|Team management/)
  assert.equal(await resident.locator('a[href="/api/organizations"]').count(),0)
  await sizes(resident,'resident-passkeys')
  await resident.getByRole('link',{name:'Back to resident access',exact:true}).click();await resident.getByRole('heading',{name:'Your resident connections',exact:true}).waitFor()
  await resident.locator('[data-resident="logout"]').click();await resident.waitForFunction(()=>window.ATRIUM_RESIDENT_PORTAL?.userId===null);await resident.locator('[data-resident="sign-in"]').first().waitFor()
  assert.equal((await residentContext.cookies(f.origin)).some(c=>c.name==='atrium_resident_session'&&c.value),false)
  checks.push('Resident passkeys use resident-only navigation and confirmed logout removes the resident session')

  assert.deepEqual(errors,[]);assert.deepEqual(f.errors,[]);assert.deepEqual(f.remoteRequests,[]);assert.deepEqual(network,[])
  console.log(JSON.stringify({ok:true,checks,browserErrors:errors,providerRequests:f.remoteRequests.length},null,2))
}catch(error){console.error(JSON.stringify({checks,browserErrors:errors,lastPageText:await pages.at(-1)?.locator('body').innerText().catch(()=>''),message:error.message},null,2));throw error}finally{await browser?.close();await f?.close()}
