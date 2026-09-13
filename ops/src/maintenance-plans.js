/* Reviewed maintenance plans. Approval never implies entry, dispatch or payment. */
(function () {
'use strict'
const A = window.Atrium
if (!A?.databaseMode || !A.can('operate')) return
const ENDPOINT = '/api/maintenance-plans', esc = A.escapeHtml
const SCOPE = Object.freeze({ organizationId: window.ATRIUM_PROPERTY.organizationId, propertyId: window.ATRIUM_PROPERTY.propertyId })
const CATEGORIES = { plumbing: 'Plumbing', electrical: 'Electrical', heating_cooling: 'Heating & cooling', appliance: 'Appliance', pest: 'Pest', access: 'Access', other: 'Other' }
const RESTRICTIONS = { legal: 'Legal', structural: 'Structural', safety_sensitive: 'Safety sensitive', unusual: 'Unusual work', other_restricted: 'Other restricted work' }
const READINESS = { needs_plan: 'Prepare a work plan', needs_policy: 'Authority rules needed', stale_plan: 'Review the changed plan', needs_context: 'Review request context', emergency_review: 'Emergency review', management_review: 'Management review', awaiting_manager: 'Manager approval needed', awaiting_owner: 'Owner approval needed', rejected: 'Plan rejected', withdrawn: 'Plan withdrawn', awaiting_resident: 'Resident approval not established', awaiting_vendor: 'Vendor readiness needs review', authorized_plan: 'Authorized plan — not dispatched' }
const TIERS = { automatic: 'Within automatic authority', approval_required: 'Approval required', management_escalation: 'Management escalation', emergency: 'Emergency protocol' }
const ERRORS = { planning_invalid_input: 'Review the fields, source dates and spending limits.', planning_not_found: 'This record is no longer available in this property.', planning_version_conflict: 'The case, rules or plan changed. Refresh and review the latest record.', planning_request_conflict: 'This change reference already belongs to a different command. Reload before continuing.', planning_not_ready: 'Current prerequisites do not permit this change. Refresh and review the next step.' }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const id = v => typeof v === 'string' && ID.test(v), obj = v => v && typeof v === 'object' && !Array.isArray(v)
const text = (v, max = 4000) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const instant = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v))
const version = v => Number.isSafeInteger(v) && v > 0, cents = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000000000
const nullable = (v, check) => v === null || check(v), bool = v => typeof v === 'boolean', own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const copy = v => JSON.parse(JSON.stringify(v)), scoped = v => v.organizationId === SCOPE.organizationId && v.propertyId === SCOPE.propertyId
const bad = () => Object.assign(new Error('The planning result could not be verified. Reload before making changes.'), { badJson: true, status: 200 })
function choices(values, allowed) { return Array.isArray(values) && values.length <= Object.keys(allowed).length && values.every(v => own(allowed, v)) && new Set(values).size === values.length }
function readSource(v) { if (!text(v.sourceReference, 240) || !instant(v.observedAt) || !instant(v.validUntil) || Date.parse(v.validUntil) <= Date.parse(v.observedAt)) throw bad() }
function readPolicy(v) {
  if (v === null) return null
  if (!obj(v) || !scoped(v) || !version(v.version) || v.currency !== 'USD' || !nullable(v.automaticLimitCents, cents) || !nullable(v.managerLimitCents, cents) || !cents(v.ownerLimitCents)
    || !choices(v.automaticCategories, CATEGORIES) || !choices(v.excludedCategories, CATEGORIES) || !bool(v.requireResidentApproval) || !bool(v.requireIndependentApprover) || !id(v.publishedBy) || !instant(v.publishedAt)) throw bad()
  readSource(v); return Object.freeze(copy(v))
}
function readVendor(v) {
  if (!obj(v) || !scoped(v) || !id(v.id) || !version(v.version) || !text(v.name, 160) || !v.name || !choices(v.categories, CATEGORIES) || !v.categories.length
    || !['approved', 'suspended'].includes(v.status) || !nullable(v.phone, x => text(x, 32)) || !nullable(v.email, x => text(x, 254)) || !text(v.serviceArea, 500) || !text(v.hours, 500)
    || !bool(v.emergencyCoverage) || !['unknown', 'available', 'unavailable'].includes(v.availability) || !text(v.expectedPricing, 1000) || !text(v.restrictions, 1000)
    || !nullable(v.responseTargetMinutes, x => version(x) && x <= 43200) || !Number.isInteger(v.preference) || v.preference < 0 || v.preference > 1000 || !id(v.reviewedBy) || !instant(v.reviewedAt) || !instant(v.createdAt)) throw bad()
  if (v.availability === 'unknown' ? v.availabilityObservedAt !== null || v.availabilityValidUntil !== null : !instant(v.availabilityObservedAt) || !instant(v.availabilityValidUntil)) throw bad()
  readSource(v); return Object.freeze(copy(v))
}
function readHistory(values, planId = null) {
  if (!Array.isArray(values) || values.length > 25) throw bad()
  for (const v of values) if (!obj(v) || !id(v.id) || !id(v.planId) || planId && v.planId !== planId || !version(v.planVersion) || !['prepared', 'approved', 'rejected', 'withdrawn', 'safety_hold'].includes(v.kind)
    || !id(v.actorUserId) || !instant(v.createdAt) || !text(v.reason, 1000) || !text(v.scopeOfWork, 4000) || !nullable(v.maximumCents, cents) || v.currency !== 'USD' || !nullable(v.vendorName, x => text(x, 160)) || !version(v.policyVersion) || !version(v.caseVersion)) throw bad()
  if (new Set(values.map(v => v.id)).size !== values.length) throw bad()
  return values.map(v => Object.freeze(copy(v)))
}
function cursor(value, rows) {
  if (value === null) return null
  if (!obj(value) || !id(value.id) || !instant(value.createdAt) || rows.at(-1)?.id !== value.id || rows.at(-1)?.createdAt !== value.createdAt) throw bad()
  return Object.freeze({ id: value.id, createdAt: value.createdAt })
}
function readDetail(v, caseId) {
  if (!obj(v) || !obj(v.request) || v.request.id !== caseId || !scoped(v.request) || !version(v.request.version) || !text(v.request.summary, 160) || !own(CATEGORIES, v.request.category)
    || !bool(v.request.contextNeedsReview) || !Array.isArray(v.request.emergencyKinds) || !v.request.emergencyKinds.every(x => text(x, 80)) || !['routine','urgent','emergency'].includes(v.request.priority)
    || !obj(v.resident) || v.resident.callerIdentityVerified !== false || v.resident.entryAuthorized !== false || !bool(v.canDecide)) throw bad()
  const policy = readPolicy(v.policy), vendor = v.vendor === null ? null : readVendor(v.vendor), p = v.plan
  if (p !== null && (!obj(p) || !scoped(p) || !id(p.id) || p.caseId !== caseId || !version(p.version) || !version(p.caseVersion) || !version(p.policyVersion) || !version(p.configurationVersion)
    || !['internal','vendor'].includes(p.route) || !nullable(p.vendorId, id) || !nullable(p.vendorVersion, version) || !nullable(p.internalTeam, x => text(x,160)) || !text(p.scopeOfWork,4000)
    || p.currency !== 'USD' || !nullable(p.maximumCents,cents) || !bool(p.includesAllCharges) || !['no_unit_entry','unit_entry'].includes(p.accessRequirement) || !choices(p.restrictions,RESTRICTIONS)
    || !Array.isArray(p.emergencyKinds) || !p.emergencyKinds.every(x => text(x,80)) || !text(p.reason,1000) || !id(p.preparedBy) || !instant(p.preparedAt) || !instant(p.createdAt) || !nullable(p.withdrawnAt, instant))) throw bad()
  if (p && (p.route === 'vendor' ? !p.vendorId || !version(p.vendorVersion) || p.internalTeam !== null || vendor && vendor.id !== p.vendorId : p.vendorId !== null || p.vendorVersion !== null || !p.internalTeam)) throw bad()
  const d = v.decision
  if (d !== null && (!obj(d) || !p || !id(d.id) || d.planId !== p.id || !version(d.planVersion) || !['approve','reject'].includes(d.decision) || !id(d.actorUserId) || !['owner','admin'].includes(d.actorRole) || !text(d.reason,1000) || !instant(d.decidedAt) || !bool(d.authorityCurrent) || ![null,'owner','admin'].includes(d.currentRole))) throw bad()
  const a = v.assessment
  if (!obj(a) || !own(READINESS,a.readiness) || !(a.tier === null || own(TIERS,a.tier)) || !Array.isArray(a.reasons) || a.reasons.length > 50 || !a.reasons.every(x => text(x,240))
    || ![null,'owner','admin_or_owner'].includes(a.requiredApprover) || !bool(a.spendingAuthorized) || !bool(a.residentApprovalRequired) || a.residentApprovalVerified !== false || a.entryAuthorized !== false || a.dispatchStatus !== 'not_dispatched' || a.notificationStatus !== 'not_sent') throw bad()
  if (!Array.isArray(v.safetyInstructions) || v.safetyInstructions.length > 30 || !v.safetyInstructions.every(x=>text(x,2000)) || !bool(v.safetyCallEmergencyServices)) throw bad()
  const history = readHistory(v.history), nextHistoryCursor = cursor(v.nextHistoryCursor,history)
  return Object.freeze({ ...copy(v), policy, vendor, history, nextHistoryCursor })
}
function readReceipt(body, command, expectedId = null) {
  const r = body?.receipt, resource = command.action === 'publish_policy' ? 'policy' : command.action === 'save_vendor' ? 'vendor' : 'plan'
  const expected = command.action === 'decide_plan' ? command.expectedPlanVersion + (r?.outcome === 'emergency_held' ? 1 : 0) : (command.expectedVersion ?? command.expectedPlanVersion) + 1
  if (!obj(r) || r.action !== command.action || r.requestId !== command.requestId || r.resource !== resource || !id(r.id) || expectedId && r.id !== expectedId || r.version !== expected || !instant(r.committedAt) || !bool(r.replayed) || !['saved','emergency_held'].includes(r.outcome) || r.outcome === 'emergency_held' && !['prepare_plan','decide_plan'].includes(command.action)) throw bad()
  return Object.freeze(copy(r))
}
const money = v => v === null ? 'Cost not established' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v/100)
const amount = v => v === null || v === undefined ? '' : (v/100).toFixed(2)
const facts = pairs => '<dl class="mp-facts">' + pairs.map(([k,v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v ?? 'Not recorded')}</dd></div>`).join('') + '</dl>'
const btn = (action,label,primary=false,disabled=false) => `<button type="button" class="btn${primary?' btn-primary':''}" data-mp="${action}"${disabled?' disabled':''}>${esc(label)}</button>`
const note = message => `<p class="mp-boundary">${esc(message)}</p>`
const sourceCurrent = v => Date.parse(v.observedAt) <= Date.now() && Date.now() < Date.parse(v.validUntil)
function availability(v) { return v.status !== 'approved' ? 'Suspended' : !sourceCurrent(v) ? 'Vendor review expired or not yet current' : v.availability === 'unknown' ? 'Availability not established' : Date.parse(v.availabilityObservedAt) > Date.now() || Date.now() >= Date.parse(v.availabilityValidUntil) ? 'Availability report expired or not yet current' : v.availability === 'available' ? 'Reported available · no appointment confirmed' : 'Reported unavailable' }
const hazard = value => /gas\s*(?:leak|smell)|smell.{0,12}gas|\bfire\b|smoke|carbon monoxide|flood|burst pipe|bleeding|unconscious|intruder|structural|ceiling.{0,16}(?:fall|collaps)/i.test(value)
const SAFETY = '<div class="sv-safety"><strong>Act on immediate danger now</strong><p>Follow the building’s emergency procedure. If anyone is in immediate danger, contact emergency services from a safe place. Saving a plan does not contact anyone.</p></div>'
const field = (key,label,value='',type='text',max=240) => `<div class="field"><label class="field-label" for="mp-${key}">${esc(label)}</label><input class="input" id="mp-${key}" type="${type}" value="${esc(value)}" maxlength="${max}"></div>`
const area = (key,label,value='',max=1000) => `<div class="field"><label class="field-label" for="mp-${key}">${esc(label)}</label><textarea class="input" id="mp-${key}" rows="3" maxlength="${max}">${esc(value)}</textarea></div>`
const select = (key,label,values,value='') => `<div class="field"><label class="field-label" for="mp-${key}">${esc(label)}</label><select class="input" id="mp-${key}">${values.map(([v,l])=>`<option value="${esc(v)}"${value===v?' selected':''}>${esc(l)}</option>`).join('')}</select></div>`
const toggle = (key,label,value) => `<label class="mp-check"><input type="checkbox" id="mp-${key}"${value?' checked':''}><span>${esc(label)}</span></label>`
const checks = (key,label,options,values=[]) => `<fieldset class="mp-checks"><legend>${esc(label)}</legend>${Object.entries(options).map(([v,l])=>toggle(key+'-'+v,l,values.includes(v))).join('')}</fieldset>`
const val = (body,key) => body.querySelector('#mp-'+key)?.value.trim() || '', checked = (body,key) => body.querySelector('#mp-'+key)?.checked === true
const selected = (body,key,values) => Object.keys(values).filter(v=>checked(body,key+'-'+v))
function required(value,label,min,max) { if (!text(value,max) || value.length < min) throw new Error(`${label} must contain ${min}–${max} characters.`); return value }
function dollars(value,label,allowUnknown=true) {
  if (!value && allowUnknown) return null
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) throw new Error(`${label} must be a USD amount with no more than two decimal places.`)
  const [whole,fraction=''] = value.split('.'), result = Number(whole)*100 + Number(fraction.padEnd(2,'0'))
  if (!cents(result)) throw new Error(`${label} exceeds the supported per-job limit.`)
  return result
}
function localInput(value) { if (!value) return ''; const p=A.fmt.nyParts(value); return `${p.ymd}T${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}` }
function sourceInstant(value,previous=null) {
  if (previous && value === localInput(previous)) return previous
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Error('Enter a complete date and time in the property’s time zone.')
  const nominal=Date.parse(value+':00.000Z'), matches=[]
  for(let offset=-16*60;offset<=16*60;offset+=15) { const candidate=nominal+offset*60000; if(localInput(new Date(candidate).toISOString())===value) matches.push(candidate) }
  if(matches.length!==1) throw new Error('That local time is missing or ambiguous because of a clock change. Choose another time.')
  return new Date(matches[0]).toISOString()
}
function sourceFields(value={}) { return field('source','Approved source / reference',value.sourceReference||'') + '<div class="mp-form-grid">'+field('observed','Source observed ('+A.property.timeZoneLabel+')',localInput(value.observedAt),'datetime-local')+field('until','Review valid until ('+A.property.timeZoneLabel+')',localInput(value.validUntil),'datetime-local')+'</div>' }
function readSourceForm(body,previous,days,prefix='',requireCurrent=true) {
  const observedAt=sourceInstant(val(body,prefix+'observed'),previous?.[prefix?'availabilityObservedAt':'observedAt']), validUntil=sourceInstant(val(body,prefix+'until'),previous?.[prefix?'availabilityValidUntil':'validUntil'])
  if(requireCurrent && (Date.parse(observedAt)>Date.now() || Date.parse(validUntil)<=Date.now()) || Date.parse(validUntil)<=Date.parse(observedAt) || Date.parse(validUntil)-Date.parse(observedAt)>days*86400000) throw new Error(`The source must be current and cover no more than ${days} days. Use actual evidence dates.`)
  return prefix ? {availabilityObservedAt:observedAt,availabilityValidUntil:validUntil} : {sourceReference:required(val(body,'source'),'Source reference',3,240),observedAt,validUntil}
}

function create(options) {
  let host=null, noticeHost=null, mode='', caseId=null, caseVersion=null, generation=0, detailGeneration=0, overview=null, detail=null, vendors=[], vendor=null, vendorCursor=null, vendorFilter='approved', selectedVendor=null, loading=false, detailLoading=false, error='', detailError='', dialog=null, busy=false, pending=null, toast=null
  const active=()=>Boolean(host && options.isActive() && A.can('operate'))
  const locked=()=>busy || Boolean(pending) || Boolean(dialog)
  function bounded(promise) { let timer; return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('The request has not been confirmed.'),{uncertain:true})),15000)})]).finally(()=>clearTimeout(timer)) }
  function changed() { renderNotice(); options.onChange?.() }
  function renderNotice() {
    if (!noticeHost) return
    noticeHost.innerHTML = pending ? '<div class="mp-warning" role="alert"><strong>Planning change is unconfirmed</strong><p>'+(pending.needsVerification?'Verify administrator access, then reload and check the saved record before making another change.':'The change may have been recorded. Recheck the exact reviewed change before starting another.')+'</p>'+ (pending.needsVerification?'<a class="btn" href="/api/mfa">Verify administrator access</a>':btn('retry','Check this exact change'))+' <a class="btn" href="'+esc(location.pathname||'/api/dashboard')+'" data-mp="reload">Reload current property</a></div>' : ''
  }
  function policyHtml() {
    const p=overview?.policy
    return '<section class="mp-policy"><div class="mp-section-title"><div><span class="page-eyebrow">PROPERTY AUTHORITY</span><h3>Work approval rules</h3></div>'+(overview?.canPublishPolicy?btn('policy',p?'Review authority rules':'Set authority rules'): '')+'</div>'+
      (p?facts([['Automatic per job',p.automaticLimitCents===null?'Disabled':money(p.automaticLimitCents)],['Manager per job',p.managerLimitCents===null?'Disabled':money(p.managerLimitCents)],['Owner ceiling per job',money(p.ownerLimitCents)],['Current source',sourceCurrent(p)?'Review current':'Review expired or not yet current']])+'<p class="mp-small">Rule version '+p.version+' · '+(p.requireIndependentApprover?'Independent approver required':'Same-person approval permitted by policy')+' · '+(p.requireResidentApproval?'Resident approval required':'Resident approval not required by this rule')+'</p>':note('No authority policy is published. Staff can record requests; work cannot become an authorized plan until rules are established.'))+'</section>'
  }
  function historyHtml() {
    if(!detail) return ''
    return '<details class="mp-history"><summary>Plan and decision history</summary><ol>'+detail.history.map(h=>`<li><strong>${esc({prepared:'Plan prepared',approved:'Plan approved',rejected:'Plan rejected',withdrawn:'Plan withdrawn',safety_hold:'Safety concern recorded'}[h.kind])} · revision ${h.planVersion}</strong><span>${esc(A.fmt.dateTime(h.createdAt))}</span><p>${esc(h.scopeOfWork)}</p><span>${esc(money(h.maximumCents))} · ${esc(h.vendorName||'Internal route')} · rule ${h.policyVersion}</span><p>${esc(h.reason)}</p></li>`).join('')+'</ol>'+(detail.nextHistoryCursor?btn('history','Load earlier decisions'):'<p class="mp-small">All returned history is shown.</p>')+'</details>'
  }
  function planHtml() {
    if(!detail) return '<p>'+(detailError?esc(detailError):'Checking the saved work plan…')+'</p>'
    const {plan:p,assessment:a,decision:d}=detail
    return `<div class="mp-section-title"><div><span class="page-eyebrow">WORK PLAN</span><h3 tabindex="-1" data-mp-heading>${esc(READINESS[a.readiness])}</h3></div>${btn('refresh','Refresh plan')}</div>`+
      (a.readiness==='emergency_review'?SAFETY+detail.safetyInstructions.map(s=>'<p class="sv-safety">'+esc(s)+'</p>').join(''):'')+
      (a.tier?'<span class="mp-tier">'+esc(TIERS[a.tier])+'</span>':'')+
      '<p class="mp-boundary">Not dispatched · No notification sent. Entry permission and caller identity are not established.</p>'+
      (a.reasons.length?'<ul class="mp-reasons">'+a.reasons.map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>':'')+
      (p?`<div class="mp-plan-scope"><h4>Scope of work · revision ${p.version}</h4><p>${esc(p.scopeOfWork)}</p></div>`+facts([['Route',p.route==='internal'?'Internal · '+p.internalTeam:detail.vendor?.name||'Vendor record unavailable'],['Maximum per job (USD)',money(p.maximumCents)],['Charges',p.includesAllCharges?'Includes tax, callout, materials and contingency':'All-in total not established'],['Entry requirement',p.accessRequirement==='unit_entry'?'Unit entry required — not authorized':'No unit entry proposed'],['Bound authority rule','Version '+p.policyVersion],['Bound request','Version '+p.caseVersion]])+(detail.vendor?note(availability(detail.vendor)):'')+(d?'<div class="mp-decision"><strong>'+esc(d.decision==='approve'?'Approval recorded':'Rejection recorded')+'</strong><p>'+esc(A.fmt.dateTime(d.decidedAt))+' · '+esc(d.actorRole==='owner'?'Owner':'Manager')+(d.authorityCurrent?'':' · Approver authority no longer current')+'</p><p>'+esc(d.reason)+'</p></div>':''):note('Prepare a precise scope and all-in spending ceiling. This records a proposed plan; it does not contact a vendor.'))+
      '<div class="mp-actions">'+btn('prepare',p?'Revise work plan':'Prepare work plan',true,!overview?.policy || a.readiness==='emergency_review')+(p&&!p.withdrawnAt?btn('withdraw','Withdraw plan'):'')+(detail.canDecide?btn('approve','Review approval',true)+btn('reject','Reject plan'):'')+(!overview?.policy && overview?.canPublishPolicy?btn('policy','Set authority rules'):'')+'</div>'+historyHtml()
  }
  function vendorHtml(v) {
    if(!v) return '<p>'+(detailError?esc(detailError):detailLoading?'Loading vendor…':'Select a vendor to review its scope and evidence.')+'</p>'
    return `<h3 tabindex="-1" data-mp-heading>${esc(v.name)}</h3><p class="mp-tier">${v.status==='approved'?'Approved vendor':'Suspended vendor'}</p>`+note(availability(v))+facts([['Trade',v.categories.map(c=>CATEGORIES[c]).join(', ')],['Service coverage',v.serviceArea],['Reported hours',v.hours],['Emergency coverage',v.emergencyCoverage?'Reported coverage':'Not established'],['Phone',v.phone],['Email',v.email],['Expected pricing',v.expectedPricing||'Not recorded'],['Response target',v.responseTargetMinutes===null?'Not recorded':v.responseTargetMinutes+' minutes'],['Preference',String(v.preference)],['Restrictions',v.restrictions||'None recorded']])+ '<details><summary>Source and review</summary>'+facts([['Source',v.sourceReference],['Observed',A.fmt.dateTime(v.observedAt)],['Review valid until',A.fmt.dateTime(v.validUntil)],['Availability observed',v.availabilityObservedAt?A.fmt.dateTime(v.availabilityObservedAt):'Not established'],['Availability valid until',v.availabilityValidUntil?A.fmt.dateTime(v.availabilityValidUntil):'Not established']])+'</details>'+note('These are staff-reviewed vendor details, not a live calendar or confirmed appointment.')+(overview?.canManageVendors?'<div class="mp-actions">'+btn('edit-vendor','Review vendor',true)+'</div>':'')
  }
  function render() {
    renderNotice(); if(!active()) return
    const previousTop=host.querySelector('.mp-vendor-list')?.scrollTop || 0
    host.innerHTML='<div class="mp-workspace"'+(loading?' aria-busy="true"':'')+'>'+(error?'<div class="mp-warning" role="alert">'+esc(error)+'</div>':'')+
      (!overview?'<p>'+(error?'Maintenance authority could not be loaded.':'Loading maintenance authority…')+'</p>'+(error?btn('refresh','Retry loading'): ''):mode==='case'?planHtml():policyHtml()+'<div class="mp-section-title"><div><span class="page-eyebrow">APPROVED DIRECTORY</span><h3>Vendors</h3></div><div class="mp-actions">'+(overview.canManageVendors?btn('add-vendor','Add vendor',true):'')+btn('refresh','Refresh')+'</div></div><div class="mp-filters">'+[['approved','Approved'],['suspended','Suspended'],['all','All vendors']].map(([v,l])=>`<button type="button" class="btn" data-mp-filter="${v}" aria-pressed="${v===vendorFilter}">${l}</button>`).join('')+'</div><p class="mp-small">'+vendors.length+' vendors shown · availability is reported, not a booking.</p><div class="mp-directory"><section><div class="mp-vendor-list">'+(vendors.length?vendors.map(v=>`<button type="button" class="mp-vendor-row" data-mp-vendor="${esc(v.id)}" aria-current="${v.id===selectedVendor}"><strong>${esc(v.name)}</strong><span>${esc(v.categories.map(c=>CATEGORIES[c]).join(', '))}</span><span>${esc(availability(v))}</span></button>`).join(''):'<p class="mp-empty">'+(loading?'Checking vendor records…':'No vendors in this result.')+'</p>')+'</div>'+ (vendorCursor?btn('more','Load more vendors'):'')+'</section><section class="mp-vendor-detail">'+vendorHtml(vendor)+'</section></div>')+'</div>'
    const list=host.querySelector('.mp-vendor-list'); if(list) list.scrollTop=previousTop
    for(const button of host.querySelectorAll('button')) button.disabled=button.disabled || busy || Boolean(pending) || Boolean(dialog) || loading || (Boolean(error) && button.dataset.mp !== 'refresh') || detailLoading
    changed()
  }
  async function getOverview() {
    const b=await bounded(A.api.get(ENDPOINT+'?resource=overview'))
    if(!obj(b)||!bool(b.canPublishPolicy)||!bool(b.canManageVendors)||!['owner','admin','staff'].includes(b.actorRole)||!text(b.formToken,2000)||!b.formToken||b.canPublishPolicy&&b.actorRole!=='owner') throw bad()
    return {...copy(b),policy:readPolicy(b.policy)}
  }
  async function load(more=false) {
    if(!active()||busy||more&&!vendorCursor) return
    const turn=++generation, savedMode=mode,savedId=caseId,savedFilter=vendorFilter,before=more?vendorCursor:null, focusMore=more&&document.activeElement?.dataset?.mp==='more'
    loading=true;error='';render()
    try {
      const o=await getOverview()
      if(!active()||generation!==turn) return
      if(savedMode==='case') {
        const b=await bounded(A.api.get(ENDPOINT+'?'+new URLSearchParams({resource:'plan',caseId:savedId}))), d=readDetail({...b.detail,safetyInstructions:b.safetyInstructions,safetyCallEmergencyServices:b.safetyCallEmergencyServices},savedId)
        if(!active()||generation!==turn) return
        overview=o;detail=d;detailError=''
      } else {
        const q=new URLSearchParams({resource:'vendors',status:savedFilter,limit:'25'});if(before){q.set('beforeCreatedAt',before.createdAt);q.set('beforeId',before.id)}
        const b=await bounded(A.api.get(ENDPOINT+'?'+q));if(!Array.isArray(b.vendors)||b.vendors.length>25)throw bad()
        const rows=b.vendors.map(readVendor),next=cursor(b.nextCursor,rows);if(savedFilter!=='all'&&rows.some(v=>v.status!==savedFilter))throw bad()
        if(!active()||generation!==turn)return
        const old=more?vendors:[];if(rows.some(v=>old.some(x=>x.id===v.id)))throw bad()
        overview=o;vendors=[...old,...rows];vendorCursor=next;selectedVendor=vendors.some(v=>v.id===selectedVendor)?selectedVendor:vendors[0]?.id||null
        vendor=vendors.find(v=>v.id===selectedVendor)||null
      }
    } catch(failure) { if(active()&&generation===turn)error=failure.propertyAccess||failure.signedOut?'Access changed. Reload this property.':failure.message||'Planning records could not be loaded.' }
    finally { if(active()&&generation===turn){loading=false;render();if(focusMore)(host.querySelector('[data-mp="more"]')||[...host.querySelectorAll('[data-mp-vendor]')].at(-1))?.focus({preventScroll:true})} }
  }
  async function chooseVendor(value) {
    if(!active()||busy||dialog)return
    const turn=++detailGeneration,epoch=generation;selectedVendor=value;detailLoading=true;detailError='';vendor=null;render()
    try{const b=await bounded(A.api.get(ENDPOINT+'?'+new URLSearchParams({resource:'vendor',id:value}))),v=readVendor(b.vendor);if(v.id!==value)throw bad();if(active()&&turn===detailGeneration&&epoch===generation)vendor=v}
    catch(failure){if(active()&&turn===detailGeneration&&epoch===generation)detailError=failure.message}
    finally{if(active()&&turn===detailGeneration&&epoch===generation){detailLoading=false;render();if(matchMedia('(max-width:760px)').matches){const h=host.querySelector('[data-mp-heading]');h?.focus({preventScroll:true});h?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}}}
  }
  async function moreHistory(){
    if(!active()||busy||loading||!detail?.nextHistoryCursor)return
    const turn=generation,savedId=caseId,before=detail.nextHistoryCursor;loading=true;render()
    try{const b=await bounded(A.api.get(ENDPOINT+'?'+new URLSearchParams({resource:'history',caseId:savedId,limit:'25',beforeCreatedAt:before.createdAt,beforeId:before.id}))),rows=readHistory(b.history),next=cursor(b.nextCursor,rows);if(!active()||turn!==generation)return;if(rows.some(v=>detail.history.some(x=>x.id===v.id)))throw bad();detail={...detail,history:[...detail.history,...rows],nextHistoryCursor:next}}
    catch(failure){if(active()&&turn===generation)error=failure.message}finally{if(active()&&turn===generation){loading=false;render();host.querySelector('.mp-history')?.setAttribute('open','');(host.querySelector('[data-mp="history"]')||host.querySelector('[data-mp-heading]'))?.focus({preventScroll:true})}}
  }
  function formHtml(kind,original){
    if(kind==='publish_policy'){const p=original||{};return note('USD ceilings are per job and include all charges. Blank automatic or manager limits disable that authority. Changing rules can invalidate existing plans.')+'<div class="mp-form-grid">'+field('automatic','Automatic maximum per job (USD)',amount(p.automaticLimitCents),'text')+field('manager','Manager maximum per job (USD)',amount(p.managerLimitCents),'text')+field('owner','Owner maximum per job (USD)',amount(p.ownerLimitCents),'text')+'</div>'+checks('automatic-category','Categories eligible for automatic authority',CATEGORIES,p.automaticCategories)+checks('excluded','Always escalate these categories',CATEGORIES,p.excludedCategories)+toggle('resident-approval','Require verified resident approval',p.requireResidentApproval??true)+toggle('independent','Require an independent approver',p.requireIndependentApprover??true)+sourceFields(p)+area('reason','Reason for publishing these rules')}
    if(kind==='save_vendor'){const v=original||{};return note('Suspending a vendor removes its approval, clears reported availability and keeps the original source dates. It does not cancel external work.')+field('name','Vendor name',v.name||'', 'text',160)+checks('category','Approved trades',CATEGORIES,v.categories)+select('status','Directory status',[['suspended','Suspended / not yet approved'],['approved','Approved']],v.status||'suspended')+'<div class="mp-form-grid">'+field('phone','Phone',v.phone||'','tel',32)+field('email','Email',v.email||'','email',254)+'</div>'+area('coverage','Service coverage',v.serviceArea||'',500)+area('hours','Reported hours',v.hours||'',500)+toggle('emergency','Vendor reports emergency coverage',v.emergencyCoverage||false)+select('availability','Reported availability',[['unknown','Not established'],['available','Reported available'],['unavailable','Reported unavailable']],v.availability||'unknown')+'<div class="mp-form-grid">'+field('availability-observed','Availability observed ('+A.property.timeZoneLabel+')',localInput(v.availabilityObservedAt),'datetime-local')+field('availability-until','Availability valid until ('+A.property.timeZoneLabel+')',localInput(v.availabilityValidUntil),'datetime-local')+'</div>'+note('Reported availability is not a reserved time. Unknown availability has no dates.')+area('pricing','Expected pricing, if known',v.expectedPricing||'')+'<div class="mp-form-grid">'+field('response','Response target (minutes; optional)',v.responseTargetMinutes===null||v.responseTargetMinutes===undefined?'':String(v.responseTargetMinutes))+field('preference','Preference (0–1000; lower is preferred)',String(v.preference??0))+'</div>'+area('restrictions','Restrictions',v.restrictions||'')+sourceFields(v)+area('reason','Reason for this vendor review')}
    if(kind==='prepare_plan'){const p=original?.plan||{};return '<div class="mp-immediate-safety" role="alert" hidden></div>'+note('A saved plan is not a dispatch. An unknown ceiling, required resident approval or unit-entry requirement can hold it for review.')+area('scope','Exact scope of work',p.scopeOfWork||'',4000)+select('route','Proposed route',[['internal','Internal team'],['vendor','Approved vendor']],p.route||'internal')+field('team','Internal team name',p.internalTeam||'','text',160)+select('vendor','Select approved vendor',[['','Choose a vendor']],p.vendorId||'')+'<p class="mp-vendor-hint" role="status">Vendor records are loaded when selected.</p>'+btn('picker-more','Load more vendor choices')+field('maximum','Maximum total per job (USD; blank means unknown)',amount(p.maximumCents))+toggle('all-charges','This ceiling includes tax, callout, materials and contingency',p.includesAllCharges||false)+select('entry','Entry requirement',[['unit_entry','Unit entry required — permission not established'],['no_unit_entry','No unit entry proposed']],p.accessRequirement||'unit_entry')+checks('restriction','Restricted work indicators',RESTRICTIONS,p.restrictions)+area('reason','Reason and proposed next step')}
    return '<div class="mp-immediate-safety" role="alert" hidden></div>'+note(kind==='withdraw_plan'?'Withdraw this exact plan. Existing case and decision history remain. No vendor cancellation is sent.':'Review the exact plan below. This decision does not contact a vendor, grant unit entry, or record resident approval.')+planReview(original?.plan,original?.vendor)+area('reason',kind==='withdraw_plan'?'Reason for withdrawal':'Decision reason')
  }
  function formCommand(kind,body,original,vendorChoices,decision){
    if(kind==='publish_policy'){
      const automaticLimitCents=dollars(val(body,'automatic'),'Automatic ceiling'),managerLimitCents=dollars(val(body,'manager'),'Manager ceiling'),ownerLimitCents=dollars(val(body,'owner'),'Owner ceiling',false),automaticCategories=selected(body,'automatic-category',CATEGORIES),excludedCategories=selected(body,'excluded',CATEGORIES)
      if(automaticCategories.some(c=>excludedCategories.includes(c))||automaticLimitCents===null&&automaticCategories.length||automaticLimitCents!==null&&automaticLimitCents>ownerLimitCents||managerLimitCents!==null&&managerLimitCents>ownerLimitCents||automaticLimitCents!==null&&managerLimitCents!==null&&automaticLimitCents>managerLimitCents)throw new Error('Automatic categories and ceilings must fit within the manager/owner limits and cannot overlap excluded categories.')
      return {action:kind,expectedVersion:original?.version||0,details:{currency:'USD',automaticLimitCents,managerLimitCents,ownerLimitCents,automaticCategories,excludedCategories,requireResidentApproval:checked(body,'resident-approval'),requireIndependentApprover:checked(body,'independent'),...readSourceForm(body,original,365)},reason:required(val(body,'reason'),'Reason',3,1000)}
    }
    if(kind==='save_vendor'){
      const categories=selected(body,'category',CATEGORIES),status=val(body,'status'),phone=val(body,'phone')||null,email=val(body,'email')||null,available=status==='suspended'?'unknown':val(body,'availability'),response=val(body,'response'),preference=val(body,'preference')
      if(!categories.length||!['approved','suspended'].includes(status)||status==='approved'&&!phone&&!email||phone&&!/^\+?[0-9().\-\s]{6,32}$/.test(phone)||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Choose at least one trade and valid contact details. Approved vendors need a phone or email.')
      if(!/^\d{1,4}$/.test(preference)||Number(preference)>1000||response&&(!/^\d{1,5}$/.test(response)||Number(response)<1||Number(response)>43200))throw new Error('Enter a valid preference and response target in minutes.')
      if(!['unknown','available','unavailable'].includes(available))throw bad()
      return {action:kind,id:original?.id||null,expectedVersion:original?.version||0,details:{name:required(val(body,'name'),'Vendor name',1,160),categories,status,phone,email,serviceArea:required(val(body,'coverage'),'Coverage',1,500),hours:required(val(body,'hours'),'Hours',1,500),emergencyCoverage:checked(body,'emergency'),availability:available,...(available==='unknown'?{availabilityObservedAt:null,availabilityValidUntil:null}:readSourceForm(body,original,14,'availability-')),expectedPricing:required(val(body,'pricing'),'Pricing note',0,1000),responseTargetMinutes:response?Number(response):null,preference:Number(preference),restrictions:required(val(body,'restrictions'),'Restrictions',0,1000),...readSourceForm(body,original,90,'',status==='approved')},reason:required(val(body,'reason'),'Reason',3,1000)}
    }
    if(kind==='prepare_plan'){
      const route=val(body,'route'),chosen=vendorChoices.find(v=>v.id===val(body,'vendor'))
      if(!['internal','vendor'].includes(route)||route==='vendor'&&(!chosen||chosen.status!=='approved'))throw new Error('Select a current approved vendor from the loaded directory.')
      return {action:kind,caseId:original.request.id,expectedCaseVersion:original.request.version,expectedPlanVersion:original.plan?.version||0,policyVersion:original.policy.version,details:{route,vendorId:route==='vendor'?chosen.id:null,vendorVersion:route==='vendor'?chosen.version:null,internalTeam:route==='internal'?required(val(body,'team'),'Internal team',1,160):null,scopeOfWork:required(val(body,'scope'),'Scope of work',3,4000),currency:'USD',maximumCents:dollars(val(body,'maximum'),'Maximum total'),includesAllCharges:checked(body,'all-charges'),accessRequirement:val(body,'entry'),restrictions:selected(body,'restriction',RESTRICTIONS),reason:required(val(body,'reason'),'Reason',3,1000)}}
    }
    return {action:kind,caseId:original.request.id,planId:original.plan.id,expectedPlanVersion:original.plan.version,...(kind==='decide_plan'?{decision}:{}),reason:required(val(body,'reason'),'Reason',3,1000)}
  }
  function planReview(p,v){return p?'<div class="mp-plan-scope"><strong>Exact proposed work</strong><p>'+esc(p.scopeOfWork)+'</p></div>'+facts([['Route',p.route==='internal'?'Internal · '+p.internalTeam:v?.name||'Selected vendor'],['Ceiling per job (USD)',money(p.maximumCents)],['All charges included',p.includesAllCharges?'Yes':'Not established'],['Entry',p.accessRequirement==='unit_entry'?'Required — not authorized':'No unit entry proposed'],['Restrictions',p.restrictions.map(r=>RESTRICTIONS[r]).join(', ')||'None declared']]):''}
  function reviewHtml(command,original,vendorChoices){
    const d=command.details,warning=hazard([d?.scopeOfWork,d?.reason,command.reason].filter(Boolean).join(' '))?SAFETY:''
    let content=''
    if(command.action==='publish_policy') content=facts([['Automatic ceiling',d.automaticLimitCents===null?'Disabled':money(d.automaticLimitCents)],['Manager ceiling',d.managerLimitCents===null?'Disabled':money(d.managerLimitCents)],['Owner ceiling',money(d.ownerLimitCents)],['Automatic categories',d.automaticCategories.map(c=>CATEGORIES[c]).join(', ')||'None'],['Excluded categories',d.excludedCategories.map(c=>CATEGORIES[c]).join(', ')||'None'],['Resident approval',d.requireResidentApproval?'Required':'Not required by this rule'],['Independent approver',d.requireIndependentApprover?'Required':'Not required'],['Source',d.sourceReference],['Observed',A.fmt.dateTime(d.observedAt)],['Valid until',A.fmt.dateTime(d.validUntil)]])
    else if(command.action==='save_vendor') content=facts([['Vendor',d.name],['Status',d.status==='approved'?'Approved':'Suspended'],['Trades',d.categories.map(c=>CATEGORIES[c]).join(', ')],['Coverage',d.serviceArea],['Hours',d.hours],['Phone',d.phone],['Email',d.email],['Emergency coverage',d.emergencyCoverage?'Reported':'Not established'],['Reported availability',d.availability],['Availability observed',d.availabilityObservedAt?A.fmt.dateTime(d.availabilityObservedAt):'Not established'],['Availability until',d.availabilityValidUntil?A.fmt.dateTime(d.availabilityValidUntil):'Not established'],['Expected pricing',d.expectedPricing||'Not recorded'],['Response target',d.responseTargetMinutes===null?'Not recorded':d.responseTargetMinutes+' minutes'],['Preference',String(d.preference)],['Restrictions',d.restrictions||'None recorded'],['Source',d.sourceReference],['Observed',A.fmt.dateTime(d.observedAt)],['Review until',A.fmt.dateTime(d.validUntil)]])
    else content=planReview(d||original.plan,d?vendorChoices.find(v=>v.id===d.vendorId):original.vendor)+facts([['Request version',String(command.expectedCaseVersion??original.request.version)],['Plan revision',String(command.expectedPlanVersion)],['Authority rule',String(command.policyVersion??original.plan.policyVersion)],...(command.decision?[['Decision',command.decision==='approve'?'Approve this exact plan':'Reject this exact plan']]:[])])
    return '<div class="mp-review">'+warning+content+'<h4>Reason</h4><p class="mp-pre">'+esc(command.reason||d?.reason)+'</p>'+note('Recording this change does not dispatch, notify, pay anyone or grant entry permission.')+'</div>'
  }
  function open(kind,decision=null,recovery=null){
    if(!active()||dialog||busy||!overview||!recovery&&(pending||loading||error||options.canOpen?.()===false))return
    if(!recovery&&(kind==='publish_policy'&&!overview.canPublishPolicy||kind==='save_vendor'&&!overview.canManageVendors||kind==='decide_plan'&&!detail?.canDecide||kind==='prepare_plan'&&(!detail?.policy||detail.assessment.readiness==='emergency_review')||kind==='withdraw_plan'&&(!detail?.plan||detail.plan.withdrawnAt)))return
    toast?.close?.();toast=null
    const original=copy(kind==='publish_policy'?overview.policy:kind==='save_vendor'?decision==='new'?null:vendor:detail),epoch=generation
    let closed=false,command=recovery?.command||null,token=recovery?.token||overview.formToken,review=Boolean(recovery),uncertain=Boolean(recovery),retired=false,draftNodes=null,reviewedHtml=recovery?.html||'',expectedId=recovery?.expectedId||null,vendorChoices=original?.vendor?[original.vendor]:[],pickerCursor=null,pickerBusy=false,pickerGeneration=0
    const current=()=>!closed&&active()&&epoch===generation
    function safety(body){const box=body.querySelector('.mp-immediate-safety');if(box){box.hidden=!hazard(val(body,'scope')+' '+val(body,'reason'));box.innerHTML=box.hidden?'':SAFETY}}
    async function picker(body,more=false){
      const gen=++pickerGeneration,p=body.querySelector('#mp-vendor'),h=body.querySelector('.mp-vendor-hint'),m=body.querySelector('[data-mp="picker-more"]');if(!p)return
      const use=val(body,'route')==='vendor';p.disabled=!use;body.querySelector('#mp-team').disabled=use;m.hidden=!use;if(!use){h.textContent='Internal work does not require a vendor.';return}
      pickerBusy=true;p.disabled=true;m.disabled=true;h.textContent='Loading approved vendor records…'
      try{const q=new URLSearchParams({resource:'vendors',status:'approved',limit:'25'});if(more&&pickerCursor){q.set('beforeCreatedAt',pickerCursor.createdAt);q.set('beforeId',pickerCursor.id)}const b=await bounded(A.api.get(ENDPOINT+'?'+q));if(!Array.isArray(b.vendors)||b.vendors.length>25)throw bad();const rows=b.vendors.map(readVendor),next=cursor(b.nextCursor,rows);if(rows.some(v=>v.status!=='approved'))throw bad();if(!current()||gen!==pickerGeneration||review)return;vendorChoices=[...new Map([...(more?vendorChoices:[]),...rows].map(v=>[v.id,v])).values()];pickerCursor=next;const chosen=p.value||original?.plan?.vendorId||'';p.innerHTML='<option value="">Choose an approved vendor</option>'+vendorChoices.map(v=>`<option value="${esc(v.id)}">${esc(v.name)} · ${esc(availability(v))}</option>`).join('');p.value=vendorChoices.some(v=>v.id===chosen)?chosen:'';h.textContent=vendorChoices.length+' vendors loaded. Approval and reported availability are separate.';m.hidden=!next}
      catch(failure){if(current()&&gen===pickerGeneration){h.textContent='Vendor choices could not be verified. Refresh before selecting a vendor.';vendorChoices=[];pickerCursor=null;m.hidden=true}}
      finally{if(current()&&gen===pickerGeneration){pickerBusy=false;p.disabled=false;m.disabled=false}}
    }
    const titles={publish_policy:'Review authority rules',save_vendor:'Review vendor directory',prepare_plan:'Prepare work plan',decide_plan:decision==='reject'?'Reject this plan':'Approve this plan',withdraw_plan:'Withdraw work plan'}
    dialog=A.dialog({title:titles[kind],secondary:{label:recovery?'Close':'Cancel',onClick(d){if(review&&!uncertain&&!retired){command=null;review=false;d.body.replaceChildren(...draftNodes);d.setPrimary({label:'Review change'});d.setError(null)}else d.close()}},build(body){body.innerHTML=recovery?recovery.html:formHtml(kind,original);if(!recovery){body.addEventListener('input',()=>safety(body));if(kind==='prepare_plan'){body.addEventListener('change',e=>{safety(body);if(e.target.id==='mp-route')picker(body)});body.querySelector('[data-mp="picker-more"]').addEventListener('click',()=>{if(!pickerBusy&&pickerCursor)picker(body,true)});picker(body)}}},primary:{label:recovery?'Retry this exact change':'Review change',async onClick(d){
      if(!current()||busy)return
      if(retired){d.close();return}
      if(!review){try{command=formCommand(kind,d.body,original,vendorChoices,decision);command.requestId=crypto.randomUUID();command=Object.freeze(copy(command));expectedId=kind==='publish_policy'?SCOPE.propertyId:kind==='save_vendor'?command.id:original.plan?.id||null;reviewedHtml=reviewHtml(command,original,vendorChoices);draftNodes=[...d.body.childNodes];d.body.innerHTML=reviewedHtml;review=true;pickerGeneration++;d.setError(null);d.setPrimary({label:kind==='decide_plan'?decision==='approve'?'Record approval':'Record rejection':'Save reviewed change'})}catch(failure){d.setError(failure.message)}return}
      busy=true;pending={command,token,html:reviewedHtml,expectedId,needsVerification:false};changed();d.setError(null);d.setBusy('Saving…')
      try{const receipt=readReceipt(await bounded(A.api.post(ENDPOINT,command,{formToken:token,doing:'Saving a reviewed maintenance plan'})),command,expectedId);if(!current())return;pending=null;d.close();busy=false;toast=A.toast(receipt.outcome==='emergency_held'?'Safety concern recorded. Follow the emergency protocol; the plan was not approved.':'Change recorded. Loading current plan…',{kind:receipt.outcome==='emergency_held'?'warn':'info'});await load()}
      catch(failure){if(!current()||failure.propertyAccess||failure.signedOut)return;const code=failure.body?.code
        if(code==='planning_mfa_required'){pending={command,token,html:reviewedHtml,expectedId,needsVerification:true};retired=true;d.setError((uncertain?'The earlier save is still unconfirmed. ':'')+'Verify administrator access, then reload and check the saved record. No change will be retried automatically.');d.body.innerHTML=reviewedHtml+'<a class="btn btn-primary" href="/api/mfa">Verify administrator access</a>';d.setPrimary({label:'Close'})}
        else if([400,404,409].includes(failure.status)&&!failure.badJson&&own(ERRORS,code)&&!uncertain){pending=null;retired=true;error=ERRORS[code];d.setError(error);d.setPrimary({label:'Close and refresh'})}
        else{uncertain=true;pending={command,token,html:reviewedHtml,expectedId,needsVerification:false};d.setError('This save is unconfirmed and may have been recorded. Retry only this exact reviewed change, or reload and check the saved record.');d.setPrimary({label:'Retry this exact change'})}
      }finally{busy=false;if(!closed)d.setBusy(null);render()}
    }},onClose(){closed=true;pickerGeneration++;dialog=null;changed()}});changed()
  }
  function handle(event){const b=event.target.closest('[data-mp], [data-mp-vendor], [data-mp-filter]');if(!b||b.disabled||busy)return
    if(b.dataset.mp==='reload'){event.preventDefault();location.reload();return}
    if(b.dataset.mp==='retry'&&pending){open(pending.command.action,pending.command.decision||null,pending);return}
    if(pending||dialog)return
    if(b.dataset.mpVendor){chooseVendor(b.dataset.mpVendor);return}
    if(b.dataset.mpFilter){vendorFilter=b.dataset.mpFilter;vendor=null;vendors=[];vendorCursor=null;load();return}
    const action=b.dataset.mp;if(action==='refresh')load();else if(action==='more')load(true);else if(action==='history')moreHistory();else if(action==='policy')open('publish_policy');else if(action==='add-vendor')open('save_vendor','new');else if(action==='edit-vendor')open('save_vendor');else if(action==='prepare')open('prepare_plan');else if(action==='withdraw')open('withdraw_plan');else if(action==='approve'||action==='reject')open('decide_plan',action)
  }
  function attach(node,context){
    if(!node)return
    const nextMode=context.mode,nextId=context.request?.id||null,nextVersion=context.request?.version||null,changedContext=mode!==nextMode||caseId!==nextId||caseVersion!==nextVersion
    if(host!==node){host=node;host.addEventListener('click',handle)}
    if(changedContext){generation++;detailGeneration++;dialog?.close();mode=nextMode;caseId=nextId;caseVersion=nextVersion;detail=null;error='';loading=false;detailLoading=false;render();load()}else render()
  }
  function deactivate(clear=false){generation++;detailGeneration++;dialog?.close();host=null;mode='';caseId=null;caseVersion=null;detail=null;vendor=null;loading=false;detailLoading=false;if(clear){pending=null;overview=null;vendors=[];noticeHost=null;toast?.close?.()}}
  return Object.freeze({attach,deactivate,locked,refresh:()=>load(),setNotice(node){if(noticeHost!==node){noticeHost=node;node?.addEventListener('click',handle)}renderNotice()},get pending(){return Boolean(pending)},get busy(){return busy},get open(){return Boolean(dialog)}})
}
A.maintenancePlans=Object.freeze({create})
})()
