import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'

const [appSource,calendarSource,actionsSource,css]=await Promise.all(['app.js','calendar.js','calendar-actions.js','calendar.css'].map(file=>readFile(new URL(`../../ops/src/${file}`,import.meta.url),'utf8')))
const plain=value=>JSON.parse(JSON.stringify(value))
function ui({mobile=false,permissions=['read','operate','configure'],name='Lake House',zone='America/Chicago'}={}){
 const window={ATRIUM_RUNTIME_MODE:'postgres',ATRIUM_ACCOUNT:{userId:'synthetic-user',username:'operator',displayName:'Operator'},
  ATRIUM_PROPERTY:{organizationId:'organization-a',propertyId:'property-a',buildingName:name,locationLabel:'Chicago, IL',timeZone:zone,configurationVersion:1,permissionVersion:'version-one',permissions,hours:{1:[9,17]},leasingPhone:null,leasingPhoneDisplay:null}}
 const classList={add(){},remove(){},toggle(){}}
 const document={readyState:'loading',addEventListener(){},querySelector(){return null},querySelectorAll(){return []},getElementById(){return null},body:{classList}}
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2032-06-01T12:00:00Z']))}static now(){return Date.parse('2032-06-01T12:00:00Z')}}
 const context={window,document,Date:Clock,Intl,URLSearchParams,console,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,
  location:{hash:'#/calendar?date=2032-06-01&view=day'},matchMedia:query=>({matches:mobile&&query.includes('max-width')})}
 runInNewContext(appSource,context)
 runInNewContext(calendarSource.replace("A.register('calendar', view)","window.calendarTest={buildModel,summaryModel,summaryHtml,heroHtml,toolbarHtml,rulesHtml,gridHtml,agendaHtml,visibleRange,unavailableHtml,cal,view}; A.register('calendar', view)"),context)
 runInNewContext(actionsSource.replace('A.calendarActions = {','window.actionsTest={unitBlocksHtml}; A.calendarActions = {'),context)
 return {app:window.Atrium,c:window.calendarTest,actions:window.actionsTest,context}
}
function calendar(){
 const first={externalId:'booking-one',slotId:'slot-2032-06-01T09:00',startsAt:'2032-06-01T14:00:00Z',endsAt:'2032-06-01T14:45:00Z',prospectName:'Prospect One',unitId:'1A',revision:0}
 const second={...first,externalId:'booking-two',prospectName:'Prospect Two',unitId:'2A'}
 const next={slotId:'slot-2032-06-01T09:15',date:'2032-06-01',startsAt:'2032-06-01T14:15:00Z',endsAt:'2032-06-01T15:00:00Z',status:'open',capacity:3,bookings:[first,second]}
 return {range:{from:'2032-06-01',to:'2032-06-01'},settings:{capacity:3,slotMinutes:45,startIntervalMinutes:15,bufferMinutes:10,minimumNoticeMinutes:120,bookingWindowDays:null,sameUnitPolicy:'exclusive'},
  slots:[{...next,...first,date:'2032-06-01',status:'open',capacity:3,bookings:[first,second]},next],
  bookings:[first,second,{...first,externalId:'outside-range',startsAt:'2032-06-02T14:00:00Z',endsAt:'2032-06-02T14:45:00Z'},first],
  blocks:[{target:'2032-06-01',reason:'Team meeting'},{target:'2032-06-01',reason:'Duplicate transport row'},
   {target:'2032-06-01',startsAt:'2032-06-02T05:00:00Z',endsAt:'2032-06-03T05:00:00Z',reason:'Retained interval from another zone'}],
  unitBlocks:[{id:'hold-a',unitId:'1A',startsAt:'2032-06-01T16:00:00Z',endsAt:'2032-06-01T17:00:00Z',reason:'Painting'},
   {id:'hold-midnight',unitId:'1A',startsAt:'2032-06-01T04:30:00Z',endsAt:'2032-06-01T05:00:00Z',reason:'Ends before selected day'},
   {id:'hold-removed',unitId:'2A',startsAt:'2032-06-01T16:00:00Z',endsAt:'2032-06-01T17:00:00Z',removedAt:'2032-06-01T12:00:00Z'}]}
}
function model(instance,data=calendar(),opts={date:'2032-06-01',view:'day'}){
 instance.app.state.calendar=data
 return instance.c.buildModel(instance.app.state,opts)
}

test('selected-range overview deduplicates actual tours and open starts without fabricating occupancy',()=>{
 const t=ui(),m=model(t)
 assert.deepEqual(plain(t.c.summaryModel(t.app.state,m)),{tours:2,open:2,building:1,unit:1,holds:2})
 const html=t.c.summaryHtml(t.app.state,m)
 assert.match(html,/Tours scheduled/);assert.match(html,/Open start times/);assert.match(html,/subject to apartment availability/)
 assert.match(html,/1 unit hold · 1 building hold/);assert.doesNotMatch(html,/occupancy|utilization|revenue|%/i)
})

test('a different range never displays zero or stale totals as a successfully loaded day',()=>{
 const t=ui(),m=model(t,calendar(),{date:'2042-06-01',view:'day'})
 assert.equal(m.loaded,false);assert.equal(t.c.summaryModel(t.app.state,m),null)
 const html=t.c.summaryHtml(t.app.state,m)
 assert.equal((html.match(/metric-value num">—</g)||[]).length,3);assert.match(html,/Waiting for this date range/)
 assert.match(t.c.toolbarHtml(m),/Loading selected dates/)
})

test('stale loaded overview keeps its real totals and labels reconnecting state',()=>{
 const t=ui(),m=model(t);t.app.state.errors.calendar=new Error('Synthetic outage')
 assert.match(t.c.summaryHtml(t.app.state,m),/Last saved view · reconnecting/)
 assert.equal(t.c.summaryModel(t.app.state,m).tours,2)
})

test('calendar controls retain unlimited date navigation and all authorized scheduling entry points',()=>{
 const t=ui(),m=model(t,calendar(),{date:'2088-06-01',view:'week'})
 const toolbar=t.c.toolbarHtml(m),hero=t.c.heroHtml(m)
 for(const action of ['prev','next','today','goto','view-week','view-day'])assert.match(toolbar,new RegExp(`data-action="${action}"`))
 assert.doesNotMatch(toolbar,/data-action="next"[^>]*aria-disabled="true"/)
 for(const action of ['block','unit-blocks','settings','more'])assert.match(hero,new RegExp(`data-action="${action}"`))
 assert.match(hero,/Block building time/);assert.match(hero,/Unit availability/)
 assert.equal(t.c.visibleRange({date:'2088-06-01',view:'day'}).from,'2088-06-01')
})

test('view-only calendar hides write entry points but keeps date browsing',()=>{
 const t=ui({permissions:['read']}),m=model(t),hero=t.c.heroHtml(m)
 assert.match(hero,/View-only access/);assert.doesNotMatch(hero,/data-action="(?:block|unit-blocks|settings|more)"/)
 assert.match(t.c.toolbarHtml(m),/data-action="goto"/)
 const operator=ui({permissions:['read','operate']}),om=model(operator)
 assert.match(operator.c.heroHtml(om),/data-action="unit-blocks"/);assert.doesNotMatch(operator.c.heroHtml(om),/data-action="settings"/)
})

test('same-time different-apartment tours remain distinct and retain open building capacity in mobile agenda',()=>{
 const t=ui({mobile:true}),data=calendar();data.blocks=[];const m=model(t,data),html=t.c.agendaHtml(m)
 assert.equal(m.view,'day');assert.equal(m.dayModels[0].tours.length,2)
 assert.equal((html.match(/data-action="agenda-tour"/g)||[]).length,2)
 assert.match(html,/apartment 1A/);assert.match(html,/apartment 2A/);assert.match(html,/data-action="agenda-open"/)
 assert.match(t.c.toolbarHtml(m),/data-action="today"/);assert.match(t.c.toolbarHtml(m),/data-action="goto"/)
 const keys=[...html.matchAll(/data-action="agenda-tour"[^>]*data-key="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(keys).size,2)
})

test('rules show actual capacity, shared-apartment setting, booking window and selected property timezone',()=>{
 const t=ui(),m=model(t),rules=t.c.rulesHtml(m)
 assert.match(rules,/3 tours at once/);assert.match(rules,/45 minutes/);assert.match(rules,/One tour per apartment/);assert.match(rules,/No advance limit/)
 m.settings={...m.settings,sameUnitPolicy:'shared',bookingWindowDays:90}
 assert.match(t.c.rulesHtml(m),/Shared tours allowed/);assert.match(t.c.rulesHtml(m),/90 days/)
 assert.match(t.c.heroHtml(m),/Chicago|Central/)
})

test('property labels and apartment hold reasons remain escaped in the redesigned cards and dialogs',()=>{
 const t=ui({name:'<img src=x onerror=alert(1)>'}),m=model(t)
 assert.doesNotMatch(t.c.heroHtml(m),/<img/);assert.match(t.c.heroHtml(m),/&lt;img/)
 t.app.state.calendar.unitBlocks=[{id:'hold-safe',unitId:'1A',startsAt:'2032-06-02T15:00:00Z',endsAt:'2032-06-02T16:00:00Z',reason:'<script>bad()</script>'}]
 const html=t.actions.unitBlocksHtml('1A');assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/)
 assert.match(t.actions.unitBlocksHtml('2A'),/No upcoming holds/)
})

test('mobile presentation has a single-column summary and full-size controls without changing grid geometry',()=>{
 assert.match(css,/@media \(max-width: 599px\)[\s\S]*?\.cal-view \.cal-metrics \{ grid-template-columns: minmax\(0, 1fr\)/)
 assert.match(css,/\.cal-hero-actions \.btn, \.cal-hero-actions \.btn-icon \{ min-height: 44px/)
 assert.match(css,/\.cal-arow \{ min-height: 76px/)
 assert.match(css,/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition: none/)
 const t=ui(),data=calendar();data.blocks=[];const m=model(t,data)
 assert.match(t.c.gridHtml(m),new RegExp(`--cal-row-height:${m.rowHeight}px`))
 assert.match(t.c.gridHtml(m),/role="grid"/)
})

test('unloaded schedule uses an explicit unavailable state instead of claiming closed or empty',()=>{
 const t=ui({mobile:true}),html=t.c.unavailableHtml()
 assert.match(html,/Schedule unavailable/);assert.match(html,/These dates have not loaded/)
 assert.doesNotMatch(html,/Closed|No tour times|data-write/)
 assert.match(calendarSource,/else if \(!m\.loaded\) body = unavailableHtml\(\)/)
})
