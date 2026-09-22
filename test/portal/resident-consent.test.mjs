import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { renderResidentConsentPage } from '../../src/residents/consent-page.ts'
import { renderMaintenanceConsentPage } from '../../src/residents/consent-staff-page.ts'

const scope = { organizationId:'org-a', propertyId:'property-a', configurationVersion:2, permissionVersion:'a'.repeat(43) }
const principal = (audience = 'resident') => ({ audience, userId:'user-one', sessionId:randomUUID(), username:'resident.one', displayName:'Sam <Resident>', credentialVersion:1, passwordHash:'DO_NOT_PROJECT_PASSWORD', privateAuthority:'DO_NOT_PROJECT_AUTHORITY' })

test('resident consent page projects only its own safe bootstrap and never a staff route or credential', () => {
  const user=principal(), requestId=randomUUID()
  const html=renderResidentConsentPage({principal:user,requestId,nonce:'nonce',formToken:'</script><script>unsafe()</script>'},'/* bundled client */')
  assert.match(html,/window.ATRIUM_RESIDENT_CONSENT=/)
  assert.match(html,/\\u003c/)
  assert.match(html,/Sam &lt;Resident&gt;/)
  assert.doesNotMatch(html,/<script>unsafe|DO_NOT_PROJECT|\/api\/dashboard|\/api\/organizations|\/api\/mfa"/)
  assert.match(html,/\/api\/resident\?resource=mfa/)
  assert.match(html,/id="consent-refresh" disabled/)
  assert.match(html,/min-height:48px/)
  assert.match(html,/role="status" aria-live="polite"/)
  assert.match(html,/No decision can be submitted/)
})

test('consent page refuses staff, anonymous and unregistered principals', () => {
  for(const user of [principal('staff'),{...principal(),sessionId:undefined}]) assert.throws(()=>renderResidentConsentPage({principal:user,nonce:'n',formToken:'f'},''))
  assert.throws(()=>renderResidentConsentPage({principal:null,nonce:'n',formToken:'f'},''))
})

test('staff consent page keeps explicit property/case context without projecting raw principal fields', () => {
  const user=principal('staff'), caseId=randomUUID()
  const html=renderMaintenanceConsentPage({principal:user,scope,caseId,nonce:'nonce',formToken:'form'},'')
  assert.match(html,/window.ATRIUM_MAINTENANCE_CONSENT=/)
  assert.match(html,/#\/services\?tab=plans&amp;id=/)
  assert.match(html,/Resident decisions/)
  assert.doesNotMatch(html,/DO_NOT_PROJECT|name="password"|name="token"/)
  assert.match(html,/id="consent-staff-refresh" disabled/)
  assert.throws(()=>renderMaintenanceConsentPage({principal:principal(),scope,caseId,nonce:'n',formToken:'f'},''))
})

import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const residentSource=(await readFile(new URL('../../src/residents/consent-client.js',import.meta.url),'utf8')).replace("import { startAuthentication } from '@simplewebauthn/browser'",'').replace('export function mountResidentConsentClient()','function mountResidentConsentClient()').replace("root.addEventListener('click',e=>", "window.testClient={load,select,open,confirm,check,history,readDetail,readTerms,state:()=>({binding,page,detail,selected,busy,pending,draft,stale,retired})};root.addEventListener('click',e=>")
const staffSource=(await readFile(new URL('../../src/residents/consent-staff-client.js',import.meta.url),'utf8')).replace('export function mountMaintenanceConsentClient()','function mountMaintenanceConsentClient()').replace("root.addEventListener('submit',event=>", "window.testClient={load,open,review,save,check,history,entryWindow,state:()=>({binding,state,pending,draft,busy,stale,retired})};root.addEventListener('submit',event=>")
const plain=v=>JSON.parse(JSON.stringify(v)), reply=(v,status=200)=>({ok:status>=200&&status<300,status,json:async()=>v}),flush=async()=>{for(let i=0;i<45;i++)await Promise.resolve()},instant=offset=>new Date(Date.now()+offset).toISOString()
const ids={case:randomUUID(),plan:randomUUID(),request:randomUUID(),entry:randomUUID(),resident:randomUUID(),other:randomUUID(),binding:randomUUID(),authority:randomUUID(),roster:randomUUID(),challenge:randomUUID(),factor:randomUUID()}
const source=()=>({reference:'Approved synthetic review evidence',version:'source-1',observedAt:instant(-3600000),validUntil:instant(86400000*10)})
const policy=()=>({organizationId:scope.organizationId,propertyId:scope.propertyId,version:1,publishedBy:'owner-one',publishedAt:instant(-3600000),current:true,enabled:true,funding:'property_no_resident_charge',recipientRule:'reviewed_complete_roster',requireWorkConsent:true,noChargeStatement:'This exact work is funded by the property with no charge to the resident.',recipientProtocol:'Review the complete household and each person’s approved decision authority.',entryProtocol:'Review the exact unit, proposed party, purpose and permitted time window.',maximumResponseMinutes:10080,maximumConsentMinutes:43200,maximumEntryMinutes:1440,helpLabel:'Property management',helpPhone:'+12125550100',helpUrl:'https://help.example/',emergencyInstructions:'For immediate danger, call emergency services and follow the property protocol.',source:source()})
const help=()=>({label:'Property management',phone:'+12125550100',url:'https://help.example/',emergencyInstructions:'For immediate danger, call emergency services and follow the property protocol.'})
const terms=(purpose='work')=>{
 let entryWindow=null
 if(purpose==='entry'){
  const startsAt=instant(3600000),endsAt=instant(7200000)
  entryWindow={startsAt,endsAt,startsLocal:startsAt.replace('Z','+00:00'),endsLocal:endsAt.replace('Z','+00:00'),timeZone:'UTC'}
 }
 return{schemaVersion:1,purpose,propertyName:'Sample <House>',unitId:'12A',publicSummary:'Repair the leaking kitchen fixture',scopeOfWork:'Replace the kitchen fixture and test the repair.',party:{kind:'internal',name:'Property maintenance team'},funding:'property_no_resident_charge',currency:'USD',propertyMaximumCents:25000,residentChargeCents:0,noChargeStatement:policy().noChargeStatement,accessRequirement:'unit_entry',entryWindow,conditions:'Keep the kitchen area clear.'}
}
const effectiveness=(extra={})=>({required:true,effective:false,holds:['awaiting_decisions'],evaluatedAt:instant(0),refreshAt:instant(300000),dispatchStatus:'not_dispatched',notificationStatus:'not_sent',...extra})
const request=(purpose='work')=>({id:purpose==='work'?ids.request:ids.entry,organizationId:scope.organizationId,propertyId:scope.propertyId,caseId:ids.case,purpose,version:1,caseVersion:2,planId:ids.plan,planVersion:3,configurationVersion:scope.configurationVersion,maintenancePolicyVersion:1,consentPolicyVersion:1,rosterId:ids.roster,rosterVersion:1,materialDigest:'a'.repeat(64),termsDigest:(purpose==='work'?'b':'c').repeat(64),terms:terms(purpose),responseDeadline:instant(1800000),consentValidUntil:instant(86400000),publishedBy:'owner-one',publishedAt:instant(-5000),createdAt:instant(-5000),withdrawnAt:null})
const ownDetail=(p='work',extra={})=>({requestId:p==='work'?ids.request:ids.entry,requestVersion:1,purpose:p,termsDigest:(p==='work'?'b':'c').repeat(64),materialDigest:'a'.repeat(64),terms:terms(p),responseDeadline:instant(1800000),consentValidUntil:instant(86400000),publishedAt:instant(-5000),withdrawnAt:null,ownDecision:null,ownDecisionVersion:0,effectiveness:effectiveness(),canGrant:true,canDecline:true,canRevoke:false,requiresPasskey:true,currentTerms:true,help:help(),...extra})
const ownSummary=d=>({requestId:d.requestId,requestVersion:d.requestVersion,purpose:d.purpose,propertyName:d.terms.propertyName,unitId:d.terms.unitId,publicSummary:d.terms.publicSummary,responseDeadline:d.responseDeadline,consentValidUntil:d.consentValidUntil,publishedAt:d.publishedAt,ownDecision:d.ownDecision?.decision||null,effective:d.effectiveness.effective,holds:d.effectiveness.holds,currentTerms:d.currentTerms})
const staffState=()=>({organizationId:scope.organizationId,propertyId:scope.propertyId,configurationVersion:scope.configurationVersion,caseId:ids.case,caseVersion:2,unitId:'12A',timeZone:'America/New_York',policy:policy(),roster:{id:ids.roster,organizationId:scope.organizationId,propertyId:scope.propertyId,version:1,policyVersion:1,unitId:'12A',members:[{residentId:ids.resident,residentVersion:1,requiredPurposes:['work','entry']},{residentId:ids.other,residentVersion:2,requiredPurposes:['entry']}],source:source(),complete:true,protocolCompleted:true,residencyDigest:'d'.repeat(64),reviewedBy:'owner-one',reviewedAt:instant(-5000),current:true},authorities:[],residents:[{id:ids.resident,version:1,displayName:'Sam <Resident>',unitId:'12A',contextState:'current',bindingId:ids.binding,bindingVersion:1},{id:ids.other,version:2,displayName:'Another resident',unitId:'12A',contextState:'expired',bindingId:null,bindingVersion:null}],plan:{id:ids.plan,version:3,scopeOfWork:'Replace the kitchen fixture and test the repair.',maximumCents:25000,currency:'USD',accessRequirement:'unit_entry',party:{kind:'internal',name:'Property maintenance team'}},purposes:[{purpose:'work',request:request(),recipients:[],effectiveness:effectiveness()},{purpose:'entry',request:null,recipients:[],effectiveness:effectiveness({holds:['missing_entry_window']})}],canPublishPolicy:true,canManageAuthority:true,canPublishRequest:true,help:help()})

function client(kind='resident',options={}){
 const nodes=new Map(),anonymous=new Set(),events=new Map(),life=new Map(),timers=new Map(),requests=[],storage=options.storage||new Map();let transport,sequence=0,reloads=0,ceremonies=0
 const prefix=kind==='staff'?'consent-staff':'consent',rootId=prefix+'-root'
 const document={activeElement:null,getElementById:key=>node(key)}
 const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
 function node(key){if(nodes.has(key))return nodes.get(key);let html='',children=[];const n={id:key,value:'',checked:false,disabled:false,hidden:false,dataset:{},attributes:{},textContent:'',scrollTop:0,control:false,focus(){document.activeElement=n},setAttribute(k,v){n.attributes[k]=v;if(k==='aria-current')n.current=v},getAttribute(k){return n.attributes[k]},addEventListener:(e,fn)=>events.set(key+':'+e,fn),querySelectorAll(selector){const pool=key===rootId?[...nodes.values(),...anonymous]:children;return pool.filter(c=>selector==='button'||selector.includes('input')?c.control:selector==='h2'||selector==='h3'?c.tag===selector:selector.includes('[data-')?[...selector.matchAll(/\[data-([\w-]+)(?:="([^"]+)")?\]/g)].every(([,k,v])=>{k=k.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return c.dataset[k]!==undefined&&(v===undefined||c.dataset[k]===v)}):selector.startsWith('.')?c.classes?.includes(selector.slice(1)):false)},querySelector(selector){return n.querySelectorAll(selector)[0]||null},get innerHTML(){return html},set innerHTML(content){html=content;for(const c of children)anonymous.delete(c);children=[];for(const[,tag,attrs]of content.matchAll(/<(input|textarea|button|h2|h3|div)\b([^>]*)>/g)){const a=Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,k,v])=>[k,decode(v)]));const c=a.id?node(a.id):{dataset:{},attributes:{},focus(){document.activeElement=c},setAttribute(k,v){c.attributes[k]=v},scrollTop:0};c.tag=tag;c.classes=(a.class||'').split(' ');c.control=['input','textarea','button'].includes(tag);c.disabled=/\bdisabled\b/.test(attrs);c.checked=/(?:^|\s)checked(?:\s|$)/.test(attrs);c.value=a.value||'';if(tag==='textarea'&&a.id)c.value=decode(new RegExp('<textarea[^>]*id="'+a.id+'"[^>]*>([\\s\\S]*?)</textarea>').exec(content)?.[1]||'');for(const[k,v]of Object.entries(a))if(k.startsWith('data-'))c.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;children.push(c);if(!a.id)anonymous.add(c)}}};nodes.set(key,n);return n}
 const boot=kind==='staff'?{audience:'staff',userId:'user-manager',sessionId:randomUUID(),scope:structuredClone(scope),caseId:ids.case,formToken:'BOOT_FORM'}:{audience:'resident',userId:'user-resident',sessionId:randomUUID(),requestId:ids.request,formToken:'BOOT_FORM'}
 const location={hostname:'app.example',origin:'https://app.example',pathname:kind==='staff'?'/api/maintenance-consent':'/api/resident-consent',search:kind==='staff'?'?organizationId=org-a&propertyId=property-a&caseId='+ids.case:'?requestId='+ids.request,href:'',reload(){reloads++}}
 const window={[kind==='staff'?'ATRIUM_MAINTENANCE_CONSENT':'ATRIUM_RESIDENT_CONSENT']:boot,addEventListener:(e,fn)=>life.set(e,fn)}
 const envelope=(action,extra={})=>({action,audience:boot.audience,userId:boot.userId,sessionId:boot.sessionId,...(kind==='staff'?{scope:structuredClone(scope),caseId:ids.case}:{}),formToken:'CURRENT_FORM',...extra})
 const defaultTransport=r=>{const u=new URL(r.url,location.origin),resource=u.searchParams.get('resource');if(resource==='state')return reply(envelope('state',{state:options.state?.()||staffState()}));if(resource==='list')return reply(envelope('list',{page:{items:[ownSummary(options.detail?.()||ownDetail()),ownSummary(ownDetail('entry'))],nextCursor:null,evaluatedAt:instant(0),refreshAt:instant(300000)}}));if(resource==='detail')return reply(envelope('detail',{detail:options.detail?.()||ownDetail(u.searchParams.get('requestId')===ids.entry?'entry':'work')}));if(resource==='history')return reply(envelope('history',{history:{items:[],nextCursor:null}}));throw Error('Unexpected fixture request '+r.url)}
 transport=options.transport||defaultTransport
 const context={window,document,location,URL,Intl,Date,AbortController,console,crypto:{randomUUID},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},startAuthentication:async args=>{ceremonies++;return options.ceremony?options.ceremony(args):{id:'credential-one',rawId:'credential-one',type:'public-key',response:{authenticatorData:'assertion',clientDataJSON:'client',signature:'signature'}}},setTimeout(fn,delay){const key=++sequence;timers.set(key,{fn,delay});return key},clearTimeout:key=>timers.delete(key),fetch:async(url,opts)=>{const r={url,...opts,payload:opts.body?JSON.parse(opts.body):null};requests.push(r);return transport(r)}}
 runInNewContext(kind==='staff'?staffSource:residentSource,context)
 const f={boot,window,document,node,location,requests,storage,timers,life,envelope,defaultTransport,helpers:window.testClient,ceremonies:()=>ceremonies,reloads:()=>reloads,setTransport(fn){transport=fn},async click(action,extra={}){const b={disabled:false,dataset:{[kind==='staff'?'consentStaff':'consent']:action,...extra}};events.get(rootId+':click')({target:{closest:()=>b}});await flush()},async submit(){events.get(rootId+':submit')({target:{id:'consent-staff-form'},preventDefault(){}});await flush()},expire(delay=15000){for(const[k,t]of [...timers])if(t.delay===delay){timers.delete(k);t.fn()}},hide(){life.get('pagehide')()},show(){life.get('pageshow')({persisted:true})},grantOptions(c){return envelope('grant_options',{challengeId:ids.challenge,expiresAt:Date.now()+60000,optionsJSON:{challenge:'challenge-base64url',userVerification:'required',rpId:'app.example',allowCredentials:[{id:'credential-one',type:'public-key'}]}})},ownReceipt(c,changes={}){return {commandId:c.commandId,action:c.action,resource:'decision',id:randomUUID(),version:c.expectedDecisionVersion+1,requestId:c.requestId,requestVersion:c.requestVersion,purpose:c.purpose,actorUserId:boot.userId,committedAt:instant(0),replayed:false,outcome:'saved',...changes}},staffReceipt(c,changes={}){const resource={publish_policy:'policy',publish_roster:'roster',save_authority:'authority',revoke_authority:'authority',publish_request:'request',withdraw_request:'request'}[c.action],resourceId=c.action==='publish_policy'?scope.propertyId:c.id||c.requestId||randomUUID();return{commandId:c.commandId,action:c.action,resource,id:resourceId,version:c.expectedVersion+1,requestId:resource==='request'?resourceId:null,requestVersion:resource==='request'?c.expectedVersion+1:null,purpose:resource==='request'?c.purpose||'work':null,actorUserId:boot.userId,committedAt:instant(0),replayed:false,outcome:'saved',...changes}}}
 return f
}
function fillSource(f){f.node('consent-staff-source-reference').value='Current reviewed synthetic evidence';f.node('consent-staff-source-version').value='v1';f.node('consent-staff-source-observed').value=instant(-60000).slice(0,19);f.node('consent-staff-source-until').value=instant(86400000).slice(0,19);f.node('consent-staff-reason').value='Record the reviewed evidence'}

test('resident loads actual list then exact selected terms with separate work and entry rows',async()=>{const f=client();await flush();assert.equal(f.helpers.state().detail.purpose,'work');assert.match(f.node('consent-list').innerHTML,/Work approval|Entry permission/);assert.match(f.node('consent-detail').innerHTML,/Property spending limit/);assert.match(f.node('consent-detail').innerHTML,/Your charge for this job/);assert.match(f.node('consent-detail').innerHTML,/Sample &lt;House&gt;/);assert.doesNotMatch(f.node('consent-detail').innerHTML,/Other resident|staff.*evidence/i);assert.equal(f.requests.length,2)})

test('grant uses exact reviewed command then real browser helper and atomic finish receipt only',async()=>{const f=client();await flush();let command;f.setTransport(r=>{if(r.payload?.action==='grant_options'){command=r.payload.command;return reply(f.grantOptions(command))}if(r.payload?.action==='grant_finish')return reply(f.envelope('grant_finish',{receipt:f.ownReceipt(command)}));return f.defaultTransport(r)});await f.click('grant');assert.equal(f.ceremonies(),0);await f.click('confirm');assert.equal(f.ceremonies(),1);assert.equal(f.requests.filter(r=>r.payload).length,2);assert.equal(command.action,'grant');assert.equal(command.purpose,'work');assert.equal(command.expectedDecisionVersion,0);assert.equal(command.termsDigest,'b'.repeat(64));assert.equal(command.materialDigest,'a'.repeat(64));assert.equal(f.requests.find(r=>r.payload).headers['x-atrium-consent-action'],'grant_options');assert.equal(f.storage.size,0);assert.match(f.node('consent-notice').textContent,/approval was recorded/);assert.equal(f.helpers.state().busy,false)})

test('passkey cancellation never sends a decision and needs another explicit review',async()=>{const f=client('resident',{ceremony:()=>{const e=Error('cancel');e.name='NotAllowedError';throw e}});await flush();f.setTransport(r=>r.payload?reply(f.grantOptions(r.payload.command)):f.defaultTransport(r));await f.click('grant');await f.click('confirm');assert.equal(f.requests.filter(r=>r.payload?.action==='grant_finish').length,0);assert.equal(f.storage.size,0);assert.match(f.node('consent-notice').textContent,/No decision was submitted/);await f.click('confirm');assert.equal(f.ceremonies(),1)})

test('decline and exact grant revocation do not ask for a passkey or infer entry approval',async()=>{for(const action of ['decline','revoke']){const grantId=randomUUID(),d=ownDetail('entry',action==='revoke'?{ownDecision:{id:grantId,requestId:ids.entry,requestVersion:1,purpose:'entry',version:3,actorUserId:'user-resident',decision:'grant',grantId:null,termsDigest:'c'.repeat(64),decidedAt:instant(-5000)},ownDecisionVersion:3,canRevoke:true}:{ });const f=client('resident',{detail:()=>d});f.boot.requestId=ids.entry;await flush();if(!f.helpers.state().detail){await f.helpers.select(ids.entry)}f.setTransport(r=>r.payload?reply(f.envelope(action,{receipt:f.ownReceipt(r.payload)})):f.defaultTransport(r));await f.click(action);await f.click('confirm');const c=f.requests.find(r=>r.payload)?.payload;assert.equal(c.purpose,'entry');assert.equal(c.action,action);if(action==='revoke'){assert.equal(c.grantId,grantId);assert.equal(c.expectedDecisionVersion,3)}assert.equal(f.ceremonies(),0)}})

test('malformed committed decision retains only safe references and never retries automatically',async()=>{for(const bad of ['unreadable','actor','version','purpose','request']){const f=client();await flush();f.setTransport(r=>{if(!r.payload)return f.defaultTransport(r);if(bad==='unreadable')return{ok:true,status:200,json:async()=>{throw Error('broken')}};const rec=f.ownReceipt(r.payload);if(bad==='actor')rec.actorUserId='foreign';if(bad==='version')rec.version=99;if(bad==='purpose')rec.purpose='entry';if(bad==='request')rec.requestId=randomUUID();return reply(f.envelope('decline',{receipt:rec}))});await f.click('decline');await f.click('confirm');assert.equal(f.storage.size,1);assert.deepEqual(Object.keys(JSON.parse([...f.storage.values()][0])).sort(),['commandId','purpose','requestId']);assert.match(f.node('consent-recovery').innerHTML,/may have been saved/);await f.click('confirm');await f.click('grant');assert.equal(f.requests.filter(r=>r.payload).length,1)}})

test('unknown decision survives sign-in reload and reconciles only its own receipt without another save',async()=>{const command={action:'decline',commandId:randomUUID(),requestId:ids.request,requestVersion:1,expectedDecisionVersion:0,purpose:'work'},storage=new Map([['atrium.resident.consent-check.v1',JSON.stringify({commandId:command.commandId,requestId:ids.request,purpose:'work'})]]),f=client('resident',{storage});await flush();f.setTransport(r=>r.url.includes('resource=receipt')?reply(f.envelope('receipt',{receipt:f.ownReceipt(command)})):f.defaultTransport(r));await f.click('check');assert.equal(storage.size,0);assert.equal(f.requests.filter(r=>r.payload).length,0);assert.match(f.node('consent-notice').textContent,/Saved decline confirmed/);assert.equal(f.helpers.state().detail.requestId,ids.request)})

test('postcommit resident 401 clears private view but preserves explicit reconciliation before navigation',async()=>{const f=client();await flush();f.setTransport(()=>reply({code:'consent_unauthenticated'},401));await f.click('decline');await f.click('confirm');assert.equal(f.helpers.state().retired,true);assert.equal(f.node('consent-detail').innerHTML,'');assert.equal(f.location.href,'');assert.equal(f.storage.size,1);assert.match(f.node('consent-recovery').innerHTML,/may have been saved/);f.hide();assert.equal(f.storage.size,1);f.show();assert.equal(f.reloads(),1)})

test('no-entry and not-required status has no irrelevant approval control',async()=>{const d=ownDetail('entry',{terms:{...terms('entry'),accessRequirement:'no_unit_entry',entryWindow:null},canGrant:false,canDecline:false,canRevoke:false,requiresPasskey:false,effectiveness:effectiveness({required:false,holds:['not_required']})});const f=client('resident',{detail:()=>({...d,requestId:ids.request})});await flush();assert.match(f.node('consent-detail').innerHTML,/Not required/);assert.doesNotMatch(f.node('consent-detail').innerHTML,/data-consent="grant"|data-consent="decline"/);assert.match(f.node('consent-help').innerHTML,/tel:\+12125550100/)})

test('unknown resident charge and foreign response cannot become a displayed review',async()=>{for(const mutation of ['charge','identity']){const f=client('resident',{transport:r=>{const u=new URL(r.url,'https://app.example');if(u.searchParams.get('resource')==='list')return reply({action:'list',audience:'resident',userId:'wrong',sessionId:'wrong',page:{}});return reply({})}});await flush();assert.equal(f.helpers.state().detail,null);assert.doesNotMatch(f.node('consent-detail').innerHTML,/Repair/)}const f=client();await flush();assert.throws(()=>f.helpers.readTerms({...terms(),residentChargeCents:100}));assert.throws(()=>f.helpers.readTerms({...terms(),funding:'unknown'}))})

test('staff loads complete candidate roster including expired source and freezes exact property headers',async()=>{const f=client('staff');await flush();assert.equal(f.helpers.state().state.residents.length,2);assert.match(f.node('consent-staff-state').innerHTML,/Another resident/);assert.match(f.node('consent-staff-state').innerHTML,/source needs review/);assert.equal(f.requests[0].headers['x-atrium-property-id'],'property-a');assert.equal(f.requests[0].headers['x-atrium-case-id'],ids.case);f.window.ATRIUM_MAINTENANCE_CONSENT.scope.propertyId='foreign';await f.helpers.load();assert.equal(f.requests.at(-1).headers['x-atrium-property-id'],'property-a')})

test('complete roster review retains every candidate and purpose selection, with explicit attestations',async()=>{const f=client('staff');await flush();await f.click('roster');fillSource(f);await f.submit();assert.match(f.node('consent-staff-notice').textContent,/explicit review confirmation/);f.node('consent-staff-complete').checked=true;f.node('consent-staff-protocol').checked=true;await f.submit();const c=f.helpers.state().draft.command;assert.equal(c.details.members.length,2);assert.deepEqual(plain(c.details.members.find(r=>r.residentId===ids.other).requiredPurposes),['entry']);assert.equal(c.details.complete,true);assert.equal(c.details.protocolCompleted,true);assert.equal(c.action,'publish_roster');assert.match(f.node('consent-staff-task').innerHTML,/Another resident/);assert.equal(f.requests.filter(r=>r.payload).length,0)})

test('staff policy review displays no-charge statement, actual assistance and source dates before saving',async()=>{const f=client('staff');await flush();await f.click('policy');fillSource(f);await f.submit();const c=f.helpers.state().draft.command;assert.equal(c.action,'publish_policy');assert.equal(c.details.funding,'property_no_resident_charge');assert.equal(c.details.helpPhone,'+12125550100');assert.match(f.node('consent-staff-task').innerHTML,/no charge to the resident/);f.setTransport(r=>r.payload?reply(f.envelope(r.payload.action,{receipt:f.staffReceipt(r.payload)})):f.defaultTransport(r));await f.click('save');assert.equal(f.requests.filter(r=>r.payload).length,1);assert.equal(f.requests.find(r=>r.payload).headers['x-atrium-consent-form'],'CURRENT_FORM');assert.match(f.node('consent-staff-notice').textContent,/Change recorded/)})

test('staff source authority is distinct from consent and binds selected resident/account/purpose',async()=>{const f=client('staff');await flush();await f.click('authority',{residentId:ids.resident,purpose:'entry'});fillSource(f);f.node('consent-staff-protocol').checked=true;await f.submit();const c=f.helpers.state().draft.command;assert.equal(c.action,'save_authority');assert.equal(c.details.bindingId,ids.binding);assert.equal(c.details.residentId,ids.resident);assert.equal(c.details.purpose,'entry');assert.equal(c.expectedVersion,0);assert.match(f.node('consent-staff-task').innerHTML,/Purpose|Entry permission/)})

test('work review can be prepared without an entry window and contains all material cost/work terms',async()=>{const f=client('staff');await flush();await f.click('request',{purpose:'work'});f.node('consent-staff-summary').value='Repair the leaking kitchen fixture';f.node('consent-staff-response-deadline').value=instant(3600000).slice(0,19);f.node('consent-staff-valid-until').value=instant(86400000).slice(0,19);f.node('consent-staff-reviewed').checked=true;f.node('consent-staff-reason').value='Publish the exact reviewed job';await f.submit();const c=f.helpers.state().draft.command;assert.equal(c.purpose,'work');assert.equal(c.entryWindow,null);assert.equal(c.expectedVersion,1);assert.match(f.node('consent-staff-task').innerHTML,/Replace the kitchen fixture/);assert.match(f.node('consent-staff-task').innerHTML,/250\.00/);assert.equal(c.funding,'property_no_resident_charge')})

test('entry interval requires an explicit valid property offset; DST gaps fail and folds are distinguishable',async()=>{const f=client('staff');await flush();await f.click('request',{purpose:'entry'});const set=(a,b,oa,ob)=>{f.node('consent-staff-entry-start').value=a;f.node('consent-staff-entry-end').value=b;f.node('consent-staff-entry-start-offset').value=oa;f.node('consent-staff-entry-end-offset').value=ob};set('2027-03-14T02:30','2027-03-14T03:30','-05:00','-04:00');assert.throws(()=>f.helpers.entryWindow(),/do not match/);set('2026-11-01T01:15','2026-11-01T01:45','-04:00','-04:00');const early=f.helpers.entryWindow();set('2026-11-01T01:15','2026-11-01T01:45','-05:00','-05:00');const late=f.helpers.entryWindow();assert.equal(Date.parse(late.startsAt)-Date.parse(early.startsAt),3600000);assert.equal(late.timeZone,'America/New_York')})

test('unreadable staff save retains non-private command/case receipt reference across reload',async()=>{const f=client('staff');await flush();await f.click('policy');fillSource(f);await f.submit();const c=plain(f.helpers.state().draft.command);f.setTransport(()=>({ok:true,status:200,json:async()=>{throw Error('broken')}}));await f.click('save');assert.equal(f.storage.size,1);assert.deepEqual(Object.keys(JSON.parse([...f.storage.values()][0])).sort(),['caseId','commandId']);const next=client('staff',{storage:f.storage});await flush();next.setTransport(r=>r.url.includes('resource=receipt')?reply(next.envelope('receipt',{receipt:next.staffReceipt(c)})):next.defaultTransport(r));await next.click('check');assert.equal(next.storage.size,0);assert.equal(next.requests.filter(r=>r.payload).length,0);assert.match(next.node('consent-staff-notice').textContent,/saved change was confirmed/)})

test('staff 403 after mutation keeps unknown outcome and never advertises a successful policy change',async()=>{const f=client('staff');await flush();await f.click('policy');fillSource(f);await f.submit();f.setTransport(()=>reply({code:'consent_forbidden'},403));await f.click('save');assert.equal(f.helpers.state().retired,true);assert.equal(f.node('consent-staff-state').innerHTML,'');assert.equal(f.storage.size,1);assert.match(f.node('consent-staff-recovery').innerHTML,/could not be confirmed/);f.hide();f.show();assert.equal(f.reloads(),1);assert.equal(f.storage.size,1)})

test('expired policy remains repairable after fresh read and source timestamps are not rebased',async()=>{const s=staffState();s.policy.current=false;s.policy.source={...source(),observedAt:instant(-86400000*2),validUntil:instant(-86400000)};const f=client('staff',{state:()=>s});await flush();assert.equal(f.helpers.state().stale,false);await f.click('policy');assert.equal(f.node('consent-staff-source-until').value,s.policy.source.validUntil.slice(0,23));f.node('consent-staff-enabled').checked=false;f.node('consent-staff-reason').value='Disable expired protocol';await f.submit();assert.equal(f.helpers.state().draft.command.details.enabled,false);assert.equal(Date.parse(f.helpers.state().draft.command.details.source.validUntil),Date.parse(s.policy.source.validUntil))})

test('both audiences bound a hanging mutation at 15 seconds and keep one exact recovery reference',async()=>{
 for(const kind of ['resident','staff']){
  const f=client(kind);await flush()
  if(kind==='staff'){await f.click('policy');fillSource(f);await f.submit()}else await f.click('decline')
  f.setTransport(r=>new Promise((_,reject)=>r.signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{name:'AbortError'})),{once:true})))
  await f.click(kind==='staff'?'save':'confirm');await f.click(kind==='staff'?'save':'confirm')
  assert.equal(f.requests.filter(r=>r.payload).length,1);assert.equal(f.helpers.state().busy,true)
  f.expire();await flush();assert.equal(f.helpers.state().busy,false);assert.equal(f.storage.size,1)
  assert.match(f.node(kind==='staff'?'consent-staff-recovery':'consent-recovery').innerHTML,/may have been saved/)
 }
})

test('generic or expired passkey options cannot prompt or finish a work decision',async()=>{
 for(const bad of ['iso-expiry','expired','far-future','uv','rp','actor']){
  const f=client();await flush();f.setTransport(r=>{const v=f.grantOptions(r.payload.command);if(bad==='iso-expiry')v.expiresAt=instant(60000);if(bad==='expired')v.expiresAt=Date.now()-1;if(bad==='far-future')v.expiresAt=Date.now()+3600000;if(bad==='uv')v.optionsJSON.userVerification='preferred';if(bad==='rp')v.optionsJSON.rpId='foreign.example';if(bad==='actor')v.userId='other';return reply(v)})
  await f.click('grant');await f.click('confirm');assert.equal(f.ceremonies(),0,bad);assert.equal(f.storage.size,0,bad);assert.equal(f.requests.filter(r=>r.payload?.action==='grant_finish').length,0,bad)
 }
})

const historyRow=(purpose='work',extra={})=>({id:randomUUID(),requestId:purpose==='work'?ids.request:ids.entry,requestVersion:1,purpose,kind:'published',createdAt:instant(-10000),termsDigest:'b'.repeat(64),terms:terms(purpose),decision:null,...extra})
test('resident and staff history load earlier exact pages and restore focus after final paging',async()=>{
 for(const kind of ['resident','staff']){
  const f=client(kind);await flush();const first=historyRow(),second=historyRow('work',{createdAt:instant(-20000)})
  f.setTransport(r=>{const url=new URL(r.url,'https://app.example');assert.equal(url.searchParams.get('requestId'),ids.request);return reply(f.envelope('history',{history:url.searchParams.has('beforeId')?{items:[second],nextCursor:null}:{items:[first],nextCursor:{createdAt:first.createdAt,id:first.id}}}))})
  await f.click('history',{id:ids.request});const target=f.node(kind==='staff'?'consent-staff-history':'consent-history');assert.match(target.innerHTML,/Load earlier history/)
  await f.click('history-more');assert.equal(f.requests.at(-1).url.includes('beforeId='+first.id),true);assert.doesNotMatch(target.innerHTML,/Load earlier history/);assert.equal(f.document.activeElement.tag,'h3');assert.match(target.innerHTML,/View recorded terms/);assert.match(target.innerHTML,/Replace the kitchen fixture/)
 }
})

test('history from another request is rejected without replacing previously verified history',async()=>{
 for(const kind of ['resident','staff']){
  const f=client(kind);await flush();f.setTransport(()=>reply(f.envelope('history',{history:{items:[historyRow()],nextCursor:null}})));await f.click('history',{id:ids.request});const target=f.node(kind==='staff'?'consent-staff-history':'consent-history'),before=target.innerHTML
  f.setTransport(()=>reply(f.envelope('history',{history:{items:[historyRow('entry')],nextCursor:null}})));await f.click('history',{id:ids.request});assert.equal(target.innerHTML,before);assert.match(f.node(kind==='staff'?'consent-staff-notice':'consent-notice').textContent,/could not be loaded/)
 }
})

test('read failures keep a working refresh and fresh status never follows a failed post-save reload',async()=>{
 for(const kind of ['resident','staff']){
  const f=client(kind,{transport:()=>reply({code:'consent_unavailable'},503)});await flush();assert.equal(f.node(kind==='staff'?'consent-staff-refresh':'consent-refresh').disabled,false)
  f.setTransport(f.defaultTransport);await f.helpers.load();assert.equal(f.helpers.state().stale,false)
  if(kind==='staff'){await f.click('policy');fillSource(f);await f.submit()}else await f.click('decline')
  f.setTransport(r=>r.payload?reply(f.envelope(r.payload.action,{receipt:kind==='staff'?f.staffReceipt(r.payload):f.ownReceipt(r.payload)})):reply({code:'consent_unavailable'},503))
  await f.click(kind==='staff'?'save':'confirm');assert.equal(f.storage.size,0);assert.match(f.node(kind==='staff'?'consent-staff-notice':'consent-notice').textContent,/recorded.*could not be loaded/);assert.doesNotMatch(f.node(kind==='staff'?'consent-staff-notice':'consent-notice').textContent,/Current readiness is shown|Current permission is shown/)
 }
})

test('late reads after navigation cannot restore private consent content or automatic actions',async()=>{
 for(const kind of ['resident','staff']){
  const f=client(kind);await flush();let resolve;f.setTransport(r=>new Promise(done=>{resolve=()=>done(f.defaultTransport(r))}));const pending=f.helpers.load();await flush();f.hide();resolve();await pending;await flush()
  assert.equal(f.node(kind==='staff'?'consent-staff-state':'consent-detail').innerHTML,'');assert.equal(f.helpers.state().retired,true);assert.equal(f.requests.filter(r=>r.payload).length,0);f.show();assert.equal(f.reloads(),1)
 }
})

test('staff capability flags hide and refuse privileged editors without inferring authority from a role',async()=>{
 const s=staffState();s.canPublishPolicy=false;s.canManageAuthority=false;s.canPublishRequest=false;const f=client('staff',{state:()=>s});await flush()
 for(const action of ['policy','roster','authority','request','withdraw']){await f.click(action,{residentId:ids.resident,purpose:'work',id:ids.request});assert.equal(f.helpers.state().draft,null)}
 assert.doesNotMatch(f.node('consent-staff-state').innerHTML,/data-consent-staff="policy"|data-consent-staff="request"|data-consent-staff="authority"/)
})

test('staff wrong-property receipt never clears recovery or advertises a saved change',async()=>{
 const f=client('staff');await flush();await f.click('policy');fillSource(f);await f.submit();f.setTransport(r=>reply(f.envelope(r.payload.action,{scope:{...scope,propertyId:'foreign'},receipt:f.staffReceipt(r.payload)})));await f.click('save');assert.equal(f.storage.size,1);assert.match(f.node('consent-staff-notice').textContent,/may have been saved/)
})

test('entry-only selection preserves list scroll and purpose, and no automatic grant occurs on refresh',async()=>{
 const f=client();await flush();f.node('consent-list').querySelector('.consent-list').scrollTop=247;await f.click('select',{id:ids.entry});assert.equal(f.helpers.state().detail.purpose,'entry');assert.equal(f.node('consent-list').querySelector('.consent-list').scrollTop,247);assert.equal(f.document.activeElement.tag,'h2');await f.helpers.load();assert.equal(f.helpers.state().detail.purpose,'entry');assert.equal(f.requests.filter(r=>r.payload).length,0)
})

test('entry selection and refresh survive clock ticks while millisecond-mismatched terms remain invalid',async t=>{
 let now=Date.now()
 t.mock.method(Date,'now',()=>now++)
 const f=client();await flush();await f.click('select',{id:ids.entry})
 assert.ok(f.helpers.state().detail,'entry detail remains readable as the clock advances')
 assert.equal(f.helpers.state().detail.purpose,'entry')
 await f.helpers.load()
 assert.equal(f.helpers.state().detail?.purpose,'entry')
 assert.equal(f.requests.filter(r=>r.payload).length,0)
 const valid=terms('entry')
 assert.doesNotThrow(()=>f.helpers.readTerms(valid))
 for(const [local,utc]of [['startsLocal','startsAt'],['endsLocal','endsAt']]){
  const mismatched={...valid,entryWindow:{...valid.entryWindow,[local]:new Date(Date.parse(valid.entryWindow[utc])+1).toISOString().replace('Z','+00:00')}}
  assert.throws(()=>f.helpers.readTerms(mismatched),local+' must match its exact instant')
 }
})

test('new approval retires at a known deadline while expiry never hides the resident help route',async()=>{
 const f=client();await flush();await f.click('grant');const timers=[...f.timers.values()].filter(t=>t.delay!==15000);assert.equal(timers.length,1);timers[0].fn();assert.equal(f.helpers.state().stale,true);assert.equal(f.helpers.state().draft,null);await f.click('grant');assert.equal(f.helpers.state().draft,null);assert.match(f.node('consent-help').innerHTML,/Property management|emergency services/);assert.equal(f.requests.filter(r=>r.payload).length,0)
})

test('history access and changed-context failures retire both protected pages',async()=>{
 for(const kind of ['resident','staff'])for(const [status,code]of [[401,'consent_unauthenticated'],[403,'consent_forbidden'],[409,'consent_changed']]){
  const f=client(kind);await flush();f.setTransport(()=>reply({code},status));await f.click('history',{id:ids.request});assert.equal(f.helpers.state().retired,true,kind+status);assert.equal(f.node(kind==='staff'?'consent-staff-state':'consent-detail').innerHTML,'',kind+status);assert.equal(f.requests.filter(r=>r.payload).length,0)
 }
})

test('staff reconciles a null receipt only after current-state review and explicit acknowledgement',async()=>{
 const marker={commandId:randomUUID(),caseId:ids.case},storage=new Map([['atrium.staff.consent-check.v1.'+ids.case,JSON.stringify(marker)]]),f=client('staff',{storage});await flush()
 await f.click('dismiss-check');assert.equal(storage.size,1)
 f.setTransport(r=>r.url.includes('resource=receipt')?reply(f.envelope('receipt',{receipt:null})):f.defaultTransport(r));await f.click('check');assert.equal(storage.size,1);assert.match(f.node('consent-staff-recovery').innerHTML,/does not prove that nothing was saved/);assert.equal(f.requests.at(-1).url.includes('resource=state'),true)
 await f.click('dismiss-check');assert.equal(storage.size,1);f.node('consent-staff-reconciled').checked=true;await f.click('dismiss-check');assert.equal(storage.size,0);assert.match(f.node('consent-staff-notice').textContent,/No saved record was undone or retried/);assert.equal(f.requests.filter(r=>r.payload).length,0);await f.click('policy');assert.equal(f.helpers.state().draft.mode,'policy')
})

test('resident appended pages keep the earliest deadline and expire the complete retained result',async()=>{
 const f=client();await flush();const early=instant(5000),late=instant(240000),cursor={id:randomUUID(),createdAt:instant(-5000)},thirdId=randomUUID();f.setTransport(r=>{const u=new URL(r.url,'https://app.example');if(u.searchParams.get('resource')!=='list')return f.defaultTransport(r);return reply(f.envelope('list',{page:u.searchParams.has('beforeId')?{items:[ownSummary(ownDetail('work',{requestId:thirdId}))],nextCursor:null,evaluatedAt:instant(0),refreshAt:late}:{items:[ownSummary(ownDetail())],nextCursor:cursor,evaluatedAt:instant(0),refreshAt:early}}))})
 await f.helpers.load();await f.click('more');assert.equal(f.helpers.state().page.items.length,2);assert.equal(f.helpers.state().page.refreshAt,early)
 const timer=[...f.timers.values()].find(t=>t.delay<10000);assert.ok(timer);timer.fn();assert.equal(f.helpers.state().page,null);assert.equal(f.helpers.state().detail,null);assert.match(f.node('consent-list').innerHTML,/earliest review deadline/);assert.doesNotMatch(f.node('consent-detail').innerHTML,/Recorded|Review approval/)
})

test('entry terms reject a mismatched property timezone and a missing grant window',async()=>{
 const f=client();await flush();const t=terms('entry');assert.throws(()=>f.helpers.readTerms({...t,entryWindow:{...t.entryWindow,timeZone:'America/New_York'}}));assert.throws(()=>f.helpers.readDetail({...ownDetail('entry'),terms:{...t,entryWindow:null}},f.boot,ids.entry))
})

test('elapsed staff effectiveness deadlines hold editors even when old policy evidence is repairable',async()=>{
 const s=staffState();s.purposes[0].effectiveness.refreshAt=instant(-1);const f=client('staff',{state:()=>s});await flush();assert.equal(f.helpers.state().stale,true);assert.match(f.node('consent-staff-notice').textContent,/review deadline/);await f.click('policy');assert.equal(f.helpers.state().draft,null);assert.equal(f.node('consent-staff-refresh').disabled,false)
})

test('resident list success followed by detail 401 keeps the retired sign-in recovery visible',async()=>{
 const f=client();await flush();f.setTransport(r=>r.url.includes('resource=detail')?reply({code:'consent_unauthenticated'},401):f.defaultTransport(r));await f.helpers.load();assert.equal(f.helpers.state().retired,true);assert.equal(f.node('consent-recovery').hidden,false);assert.match(f.node('consent-recovery').innerHTML,/Sign in to resident access/);assert.doesNotMatch(f.node('consent-notice').textContent,/Current review list loaded/)
})

test('staff absent receipt followed by state 403 preserves retirement instead of disabled recovery controls',async()=>{
 const m={commandId:randomUUID(),caseId:ids.case},storage=new Map([['atrium.staff.consent-check.v1.'+ids.case,JSON.stringify(m)]]),f=client('staff',{storage});await flush();f.setTransport(r=>r.url.includes('resource=receipt')?reply(f.envelope('receipt',{receipt:null})):reply({code:'consent_forbidden'},403));await f.click('check');assert.equal(f.helpers.state().retired,true);assert.match(f.node('consent-staff-recovery').innerHTML,/Sign in again/);assert.doesNotMatch(f.node('consent-staff-recovery').innerHTML,/data-consent-staff="check"/);assert.equal(storage.size,1)
})

test('a confirmed mutation followed by expired access cannot repaint the retired protected page',async()=>{
 for(const kind of ['resident','staff']){
  const f=client(kind);await flush();if(kind==='staff'){await f.click('policy');fillSource(f);await f.submit()}else await f.click('decline')
  f.setTransport(r=>r.payload?reply(f.envelope(r.payload.action,{receipt:kind==='staff'?f.staffReceipt(r.payload):f.ownReceipt(r.payload)})):reply({code:'consent_unauthenticated'},401));await f.click(kind==='staff'?'save':'confirm');assert.equal(f.helpers.state().retired,true);assert.match(f.node(kind==='staff'?'consent-staff-recovery':'consent-recovery').innerHTML,/Sign in/);assert.doesNotMatch(f.node(kind==='staff'?'consent-staff-notice':'consent-notice').textContent,/Current.*shown/);assert.equal(f.storage.size,0)
 }
})

test('re-reviewing revoked authority renews the latest revision for the exact current binding',async()=>{
 const s=staffState(),base={id:ids.authority,organizationId:scope.organizationId,propertyId:scope.propertyId,policyVersion:1,userId:'user-resident',residentId:ids.resident,residentVersion:1,bindingId:ids.binding,bindingVersion:1,unitId:'12A',purpose:'entry',source:source(),protocolCompleted:true,reviewedBy:'user-manager',reviewedAt:instant(-5000)}
 s.authorities=[{...base,version:1,current:false,revokedAt:null},{...base,version:2,current:false,revokedAt:instant(-1000)}]
 const f=client('staff',{state:()=>s});await flush();await f.click('authority',{residentId:ids.resident,purpose:'entry'});fillSource(f);f.node('consent-staff-protocol').checked=true;await f.submit();const c=f.helpers.state().draft.command;assert.equal(c.action,'save_authority');assert.equal(c.id,ids.authority);assert.equal(c.expectedVersion,2);assert.equal(c.details.bindingId,ids.binding);assert.equal(f.requests.filter(r=>r.payload).length,0)
})

test('re-enrolled resident starts authority for the new binding without reusing an old binding chain',async()=>{
 const s=staffState(),newBinding=randomUUID();s.residents[0].bindingId=newBinding
 s.authorities=[{id:ids.authority,organizationId:scope.organizationId,propertyId:scope.propertyId,version:9,policyVersion:1,userId:'user-resident',residentId:ids.resident,residentVersion:1,bindingId:ids.binding,bindingVersion:1,unitId:'12A',purpose:'work',source:source(),protocolCompleted:true,reviewedBy:'user-manager',reviewedAt:instant(-5000),revokedAt:null,current:false}]
 const f=client('staff',{state:()=>s});await flush();await f.click('authority',{residentId:ids.resident,purpose:'work'});fillSource(f);f.node('consent-staff-protocol').checked=true;await f.submit();const c=f.helpers.state().draft.command;assert.equal(c.id,null);assert.equal(c.expectedVersion,0);assert.equal(c.details.bindingId,newBinding);assert.equal(c.details.residentId,ids.resident)
})

test('browser-normalized fractional input preserves exact source milliseconds and canonical entry instants',async()=>{
 const s=staffState(),observed=new Date(Date.now()-60000);observed.setUTCMilliseconds(200);s.policy.source.observedAt=observed.toISOString();const f=client('staff',{state:()=>s});await flush();await f.click('policy');f.node('consent-staff-source-observed').value=s.policy.source.observedAt.slice(0,21);f.node('consent-staff-reason').value='Review unchanged precise source';await f.submit();assert.equal(f.helpers.state().draft.command.details.source.observedAt,s.policy.source.observedAt)
 await f.click('close');await f.click('request',{purpose:'entry'});f.node('consent-staff-entry-start').value='2026-11-01T01:15:00.2';f.node('consent-staff-entry-end').value='2026-11-01T01:45:00.25';f.node('consent-staff-entry-start-offset').value='-04:00';f.node('consent-staff-entry-end-offset').value='-04:00';const window=f.helpers.entryWindow();assert.match(window.startsLocal,/\.200-04:00$/);assert.match(window.endsAt,/\.250Z$/)
})
