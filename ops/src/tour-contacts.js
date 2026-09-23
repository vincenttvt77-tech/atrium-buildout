/* Staff-reviewed contact belongs to one reservation, with durable command recovery. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, endpoint = '/api/tour-contacts', digest = /^[a-f0-9]{64}$/
const contact = v => v && typeof v.name === 'string' && v.name.length <= 200 && (v.email === null || typeof v.email === 'string' && v.email.length <= 254)
const change = v => v && typeof v.requestId === 'string' && typeof v.actorId === 'string' && typeof v.reason === 'string'
  && Number.isSafeInteger(v.revision) && v.revision > 0 && v.revision <= 1000 && Number.isFinite(Date.parse(v.at)) && contact(v.previous) && contact(v.next)
const invalid = () => new Error('The saved tour contact could not be verified. Reload before editing.')
function read(value, id) {
  if (!contact(value) || value.externalId !== id || !digest.test(value.expectedSha256) || typeof value.canEdit !== 'boolean'
    || typeof value.reviewedByStaff !== 'boolean' || !Number.isSafeInteger(value.contactRevision) || value.contactRevision < 0
    || value.historyCount !== value.contactRevision || value.reviewedByStaff !== (value.contactRevision > 0)
    || !(value.reason === null || typeof value.reason === 'string') || !Array.isArray(value.history) || value.history.length > 20
    || value.history.some((c,i) => !change(c) || c.revision > value.contactRevision || i > 0 && c.revision !== value.history[i-1].revision - 1)
    || !(value.nextBeforeRevision === null || value.history.length && value.nextBeforeRevision === value.history.at(-1).revision)) throw invalid()
  return value
}
function bounded(promise) {
  let timer
  return Promise.race([promise, new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('The save or lookup has not responded yet.')), 15000) })]).finally(() => clearTimeout(timer))
}
let active = null
A.on('route', () => { if (active) active.close() })
function open(externalId) {
  if (!A.databaseMode || !A.can('operate') || typeof externalId !== 'string') return
  if (active) active.close()
  let closed = false, data = null, pending = null, reload = false, note = '', saving = false
  const alive = () => !closed && A.can('operate')
  function show(dialog, focus = false) {
    if (!data) return
    dialog.body.innerHTML = `<div class="tour-contact-form"><p>This contact is for the saved tour. Saving sends no email and grants no permission to send one.</p>` +
      (note ? `<p class="notice" role="status">${esc(note)}</p>` : '') +
      (data.reason ? `<p class="notice">${esc(data.reason)}</p>` : '') +
      `<div class="field"><label class="field-label" for="tour-contact-name">Tour contact name</label><input class="input" id="tour-contact-name" autocomplete="off" maxlength="200" value="${esc(pending ? pending.name : data.name)}"></div>` +
      `<div class="field"><label class="field-label" for="tour-contact-email">Tour email</label><input class="input" id="tour-contact-email" type="email" autocomplete="off" maxlength="254" value="${esc((pending ? pending.email : data.email) || '')}"><p class="small">Leave blank to clear an incorrect address.</p></div>` +
      `<div class="field"><label class="field-label" for="tour-contact-reason">Reason for correction</label><textarea class="input" id="tour-contact-reason" rows="2" minlength="3" maxlength="500" placeholder="For example, the prospect corrected their email">${esc(pending?.reason || '')}</textarea></div>` +
      `<p class="small">${data.reviewedByStaff ? 'Staff-reviewed contact. The AI cannot overwrite it.' : 'A staff correction protects these contact details from later AI updates.'} Original caller and call records are retained.</p>` +
      `<button type="button" class="btn" data-contact-confirmation>Review tour confirmation</button>` +
      `<section class="tour-contact-history" aria-label="Contact change history"><h3>Contact history${data.historyCount ? ' · ' + data.historyCount : ''}</h3>` +
      (data.history.length ? '<ol>' + data.history.map(c => `<li><strong>Change ${c.revision} · ${esc(A.fmt.dateTime(c.at))}</strong><p>${esc(c.reason)}</p><p>${esc(c.previous.name)} · ${esc(c.previous.email || 'No email')}<br>Changed to ${esc(c.next.name)} · ${esc(c.next.email || 'No email')}</p></li>`).join('') + '</ol>' : '<p>No staff contact changes recorded.</p>') +
      (data.nextBeforeRevision !== null ? '<button type="button" class="btn" data-contact-history>Load earlier changes</button>' : '') + '</section></div>'
    const fields = [...dialog.body.querySelectorAll('input,textarea')]
    const sync = () => {
      const [name, email, reason] = fields
      dialog.setPrimary({ label: pending ? 'Check saved change' : reload ? 'Reload tour contact' : 'Save tour contact',
        disabled: !pending && !reload && (!data.canEdit || !name.value.trim() || !email.checkValidity() || reason.value.trim().length < 3
          || name.value.trim() === data.name && (email.value.trim() || null) === data.email) })
    }
    fields.forEach(field => { field.disabled = !data.canEdit || !!pending || reload; field.addEventListener('input', sync) })
    dialog.body.querySelector('[data-contact-confirmation]').addEventListener('click', () => { dialog.close(); A.tourConfirmations.open(externalId) })
    const more = dialog.body.querySelector('[data-contact-history]')
    more?.addEventListener('click', async () => {
      if (saving || pending || reload) return
      more.disabled = true
      const expected = data.expectedSha256, cursor = data.nextBeforeRevision
      try {
        const next = read((await bounded(A.api.get(`${endpoint}?externalId=${encodeURIComponent(externalId)}&beforeRevision=${cursor}`)))?.current, externalId)
        if (!alive()) return
        if (next.expectedSha256 !== expected || next.history.some(c => c.revision >= cursor)) throw invalid()
        // Add history only; never replace or lose the operator's unsaved form values.
        const values = fields.map(field => field.value)
        data = { ...next, history: [...data.history, ...next.history] }; show(dialog)
        dialog.body.querySelectorAll('input,textarea').forEach((field,i) => { field.value = values[i]; field.dispatchEvent(new Event('input')) })
        dialog.body.querySelector('[data-contact-history]')?.focus()
      } catch (error) { if (alive()) { reload = true; dialog.setError(error.message); show(dialog) } }
    })
    sync()
    if (focus) fields[0].focus()
  }
  async function load(dialog) {
    dialog.setBusy('Loading tour contact…'); dialog.setError(null)
    try {
      const next = read((await bounded(A.api.get(`${endpoint}?externalId=${encodeURIComponent(externalId)}`)))?.current, externalId)
      if (!alive()) return
      data = next; reload = false; pending = null; note = ''; show(dialog, true)
    } catch (error) {
      if (alive()) { reload = true; dialog.setError(error.message); dialog.setPrimary({ label: 'Reload tour contact', disabled: false }) }
    } finally { if (!closed) dialog.setBusy(null) }
  }
  active = A.dialog({ title: 'Edit tour contact', secondary: { label: 'Close' },
    build(body, dialog) { body.innerHTML = '<p role="status">Loading this reservation’s contact…</p>'; void load(dialog) },
    primary: { label: 'Loading…', disabled: true, async onClick(dialog) {
      if (!alive() || saving) return
      if (!pending && (reload || !data)) { await load(dialog); return }
      if (!pending) {
        const name = dialog.body.querySelector('#tour-contact-name'), email = dialog.body.querySelector('#tour-contact-email'), reason = dialog.body.querySelector('#tour-contact-reason')
        if (!data.canEdit || !name.value.trim() || !email.checkValidity() || reason.value.trim().length < 3) return
        pending = Object.freeze({ action: 'save', externalId, expectedSha256: data.expectedSha256, requestId: crypto.randomUUID(),
          name: name.value.trim(), email: email.value.trim() || null, reason: reason.value.trim() })
      }
      saving = true; dialog.setBusy('Saving tour contact…'); dialog.setError(null)
      dialog.body.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true })
      try {
        const command = pending, result = await bounded(A.api.post(endpoint, command))
        if (!alive()) return
        if (!result || typeof result.replayed !== 'boolean' || !change(result.change) || result.change.requestId !== command.requestId
          || result.change.next.name !== command.name || result.change.next.email !== command.email || result.change.reason !== command.reason) throw invalid()
        if (result.current === null) {
          pending = null; data = null; reload = true
          dialog.body.innerHTML = '<p role="status">The contact change was saved, but this tour is no longer on the calendar. Its earlier change history is retained.</p>'
          dialog.setPrimary({ label: 'Tour no longer available', disabled: true }); void A.refresh(); return
        }
        data = read(result.current, externalId); pending = null; reload = false
        note = data.contactRevision === result.change.revision ? 'Tour contact saved. No message was sent.' : 'Your change was saved. Another staff change followed; the current contact is shown below.'
        show(dialog); A.announce(note); void A.refresh()
      } catch (error) {
        if (!alive()) return
        if ([400,403,404,409].includes(error.status) && !error.badJson) { pending = null; reload = true }
        // An uncertain response retries exactly the same command, never a new edit.
        show(dialog)
        dialog.setError((error.message || 'The change is unconfirmed.') + (pending ? ' It may already be saved. Use Check saved change to verify the same correction.' : ' Reload the current tour before editing.'))
      } finally { saving = false; if (!closed) dialog.setBusy(null) }
    } }, onClose() { closed = true; active = null },
  })
}
A.tourContacts = { open }
})()
