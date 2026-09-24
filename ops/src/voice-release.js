/* Reviewed property voice releases. Recovery reads a saved result; it never repeats a provider write. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, endpoint = '/api/vapi-sync'
let active = null
A.on('route', () => active?.close())
const states = { prepared: 'Ready for review', sending: 'Update unconfirmed', verified: 'Saved configuration verified', cancelled: 'Review cancelled' }
function checked(value, id) {
  const r = value?.release
  if (!r || r.id !== id || !Object.hasOwn(states,r.state) || typeof r.current !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(r.reviewHash) || !Number.isFinite(Date.parse(r.preparedAt))
    || !Number.isFinite(Date.parse(r.expiresAt)) || !Number.isSafeInteger(r.configurationVersion)
    || r.state === 'verified' && (r.check !== 'matches' || !Number.isFinite(Date.parse(r.checkedAt)))
    || value.proposal !== null && (!value.proposal || typeof value.proposal.firstMessage !== 'string'
      || !Array.isArray(value.proposal.prompt) || !Array.isArray(value.proposal.tools)
      || value.proposal.prompt.some(m=>typeof m?.content!=='string')
      || value.proposal.tools.some(t=>typeof t?.function?.name!=='string')
      || typeof value.proposal.serverUrl !== 'string')) throw new Error('The release response could not be verified. Check its saved result.')
  return value
}
function bounded(promise) {
  let timer
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The request has not responded yet.')),15000)})]).finally(()=>clearTimeout(timer))
}
function open() {
  if (!A.databaseMode || !A.can('configure')) return
  active?.close()
  let closed=false,busy=false,data=null,rows=[],pending=null,reload=false
  const alive=()=>!closed&&A.can('configure')
  function render(dialog) {
    const r=data?.release,p=data?.proposal,unconfirmed=r?.state==='sending'
    dialog.body.innerHTML='<div class="voice-release"><p>Review the selected property’s leasing script and tools before applying them. Your selected voice, speech recognition and model settings are kept.</p>'+
      (r?`<div class="voice-release-summary"><strong>${esc(states[r.state])}</strong><p>Property configuration ${esc(r.configurationVersion)} · prepared ${esc(A.fmt.dateTime(r.preparedAt))}</p>`+
        (r.checkedAt?`<p>Last check: ${esc(A.fmt.dateTime(r.checkedAt))} · ${esc(r.check==='matches'?'saved fields matched':r.check==='differs'?'saved fields differ':'provider unavailable')}</p>`:'')+'</div>'+
        (unconfirmed?'<p class="notice" role="status">The update may have reached the phone provider. Check the saved result; do not submit another update. A different saved configuration needs administrator review.</p>':
          r.state==='verified'?'<p class="notice" role="status">The reviewed settings matched the saved assistant at the last check. Test a phone call before relying on this release in a demonstration.</p>':
            !r.current?'<p class="notice">This review belongs to earlier property or application settings. Prepare a fresh review.</p>':'')+
        (p?`<details><summary>Opening message and leasing script</summary><p>${esc(p.firstMessage)}</p><pre>${esc(p.prompt.map(m=>m.content).join('\n\n'))}</pre></details>`+
          `<details><summary>${p.tools.length} leasing tools and connection</summary><ul>${p.tools.map(t=>`<li>${esc(t.function.name)}</li>`).join('')}</ul><p>${esc(p.serverUrl)}</p><pre>${esc(JSON.stringify({tools:p.tools,startSpeakingPlan:p.startSpeakingPlan,stopSpeakingPlan:p.stopSpeakingPlan},null,2))}</pre></details>`:'')+
        (r.state==='prepared'&&r.current?`<label class="voice-release-check"><input type="checkbox" data-reviewed>I reviewed this property’s script, tools and connection. Apply this release to its live assistant.</label><p class="small">Review expires ${esc(A.fmt.dateTime(r.expiresAt))}. Avoid editing this assistant in Vapi while applying the release.</p><button type="button" class="btn" data-cancel-review>Cancel this review</button>`:''):'')+
      '<details class="voice-release-history"><summary>Release history</summary>'+(rows.length?`<ol>${rows.map((item,i)=>`<li><button type="button" class="btn" data-release="${i}">${esc(states[item.state])} · ${esc(A.fmt.dateTime(item.preparedAt))}</button></li>`).join('')}</ol>`:'<p>No saved releases for this assistant.</p>')+'</details>'+
      (r&&!unconfirmed?'<button type="button" class="btn" data-new-review>Prepare another review</button>':'')+'</div>'
    const sync=()=>dialog.setPrimary({label:pending?'Check saved result':reload?'Reload releases':!r?'Prepare review':unconfirmed?'Check provider result':r.state==='prepared'?'Publish reviewed release':'Release recorded',
      disabled:busy||!pending&&!reload&&!!r&&!unconfirmed&&(r.state!=='prepared'||!r.current||Date.parse(r.expiresAt)<=Date.now()||!dialog.body.querySelector('[data-reviewed]')?.checked)})
    dialog.body.querySelector('[data-reviewed]')?.addEventListener('change',sync)
    dialog.body.querySelectorAll('[data-release]').forEach(button=>button.addEventListener('click',()=>{if(!busy&&!pending)void run(dialog,()=>A.api.get(endpoint+'?id='+encodeURIComponent(rows[Number(button.dataset.release)].id)),rows[Number(button.dataset.release)].id)}))
    dialog.body.querySelector('[data-cancel-review]')?.addEventListener('click',()=>{if(!busy&&!pending)void send(dialog,{action:'cancel',id:r.id,reviewHash:r.reviewHash})})
    dialog.body.querySelector('[data-new-review]')?.addEventListener('click',()=>{if(!busy&&!pending){data=null;render(dialog)}})
    dialog.body.querySelectorAll('button,input').forEach(el=>{el.disabled=busy||!!pending})
    sync()
  }
  async function run(dialog,operation,id=null) {
    if(!alive()||busy)return
    busy=true;dialog.setBusy('Checking assistant release…');dialog.setError(null)
    dialog.body.querySelectorAll('button,input').forEach(el=>{el.disabled=true})
    try {
      const result=await bounded(operation())
      if(!alive())return
      if(id){
        data=checked(result,id);rows=[data.release,...rows.filter(r=>r.id!==id)]
        if(!pending||!['publish','cancel'].includes(pending.action)||data.release.state!=='prepared')pending=null
      }
      else {
        if(!Array.isArray(result?.releases)||result.releases.some(r=>!r||typeof r.id!=='string'||!Object.hasOwn(states,r.state)||!Number.isFinite(Date.parse(r.preparedAt))))throw new Error('Release history could not be verified.')
        rows=result.releases
        const unsettled=rows.find(r=>r.state==='sending')
        if(unsettled){
          const detail=await bounded(A.api.get(endpoint+'?id='+encodeURIComponent(unsettled.id)))
          if(!alive())return
          data=checked(detail,unsettled.id)
        }
      }
      reload=false
    } catch(error) {
      if(!alive())return
      if(['voice_release_changed','voice_backend_contract_mismatch','voice_release_command'].includes(error.body?.code))pending=null
      reload=!pending
      dialog.setError((error.message||'The result could not be verified.')+(pending?' The action may already be saved. Check the same release before continuing.':''))
    } finally {busy=false;if(alive()){render(dialog);dialog.setBusy(null)}}
  }
  async function send(dialog,command) {
    if(!alive()||busy)return
    pending=Object.freeze(command)
    await run(dialog,()=>A.api.post(endpoint,command),command.id||command.requestId)
  }
  active=A.dialog({title:'Property phone assistant',secondary:{label:'Close'},
    build(body,dialog){body.innerHTML='<p role="status">Loading saved releases…</p>';void run(dialog,()=>A.api.get(endpoint))},
    primary:{label:'Loading…',disabled:true,async onClick(dialog){
      if(!alive()||busy)return
      if(pending){const id=pending.id||pending.requestId;await run(dialog,()=>A.api.get(endpoint+'?id='+encodeURIComponent(id)),id);return}
      if(reload){await run(dialog,()=>A.api.get(endpoint));return}
      const r=data?.release
      if(!r){await send(dialog,{action:'prepare',requestId:crypto.randomUUID()});return}
      if(r.state==='sending'){await send(dialog,{action:'verify',id:r.id});return}
      if(r.state==='prepared'&&r.current&&Date.parse(r.expiresAt)>Date.now()&&dialog.body.querySelector('[data-reviewed]')?.checked)
        await send(dialog,{action:'publish',id:r.id,reviewHash:r.reviewHash})
    }},onClose(){closed=true;active=null},
  })
}
A.voiceRelease={open}
})()
