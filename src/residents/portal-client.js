const object = v => !!v && typeof v === 'object' && !Array.isArray(v)
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const version = v => Number.isSafeInteger(v) && v > 0
const text = (v,max=240) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const esc = v => String(v ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const STATES = {current:'Current resident access',revoked:'Access revoked',policy_changed:'Property protocol needs review',context_changed:'Occupancy context needs review',account_unavailable:'Account unavailable'}
const ERRORS = { enrollment_password_incorrect:'The password could not be verified. Check it and try again.', enrollment_rate_limited:'Too many attempts. Wait before trying again.', enrollment_username_unavailable:'That username is unavailable. Choose another or sign in to your existing account.', enrollment_invitation_unavailable:'This invitation is unavailable. Sign in to check existing access or ask your property team for a new invitation.', enrollment_invalid_input:'Check the entered information.', enrollment_reconcile_required:'Your access may already be activated. Sign in and check the saved result.', enrollment_changed:'Your sign-in or invitation context changed. Reload before continuing.', enrollment_unauthenticated:'Sign in to continue.', enrollment_forbidden:'The current security form cannot be used. Reload before continuing.', mfa_required:'Verify your resident session with a passkey before continuing.' }
const STORAGE = 'atrium.resident.activation-check.v1'
class Unconfirmed extends Error {}
class Rejected extends Error { constructor(code,status) { super(ERRORS[code] || 'The result could not be confirmed.'); this.code=code; this.status=status } }
function identity(v,b) { if (!object(v) || v.audience !== 'resident' || v.userId !== b.userId || v.sessionId !== b.sessionId) throw new Unconfirmed(); return v }
function preview(v) {
  if (v === null) return null
  if (!object(v) || !uuid(v.invitationId) || !version(v.invitationVersion) || !text(v.propertyName,200) || !id(v.unitId) || !text(v.recipientHint,200) || !iso(v.expiresAt)) throw new Unconfirmed()
  return {invitationId:v.invitationId,invitationVersion:v.invitationVersion,propertyName:v.propertyName,unitId:v.unitId,recipientHint:v.recipientHint,expiresAt:v.expiresAt}
}
function bindings(v,b) {
  if (!object(v) || !Array.isArray(v.items) || v.items.length > 25 || !(v.nextId === null || uuid(v.nextId))) throw new Unconfirmed()
  const items = v.items.map(r => {
    if (!object(r) || !uuid(r.id) || !version(r.version) || r.userId !== b.userId || !id(r.organizationId) || !id(r.propertyId) || !uuid(r.residentId) || !version(r.residentVersion) || !version(r.policyVersion) || !uuid(r.invitationId) || !id(r.unitId) || !iso(r.activatedAt) || !(r.revokedAt === null || iso(r.revokedAt)) || !Object.hasOwn(STATES,r.state) || !text(r.propertyName,200)) throw new Unconfirmed()
    return {id:r.id,version:r.version,userId:r.userId,organizationId:r.organizationId,propertyId:r.propertyId,residentId:r.residentId,unitId:r.unitId,activatedAt:r.activatedAt,revokedAt:r.revokedAt,state:r.state,propertyName:r.propertyName}
  })
  if (new Set(items.map(r=>r.id)).size !== items.length || v.nextId !== null && (!items.length || items.at(-1).id !== v.nextId)) throw new Unconfirmed()
  return {items,nextId:v.nextId}
}
function state(v,b) {
  identity(v,b)
  if (!text(v.formToken,4096) || typeof v.mfaRequired !== 'boolean' || (b.userId ? !text(v.username,64) || !text(v.displayName,200) : v.username !== null || v.displayName !== null) || (v.mfaRequired || !b.userId) && v.bindings !== null) throw new Unconfirmed()
  const invitation = preview(v.invitation)
  if (invitation ? !text(v.reviewToken,4096) : v.reviewToken !== null) throw new Unconfirmed()
  return {formToken:v.formToken,username:v.username,displayName:v.displayName,invitation,reviewToken:v.reviewToken,mfaRequired:v.mfaRequired,bindings:v.bindings === null ? null:bindings(v.bindings,b)}
}
function receipt(v,b,marker,action) {
  identity(v,b)
  if (action && (v.action !== action || v.signInRequired !== true)) throw new Unconfirmed()
  if (!action && v.receipt === null) return null
  const r=v.receipt
  if (!object(r) || r.requestId !== marker.requestId || r.invitationId !== marker.invitationId || !uuid(r.bindingId) || !version(r.bindingVersion) || !id(r.organizationId) || !id(r.propertyId) || !uuid(r.residentId) || !id(r.userId) || b.userId && r.userId !== b.userId || !iso(r.activatedAt) || typeof r.replayed !== 'boolean') throw new Unconfirmed()
  return r
}

export function mountResidentPortalClient() {
  const root=document.getElementById('resident-root'), el=id=>document.getElementById(id), boot=window.ATRIUM_RESIDENT_PORTAL
  if (!root) return
  // Strip a capability from browser history before any asynchronous work or request.
  let invitationToken=null, invalidFragment=false
  if (location.hash) {
    const match=/^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash)
    if (match) invitationToken=match[1]; else invalidFragment=true
    try { history.replaceState(null,'',location.pathname+location.search) } catch { invitationToken=null; invalidFragment=true }
  }
  let binding,current=null,formToken=null,busy=false,retired=false,generation=0,draft=null,recovery=null,correction=null,signInMode=false
  const controllers=new Set()
  const notice=(message,error=false)=>{el('resident-notice').textContent=message;el('resident-notice').dataset.error=String(error)}
  const close=()=>{ draft=null;el('resident-task').innerHTML='';el('resident-task').hidden=true }
  function controls() { root.querySelectorAll('button,input').forEach(c=>{c.disabled=retired||busy||(Boolean(recovery)&&(['new','existing'].includes(c.dataset.resident)&&!correctionReady()||c.dataset.resident==='confirm'&&!draft?.previous))}) }
  function markerWrite(value) { recovery=value;if(!value)correction=null; try { if(value) sessionStorage.setItem(STORAGE,JSON.stringify(value));else sessionStorage.removeItem(STORAGE) } catch { notice('Keep this page open until activation is checked; this browser could not retain the request reference.',true) } }
  function correctionReady(){return !!correction&&!!recovery&&correction.command.requestId===recovery.requestId&&current?.invitation?.invitationId===recovery.invitationId&&current.invitation.invitationVersion===correction.command.invitationVersion&&!current.mfaRequired}
  function recoveryHtml(message='An earlier activation may have been saved. Sign in with the account you chose, then check its saved result before activating again.') {
    if(!recovery)return
    el('resident-recovery').hidden=false;el('resident-recovery').innerHTML=`<h2>Check the activation result</h2><p>${esc(message)}</p><p class="hint">This request reference cannot authorize access. No password or invitation link is retained.</p><div class="actions">${binding.userId?'<button type="button" data-resident="check">Check saved activation</button>':'<button type="button" data-resident="sign-in">Sign in to check</button>'}${correctionReady()?'<button type="button" data-resident="existing">Correct password for this activation</button>':''}<button type="button" class="secondary" data-resident="dismiss-recovery">Dismiss after reconciling</button></div>`
  }
  function retire(message,mfa=false) {
    retired=true;correction=null;generation++;controllers.forEach(c=>c.abort());current=null;formToken=null;invitationToken=null;close();el('resident-content').innerHTML=''
    el('resident-recovery').hidden=false;el('resident-recovery').innerHTML=`<h2>Check your resident access</h2><p>${esc(message)}</p><div class="actions">${mfa?'<a class="button" href="/api/resident?resource=mfa">Verify resident passkey</a>':''}<a class="button secondary" href="/api/resident">Reload resident access</a><a class="link" href="/api/resident?reauthenticate=1">Sign in again</a></div>`;notice(message,true);controls();el('resident-recovery').focus()
  }
  try {
    if (!object(boot)||boot.audience!=='resident'||!text(boot.formToken,4096)||!(boot.userId===null&&boot.sessionId===null||id(boot.userId)&&uuid(boot.sessionId))||typeof boot.reauthenticate!=='boolean')throw new Unconfirmed()
    binding=Object.freeze({userId:boot.userId,sessionId:boot.sessionId});formToken=boot.formToken;signInMode=boot.reauthenticate
    try {const saved=JSON.parse(sessionStorage.getItem(STORAGE)||'null');if(saved&&uuid(saved.requestId)&&uuid(saved.invitationId)&&Object.keys(saved).length===2)recovery={requestId:saved.requestId,invitationId:saved.invitationId};else sessionStorage.removeItem(STORAGE)}catch{}
  }catch{retire('This resident page could not be verified. Reload to continue.');return}
  async function api(resource,command) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);controllers.add(controller)
    const headers={};if(binding.userId){headers['x-atrium-user-id']=binding.userId;headers['x-atrium-session-id']=binding.sessionId}
    let url='/api/resident?format=json&resource='+resource
    if(resource==='bindings')url+='&afterId='+encodeURIComponent(current.bindings.nextId)
    if(resource==='receipt')url+='&requestId='+encodeURIComponent(recovery.requestId)
    if(command){url='/api/resident';headers['Content-Type']='application/json';headers['x-atrium-resident-form']=formToken}
    try{const response=await fetch(url,{method:command?'POST':'GET',headers,credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,...(command?{body:JSON.stringify(command)}:{})});let data;try{data=await response.json()}catch{throw new Unconfirmed()};if(!response.ok)throw new Rejected(object(data)?data.code:null,response.status);return data}
    finally{clearTimeout(timer);controllers.delete(controller)}
  }
  function bindingHtml() {
    const collection=current?.bindings
    if(!collection)return''
    return `<section class="panel"><span class="eyebrow">PROPERTY ACCESS</span><h2>Your resident connections</h2>${collection.items.length?'<ul class="list">'+collection.items.map(r=>`<li><h3>${esc(r.propertyName)}</h3><p>Apartment ${esc(r.unitId)}</p><span class="badge ${r.state!=='current'?'warn':''}">${esc(STATES[r.state])}</span><p class="hint">${r.state==='current'?'Account connection and occupancy are current. No maintenance work or entry has been approved.':'Ask the property team to review this connection. This record remains visible as history.'}</p></li>`).join('')+'</ul>':'<p>No resident connections are currently listed for this account.</p>'}${collection.nextId?'<button type="button" class="secondary" data-resident="more">Load more connections</button>':''}</section>`
  }
  function render() {
    if(!current)return
    const inv=current.invitation,expired=inv&&Date.parse(inv.expiresAt)<=Date.now()
    let html=binding.userId?`<section class="panel"><span class="eyebrow">SIGNED IN</span><h2>${esc(current.displayName)}</h2><p>${esc(current.username)}</p><div class="actions"><a class="button secondary" href="/api/resident?resource=mfa">Resident passkeys</a><button type="button" class="secondary" data-resident="logout">Sign out</button><button type="button" class="secondary" data-resident="sign-in">Use another account</button></div></section>`:'<section class="panel"><h2>Already have an account?</h2><p>Sign in with your own username and password. Your resident session is separate from any staff workspace.</p><button type="button" data-resident="sign-in">Sign in</button></section>'
    if(current.mfaRequired)html+='<section class="panel warning"><h2>Verify your resident session</h2><p>Use your passkey before viewing resident connections or activating an invitation.</p><a class="button" href="/api/resident?resource=mfa">Verify resident passkey</a></section>'
    if(inv)html+=`<section class="panel"><span class="eyebrow">PRIVATE INVITATION</span><h2>${esc(inv.propertyName)}</h2><p>Apartment ${esc(inv.unitId)} · Recipient ${esc(inv.recipientHint)}</p><p class="hint">Expires ${esc(new Date(inv.expiresAt).toLocaleString())}. If these details are not yours, stop and contact the property team.</p>${expired?'<p class="warning">This invitation has expired. Ask the property team for a new one.</p>':!current.mfaRequired&&!recovery?`<div class="actions">${binding.userId?'<button type="button" data-resident="existing">Review activation with this account</button>':'<button type="button" data-resident="new">Create my account and activate</button><button type="button" class="secondary" data-resident="sign-in">Sign in to activate</button>'}</div>`:''}<p class="hint">This connects your account to the resident record. It does not approve work, payment, entry or an appointment.</p></section>`
    else if(!recovery)html+='<section class="panel"><h2>Need a resident invitation?</h2><p>Ask your property team to complete its recipient check and hand you a private invitation link. Matching a phone number or email does not activate access.</p></section>'
    html+=bindingHtml()+'<div class="actions"><button type="button" class="secondary" data-resident="refresh">Refresh current access</button></div>'
    el('resident-content').innerHTML=html;el('resident-content').setAttribute('aria-busy','false');recoveryHtml();controls()
  }
  function input(key,label,type='text',max=120,value='') {return `<label for="resident-${key}">${label}</label><input id="resident-${key}" type="${type}" maxlength="${max}" value="${esc(value)}" autocomplete="${type==='password'?(key==='new-password'||key==='confirm-password'?'new-password':'current-password'):key==='username'?'username':'name'}" required>`}
  function open(mode) {
    if(busy||retired||!current||mode!=='sign-in'&&(recovery&&!(mode==='existing'&&correctionReady())||current.mfaRequired||!current.invitation||Date.parse(current.invitation.expiresAt)<=Date.now()))return
    close();draft={mode,...(mode==='existing'&&correctionReady()?{previous:correction}:{})};let html
    if(mode==='sign-in')html='<h2>Sign in to resident access</h2>'+input('username','Username','text',64,current.username||'')+input('password','Password','password',256)+'<div class="actions"><button type="submit">Sign in</button>'
    else{const inv=current.invitation;html=`<span class="step">Review your invitation</span><h2>${mode==='new'?'Choose your account':'Activate with your account'}</h2><p>${esc(inv.propertyName)} · Apartment ${esc(inv.unitId)} · ${esc(inv.recipientHint)}</p>`+(mode==='new'?input('display-name','Your display name')+input('username','Choose a username','text',64)+input('new-password','Choose a password (at least 15 characters)','password',256)+input('confirm-password','Confirm your password','password',256):`<p>Account: <strong>${esc(current.displayName)}</strong> (${esc(current.username)})</p>`+input('password','Confirm your current password','password',256))+'<label class="check"><input id="resident-recipient-confirm" type="checkbox" required>This invitation is for me and the property and apartment details are correct.</label><p class="hint">This confirmation is account activation only. It is not permission for maintenance or entry.</p><div class="actions"><button type="submit">Review activation</button>'}
    html+='<button type="button" class="secondary" data-resident="close">Cancel</button></div>'
    el('resident-task').innerHTML=`<form id="resident-form" method="post" action="/api/resident">${html}</form>`;el('resident-task').hidden=false;el('resident-task').focus();controls()
  }
  function password(v,fresh=false){if(!text(v,256)||fresh&&[...v].length<15||/[\ud800-\udfff]/u.test(v))throw new Error(fresh?'Choose a password of at least 15 characters.':'Enter your password.');return v}
  async function formSubmit() {
    if(!draft||busy||retired)return
    try{
      if(draft.mode==='sign-in'){const username=el('resident-username').value.trim(),pw=password(el('resident-password').value);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username))throw new Error('Enter your username.');await signIn({action:'sign_in',username,password:pw});return}
      if(!el('resident-recipient-confirm').checked)throw new Error('Confirm that this invitation is for you before continuing.')
      const inv=current.invitation;if(!inv||Date.parse(inv.expiresAt)<=Date.now())throw new Error('The invitation expired. Refresh before continuing.')
      const previous=draft.previous, fresh=draft.mode==='new',pw=password(el(fresh?'resident-new-password':'resident-password').value,fresh)
      if(fresh&&pw!==el('resident-confirm-password').value)throw new Error('The passwords do not match.')
      const username=fresh?el('resident-username').value.trim().toLowerCase():current.username,displayName=fresh?el('resident-display-name').value.trim():current.displayName
      if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)||!text(displayName,fresh?120:200))throw new Error('Review your username and display name.')
      draft={mode:'review',previous,command:{action:fresh?'activate_new':'activate_existing',requestId:previous?.command.requestId||crypto.randomUUID(),invitationVersion:inv.invitationVersion,reviewToken:current.reviewToken,password:pw,...(fresh?{username,displayName}:{})},invitationId:inv.invitationId}
      el('resident-task').innerHTML=`<span class="step">Confirm activation</span><h2>Connect your account</h2><p><strong>${esc(displayName)}</strong> (${esc(username)})</p><p>${esc(inv.propertyName)} · Apartment ${esc(inv.unitId)}</p><p>Only activate if the property team’s invitation is for you. No work, payment or entry is authorized.</p><div class="actions"><button type="button" data-resident="confirm">Activate resident access</button><button type="button" class="secondary" data-resident="close">Cancel</button></div>`;el('resident-task').focus()
    }catch(e){notice(e.message||'Review the details.',true)}
  }
  async function signIn(command) {
    if(busy||retired)return;busy=true;controls();const epoch=generation;close()
    try{const result=await api('',command);if(retired||epoch!==generation)return;if(!object(result)||result.action!=='sign_in'||result.audience!=='resident'||!id(result.userId)||!uuid(result.sessionId))throw new Unconfirmed();location.href='/api/resident'}
    catch(e){if(retired||epoch!==generation)return;if(e instanceof Rejected&&['enrollment_password_incorrect','enrollment_rate_limited'].includes(e.code)){notice(e.message,true);busy=false;open('sign-in');el('resident-username').value=command.username}else retire('Sign-in could not be confirmed. Reload resident access to check the current session. No activation was retried.')}
    finally{command.password='';busy=false;controls()}
  }
  async function activate() {
    if(busy||retired||!draft?.command||recovery&&(!draft.previous||draft.command.requestId!==recovery.requestId||draft.invitationId!==recovery.invitationId))return
    const command=draft.command,marker={requestId:command.requestId,invitationId:draft.invitationId},epoch=generation;markerWrite(marker);close();busy=true;controls()
    try{
      const result=await api('',command);if(retired||epoch!==generation)return;receipt(result,binding,marker,command.action);markerWrite(null);el('resident-recovery').innerHTML='';el('resident-recovery').hidden=true;busy=false
      await load();notice(binding.userId?'Activation recorded. Check your current resident connection below.':'Activation recorded. Sign in with the username and password you chose to check your access.');if(!binding.userId&&!retired)open('sign-in')
    }catch(e){if(retired||epoch!==generation)return;
      if(e instanceof Rejected&&e.code==='enrollment_username_unavailable'&&command.action==='activate_new'){
        busy=false;await load()
        if(!retired&&!binding.userId&&current?.invitation?.invitationId===marker.invitationId&&current.invitation.invitationVersion===command.invitationVersion){
          markerWrite(null);el('resident-recovery').hidden=true;el('resident-recovery').innerHTML='';open('new');notice('That username is unavailable. The current invitation has been refreshed. Choose a different username and explicitly review a new activation request, or sign in to your existing account.',true)
        }else if(!retired){recoveryHtml('That username is unavailable and the current invitation could not be confirmed. Check existing access before starting again.');notice('The username is unavailable. Check current access before continuing.',true)}
        return
      }
      if(e instanceof Rejected&&e.code==='enrollment_password_incorrect'&&command.action==='activate_existing'){
        const previous={command:{...command,password:''},invitationId:marker.invitationId};correction=previous;busy=false;await load()
        if(!retired&&current?.invitation?.invitationId===marker.invitationId&&current.invitation.invitationVersion===command.invitationVersion&&!current.mfaRequired){
          open('existing');recoveryHtml('The password was not verified. You can correct it for this same activation request or check whether an activation was saved.');notice('The password could not be verified. Current invitation details have been refreshed. Correct the password and explicitly review the same activation request.',true)
        }else if(!retired){recoveryHtml('The password could not be verified and the invitation is no longer available for the same activation. Check the saved result before starting again.');notice('Check the activation result before continuing.',true)}
        return
      }
      const message='Activation may have been saved, but its result could not be confirmed. Do not activate again until you have signed in and checked the saved result.';if(e instanceof Rejected&&[401,403].includes(e.status)){retire(message+' '+e.message,e.code==='mfa_required')}else{notice(message,true);recoveryHtml(message);render();el('resident-recovery').focus()}}
    finally{command.password='';busy=false;controls()}
  }
  async function check() {
    if(busy||retired||!recovery||!binding.userId)return;busy=true;controls();const epoch=generation
    try{const result=receipt(await api('receipt'),binding,recovery);if(retired||epoch!==generation)return;if(!result){notice('No saved activation for this request is available to this account. This does not prove it was not saved. Check the chosen account or contact the property team before activating again.',true);return}markerWrite(null);el('resident-recovery').hidden=true;el('resident-recovery').innerHTML='';busy=false;await load();notice('Saved activation confirmed for your account. Current resident access has been refreshed.')}
    catch(e){if(retired||epoch!==generation)return;if(e instanceof Rejected&&[401,403].includes(e.status))retire('The activation remains unconfirmed. '+e.message,e.code==='mfa_required');else notice('The saved activation could not be checked. Keep this request reference and try checking again.',true)}finally{busy=false;controls()}
  }
  async function logout() {
    if(busy||retired)return;busy=true;close();controls();const epoch=generation
    try{const r=await api('',{action:'logout'});if(retired||epoch!==generation)return;if(!object(r)||r.action!=='logout'||r.audience!=='resident'||r.userId!==null||r.sessionId!==null)throw new Unconfirmed();location.href='/api/resident'}
    catch{if(!retired&&epoch===generation)retire('Sign-out could not be confirmed. Reload to check the current resident session before using a shared device.')}finally{busy=false;controls()}
  }
  async function load(more=false) {
    if(busy||retired)return;const epoch=++generation;busy=true;close();controls()
    const focusedMore=more&&document.activeElement?.dataset?.resident==='more'
    try{
      if(more){const r=identity(await api('bindings'),binding),page=bindings(r.bindings,binding);if(retired||epoch!==generation)return;if(page.items.some(item=>current.bindings.items.some(old=>old.id===item.id)))throw new Unconfirmed();current.bindings={items:[...current.bindings.items,...page.items],nextId:page.nextId}}
      else{const r=state(await api('state'),binding);if(retired||epoch!==generation)return;current=r;formToken=r.formToken}
      render();notice('Current resident access loaded.');if(focusedMore&&!current.bindings.nextId){el('resident-content').setAttribute('tabindex','-1');el('resident-content').focus()}
      if(signInMode){signInMode=false;busy=false;open('sign-in')}
    }catch(e){if(retired||epoch!==generation)return;if(e instanceof Rejected&&[401,403,409].includes(e.status))retire((recovery?'An activation remains unconfirmed. ':'')+e.message,e.code==='mfa_required');else{if(!more){current=null;el('resident-content').innerHTML='<section class="panel"><h2>Resident access could not be loaded</h2><p>Refresh to check current access.</p><button type="button" data-resident="refresh">Refresh current access</button></section>'}notice(e.message||'Current access could not be verified.',true);recoveryHtml()}}
    finally{busy=false;controls()}
  }
  root.addEventListener('submit',event=>{event.preventDefault();if(event.target.id==='resident-form')void formSubmit()})
  root.addEventListener('click',event=>{const c=event.target.closest?.('[data-resident]');if(!c||c.disabled)return;const a=c.dataset.resident;if(a==='close')close();else if(a==='initialize')void start();else if(a==='refresh')void load();else if(a==='more')void load(true);else if(a==='confirm')void activate();else if(a==='check')void check();else if(a==='logout')void logout();else if(a==='dismiss-recovery'){markerWrite(null);el('resident-recovery').hidden=true;el('resident-recovery').innerHTML='';render();notice('Recovery reference dismissed. Check your current access before starting a new activation.')}else open(a)})
  window.addEventListener('pagehide',()=>{retired=true;correction=null;generation++;controllers.forEach(c=>c.abort());current=null;formToken=null;invitationToken=null;close();el('resident-content').innerHTML='';el('resident-recovery').innerHTML='';controls()})
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()})
  async function start(){
    if(busy||retired)return
    // Strict cookies can be omitted on the external navigation that rendered this HTML.
    // Resolve identity once from the same-origin state before exposing any form or sending the capability.
    busy=true;controls();const epoch=generation
    let startupMessage=invalidFragment?'The invitation link could not be read. Ask your property team for the complete private link.':null
    try{
      const data=await api('state');if(retired||epoch!==generation)return
      if(!object(data)||data.audience!=='resident'||!(data.userId===null&&data.sessionId===null||id(data.userId)&&uuid(data.sessionId)))throw new Unconfirmed()
      const candidate=Object.freeze({userId:data.userId,sessionId:data.sessionId}),initial=state(data,candidate)
      binding=candidate;formToken=initial.formToken;current=initial
      if(invitationToken){const token=invitationToken;invitationToken=null;try{const result=identity(await api('',{action:'exchange',token}),binding);if(result.action!=='exchange')throw new Unconfirmed()}catch(e){startupMessage=e.message||'The invitation exchange could not be confirmed. Refresh to check before opening the link again.'}}
      if(retired||epoch!==generation)return
      busy=false;await load();if(startupMessage&&!retired)notice(startupMessage,true)
    }catch(e){if(!retired&&epoch===generation){current=null;el('resident-content').innerHTML='<section class="panel warning"><h2>Check resident identity</h2><p>Current sign-in could not be confirmed. The invitation has not been submitted. Keep this page open and retry the identity check.</p><button type="button" data-resident="initialize">Retry identity check</button></section>';notice('Current resident identity could not be confirmed. No invitation exchange or activation was sent.',true)}}
    finally{busy=false;controls()}
  }
  void start()
}
if(typeof window!=='undefined'&&window.ATRIUM_RESIDENT_PORTAL)mountResidentPortalClient()
