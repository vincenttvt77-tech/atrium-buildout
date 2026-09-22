/* Staff permission and delivery for the exact saved tour; never a fabricated send. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, endpoint = '/api/tour-confirmations'
const validConfirmation = (row, id) => row && row.id === id && typeof row.message === 'string'
  && typeof row.canProcess === 'boolean' && ['queued','running','retry_wait','verifying','succeeded','needs_review','cancelled'].includes(row.state)
  && ['delivered','not_verified'].includes(row.delivery) && (row.delivery !== 'delivered' || row.state === 'succeeded')
let active = null
A.on('route', () => { if (active) active.close() })
function open(externalId) {
  if (!A.databaseMode || !A.can('operate') || typeof externalId !== 'string') return
  if (active) active.close()
  let closed = false, data = null, reloadRequired = false
  const show = dialog => {
    const row = data.confirmation
    const canSend = data.ready === true && A.can('operate')
    dialog.body.innerHTML = `<div class="tour-email-recipient"><span class="field-label">To</span><strong>${esc(data.preview.recipient)}</strong></div>` +
      `<h4 class="tour-email-subject">${esc(data.preview.subject)}</h4><pre class="tour-email-preview">${esc(data.preview.body)}</pre>` +
      (row ? `<p class="notice" role="status">${esc(row.message)}</p>` : canSend
        ? '<label class="tour-email-permission"><input type="checkbox" name="emailPermission"><span>The prospect agreed to receive this tour confirmation at the email address above.</span></label>' : '') +
      (!canSend ? `<p class="notice" role="status">${esc(data.reason || 'Email sending is unavailable for this property.')}</p>` : '')
    const check = dialog.body.querySelector('[name="emailPermission"]')
    const sync = () => dialog.setPrimary({ label: row ? row.state === 'queued' ? 'Send saved confirmation' : 'Check delivery' : 'Save permission and send',
      disabled: !canSend || (row ? !row.canProcess : !check?.checked) })
    check?.addEventListener('change', sync)
    sync()
  }
  const load = async dialog => {
    dialog.setBusy('Loading confirmation…'); dialog.setError(null)
    try {
      const next = await A.api.get(`${endpoint}?externalId=${encodeURIComponent(externalId)}`)
      if (closed) return
      if (!next?.preview || !/^[a-f0-9]{64}$/.test(next.preview.bookingSha256) || next.preview.externalId !== externalId || typeof next.preview.body !== 'string'
        || typeof next.preview.recipient !== 'string' || typeof next.ready !== 'boolean'
        || (next.confirmation !== null && !validConfirmation(next.confirmation, next.preview.bookingSha256))) throw new Error('The confirmation could not be verified. Reload before continuing.')
      data = next; reloadRequired = false; show(dialog)
    } catch (error) {
      if (!closed) { reloadRequired = true; dialog.setError(error.message || 'Unable to load the saved tour.'); dialog.setPrimary({ label: 'Reload confirmation', disabled: false }) }
    } finally { if (!closed) dialog.setBusy(null) }
  }
  active = A.dialog({ title: 'Tour confirmation', secondary: { label: 'Close' },
    build(body, dialog) { body.innerHTML = '<p role="status">Loading the saved reservation…</p>'; void load(dialog) },
    primary: { label: 'Loading…', disabled: true, async onClick(dialog) {
      if (reloadRequired || !data) { await load(dialog); return }
      if (data.ready !== true || !A.can('operate')) return
      const existing = data.confirmation
      if (!existing && !dialog.body.querySelector('[name="emailPermission"]')?.checked) return
      if (existing && !existing.canProcess) return
      dialog.setBusy(existing ? 'Checking confirmation…' : 'Saving permission…'); dialog.setError(null)
      try {
        if (!data.confirmation) {
          const saved = await A.api.post(endpoint, { action: 'queue', externalId, bookingSha256: data.preview.bookingSha256, permissionConfirmed: true })
          if (closed) return
          if (!validConfirmation(saved?.confirmation, data.preview.bookingSha256)) throw new Error('The saved confirmation could not be verified. Reload to check it before retrying.')
          data.confirmation = saved.confirmation
        }
        dialog.setBusy('Checking delivery…')
        const result = await A.api.post(endpoint, { action: 'process', confirmationId: data.confirmation.id })
        if (closed) return
        if (!validConfirmation(result?.confirmation, data.confirmation.id)) throw new Error('The delivery result could not be verified. Reload to check it.')
        data.confirmation = result.confirmation; show(dialog)
      } catch (error) {
        if (!closed) {
          reloadRequired = true
          dialog.setError((error.message || 'The result is uncertain.') + ' Reload to check the saved confirmation before trying again.')
          dialog.setPrimary({ label: 'Reload confirmation', disabled: false })
        }
      } finally { if (!closed) dialog.setBusy(null) }
    } },
    onClose() { closed = true; active = null },
  })
}
A.tourConfirmations = { open }
})()
