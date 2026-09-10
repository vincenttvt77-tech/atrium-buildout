/*
 * Calls view (brief §8). Owner: shell. Registers 'calls' on window.Atrium and renders into the
 * root the shell hands it: search + filter chips, the list grouped by New York day, and the
 * detail panel (split ≥ 1200 px, a full page with "‹ Calls" below). The story, steps, facts and
 * chips come from Atrium.derive.callStory; nothing here calls fetch.
 */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml
const { fmt, derive, text, href } = A
const ico = (n) => `<span class="ico">${A.icon(n)}</span>`
const cssq = (s) => (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, (c) => '\\' + c)
const FILTERS = [['all', 'All'], ['person', 'Needs a person'], ['booked', 'Tour booked'], ['priced', 'Priced out'], ['emergency', 'Emergency']]
const isSplit = () => matchMedia('(min-width: 1200px)').matches
const isDesktop = () => matchMedia('(min-width: 960px)').matches
/* A shorter placeholder on a phone so it is not cut off at 390 px. */
const searchPlaceholder = () => (isDesktop() ? 'Search calls by name, number or apartment' : 'Search name, number or apartment')
const hasChip = (story, name) => story.chips.some((c) => c.text === name)
const passes = (filter, story) => filter === 'person' ? story.needsPerson : filter === 'booked' ? hasChip(story, 'Tour booked') : filter === 'priced' ? hasChip(story, 'Priced out') : filter === 'emergency' ? story.emergency : true

function callWork(rec, s) {
  const followUps = ((s.leads && s.leads.followUps) || []).filter(f => f && f.createdFromCall === rec.id && f.status === 'scheduled')
  const requests = ((s.leads && s.leads.tourChangeRequests) || []).filter(r => r && r.callId === rec.id && r.status === 'pending')
  return { followUps, requests, count: followUps.length + requests.length }
}
function callOverviewHtml(s, records, stories) {
  const known = s.loaded.calls || s.loaded.leads
  const stale = s.errors.calls || s.errors.leads || s.callsError || s.safetyEventsError
  const booked = records.filter(r => hasChip(stories.get(r.id), 'Tour booked')).length
  const review = records.filter(r => {
    const story = stories.get(r.id)
    return story.emergency || story.needsPerson || callWork(r, s).count > 0
  }).length
  const metrics = [['Saved call records', records.length, stale ? 'Saved snapshot · refresh needed' : 'Recent history + retained lead records'],
    ['Tour-booking outcomes', booked, 'Calls with a recorded booking outcome'],
    ['Calls to review', review, 'Open staff work or a flagged outcome']]
  return `<div class="page-metrics" aria-label="Loaded call history">${metrics.map(([label, value, detail]) => `<div><span class="metric-label">${esc(label)}</span><strong class="metric-value num">${known ? value : '—'}</strong><span class="metric-detail">${known ? esc(detail) : 'Waiting for call records'}</span></div>`).join('')}</div>`
}
function callContextHtml(rec, story, s) {
  const work = callWork(rec, s)
  const leadLink = rec.profile ? `<a class="btn btn-quiet" href="${esc(A.hashFor('leads', { phone: rec.profile.phone, tab: work.count ? 'todo' : 'all' }))}">View prospect ${ico('chevron-right')}</a>` : ''
  const queueLink = work.count ? `<a class="btn" href="${esc(A.hashFor('leads', { tab: 'todo', ...(rec.profile ? { phone: rec.profile.phone } : {}) }))}">Review staff work ${ico('chevron-right')}</a>` : ''
  const title = work.requests.length ? 'Tour change awaiting staff review' : work.followUps.length ? `${text.plural(work.followUps.length, 'follow-up')} to complete` : story.emergency ? 'Safety report needs review' : story.needsPerson ? 'A staff decision is needed' : rec.profile ? 'Conversation saved to this prospect' : 'Call record available'
  const detail = work.requests.length ? 'The request is saved. This does not confirm a changed tour or a notification to staff.' : work.followUps.length ? 'Open the work queue for the saved task, contact details, and due time.' : rec.profile ? 'Review requirements, tours, and conversation history together.' : 'A linked prospect profile is not available in the loaded records.'
  return `<section class="call-context${work.count || story.needsPerson || story.emergency ? ' call-context-attention' : ''}"><span class="section-kicker">Next step</span><h3>${esc(title)}</h3><p>${esc(detail)}</p>${work.requests.map(r => `<p class="call-request-quote">“${esc(text.truncate((r.excerpts || []).slice(-1)[0] || 'Tour-change request', 220))}”</p>`).join('')}<div class="panel-actions">${queueLink}${leadLink}</div></section>`
}

function matches(rec, story, q) {
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  if (digits.length >= 2 && String(rec.phone || '').replace(/\D/g, '').includes(digits)) return true
  const f = story.findings
  const hay = [rec.displayName, rec.name, rec.profile && rec.profile.email, story.sentence, story.wants, rec.call && rec.call.transcript,
    ...(rec.profile ? rec.profile.unitsDiscussed || [] : []), ...f.units, ...f.stretch, ...f.later, story.booked && story.booked.unitId,
    ...story.facts.map((x) => `${x.value || ''} ${x.excerpt || ''}`), ...story.steps.map((x) => x.text)]
    .filter(Boolean).join('\n').toLowerCase()
  return hay.includes(q.toLowerCase())
}
function dayLabel(ymd, today) {
  if (!ymd) return 'Earlier'
  if (ymd === today) return 'Today'
  if (ymd === fmt.addDays(today, -1)) return 'Yesterday'
  return fmt.day(ymd)
}
function rowHtml(rec, story, open, tab, isNew) {
  const iconName = story.emergency ? 'siren' : story.needsPerson ? 'hand' : 'phone'
  const cls = story.emergency ? 'row-siren' : story.needsPerson ? 'row-hand' : ''
  const dur = rec.durationSeconds != null ? fmt.duration(rec.durationSeconds) : '—'
  const phone = rec.name ? fmt.phone(rec.phone) : ''
  const time = rec.startedAt ? fmt.time(rec.startedAt) : ''
  const whenDesk = [time, dur !== '—' ? dur : ''].filter(Boolean).join(' · ')
  const whenMobile = [rec.startedAt ? fmt.dateTime(rec.startedAt, { inSentence: true }) : '', dur !== '—' ? dur : ''].filter(Boolean).join(' · ')
  return `<button type="button" class="row row-click call-row ${cls}${isNew ? ' row-new' : ''}" data-key="row:${esc(rec.id)}" data-id="${esc(rec.id)}" aria-current="${open ? 'true' : 'false'}" tabindex="${tab ? '0' : '-1'}">` +
    `<span class="row-lead"><span class="row-lead-icon">${ico(iconName)}</span></span>` +
    `<span class="row-body"><span class="row-title"><span class="who">${esc(rec.displayName)}</span>${phone ? `<span class="phone">· ${esc(phone)}</span>` : ''}` +
    `<span class="when when-desk num">${esc(whenDesk)}</span><span class="when when-mobile num">${esc(whenMobile)}</span></span>` +
    `<span class="row-sub">${esc(story.sentence)}</span>` +
    `<span class="call-row-foot"><span class="row-chips">${story.chips.slice(0, 2).map((c) => A.html.chip(c.cls, c.icon, c.text)).join('')}</span><span class="call-evidence">${rec.call && rec.call.transcript ? 'Transcript' : 'Saved summary'}${rec.call && href.recording(rec.call.recordingUrl) ? ' · Audio' : ''}</span></span>` +
    `</span></button>`
}
function bubbleRuns(transcript) {
  const runs = []
  let cur = null
  for (const raw of String(transcript ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    let speaker = null, txt = line
    if (/^AI:\s?/.test(line)) { speaker = 'assistant'; txt = line.replace(/^AI:\s?/, '') }
    else if (/^User:\s?/.test(line)) { speaker = 'caller'; txt = line.replace(/^User:\s?/, '') }
    if (speaker === null) { if (cur) { cur.texts.push(txt); continue } speaker = 'caller' }
    if (cur && cur.speaker === speaker) cur.texts.push(txt)
    else { cur = { speaker, texts: [txt] }; runs.push(cur) }
  }
  return runs
}
function supportHtml(rec) {
  const call = rec.call
  const pairs = [['Call id', rec.id]]
  if (call) {
    pairs.push(['Started', String(call.startedAt ?? '—')])
    pairs.push(['Ended because', String(call.endedReason ?? '—')])
    if (call.cost != null && !isNaN(Number(call.cost))) pairs.push(['Cost', "$" + Number(call.cost).toFixed(2)])
  }
  let out = pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
  if (call) for (const tc of call.toolCalls || []) {
    const args = tc && tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {}
    const argText = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')
    const result = tc && tc.result == null ? 'no result came back' : text.truncate(String(tc.result), 600)
    out += `<dt>Tool</dt><dd>${esc(String((tc && tc.name) ?? 'unknown'))}${argText ? `<br>${esc(argText)}` : ''}<p>${esc(result)}</p></dd>`
  }
  return `<dl class="facts">${out}</dl>`
}
function panelHtml(rec, story, s) {
  const call = rec.call
  const phone = fmt.phone(rec.phone)
  const dur = rec.durationSeconds != null ? fmt.duration(rec.durationSeconds) : '—'
  const meta = [phone ? (href.tel(rec.phone) ? `<a href="${esc(href.tel(rec.phone))}">${esc(phone)}</a>` : esc(phone)) : '', rec.startedAt ? esc(fmt.dateTime(rec.startedAt, { inSentence: true })) : '', dur !== '—' ? esc(dur) : '', story.ended ? esc(story.ended) : ''].filter(Boolean).join(' · ')
  let out = `<div class="panel-head"><button type="button" class="btn btn-quiet panel-back" data-action="close">${ico('chevron-left')}Calls</button>` +
    `<h2 tabindex="-1" data-key="panel-title">${esc(rec.displayName)}</h2>` +
    (rec.profile ? `<a class="btn btn-quiet" href="${esc(A.hashFor('leads', { phone: rec.profile.phone }))}">Open lead</a>` : '') +
    `<button type="button" class="btn-icon btn-quiet panel-close" aria-label="Close" data-action="close">${A.icon('x')}</button></div><div class="panel-body">`
  if (story.emergency) {
    const em = story.findings.emergency
    out += A.html.banner('danger', '', { raw: `<strong>Emergency — ${esc(em.phrase)}</strong> reported by ${phone ? esc(phone) : 'a caller with a hidden number'}${rec.startedAt ? ` ${esc(fmt.whenPhrase(rec.startedAt))}` : ''}.${em.matched ? ` They said "${esc(em.matched)}".` : ''} ${esc(em.action)}`, icon: 'siren' }) + '<div style="height:12px"></div>'
  }
  out += `<div class="panel-meta">${meta}</div>`
  const rec_ = call ? href.recording(call.recordingUrl) : null
  const actions = []
  if (rec_) actions.push(`<a class="btn" href="${esc(rec_)}" target="_blank" rel="noopener noreferrer">${ico('play')}Listen to the recording <span class="vh">(opens in a new tab)</span>${ico('external')}</a>`)
  if (call && call.transcript) actions.push(`<button type="button" class="btn btn-quiet" data-action="read">Read the conversation ${ico('chevron-down')}</button>`)
  if (s.callsConfigured === false) actions.push(`<span class="faint small">Recordings aren't connected.</span>`)
  if (actions.length) out += `<div class="panel-actions">${actions.join('')}</div>`
  if (!call) out += `<div style="margin-top:12px">${A.html.banner('info', 'This is a retained call summary. A transcript and recording are not in the loaded history.')}</div>`
  out += callContextHtml(rec, story, s)
  out += `<section class="panel-section call-story"><span class="section-kicker">Conversation brief</span><h3>What happened</h3><p class="story prose">${esc([story.who, story.wants, story.sentence].filter(Boolean).join(' '))}</p>` +
    (story.dropped ? `<p class="muted small" style="margin-top:6px">The call seems to have dropped partway through — the last step never finished.</p>` : '') +
    (story.chips.length ? `<div class="chips">${story.chips.map((c) => A.html.chip(c.cls, c.icon, c.text)).join('')}</div>` : '') + '</section>'
  if (story.needsPerson) {
    const r = story.restricted
    const t = r ? derive.escalationText({ trigger: r.trigger, detail: r.question }) : null
    const fus = (s.leads && s.leads.followUps) || []
    const fu = fus.find((f) => f && f.kind === 'callback' && f.createdFromCall === rec.id) || (rec.profile ? fus.find((f) => f && f.kind === 'callback' && f.phone === rec.profile.phone && f.status === 'scheduled') : null)
    let handling
    if (!fu) handling = '<span>No call-back was created for this.</span>'
    else if (fu.status === 'scheduled') handling = `<span>Still waiting — ${esc(fmt.respondPhrase(fu.dueAt))}</span><button type="button" class="btn" data-action="handled" data-fu="${esc(fu.id)}" data-key="fu:${esc(fu.id)}:done" data-write="leads">Mark handled</button>`
    else handling = fu.status === 'done' ? '<span>Handled — a person marked this done.</span>' : '<span>Marked not needed. No completed callback is recorded here.</span>'
    out += `<section class="panel-section"><h3 data-key="panel-np" tabindex="-1">Needs a person</h3><div class="card card-warn needs-card">` +
      (t ? `<div class="${t.quote === null ? 'quote' : ''}">${t.quote === null ? esc(t.headline.replace(/^asked /, '')) : esc(text.capitalise(t.headline))}</div>${t.quote ? `<div class="quote">"${esc(t.quote)}"</div>` : ''}<div class="reassure">${esc(t.reassurance)}</div>`
        : `<div>They wanted a tour but it couldn't be booked.</div><div class="reassure">The assistant said someone would call back with times.</div>`) +
      A.html.followUpReview(fu) + `<div class="handling">${handling}</div></div></section>`
  }
  out += `<section class="panel-section"><h3>What the assistant learned</h3>`
  if (story.facts.length) {
    out += `<dl class="facts">${story.facts.map((f) => f.unreadable
      ? `<dt>${esc(f.label)}</dt><dd>Couldn't make out their ${esc(A.label(A.labels.signalShort, f.signal, 'answer'))} from "${esc(f.value)}" — asked again.</dd>`
      : `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}${f.excerpt ? ` — <span class="quote">"${esc(f.excerpt)}"</span>` : ''}</dd>`).join('')}</dl>`
  } else out += `<p class="muted">No structured requirements were saved for this call.</p>`
  out += '</section>'
  out += `<section class="panel-section"><h3>What the assistant did</h3>`
  if (story.steps.length) out += `<ol class="steps">${story.steps.map((st) => `<li>${ico(st.icon)}<span>${esc(st.text)}</span></li>`).join('')}</ol>`
  else out += `<p class="muted">No completed tool actions are present in this call record.</p>`
  out += '</section>'
  const transcript = call && call.transcript ? String(call.transcript) : ''
  if (transcript.trim()) {
    const runs = bubbleRuns(transcript)
    const lines = transcript.split('\n').filter((l) => l.trim()).length
    const open = isDesktop() && lines <= 40
    out += `<details class="panel-section convo" data-key="convo"${open ? ' open' : ''}><summary><h3>Conversation</h3>${ico('chevron-down')}</summary><div class="bubbles">` +
      runs.map((r) => `<div class="bubble-run ${r.speaker}"><span class="bubble-label">${r.speaker === 'caller' ? 'Caller' : 'Assistant'}</span><div class="bubble">${esc(r.texts.join('\n'))}</div></div>`).join('') + '</div></details>'
  } else if (call) {
    out += `<section class="panel-section"><h3>Conversation</h3><p class="muted">No transcript was saved for this call.${s.callsConfigured === false ? ' Transcripts aren\'t connected yet — see Status.' : ''}</p></section>`
  }
  out += `<details class="panel-section support" data-key="support"><summary>${ico('chevron-down')}For support</summary>${supportHtml(rec)}</details>`
  out += '</div>'
  return out
}

const view = {
  title: 'Calls', icon: A.icons.calls, root: null, list: null, panel: null, split: null, banners: null, chipsEl: null, search: null,
  q: '', filter: 'all', openId: null, listHtml: null, panelHtml: null, bannerHtml: null, prevIds: null, warnedStale: new Set(),
  savedScroll: null, returnKey: null, focusPanel: false, typing: null,
  mount(root) {
    this.root = root
    root.innerHTML = `<div class="calls-view"><header class="page-hero"><div><span class="page-eyebrow">Leasing conversations</span><h1 tabindex="-1">Calls</h1><p>Hear what matters. See what happened. Know what needs a person.</p></div><div class="page-hero-actions"><a class="btn" href="${esc(A.hashFor('leads', { tab: 'todo' }))}">${ico('leads')}Open work queue</a></div></header><div class="calls-overview"></div><div class="calls-banners"></div>` +
      `<div class="calls-tools workspace-panel"><div class="calls-search-head"><div><span class="section-kicker">Conversation history</span><p>Search the loaded calls and retained summaries.</p></div><label class="search"><span class="vh">Search calls by name, number or apartment</span>${ico('search')}<input type="search" data-key="search" placeholder="${esc(searchPlaceholder())}" aria-label="Search calls by name, number or apartment" autocomplete="off"></label></div>` +
      `<div class="chips" role="group" aria-label="Filter calls">${FILTERS.map(([k, l]) => `<button type="button" class="chip-filter" data-filter="${k}" aria-pressed="${k === 'all' ? 'true' : 'false'}">${ico('check')}<span>${esc(l)} · 0</span></button>`).join('')}</div></div>` +
      `<div class="split calls-split"><div class="split-list calls-list" data-key="list"></div><div class="panel call-panel" data-key="panel"></div></div></div>`
    this.wrap = root.querySelector('.calls-view'); this.overview = root.querySelector('.calls-overview'); this.overviewHtml = null
    this.banners = root.querySelector('.calls-banners'); this.chipsEl = root.querySelector('.chips'); this.search = root.querySelector('input[data-key="search"]')
    this.split = root.querySelector('.split'); this.list = root.querySelector('.calls-list'); this.panel = root.querySelector('.call-panel')
    this.search.addEventListener('input', () => {
      clearTimeout(this.typing)
      this.typing = setTimeout(() => { const v = this.search.value.trim(); if (v !== this.q) this.setParams({ q: v || undefined }, true) }, 150)
    })
    this.chipsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.chip-filter')
      if (!b || b.getAttribute('aria-disabled') === 'true') return
      this.setParams({ filter: b.dataset.filter === 'all' ? undefined : b.dataset.filter }, true)
    })
    this.list.addEventListener('click', (e) => { const row = e.target.closest('.call-row'); if (row) this.open(row.dataset.id, row) })
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const rows = [...this.list.querySelectorAll('.call-row')]
      const i = rows.indexOf(document.activeElement)
      if (i < 0) return
      e.preventDefault()
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      rows.forEach((r) => r.setAttribute('tabindex', r === next ? '0' : '-1'))
      next.focus()
    })
    this.panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]')
      if (!btn) return
      if (btn.dataset.action === 'close') this.close()
      else if (btn.dataset.action === 'read') {
        const d = this.panel.querySelector('.convo')
        if (d) { d.open = true; d.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
      } else if (btn.dataset.action === 'handled') {
        const fu = ((A.state.leads && A.state.leads.followUps) || []).find((f) => f && f.id === btn.dataset.fu)
        if (fu) A.setFollowUpStatus(fu, 'done', { verb: 'handled', button: btn })
      }
    })
    // Esc closes the open panel when it is the page (stacked layout) or when focus is inside it (split);
    // focus goes back to the row that opened it (the closing path in render()).
    A.escape.push(() => { if (this.openId && !this.root.hidden && (!isSplit() || this.panel.contains(document.activeElement))) { this.close(); return true } return false })
    const repaint = () => { if (this.root && !this.root.hidden) this.render(A.state) }
    A.on('data', repaint); A.on('minute', repaint)
    let resizeTimer = null
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { this.search.placeholder = searchPlaceholder(); this.panelHtml = null; this.listHtml = null; repaint() }, 150) })
  },
  params() { return A.route().params },
  setParams(patch, replace) {
    const p = { ...this.params(), ...patch }
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k]
    A.navigate('calls', p, { replace })
  },
  open(id, rowEl) {
    this.savedScroll = { list: this.list.scrollTop, page: window.scrollY }
    this.returnKey = rowEl ? rowEl.dataset.key : `row:${id}`
    this.focusPanel = true
    this.setParams({ id }, false)
  },
  close() {
    this.closing = true
    this.setParams({ id: undefined }, true)
  },
  render(s) {
    if (!this.root) return
    const p = this.params()
    this.q = String(p.q || '').trim()
    this.filter = FILTERS.some(([k]) => k === p.filter) ? p.filter : 'all'
    if (document.activeElement !== this.search && this.search.value !== this.q) this.search.value = this.q
    const wantId = p.id || null
    const today = fmt.nyNow().ymd
    const records = derive.callRecords(s)
    const stories = new Map(records.map((r) => [r.id, derive.callStory(r, s)]))
    const known = s.loaded.calls || s.loaded.leads
    const overviewHtml = callOverviewHtml(s, records, stories)
    if (overviewHtml !== this.overviewHtml) { this.overviewHtml = overviewHtml; this.overview.innerHTML = overviewHtml }
    if (wantId && known && !records.some((r) => r.id === wantId)) {
      if (!this.warnedStale.has(wantId)) { this.warnedStale.add(wantId); A.toast("That item isn't on the list any more.", { kind: 'info' }) }
      this.setParams({ id: undefined }, true)
      return
    }
    const searched = records.filter((r) => matches(r, stories.get(r.id), this.q))
    const counts = {}
    for (const [k] of FILTERS) counts[k] = searched.filter((r) => passes(k, stories.get(r.id))).length
    if (this.filter !== 'all' && counts[this.filter] === 0 && known) { this.setParams({ filter: undefined }, true); return }
    const shown = searched.filter((r) => passes(this.filter, stories.get(r.id)))
    // banners
    let banners = ''
    if (s.errors.calls && s.loaded.calls) banners += A.html.banner('warn', `We can't load calls right now.${s.lastGoodAt.calls ? ` Showing what we had at ${fmt.time(s.lastGoodAt.calls)}.` : ''}`)
    else if (s.errors.calls) banners += A.html.banner('warn', "We can't load calls right now.")
    if (s.callsConfigured === false) banners += A.html.banner('info', '', { raw: `<strong>Call history isn't connected yet.</strong> Calls the assistant handled still show here from the leads' records. Recordings and transcripts need a connection — <a href="#/status">see Status</a>.` })
    else if (s.callsError && s.callsConfigured) banners += A.html.banner('warn', '', { raw: `<strong>Call history is temporarily unavailable — trying again.</strong>${s.lastGoodAt.calls ? ` Showing what we had at ${esc(fmt.time(s.lastGoodAt.calls))}.` : ''}` })
    if (s.safetyEventsError) banners += A.html.banner('warn', 'Safety reports are temporarily unavailable. The list may be incomplete. Trying again.')
    if (banners !== this.bannerHtml) { this.bannerHtml = banners; this.banners.innerHTML = banners; this.banners.style.marginBottom = banners ? '16px' : '0' }
    // chips
    for (const b of this.chipsEl.querySelectorAll('.chip-filter')) {
      const k = b.dataset.filter, lbl = FILTERS.find(([x]) => x === k)[1]
      b.querySelector('span:last-child').textContent = `${lbl} · ${counts[k] || 0}`
      b.setAttribute('aria-pressed', k === this.filter ? 'true' : 'false')
      if (k !== 'all' && !counts[k]) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled')
    }
    // list
    let listHtml = ''
    if (!known && !s.errors.calls && !s.errors.leads) {
      listHtml = `<div class="skeleton" aria-busy="true" style="padding:12px"><span class="vh">Loading…</span><div class="skeleton-line"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-line"></div><div class="skeleton-row"></div></div>`
    } else if (!records.length) {
      listHtml = A.html.empty({ icon: 'phone', title: 'No calls yet.', text: 'Calls to the leasing line show up here within a minute of ending.' })
    } else if (!shown.length) {
      listHtml = A.html.empty({ icon: 'search', title: `Nothing matches "${this.q}".`, text: 'Try a name, the last four digits, or an apartment number.' })
    } else {
      const groups = []
      for (const r of shown) {
        const ymd = r.startedAt ? fmt.nyDate(r.startedAt) : null
        const last = groups[groups.length - 1]
        if (last && last.ymd === ymd) last.items.push(r); else groups.push({ ymd, items: [r] })
      }
      const firstId = (wantId && shown.some((r) => r.id === wantId)) ? wantId : shown[0].id
      for (const g of groups) {
        listHtml += `<h2 class="day-head"><span>${esc(dayLabel(g.ymd, today))}</span><span class="num">${g.items.length}</span></h2><div class="card rows">` +
          g.items.map((r) => rowHtml(r, stories.get(r.id), r.id === wantId, r.id === firstId, Boolean(this.prevIds) && !this.prevIds.has(r.id))).join('') + '</div>'
      }
      listHtml += `<p class="calls-end">${esc(text.plural(shown.length, 'call record'))} shown${shown.length !== records.length ? ` of ${records.length} loaded` : ''}. Retained summaries may not include a transcript or recording.</p>`
    }
    if (listHtml !== this.listHtml) {
      this.listHtml = listHtml
      const focusKey = this.list.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key : null
      const top = this.list.scrollTop
      this.list.innerHTML = listHtml
      this.list.scrollTop = top
      if (focusKey) { const el = this.list.querySelector(`[data-key="${cssq(focusKey)}"]`); if (el) { try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
    }
    this.prevIds = new Set(records.map((r) => r.id))
    // panel
    const openRec = wantId ? records.find((r) => r.id === wantId) : null
    let panelHtml_ = ''
    if (openRec) { this.split.classList.add('has-panel'); panelHtml_ = panelHtml(openRec, stories.get(openRec.id), s) }
    else { this.split.classList.remove('has-panel'); panelHtml_ = isSplit() ? `<div class="panel-empty"><div class="call-empty-guide">${ico('calls')}<span class="section-kicker">The full conversation</span><h2>Select a call</h2><p>Move from the conversation to the prospect, the saved outcome, and the next staff action.</p><ol><li><span>01</span>Review the conversation brief</li><li><span>02</span>Read or listen to the saved call</li><li><span>03</span>Follow through in Leads</li></ol></div></div>` : '' }
    this.wrap.classList.toggle('has-panel', Boolean(openRec))
    if (panelHtml_ !== this.panelHtml) {
      const wasOpen = new Set([...this.panel.querySelectorAll('details[open]')].map((d) => d.dataset.key))
      const sameCall = this.openId === (openRec && openRec.id)
      this.panelHtml = panelHtml_
      const top = this.panel.scrollTop
      this.panel.innerHTML = panelHtml_
      if (sameCall) { for (const d of this.panel.querySelectorAll('details')) d.open = wasOpen.has(d.dataset.key); this.panel.scrollTop = top }
    }
    const prevOpen = this.openId
    this.openId = openRec ? openRec.id : null
    if (openRec && this.focusPanel) {
      this.focusPanel = false
      const h2 = this.panel.querySelector('h2')
      if (h2) { try { h2.focus({ preventScroll: isSplit() }) } catch (e) { /* ignore */ } }
      if (!isSplit()) window.scrollTo({ top: 0, behavior: 'auto' })
    } else if (!openRec && prevOpen && this.closing) {
      this.closing = false
      const row = this.returnKey ? this.list.querySelector(`[data-key="${cssq(this.returnKey)}"]`) : null
      if (this.savedScroll) { this.list.scrollTop = this.savedScroll.list; window.scrollTo({ top: this.savedScroll.page, behavior: 'auto' }) }
      if (row) { for (const r of this.list.querySelectorAll('.call-row')) r.setAttribute('tabindex', r === row ? '0' : '-1'); try { row.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
    }
    A.busyNow('leads')
  },
  badge() { return null },
}
A.register('calls', view)
})()
