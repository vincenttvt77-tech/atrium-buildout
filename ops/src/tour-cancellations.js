/* Staff cancellation of one exact reservation. No message delivery is implied. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, endpoint = '/api/tour-cancellations'
let active = null
A.on('route', () => { if (active) active.close() })
const invalid = () => new Error('The reservation response could not be verified. Reload before making a change.')
function read(value, id) {
  if (!value || value.externalId !== id || !['active','cancelled'].includes(value.status)
    || !value.booking || value.booking.externalId !== id || typeof value.booking.prospectName !== 'string'
    || typeof value.canCancel !== 'boolean' || value.notification !== 'not_sent'
    || (value.status === 'active' ? !/^[a-f0-9]{64}$/.test(value.expectedSha256) || value.cancellation !== null
      : value.canCancel || !value.cancellation || value.cancellation.booking?.externalId !== id
        || value.cancellation.notification !== 'not_sent' || typeof value.cancellation.reason !== 'string'
        || !Number.isFinite(Date.parse(value.cancellation.at)))) throw invalid()
  return value
}
function bounded(promise) {
  let timer
  return Promise.race([promise, new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('The lookup or cancellation has not responded yet.')), 15000) })]).finally(() => clearTimeout(timer))
}
function open(externalId) {
  if (!A.databaseMode || !A.can('operate') || typeof externalId !== 'string') return
  if (active) active.close()
  let closed = false, saving = false, data = null, pending = null, reload = false, projection = null
  const alive = () => !closed && A.can('operate')
  function show(dialog) {
    if (!data) return
    const b = data.booking, c = data.cancellation, cancelled = data.status === 'cancelled'
    dialog.body.innerHTML = `<div class="tour-cancel-form"><div class="tour-cancel-summary"><span class="section-kicker">${cancelled ? 'Cancelled reservation' : 'Review this reservation'}</span>` +
      `<h3>${esc(b.prospectName || 'Tour guest')}</h3><p>${esc(A.fmt.dateTime(b.startsAt))} · ${b.unitId ? 'Apartment ' + esc(b.unitId) : 'Building tour'}</p>` +
      `<p>${esc(b.prospectPhone || 'No phone recorded')}${b.prospectEmail ? ' · ' + esc(b.prospectEmail) : ''}</p></div>` +
      (cancelled ? `<p class="notice" role="status">Tour cancelled. Its capacity is available again. No cancellation message was sent.</p>` +
        `<dl><dt>Reason</dt><dd>${esc(c.reason)}</dd><dt>Cancelled</dt><dd>${esc(A.fmt.dateTime(c.at))}</dd><dt>Staff account</dt><dd>${esc(c.actorId)}</dd></dl>` +
        (projection ? `<p>${projection.retired} scheduled tour follow-up${projection.retired === 1 ? '' : 's'} retired.${projection.review ? ' Older ambiguous tasks need staff review.' : ''}${projection.status === 'awaiting_call' ? ' The original call can still finish saving; it cannot restore this tour.' : ''}</p>` : '')
        : `<p>Cancelling frees this reservation’s capacity and retains its history. It also retires matching tour follow-ups.</p>` +
          (data.reason ? `<p class="notice">${esc(data.reason)}</p>` : '') +
          `<div class="field"><label class="field-label" for="tour-cancel-reason">Cancellation reason</label><textarea class="input" id="tour-cancel-reason" rows="3" minlength="3" maxlength="500" placeholder="For example, the prospect can no longer attend">${esc(pending?.reason || '')}</textarea></div>` +
          `<label class="tour-cancel-check"><input type="checkbox" id="tour-cancel-verified"${pending ? ' checked' : ''}>I verified this is the reservation to cancel.</label>`) +
      `<p class="small">Contact the prospect separately. An earlier confirmation may already have been sent or be in flight; cancellation cannot recall it.</p>` +
      `<button class="btn" type="button" data-cancel-work>Review work queue</button></div>`
    dialog.body.querySelector('[data-cancel-work]').addEventListener('click', () => { if (!saving && !pending) { dialog.close(); A.navigate('workflows') } })
    const fields = [...dialog.body.querySelectorAll('input,textarea')]
    fields.forEach(f => { f.disabled = !data.canCancel || !!pending || reload })
    const sync = () => dialog.setPrimary({ label: cancelled ? 'Cancellation saved' : pending ? 'Check saved cancellation' : reload ? 'Reload reservation' : 'Cancel tour',
      disabled: cancelled || !pending && !reload && (!data.canCancel || dialog.body.querySelector('#tour-cancel-reason').value.trim().length < 3 || !dialog.body.querySelector('#tour-cancel-verified').checked) })
    fields.forEach(f => f.addEventListener('input', sync)); sync()
  }
  async function load(dialog) {
    dialog.setBusy('Loading reservation…'); dialog.setError(null)
    try {
      const next = read((await bounded(A.api.get(`${endpoint}?externalId=${encodeURIComponent(externalId)}`)))?.current, externalId)
      if (!alive()) return
      data = next; pending = null; reload = false; show(dialog)
    } catch (error) { if (alive()) { reload = true; dialog.setError(error.message); dialog.setPrimary({ label: 'Reload reservation', disabled: false }) } }
    finally { if (!closed) dialog.setBusy(null) }
  }
  active = A.dialog({ title: 'Cancel tour', secondary: { label: 'Close' },
    build(body, dialog) { body.innerHTML = '<p role="status">Loading this reservation…</p>'; void load(dialog) },
    primary: { label: 'Loading…', disabled: true, async onClick(dialog) {
      if (!alive() || saving) return
      if (!pending && (reload || !data)) { await load(dialog); return }
      if (!pending) {
        const reason = dialog.body.querySelector('#tour-cancel-reason'), verified = dialog.body.querySelector('#tour-cancel-verified')
        if (!data.canCancel || !reason || reason.value.trim().length < 3 || !verified?.checked) return
        pending = Object.freeze({ action: 'cancel', externalId, expectedSha256: data.expectedSha256,
          requestId: crypto.randomUUID(), reason: reason.value.trim(), verified: true })
      }
      saving = true; dialog.setBusy('Cancelling tour…'); dialog.setError(null)
      dialog.body.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true })
      try {
        const command = pending, result = await bounded(A.api.post(endpoint, command))
        if (!alive()) return
        const next = read(result?.current, externalId)
        if (typeof result.replayed !== 'boolean' || next.status !== 'cancelled' || next.cancellation.requestId !== command.requestId
          || next.cancellation.reason !== command.reason || !result.projection
          || !['complete','awaiting_call','needs_review'].includes(result.projection.status)
          || !Number.isSafeInteger(result.projection.retired) || !Number.isSafeInteger(result.projection.review)) throw invalid()
        data = next; projection = result.projection; pending = null; reload = false; show(dialog)
        A.announce('Tour cancelled. No cancellation message was sent.'); void A.refresh()
      } catch (error) {
        if (!alive()) return
        if ([400,403,404,409].includes(error.status) && !error.badJson) { pending = null; reload = true }
        show(dialog)
        dialog.setError((error.message || 'Cancellation is unconfirmed.') + (pending ? ' It may already be saved. Check the same cancellation to verify.' : ' Reload the reservation before trying again.'))
      } finally { saving = false; if (!closed) dialog.setBusy(null) }
    } }, onClose() { closed = true; active = null },
  })
}
function history() {
  if (!A.databaseMode || !A.can('operate')) return
  if (active) active.close()
  const rows = Array.isArray(A.state.calendar?.cancelledBookings) ? A.state.calendar.cancelledBookings : []
  active = A.dialog({ title: 'Recent cancellations', secondary: { label: 'Close' }, build(body, dialog) {
    body.innerHTML = `<div class="tour-cancel-form"><p>Up to 100 recent cancellations from the loaded calendar. Open one to verify its current saved history.</p>` +
      (rows.length ? `<ol class="tour-cancel-list">${rows.map((c,i) => `<li><button type="button" class="btn" data-cancel-history="${i}">${esc(c.booking.prospectName)} · ${esc(A.fmt.dateTime(c.booking.startsAt))}</button><p>${esc(c.reason)}</p></li>`).join('')}</ol>` : '<p>No cancellations in the loaded calendar.</p>') + '</div>'
    body.querySelectorAll('[data-cancel-history]').forEach(button => button.addEventListener('click', () => { const id = rows[Number(button.dataset.cancelHistory)]?.booking.externalId; dialog.close(); if (id) open(id) }))
  }, onClose() { active = null } })
}
A.tourCancellations = { open, history }
})()
