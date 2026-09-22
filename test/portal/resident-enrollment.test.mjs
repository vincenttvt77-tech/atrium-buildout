import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { renderResidentPortalPage } from '../../src/residents/portal-page.ts'
import { renderResidentAccessPage } from '../../src/residents/access-page.ts'
import { renderMfaPage } from '../../src/auth/mfa-page.ts'

const accessSource=(await readFile(new URL('../../src/residents/access-client.js',import.meta.url),'utf8')).replace('export function mountResidentAccessClient()','function mountResidentAccessClient()').replace("root.addEventListener('submit',event =>", "window.testClient={load,open,review,save,state:()=>({state,pending,draft,busy,retired})}; root.addEventListener('submit',event =>")
const portalSource=(await readFile(new URL('../../src/residents/portal-client.js',import.meta.url),'utf8')).replace('export function mountResidentPortalClient()','function mountResidentPortalClient()').replace("root.addEventListener('submit',event=>", "window.testClient={load,open,formSubmit,activate,check,logout,state:()=>({current,recovery,draft,busy,retired})}; root.addEventListener('submit',event=>")
const plain=v=>JSON.parse(JSON.stringify(v)), reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data})
const flush=async()=>{for(let i=0;i<35;i++)await Promise.resolve()}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const instant=offset=>new Date(Date.now()+offset).toISOString()
const scope={organizationId:'org-a',propertyId:'property-a',configurationVersion:2,permissionVersion:'a'.repeat(43)}
const residentId=randomUUID(),invitationId=randomUUID(),bindingId=randomUUID()
const policy=()=>({organizationId:scope.organizationId,propertyId:scope.propertyId,version:2,enabled:true,current:true,method:'in_person_staff_check',protocol:'Check the recipient in person against the approved property process.',invitationLifetimeMinutes:60,sourceReference:'Synthetic approved protocol',observedAt:instant(-3600000),validUntil:instant(86400000),publishedAt:instant(-3600000),publishedBy:'user-manager'})
const staffState=()=>({policy:policy(),resident:{id:residentId,version:3,displayName:'Sam <Resident>',unitId:'12A',contextState:'current'},invitation:null,binding:null,canManage:true})
const preview=()=>({invitationId,invitationVersion:1,propertyName:'Sample House',unitId:'12A',recipientHint:'S…',expiresAt:instant(3600000)})
const connection=(userId='user-resident',overrides={})=>({id:bindingId,version:1,organizationId:'org-a',propertyId:'property-a',residentId,residentVersion:3,policyVersion:2,userId,invitationId,unitId:'12A',activatedAt:instant(-1000),revokedAt:null,state:'current',propertyName:'Sample House',...overrides})

function fixture(kind='portal',{signedIn=false,initial,hash='',storage=new Map(),reauthenticate=false}={}) {
  const nodes=new Map(),anonymous=new Set(),events=new Map(),life=new Map(),timers=new Map(),requests=[],historyCalls=[]
  const boot=kind==='access'?{userId:'user-manager',sessionId:randomUUID(),residentId,scope:structuredClone(scope),formToken:'BOOT_FORM'}:{audience:'resident',userId:signedIn?'user-resident':null,sessionId:signedIn?randomUUID():null,username:signedIn?'resident.one':null,displayName:signedIn?'Sam':null,formToken:'BOOT_FORM',reauthenticate}
  let timerId=0,reloads=0,copies=0,transport
  const document={activeElement:null,getElementById:key=>node(key)}
  function node(key){
    if(!nodes.has(key)){
      let html='',children=[]
      const value={id:key,dataset:{},attributes:{},value:'',textContent:'',checked:false,disabled:false,hidden:false,control:false,
        focus(){document.activeElement=value},setAttribute(k,v){value.attributes[k]=v},addEventListener:(event,fn)=>events.set(key+':'+event,fn),
        querySelectorAll(){return key.endsWith('-root')?[...nodes.values(),...anonymous].filter(x=>x.control):children},
        get innerHTML(){return html},set innerHTML(content){html=content;for(const child of children)anonymous.delete(child);children=[]
          for(const[,tag,attrs,body]of content.matchAll(/<(input|textarea|button|h2|form)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\/?\s*>)/g)){
            // A form wrapper must not swallow its nested controls.
            if(tag==='form')continue
          }
          for(const[,tag,attrs]of content.matchAll(/<(input|textarea|button)\b([^>]*)>/g)){
            const a=Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,k,v])=>[k,v]));const c=a.id?node(a.id):{dataset:{},focus(){document.activeElement=c}}
            c.control=true;c.disabled=/\bdisabled\b/.test(attrs);c.checked=/(?:^|\s)checked(?:\s|$)/.test(attrs);c.value=a.value||''
            if(tag==='textarea'){const escaped=a.id?.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');c.value=escaped?new RegExp('<textarea[^>]*id="'+escaped+'"[^>]*>([\\s\\S]*?)</textarea>').exec(content)?.[1]||'':''}
            for(const[k,v]of Object.entries(a))if(k.startsWith('data-'))c.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v
            children.push(c);if(!a.id)anonymous.add(c)
          }
        }};nodes.set(key,value)
    }return nodes.get(key)
  }
  node(kind==='access'?'access-refresh':'resident-refresh').control=true
  const location={origin:'https://app.example',pathname:kind==='access'?'/api/resident-access':'/api/resident',search:kind==='access'?'?organizationId=org-a&propertyId=property-a&residentId='+residentId:'',hash,href:'',reload(){reloads++}}
  const window={[kind==='access'?'ATRIUM_RESIDENT_ACCESS':'ATRIUM_RESIDENT_PORTAL']:boot,addEventListener:(event,fn)=>life.set(event,fn)}
  const identity=()=>({audience:'resident',userId:boot.userId,sessionId:boot.sessionId})
  const access=(overrides={})=>({action:'state',userId:boot.userId,sessionId:boot.sessionId,residentId,scope:structuredClone(scope),formToken:'CURRENT_SCOPE_FORM',state:staffState(),...overrides})
  const portal=(overrides={})=>({...identity(),username:boot.username,displayName:boot.displayName,formToken:'CURRENT_RESIDENT_FORM',invitation:preview(),reviewToken:'PREVIEW_FORM',bindings:signedIn?{items:[connection()],nextId:null}:null,mfaRequired:false,...overrides})
  const context={window,document,location,history:{replaceState(_a,_b,url){historyCalls.push(url);location.hash=''}},sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,val)=>storage.set(key,val),removeItem:key=>storage.delete(key)},navigator:{clipboard:{writeText:async()=>{copies++}}},crypto:{randomUUID},URL,Date,AbortController,console,
    setTimeout(fn,delay){const key=++timerId;timers.set(key,{fn,delay});return key},clearTimeout(key){timers.delete(key)},fetch:async(url,options)=>{const request={url,...options,payload:options.body?JSON.parse(options.body):null};requests.push(request);return transport(request)}}
  transport=initial?request=>initial(request,{boot,identity,access,portal}):()=>reply(kind==='access'?access():portal())
  runInNewContext(kind==='access'?accessSource:portalSource,context)
  const f={boot,window,document,node,requests,historyCalls,location,storage,life,context,access,portal,identity,helpers:window.testClient,setTransport(fn){transport=fn},copies:()=>copies,reloads:()=>reloads,
    async click(action){const c={disabled:false,dataset:{[kind==='access'?'access':'resident']:action}};await events.get((kind==='access'?'access-root':'resident-root')+':click')({target:{closest:()=>c}});await flush()},
    async submit(){await events.get((kind==='access'?'access-root':'resident-root')+':submit')({target:{id:kind==='access'?'access-form':'resident-form'},preventDefault(){}});await flush()},
    expire(){for(const[key,t]of timers)if(t.delay===15000){timers.delete(key);t.fn()}},hide(){life.get('pagehide')()},show(){life.get('pageshow')({persisted:true})},
    staffReceipt(request,overrides={}){const c=request.payload;return{action:c.action,userId:boot.userId,sessionId:boot.sessionId,residentId,scope:structuredClone(scope),receipt:{action:c.action,requestId:c.requestId,organizationId:scope.organizationId,propertyId:scope.propertyId,actorUserId:boot.userId,id:c.action==='publish_policy'?scope.propertyId:c.id||invitationId,version:c.action==='issue_invitation'?1:(c.expectedVersion||0)+1,residentId:c.action==='publish_policy'?null:residentId,recordedAt:instant(0),replayed:false,...overrides}}},
    activationReceipt(request,overrides={}){return{...identity(),action:request.payload.action,signInRequired:true,receipt:{requestId:request.payload.requestId,invitationId,bindingId,bindingVersion:1,organizationId:'org-a',propertyId:'property-a',residentId,userId:boot.userId||'user-new',activatedAt:instant(0),replayed:false,...overrides}}}
  };return f
}
async function prepareIssue(f){await flush();await f.click('issue');f.node('access-checked').checked=true;f.node('access-checked-at').value=instant(-60000).slice(0,16);f.node('access-evidence').value='Recipient checked in person';f.node('access-reason').value='Requested resident account access';await f.submit()}
async function prepareActivation(f,fresh=true){await flush();await f.click(fresh?'new':'existing');f.node('resident-recipient-confirm').checked=true;if(fresh){f.node('resident-username').value='new.resident';f.node('resident-display-name').value='Sam Resident';f.node('resident-new-password').value='Synthetic password 123!';f.node('resident-confirm-password').value='Synthetic password 123!'}else f.node('resident-password').value='Existing synthetic password';await f.submit()}

test('pages project narrow identity, safe nonce JSON and mobile controls without a credential GET fallback',()=>{
  const principal={audience:'resident',userId:'user-r',sessionId:randomUUID(),displayName:'<Sam>',username:'sam',passwordHash:'PRIVATE_HASH'}
  const html=renderResidentPortalPage({principal,nonce:'nonce',formToken:'</script><script>unsafe()</script>'},'/* client */')
  assert.doesNotMatch(html,/<script>unsafe|PRIVATE_HASH|name="password"|\/api\/dashboard|\/api\/organizations/);assert.match(html,/\\u003c/);assert.match(html,/min-height:48px/)
  const staff=renderResidentAccessPage({principal:{...principal,audience:'staff'},scope,residentId,nonce:'nonce',formToken:'form'},'')
  assert.match(staff,/#\/services\?tab=residents/);assert.match(staff,/&lt;Sam&gt;/);assert.doesNotMatch(staff,/PRIVATE_HASH/)
  assert.throws(()=>renderResidentPortalPage({principal:{...principal,audience:'staff'},nonce:'n',formToken:'f'},''))
})

test('private fragment is removed before exchange, never sent as query, and preview comes from fresh state',async()=>{
  const token='a'.repeat(43);let observed
  const f=fixture('portal',{hash:'#invite='+token,initial:(r,c)=>{if(r.payload){observed=r;return reply({action:'exchange',...c.identity()})}return reply(c.portal())}});await flush()
  assert.equal(f.historyCalls[0],'/api/resident');assert.equal(f.location.hash,'');assert.deepEqual(observed.payload,{action:'exchange',token});assert.equal(observed.url,'/api/resident');assert.equal(f.requests[0].url,'/api/resident?format=json&resource=state');assert.equal(f.requests[2].url,'/api/resident?format=json&resource=state')
  assert.equal(observed.headers['x-atrium-resident-form'],'CURRENT_RESIDENT_FORM');assert.equal(observed.redirect,'error');assert.equal(f.storage.size,0);assert.match(f.node('resident-content').innerHTML,/Sample House/)
})

test('new activation uses reviewed invitation and one UUID, then requires ordinary sign-in',async()=>{
  const f=fixture();await prepareActivation(f);assert.equal(f.requests.length,2);assert.equal(f.helpers.state().draft.mode,'review')
  f.window.ATRIUM_RESIDENT_PORTAL.formToken='tampered';f.setTransport(r=>r.payload?reply(f.activationReceipt(r)):reply(f.portal({invitation:null,reviewToken:null})))
  await f.click('confirm');const post=f.requests.find(r=>r.payload)
  assert.equal(post.payload.invitationVersion,1);assert.equal(post.payload.reviewToken,'PREVIEW_FORM');assert.equal(post.payload.action,'activate_new');assert.equal(post.headers['x-atrium-resident-form'],'CURRENT_RESIDENT_FORM');assert.equal(post.headers['x-atrium-user-id'],undefined)
  assert.equal(f.storage.size,0);assert.match(f.node('resident-notice').textContent,/Activation recorded.*Sign in/);assert.match(f.node('resident-task').innerHTML,/Sign in to resident access/);assert.equal(f.location.href,'')
})

test('existing activation preserves own account and requires recipient checkbox plus password confirmation',async()=>{
  const f=fixture('portal',{signedIn:true});await flush();await f.click('existing');f.node('resident-password').value='synthetic password';await f.submit();assert.equal(f.requests.length,2);assert.match(f.node('resident-notice').textContent,/Confirm that/)
  f.node('resident-recipient-confirm').checked=true;await f.submit();f.setTransport(r=>r.payload?reply(f.activationReceipt(r)):reply(f.portal()));await f.click('confirm')
  const r=f.requests.find(r=>r.payload);assert.deepEqual(Object.keys(r.payload).sort(),['action','requestId','invitationVersion','reviewToken','password'].sort());assert.equal(r.headers['x-atrium-user-id'],'user-resident');assert.equal(r.headers['x-atrium-session-id'],f.boot.sessionId)
})

test('unreadable and wrong activation receipts retain only non-authorizing IDs and never automatically retry',async()=>{
  for(const bad of ['unreadable','request','invitation','account','version']){
    const f=fixture('portal',{signedIn:true});await prepareActivation(f,false)
    f.setTransport(r=>{if(bad==='unreadable')return{ok:true,status:200,json:async()=>{throw Error('broken')}};const d=f.activationReceipt(r);if(bad==='request')d.receipt.requestId=randomUUID();if(bad==='invitation')d.receipt.invitationId=randomUUID();if(bad==='account')d.receipt.userId='foreign';if(bad==='version')d.receipt.bindingVersion=0;return reply(d)})
    await f.click('confirm');assert.match(f.node('resident-notice').textContent,/may have been saved/);const marker=JSON.parse([...f.storage.values()][0]);assert.deepEqual(Object.keys(marker).sort(),['invitationId','requestId']);assert.equal(f.helpers.state().draft,null)
    await f.click('confirm');await f.click('new');assert.equal(f.requests.filter(r=>r.payload).length,1);assert.doesNotMatch([...f.storage.values()].join(),/password|PREVIEW_FORM|resident\.one/)
  }
})

test('activation marker survives sign-in reload and own receipt read clears it without another activation POST',async()=>{
  const f=fixture();await prepareActivation(f);f.setTransport(()=>reply({},503));await f.click('confirm');const marker=JSON.parse([...f.storage.values()][0])
  const next=fixture('portal',{signedIn:true,storage:f.storage});await flush();next.setTransport(r=>r.url.includes('resource=receipt')?reply({...next.identity(),receipt:{requestId:marker.requestId,invitationId:marker.invitationId,bindingId,bindingVersion:1,organizationId:'org-a',propertyId:'property-a',residentId,userId:'user-resident',activatedAt:instant(0),replayed:true}}):reply(next.portal()))
  await next.click('check');assert.equal(next.storage.size,0);assert.equal(next.requests.filter(r=>r.payload).length,0);assert.match(next.node('resident-notice').textContent,/Saved activation confirmed/)
})

test('foreign own-receipt never clears unknown activation and missing receipt is not proof of no save',async()=>{
  for(const wrong of [true,false]){const storage=new Map([['atrium.resident.activation-check.v1',JSON.stringify({requestId:randomUUID(),invitationId})]]),f=fixture('portal',{signedIn:true,storage});await flush();f.setTransport(()=>reply({...f.identity(),...(wrong?{userId:'other'}:{}),receipt:null}));await f.click('check');assert.equal(f.storage.size,1);assert.match(f.node('resident-notice').textContent,wrong?/could not be checked/:/does not prove/)}
})

test('MFA hold hides bindings and activation but retains safe invitation preview and fixed resident verification link',async()=>{
  const f=fixture('portal',{signedIn:true,initial:(_r,c)=>reply(c.portal({mfaRequired:true,bindings:null}))});await flush();assert.match(f.node('resident-content').innerHTML,/\/api\/resident\?resource=mfa/);assert.doesNotMatch(f.node('resident-content').innerHTML,/data-resident="existing"|Current resident access/);await f.click('existing');assert.equal(f.helpers.state().draft,null)
})

test('changed account state is refused before display and late responses cannot restore a retired page',async()=>{
  const f=fixture('portal',{signedIn:true});await flush();f.setTransport(()=>reply(f.portal({userId:'foreign-user',displayName:'PRIVATE FOREIGN'})));await f.helpers.load();assert.doesNotMatch(f.node('resident-content').innerHTML,/PRIVATE FOREIGN/)
  const d=deferred(),g=fixture('portal',{initial:()=>d.promise});g.hide();d.resolve(reply(g.portal()));await flush();assert.equal(g.node('resident-content').innerHTML,'');g.show();assert.equal(g.reloads(),1)
})

test('activation postcommit 401 retires content with an unknown-save warning and retains nonprivate recovery reference',async()=>{
  const f=fixture('portal',{signedIn:true});await prepareActivation(f,false);f.setTransport(()=>reply({code:'enrollment_unauthenticated'},401));await f.click('confirm');assert.equal(f.helpers.state().retired,true);assert.equal(f.node('resident-content').innerHTML,'');assert.match(f.node('resident-recovery').innerHTML,/may have been saved/);assert.equal(f.location.href,'');assert.equal(f.storage.size,1)
})

test('duplicate activation clicks and a bounded timeout cannot send another command or claim success',async()=>{
  const f=fixture();await prepareActivation(f);f.setTransport(r=>new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(new Error('Aborted')))));await f.click('confirm');await f.click('confirm');assert.equal(f.requests.filter(r=>r.payload).length,1);f.expire();await flush();assert.equal(f.helpers.state().busy,false);assert.match(f.node('resident-notice').textContent,/could not be confirmed/);assert.equal(f.storage.size,1)
})

test('password sign-in known rejection permits correction, but malformed success never claims a session',async()=>{
  const f=fixture();await flush();await f.click('sign-in');f.node('resident-username').value='resident.one';f.node('resident-password').value='Synthetic current password';f.setTransport(()=>reply({code:'enrollment_password_incorrect'},400));await f.submit();assert.match(f.node('resident-notice').textContent,/could not be verified/);assert.match(f.node('resident-task').innerHTML,/Sign in/)
  f.node('resident-password').value='Correct synthetic password';f.setTransport(()=>reply({action:'sign_in',audience:'staff',userId:'user-r',sessionId:randomUUID()}));await f.submit();assert.equal(f.location.href,'');assert.equal(f.helpers.state().retired,true)
})

test('logout needs exact resident null identity receipt, and an unconfirmed logout does not navigate',async()=>{
  const f=fixture('portal',{signedIn:true});await flush();f.setTransport(()=>reply({action:'logout',...f.identity()}));await f.click('logout');assert.equal(f.location.href,'');assert.match(f.node('resident-recovery').innerHTML,/Sign-out could not be confirmed/)
  const g=fixture('portal',{signedIn:true});await flush();g.setTransport(()=>reply({action:'logout',audience:'resident',userId:null,sessionId:null}));await g.click('logout');assert.equal(g.location.href,'/api/resident')
})

test('binding pagination validates own account and restores keyboard focus when final control disappears',async()=>{
  const first=connection(),f=fixture('portal',{signedIn:true,initial:(_r,c)=>reply(c.portal({bindings:{items:[first],nextId:first.id}}))});await flush();f.document.activeElement={dataset:{resident:'more'}};f.setTransport(()=>reply({...f.identity(),bindings:{items:[connection('user-resident',{id:randomUUID(),unitId:'14B',state:'revoked'})],nextId:null}}));await f.click('more');assert.equal(f.helpers.state().current.bindings.items.length,2);assert.equal(f.document.activeElement.id,'resident-content');assert.match(f.node('resident-content').innerHTML,/Access revoked/)
})

test('staff policy defaults disabled, uses actual source timestamps and requires explicit local review before POST',async()=>{
  const f=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),policy:null}}))});await flush();await f.click('policy');assert.equal(f.node('access-enabled').checked,false);assert.equal(f.node('access-observed').value,'');assert.equal(f.requests.length,1)
  f.node('access-protocol').value='Check the recipient in person using the approved process.';f.node('access-source').value='Management protocol record';f.node('access-observed').value=instant(-3600000).slice(0,16);f.node('access-until').value=instant(86400000).slice(0,16);f.node('access-reason').value='Configure resident activation';await f.submit();assert.equal(f.helpers.state().draft.command.details.enabled,false);assert.equal(f.requests.length,1);assert.match(f.node('access-task').innerHTML,/Confirm the reviewed change/)
})

test('staff protocol review preserves original milliseconds when displayed UTC minute is unchanged',async()=>{
  const p=policy(),f=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),policy:p}}))});await flush();await f.click('policy');f.node('access-reason').value='Reviewed without changing source';await f.submit();assert.equal(f.helpers.state().draft.command.details.observedAt,p.observedAt);assert.equal(f.helpers.state().draft.command.details.validUntil,p.validUntil)
})

test('staff issue carries exact property/user/session/action/token and link is only manual with validated same-origin URL',async()=>{
  const f=fixture('access');await prepareIssue(f);assert.equal(f.helpers.state().draft.command.action,'issue_invitation');f.window.ATRIUM_RESIDENT_ACCESS.scope.propertyId='tampered';f.setTransport(r=>r.payload?reply({...f.staffReceipt(r),invitationUrl:'https://app.example/api/resident#invite='+'a'.repeat(43)}):reply(f.access()));await f.click('confirm');const r=f.requests.find(r=>r.payload)
  assert.equal(r.headers['x-atrium-property-id'],'property-a');assert.equal(r.headers['x-atrium-enrollment-form'],'CURRENT_SCOPE_FORM');assert.equal(r.headers['x-atrium-enrollment-action'],'issue_invitation');assert.equal(r.headers['x-atrium-resident-id'],residentId);assert.equal(r.payload.expectedResidentVersion,3);assert.equal(r.payload.protocolCompleted,true);assert.equal(r.payload.replaces,null);assert.equal(f.copies(),0);assert.match(f.node('access-link').innerHTML,/No message has been sent/)
  await f.click('copy');assert.equal(f.copies(),1);await f.click('dismiss-link');assert.equal(f.node('access-link').innerHTML,'')
})

test('staff issue requires checked protocol, and existing invitation replacement is explicit rather than silent',async()=>{
  const invitation={id:invitationId,version:2,organizationId:'org-a',propertyId:'property-a',residentId,residentVersion:3,policyVersion:2,configurationVersion:2,state:'pending',createdAt:instant(-1000),expiresAt:instant(3600000),checkedAt:instant(-1000),checkedBy:'user-manager',evidenceReference:'Prior in-person check',deliveryStatus:'not_sent'}
  const f=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),invitation}}))});await flush();await f.click('issue');assert.match(f.node('access-task').innerHTML,/explicitly revokes the previous invitation/);f.node('access-reason').value='Replace unavailable link';await f.submit();assert.equal(f.requests.length,1);assert.match(f.node('access-notice').textContent,/in-person recipient check/);await prepareIssue(f);assert.deepEqual(plain(f.helpers.state().draft.command.replaces),{id:invitationId,version:2})
})

test('staff malformed successful issue is reconciled by read-only receipt without a second POST or fabricated replacement link',async()=>{
  const f=fixture('access');await prepareIssue(f);let original;f.setTransport(r=>{original=r;return reply({})});await f.click('confirm');assert.ok(f.helpers.state().pending);await f.click('issue');await f.click('confirm');assert.equal(f.requests.filter(r=>r.payload).length,1)
  const saved=f.staffReceipt(original,{replayed:true});f.setTransport(r=>r.url.includes('resource=receipt')?reply({...saved,action:'receipt'}):reply(f.access()));await f.click('check');assert.equal(f.requests.filter(r=>r.payload).length,1);assert.equal(f.helpers.state().pending,null);assert.equal(f.node('access-link').innerHTML,'');assert.match(f.node('access-notice').textContent,/cannot be recovered/)
})

test('staff wrong property/session/record/version receipts and foreign invitation URL remain unconfirmed',async()=>{
  for(const bad of ['scope','session','resident','version','url']){const f=fixture('access');await prepareIssue(f);f.setTransport(r=>{const v={...f.staffReceipt(r),invitationUrl:'https://app.example/api/resident#invite='+'a'.repeat(43)};if(bad==='scope')v.scope.propertyId='property-other';if(bad==='session')v.sessionId=randomUUID();if(bad==='resident')v.receipt.residentId=randomUUID();if(bad==='version')v.receipt.version=3;if(bad==='url')v.invitationUrl='https://evil.example/api/resident#invite='+'a'.repeat(43);return reply(v)});await f.click('confirm');assert.ok(f.helpers.state().pending);assert.equal(f.node('access-link').innerHTML,'');assert.match(f.node('access-recovery').innerHTML,/may have been saved/)}
})

test('staff stale occupancy remains visible without issue action and binding revocation is a separate exact target',async()=>{
  const b=connection('user-r'),f=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),resident:{...staffState().resident,contextState:'expired'},binding:b}}))});await flush();assert.match(f.node('access-state').innerHTML,/Occupancy needs review/);assert.doesNotMatch(f.node('access-state').innerHTML,/data-access="issue"/);await f.click('revoke_binding');f.node('access-reason').value='Resident requested access removal';await f.submit();assert.equal(f.helpers.state().draft.command.id,b.id);assert.equal(f.helpers.state().draft.command.action,'revoke_binding')
})

test('staff read error remains retryable; postcommit authorization error requires deliberate navigation and pagehide clears private link',async()=>{
  const f=fixture('access',{initial:()=>reply({},503)});await flush();assert.equal(f.node('access-refresh').disabled,false);f.setTransport(()=>reply(f.access()));await f.helpers.load();await prepareIssue(f);f.setTransport(()=>reply({code:'enrollment_unauthenticated'},401));await f.click('confirm');assert.equal(f.helpers.state().retired,true);assert.match(f.node('access-recovery').innerHTML,/may have been saved/);assert.equal(f.location.href,'');f.hide();assert.equal(f.node('access-state').innerHTML,'');f.show();assert.equal(f.reloads(),1)
})

test('resident MFA page contains resident-only endpoints and never Team or staff navigation',()=>{
  const mfa={securityVersion:1,required:true,everEnabled:false,sessionVerified:false,manageVerified:false,administratorVerified:false,factors:[],recoveryRemaining:0},principal={audience:'resident',userId:'user-r',sessionId:randomUUID(),username:'resident',displayName:'Sam'}
  const html=renderMfaPage({principal,formToken:'form',nonce:'nonce',state:mfa},'')
  assert.match(html,/\/api\/resident\?resource=mfa/);assert.match(html,/Back to resident access/);assert.doesNotMatch(html,/\/api\/organizations|\/api\/dashboard|\/api\/account/)
  const staff=renderMfaPage({principal:{...principal,audience:'staff'},formToken:'form',nonce:'nonce',state:mfa},'');assert.match(staff,/\/api\/organizations/);assert.match(staff,/\/api\/mfa/)
})

test('cross-site anonymous HTML adopts full same-origin resident identity once before fragment exchange, then freezes it',async()=>{
  const sid=randomUUID();let gets=0,exchange
  const f=fixture('portal',{hash:'#invite='+'a'.repeat(43),initial:(r,c)=>{const current={...c.portal(),userId:'user-resident',sessionId:sid,username:'resident.one',displayName:'Sam',bindings:{items:[connection()],nextId:null}};if(r.payload){exchange=r;return reply({action:'exchange',audience:'resident',userId:'user-resident',sessionId:sid})}gets++;return reply(current)}});await flush()
  assert.equal(gets,2);assert.equal(exchange.headers['x-atrium-user-id'],'user-resident');assert.equal(exchange.headers['x-atrium-session-id'],sid);assert.equal(exchange.headers['x-atrium-resident-form'],'CURRENT_RESIDENT_FORM');assert.match(f.node('resident-content').innerHTML,/Review activation with this account/)
  f.setTransport(()=>reply({...f.portal(),userId:'other',sessionId:randomUUID(),username:'other',displayName:'OTHER PRIVATE',bindings:{items:[],nextId:null}}));await f.helpers.load();assert.doesNotMatch(f.node('resident-content').innerHTML,/OTHER PRIVATE/)
})

test('failed initial identity check retains stripped fragment only in memory and offers read retry without anonymous POST',async()=>{
  const f=fixture('portal',{hash:'#invite='+'a'.repeat(43),initial:()=>reply({},503)});await flush();assert.equal(f.location.hash,'');assert.equal(f.requests.filter(r=>r.payload).length,0);assert.equal(f.storage.size,0);assert.match(f.node('resident-content').innerHTML,/Retry identity check/)
  f.setTransport(r=>r.payload?reply({action:'exchange',...f.identity()}):reply(f.portal()));await f.click('initialize');assert.equal(f.requests.filter(r=>r.payload?.action==='exchange').length,1);assert.match(f.node('resident-content').innerHTML,/Sample House/)
})

test('resident MFA client fixes its endpoint and rejects administrator ceremonies even when a forged click is supplied',async()=>{
  const source=(await readFile(new URL('../../src/auth/mfa-client.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/,'').replace('export function mountMfaClient()','function mountMfaClient()')
  const nodes=new Map(),events=new Map(),requests=[],node=key=>{if(!nodes.has(key))nodes.set(key,{id:key,innerHTML:'',textContent:'',hidden:false,dataset:{},value:'',querySelectorAll:()=>[],contains:()=>true,addEventListener:(name,fn)=>events.set(name,fn),focus(){}});return nodes.get(key)}
  const state={securityVersion:1,required:true,everEnabled:true,sessionVerified:true,manageVerified:false,administratorVerified:false,factors:[{id:randomUUID(),label:'Synthetic passkey',status:'active',createdAt:Date.now()-1000,lastUsedAt:null}],recoveryRemaining:0}
  const boot={audience:'resident',userId:'user-r',sessionId:randomUUID(),formToken:'resident-mfa-form',state}
  const window={ATRIUM_MFA:boot,addEventListener(){}}
  runInNewContext(source,{window,document:{getElementById:node},Date,AbortController,crypto:{randomUUID},setTimeout,clearTimeout,startRegistration:async()=>({}),startAuthentication:async()=>({}),fetch:async(path,options)=>{requests.push({path,...options,payload:JSON.parse(options.body)});return{status:400,json:async()=>({code:'incorrect_password'})}}})
  assert.doesNotMatch(node('mfa-summary').innerHTML,/Verify administrator access/)
  await events.get('click')({target:{closest:()=>({disabled:false,dataset:{action:'organization_administration'}})}});assert.equal(requests.length,0)
  await events.get('click')({target:{closest:()=>({disabled:false,dataset:{action:'add'}})}});node('mfa-password').value='Synthetic password';node('mfa-label').value='Phone';await events.get('submit')({target:{id:'mfa-action-form'},preventDefault(){}})
  assert.equal(requests[0].path,'/api/resident?resource=mfa');assert.equal(requests[0].headers['x-atrium-account-action'],'password');assert.equal(requests[0].headers['x-atrium-user-id'],'user-r')
})

test('disabled or stale policy does not hide revocation of an unconsumed stale or expired invitation',async()=>{
  for(const state of ['stale','expired']){
    const invitation={id:invitationId,version:2,organizationId:'org-a',propertyId:'property-a',residentId,residentVersion:3,policyVersion:2,configurationVersion:2,state,createdAt:instant(-1000),expiresAt:instant(state==='expired'?-500:3600000),checkedAt:instant(-1000),checkedBy:'user-manager',evidenceReference:'Prior in-person check',deliveryStatus:'not_sent'}
    const f=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),policy:{...policy(),enabled:false,current:false},invitation}}))});await flush();assert.match(f.node('access-state').innerHTML,/data-access="revoke_invitation"/);assert.doesNotMatch(f.node('access-state').innerHTML,/data-access="issue"/);await f.click('revoke_invitation');f.node('access-reason').value='Withdraw unused invitation';await f.submit();assert.equal(f.helpers.state().draft.command.id,invitationId);assert.equal(f.helpers.state().draft.command.expectedVersion,2)
  }
})

test('existing password correction refreshes current invitation and keeps the same request reference for explicit resubmission',async()=>{
  const f=fixture('portal',{signedIn:true});await prepareActivation(f,false);let first
  f.setTransport(r=>{if(r.payload){first=r;return reply({code:'enrollment_password_incorrect'},400)}return reply(f.portal())});await f.click('confirm')
  assert.equal(f.storage.size,1);assert.match(f.node('resident-notice').textContent,/Current invitation details have been refreshed/);assert.equal(f.node('resident-password').value,'');assert.equal(f.requests.filter(r=>r.payload).length,1)
  f.node('resident-password').value='Corrected synthetic password';f.node('resident-recipient-confirm').checked=true;await f.submit();assert.equal(f.helpers.state().draft.command.requestId,first.payload.requestId)
  f.setTransport(r=>r.payload?reply(f.activationReceipt(r)):reply(f.portal()));await f.click('confirm');assert.equal(f.requests.filter(r=>r.payload).length,2);assert.match(f.node('resident-notice').textContent,/Activation recorded/)
})

test('password rejection with changed invitation retains reconciliation instead of creating a fresh activation',async()=>{
  const f=fixture('portal',{signedIn:true});await prepareActivation(f,false);f.setTransport(r=>r.payload?reply({code:'enrollment_password_incorrect'},400):reply(f.portal({invitation:null,reviewToken:null})));await f.click('confirm');assert.equal(f.storage.size,1);assert.equal(f.helpers.state().draft,null);assert.match(f.node('resident-recovery').innerHTML,/no longer available/)
})

test('consumed or revoked invitation history is not sent as a replacement, and an active binding blocks new issue',async()=>{
  for(const state of ['consumed','revoked']){
    const invitation={id:invitationId,version:2,organizationId:'org-a',propertyId:'property-a',residentId,residentVersion:3,policyVersion:2,configurationVersion:2,state,createdAt:instant(-1000),expiresAt:instant(3600000),checkedAt:instant(-1000),checkedBy:'user-manager',evidenceReference:'Prior in-person check',deliveryStatus:'not_sent'}
    const f=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),invitation,binding:connection('user-r',{state:'revoked',revokedAt:instant(0)})}}))});await prepareIssue(f);assert.equal(f.helpers.state().draft.command.replaces,null);assert.doesNotMatch(f.node('access-task').innerHTML,/Will be revoked/)
  }
  const g=fixture('access',{initial:(_r,c)=>reply(c.access({state:{...staffState(),binding:connection('user-r',{state:'policy_changed'})}}))});await flush();assert.doesNotMatch(g.node('access-state').innerHTML,/data-access="issue"/);await g.click('issue');assert.equal(g.helpers.state().draft,null)
})

test('resident reauthenticate entry opens sign-in without a command and accepts existing display names up to 200 characters',async()=>{
  const f=fixture('portal',{signedIn:true,reauthenticate:true,initial:(_r,c)=>reply(c.portal({displayName:'S'.repeat(200)}))});await flush();assert.match(f.node('resident-task').innerHTML,/Sign in to resident access/);assert.equal(f.helpers.state().retired,false);assert.equal(f.helpers.state().current.displayName.length,200)
})

test('password correction close and reopen keeps its marker and original operation ID until reconciled',async()=>{
  const f=fixture('portal',{signedIn:true});await prepareActivation(f,false);let original
  f.setTransport(r=>{if(r.payload){original=r;return reply({code:'enrollment_password_incorrect'},400)}return reply(f.portal())});await f.click('confirm');await f.click('close');assert.equal(f.storage.size,1);await f.click('existing');f.node('resident-password').value='Corrected synthetic password';f.node('resident-recipient-confirm').checked=true;await f.submit();assert.equal(f.helpers.state().draft.command.requestId,original.payload.requestId);assert.equal(f.storage.size,1)
})

test('definite taken-username refusal refreshes the same guest invitation before explicit new-name review with a fresh ID',async()=>{
  const f=fixture();await prepareActivation(f);let original
  f.setTransport(r=>{if(r.payload){original=r;return reply({code:'enrollment_username_unavailable'},409)}return reply(f.portal())});await f.click('confirm');assert.match(f.node('resident-notice').textContent,/username is unavailable/);assert.equal(f.storage.size,0);assert.equal(f.requests.filter(r=>r.payload).length,1);assert.equal(f.node('resident-new-password').value,'')
  f.node('resident-username').value='different.resident';f.node('resident-display-name').value='Same recipient';f.node('resident-new-password').value='Synthetic different password';f.node('resident-confirm-password').value='Synthetic different password';f.node('resident-recipient-confirm').checked=true;await f.submit();assert.notEqual(f.helpers.state().draft.command.requestId,original.payload.requestId);assert.equal(f.helpers.state().draft.command.invitationVersion,original.payload.invitationVersion)
})
