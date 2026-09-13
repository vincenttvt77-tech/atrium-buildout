/* Resident source context and service intake. No identity, entry or dispatch authority is inferred. */
(function () {
'use strict'
const A = window.Atrium
if (!A?.databaseMode || !A.can('operate')) return
const esc = A.escapeHtml, ENDPOINT = '/api/resident-services'
const scope = Object.freeze({ organizationId: window.ATRIUM_PROPERTY.organizationId, propertyId: window.ATRIUM_PROPERTY.propertyId })
const STATES = { needs_triage: 'Needs triage', waiting_information: 'Waiting for information', management_review: 'Management review', ready_for_planning: 'Triaged for planning', emergency_review: 'Emergency review' }
const CONTEXT = { current: 'Source review current', expired: 'Source review expired', revoked: 'Record revoked', not_started: 'Occupancy not started', ended: 'Occupancy ended', not_established: 'Resident not established' }
const CATEGORIES = { plumbing: 'Plumbing', electrical: 'Electrical', heating_cooling: 'Heating & cooling', appliance: 'Appliance', pest: 'Pest', access: 'Access', other: 'Other' }
const ORIGINS = { resident_report: 'Resident report', staff_observation: 'Staff observation', unknown: 'Not established' }
const PRIORITIES = { routine: 'Routine', urgent: 'Urgent', emergency: 'Emergency' }
const FILTERS = { requests: [['attention', 'Needs review'], ['waiting', 'Waiting'], ['planning', 'Planning'], ['all', 'All requests']], residents: [['active', 'Active records'], ['revoked', 'Revoked'], ['all', 'All records']] }
const FILTER_STATES = { attention: ['needs_triage', 'management_review', 'emergency_review'], waiting: ['waiting_information'], planning: ['ready_for_planning'], all: Object.keys(STATES) }
const ERRORS = { service_version_conflict: 'This record changed. Refresh and review the latest version.', service_request_conflict: 'This request reference was used for a different change. Reload and review before continuing.', service_context_required: 'Current resident source context is required for that planning step. Review the resident record first.', service_emergency_hold: 'Emergency evidence holds this request for management review. It cannot be downgraded through ordinary triage.', service_not_found: 'This record is no longer available in this property.', service_invalid_input: 'Some details were refused. Review the form and its dates before trying again.' }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const validId = value => typeof value === 'string' && ID.test(value)
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key)
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const text = (v, max = 5000) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const optional = (v, max) => v === null || text(v, max)
const version = v => Number.isSafeInteger(v) && v > 0
const instant = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v))
const date = v => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v
const bad = () => Object.assign(new Error('The service workspace returned an unreadable result. Reload before making changes.'), { badJson: true, status: 200 })
const clone = value => JSON.parse(JSON.stringify(value))
function readLocation(v) {
  if (!object(v) || !['unit', 'common_area', 'unknown'].includes(v.kind) || (v.kind === 'unit' ? !text(v.unitId, 128) || !v.unitId : !text(v.label, 160))) throw bad()
  return v.kind === 'unit' ? { kind: v.kind, unitId: v.unitId } : { kind: v.kind, label: v.label }
}
function readSummary(v) {
  if (!object(v) || !validId(v.id) || !version(v.version) || !text(v.summary, 200) || !own(STATES, v.state) || !own(CATEGORIES, v.category)
    || !own(ORIGINS, v.requestOrigin) || typeof v.contextNeedsReview !== 'boolean' || !own(PRIORITIES, v.priority) || !instant(v.createdAt) || !instant(v.updatedAt) || !(v.residentId === null || validId(v.residentId))) throw bad()
  return Object.freeze({ id: v.id, version: v.version, location: readLocation(v.location), summary: v.summary, category: v.category,
    state: v.state, priority: v.priority, requestOrigin: v.requestOrigin, contextNeedsReview: v.contextNeedsReview, createdAt: v.createdAt, updatedAt: v.updatedAt, residentId: v.residentId })
}
function readResident(v) {
  if (!object(v) || !validId(v.id) || !validId(v.personId) || v.organizationId !== scope.organizationId || v.propertyId !== scope.propertyId
    || !version(v.version) || !text(v.unitId, 128) || !text(v.displayName, 160) || !['leaseholder', 'occupant'].includes(v.relationship)
    || !['active', 'revoked'].includes(v.status) || !own(CONTEXT, v.contextState) || v.contextState === 'not_established'
    || !date(v.startsOn) || !(v.endsOn === null || date(v.endsOn)) || !optional(v.phone, 64) || !optional(v.email, 254)
    || ![v.createdAt, v.updatedAt, v.reviewedAt].every(instant) || !validId(v.reviewedBy) || !object(v.source) || v.source.kind !== 'staff_review'
    || !text(v.source.reference, 500) || !text(v.source.version, 100) || !instant(v.source.observedAt) || !instant(v.source.validUntil)) throw bad()
  return Object.freeze(clone(v))
}
function readCursor(v, items) {
  if (v === null) return null
  if (!object(v) || !validId(v.id) || !instant(v.createdAt) || !items.length || items.at(-1).id !== v.id || items.at(-1).createdAt !== v.createdAt) throw bad()
  return Object.freeze({ id: v.id, createdAt: v.createdAt })
}
function readEvents(values, caseId) {
  if (!Array.isArray(values) || values.length > 25) throw bad()
  const events = values.map(v => {
    if (!object(v) || !validId(v.id) || v.caseId !== caseId || !version(v.caseVersion) || !['intake', 'note', 'triage', 'context'].includes(v.kind)
      || !validId(v.actorUserId) || !instant(v.createdAt) || !text(v.note, 5000) || !own(STATES, v.state) || !own(PRIORITIES, v.priority)) throw bad()
    readLocation(v.contextLocation)
    if (!(v.contextResidentId === null || validId(v.contextResidentId)) || !(v.contextResidentVersion === null || version(v.contextResidentVersion)) || !optional(v.contextResidentName, 120)) throw bad()
    return Object.freeze(clone(v))
  })
  if (new Set(events.map(v => v.id)).size !== events.length) throw bad()
  return events
}
function readDetail(v, id) {
  if (!object(v) || !object(v.request) || v.request.id !== id) throw bad()
  const request = v.request; readSummary(request); readLocation(request.intakeLocation)
  if (!(request.residentIdAtIntake === null || validId(request.residentIdAtIntake)) || !(request.residentVersionAtIntake === null || version(request.residentVersionAtIntake)) || !optional(request.residentNameAtIntake, 120)) throw bad()
  if (request.organizationId !== scope.organizationId || request.propertyId !== scope.propertyId || !text(request.description, 5000) || !text(request.accessNotes, 2000)
    || !optional(request.reporterName, 160) || !optional(request.reporterPhone, 64) || !optional(request.reporterEmail, 254)
    || !own(ORIGINS, request.requestOrigin) || !own(PRIORITIES, request.reportedPriority) || request.dispatchStatus !== 'not_dispatched' || request.notificationStatus !== 'not_sent'
    || request.callerIdentityVerified !== false || request.entryAuthorized !== false || !Array.isArray(request.emergencyKinds)
    || request.emergencyKinds.some(kind => !['gas', 'smoke_or_fire', 'carbon_monoxide', 'flooding', 'no_heat', 'injury', 'intruder', 'structural'].includes(kind))) throw bad()
  const resident = v.resident
  if (!object(resident) || !own(CONTEXT, resident.state) || resident.callerIdentityVerified !== false || resident.entryAuthorized !== false
    || resident.residentId !== request.residentId || !optional(resident.displayName, 160) || !optional(resident.unitId, 128)
    || !(resident.residentVersion === null || version(resident.residentVersion)) || !Array.isArray(v.related) || v.related.length > 25
    || typeof v.eventsTruncated !== 'boolean' || typeof v.relatedTruncated !== 'boolean') throw bad()
  const events = readEvents(v.events, id), nextEventsCursor = readCursor(v.nextEventsCursor, events)
  for (const row of v.related) if (!validId(row.id) || !text(row.summary, 200) || !own(STATES, row.state) || !own(PRIORITIES, row.priority) || !instant(row.createdAt)) throw bad()
  if (v.safetyInstructions !== undefined && (!Array.isArray(v.safetyInstructions) || v.safetyInstructions.some(value => !text(value, 2000)))) throw bad()
  return { request: clone(request), resident: clone(resident), events, nextEventsCursor, eventsTruncated: v.eventsTruncated, related: clone(v.related), relatedTruncated: v.relatedTruncated, safetyInstructions: v.safetyInstructions || [] }
}
function readReceipt(body, command) {
  const v = body?.receipt, isResident = ['add_resident', 'review_resident', 'revoke_resident'].includes(command.action)
  if (!object(v) || v.action !== command.action || v.requestId !== command.requestId || v.resource !== (isResident ? 'resident' : 'request')
    || !validId(v.id) || !version(v.version) || !instant(v.committedAt) || typeof v.replayed !== 'boolean'
    || command.id && v.id !== command.id || v.version !== (command.expectedVersion ? command.expectedVersion + 1 : 1)) throw bad()
  return v
}
const locationLabel = value => value.kind === 'unit' ? `Apartment ${value.unitId}` : value.kind === 'common_area' ? `Common area · ${value.label}` : value.label || 'Location not established'
const chip = (label, urgent = false) => A.html.chip(urgent ? 'chip-warn' : 'chip-neutral', urgent ? 'warning' : 'clock', label)
const facts = entries => '<dl class="sv-facts">' + entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value || 'Not recorded')}</dd></div>`).join('') + '</dl>'
const empty = (title, message) => `<div class="sv-empty"><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`
const emergencyHint = (value, priority) => priority === 'emergency' || /gas\s*(?:leak|smell)|smell.{0,12}gas|\bfire\b|smoke|carbon monoxide|flood|burst pipe|bleeding|unconscious|intruder|structural|ceiling.{0,16}(?:fall|collaps)/i.test(value)
const safetyNotice = '<strong>Act on immediate danger now</strong><p>Follow the building’s emergency procedure. If anyone is in immediate danger, contact emergency services from a safe place. Recording this request does not contact emergency services or building staff.</p>'
let root = null, active = false, epoch = 0, detailEpoch = 0, tab = 'requests', filter = 'attention', unit = '', items = [], cursor = null, selected = null
let savedToast = null
let overview = null, loaded = false, loading = false, detail = null, detailLoading = false, error = '', detailError = '', checkedAt = null, panel = null, busy = false, pending = null
const visible = () => Boolean(root && active && A.can('operate') && A.route().name === 'services')
function bounded(promise) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The response is unconfirmed.'), { status: 0 })), 15000) })]).finally(() => clearTimeout(timer))
}
function replace(host, html) {
  if (!host || host.innerHTML === html) return
  const key = host.contains(document.activeElement) ? document.activeElement?.dataset?.key : null, top = host.scrollTop, left = host.scrollLeft
  host.innerHTML = html; host.scrollTop = top; host.scrollLeft = left
  if (key) [...host.querySelectorAll('[data-key]')].find(node => node.dataset.key === key)?.focus({ preventScroll: true })
}
function listHtml() {
  if (!loaded) return empty(loading ? 'Loading saved records…' : 'Records not loaded', loading ? 'Checking this property’s service records.' : 'Refresh to try again.')
  if (!items.length) return empty(tab === 'requests' ? 'No requests in this result' : 'No resident records in this result', 'Change the filter or record a new entry. This view contains only saved records.')
  return '<ul class="sv-list">' + items.map(item => `<li><button type="button" class="sv-row" data-select="${esc(item.id)}" data-key="service:${esc(item.id)}" aria-current="${item.id === selected}" aria-controls="sv-detail"><span class="sv-row-top"><strong>${esc(tab === 'residents' ? item.displayName : item.summary)}</strong>${chip(tab === 'residents' ? CONTEXT[item.contextState] : item.contextNeedsReview ? 'Context needs review' : STATES[item.state], tab === 'residents' ? item.contextState !== 'current' : item.priority === 'emergency' || item.contextNeedsReview)}</span><span class="sv-row-context">${esc(tab === 'residents' ? `Apartment ${item.unitId} · ${item.relationship === 'leaseholder' ? 'Leaseholder' : 'Occupant'}` : `${locationLabel(item.location)} · ${PRIORITIES[item.priority]}`)}</span><span class="sv-row-date">Updated ${esc(A.fmt.dateTime(item.updatedAt))}</span></button></li>`).join('') + '</ul>'
}
function residentHtml(record) {
  return `<div class="sv-detail-head">${chip(CONTEXT[record.contextState], record.contextState !== 'current')}<h2 tabindex="-1" data-key="service-detail-heading">${esc(record.displayName)}</h2><p>Apartment ${esc(record.unitId)} · ${record.relationship === 'leaseholder' ? 'Leaseholder' : 'Occupant'}</p></div>` +
    '<div class="sv-boundary"><strong>Reviewed occupancy source</strong><p>This staff-reviewed record does not verify an incoming caller or authorize entry.</p></div>' +
    facts([['Occupancy begins', A.fmt.dayLong(record.startsOn)], ['Occupancy ends (exclusive)', record.endsOn ? A.fmt.dayLong(record.endsOn) : 'No end recorded'], ['Phone claim', record.phone], ['Email claim', record.email]]) +
    `<section class="sv-section"><h3>Source and review</h3>${facts([['Source reference', record.source.reference], ['Source version', record.source.version], ['Observed', A.fmt.dateTime(record.source.observedAt)], ['Review valid until', A.fmt.dateTime(record.source.validUntil)], ['Reviewed', A.fmt.dateTime(record.reviewedAt)]])}</section>` +
    (overview?.canManageResidents && A.can('configure') && record.status === 'active' && !error ? '<div class="sv-actions"><button type="button" class="btn btn-primary" data-command="review-resident">Review source</button><button type="button" class="btn" data-command="revoke-resident">Revoke record</button></div>' : '')
}
function requestHtml(value) {
  const r = value.request, contextNeedsReview = r.contextNeedsReview || r.location.kind === 'unknown' || r.location.kind === 'unit' && r.requestOrigin !== 'staff_observation' && value.resident.state !== 'current', emergency = r.priority === 'emergency' || r.emergencyKinds.length > 0
  let html = `<div class="sv-detail-head">${chip(r.contextNeedsReview ? 'Context needs review' : STATES[r.state], emergency || r.contextNeedsReview)}<h2 tabindex="-1" data-key="service-detail-heading">${esc(r.summary)}</h2><p>${esc(locationLabel(r.location))} · ${esc(CATEGORIES[r.category])}</p></div>`
  if (emergency) html += `<section class="sv-safety" role="alert">${safetyNotice}${value.safetyInstructions.map(instruction => `<p>${esc(instruction)}</p>`).join('')}</section>`
  html += `<section class="sv-next"><span class="page-eyebrow">NEXT STEP</span><h3>${esc(r.state === 'emergency_review' ? 'Management emergency review' : r.state === 'ready_for_planning' && contextNeedsReview ? 'Review current request context before planning' : r.state === 'needs_triage' ? 'Review the issue and context' : r.state === 'waiting_information' ? 'Gather the missing information' : r.state === 'management_review' ? 'Management decision needed' : 'Prepare an authorized work plan')}</h3><p>Not dispatched · No notification sent. Planning is not approval or a confirmed appointment.</p>${r.state === 'ready_for_planning' && contextNeedsReview ? '<p><strong>The earlier triage remains in history; current unit or occupancy context needs review before planning.</strong></p>' : ''}</section>` +
    `<section class="sv-section"><h3>Reported issue</h3><p class="sv-pre">${esc(r.description)}</p>${facts([['Request origin', ORIGINS[r.requestOrigin]], ['Reported priority', PRIORITIES[r.reportedPriority]], ['Current priority', PRIORITIES[r.priority]], ['First reported', A.fmt.dateTime(r.createdAt)], ['Last changed', A.fmt.dateTime(r.updatedAt)]])}${JSON.stringify(r.intakeLocation) !== JSON.stringify(r.location) || r.residentIdAtIntake !== r.residentId ? '<details class="sv-form-details"><summary>Original intake context</summary>' + facts([['Location at intake', locationLabel(r.intakeLocation)], ['Resident source at intake', r.residentNameAtIntake || 'Not established'], ['Source record version at intake', r.residentVersionAtIntake === null ? 'Not established' : String(r.residentVersionAtIntake)]]) + '</details>' : ''}</section>` +
    `<section class="sv-section"><h3>Resident context</h3>${chip(CONTEXT[value.resident.state], value.resident.state !== 'current')}<p>${esc(value.resident.displayName || 'No resident established')}${r.residentNameAtIntake && r.residentNameAtIntake !== value.resident.displayName ? ` · Originally linked as ${esc(r.residentNameAtIntake)}` : ''}</p><p class="sv-boundary">Caller identity not verified. No entry permission established.</p>${facts([['Reporter name claim', r.reporterName], ['Reporter phone claim', r.reporterPhone], ['Reporter email claim', r.reporterEmail]])}${r.residentId ? `<button type="button" class="btn" data-resident="${esc(r.residentId)}">Review resident source</button>` : ''}</section>` +
    `<section class="sv-section"><h3>Access notes</h3><p class="sv-pre">${esc(r.accessNotes || 'No access notes recorded.')}</p><p class="small muted">Reported instructions are not permission to enter.</p></section>` +
    '<div class="sv-actions"><button type="button" class="btn btn-primary" data-command="note">Add note</button><button type="button" class="btn" data-command="context">Update request context</button>' + (!emergency ? '<button type="button" class="btn" data-command="triage">Review triage</button>' : '') + '</div>' +
    `<section class="sv-section"><h3>Related requests at this unit</h3>${value.related.length ? '<ul class="sv-related">' + value.related.map(row => `<li><button type="button" class="sv-link" data-related="${esc(row.id)}">${esc(row.summary)}</button><span>${esc(STATES[row.state])}</span></li>`).join('') + '</ul>' : '<p>No related requests returned.</p>'}${value.relatedTruncated ? '<p class="small muted">Only part of the related history is shown.</p>' : ''}</section>` +
    `<section class="sv-section"><h3>Request history</h3><ol class="sv-history">${value.events.map(event => `<li><strong>${esc(event.kind === 'intake' ? 'Request recorded' : event.kind === 'note' ? 'Staff note' : event.kind === 'context' ? 'Request context updated' : 'Triage reviewed')}</strong><span>${esc(A.fmt.dateTime(event.createdAt))} · ${esc(STATES[event.state])}</span><span>${esc(locationLabel(event.contextLocation))}${event.contextResidentName ? ' · ' + esc(event.contextResidentName) + (event.contextResidentVersion ? ' (source version ' + event.contextResidentVersion + ')' : '') : ' · No resident source linked'}</span><p class="sv-pre">${esc(event.note)}</p></li>`).join('')}</ol>${value.nextEventsCursor ? '<button type="button" class="btn" data-command="events">Load earlier history</button>' : value.eventsTruncated ? '<p class="small muted">Earlier history is not included in this result.</p>' : ''}</section>`
  return html
}
function detailHtml() {
  if (detailLoading) return empty('Loading record…', 'Waiting for current saved details.')
  if (detailError) return empty('Record could not be loaded', detailError)
  if (!detail) return empty('Select a record', 'See its context, saved history and next step.')
  return (tab === 'residents' ? residentHtml(detail) : requestHtml(detail)) + `<p class="sv-zone">Times in ${esc(A.property.timeZoneLabel)}. Refresh before acting on a changed record.</p>`
}
function paint({ list = true } = {}) {
  if (!visible()) return
  for (const button of root.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab))
  replace(root.querySelector('.sv-filters'), FILTERS[tab].map(([key, label]) => `<button type="button" class="btn" data-filter="${key}" aria-pressed="${filter === key}">${esc(label)}</button>`).join(''))
  const add = root.querySelector('[data-command="add"]'); add.textContent = tab === 'requests' ? 'Record request' : 'Add reviewed record'; add.hidden = tab === 'residents' && !(overview?.canManageResidents && A.can('configure')); add.disabled = loading || !overview || Boolean(error) || busy || Boolean(pending)
  const refresh = root.querySelector('[data-command="refresh"]'); refresh.disabled = loading || busy; refresh.textContent = loading ? 'Refreshing…' : 'Refresh'
  root.querySelector('.sv-loaded').textContent = loading ? 'Checking saved service records…' : checkedAt ? `${items.length} records shown · checked ${A.fmt.time(checkedAt)}` : 'No records received yet'
  replace(root.querySelector('.sv-errors'), (error ? A.html.banner('warn', error) : '') + (pending ? A.html.banner('warn', 'The last save is unconfirmed. Check the same change before starting another.', { actionsHtml: '<button type="button" class="btn" data-command="retry">Check saved change</button><button type="button" class="btn" data-command="reload">Reload page</button>' }) : ''))
  const listNode = root.querySelector('.sv-results'); listNode.setAttribute('aria-busy', String(loading))
  if (list) replace(listNode, listHtml()); else for (const button of listNode.querySelectorAll('[data-select]')) button.setAttribute('aria-current', String(button.dataset.select === selected))
  replace(root.querySelector('.sv-detail'), detailHtml())
  const more = root.querySelector('[data-command="more"]'); more.hidden = !cursor; more.disabled = loading || busy
  for (const node of root.querySelectorAll('[data-command="note"], [data-command="context"], [data-command="triage"], [data-command="review-resident"], [data-command="revoke-resident"]')) node.disabled = busy || Boolean(pending) || loading || Boolean(error)
}
async function getOverview() {
  const body = await bounded(A.api.get(ENDPOINT + '?resource=overview'))
  if (!text(body.formToken, 2000) || !body.formToken || typeof body.canManageResidents !== 'boolean' || !Array.isArray(body.units) || body.units.length > 10000 || body.timeZone !== A.property.timeZone
    || body.units.some(row => !object(row) || !text(row.id, 128) || !row.id || !text(row.label, 160)) || new Set(body.units.map(row => row.id)).size !== body.units.length) throw bad()
  return { formToken: body.formToken, canManageResidents: body.canManageResidents, units: body.units.map(row => ({ id: row.id, label: row.label })) }
}
async function load(more = false) {
  if (!visible() || busy || more && (loading || !cursor)) return
  const turn = ++epoch, savedTab = tab, savedFilter = filter, savedUnit = unit, before = more ? cursor : null
  const focusMore = more && document.activeElement?.dataset?.command === 'more'
  loading = true; error = ''; paint({ list: !loaded })
  try {
    const nextOverview = await getOverview()
    const query = new URLSearchParams({ resource: savedTab, [savedTab === 'requests' ? 'state' : 'status']: savedFilter, limit: '25' })
    if (savedUnit) query.set('unitId', savedUnit)
    if (before) { query.set('beforeCreatedAt', before.createdAt); query.set('beforeId', before.id) }
    const body = await bounded(A.api.get(ENDPOINT + '?' + query)), values = body[savedTab]
    if (!Array.isArray(values) || values.length > 25) throw bad()
    const rows = values.map(savedTab === 'requests' ? readSummary : readResident), nextCursor = readCursor(body.nextCursor, rows)
    if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => savedUnit && (savedTab === 'requests' ? row.location.unitId : row.unitId) !== savedUnit
      || savedTab === 'requests' && !FILTER_STATES[savedFilter].includes(row.state) && !(savedFilter === 'attention' && row.contextNeedsReview) || savedTab === 'residents' && savedFilter !== 'all' && row.status !== savedFilter)) throw bad()
    if (!visible() || turn !== epoch) return
    overview = nextOverview; items = more ? [...new Map([...items, ...rows].map(row => [row.id, row])).values()] : rows; cursor = nextCursor; loaded = true; checkedAt = new Date().toISOString()
    replace(root.querySelector('.sv-unit-filter'), '<label for="sv-unit">Location</label><select class="input" id="sv-unit" data-unit-filter><option value="">All units &amp; areas</option>' + overview.units.map(row => `<option value="${esc(row.id)}"${row.id === unit ? ' selected' : ''}>${esc(row.label)}</option>`).join('') + '</select>')
    if (!selected) selected = items[0]?.id || null
    loading = false; paint()
    if (focusMore && !cursor) [...root.querySelector('.sv-results').querySelectorAll('[data-select]')].at(-1)?.focus({ preventScroll: true })
    if (selected && !more) await select(selected, false)
  } catch (failure) {
    if (visible() && turn === epoch && !failure.propertyAccess && !failure.signedOut) { error = 'Service records could not be loaded. Saved information may be out of date. Refresh before making changes.'; detail = null }
  } finally { if (visible() && turn === epoch) { loading = false; paint() } }
}
async function select(id, focus = true) {
  if (!visible() || busy || !validId(id)) return
  const turn = ++detailEpoch, routeEpoch = epoch, resource = tab === 'requests' ? 'request' : 'resident'
  selected = id; detail = null; detailError = ''; detailLoading = true; paint({ list: false })
  try {
    const body = await bounded(A.api.get(ENDPOINT + '?' + new URLSearchParams({ resource, id })))
    const value = resource === 'request' ? readDetail({ ...body.detail, safetyInstructions: body.safetyInstructions }, id) : readResident(body.resident)
    if (resource === 'resident' && value.id !== id) throw bad()
    if (!visible() || turn !== detailEpoch || routeEpoch !== epoch) return
    detail = value
  } catch (failure) { if (visible() && turn === detailEpoch && routeEpoch === epoch && !failure.propertyAccess && !failure.signedOut) detailError = 'Refresh and select the record again to check its current details.' }
  finally {
    if (visible() && turn === detailEpoch && routeEpoch === epoch) {
      detailLoading = false; paint({ list: false })
      if (focus && matchMedia('(max-width: 760px)').matches) { const heading = root.querySelector('[data-key="service-detail-heading"]'); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
    }
  }
}
async function loadEvents() {
  if (!visible() || busy || detailLoading || tab !== 'requests' || !detail?.nextEventsCursor) return
  const turn = detailEpoch, id = detail.request.id, before = detail.nextEventsCursor
  detailLoading = true
  try {
    const body = await bounded(A.api.get(ENDPOINT + '?' + new URLSearchParams({ resource: 'events', id, limit: '25', beforeCreatedAt: before.createdAt, beforeId: before.id })))
    const events = readEvents(body.events, id), next = readCursor(body.nextCursor, events)
    if (!visible() || turn !== detailEpoch || detail?.request.id !== id) return
    detail.events = [...new Map([...detail.events, ...events].map(row => [row.id, row])).values()]; detail.nextEventsCursor = next
  } catch (failure) { if (visible() && turn === detailEpoch && !failure.propertyAccess && !failure.signedOut) A.toast('Earlier history could not be loaded. The visible history is incomplete.', { kind: 'warn' }) }
  finally { if (visible() && turn === detailEpoch) { detailLoading = false; paint({ list: false }); (root.querySelector('[data-command="events"]') || root.querySelector('[data-key="service-detail-heading"]'))?.focus({ preventScroll: true }) } }
}
const field = (id, label, value = '', type = 'text', max = 120, required = false) => `<div class="field"><label class="field-label" for="sv-${id}">${esc(label)}</label><input class="input" id="sv-${id}" type="${type}" value="${esc(value)}" maxlength="${max}"${required ? ' required' : ''}></div>`
const area = (id, label, value = '', max = 4000, required = false) => `<div class="field"><label class="field-label" for="sv-${id}">${esc(label)}</label><textarea class="input" id="sv-${id}" rows="3" maxlength="${max}"${required ? ' required' : ''}>${esc(value)}</textarea></div>`
const selectField = (id, label, choices, value = '') => `<div class="field"><label class="field-label" for="sv-${id}">${esc(label)}</label><select class="input" id="sv-${id}">${choices.map(([key, title]) => `<option value="${esc(key)}"${key === value ? ' selected' : ''}>${esc(title)}</option>`).join('')}</select></div>`
const val = (body, key) => body.querySelector('#sv-' + key)?.value.trim() || ''
const nullable = value => value || null
function localInput(iso) {
  if (!iso) return ''
  const p = A.fmt.nyParts(iso)
  return `${p.ymd}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
/** Explicit property wall times; refuse nonexistent or ambiguous DST times. */
function sourceInstant(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) || !date(value.slice(0, 10))) throw new Error('Enter a valid source date and time.')
  const nominal = Date.parse(value + ':00.000Z'), matches = []
  for (let offset = -16 * 60; offset <= 16 * 60; offset += 15) {
    const candidate = nominal + offset * 60000
    if (localInput(candidate) === value) matches.push(candidate)
  }
  if (matches.length !== 1) throw new Error('This source time is ambiguous or unavailable because of a clock change. Choose an unambiguous local time from the source.')
  return new Date(matches[0]).toISOString()
}
function requiredText(value, label, min, max) {
  if (!text(value, max) || value.length < min) throw new Error(`${label} must contain ${min === 1 ? 'at least one' : 'at least ' + min} character${min === 1 ? '' : 's'} (maximum ${max}).`)
  return value
}
function contacts(body, prefix = '') {
  const phone = nullable(val(body, prefix + 'phone')), email = nullable(val(body, prefix + 'email'))
  if (phone && !/^\+?[0-9][0-9 ()-]{5,30}$/.test(phone)) throw new Error('Enter a valid phone claim or leave it blank.')
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new Error('Enter a valid email claim or leave it blank.')
  return { phone, email }
}
function residentForm(record) {
  const d = record || {}, source = d.source || {}
  return '<p class="sv-form-note">Record the occupancy evidence you actually reviewed. This does not verify a caller or authorize entry. Source times below use ' + esc(A.property.timeZoneLabel) + '.</p><div class="sv-form-grid">' +
    (record ? `<p>Apartment <strong>${esc(record.unitId)}</strong> · unit and person links stay fixed.</p>` : selectField('unit', 'Apartment', [['', 'Choose an apartment'], ...overview.units.map(row => [row.id, row.label])])) +
    field('name', 'Resident name', d.displayName, 'text', 120, true) + selectField('relationship', 'Relationship', [['leaseholder', 'Leaseholder'], ['occupant', 'Occupant']], d.relationship || 'occupant') +
    field('starts', 'Occupancy begins', d.startsOn, 'date', 10, true) + field('ends', 'Occupancy ends (exclusive, optional)', d.endsOn, 'date', 10) + field('phone', 'Phone claim (optional)', d.phone, 'tel', 32) + field('email', 'Email claim (optional)', d.email, 'email', 254) + '</div>' +
    field('reference', 'Reviewed source reference', source.reference, 'text', 240, true) + field('source-version', 'Source version', source.version, 'text', 80, true) +
    '<div class="sv-form-grid">' + field('observed', 'Source observed at (property time)', localInput(source.observedAt), 'datetime-local', 30, true) + field('valid-until', 'Review valid until (property time)', localInput(source.validUntil), 'datetime-local', 30, true) + '</div><p class="small muted">The observed time must not be in the future. Review validity must be current and at most 90 days from the observed time.</p>' + area('reason', 'Reason for this record or review', '', 1000, true)
}
function readResidentForm(body, record) {
  const details = { displayName: requiredText(val(body, 'name'), 'Name', 1, 120), relationship: val(body, 'relationship'), startsOn: val(body, 'starts'), endsOn: nullable(val(body, 'ends')), ...contacts(body),
    source: { kind: 'staff_review', reference: requiredText(val(body, 'reference'), 'Source reference', 3, 240), version: requiredText(val(body, 'source-version'), 'Source version', 1, 80), observedAt: record && localInput(record.source.observedAt) === val(body, 'observed') ? record.source.observedAt : sourceInstant(val(body, 'observed')), validUntil: record && localInput(record.source.validUntil) === val(body, 'valid-until') ? record.source.validUntil : sourceInstant(val(body, 'valid-until')) } }
  if (!['leaseholder', 'occupant'].includes(details.relationship) || !date(details.startsOn) || details.endsOn && (!date(details.endsOn) || details.endsOn <= details.startsOn)) throw new Error('Check the occupancy dates. The exclusive end must be later than the start.')
  const observed = Date.parse(details.source.observedAt), until = Date.parse(details.source.validUntil)
  if (observed > Date.now() || until <= Date.now() || until <= observed || until - observed > 90 * 86400000) throw new Error('Check the source review dates: observed time cannot be future, and validity must be current and within 90 days.')
  if (!record) { details.unitId = val(body, 'unit'); if (!overview.units.some(row => row.id === details.unitId)) throw new Error('Choose an apartment from this property.') }
  return { action: record ? 'review_resident' : 'add_resident', ...(record ? { id: record.id, expectedVersion: record.version } : {}), details, reason: requiredText(val(body, 'reason'), 'Reason', 3, 1000) }
}
function intakeForm() {
  return '<div class="sv-safety sv-immediate-safety" role="alert" hidden></div><div class="sv-form-grid">' + selectField('location', 'Where is the issue?', [['unit', 'Apartment'], ['common_area', 'Common area'], ['unknown', 'Location not established']]) +
    selectField('unit', 'Apartment', [['', 'Choose an apartment'], ...overview.units.map(row => [row.id, row.label])], unit) + '</div>' + field('location-label', 'Common area or location description', '', 'text', 160) +
    '<div class="sv-resident-select">' + selectField('resident', 'Resident source link (optional)', [['', 'No resident established']]) + '<p class="sv-source-hint small muted">Choose an apartment to load its records. A contact claim is never matched automatically.</p><button type="button" class="btn" data-form-action="resident-more" hidden>Load more resident records</button></div>' +
    selectField('origin', 'Request origin', Object.entries(ORIGINS), 'resident_report') + field('summary', 'Issue summary', '', 'text', 160, true) + area('description', 'What was reported? (optional)', '', 4000) + '<div class="sv-form-grid">' + selectField('category', 'Category', Object.entries(CATEGORIES), 'other') + selectField('priority', 'Reported priority', Object.entries(PRIORITIES), 'routine') + '</div>' +
    '<details class="sv-form-details"><summary>Reporter contact claims (optional)</summary>' + field('reporter-name', 'Reporter name claim', '', 'text', 120) + field('reporter-phone', 'Reporter phone claim', '', 'tel', 32) + field('reporter-email', 'Reporter email claim', '', 'email', 254) + '</details>' +
    area('access', 'Reported access notes (optional)', '', 1000) + '<p class="sv-form-note">Caller identity is unverified. Access notes do not grant entry permission. Saving records the request; it does not dispatch work or send a notification.</p>'
}
function selectedContext(body, residentChoices) {
  const kind = val(body, 'location'), unitId = val(body, 'unit'), label = val(body, 'location-label') || (val(body, 'location') === 'unknown' ? 'Location not established' : '')
  if (!['unit', 'common_area', 'unknown'].includes(kind)) throw new Error('Choose a location type.')
  if (kind === 'unit' && !overview.units.some(row => row.id === unitId)) throw new Error('Choose an apartment from this property.')
  if (kind === 'common_area') requiredText(label, 'Common area', 1, 160)
  const residentId = kind === 'unit' ? nullable(val(body, 'resident')) : null
  if (residentId && !residentChoices.some(row => row.id === residentId && row.unitId === unitId)) throw new Error('Select a resident source loaded for this apartment, or leave the link empty.')
  return { location: kind === 'unit' ? { kind, unitId } : { kind, label }, residentId }
}
function readIntake(body, residentChoices) {
  const selected = selectedContext(body, residentChoices)
  const requestOrigin = val(body, 'origin')
  if (!own(ORIGINS, requestOrigin)) throw new Error('Choose how this issue was reported.')
  const contact = contacts(body, 'reporter-'), category = val(body, 'category'), reportedPriority = val(body, 'priority')
  if (!own(CATEGORIES, category) || !own(PRIORITIES, reportedPriority)) throw new Error('Choose a category and reported priority.')
  return { action: 'create_request', intake: { requestOrigin, ...selected,
    summary: requiredText(val(body, 'summary'), 'Summary', 3, 160), description: val(body, 'description'), category, reportedPriority,
    reporterName: nullable(val(body, 'reporter-name')), reporterPhone: contact.phone, reporterEmail: contact.email, accessNotes: val(body, 'access') } }
}
function contextForm(record) {
  return '<p class="sv-form-note">Clarify this request’s location or explicitly linked resident source. Original intake and the request origin stay in history. Ordinary requests return to Needs triage; emergency evidence stays held.</p><div class="sv-form-grid">' +
    selectField('location', 'Current location', [['unit', 'Apartment'], ['common_area', 'Common area'], ['unknown', 'Location not established']], record.location.kind) +
    selectField('unit', 'Apartment', [['', 'Choose an apartment'], ...overview.units.map(row => [row.id, row.label])], record.location.unitId || '') + '</div>' +
    field('location-label', 'Common area or location description', record.location.label || '', 'text', 160) +
    '<div class="sv-resident-select">' + selectField('resident', 'Resident source link (optional)', [['', 'No resident established']]) + '<p class="sv-source-hint small muted">Loading the selected apartment’s source records.</p><button type="button" class="btn" data-form-action="resident-more" hidden>Load more resident records</button></div>' +
    area('note', 'Why is this context being updated?', '', 4000, true) + '<p class="sv-form-note">A source link does not verify the caller or authorize entry.</p>'
}
function reviewHtml(command, selectedResidentName = null) {
  let entries
  if (command.action === 'create_request') {
    const r = command.intake
    entries = [['Request origin', ORIGINS[r.requestOrigin]], ['Location', locationLabel(r.location)], ['Summary', r.summary], ['Description', r.description], ['Category', CATEGORIES[r.category]], ['Reported priority', PRIORITIES[r.reportedPriority]], ['Resident source', r.residentId ? selectedResidentName || 'Explicitly selected source record' : 'Not established'], ['Reporter name claim', r.reporterName], ['Reporter phone claim', r.reporterPhone], ['Reporter email claim', r.reporterEmail], ['Access notes (not entry permission)', r.accessNotes]]
  } else if (command.action === 'update_context') {
    entries = [['Request', detail?.request.summary], ['New location', locationLabel(command.location)], ['Resident source', command.residentId ? selectedResidentName || 'Explicitly selected source record' : 'Not established'], ['Reason for clarification', command.note], ['Effect', 'Current context updated; original intake retained. Ordinary request needs triage again.']]
  } else if (command.details) {
    const d = command.details
    entries = [['Apartment', d.unitId || detail?.unitId], ['Resident name', d.displayName], ['Relationship', d.relationship], ['Occupancy begins', d.startsOn], ['Occupancy ends (exclusive)', d.endsOn], ['Phone claim', d.phone], ['Email claim', d.email], ['Source reference', d.source.reference], ['Source version', d.source.version], ['Observed', A.fmt.dateTime(d.source.observedAt)], ['Valid until', A.fmt.dateTime(d.source.validUntil)], ['Reason', command.reason]]
  } else entries = [['Record', tab === 'requests' ? detail?.request.summary : detail?.displayName], ...(command.state ? [['State', STATES[command.state]], ['Priority', PRIORITIES[command.priority]]] : []), ['Note or reason', command.note || command.reason]]
  return (emergencyHint(command.intake ? [command.intake.summary, command.intake.description, command.intake.accessNotes].join(' ') : command.note || '', command.intake?.reportedPriority) ? '<div class="sv-safety" role="alert">' + safetyNotice + '</div>' : '') + '<div class="sv-review"><span class="page-eyebrow">REVIEW BEFORE SAVING</span>' + facts(entries) + '<p class="sv-form-note">This change is recorded in this property only. It does not verify a caller, authorize entry, dispatch work, send a notification or resolve a request.</p></div>'
}
function immediateSafety(body) {
  const box = body.querySelector('.sv-immediate-safety'); if (!box) return
  const description = ['summary', 'description', 'access', 'note'].map(key => val(body, key)).join(' ')
  const urgent = emergencyHint(description, val(body, 'priority'))
  box.hidden = !urgent; if (urgent) box.innerHTML = safetyNotice
}
function openForm(kind, recovery = null) {
  if (!visible() || panel || busy || !overview || !recovery && (pending || loading || error)) return
  const residentAction = ['add_resident', 'review_resident', 'revoke_resident'].includes(kind)
  if (residentAction && !(overview.canManageResidents && A.can('configure'))) return
  const original = residentAction ? (kind === 'add_resident' ? null : detail) : (kind === 'create_request' ? null : detail?.request)
  if (!recovery && !['add_resident', 'create_request'].includes(kind) && !original) return
  if (!recovery && kind === 'triage_request' && (original.priority === 'emergency' || original.emergencyKinds.length)) return
  savedToast?.close?.(); savedToast = null
  const turn = epoch
  let closed = false, command = recovery?.command || null, token = recovery?.token || overview.formToken, review = Boolean(recovery), uncertain = Boolean(recovery), retired = false
  let reviewedHtml = recovery?.html || ''
  let draftNodes = null, residentChoices = [], residentCursor = null, residentGeneration = 0, residentLoading = false
  const title = { create_request: 'Record service request', add_resident: 'Add reviewed resident record', review_resident: 'Review resident source', revoke_resident: 'Revoke resident record', add_note: 'Add request note', triage_request: 'Review request triage', update_context: 'Update request context' }[kind]
  function current() { return !closed && visible() && turn === epoch }
  async function loadResidents(body, more = false) {
    const apartment = val(body, 'unit'), gen = ++residentGeneration, picker = body.querySelector('#sv-resident'), hint = body.querySelector('.sv-source-hint'), moreButton = body.querySelector('[data-form-action="resident-more"]')
    if (!picker) return
    if (!more) {
      residentChoices = []; residentCursor = null
      const saved = kind === 'update_context' && detail?.resident && original?.location.kind === 'unit' && original.location.unitId === apartment && val(body, 'location') === 'unit' ? detail.resident : null
      if (saved?.residentId) residentChoices.push({ id: saved.residentId, unitId: apartment, displayName: saved.displayName || 'Previously linked resident source', contextState: saved.state })
      picker.innerHTML = '<option value="">No resident established</option>' + residentChoices.map(row => `<option value="${esc(row.id)}">${esc(row.displayName)} · ${esc(CONTEXT[row.contextState])}</option>`).join(''); picker.value = residentChoices[0]?.id || ''
    }
    if (val(body, 'location') !== 'unit' || !apartment) { picker.disabled = true; hint.textContent = 'No resident link for an unknown or common-area location.'; moreButton.hidden = true; return }
    residentLoading = true; picker.disabled = true; moreButton.disabled = true; hint.textContent = 'Loading this apartment’s reviewed records…'
    try {
      const query = new URLSearchParams({ resource: 'residents', status: 'active', limit: '25', unitId: apartment })
      if (more && residentCursor) { query.set('beforeCreatedAt', residentCursor.createdAt); query.set('beforeId', residentCursor.id) }
      const bodyResult = await bounded(A.api.get(ENDPOINT + '?' + query))
      if (!Array.isArray(bodyResult.residents) || bodyResult.residents.length > 25) throw bad()
      const rows = bodyResult.residents.map(readResident), next = readCursor(bodyResult.nextCursor, rows)
      if (rows.some(row => row.unitId !== apartment || row.status !== 'active')) throw bad()
      if (!current() || gen !== residentGeneration || review) return
      residentChoices = [...new Map([...residentChoices, ...rows].map(row => [row.id, row])).values()]; residentCursor = next
      const chosen = picker.value
      picker.innerHTML = '<option value="">No resident established</option>' + residentChoices.map(row => `<option value="${esc(row.id)}">${esc(row.displayName)} · ${esc(CONTEXT[row.contextState])}</option>`).join(''); picker.value = chosen
      hint.textContent = `${residentChoices.length} records loaded. Choose explicitly; this does not verify the reporter.`; moreButton.hidden = !next
    } catch (failure) { if (current() && gen === residentGeneration) { hint.textContent = 'Resident records could not be loaded. You can still record an unlinked request.'; moreButton.hidden = true } }
    finally { if (current() && gen === residentGeneration) { residentLoading = false; picker.disabled = false; moreButton.disabled = false } }
  }
  const options = { title, secondary: { label: recovery ? 'Close' : 'Cancel', onClick(dialog) {
    if (review && !uncertain && !retired) { command = null; review = false; dialog.body.replaceChildren(...draftNodes); dialog.setPrimary({ label: 'Review change' }); dialog.setError(null) }
    else dialog.close()
  } }, build(body) {
    if (recovery) { body.innerHTML = recovery.html; return }
    body.innerHTML = kind === 'create_request' ? intakeForm() : kind === 'update_context' ? contextForm(original) : ['add_resident', 'review_resident'].includes(kind) ? residentForm(original)
      : kind === 'revoke_resident' ? '<p class="sv-form-note">This revokes the current property occupancy record. Its source history and existing requests remain. It does not change another property or the person’s login.</p>' + area('reason', 'Reason for revocation', '', 1000, true)
        : (kind === 'triage_request' ? selectField('state', 'Next state', [['waiting_information', 'Waiting for information'], ['management_review', 'Management review'], ['ready_for_planning', 'Ready for planning']], 'management_review') + selectField('priority', 'Reviewed priority', [['routine', 'Routine'], ['urgent', 'Urgent']], original.priority) + '<p class="sv-form-note">Ready for planning needs current source context for unit work. It is not spending approval, entry permission or dispatch.</p>' : '') + area('note', kind === 'add_note' ? 'Staff note' : 'Triage note and reason', '', 4000, true)
    if (!residentAction) {
      if (kind !== 'create_request') body.innerHTML = '<div class="sv-safety sv-immediate-safety" role="alert" hidden></div>' + body.innerHTML
      body.addEventListener('input', () => immediateSafety(body))
    }
    if (kind === 'create_request' || kind === 'update_context') {
      body.addEventListener('change', event => { immediateSafety(body); if (['sv-unit', 'sv-location'].includes(event.target.id)) loadResidents(body) })
      body.querySelector('[data-form-action="resident-more"]').addEventListener('click', () => { if (!residentLoading && residentCursor) loadResidents(body, true) })
      loadResidents(body)
    }
  }, primary: { label: recovery ? 'Retry this exact change' : 'Review change', async onClick(dialog) {
    if (!current() || busy) return
    if (retired) { dialog.close(); return }
    if (!review) {
      try {
        if (kind === 'create_request') command = readIntake(dialog.body, residentChoices)
        else if (kind === 'update_context') command = { action: kind, id: original.id, expectedVersion: original.version, ...selectedContext(dialog.body, residentChoices), note: requiredText(val(dialog.body, 'note'), 'Clarification note', 3, 4000) }
        else if (kind === 'add_resident' || kind === 'review_resident') command = readResidentForm(dialog.body, original)
        else if (kind === 'revoke_resident') command = { action: kind, id: original.id, expectedVersion: original.version, reason: requiredText(val(dialog.body, 'reason'), 'Reason', 3, 1000) }
        else command = { action: kind, id: original.id, expectedVersion: original.version, note: requiredText(val(dialog.body, 'note'), 'Note', 3, 4000), ...(kind === 'triage_request' ? { state: val(dialog.body, 'state'), priority: val(dialog.body, 'priority') } : {}) }
        command.requestId = crypto.randomUUID(); command = Object.freeze(clone(command)); review = true; residentGeneration++
        draftNodes = [...dialog.body.childNodes]; reviewedHtml = reviewHtml(command, residentChoices.find(row => row.id === (command.intake?.residentId || command.residentId))?.displayName || null); dialog.body.innerHTML = reviewedHtml; dialog.setError(null); dialog.setPrimary({ label: 'Save reviewed change' })
      } catch (failure) { dialog.setError(failure.message) }
      return
    }
    busy = true; pending = { command, token, html: reviewedHtml }; dialog.setError(null)
    try {
      const receipt = readReceipt(await bounded(A.api.post(ENDPOINT, command, { formToken: token, doing: 'Saving a reviewed service change' })), command)
      if (!current()) return
      pending = null; dialog.close(); busy = false
      savedToast = A.toast('Change recorded. Loading saved record…', { kind: 'info' })
      tab = receipt.resource === 'resident' ? 'residents' : 'requests'; filter = 'all'; selected = receipt.id; items = []; loaded = false; detail = null
      A.navigate('services', { tab, state: filter }); await load()
    } catch (failure) {
      if (!current() || failure.propertyAccess || failure.signedOut) return
      const code = failure.body?.code, known = [400, 404, 409].includes(failure.status) && !failure.badJson && own(ERRORS, code)
      if (known && !uncertain) {
        pending = null; retired = true; error = ERRORS[code]; dialog.setError(error); dialog.setPrimary({ label: 'Close and refresh' })
      } else {
        uncertain = true; pending = { command, token, html: reviewedHtml }
        dialog.setError('This save is unconfirmed and may have been recorded. Retry this exact change to check or complete it. Do not start another change until you reconcile it.'); dialog.setPrimary({ label: 'Retry this exact change' })
      }
    } finally { busy = false; if (!closed) dialog.setBusy(null); paint({ list: false }) }
  } }, onClose() { closed = true; residentGeneration++; panel = null } }
  panel = A.dialog(options)
}
function deactivate() { active = false; epoch++; detailEpoch++; loading = false; detailLoading = false; if (panel) panel.close() }
const view = {
  title: 'Service', icon: 'home',
  mount(el) {
    root = el; root.classList.add('sv-view')
    root.innerHTML = `<header class="page-hero sv-hero"><div><span class="page-eyebrow">RESIDENT OPERATIONS · ${esc(A.property.name)}</span><h1 tabindex="-1">Service</h1><p>Understand the issue, review the resident context, and give every request a clear next step.</p></div><div class="page-hero-actions"><button type="button" class="btn btn-primary" data-command="add">Record request</button><button type="button" class="btn" data-command="refresh">Refresh</button></div></header>` +
      '<div class="sv-story"><div><span>01</span><strong>Record the issue</strong><p>Keep the report and location together.</p></div><div><span>02</span><strong>Review the context</strong><p>Separate source evidence from caller identity.</p></div><div><span>03</span><strong>Plan the next step</strong><p>Saved triage, with dispatch still pending.</p></div></div>' +
      '<div class="sv-toolbar"><div class="sv-tabs" role="group" aria-label="Service workspace"><button type="button" class="btn" data-tab="requests">Requests</button><button type="button" class="btn" data-tab="residents">Resident records</button></div><div class="sv-unit-filter"></div></div><div class="sv-filters" role="group" aria-label="Filter service records"></div><p class="sv-loaded" role="status"></p><div class="sv-errors"></div>' +
      '<div class="sv-workspace"><section class="sv-browser" aria-label="Service records"><div class="sv-results" aria-busy="false"></div><div class="sv-pagination"><button type="button" class="btn" data-command="more" hidden>Load more records</button></div></section><section class="sv-detail" id="sv-detail" aria-label="Selected service record"></section></div>'
    root.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || !root.contains(button) || button.disabled || busy) return
      if (button.dataset.tab && FILTERS[button.dataset.tab]) A.navigate('services', { tab: button.dataset.tab })
      else if (button.dataset.filter && FILTERS[tab].some(([key]) => key === button.dataset.filter)) A.navigate('services', { tab, state: button.dataset.filter, unit })
      else if (button.dataset.select) select(button.dataset.select)
      else if (button.dataset.related) select(button.dataset.related)
      else if (button.dataset.resident) { selected = button.dataset.resident; A.navigate('services', { tab: 'residents', state: 'all', id: button.dataset.resident }) }
      else {
        const action = button.dataset.command
        if (action === 'refresh') load()
        else if (action === 'more') load(true)
        else if (action === 'events') loadEvents()
        else if (action === 'reload') location.reload()
        else if (action === 'retry' && pending) openForm(pending.command.action, pending)
        else if (action === 'add') openForm(tab === 'requests' ? 'create_request' : 'add_resident')
        else if (['note', 'context', 'triage', 'review-resident', 'revoke-resident'].includes(action)) openForm({ note: 'add_note', context: 'update_context', triage: 'triage_request', 'review-resident': 'review_resident', 'revoke-resident': 'revoke_resident' }[action])
      }
    })
    root.addEventListener('change', event => { if (event.target.matches('[data-unit-filter]') && !busy) A.navigate('services', { tab, state: filter, unit: event.target.value }) })
    A.on('route', route => { if (route.name !== 'services') deactivate() })
  },
  render() {
    if (!A.can('operate') || A.route().name !== 'services') return
    const params = A.route().params, nextTab = params.tab === 'residents' ? 'residents' : 'requests'
    const nextFilter = FILTERS[nextTab].some(([key]) => key === params.state) ? params.state : nextTab === 'requests' ? 'attention' : 'active', nextUnit = params.unit || ''
    if (tab !== nextTab || filter !== nextFilter || unit !== nextUnit) { deactivate(); tab = nextTab; filter = nextFilter; unit = nextUnit; items = []; cursor = null; selected = validId(params.id || '') ? params.id : null; loaded = false; detail = null; error = ''; checkedAt = null }
    const entered = !active; active = true; paint(); if (entered) load()
  },
}
window.addEventListener('pagehide', () => { deactivate(); pending = null; overview = null; items = []; detail = null; root?.replaceChildren() })
window.addEventListener('pageshow', event => { if (event.persisted) location.reload() })
A.register('services', view)
})()
