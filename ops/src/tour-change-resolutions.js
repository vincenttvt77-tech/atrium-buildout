/* Staff outcomes describe saved evidence; this form never moves or cancels a tour. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, endpoint = '/api/tour-change-resolutions'
let active = null
A.on('route', () => active?.close())
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function bounded(promise) {
  let timer
  return Promise.race([promise, new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('The outcome request has not responded yet.')),15000) })]).finally(() => clearTimeout(timer))
}
function open(id) {
  if (!A.databaseMode || !A.can('operate') || typeof id !== 'string') return
  if (active) active.close()
  let closed = false, data = null, pending = null, reload = false, saving = false
  const alive = () => !closed && A.can('operate')
  function show(dialog) {
    const request = data.request, history = request.resolutions || []
    dialog.body.innerHTML = `<p>Review the latest caller instructions and record what staff handled. This form does not change a tour or send a message.</p>` +
      `<p><strong>${esc(request.name || 'Caller details not provided')}</strong></p>` +
      (request.excerpts || []).map(words => `<blockquote>${esc(words)}</blockquote>`).join('') +
      (request.status === 'resolved' ? `<p class="notice" role="status">This request already has a recorded outcome: ${esc(history.at(-1)?.note || '')}</p>` :
        `<div class="field"><label class="field-label" for="tour-outcome-search">Find a saved change by name or apartment</label><input class="input" id="tour-outcome-search" maxlength="120"><button class="btn" type="button" data-search-outcomes>Find changes</button></div>` +
        `<div class="field"><label class="field-label" for="tour-outcome">What happened?</label><select class="input" id="tour-outcome"><option value="">Choose an outcome</option><option value="no_change">Close without a tour change</option>` +
        data.candidates.map((row,i) => `<option value="${i}">${row.outcome === 'cancelled' ? 'Cancelled' : 'Rescheduled'} · ${esc(row.name || 'Tour guest')} · ${esc(row.source.unitId || 'Building tour')} · ${esc(A.fmt.dateTime(row.source.startsAt))}</option>`).join('') + `</select></div>` +
        `<p class="small">Only currently verified saved changes made after the latest caller details appear.${data.more ? ' More than 100 match; narrow the search to find the intended change.' : ''} Use the calendar first if the tour still needs changing.</p>` +
        `<p class="notice" data-outcome-detail hidden></p>` +
        `<div class="field"><label class="field-label" for="tour-outcome-note">What did you verify or decide?</label><textarea class="input" id="tour-outcome-note" rows="3" minlength="3" maxlength="1000" placeholder="Record why this outcome addresses the caller’s latest request"></textarea></div>` +
        `<label class="tour-cancel-check"><input type="checkbox" id="tour-outcome-verified">I reviewed the latest request. For a saved tour change, I verified the caller and the correct reservation.</label>`) +
      `<p class="small">A reviewed request stays open until an outcome is recorded. New caller details can reopen it. Contact and email delivery are tracked separately.</p>`
    const choose = dialog.body.querySelector('#tour-outcome'), note = dialog.body.querySelector('#tour-outcome-note'), checked = dialog.body.querySelector('#tour-outcome-verified')
    const sync = () => {
      const selected = choose?.value, row = selected !== '' && selected !== 'no_change' ? data.candidates[Number(selected)] : null
      const detail = dialog.body.querySelector('[data-outcome-detail]')
      if (detail) { detail.hidden = !selected; detail.textContent = selected === 'no_change'
        ? 'This closes the request with your reason. It does not claim a tour changed or the caller was contacted.'
        : row ? `${row.outcome === 'cancelled' ? 'Cancellation' : 'Reschedule'} saved ${A.fmt.dateTime(row.source.at)}. ${row.name || 'Tour guest'} · ${row.source.unitId || 'Building tour'} · ${A.fmt.dateTime(row.source.startsAt)}. Confirm this is the intended reservation.` : '' }
      dialog.setPrimary({ label: request.status === 'resolved' ? 'Outcome recorded' : 'Record outcome',
        disabled: !data.canResolve || !selected || note.value.trim().length < 3 || !checked.checked })
    }
    choose?.addEventListener('change',sync); note?.addEventListener('input',sync); checked?.addEventListener('change',sync)
    dialog.body.querySelector('[data-search-outcomes]')?.addEventListener('click',() => {
      if (!pending && !saving) void load(dialog,dialog.body.querySelector('#tour-outcome-search').value)
    })
    sync()
  }
  async function load(dialog,search='') {
    dialog.setBusy('Loading saved changes…');dialog.setError(null)
    try {
      const next = await bounded(A.api.get(`${endpoint}?${new URLSearchParams({id,search})}`))
      if (!alive()) return
      if (!next || next.request?.id !== id || !Number.isSafeInteger(next.request.revision) || !['pending','reviewed','resolved'].includes(next.request.status)
        || !Array.isArray(next.request.excerpts) || !digest(next.expectedSha256) || typeof next.canResolve !== 'boolean' || typeof next.more !== 'boolean'
        || next.request.status === 'resolved' && next.canResolve
        || !Array.isArray(next.candidates) || next.candidates.length > 100 || next.candidates.some(row => !['cancelled','rescheduled'].includes(row?.outcome)
          || typeof row.name !== 'string' || !digest(row.source?.sha256) || !Number.isFinite(Date.parse(row.source?.startsAt)) || !Number.isFinite(Date.parse(row.source?.at)))) {
        throw new Error('The saved request or calendar changes could not be verified.')
      }
      data = next; pending = null; reload = false; show(dialog)
      const field = dialog.body.querySelector('#tour-outcome-search'); if (field) field.value = search
    } catch (error) {
      if (alive()) { reload = true; dialog.setError(error.message); dialog.setPrimary({label:'Reload request',disabled:false}) }
    } finally { if (!closed) dialog.setBusy(null) }
  }
  active = A.dialog({ title:'Record tour-change outcome', secondary:{label:'Close'},
    build(body,dialog) { body.innerHTML='<p role="status">Loading the latest caller request…</p>';void load(dialog) },
    primary:{label:'Loading…',disabled:true,async onClick(dialog) {
      if (!alive() || saving) return
      if (reload || !data) { await load(dialog); return }
      if (!pending) {
        const selected=dialog.body.querySelector('#tour-outcome')?.value, note=dialog.body.querySelector('#tour-outcome-note')?.value.trim()
        if (!data.canResolve || !selected || !note || note.length<3 || !dialog.body.querySelector('#tour-outcome-verified')?.checked) return
        const candidate=selected==='no_change'?null:data.candidates[Number(selected)]
        if (selected!=='no_change'&&!candidate) return
        pending=Object.freeze({action:'resolve',id,expectedRevision:data.request.revision,expectedSha256:data.expectedSha256,
          requestId:crypto.randomUUID(),outcome:candidate?.outcome||'no_change',sourceSha256:candidate?.source.sha256||null,note,verified:true})
      }
      saving=true;dialog.setBusy('Saving outcome…');dialog.setError(null)
      dialog.body.querySelectorAll('input,textarea,select,button').forEach(el=>{el.disabled=true})
      try {
        const command=pending,result=await bounded(A.api.post(endpoint,command))
        if (!alive()) return
        if (typeof result?.replayed!=='boolean'||result.request?.id!==id||!Number.isSafeInteger(result.request.revision)
          ||result.request.revision<command.expectedRevision+1||result.resolution?.requestId!==command.requestId
          ||result.resolution.requestRevision!==command.expectedRevision||result.resolution.outcome!==command.outcome
          ||(result.resolution.source?.sha256??null)!==command.sourceSha256||result.resolution.note!==command.note
          ||!['pending','reviewed','resolved'].includes(result.request.status)) throw new Error('The saved outcome could not be verified.')
        A.apply('leads',{scope:result.scope,tourChangeRequest:result.request})
        pending=null;data=null
        dialog.body.innerHTML=`<p class="notice" role="status">Outcome recorded. ${result.request.status==='resolved'?'This request is closed.':'Newer caller details still need follow-up.'} No booking was changed and no message was sent by this action.</p>`
        dialog.setPrimary({label:'Outcome recorded',disabled:true});void A.refresh()
      } catch (error) {
        if (!alive()) return
        if ([400,404,409].includes(error.status)&&!error.badJson) { pending=null;reload=true }
        dialog.setError((error.message||'The result is uncertain.')+(pending?' It may already be saved. Check the same outcome before trying something else.':' Reload and review the latest request.'))
        dialog.setPrimary({label:pending?'Check saved outcome':'Reload request',disabled:false})
      } finally {saving=false;if(!closed)dialog.setBusy(null)}
    }},onClose(){closed=true;active=null},
  })
}
A.tourChangeResolutions={open}
})()
