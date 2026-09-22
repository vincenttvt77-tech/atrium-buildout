const object = v => !!v && typeof v === 'object' && !Array.isArray(v)
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const version = v => Number.isSafeInteger(v) && v > 0
const text = (v, max = 240) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const facts = rows => '<dl class="facts">' + rows.map(([a,b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('') + '</dl>'
const STATES = { current:'Current', revoked:'Revoked', policy_changed:'Property protocol changed', context_changed:'Occupancy context changed', account_unavailable:'Account unavailable', pending:'Awaiting resident activation', expired:'Expired', consumed:'Used', stale:'Needs review' }
const ERRORS = { mfa_required:'Verify administrator access with your passkey, then reload this page.', enrollment_changed:'The resident or property protocol changed. Refresh and review the current record.', enrollment_forbidden:'Your current authority does not permit this change.', enrollment_unauthenticated:'Your sign-in ended.', invalid_enrollment_form:'This security form is no longer current.', account_changed:'The signed-in account changed.', enrollment_invalid_input:'Review the entered details.', enrollment_rate_limited:'Too many attempts. Wait before trying again.' }
class Unconfirmed extends Error {}
class Rejected extends Error { constructor(code, status) { super(ERRORS[code] || 'The result could not be confirmed.'); this.code = code; this.status = status } }
const sameScope = (a,b) => object(a) && ['organizationId','propertyId','configurationVersion','permissionVersion'].every(k => a[k] === b[k])
function readState(value, binding) {
  if (!object(value) || value.action !== 'state' || value.userId !== binding.userId || value.sessionId !== binding.sessionId || value.residentId !== binding.residentId || !sameScope(value.scope,binding.scope) || !text(value.formToken,4096)) throw new Unconfirmed()
  const s = value.state, r = s?.resident, p = s?.policy, invitation = s?.invitation, b = s?.binding
  if (!object(s) || !object(r) || r.id !== binding.residentId || !version(r.version) || !text(r.displayName,120) || !id(r.unitId) || !['current','expired','revoked','not_started','ended'].includes(r.contextState) || typeof s.canManage !== 'boolean') throw new Unconfirmed()
  const scoped = item => object(item) && item.organizationId === binding.scope.organizationId && item.propertyId === binding.scope.propertyId && version(item.version)
  if (p !== null && (!scoped(p) || typeof p.enabled !== 'boolean' || typeof p.current !== 'boolean' || p.method !== 'in_person_staff_check' || !text(p.protocol,2000) || !text(p.sourceReference) || !iso(p.observedAt) || !iso(p.validUntil) || !iso(p.publishedAt) || !id(p.publishedBy) || !Number.isInteger(p.invitationLifetimeMinutes) || p.invitationLifetimeMinutes < 15 || p.invitationLifetimeMinutes > 1440)) throw new Unconfirmed()
  if (invitation !== null && (!scoped(invitation) || !uuid(invitation.id) || invitation.residentId !== r.id || !version(invitation.residentVersion) || !version(invitation.policyVersion) || !version(invitation.configurationVersion) || !['pending','expired','revoked','consumed','stale'].includes(invitation.state) || !iso(invitation.createdAt) || !iso(invitation.expiresAt) || !iso(invitation.checkedAt) || !id(invitation.checkedBy) || !text(invitation.evidenceReference) || invitation.deliveryStatus !== 'not_sent')) throw new Unconfirmed()
  if (b !== null && (!scoped(b) || !uuid(b.id) || b.residentId !== r.id || !version(b.residentVersion) || !version(b.policyVersion) || !id(b.userId) || !uuid(b.invitationId) || !id(b.unitId) || !iso(b.activatedAt) || !(b.revokedAt === null || iso(b.revokedAt)) || !['current','revoked','policy_changed','context_changed','account_unavailable'].includes(b.state))) throw new Unconfirmed()
  return { state: JSON.parse(JSON.stringify(s)), formToken:value.formToken }
}
function readReceipt(value, binding, command, recovery = false) {
  if (!object(value) || value.action !== (recovery ? 'receipt' : command.action) || value.userId !== binding.userId || value.sessionId !== binding.sessionId || value.residentId !== binding.residentId || !sameScope(value.scope,binding.scope)) throw new Unconfirmed()
  if (recovery && value.receipt === null) return null
  const r = value.receipt, policy = command.action === 'publish_policy', expected = command.action === 'issue_invitation' ? 1 : (command.expectedVersion ?? 0) + 1
  if (!object(r) || r.action !== command.action || r.requestId !== command.requestId || r.actorUserId !== binding.userId || r.organizationId !== binding.scope.organizationId || r.propertyId !== binding.scope.propertyId || r.residentId !== (policy ? null : binding.residentId) || r.version !== expected || !iso(r.recordedAt) || typeof r.replayed !== 'boolean' || (policy ? r.id !== binding.scope.propertyId : !uuid(r.id)) || (command.id && r.id !== command.id)) throw new Unconfirmed()
  return r
}

export function mountResidentAccessClient() {
  const root = document.getElementById('access-root'), el = id => document.getElementById(id), boot = window.ATRIUM_RESIDENT_ACCESS
  if (!root) return
  let binding, state = null, formToken = null, busy = false, retired = false, generation = 0, draft = null, pending = null, secretUrl = null
  const controllers = new Set()
  const notice = (message, error = false) => { el('access-notice').textContent = message; el('access-notice').dataset.error = String(error) }
  const close = () => { draft = null; el('access-task').innerHTML = ''; el('access-task').hidden = true }
  function clearLink() { secretUrl = null; el('access-link').innerHTML = ''; el('access-link').hidden = true }
  function controls() { root.querySelectorAll('button,input,textarea,select').forEach(c => { c.disabled = retired || busy || (Boolean(pending) && !['check','dismiss-link'].includes(c.dataset.access)) || (c.dataset.requiresManage === 'true' && !state?.canManage) }); el('access-refresh').disabled = retired || busy || Boolean(pending) }
  function retire(message, mfa = false) {
    retired = true; generation++; controllers.forEach(c => c.abort()); state = null; formToken = null; close(); clearLink(); el('access-state').innerHTML = ''
    el('access-recovery').hidden = false
    el('access-recovery').innerHTML = `<h2>Check access before continuing</h2><p>${esc(message)}</p><div class="actions">${mfa ? '<a class="button" href="/api/mfa">Verify administrator access</a>' : ''}<a class="button secondary" href="${esc(location.pathname + location.search)}">Reload current access</a><a class="link" href="/api/dashboard?reauthenticate=1">Sign in again</a></div>`
    notice(message,true); controls(); el('access-recovery').focus()
  }
  try {
    if (!object(boot) || !id(boot.userId) || !uuid(boot.sessionId) || !uuid(boot.residentId) || !object(boot.scope) || !id(boot.scope.organizationId) || !id(boot.scope.propertyId) || !version(boot.scope.configurationVersion) || !/^[A-Za-z0-9_-]{43}$/.test(boot.scope.permissionVersion) || !text(boot.formToken,4096)) throw new Unconfirmed()
    binding = Object.freeze({ userId:boot.userId, sessionId:boot.sessionId, residentId:boot.residentId, scope:Object.freeze({...boot.scope}) }); formToken = boot.formToken
  } catch { retire('This page could not be verified. Reload before continuing.'); return }
  async function api(resource, command) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),15000); controllers.add(controller)
    const headers = { 'x-atrium-user-id':binding.userId, 'x-atrium-session-id':binding.sessionId, 'x-atrium-organization-id':binding.scope.organizationId, 'x-atrium-property-id':binding.scope.propertyId, 'x-atrium-config-version':String(binding.scope.configurationVersion) }
    let url = '/api/resident-access?format=json&resource=' + resource + '&residentId=' + encodeURIComponent(binding.residentId)
    if (resource === 'receipt') url += '&requestId=' + encodeURIComponent(pending.command.requestId)
    if (command) { url = '/api/resident-access'; Object.assign(headers,{ 'Content-Type':'application/json', 'x-atrium-enrollment-form':pending.formToken, 'x-atrium-enrollment-action':command.action, 'x-atrium-resident-id':binding.residentId }) }
    try {
      const response = await fetch(url,{method:command ? 'POST':'GET',headers,credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,...(command ? {body:JSON.stringify(command)} : {})})
      let data; try { data = await response.json() } catch { throw new Unconfirmed() }
      if (!response.ok) throw new Rejected(object(data) ? data.code : null,response.status)
      return data
    } finally { clearTimeout(timer); controllers.delete(controller) }
  }
  function render() {
    if (!state) return
    const p = state.policy, r = state.resident, inv = state.invitation, b = state.binding, replaceable = inv && ['pending','stale','expired'].includes(inv.state), activeBinding = b && b.revokedAt === null && b.state !== 'revoked'
    el('access-state').innerHTML = `<section class="panel"><div class="status-row"><div><span class="eyebrow">CURRENT RESIDENT RECORD</span><h2>${esc(r.displayName)}</h2><p>Apartment ${esc(r.unitId)}</p></div><span class="badge ${r.contextState !== 'current' ? 'warn':''}">${esc(r.contextState === 'current' ? 'Current occupancy source' : 'Occupancy needs review')}</span></div><p class="hint">The occupancy record does not verify the person receiving an invitation.</p></section><div class="grid"><section class="panel"><span class="eyebrow">1 · PROPERTY PROTOCOL</span><h2>${p?.enabled && p.current ? 'Enrollment enabled':'Enrollment held'}</h2>${p ? facts([['Required recipient check',p.protocol],['Protocol source',p.sourceReference],['Valid until (UTC)',p.validUntil],['Invitation lifetime',p.invitationLifetimeMinutes + ' minutes']]) : '<p>No property enrollment protocol has been published.</p>'}${state.canManage ? '<button type="button" data-access="policy">Review property protocol</button>' : '<p>Property management must configure the enrollment protocol.</p>'}</section><section class="panel"><span class="eyebrow">2 · PRIVATE INVITATION</span><h2>${inv ? esc(STATES[inv.state]) : 'No invitation prepared'}</h2>${inv ? facts([['Recipient check (UTC)',inv.checkedAt],['Evidence reference',inv.evidenceReference],['Expires (UTC)',inv.expiresAt]]) : '<p>Complete the approved in-person check before preparing an invitation.</p>'}<p class="hint">Manual handoff only. No email or text message is sent.</p>${state.canManage ? `<div class="actions">${p?.current && p.enabled && r.contextState === 'current' && !activeBinding ? `<button type="button" data-access="issue">${replaceable ? 'Review replacement invitation':'Prepare invitation'}</button>` : ''}${inv && ['pending','stale','expired'].includes(inv.state) ? '<button type="button" class="danger" data-access="revoke_invitation">Revoke invitation</button>':''}</div>`:''}</section></div><section class="panel"><span class="eyebrow">3 · ACCOUNT ACCESS</span><h2>${b ? esc(STATES[b.state]) : 'Not activated'}</h2>${b ? facts([['Activated (UTC)',b.activatedAt],['Apartment',b.unitId]]) : '<p>The resident chooses their own account and password. A prepared invitation is not activated access.</p>'}${b && b.state !== 'revoked' && state.canManage ? '<button type="button" class="danger" data-access="revoke_binding">Revoke resident account access</button>':''}<p class="hint">Revoking an invitation does not revoke an already activated binding. Account access grants no work consent or entry permission.</p></section>`
    el('access-state').setAttribute('aria-busy','false'); controls()
  }
  async function load() {
    if (busy || retired || pending) return
    const epoch = ++generation; busy = true; close(); clearLink(); controls()
    try { const result = readState(await api('state'),binding); if (retired || epoch !== generation) return; state = result.state; formToken = result.formToken; render(); notice('Current resident access loaded.') }
    catch (e) { if (retired || epoch !== generation) return; if (e instanceof Rejected && [401,403].includes(e.status)) retire(e.message,e.code === 'mfa_required'); else { state = null; el('access-state').innerHTML = '<div class="panel"><h2>Current access could not be loaded</h2><p>Refresh to check the record before making a change.</p></div>'; notice(e.message || 'Current access could not be confirmed.',true) } }
    finally { busy = false; controls() }
  }
  const input = (key,label,value='',type='text',max=240) => `<label for="access-${key}">${label}</label><input id="access-${key}" type="${type}" value="${esc(value)}" maxlength="${max}" required>`
  const area = (key,label,value='',max=1000) => `<label for="access-${key}">${label}</label><textarea id="access-${key}" maxlength="${max}" required>${esc(value)}</textarea>`
  const dateValue = value => value ? value.slice(0,16) : ''
  function open(action) {
    if (busy || retired || pending || !state?.canManage) return
    if (action === 'issue' && (!state.policy?.current || !state.policy.enabled || state.resident.contextState !== 'current' || state.binding && state.binding.revokedAt === null && state.binding.state !== 'revoked')) return
    clearLink(); draft = { action }; const p = state.policy, replaceable = state.invitation && ['pending','stale','expired'].includes(state.invitation.state)
    let html = '<span class="step">Review the change before saving</span>'
    if (action === 'policy') html += '<h2>Property enrollment protocol</h2><p>Publishing replaces the property protocol. Older invitations and bindings may need a new review.</p>' + `<label class="check"><input id="access-enabled" type="checkbox"${p?.enabled ? ' checked':''}>Enable resident enrollment under this protocol</label>` + area('protocol','Required in-person recipient check',p?.protocol || '',2000) + input('source','Protocol source reference',p?.sourceReference || '') + input('observed','Protocol observed at (UTC)',dateValue(p?.observedAt),'datetime-local') + input('until','Protocol valid until (UTC; up to 90 days)',dateValue(p?.validUntil),'datetime-local') + input('lifetime','Invitation lifetime in minutes (15–1440)',p?.invitationLifetimeMinutes || 60,'number')
    else if (action === 'issue') html += `<h2>${replaceable ? 'Replace the existing invitation':'Prepare a private invitation'}</h2><p>${replaceable ? 'This explicitly revokes the previous invitation. It does not remove an activated account binding.':'The resident will choose a new account or sign in to an existing account.'}</p>` + facts([['Recipient',state.resident.displayName],['Apartment',state.resident.unitId],['Required check',p.protocol]]) + input('checked-at','In-person recipient check completed at (UTC; within 24 hours)','','datetime-local') + input('evidence','Recipient check evidence reference') + '<label class="check"><input id="access-checked" type="checkbox" required>I completed the current property protocol with this recipient in person.</label>'
    else html += `<h2>${action === 'revoke_binding' ? 'Revoke activated resident access':'Revoke the invitation'}</h2><p>${action === 'revoke_binding' ? 'This removes this property’s resident account binding. It does not change their password or other property access.' : 'This prevents use of this invitation. Existing activated access is managed separately.'}</p>`
    html += area('reason','Reason for this change') + '<div class="actions"><button type="submit">Review change</button><button type="button" class="secondary" data-access="close">Cancel</button></div>'
    el('access-task').innerHTML = `<form id="access-form" method="post" action="/api/resident-access">${html}</form>`; el('access-task').hidden = false; el('access-task').focus(); controls()
  }
  function utc(key,original) { const raw = el('access-' + key).value; if (original && raw === dateValue(original)) return original; const result = new Date(raw + ':00.000Z').toISOString(); if (!iso(result)) throw new Error('Enter a valid UTC date and time.'); return result }
  function review() {
    if (busy || retired || !draft || pending) return
    try {
      const reason = el('access-reason').value.trim(); if (!text(reason,1000) || reason.length < 3) throw new Error('Enter a reason of at least 3 characters.')
      let command, details
      if (draft.action === 'policy') {
        details = { enabled:el('access-enabled').checked, method:'in_person_staff_check', protocol:el('access-protocol').value.trim(), invitationLifetimeMinutes:Number(el('access-lifetime').value), sourceReference:el('access-source').value.trim(), observedAt:utc('observed',state.policy?.observedAt), validUntil:utc('until',state.policy?.validUntil) }
        if (details.protocol.length < 20 || !text(details.protocol,2000) || details.sourceReference.length < 3 || !text(details.sourceReference) || !Number.isInteger(details.invitationLifetimeMinutes) || details.invitationLifetimeMinutes < 15 || details.invitationLifetimeMinutes > 1440 || Date.parse(details.validUntil) <= Date.parse(details.observedAt) || Date.parse(details.validUntil)-Date.parse(details.observedAt) > 90*86400000) throw new Error('Review the protocol, source dates and invitation lifetime.')
        command = {action:'publish_policy',requestId:crypto.randomUUID(),expectedVersion:state.policy?.version ?? null,details,reason}
      } else if (draft.action === 'issue') {
        if (!el('access-checked').checked || !state.policy?.current || !state.policy.enabled || state.resident.contextState !== 'current') throw new Error('Complete the in-person recipient check under the current protocol first.')
        const checkedAt = utc('checked-at'), evidenceReference = el('access-evidence').value.trim()
        if (!text(evidenceReference) || evidenceReference.length < 3 || Date.parse(checkedAt) > Date.now() + 5000 || Date.parse(checkedAt) < Date.now()-86400000) throw new Error('Enter a recent check time and its evidence reference.')
        command = {action:'issue_invitation',requestId:crypto.randomUUID(),residentId:binding.residentId,expectedResidentVersion:state.resident.version,expectedPolicyVersion:state.policy.version,replaces:state.invitation && ['pending','stale','expired'].includes(state.invitation.state) ? {id:state.invitation.id,version:state.invitation.version}:null,checkedAt,evidenceReference,protocolCompleted:true,reason}
      } else { const target = draft.action === 'revoke_binding' ? state.binding : state.invitation; command = {action:draft.action,requestId:crypto.randomUUID(),id:target.id,expectedVersion:target.version,reason} }
      draft = {command,formToken}; el('access-task').innerHTML = '<span class="step">Confirm the reviewed change</span><h2>' + (command.action === 'publish_policy' ? 'Publish property protocol' : command.action === 'issue_invitation' ? 'Prepare private invitation' : 'Revoke access') + '</h2>' + facts(command.action === 'publish_policy' ? [['Enrollment',details.enabled ? 'Enabled':'Disabled'],['Protocol',details.protocol],['Source reference',details.sourceReference],['Observed (UTC)',details.observedAt],['Valid until (UTC)',details.validUntil],['Invitation lifetime',details.invitationLifetimeMinutes + ' minutes'],['Reason',reason]] : command.action === 'issue_invitation' ? [['Recipient',state.resident.displayName],['Apartment',state.resident.unitId],['Previous invitation',command.replaces ? 'Will be revoked':'None'],['Check completed (UTC)',command.checkedAt],['Evidence reference',command.evidenceReference],['Reason',reason]] : [['Change',command.action === 'revoke_binding' ? 'Revoke activated binding':'Revoke invitation'],['Reason',reason]]) + '<p>No message is sent. This does not approve work or entry.</p><div class="actions"><button type="button" data-access="confirm">Confirm change</button><button type="button" class="secondary" data-access="close">Cancel</button></div>'; el('access-task').focus()
    } catch(e) { notice(e.message || 'Review the details.',true) }
  }
  function uncertain(e) {
    close(); clearLink(); const message = 'This change may have been saved, but its result could not be confirmed. Check the saved receipt before preparing another change.'
    if (e instanceof Rejected && [401,403].includes(e.status)) { retire(message + ' ' + e.message,e.code === 'mfa_required'); return }
    el('access-recovery').hidden = false; el('access-recovery').innerHTML = `<h2>Check the saved result</h2><p>${message}</p><button type="button" data-access="check">Check saved receipt</button><p class="hint">If an invitation was saved, its private link cannot be recovered from a receipt. After checking, explicitly replace it to prepare a new link.</p>`; notice(message,true); el('access-recovery').focus(); controls()
  }
  function showLink(url) {
    secretUrl = url; el('access-link').hidden = false; el('access-link').innerHTML = '<h2>Private invitation prepared</h2><p>Hand this link only to the recipient you checked. It is shown now and is not stored in this page after navigation. No message has been sent.</p><label for="access-private-url">Invitation link</label><input id="access-private-url" class="private-copy" readonly><div class="actions"><button type="button" data-access="copy">Copy link</button><button type="button" class="secondary" data-access="dismiss-link">Hide link</button></div>'; el('access-private-url').value = url; el('access-link').focus()
  }
  async function save(check = false) {
    if (busy || retired || (check ? !pending : !draft?.command)) return
    if (!check) { pending = JSON.parse(JSON.stringify(draft)); draft = null }
    const epoch = generation; busy = true; notice(check ? 'Checking the saved receipt…' : 'Saving the reviewed change…'); controls()
    try {
      const result = await api(check ? 'receipt':'',check ? null:pending.command); if (retired || generation !== epoch) return
      const receipt = readReceipt(result,binding,pending.command,check)
      if (!receipt) { notice('No saved receipt is available yet. This does not prove the change was not saved. Check again or ask management to reconcile before creating another invitation.',true); return }
      let url = null
      if (!check && pending.command.action === 'issue_invitation' && !receipt.replayed) {
        const candidate = new URL(result.invitationUrl,location.origin)
        if (candidate.origin !== location.origin || candidate.pathname !== '/api/resident' || candidate.search || candidate.username || candidate.password || !/^#invite=[A-Za-z0-9_-]{43}$/.test(candidate.hash)) throw new Unconfirmed()
        url = candidate.href
      }
      pending = null; close(); el('access-recovery').hidden = true; el('access-recovery').innerHTML = ''; busy = false
      await load()
      if (!retired) { if (url) showLink(url); notice(check || receipt.replayed ? 'Saved change confirmed from its receipt. Current access has been refreshed. An earlier private invitation link cannot be recovered; use an explicit replacement if needed.' : 'Change recorded. Review the current access below.') }
    } catch(e) { if (!retired && generation === epoch) uncertain(e) }
    finally { busy = false; controls() }
  }
  root.addEventListener('submit',event => { event.preventDefault(); if (event.target.id === 'access-form') review() })
  root.addEventListener('click',async event => {
    const button = event.target.closest?.('[data-access]'); if (!button || button.disabled) return
    const action = button.dataset.access
    if (action === 'close') close()
    else if (action === 'confirm') await save()
    else if (action === 'check') await save(true)
    else if (action === 'dismiss-link') clearLink()
    else if (action === 'copy' && secretUrl) { try { await navigator.clipboard.writeText(secretUrl); notice('Invitation link copied. No message sent.') } catch { notice('Copy was not confirmed. Select the private link and copy it manually.',true) } }
    else open(action)
  })
  el('access-refresh').addEventListener('click',load)
  window.addEventListener('pagehide',() => { retired = true; generation++; controllers.forEach(c => c.abort()); pending = null; state = null; formToken = null; close(); clearLink(); el('access-state').innerHTML = ''; el('access-recovery').innerHTML = ''; controls() })
  window.addEventListener('pageshow',event => { if (event.persisted) location.reload() })
  void load()
}
if (typeof window !== 'undefined' && window.ATRIUM_RESIDENT_ACCESS) mountResidentAccessClient()
