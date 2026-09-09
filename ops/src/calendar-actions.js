/* Property-scoped unit blackout and manual tour-change controls. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, arr = value => Array.isArray(value) ? value : []
const current = () => A.state.calendar || {}
const units = () => arr(current().units)
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && A.fmt.addDays(value, 0) === value
const unitId = unit => String(unit.id || unit.unitId || '')
const unitLabel = unit => unit.label || `Apartment ${unitId(unit)}`
const options = selected => units().map(unit => `<option value="${esc(unitId(unit))}"${unitId(unit) === selected ? ' selected' : ''}>${esc(unitLabel(unit))}</option>`).join('')
const requestId = () => window.crypto.randomUUID()
const uncertain = error => error.network || error.badJson || !error.status || error.status >= 500 || (error.status >= 200 && error.status < 300)
const unverified = message => Object.assign(new Error(message), { badJson: true })
function verifiedCalendar(result) {
  if (!result || !['slots', 'blocks', 'bookings', 'unitBlocks'].every(key => Array.isArray(result[key]))) throw unverified('The saved calendar could not be verified.')
}
const lockForm = (form, locked) => { for (const control of form.querySelectorAll('input, select, textarea')) control.disabled = locked }
let active = null
function allowed() {
  if (!A.can('operate')) { A.toast('Your access is view only.', { kind: 'info' }); return false }
  if (!A.state.calendar || A.busyNow('calendar')) { A.toast('Wait for the calendar to finish loading.', { kind: 'info' }); return false }
  return true
}
async function reload() {
  const calendar = await A.api.get(A.calendarUrl())
  A.apply('calendar', calendar)
  return calendar
}
function closeActive() { if (active) active.close(); active = null }
A.on('route', () => closeActive())
function field(label, name, type, value, extra = '') {
  return `<label class="field"><span class="field-label">${esc(label)}</span><input class="input" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`
}
function unitConflicts(block) {
  if (Array.isArray(block.conflictingBookingIds)) {
    const ids = new Set(block.conflictingBookingIds)
    return arr(current().bookings).filter(booking => ids.has(booking.externalId))
  }
  const start = Date.parse(block.startsAt), end = Date.parse(block.endsAt)
  return arr(current().bookings).filter(booking => String(booking.unitId || '').toUpperCase() === String(block.unitId).toUpperCase()
    && Date.parse(booking.occupiedStartsAt || booking.startsAt) < end && Date.parse(booking.occupiedEndsAt || booking.endsAt) > start)
}
function unitBlocksHtml(selected) {
  const blocks = arr(current().unitBlocks).filter(block => !block.removedAt && (!selected || block.unitId === selected) && Date.parse(block.endsAt) > Date.now())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  if (!blocks.length) return '<p class="muted-line">No upcoming unit blocks.</p>'
  return blocks.map(block => {
    const conflicts = unitConflicts(block)
    return `<article class="cal-unit-block"><div><strong>Apartment ${esc(block.unitId)}</strong><p>${esc(A.fmt.dateTime(block.startsAt))} – ${esc(A.fmt.dateTime(block.endsAt))}</p><p>${esc(block.reason || 'Unavailable for tours')}</p>${conflicts.length ? `<p class="cal-unit-conflict" role="status">${conflicts.length} existing tour${conflicts.length === 1 ? ' needs' : 's need'} attention, including time reserved before or after tours. Reschedule from the calendar.</p>` : ''}</div><button type="button" class="btn btn-quiet" data-unit-reopen="${esc(block.id)}" data-write="calendar">Reopen unit</button></article>`
  }).join('')
}
function openUnitBlocks(preset = {}) {
  if (!allowed()) return
  if (!units().length) { A.toast('No property units are available to select. Refresh the property inventory first.', { kind: 'warn' }); return }
  closeActive()
  const today = A.fmt.nyNow().ymd
  const selected = units().some(unit => unitId(unit) === preset.unitId) ? preset.unitId : unitId(units()[0])
  const date = dateValid(preset.date) && preset.date >= today ? preset.date : today
  let fields, draftId = requestId(), previousPayload = '', alive = true, uncertainWrite = false, pendingWrite = null
  active = A.dialog({ title: 'Unit availability', secondary: { label: 'Close' },
    build(body, dialog) {
      body.innerHTML = `<p class="cal-action-intro">Block an apartment for painting, renovation, a move-out, or another reason. Other apartments remain available. Existing tours stay on the calendar.</p><form class="cal-action-form">` +
        `<label class="field"><span class="field-label">Apartment</span><select class="select" name="unitId">${options(selected)}</select></label>` +
        `<label class="cal-action-check"><input type="checkbox" name="allDay" checked> All day</label><div class="cal-action-pair">${field('First day', 'date', 'date', date, `min="${today}" max="9998-12-31"`)}${field('Last day', 'endDate', 'date', date, `min="${today}" max="9998-12-31"`)}</div>` +
        `<div class="cal-action-pair" data-times hidden>${field('Start time', 'startTime', 'time', '09:00')}${field('End time', 'endTime', 'time', '17:00')}</div>` +
        `<label class="field"><span class="field-label">Reason</span><input class="input" name="reason" maxlength="120" placeholder="e.g. Painting, renovation, move-out" required></label><p class="field-hint">Times use ${esc(A.property.timeZoneLabel)}. The last day is included for all-day blocks.</p></form><section class="cal-unit-blocks"><h4>Upcoming blocks</h4><div data-block-list>${unitBlocksHtml(selected)}</div></section>`
      fields = Object.fromEntries([...body.querySelectorAll('[name]')].map(element => [element.name, element]))
      const list = body.querySelector('[data-block-list]')
      fields.allDay.addEventListener('change', () => { body.querySelector('[data-times]').hidden = fields.allDay.checked })
      fields.unitId.addEventListener('change', () => { list.innerHTML = unitBlocksHtml(fields.unitId.value); dialog.setError(null) })
      fields.date.addEventListener('change', () => { if (fields.endDate.value < fields.date.value) fields.endDate.value = fields.date.value })
      body.querySelector('form').addEventListener('submit', event => { event.preventDefault(); dialog.el.querySelector('.dlg-primary').click() })
      list.addEventListener('click', async event => {
        const button = event.target.closest('[data-unit-reopen]')
        if (!button || dialog.isBusy() || !A.can('operate')) return
        const block = arr(current().unitBlocks).find(value => value.id === button.dataset.unitReopen)
        if (!block) { dialog.setError('This block changed. Refresh and try again.'); return }
        dialog.setBusy('Reopening…'); dialog.setError(null)
        try {
          const result = await A.busy('calendar', A.api.post('/api/calendar', { action: 'unit_unblock', blockId: block.id, revision: block.revision }, { doing: 'reopening a unit' }))
          A.apply('calendar', result)
          if (alive) list.innerHTML = unitBlocksHtml(fields.unitId.value)
          A.toast(`Apartment ${block.unitId} reopened for tours.`, { kind: 'ok' })
        } catch (error) { if (alive && !error.signedOut) dialog.setError(error.message); reload().catch(() => {}) }
        finally { if (alive) dialog.setBusy(null) }
      })
    },
    primary: { label: 'Block unit', busyLabel: 'Saving unit block…', async onClick(dialog) {
      if (!A.can('operate')) throw new Error('Your access is view only.')
      const form = dialog.body.querySelector('form')
      if (!uncertainWrite && !form.reportValidity()) return
      if (!pendingWrite) {
        const payload = { action: 'unit_block', unitId: fields.unitId.value, date: fields.date.value, endDate: fields.endDate.value,
          allDay: fields.allDay.checked, reason: fields.reason.value.trim(), ...(!fields.allDay.checked ? { startTime: fields.startTime.value, endTime: fields.endTime.value } : {}) }
        if (!dateValid(payload.date) || !dateValid(payload.endDate) || payload.endDate < payload.date) throw new Error('Choose a valid start and end date.')
        if (!payload.reason) throw new Error('Enter a reason for this unit block.')
        const fingerprint = JSON.stringify(payload)
        if (previousPayload && previousPayload !== fingerprint) draftId = requestId()
        previousPayload = fingerprint
        pendingWrite = Object.freeze({ ...payload, requestId: draftId })
      }
      const payload = pendingWrite
      lockForm(form, true)
      try {
        const result = await A.busy('calendar', A.api.post('/api/calendar', payload, { doing: 'blocking a unit' }))
        verifiedCalendar(result)
        const saved = result.unitBlocks.find(block => block.requestId === payload.requestId)
        if (saved && (saved.unitId !== payload.unitId || saved.date !== payload.date || saved.endDate !== payload.endDate
          || saved.allDay !== payload.allDay || saved.reason !== payload.reason)) throw unverified('The saved unit block does not match this request.')
        A.apply('calendar', result)
        if (!alive) return
        if (!saved || saved.removedAt) {
          dialog.close()
          A.toast('No active block for this request is shown. Review the current availability before adding a different block.', { kind: 'info' })
          return
        }
        const conflicts = arr(result.unitBlocks).filter(block => !block.removedAt && block.unitId === payload.unitId).flatMap(unitConflicts)
        dialog.close()
        A.toast(`Apartment ${payload.unitId} blocked.${conflicts.length ? ' Existing tours need staff attention.' : ''}`, { kind: conflicts.length ? 'warn' : 'ok' })
      } catch (error) {
        uncertainWrite = uncertainWrite || uncertain(error)
        reload().catch(() => {})
        if (uncertainWrite) throw new Error('The result could not be verified. Retry this same block, or close and refresh the calendar before making a different change.')
        throw error
      } finally { if (alive && !uncertainWrite) { pendingWrite = null; lockForm(form, false) } }
    } },
    onClose() { alive = false; active = null },
  })
}

function openReschedule(booking) {
  if (!allowed()) return
  if (!booking || !booking.externalId) { A.toast('Refresh the calendar to load this booking.', { kind: 'info' }); return }
  closeActive()
  const original = structuredClone(booking), today = A.fmt.nyNow().ymd
  const oldDate = A.fmt.nyParts(booking.startsAt)?.ymd
  let fields, alive = true, epoch = 0, slots = [], dialog, draftId = requestId(), previousPayload = '', uncertainWrite = false, pendingWrite = null, pendingSlot = null
  const initialUnit = original.unitId || ''
  async function loadSlots() {
    if (!dialog || !alive || pendingWrite) return
    const version = ++epoch
    slots = []
    fields.slotId.innerHTML = '<option value="">Checking availability…</option>'
    dialog.setPrimary({ disabled: true }); dialog.setError(null)
    const date = fields.date.value
    if (!dateValid(date)) { fields.slotId.innerHTML = '<option value="">Choose a valid date</option>'; return }
    const query = new URLSearchParams({ from: date, to: date, rescheduleBookingId: original.externalId })
    if (fields.unitId.value) query.set('unitId', fields.unitId.value)
    try {
      const result = await A.api.get(`/api/calendar?${query}`)
      if (!alive || version !== epoch) return
      const preview = result.reschedule
      if (!preview || !Array.isArray(preview.slots)) throw new Error('The server did not return verified rescheduling options.')
      const revision = preview.booking?.revision ?? preview.revision
      if (revision !== undefined && revision !== (original.revision ?? 0)) throw new Error('This tour changed in another session. Close this window and reopen the tour.')
      slots = preview.slots
      fields.slotId.innerHTML = '<option value="">Choose a tour time</option>' + slots.map(slot => `<option value="${esc(slot.slotId)}">${esc(A.fmt.timeRange(slot.startsAt, slot.endsAt))}</option>`).join('')
      if (!slots.length) { fields.slotId.innerHTML = '<option value="">No available tours on this date</option>'; dialog.setError('Try another day or apartment. The original tour is unchanged.') }
      dialog.setPrimary({ disabled: !slots.length })
    } catch (error) {
      if (!alive || version !== epoch || error.signedOut) return
      fields.slotId.innerHTML = '<option value="">Availability could not be checked</option>'
      dialog.setError(error.message)
    }
  }
  active = A.dialog({ title: `Reschedule ${original.prospectName || 'tour'}`, secondary: { label: 'Keep original tour' },
    build(body, api) {
      dialog = api
      const unknownUnit = initialUnit && !units().some(unit => unitId(unit) === initialUnit)
      body.innerHTML = `<p class="cal-action-intro">Current tour: ${esc(A.fmt.dateTime(original.startsAt))}${initialUnit ? ` · Apartment ${esc(initialUnit)}` : ''}. The original appointment stays until the new time is saved.</p><form class="cal-action-form">` +
        `<label class="field"><span class="field-label">Apartment</span><select class="select" name="unitId">${!initialUnit ? '<option value="">No apartment selected</option>' : ''}${unknownUnit ? `<option value="${esc(initialUnit)}" selected>Apartment ${esc(initialUnit)} — no longer in inventory</option>` : ''}${options(initialUnit)}</select></label>` +
        field('New date', 'date', 'date', oldDate && oldDate >= today ? oldDate : today, `min="${today}" max="9998-12-31"`) +
        `<label class="field"><span class="field-label">New tour time</span><select class="select" name="slotId" required><option value="">Checking availability…</option></select></label><p class="field-hint">${esc(A.property.timeZoneLabel)} · availability includes staffing capacity, unit blocks, tour hours and notice.</p><p class="cal-consequence">Contact the prospect with the new time. This action does not send a text or email.</p></form>`
      fields = Object.fromEntries([...body.querySelectorAll('[name]')].map(element => [element.name, element]))
      fields.date.addEventListener('input', loadSlots)
      fields.date.addEventListener('change', loadSlots)
      fields.unitId.addEventListener('change', loadSlots)
      body.querySelector('form').addEventListener('submit', event => { event.preventDefault(); api.el.querySelector('.dlg-primary').click() })
      Promise.resolve().then(loadSlots)
    },
    primary: { label: 'Save new time', disabled: true, busyLabel: 'Moving tour…', async onClick(api) {
      if (!A.can('operate')) throw new Error('Your access is view only.')
      const form = api.body.querySelector('form')
      if (!uncertainWrite && !form.reportValidity()) return
      if (!pendingWrite) {
        const slot = slots.find(value => value.slotId === fields.slotId.value)
        if (!slot) throw new Error('Check availability and choose a tour time.')
        const payload = { action: 'reschedule', externalId: original.externalId, expectedRevision: original.revision ?? 0,
          slotId: slot.slotId, unitId: fields.unitId.value || null }
        const fingerprint = JSON.stringify(payload)
        if (previousPayload && fingerprint !== previousPayload) draftId = requestId()
        previousPayload = fingerprint
        pendingWrite = Object.freeze({ ...payload, requestId: draftId })
        pendingSlot = Object.freeze({ ...slot })
      }
      const payload = pendingWrite, slot = pendingSlot
      lockForm(form, true)
      try {
        const result = await A.busy('calendar', A.api.post('/api/calendar', payload, { doing: 'rescheduling a tour' }))
        verifiedCalendar(result)
        const receipt = result.reschedule
        const saved = result.bookings.find(row => row.externalId === payload.externalId)
        if (!receipt || receipt.externalId !== payload.externalId || receipt.requestId !== payload.requestId
          || receipt.revision !== payload.expectedRevision + 1 || receipt.notificationSent !== false
          || !['complete', 'pending_projection', 'superseded'].includes(receipt.status) || !saved
          || (receipt.status === 'superseded' ? !(saved.revision > receipt.revision)
            : saved.revision !== receipt.revision || saved.slotId !== payload.slotId || saved.unitId !== payload.unitId
              || Date.parse(saved.startsAt) !== Date.parse(slot.startsAt) || Date.parse(saved.endsAt) !== Date.parse(slot.endsAt))) {
          throw unverified('The saved tour change does not match this request.')
        }
        A.apply('calendar', result)
        A.refresh()
        api.close()
        if (receipt.status === 'superseded') {
          A.toast('This request was already applied, and the tour has since changed again. The calendar shows its current time.', { kind: 'info', ms: 10000 })
          return
        }
        const pending = receipt.status === 'pending_projection'
          || arr(result.rescheduleProjectionPending).some(item => item.externalId === original.externalId)
        A.toast(`Tour moved to ${A.fmt.dateTime(slot.startsAt)}.${pending ? ' Follow-up records still need to sync.' : ''} Contact the prospect to confirm the change.`, { kind: pending ? 'warn' : 'ok', ms: 10000 })
      } catch (error) {
        uncertainWrite = uncertainWrite || uncertain(error)
        reload().catch(() => {})
        // Never tell staff the original is unchanged after an ambiguous network failure.
        if (uncertainWrite) throw new Error('The result could not be fully verified. Retry this same selection, or close and refresh the calendar before making another change.')
        throw error
      } finally { if (alive && !uncertainWrite) { pendingWrite = null; pendingSlot = null; lockForm(form, false) } }
    } },
    onClose() { alive = false; epoch++; active = null },
  })
}
async function retryProjection(externalId) {
  if (!allowed()) return
  const pending = arr(current().rescheduleProjectionPending).find(item => item.externalId === externalId)
  if (!pending) { A.toast('This tour has no pending follow-up sync. Refresh the calendar if it just changed.', { kind: 'info' }); return }
  try {
    const result = await A.busy('calendar', A.api.post('/api/calendar', { action: 'reschedule_sync',
      externalId, revision: pending.revision, requestId: pending.requestId }, { doing: 'syncing tour follow-ups' }))
    A.apply('calendar', result)
    A.refresh()
    const remains = arr(result.rescheduleProjectionPending).some(item => item.externalId === externalId)
    A.toast(remains ? 'The tour is saved. Follow-ups still need staff review before they can sync.' : 'Tour follow-ups are up to date.', { kind: remains ? 'warn' : 'ok' })
  } catch (error) { if (!error.signedOut) A.toast(error.message, { kind: 'error' }); reload().catch(() => {}) }
}
A.calendarActions = { openUnitBlocks, openReschedule, retryProjection }
})()
