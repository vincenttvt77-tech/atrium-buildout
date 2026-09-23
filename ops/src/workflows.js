/* Property work queue. Inspection, deliberate recovery and verification-only email checks. */
(function () {
'use strict'
const A = window.Atrium
if (!A || !A.databaseMode) return
const esc = A.escapeHtml
const FILTERS = [['attention', 'Needs review'], ['active', 'In progress'], ['complete', 'Finished'], ['all', 'All work']]
const STATES = {
  queued: ['Queued', 'Saved and waiting to be picked up.', 'neutral'],
  running: ['Processing', 'The last recorded attempt is in progress. Refresh to check its outcome.', 'neutral'],
  retry_wait: ['Waiting to retry', 'A safe retry is waiting. The requested work is not yet confirmed.', 'warn'],
  verifying: ['Verifying', 'An earlier attempt may have reached the provider. Its result must be checked before another attempt.', 'warn'],
  succeeded: ['Verified result', 'The action has a verified result. This does not establish that the wider resident or prospect request is resolved.', 'ok'],
  needs_review: ['Needs review', 'This action is held. Review the recorded issue before deciding what happens next.', 'warn'],
  cancelled: ['Cancelled in queue', 'This queued action was stopped before dispatch. No external booking or work order was cancelled.', 'neutral'],
}
const DELIVERY = {
  not_sent: ['Not sent', 'No email dispatch is recorded. This view cannot send it.'],
  accepted: ['Accepted by email provider', 'Delivery is not yet verified. Check the existing email; no new message is sent.'],
  delivered: ['Delivery verified', 'The provider reported delivery for the exact saved email. This does not prove that the recipient read it.'],
  unknown: ['Submission unconfirmed', 'An email may have been submitted, but its acknowledgement is missing. Do not send another copy.'],
  needs_review: ['Email needs review', 'Automatic checks are paused. Review the issue before choosing the next step.'],
}
const ERRORS = {
  provider_accepted: 'The email provider accepted this message. Delivery still needs verification.',
  email_delivery_unverified: 'The provider has not reported verified delivery yet.',
  email_readback_unavailable: 'The email provider could not return a usable delivery result.',
  email_acknowledgement_missing: 'The send acknowledgement is missing. Delivery cannot be verified automatically.',
  email_delivery_failed: 'The provider reported a failed or rejected delivery. Review the address and delivery issue; this control cannot resend.',
  email_provider_payload_mismatch: 'The provider email did not match the saved message. An administrator must investigate.',
  email_binding_unavailable: 'The reviewed email sender is unavailable for this property.',

  original_authorization_changed: 'The access that originally authorized this action has changed. An administrator must review its authority.',
  original_authorization_revoked: 'The access that originally authorized this action is no longer valid.',
  original_configuration_changed: 'The property configuration has changed since this action was prepared.',
  workflow_origin_revoked: 'The access that originally authorized this action is no longer valid.',
  workflow_configuration_changed: 'The property configuration has changed since this action was prepared.',
  property_configuration_changed: 'The property configuration has changed since this action was prepared.',
  workflow_attempts_exhausted: 'The permitted attempts have been used. Review the original request before proceeding.',
  verification_attempts_exhausted: 'The permitted verification attempts have been used. The provider result is still unconfirmed.',
  verification_unknown: 'The provider result could not be established. Check it before considering another attempt.',
  connector_unavailable: 'The required connection is not available.',
  provider_reference_conflict: 'The provider returned a different reference. Its result needs review.',
  verification_mismatch: 'The provider result did not match the requested action.',
}
const FILTER_STATES = { attention: ['needs_review'], active: ['queued', 'running', 'retry_wait', 'verifying'], complete: ['succeeded', 'cancelled'], all: Object.keys(STATES) }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const MACHINE = /^[a-z][a-z0-9_.:-]{0,127}$/
const REVISION = /^[a-f0-9]{64}$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
const count = value => Number.isSafeInteger(value) && value >= 0
const badResponse = () => Object.assign(new Error('The work queue returned an unreadable result. Reload before making changes.'), { badJson: true, status: 200 })

function readItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !ID.test(value.id)
    || typeof value.kind !== 'string' || typeof value.connector !== 'string' || !MACHINE.test(value.kind) || !MACHINE.test(value.connector)
    || !own(STATES, value.state) || !['dispatch', 'verify'].includes(value.phase)
    || ![value.createdAt, value.updatedAt, value.availableAt].every(instant)
    || !(value.completedAt === null || instant(value.completedAt))
    || !(value.lastErrorCode === null || typeof value.lastErrorCode === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value.lastErrorCode))
    || !count(value.dispatchAttempts) || !count(value.verificationAttempts) || !Number.isSafeInteger(value.maxAttempts)
    || value.maxAttempts < 1 || value.maxAttempts > 20 || typeof value.dispatchStarted !== 'boolean'
    || typeof value.canReplay !== 'boolean' || typeof value.canCancel !== 'boolean' || typeof value.revision !== 'string' || !REVISION.test(value.revision)) throw badResponse()
  if (typeof value.canVerifyEmail !== 'boolean' || !(value.emailDelivery === null || own(DELIVERY, value.emailDelivery))
    || value.emailDelivery !== null && (value.kind !== 'leasing_email' || value.connector !== 'resend_email_v1')
    || value.emailDelivery === 'delivered' && value.state !== 'succeeded'
    || value.emailDelivery === 'needs_review' && value.state !== 'needs_review'
    || value.canVerifyEmail && (value.emailDelivery === null || !value.dispatchStarted || value.phase !== 'verify' || !FILTER_STATES.active.includes(value.state))) throw badResponse()
  if (value.callback !== undefined && (!value.callback || value.kind !== 'website_callback' || value.connector !== 'vapi_callback_v1'
    || typeof value.callback.name !== 'string' || value.callback.name.length > 80
    || typeof value.callback.phone !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value.callback.phone)
    || typeof value.callback.canCheck !== 'boolean' || typeof value.callback.message !== 'string' || value.callback.message.length > 500
    || !instant(value.callback.observedAt) || !['saved','checking','requested','scheduled','queued','ringing','in-progress','forwarding','ended','needs_review','cancelled'].includes(value.callback.stage))) throw badResponse()
  // Keep only the operator projection, including the explicitly scoped callback contact.
  return Object.freeze(Object.fromEntries(['id', 'kind', 'connector', 'state', 'phase', 'createdAt', 'updatedAt', 'availableAt',
    'completedAt', 'lastErrorCode', 'dispatchAttempts', 'verificationAttempts', 'maxAttempts', 'dispatchStarted', 'revision', 'canReplay', 'canCancel', 'emailDelivery', 'canVerifyEmail', 'callback']
    .map(key => [key, value[key]])))
}
function readPage(body, filter) {
  if (!body || body.executionEnabled !== false || typeof body.canManage !== 'boolean' || !Array.isArray(body.actions) || body.actions.length > 25) throw badResponse()
  const actions = body.actions.map(readItem)
  if (new Set(actions.map(item => item.id)).size !== actions.length || actions.some(item => !FILTER_STATES[filter].includes(item.state))) throw badResponse()
  const cursor = body.nextCursor
  if (cursor !== null && (!cursor || !instant(cursor.createdAt) || !ID.test(cursor.id) || !actions.length
    || cursor.id !== actions.at(-1).id || cursor.createdAt !== actions.at(-1).createdAt)) throw badResponse()
  return { actions, canManage: body.canManage, nextCursor: cursor ? Object.freeze({ createdAt: cursor.createdAt, id: cursor.id }) : null }
}
function readReceipt(body, command, previous) {
  if (!body || body.executionEnabled !== false) throw badResponse()
  const item = readItem(body.action)
  if (item.id !== command.id || item.kind !== previous.kind || item.connector !== previous.connector || item.createdAt !== previous.createdAt
    || item.dispatchStarted !== previous.dispatchStarted || item.dispatchAttempts !== previous.dispatchAttempts
    || item.verificationAttempts !== previous.verificationAttempts
    || command.action === 'cancel' && (item.state !== 'cancelled' || item.canCancel || !item.completedAt)
    || command.action === 'replay' && (!['queued', 'verifying', 'needs_review'].includes(item.state)
      || item.state === 'queued' && item.dispatchStarted || item.state === 'verifying' && !item.dispatchStarted)) throw badResponse()
  return item
}
const human = value => A.text.capitalise(String(value).replace(/[_.:-]+/g, ' '))
const icon = name => `<span class="ico">${A.icon(name)}</span>`
const stateChip = item => A.html.chip(`chip-${STATES[item.state][2]}`, item.state === 'needs_review' ? 'warning' : item.state === 'succeeded' ? 'check' : 'clock', (item.callback ? ['Callback · ' + human(item.callback.stage)] : item.emailDelivery ? DELIVERY[item.emailDelivery] : STATES[item.state])[0])
function issueText(item) { return item.lastErrorCode ? ERRORS[item.lastErrorCode] || 'The last attempt needs attention. Share the issue code with your administrator if the next step is unclear.' : '' }
function nextStep(item) {
  if (item.state === 'cancelled') return 'None — this queued action is stopped'
  if (item.state === 'succeeded') return 'None — the action result is verified'
  if (item.state === 'needs_review') return 'Administrator review before further work'
  return item.phase === 'verify' ? 'Check the provider result' : 'Dispatch when authorized'
}

// Deliberately separate from the shared Calls/Leads/Calendar polling state.
let root = null, active = false, generation = 0, filter = 'attention', items = [], cursor = null, selected = null
let loaded = false, loading = false, error = '', checkedAt = null, canManage = false, actionBusy = false, panel = null
const uncertain = new Set()
const visible = () => Boolean(root && active && A.can('read') && A.route().name === 'workflows')
function bounded(promise) {
  let timer
  const wait = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The request is still unconfirmed.'), { status: 0, timeout: true })), 15000) })
  return Promise.race([promise, wait]).finally(() => clearTimeout(timer))
}
function replaceHtml(host, html) {
  if (!host || host.innerHTML === html) return
  const focused = host.contains(document.activeElement) ? document.activeElement?.dataset?.key : null
  const top = host.scrollTop, left = host.scrollLeft
  host.innerHTML = html
  host.scrollTop = top; host.scrollLeft = left
  if (focused) {
    const targets = [...host.querySelectorAll('[data-key]')]
    const target = targets.find(node => node.dataset.key === focused) || targets[0]
    if (target) target.focus({ preventScroll: true })
  }
}
function listHtml() {
  if (!loaded && loading) return '<div class="wq-empty"><h3>Loading the work queue…</h3><p>Waiting for this property’s saved actions.</p></div>'
  if (!loaded) return '<div class="wq-empty"><h3>Work queue not loaded</h3><p>Refresh to check this property’s saved actions.</p></div>'
  if (!items.length) return `<div class="wq-empty">${icon(filter === 'attention' ? 'check-circle' : 'clock')}<h3>${filter === 'attention' ? 'No actions need review in this result' : 'No actions in this view'}</h3><p>${filter === 'attention' ? 'Use In progress or All work to inspect other saved actions.' : 'Only actions saved to this property’s work queue appear here.'}</p></div>`
  return '<ul class="wq-list">' + items.map(item => `<li><button type="button" class="wq-row" data-select="${esc(item.id)}" data-key="work:${esc(item.id)}" aria-current="${item.id === selected ? 'true' : 'false'}" aria-controls="wq-detail">` +
    `<span class="wq-row-top"><strong>${esc(human(item.kind))}</strong>${stateChip(item)}</span><span class="wq-row-context">${esc(item.callback ? item.callback.name : item.emailDelivery ? 'Email' : human(item.connector))} · ${esc(A.fmt.dateTime(item.createdAt))}</span>` +
    `<span class="wq-row-note">${esc(item.callback ? item.callback.message.replace('your phone', 'the prospect’s phone') : item.lastErrorCode ? issueText(item) : STATES[item.state][1])}</span></button></li>`).join('') + '</ul>'
}
function detailHtml(item) {
  if (!item) return '<div class="wq-empty wq-detail-empty">' + icon('clock') + '<h2>Select an action</h2><p>See its last recorded result and the next safe step.</p></div>'
  const blocked = uncertain.has(item.id), mayManage = canManage && A.can('configure') && !blocked && !loading && !error
  const delivery = item.callback ? ['Callback · ' + human(item.callback.stage), item.callback.message.replace('your phone', 'the prospect’s phone')] : item.emailDelivery ? DELIVERY[item.emailDelivery] : STATES[item.state]
  const issue = item.lastErrorCode && !(item.emailDelivery && ['provider_accepted','email_delivery_unverified'].includes(item.lastErrorCode))
  const mayCheckCallback = item.callback?.canCheck && A.can('operate') && !blocked && !loading && !error
  const mayCheck = item.canVerifyEmail && A.can('operate') && !blocked && !loading && !error
  const replay = mayManage && item.canReplay, cancel = mayManage && item.canCancel && !item.dispatchStarted
  return `<div class="wq-detail-title">${stateChip(item)}<h2 tabindex="-1" data-key="work-detail-heading">${esc(human(item.kind))}</h2><p>${esc(item.callback ? 'Website-requested call' : item.emailDelivery ? 'Requested leasing email' : human(item.connector))}</p></div>` +
    `<section class="wq-next"><span class="page-eyebrow">LAST RECORDED RESULT</span><h3>${esc(delivery[0])}</h3><p>${esc(delivery[1])}</p>` +
    (issue ? `<div class="wq-issue"><strong>What needs attention</strong><p>${esc(issueText(item))}</p><details class="small"><summary>Technical details</summary><code>${esc(item.lastErrorCode)}</code></details></div>` : '') + '</section>' +
    (item.callback ? `<section class="wq-next"><h3>${esc(item.callback.name)}</h3><p>${esc(item.callback.phone)}</p><p class="small">One website-requested AI callback. Last provider observation: ${esc(A.fmt.dateTime(item.callback.observedAt))}. Call initiation does not confirm a tour or a conversation.</p></section>` : '') +
    `<dl class="wq-facts"><div><dt>Saved</dt><dd>${esc(A.fmt.dateTime(item.createdAt))}</dd></div><div><dt>Last changed</dt><dd>${esc(A.fmt.dateTime(item.updatedAt))}</dd></div>` +
    `<div><dt>Next step</dt><dd>${esc(item.callback ? 'Review the call status and conversation in Calls; do not redial this request.' : nextStep(item))}</dd></div>` +
    (item.callback ? `<div><dt>Call attempts</dt><dd>${item.dispatchAttempts} of 1 automatic attempt</dd></div><div><dt>Initiation checks</dt><dd>${item.verificationAttempts}</dd></div>` : item.emailDelivery ? `<div><dt>Delivery checks recorded</dt><dd>${item.verificationAttempts}</dd></div>`
      : `<div><dt>Attempts recorded</dt><dd>${item.dispatchAttempts} dispatch · ${item.verificationAttempts} verification</dd></div><div><dt>Dispatch limit</dt><dd>${item.maxAttempts} attempts</dd></div>`) +
    (['queued', 'retry_wait', 'verifying'].includes(item.state) ? `<div><dt>Eligible from</dt><dd>${esc(A.fmt.dateTime(item.availableAt))}</dd></div>` : '') + '</dl>' +
    `<p class="wq-timezone small">All times in ${esc(A.property.timeZoneLabel)}.</p>` +
    (blocked ? A.html.banner('warn', 'The last change is unconfirmed. Reload this page and check the saved state before trying another change.', { actionsHtml: '<button type="button" class="btn" data-command="reload" data-key="reload-after-change">Reload page</button>' }) : '') +
    (mayCheckCallback ? `<button type="button" class="btn btn-primary" data-command="check-callback" data-key="callback:${esc(item.id)}" data-permission="operate" ${actionBusy ? 'disabled' : ''}>${actionBusy ? 'Checking call…' : 'Check call status'}</button>` : '') +
    (mayCheck ? `<button type="button" class="btn btn-primary" data-command="verify-email" data-key="email:${esc(item.id)}" data-permission="operate" ${actionBusy ? 'disabled' : ''}>${actionBusy ? 'Checking delivery…' : 'Check email delivery'}</button>` : '') +
    (!canManage || !A.can('configure') ? '<p class="wq-access">An administrator can review recovery options. Recovery changes require administrator access.</p>' : '') +
    (replay || cancel ? `<section class="wq-recovery"><h3>Recovery options</h3><p>Changes affect this saved action only. They do not run the work or contact anyone.</p><div class="wq-actions">` +
      (replay ? `<button type="button" class="btn btn-primary" data-command="replay" data-key="replay:${esc(item.id)}" data-permission="configure" ${actionBusy ? 'disabled' : ''}>${item.dispatchStarted ? 'Requeue verification' : 'Requeue action'}</button>` : '') +
      (cancel ? `<button type="button" class="btn" data-command="cancel" data-key="cancel:${esc(item.id)}" data-permission="configure" ${actionBusy ? 'disabled' : ''}>Cancel queued action</button>` : '') + '</div></section>' : '') +
    (item.dispatchStarted && canManage ? '<p class="wq-access">Cancellation is unavailable because a dispatch may have reached the provider. Verify its result first.</p>' : '') +
    `<details class="wq-reference"><summary data-key="work-reference">Action reference</summary><code>${esc(item.id)}</code></details>`
}
function paint({ list = true } = {}) {
  if (!visible()) return
  for (const button of root.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter))
  const refresh = root.querySelector('[data-command="refresh"]')
  refresh.disabled = loading || actionBusy; refresh.textContent = loading ? 'Refreshing…' : 'Refresh queue'
  const message = loading ? (loaded ? 'Refreshing the saved queue…' : 'Loading the saved queue…')
    : checkedAt ? `${items.length} ${items.length === 1 ? 'action' : 'actions'} shown · checked ${A.fmt.time(checkedAt)} · refresh for current status` : 'No queue data received yet'
  root.querySelector('.wq-loaded').textContent = message
  replaceHtml(root.querySelector('.wq-errors'), error ? A.html.banner('warn', error) : '')
  const listEl = root.querySelector('.wq-results')
  listEl.setAttribute('aria-busy', String(loading))
  if (list) replaceHtml(listEl, listHtml())
  else for (const button of listEl.querySelectorAll('[data-select]')) button.setAttribute('aria-current', String(button.dataset.select === selected))
  replaceHtml(root.querySelector('.wq-detail'), detailHtml(items.find(item => item.id === selected)))
  const more = root.querySelector('[data-command="more"]')
  more.hidden = !cursor; more.disabled = loading || actionBusy; more.textContent = loading ? 'Loading…' : 'Load more actions'
  A.paintPermissions(root)
}
async function load(more = false) {
  if (!visible() || actionBusy || more && (!cursor || loading)) return
  const turn = ++generation, requestedFilter = filter, previousCursor = more ? cursor : null
  const focusMore = more && document.activeElement?.dataset?.key === 'work-more'
  loading = true; error = ''; paint({ list: !loaded })
  const params = new URLSearchParams({ state: requestedFilter, limit: '25' })
  if (previousCursor) { params.set('beforeCreatedAt', previousCursor.createdAt); params.set('beforeId', previousCursor.id) }
  try {
    const page = readPage(await bounded(A.api.get(`/api/workflows?${params}`)), requestedFilter)
    if (turn !== generation || !visible()) return
    if (previousCursor && page.nextCursor?.id === previousCursor.id && page.nextCursor.createdAt === previousCursor.createdAt) throw badResponse()
    const combined = more ? new Map(items.map(item => [item.id, item])) : new Map()
    for (const item of page.actions) combined.set(item.id, item)
    items = [...combined.values()]; cursor = page.nextCursor; canManage = page.canManage; loaded = true; checkedAt = new Date().toISOString()
    if (!items.some(item => item.id === selected)) selected = items[0]?.id || null
    A.announce(`${items.length} saved ${items.length === 1 ? 'action' : 'actions'} shown. ${FILTERS.find(([key]) => key === filter)[1]}.`)
  } catch (failure) {
    if (turn !== generation || !visible() || failure.signedOut || failure.propertyAccess) return
    error = failure.timeout ? 'The queue has not responded yet. The request may still be pending; try Refresh queue to check again.'
      : loaded ? 'The queue could not be refreshed. These are the last loaded actions; recovery controls are paused until a successful refresh.'
        : 'The work queue could not be loaded. No current queue status is available. Try Refresh queue.'
  } finally {
    if (turn === generation) {
      loading = false; paint()
      if (focusMore && visible() && !cursor) [...root.querySelector('.wq-results').querySelectorAll('[data-select]')].at(-1)?.focus({ preventScroll: true })
    }
  }
}
function select(id) {
  if (!visible() || !items.some(item => item.id === id) || actionBusy) return
  selected = id; paint({ list: false })
  if (matchMedia('(max-width: 760px)').matches) {
    const heading = root.querySelector('[data-key="work-detail-heading"]')
    heading?.focus({ preventScroll: true })
    heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
}
async function checkCallback() {
  const original = items.find(item => item.id === selected)
  if (!visible() || panel || loading || actionBusy || error || !original?.callback?.canCheck || !A.can('operate') || uncertain.has(original.id)) return
  const turn = generation
  actionBusy = true; paint({ list: false })
  try {
    const body = await bounded(A.api.post('/api/callbacks', { actionId: original.id, expectedRevision: original.revision }, { doing: 'Checking requested call' }))
    if (turn !== generation || !visible()) return
    const changed = readItem(body.action)
    if (changed.id !== original.id || changed.kind !== original.kind || changed.connector !== original.connector
      || changed.createdAt !== original.createdAt || changed.dispatchAttempts !== original.dispatchAttempts || !changed.callback) throw badResponse()
    items = items.map(item => item.id === changed.id ? changed : item).filter(item => FILTER_STATES[filter].includes(item.state))
    selected = items.some(item => item.id === selected) ? selected : items[0]?.id || null
    A.toast(changed.callback.message, { kind: 'info' }); A.announce(changed.callback.message)
  } catch (failure) {
    if (turn !== generation || !visible() || failure.signedOut || failure.propertyAccess) return
    error = 'The call check could not be confirmed. No new call was requested. Refresh the queue to see the saved result.'
  } finally { actionBusy = false; paint() }
}

async function verifyEmail() {
  const original = items.find(item => item.id === selected)
  if (!visible() || panel || loading || actionBusy || error || !original?.canVerifyEmail || !A.can('operate') || uncertain.has(original.id)) return
  const turn = generation
  actionBusy = true; paint({ list: false })
  try {
    const body = await bounded(A.api.post('/api/email-reconciliation', { actionId: original.id, expectedRevision: original.revision }, { doing: 'Checking email delivery' }))
    if (turn !== generation || !visible()) return
    if (body?.verificationOnly !== true) throw badResponse()
    const changed = readItem(body.action)
    if (changed.id !== original.id || changed.kind !== original.kind || changed.connector !== original.connector
      || changed.createdAt !== original.createdAt || changed.dispatchAttempts !== original.dispatchAttempts
      || changed.dispatchStarted !== original.dispatchStarted || changed.verificationAttempts < original.verificationAttempts) throw badResponse()
    items = items.map(item => item.id === changed.id ? changed : item)
    if (!FILTER_STATES[filter].includes(changed.state)) items = items.filter(item => item.id !== changed.id)
    selected = items.some(item => item.id === selected) ? selected : items[0]?.id || null
    A.toast(DELIVERY[changed.emailDelivery]?.[1] || 'Delivery is not yet verified.', { kind: changed.emailDelivery === 'delivered' ? 'success' : 'info' })
    A.announce(DELIVERY[changed.emailDelivery]?.[0] || 'Delivery check finished')
  } catch (failure) {
    if (turn !== generation || !visible() || failure.signedOut || failure.propertyAccess) return
    if ([400,403,404,409].includes(failure.status) && !failure.badJson) error = 'The delivery check was refused or this action changed. Refresh the queue to review its current state.'
    else { uncertain.add(original.id); error = 'The check could not be confirmed. No new email was requested. Reload the page to see the saved result.' }
  } finally { actionBusy = false; paint() }
}

function recover(kind) {
  const original = items.find(item => item.id === selected)
  if (!visible() || panel || loading || actionBusy || error || !original || !canManage || !A.can('configure') || uncertain.has(original.id)
    || kind === 'replay' && !original.canReplay || kind === 'cancel' && (!original.canCancel || original.dispatchStarted)) return
  const turn = generation, choices = kind === 'replay' ? [['reviewed_request', 'I reviewed the request'], ['provider_recovered', 'The provider connection has recovered']]
    : [['no_longer_needed', 'The queued action is no longer needed'], ['duplicate_request', 'This is a duplicate request']]
  let closed = false, uncertainResult = false
  const submitted = { action: kind, id: original.id, expectedRevision: original.revision, reason: choices[0][0] }
  panel = A.dialog({ title: kind === 'cancel' ? 'Cancel this queued action?' : original.dispatchStarted ? 'Requeue verification?' : 'Requeue this action?',
    build(body) {
      body.innerHTML = `<p class="prose">${kind === 'cancel' ? 'This stops the saved action before dispatch. It does not cancel a booking or work order in another system.' : original.dispatchStarted ? 'An earlier attempt may have reached the provider. Only verification will be requeued; the original action will not be blindly repeated.' : 'This prepares the saved action to be picked up again. It does not complete the work.'}</p>` +
        `<p class="wq-form-note">This control only changes the queue. Enabled delivery checks may later inspect an existing email; they cannot send another copy.</p>` +
        `<div class="field"><label class="field-label" for="wq-reason">Reason for this change</label><select class="input" id="wq-reason">${choices.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></div>`
    }, secondary: { label: 'Keep unchanged' },
    primary: { label: kind === 'cancel' ? 'Cancel queued action' : 'Requeue', danger: kind === 'cancel', async onClick(dialog) {
      if (closed || actionBusy || !visible() || turn !== generation || !A.can('configure')) return
      if (uncertainResult) { dialog.close(); return }
      const reason = dialog.body.querySelector('#wq-reason')
      if (!choices.some(([key]) => key === reason.value)) return
      submitted.reason = reason.value
      const command = Object.freeze({ ...submitted })
      actionBusy = true; reason.disabled = true; dialog.setError(null); paint({ list: false })
      try {
        const changed = readReceipt(await bounded(A.api.post('/api/workflows', command, { doing: kind === 'cancel' ? 'Cancelling a queued action' : 'Requeuing an action' })), command, original)
        if (closed || turn !== generation || !visible()) return
        items = items.map(item => item.id === changed.id ? changed : item)
        if (!FILTER_STATES[filter].includes(changed.state)) items = items.filter(item => item.id !== changed.id)
        selected = items.some(item => item.id === selected) ? selected : items[0]?.id || null
        dialog.close()
        A.toast(changed.state === 'needs_review' ? 'The action is still held for review. No work was performed.'
          : changed.state === 'cancelled' ? 'Cancelled in the queue. No external booking or work order was cancelled.'
            : changed.state === 'verifying' ? 'Verification requeued. The provider result is not yet confirmed.' : 'Action requeued. It has not been run or completed.', { kind: changed.state === 'needs_review' ? 'warn' : 'info' })
      } catch (failure) {
        if (closed || turn !== generation || !visible() || failure.signedOut || failure.propertyAccess) return
        const known = [400, 404, 409].includes(failure.status) && !failure.badJson
        uncertainResult = !known
        if (uncertainResult) {
          uncertain.add(original.id)
          dialog.setError('The change is unconfirmed. It may have been saved. Close this panel, then reload the page and check the action before making another change.')
        } else {
          error = failure.status === 409 ? 'This action changed or recovery was refused. Refresh the queue and review its latest state before trying again.'
            : 'The change was refused. Refresh the queue before reviewing another action.'
          dialog.setError(error)
        }
        dialog.setPrimary({ label: 'Close and review', disabled: false })
        // Replace only our callback's next behavior; no automatic repeat of a mutation.
        uncertainResult = true
      } finally {
        actionBusy = false
        if (!closed) { dialog.setBusy(null); dialog.setPrimary({ ...(uncertainResult ? { label: 'Close and review' } : {}), disabled: false }) }
        paint()
      }
    } },
    onClose() { closed = true; panel = null },
  })
}
function deactivate() {
  active = false; generation++; loading = false
  if (panel) panel.close()
}
const view = {
  title: 'Work queue', icon: 'clock',
  mount(el) {
    root = el; root.classList.add('wq-view')
    root.innerHTML = `<header class="page-hero wq-hero"><div><span class="page-eyebrow">OPERATIONS · ${esc(A.property.name)}</span><h1 tabindex="-1">Work queue</h1><p>See what is waiting, understand what needs attention, and choose the next safe step.</p></div><div class="page-hero-actions"><button type="button" class="btn" data-command="refresh" data-key="work-refresh">Refresh queue</button></div></header>` +
      `<div class="wq-runner">${icon('info')}<div><strong>Track work, email delivery and callbacks</strong><p>Check an existing email or requested call without contacting the prospect again. Refresh to see the latest saved result.</p></div></div>` +
      `<div class="wq-toolbar"><div class="wq-filters" role="group" aria-label="Filter work queue">${FILTERS.map(([key, label]) => `<button type="button" class="btn" data-filter="${key}" data-key="work-filter:${key}" aria-pressed="false">${label}</button>`).join('')}</div><p class="wq-loaded" role="status"></p></div>` +
      '<div class="wq-errors"></div><div class="wq-workspace"><section class="wq-browser" aria-label="Saved actions"><div class="wq-results" aria-busy="false"></div><div class="wq-pagination"><button type="button" class="btn" data-command="more" data-key="work-more" hidden>Load more actions</button></div></section><section class="wq-detail" id="wq-detail" aria-label="Selected action"></section></div>'
    root.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button || !root.contains(button) || button.disabled) return
      if (button.dataset.filter && FILTER_STATES[button.dataset.filter]) {
        if (!actionBusy) A.navigate('workflows', { state: button.dataset.filter })
      } else if (button.dataset.select) select(button.dataset.select)
      else if (button.dataset.command === 'refresh') load()
      else if (button.dataset.command === 'more') load(true)
      else if (button.dataset.command === 'reload') location.reload()
      else if (button.dataset.command === 'check-callback') checkCallback()
      else if (button.dataset.command === 'verify-email') verifyEmail()
      else if (['replay', 'cancel'].includes(button.dataset.command)) recover(button.dataset.command)
    })
    A.on('route', route => { if (route.name !== 'workflows') deactivate() })
  },
  render() {
    if (!A.can('read') || !A.databaseMode || A.route().name !== 'workflows') return
    const requested = A.route().params.state, next = FILTERS.some(([key]) => key === requested) ? requested : 'attention'
    if (next !== filter) { filter = next; items = []; cursor = null; selected = null; loaded = false; checkedAt = null; error = ''; if (panel) panel.close(); active = false }
    const entered = !active; active = true
    paint()
    if (entered) load()
  },
}
A.register('workflows', view)
})()
