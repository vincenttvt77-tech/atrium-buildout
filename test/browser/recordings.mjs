import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { recordingFixture } from '../helpers/recording-fixture.mjs'
const { chromium }=await import(process.env.ATRIUM_PLAYWRIGHT_MODULE?pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href:'playwright')
const fixture=await recordingFixture(), errors=[], checks=[]
let browser
try{
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  let failMedia=false, wrongScope=false, mediaRequests=0
  const wav=Buffer.alloc(44+160000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(160000,40)
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.origin==='https://storage.vapi.ai'){
      mediaRequests++;assert.equal(route.request().headers().authorization,undefined,'Provider key must never enter browser audio requests')
      await route.fulfill({status:failMedia?404:200,contentType:'audio/wav',body:failMedia?'':wav});return
    }
    if(url.origin===fixture.origin){
      if(url.pathname==='/api/recordings'&&wrongScope){const response=await route.fetch();const body=await response.json();body.scope.propertyId='foreign-property';await route.fulfill({response,json:body});return}
      await route.continue();return
    }
    assert.ok(/^https:\/\/fonts\.(googleapis|gstatic)\.com$/.test(url.origin),'Unexpected browser network destination: '+url.origin)
    await route.fulfill({status:204,body:''})
  })
  const cookie=fixture.cookies['viewer-a'];await context.addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:fixture.origin}])
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000)
  const pageUrl=fixture.origin+'/api/dashboard?organizationId=organization-a&propertyId=property-a1#/calls'
  async function select(){await page.goto(pageUrl);await page.locator('.call-row').waitFor();await page.locator('.call-row').first().click();await page.getByRole('button',{name:'Listen to the recording',exact:true}).waitFor()}
  async function open(){await page.getByRole('button',{name:'Listen to the recording',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('dialog').locator('audio').waitFor()}
  async function close(){await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).last().click()}
  await select();assert.equal(fixture.state.requests.length,0,'List rendering does not mint capabilities')
  await open();assert.equal(fixture.state.requests.length,2);assert.equal(mediaRequests,0,'Audio is not fetched until playback')
  const audio=await page.locator('audio').elementHandle();await audio.evaluate(el=>el.play())
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>0.2)
  await page.evaluate(()=>window.Atrium.refresh())
  assert.equal(await audio.evaluate(el=>el===document.querySelector('audio')&&!el.paused),true,'Polling preserves the playing audio element')
  assert.equal(fixture.state.requests.length,2);checks.push('Viewer keyboard playback uses fresh scoped access and survives dashboard polling')
  async function viewport(width){
    await page.setViewportSize({width,height:900})
    // The Calls view debounces its responsive repaint. Check the rendered state,
    // including the search label, rather than capturing a pre-repaint frame.
    await page.waitForFunction(()=>{
      const search=document.querySelector('.calls-view input[type="search"]')
      return search?.placeholder===(innerWidth>=960?'Search calls by name, number or apartment':'Search name, number or apartment')
        &&document.documentElement.scrollWidth<=innerWidth
        &&document.querySelector('audio')?.getBoundingClientRect().right<=innerWidth
    },undefined,{timeout:2000})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const fit=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,outliers:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right})).slice(0,12)})); assert.ok(fit.scroll<=width,'Player fits viewport '+JSON.stringify(fit))
    assert.ok(await page.locator('audio').evaluate(el=>el.getBoundingClientRect().right<=innerWidth),'Audio controls fit '+width)
  }
  for(const width of [320,390,768,1280,320,1280,390]) await viewport(width)
  if(process.env.ATRIUM_BROWSER_ARTIFACTS){await mkdir(process.env.ATRIUM_BROWSER_ARTIFACTS,{recursive:true});await page.screenshot({path:process.env.ATRIUM_BROWSER_ARTIFACTS+'/recording-mobile.png'});console.log('Mobile geometry',await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,dialog:document.querySelector('[role="dialog"]').getBoundingClientRect().toJSON()})))}
  await page.keyboard.press('Escape');assert.equal(await page.locator('audio').count(),0);assert.equal(await audio.evaluate(el=>el.paused&&!el.hasAttribute('src')),true)
  assert.equal(await page.getByRole('button',{name:'Listen to the recording',exact:true}).evaluate(el=>el===document.activeElement),true)
  checks.push('320/390/768/1280 layout, Escape stop and focus restoration pass')
  fixture.state.recordingStatus=404;await page.getByRole('button',{name:'Listen to the recording',exact:true}).click();await page.getByRole('alert').filter({hasText:'The recording is unavailable'}).waitFor();assert.equal(await page.locator('audio').count(),0)
  fixture.state.recordingStatus=302;await page.getByRole('button',{name:'Try again',exact:true}).click();await page.locator('audio').waitFor();checks.push('Removed/unavailable recording shows truthful retry and reacquires fresh access');await close()
  failMedia=true;await open();await page.locator('audio').evaluate(el=>el.play().catch(()=>{}));await page.getByText('The audio could not be loaded.',{exact:false}).waitFor()
  failMedia=false;await page.getByRole('button',{name:'Refresh recording access',exact:true}).click();await page.locator('audio').evaluate(el=>el.play());await page.waitForFunction(()=>document.querySelector('audio').currentTime>0);checks.push('Expired audio recovers with a new authorized capability');await close()
  let release,entered=false;fixture.state.onRecording=()=>new Promise(resolve=>{entered=true;release=resolve})
  await page.getByRole('button',{name:'Listen to the recording',exact:true}).click()
  while(!entered)await new Promise(resolve=>setTimeout(resolve,20))
  await close();release();fixture.state.onRecording=null
  await page.evaluate(()=>window.Atrium.refresh());assert.equal(await page.locator('audio').count(),0)
  await open();await page.evaluate(()=>{location.hash='#/today'});await page.getByRole('heading',{name:'Today',exact:true}).waitFor();assert.equal(await page.locator('audio').count(),0)
  checks.push('Closed or navigated dialogs cannot revive from delayed responses')
  await select();wrongScope=true;await page.getByRole('button',{name:'Listen to the recording',exact:true}).click()
  await page.getByText('The property or your access changed.',{exact:false}).waitFor();assert.equal(await page.locator('audio').count(),0)
  checks.push('Mismatched property response retires the document without exposing audio')
  assert.deepEqual(errors,[]);assert.deepEqual(fixture.state.errors,[])
  console.log(JSON.stringify({checks,providerReads:fixture.state.requests.length,syntheticMediaRequests:mediaRequests,realCalls:0,realRecordings:0},null,2))
}finally{await browser?.close();await fixture.close()}
