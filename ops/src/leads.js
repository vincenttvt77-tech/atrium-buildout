/*
 * Leads view (brief §9). Owner: leads. Registers 'leads' on window.Atrium and renders into the
 * root the shell hands it: two tabs — To do (scheduled follow-ups grouped Overdue / Today /
 * Later this week / Later on the New York calendar, with the "Done and not needed today"
 * recovery list) and Everyone (the pipeline: search, stage chips, one row per caller) — and
 * the person panel (split ≥ 1200 px, a page with "‹ Leads" below), which opens from a name,
 * a row, or `#/leads?phone=…` (Today and Calls link here).
 *
 * Data comes only from Atrium.state and Atrium.derive; nothing here calls fetch. Writes:
 * Done / Not needed / Put back / Mark handled go through Atrium.setFollowUpStatus (the shell's
 * shared busy → apply → toast → undo path); Save note and Set name POST {action:'note'} through
 * Atrium.busy + Atrium.api.post and paint from the returned profile via Atrium.apply.
 *
 * Re-render rules: each region (banners, list, panel) is rebuilt as a string and replaced only
 * when it changed, so a poll that changes nothing on screen touches nothing; the focused
 * control's data-key, the caret in the note field, note drafts (per phone), open <details>,
 * the open panel and the list's scroll offset survive every replacement. A once-a-minute tick
 * re-evaluates the due groups so a row moves into Today or Overdue without a data change.
 */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml
const { fmt, derive, text, href, labels } = A
const ico = (n) => `<span class="ico">${A.icon(n)}</span>`
const cssq = (s) => (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, (c) => '\\' + c)
const isSplit = () => matchMedia('(min-width: 1200px)').matches
const isMobile = () => matchMedia('(max-width: 959px)').matches
/* Shorter placeholders on a phone so they are not cut off at 390 px; the hint line under the note field still says to start with initials. */
const searchPlaceholder = () => (isMobile() ? 'Search name, number or apartment' : 'Search by name, number or apartment')
const notePlaceholder = () => (isMobile() ? 'Add a note, e.g. "MR: left a voicemail"' : 'Add a note — start with your initials, e.g. "MR: left a voicemail"')
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const arr = (v) => (Array.isArray(v) ? v : [])
const toTime = (v) => { if (v == null || v === '') return null; const t = Date.parse(String(v)); return isNaN(t) ? null : t }
const profilesOf = (s) => arr(s.leads && s.leads.profiles).filter((p) => p && p.phone != null)
const followUpsOf = (s) => arr(s.leads && s.leads.followUps).filter((f) => f && f.id != null)
const callAt = (profile, callId) => { const c = profile && arr(profile.calls).find((x) => x && x.callId === callId); return c ? c.at : null }
const byDue = (a, b) => (toTime(a.dueAt) ?? Infinity) - (toTime(b.dueAt) ?? Infinity)
const byDueDesc = (a, b) => (toTime(b.dueAt) ?? 0) - (toTime(a.dueAt) ?? 0)
const openItems = (s, phone) => derive.needsPerson(s).filter((n) => n && n.phone === phone)

const TABS = [['todo', 'To do'], ['all', 'Everyone']]
const STAGES = [['all', 'All'], ['new', 'New'], ['qualified', 'Interested'], ['tour_scheduled', 'Tour booked'], ['toured', 'Toured'], ['lost', "Didn't work out"], ['needs_person', 'Needs a person']]
const GROUPS = [['overdue', 'Overdue', 'clock'], ['today', 'Today', null], ['week', 'Later this week', null], ['later', 'Later', null]]

// ---------------------------------------------------------------------------------------
// Small builders (every caller string is escaped here)
// ---------------------------------------------------------------------------------------

const telLink = (phone) => { const h = href.tel(phone), shown = fmt.phone(phone); return h && shown ? `<a href="${esc(h)}">${esc(shown)}</a>` : esc(shown) }
const mailLink = (email) => { const h = href.mailto(email); return h ? `<a href="${esc(h)}">${esc(email)}</a>` : esc(email || '') }
const telBtn = (phone, txt, cls) => { const h = href.tel(phone); return h ? `<a class="${cls || 'btn btn-call'}" href="${esc(h)}">${ico('phone')}${esc(txt || 'Call')}</a>` : '' }
const link = (name, params, txt, cls) => `<a class="${cls || 'btn btn-quiet'}" href="${esc(A.hashFor(name, params))}">${esc(txt)}</a>`
const chip = (cls, iconName, txt) => A.html.chip(cls, iconName, txt)
const countHtml = (n) => `<span class="count">· ${Number(n) || 0}</span>`

/** '2026-09-07T21:49:42.591Z MR: left a voicemail' → { stamp, body }; a note without a stamp is all body. */
function parseNote(n) {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(String(n ?? ''))
  if (m && /^\d{4}-\d{2}-\d{2}T\S+$/.test(m[1]) && toTime(m[1]) != null) return { stamp: m[1], body: m[2] }
  return { stamp: null, body: String(n ?? '') }
}
const nameNote = (body) => { const m = /^name:\s*(.+)$/i.exec(String(body ?? '').trim()); return m ? m[1].trim() : null }
const bedroomsFact = (v) => { const t = derive.bedroomsText(v); return /or more$/.test(t) ? `${t} bedrooms` : t }
const nextTour = (p) => arr(p.bookings).filter((b) => b && b.status === 'confirmed' && (toTime(b.startsAt) ?? -1) >= Date.now()).sort((a, b) => toTime(a.startsAt) - toTime(b.startsAt))[0] || null
/** The calendar's name for one of this caller's tours, when the profile has none (§9.4.1). */
function calendarName(p, s) {
  const cal = s.calendar
  if (!cal) return null
  const ids = new Set(arr(p.bookings).map((b) => b && b.slotId))
  const hit = arr(cal.bookings).find((b) => b && ids.has(b.slotId) && String(b.prospectName ?? '').trim())
  return hit ? String(hit.prospectName).trim() : null
}

// ---------------------------------------------------------------------------------------
// To do tab (§9.1)
// ---------------------------------------------------------------------------------------

function groupOf(fu, now, today, weekEnd) {
  const t = toTime(fu.dueAt)
  if (t == null) return 'later'
  if (t <= now) return 'overdue'
  const ymd = fmt.nyDate(fu.dueAt)
  if (ymd === today) return 'today'
  if (ymd && ymd <= weekEnd) return 'week'
  return 'later'
}
/** One scheduled follow-up as a §6.3 row. o.nameLink: the name opens the person panel. */
function fuRowHtml(fu, s, o) {
  const profile = derive.profileByPhone(s, fu.phone)
  const sen = derive.todoSentence(fu, profile, s)
  const overdue = (toTime(fu.dueAt) ?? Infinity) <= Date.now()
  const channel = String(fu.channel ?? 'call')
  const email = profile && profile.email
  const from = callAt(profile, fu.createdFromCall) || fu.createdAt
  const shown = fmt.phone(fu.phone)
  const nameHtml = o && o.nameLink
    ? `<button type="button" class="btn-link name" data-action="open" data-phone="${esc(fu.phone)}" data-key="who:${esc(fu.id)}">${esc(sen.name)}</button>`
    : `<span class="name">${esc(sen.name)}</span>`
  let primary = ''
  if (channel === 'email' && href.mailto(email)) primary = `<a class="btn btn-quiet btn-call" href="${esc(href.mailto(email))}">${ico('mail')}Email</a>`
  else if (channel === 'sms' && href.sms(fu.phone)) primary = `<a class="btn btn-quiet btn-call" href="${esc(href.sms(fu.phone))}">${ico('message')}Text</a>`
  else primary = telBtn(fu.phone, 'Call', 'btn btn-quiet btn-call')
  const sub = [shown ? telLink(fu.phone) : '', channel === 'email' && email ? mailLink(email) : '', `from their call ${esc(fmt.dateTime(from, { inSentence: true }))}`].filter(Boolean).join(' · ')
  return `<div class="row row-stack todo-row${sen.needsPerson ? ' row-flag' : ''}" data-key="fu:${esc(fu.id)}">` +
    `<span class="row-lead"><span class="due${overdue ? ' overdue' : ''}">${overdue ? ico('clock') : ''}<span>${esc(fmt.duePhrase(fu.dueAt))}</span></span>` +
    `<span class="row-lead-icon">${ico(sen.needsPerson ? 'hand' : A.label(labels.channelIcon, channel, 'phone'))}</span></span>` +
    `<span class="row-body"><span class="row-title">${esc(sen.before)}${nameHtml}${esc(sen.after)}</span>` +
    (sen.needsPerson ? `<span class="row-chips">${chip('chip-warn', 'hand', 'Needs a person')}</span>` : '') +
    `<span class="row-sub">${sub}</span></span>` +
    `<span class="row-actions">${primary}` +
    `<button type="button" class="btn" data-action="done" data-fu="${esc(fu.id)}" data-key="fu:${esc(fu.id)}:done" data-write="leads">Done</button>` +
    `<button type="button" class="btn" data-action="skip" data-fu="${esc(fu.id)}" data-key="fu:${esc(fu.id)}:skip" data-write="leads">Not needed</button></span></div>`
}
/** A done / not-needed follow-up with its Put back button (the recovery list). */
function doneRowHtml(fu, s) {
  const sen = derive.todoSentence(fu, derive.profileByPhone(s, fu.phone), s)
  const done = String(fu.status) === 'done'
  return `<div class="row done-row" data-key="fu:${esc(fu.id)}"><span class="row-body">` +
    `<span class="row-title">${esc(sen.before)}<span class="name">${esc(sen.name)}</span>${esc(sen.after)}</span>` +
    `<span class="row-chips">${done ? chip('chip-ok', 'check', 'Done') : chip('chip-neutral', 'x', 'Not needed')}</span></span>` +
    `<span class="row-actions"><button type="button" class="btn btn-quiet" data-action="back" data-fu="${esc(fu.id)}" data-key="fu:${esc(fu.id)}:back" data-write="leads">${ico('undo')}Put back</button></span></div>`
}
function todoListHtml(s) {
  const now = Date.now(), today = fmt.nyNow().ymd, weekEnd = fmt.addDays(today, 6 - fmt.dayOfWeek(today))
  const all = followUpsOf(s)
  const scheduled = all.filter((f) => f.status === 'scheduled').sort(byDue)
  const done = all.filter((f) => (f.status === 'done' || f.status === 'skipped') && (fmt.nyDate(f.dueAt) || '9999') <= today).sort(byDueDesc).slice(0, 20)
  let out = ''
  if (!scheduled.length) {
    if (!all.length) out += A.html.empty({ icon: 'check-circle', title: 'Nothing to do yet.', text: "When the assistant thinks someone needs a call — a tour to confirm, a question it couldn't answer — it shows up here." })
    else out += A.html.empty({ icon: 'check-circle', title: 'All caught up.', text: 'Everything on the list is done.', actionHtml: done.length ? `<button type="button" class="btn-link" data-action="seedone">See what's done</button>` : '' })
  } else {
    const groups = { overdue: [], today: [], week: [], later: [] }
    for (const f of scheduled) groups[groupOf(f, now, today, weekEnd)].push(f)
    for (const [key, label_, iconName] of GROUPS) {
      const items = groups[key]
      if (!items.length) continue
      out += `<h2 class="group-head${key === 'overdue' ? ' overdue' : ''}" data-key="group:${key}" tabindex="-1">${iconName ? ico(iconName) : ''}<span>${esc(label_)}</span>${countHtml(items.length)}</h2>` +
        `<div class="card rows">${items.map((f) => fuRowHtml(f, s, { nameLink: true })).join('')}</div>`
    }
  }
  if (done.length) {
    out += `<details class="done-list" data-key="done-today"><summary data-key="done-today-summary">${ico('chevron-down')}<span>Done and not needed today</span>${countHtml(done.length)}</summary>` +
      `<div class="card rows">${done.map((f) => doneRowHtml(f, s)).join('')}</div></details>`
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Everyone tab (§9.3)
// ---------------------------------------------------------------------------------------

function leadMatches(p, q) {
  if (!q) return true
  const numeric = /^[\d\s()+.-]+$/.test(q)
  const digits = q.replace(/\D/g, '')
  if (numeric && digits.length >= 2) return String(p.phone ?? '').replace(/\D/g, '').includes(digits)
  const hay = [derive.displayName(p), p.name, p.email, ...arr(p.unitsDiscussed), ...arr(p.bookings).map((b) => b && b.unitId),
    ...arr(p.notes).map((n) => parseNote(n).body)].filter(Boolean).join('\n').toLowerCase()
  return hay.includes(q.toLowerCase())
}
function passesStage(p, s, key) {
  if (key === 'all') return true
  if (key === 'needs_person') return openItems(s, p.phone).length > 0
  return derive.displayStage(p, s).key === key
}
/** Open needs-a-person item first (soonest respond-by first), then last call, newest first. */
function sortLeads(list, s) {
  const urgency = (p) => { const items = openItems(s, p.phone); return items.length ? Math.min(...items.map((i) => toTime(i.respondBy) ?? i.sortAt ?? 0)) : null }
  return list.map((p) => ({ p, u: urgency(p), t: toTime(p.lastSeenAt) ?? 0 })).sort((a, b) => {
    if (a.u != null && b.u != null) return a.u - b.u
    if (a.u != null) return -1
    if (b.u != null) return 1
    return b.t - a.t
  }).map((x) => x.p)
}
function computeEveryone(s, q, stage) {
  const profiles = profilesOf(s)
  const searched = profiles.filter((p) => leadMatches(p, q))
  const counts = {}
  for (const [k] of STAGES) counts[k] = searched.filter((p) => passesStage(p, s, k)).length
  const shown = sortLeads(searched.filter((p) => passesStage(p, s, stage)), s)
  return { profiles, searched, counts, shown }
}
function leadRowHtml(p, s, open, tab) {
  const hidden = p.phone === 'unknown'
  const name = derive.displayName(p)
  const stage = derive.displayStage(p, s)
  const items = openItems(s, p.phone)
  const flag = items.length > 0
  const sig = p.signals || {}
  const facts = []
  if (hidden) facts.push(`${text.plural(arr(p.calls).length, 'call')} from numbers that weren't shared`)
  else if (p.name && fmt.phone(p.phone)) facts.push(fmt.phone(p.phone)) // a nameless row's title is already the number
  const more = []
  if (sig.bedrooms) more.push(bedroomsFact(sig.bedrooms.value))
  if (sig.budget) more.push(`up to ${fmt.money(sig.budget.value)}/mo`)
  if (sig.moveIn) more.push(String(sig.moveIn.excerpt || derive.moveInText(sig.moveIn.value) || ''))
  const tour = nextTour(p)
  const cb = items.find((i) => i.type === 'callback' && i.question)
  const loss = arr(p.lossReasons).filter(Boolean).slice(-1)[0]
  if (tour) more.push(`tour ${fmt.dayPhrase(tour.startsAt)} ${fmt.time(tour.startsAt)}${tour.unitId ? ` (${tour.unitId})` : ''}`)
  else if (cb) more.push(`"${text.truncate(cb.question, 60)}"`)
  else if (stage.key === 'lost' && loss) more.push(derive.lossText(loss))
  const line2 = facts.concat(more.filter(Boolean).slice(0, 4))
  if (!more.filter(Boolean).length) line2.push('no details yet')
  return `<button type="button" class="row row-click lead-row${flag ? ' row-flag' : ''}" data-key="lead:${esc(p.phone)}" data-phone="${esc(p.phone)}" aria-current="${open ? 'true' : 'false'}" tabindex="${tab ? '0' : '-1'}">` +
    `<span class="row-lead"><span class="row-lead-icon">${ico(flag ? 'hand' : 'person')}</span></span>` +
    `<span class="row-body"><span class="row-title"><span class="who">${esc(name)}</span>${chip(stage.chipClass, stage.icon, stage.label)}` +
    (flag && stage.key !== 'escalated' ? chip('chip-warn', 'hand', 'Needs a person') : '') +
    `<span class="last num">Last call ${esc(fmt.relative(p.lastSeenAt))}</span></span>` +
    `<span class="row-sub">${line2.map((f) => (f.startsWith('"') ? `<span class="quote">${esc(f)}</span>` : esc(f))).join(' · ')}</span></span></button>`
}
function everyoneListHtml(ev, s, q, stage, openPhone) {
  if (!ev.profiles.length) return A.html.empty({ icon: 'leads', title: 'No callers yet.', text: "When someone calls the leasing line, they'll appear here with what they asked for." })
  if (!ev.shown.length) {
    if (q) return A.html.empty({ icon: 'search', title: `No one matches "${q}".`, text: 'Try a last name, the number, or an apartment.' })
    const lbl = (STAGES.find(([k]) => k === stage) || ['', 'that stage'])[1]
    return A.html.empty({ icon: 'leads', title: `No one is at "${lbl}" right now.` })
  }
  const first = (openPhone && ev.shown.some((p) => p.phone === openPhone)) ? openPhone : ev.shown[0].phone
  return `<div class="card rows">${ev.shown.map((p) => leadRowHtml(p, s, p.phone === openPhone, p.phone === first)).join('')}</div>`
}

// ---------------------------------------------------------------------------------------
// The person panel (§9.4)
// ---------------------------------------------------------------------------------------

/** Budget / Bedrooms / Move-in from the profile; Pets / Parking from the profile or the call record (gap G-7). */
function lookingFor(p, s, recById) {
  const sig = p.signals || {}
  const out = []
  const push = (label_, e, value, from) => out.push({ label: label_, value: String(value ?? ''), excerpt: String((e && e.excerpt) ?? ''), unsure: e != null && Number(e.confidence) < 0.7, from: from || null, confidence: e && e.confidence })
  if (sig.budget) push('Budget', sig.budget, `up to ${fmt.money(sig.budget.value)}/mo`)
  if (sig.bedrooms) push('Bedrooms', sig.bedrooms, derive.bedroomsText(sig.bedrooms.value))
  if (sig.moveIn) push('Move-in', sig.moveIn, derive.moveInText(sig.moveIn.value) || String(sig.moveIn.excerpt ?? ''))
  for (const key of ['pets', 'parking']) {
    const label_ = key === 'pets' ? 'Pets' : 'Parking'
    if (sig[key]) { push(label_, sig[key], sig[key].value); continue }
    let found = null
    for (const c of arr(p.calls)) {
      const rec = c && recById.get(String(c.callId))
      if (!rec || !rec.call) continue
      for (const tc of arr(rec.call.toolCalls)) {
        const args = tc && tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : null
        if (!args || tc.name !== 'capture_signal' || args.signal !== key || typeof tc.result !== 'string' || !/^Got it/.test(tc.result)) continue
        const at = toTime(rec.startedAt) ?? toTime(c.at) ?? 0
        if (!found || at >= found.at) found = { at, value: args.value, excerpt: args.excerpt, from: rec.startedAt || c.at }
      }
    }
    if (found) push(label_, { excerpt: found.excerpt, confidence: 1 }, found.value, found.from)
  }
  return out
}
function npCardHtml(it, recById) {
  const rec = recById.get(String(it.callId))
  const seeCall = rec && (rec.call || arr(rec.events).length) ? link('calls', { id: it.callId }, 'See the call') : ''
  if (it.type === 'callback') {
    const t = derive.escalationText({ trigger: it.trigger, detail: it.question })
    const overdue = (toTime(it.respondBy) ?? Infinity) <= Date.now()
    return `<div class="card card-warn np-card"><div class="np-title"><strong>Call ${esc(derive.personName(it.profile || { phone: it.phone, name: null }))} back</strong> — ${esc(t.headline)}</div>` +
      (t.quote ? `<div class="quote">"${esc(t.quote)}"</div>` : '') +
      `<div class="reassure">${esc(t.reassurance)}</div>` +
      `<div class="meta">called ${esc(fmt.dateTime(it.calledAt, { inSentence: true }))} · <span class="${overdue ? 'overdue' : ''}">${esc(fmt.respondPhrase(it.respondBy))}</span></div>` +
      `<div class="actions"><button type="button" class="btn" data-action="handled" data-fu="${esc(it.fu.id)}" data-key="fu:${esc(it.fu.id)}:done" data-write="leads">Mark handled</button>${seeCall}</div></div>`
  }
  if (it.type === 'stuckTour') {
    const b = it.booking, failed = b.status === 'failed'
    return `<div class="card card-warn np-card"><div class="np-title"><strong>${failed ? "Tour wasn't booked" : "Tour isn't confirmed yet"}</strong> — ${failed ? "the assistant couldn't reach the calendar" : 'the assistant is still arranging it'}</div>` +
      `<div class="meta">called ${esc(fmt.dateTime(it.calledAt, { inSentence: true }))} · wanted ${esc(fmt.day(b.startsAt))} at ${esc(fmt.time(b.startsAt))}${b.unitId ? ` (${esc(b.unitId)})` : ''}</div>` +
      `<div class="reassure">Call to set a time.</div>` +
      `<div class="actions">${telBtn(it.phone, 'Call', 'btn')}${link('calendar', { date: fmt.nyDate(b.startsAt) || undefined }, 'Calendar')}</div></div>`
  }
  if (it.type === 'emergency') {
    return `<div class="card card-danger np-card"><div class="np-title"><strong>Emergency — ${esc(it.phrase)}</strong> reported ${esc(fmt.whenPhrase(it.at) || fmt.dateTime(it.at, { inSentence: true }))}.${it.matched ? ` They said "${esc(it.matched)}".` : ''} ${esc(it.action)}</div>` +
      (seeCall ? `<div class="actions">${seeCall}</div>` : '') + '</div>'
  }
  return ''
}
function panelHeadHtml(titleHtml, extra) {
  return `<div class="panel-head"><button type="button" class="btn btn-quiet panel-back" data-action="close">${ico('chevron-left')}Leads</button>` +
    `<h2 tabindex="-1" data-key="panel-title">${titleHtml}</h2>${extra || ''}` +
    `<button type="button" class="btn-icon btn-quiet panel-close" aria-label="Close" data-action="close">${A.icon('x')}</button></div>`
}
function gonePanelHtml() {
  return panelHeadHtml('This caller is no longer on the list.') +
    `<div class="panel-body gone"><p class="muted">They may have been removed by a demo reset or by someone else.</p><button type="button" class="btn" data-action="close" data-key="gone-back">Back</button></div>`
}
function leadPanelHtml(p, s) {
  const hidden = p.phone === 'unknown'
  const name = derive.displayName(p)
  const first = text.firstName(p.name) || 'this caller'
  const stage = derive.displayStage(p, s)
  const items = openItems(s, p.phone)
  const records = derive.callRecords(s), recById = new Map(records.map((r) => [String(r.id), r]))
  const shown = fmt.phone(p.phone)
  const setName = hidden ? '' : `<button type="button" class="btn btn-quiet setname" data-action="setname" data-key="setname" data-write="leads">${ico('note')}${p.name ? 'Edit name' : 'Set name'}</button>`
  let out = panelHeadHtml(esc(name), setName) + '<div class="panel-body"><div class="lead-head">'
  // 1. header
  out += `<div class="lead-chips">${chip(stage.chipClass, stage.icon, stage.label)}${items.length && stage.key !== 'escalated' ? chip('chip-warn', 'hand', 'Needs a person') : ''}</div>`
  if (hidden) out += `<div class="lead-meta">${esc(text.plural(arr(p.calls).length, 'call'))} from numbers that weren't shared</div>`
  else out += `<div class="lead-meta">${shown ? `${telLink(p.phone)} · ` : ''}${p.email ? mailLink(p.email) : 'No email yet'}</div>`
  out += `<div class="lead-meta">First called ${esc(fmt.monthDay(p.firstSeenAt))} · Last call ${esc(fmt.dateTime(p.lastSeenAt, { inSentence: true }))}</div>`
  if (shown && href.tel(p.phone)) out += `<a class="btn btn-primary lead-call" href="${esc(href.tel(p.phone))}">${ico('phone')}Call ${esc(shown)}</a>`
  if (!hidden && !p.name) {
    const sug = calendarName(p, s)
    if (sug) out += `<div class="suggest"><span>The tour was booked under "${esc(sug)}" —</span><button type="button" class="btn-link" data-action="usename" data-name="${esc(sug)}" data-key="usename" data-write="leads">Use this name</button></div>`
  }
  out += '</div>'
  // 2. needs a person (open items, then history)
  const openCallIds = new Set(items.map((i) => String(i.callId)))
  const history = arr(p.escalations).filter((e) => e && !openCallIds.has(String(e.callId)))
  if (items.length || history.length) {
    out += `<section class="panel-section"><h3 data-key="panel-np" tabindex="-1">Needs a person</h3>${items.map((it) => npCardHtml(it, recById)).join('')}`
    if (history.length) out += `<div class="np-history">${history.map((e) => { const t = derive.escalationText(e); return `<div class="np-hist">Handled — ${esc(t.headline)} · ${esc(fmt.monthDay(e.at))}</div>` }).join('')}</div>`
    out += '</section>'
  }
  // 3. to do
  const mine = followUpsOf(s).filter((f) => f.phone === p.phone)
  const scheduled = mine.filter((f) => f.status === 'scheduled').sort(byDue)
  const finished = mine.filter((f) => f.status === 'done' || f.status === 'skipped').sort(byDueDesc)
  if (mine.length) {
    out += `<section class="panel-section"><h3 data-key="panel-todo" tabindex="-1">To do ${countHtml(scheduled.length)}</h3>`
    if (scheduled.length) out += `<div class="card rows">${scheduled.map((f) => fuRowHtml(f, s, { nameLink: false })).join('')}</div>`
    else out += `<p class="muted">Nothing to do for ${esc(first)} right now.</p>`
    if (finished.length) out += `<details class="done-list" data-key="done-panel"><summary data-key="done-panel-summary">${ico('chevron-down')}<span>Done and not needed</span>${countHtml(finished.length)}</summary><div class="card rows">${finished.map((f) => doneRowHtml(f, s)).join('')}</div></details>`
    out += '</section>'
  }
  // 4. tours
  const bookings = arr(p.bookings).filter((b) => b && b.slotId).sort((a, b) => (toTime(b.startsAt) ?? 0) - (toTime(a.startsAt) ?? 0))
  if (bookings.length) {
    const cal = s.calendar, calIds = new Set(arr(cal && cal.bookings).map((b) => b && b.slotId))
    out += `<section class="panel-section"><h3>Tours</h3><div class="card rows">${bookings.map((b) => {
      const st = String(b.status ?? '')
      const stuck = st === 'failed' || st === 'arranging'
      const c = st === 'confirmed' && cal && !calIds.has(b.slotId)
        ? chip('chip-info', 'info', 'No longer on the calendar')
        : chip(A.label(labels.bookingChip, st, 'chip-neutral'), A.label(labels.bookingIcon, st, 'calendar'), A.label(labels.bookingStatus, st))
      return `<div class="row row-2 tour-row${stuck ? ' row-warn' : ''}" data-key="tour:${esc(b.slotId)}"><span class="row-body">` +
        `<span class="row-title">${esc(fmt.day(b.startsAt))} · ${esc(fmt.time(b.startsAt))} · ${b.unitId ? `apartment ${esc(b.unitId)}` : 'no apartment picked yet'}</span>` +
        `<span class="row-chips">${c}</span>${stuck ? '<span class="row-sub">Call to set a time.</span>' : ''}</span>` +
        `<span class="row-actions">${link('calendar', { date: fmt.nyDate(b.startsAt) || undefined, slot: b.slotId }, 'See on calendar')}</span></div>`
    }).join('')}</div></section>`
  }
  // 5. what they're looking for
  const facts = lookingFor(p, s, recById)
  out += `<section class="panel-section"><h3>What they're looking for</h3>`
  if (facts.length) {
    out += `<dl class="facts">${facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}${f.unsure ? ' <span class="warn-text small">(not sure)</span>' : ''} — ` +
      (f.excerpt ? `<span class="quote">"${esc(f.excerpt)}"</span>` : '<span class="faint">(no quote saved)</span>') +
      (f.from ? ` <span class="faint small">(from the call ${esc(fmt.dateTime(f.from, { inSentence: true }))})</span>` : '') + '</dd>').join('')}</dl>`
  } else out += `<p class="muted">The assistant hasn't learned what they want yet.</p>`
  out += '</section>'
  // 6. apartments they were told about
  const units = arr(p.unitsDiscussed).filter((u) => u != null && String(u).trim())
  if (units.length) out += `<section class="panel-section"><h3>Apartments they were told about</h3><div class="chips">${units.map((u) => chip('chip-neutral', 'home', String(u))).join('')}</div></section>`
  // 7. why it might not work out
  const losses = arr(p.lossReasons).filter(Boolean)
  if (losses.length) {
    out += `<section class="panel-section"><h3>Why it might not work out</h3>${losses.map((r) => `<div class="loss"><div>${esc(derive.lossText(r))}</div>` +
      (r.evidence ? `<div class="quote">"${esc(r.evidence)}"</div>` : '') + `<div class="when">${esc(fmt.day(r.at))}</div></div>`).join('')}</section>`
  }
  // 8. calls
  const calls = arr(p.calls).filter((c) => c && c.callId != null).sort((a, b) => (toTime(b.at) ?? 0) - (toTime(a.at) ?? 0))
  if (calls.length) {
    out += `<section class="panel-section lead-calls"><h3>Calls ${countHtml(calls.length)}</h3>${calls.map((c) => {
      const rec = recById.get(String(c.callId))
      const rich = Boolean(rec && (rec.call || arr(rec.events).length))
      const sentence = rich ? derive.callStory(rec, s).sentence : derive.summarySentence(c.outcome)
      const dur = fmt.duration(c.durationSeconds)
      return `<div class="lcall"><div class="when num">${esc(fmt.dateTime((rec && rec.startedAt) || c.at))}${dur !== '—' ? ` · ${esc(dur)}` : ''}</div><div>${esc(sentence)}</div>` +
        `<div class="see">${rich ? link('calls', { id: String(c.callId) }, 'See the call', 'btn-link') : '<span class="faint">not in the last 20 calls</span>'}</div></div>`
    }).join('')}</section>`
  }
  // 9. notes
  const notes = arr(p.notes).map(parseNote).reverse()
  out += `<section class="panel-section lead-notes"><h3>Notes</h3>`
  if (notes.length) {
    out += `<ul class="notes">${notes.map((n) => {
      const stamp = n.stamp ? `<span class="stamp">${esc(fmt.dateTime(n.stamp))} — </span>` : ''
      const nm = nameNote(n.body)
      return nm != null ? `<li class="muted">${stamp}Set the name to "${esc(nm)}"</li>` : `<li>${stamp}${esc(n.body)}</li>`
    }).join('')}</ul>`
  } else out += `<p class="muted" style="margin-bottom:12px">No notes yet.</p>`
  if (hidden) out += `<p class="muted small">These callers' numbers were hidden, so there's nowhere to save a note.</p>`
  else {
    out += `<div class="note-form"><input class="input" type="text" maxlength="500" autocomplete="off" placeholder="${esc(notePlaceholder())}" aria-label="Add a note about ${esc(name)}" data-key="note:${esc(p.phone)}" data-phone="${esc(p.phone)}">` +
      `<button type="button" class="btn" data-action="savenote" data-phone="${esc(p.phone)}" data-key="notebtn:${esc(p.phone)}" data-write="leads" aria-disabled="true">Save note</button></div>` +
      `<p class="field-hint">Start with your initials so the team knows who wrote it.</p>`
  }
  out += '</section>'
  // 10. for support
  const pairs = [['Stage', String(p.stage ?? '')], ['Phone as stored', String(p.phone ?? '')], ['Email', String(p.email ?? '—')], ['First call', String(p.firstSeenAt ?? '')], ['Last call', String(p.lastSeenAt ?? '')]]
  for (const [k, e] of Object.entries(p.signals || {})) if (e && typeof e === 'object') pairs.push([`${text.humanise(k)} confidence`, `${Math.round(Number(e.confidence) * 100)}%`])
  for (const e of arr(p.escalations)) if (e) pairs.push(['Escalation', `${String(e.trigger ?? '')} · ${String(e.callId ?? '')} · ${String(e.at ?? '')}`])
  for (const b of bookings) pairs.push(['Booking', `${String(b.slotId)} · ${String(b.status ?? '')} · ${String(b.callId ?? '')}`])
  for (const c of calls) pairs.push(['Call id', `${String(c.callId)}${arr(c.toolsCalled).length ? ` · ${arr(c.toolsCalled).join(', ')}` : ''}`])
  out += `<details class="panel-section support" data-key="support"><summary>${ico('chevron-down')}For support</summary><dl class="facts">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`
  out += '</div>'
  return out
}

// ---------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------

const view = {
  title: 'Leads', icon: A.icons.leads,
  root: null, wrap: null, tabsEl: null, banners: null, noteEl: null, tools: null, search: null, chipsEl: null, split: null, list: null, panel: null,
  tab: 'todo', q: '', stage: 'all', openPhone: null,
  listHtml: null, listTab: null, panelHtml: null, bannerHtml: null,
  drafts: {}, saving: null, savedScroll: null, returnKey: null, focusPanel: false, closing: false, typing: null, warnedStale: new Set(),
  mount(root) {
    this.root = root
    root.innerHTML = `<div class="leads-view" data-tab="todo"><div class="view-head"><h1 tabindex="-1">Leads</h1></div>` +
      `<div class="leads-top"><div class="tabs" role="tablist" aria-label="Leads">` +
      TABS.map(([k, l], i) => `<button type="button" role="tab" class="tab" id="leads-tab-${k}" data-tab="${k}" data-key="tab:${k}" aria-selected="${i === 0 ? 'true' : 'false'}" aria-controls="leads-list" tabindex="${i === 0 ? '0' : '-1'}">${esc(l)}</button>`).join('') +
      `</div><div class="leads-banners"></div>` +
      `<p class="leads-note small muted" hidden>These are for you to do — the assistant doesn't make outgoing calls or send messages yet.</p>` +
      `<div class="leads-tools" hidden><label class="search"><span class="vh">Search by name, number or apartment</span>${ico('search')}<input type="search" data-key="search" placeholder="${esc(searchPlaceholder())}" aria-label="Search by name, number or apartment" autocomplete="off"></label>` +
      `<div class="chips" role="group" aria-label="Filter callers">${STAGES.map(([k, l]) => `<button type="button" class="chip-filter" data-stage="${k}" data-key="stage:${k}" aria-pressed="${k === 'all' ? 'true' : 'false'}">${ico('check')}<span>${esc(l)}</span></button>`).join('')}</div></div></div>` +
      `<div class="split leads-split"><div class="split-list leads-list" id="leads-list" role="tabpanel" aria-labelledby="leads-tab-todo" data-key="list"></div><div class="panel lead-panel" data-key="panel"></div></div></div>`
    this.wrap = root.querySelector('.leads-view'); this.tabsEl = root.querySelector('.tabs'); this.banners = root.querySelector('.leads-banners')
    this.noteEl = root.querySelector('.leads-note'); this.tools = root.querySelector('.leads-tools'); this.search = root.querySelector('input[data-key="search"]')
    this.chipsEl = root.querySelector('.chips'); this.split = root.querySelector('.split'); this.list = root.querySelector('.leads-list'); this.panel = root.querySelector('.lead-panel')
    // tabs: click, arrows, Home/End
    this.tabsEl.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) this.setTab(b.dataset.tab) })
    this.tabsEl.addEventListener('keydown', (e) => {
      const tabs = [...this.tabsEl.querySelectorAll('.tab')]
      const i = tabs.indexOf(document.activeElement)
      if (i < 0) return
      let n = null
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length
      else if (e.key === 'Home') n = 0
      else if (e.key === 'End') n = tabs.length - 1
      if (n == null) return
      e.preventDefault()
      tabs[n].focus()
      this.setTab(tabs[n].dataset.tab)
    })
    // search and chips
    this.search.addEventListener('input', () => {
      clearTimeout(this.typing)
      this.typing = setTimeout(() => { const v = this.search.value.trim(); if (v !== this.q) this.setParams({ q: v || undefined, tab: 'all' }, true) }, 150)
    })
    this.chipsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.chip-filter')
      if (!b || b.getAttribute('aria-disabled') === 'true') return
      this.setParams({ stage: b.dataset.stage === 'all' ? undefined : b.dataset.stage, tab: 'all' }, true)
    })
    // the list: rows, names, Done / Not needed / Put back, "See what's done"
    this.list.addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]')
      if (act && this.list.contains(act)) {
        if (act.getAttribute('aria-disabled') === 'true' || act.classList.contains('is-busy')) return
        const a = act.dataset.action
        if (a === 'open') this.open(act.dataset.phone, act)
        else if (a === 'seedone') { const d = this.list.querySelector('.done-list'); if (d) { d.open = true; const sm = d.querySelector('summary'); if (sm) { sm.setAttribute('tabindex', '0'); sm.focus() } } }
        else this.fuAction(act)
        return
      }
      const row = e.target.closest('.lead-row')
      if (row) { this.open(row.dataset.phone, row); return }
      // To do rows: the sentence (row body) opens the person too, not only the bold name — a click on a
      // link inside it (the phone, the email) keeps its own job.
      const body = e.target.closest('.todo-row .row-body')
      if (body && !e.target.closest('a')) { const nameBtn = body.querySelector('[data-action="open"]'); if (nameBtn) this.open(nameBtn.dataset.phone, nameBtn) }
    })
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const rows = [...this.list.querySelectorAll('.lead-row')]
      const i = rows.indexOf(document.activeElement)
      if (i < 0) return
      e.preventDefault()
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      rows.forEach((r) => r.setAttribute('tabindex', r === next ? '0' : '-1'))
      next.focus()
    })
    // the panel: close, names, notes, follow-ups
    this.panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]')
      if (!btn || !this.panel.contains(btn)) return
      if (btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('is-busy')) return
      const a = btn.dataset.action
      if (a === 'close') this.close()
      else if (a === 'setname') { const p = this.current(); if (p) this.setName(p, btn) }
      else if (a === 'usename') { const p = this.current(); if (p && btn.dataset.name) this.postName(p.phone, btn.dataset.name, btn) }
      else if (a === 'savenote') this.saveNote(btn.dataset.phone, btn)
      else this.fuAction(btn)
    })
    this.panel.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-phone]')
      if (!inp) return
      this.drafts[inp.dataset.phone] = inp.value
      this.paintNote(inp.dataset.phone)
    })
    this.panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const inp = e.target.closest('input[data-phone]')
      if (!inp) return
      e.preventDefault()
      this.saveNote(inp.dataset.phone, this.noteBtn(inp.dataset.phone))
    })
    // Esc closes the open panel when it is the page (stacked layout) or when focus is inside it (split);
    // focus goes back to the row or name that opened it (the closing path in render()).
    A.escape.push(() => { if (this.openPhone && !this.root.hidden && (!isSplit() || this.panel.contains(document.activeElement))) { this.close(); return true } return false })
    const repaint = () => { if (this.root && !this.root.hidden) this.render(A.state) }
    A.on('data', repaint); A.on('minute', repaint)
    A.on('busy', () => { if (this.root && !this.root.hidden) this.paintBusy() })
    let resizeTimer = null
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { this.search.placeholder = searchPlaceholder(); this.panelHtml = null; this.listHtml = null; repaint() }, 150) })
  },
  params() { return A.route().params },
  setParams(patch, replace) {
    const p = { ...this.params(), ...patch }
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k]
    A.navigate('leads', p, { replace })
  },
  setTab(tab) {
    if (!TABS.some(([k]) => k === tab)) return
    try { localStorage.setItem('atrium.leads.tab', tab) } catch (e) { /* a convenience only */ }
    this.setParams({ tab }, true)
  },
  current() { return this.openPhone ? profilesOf(A.state).find((p) => p.phone === this.openPhone) || null : null },
  open(phone, el) {
    if (!phone) return
    this.savedScroll = { list: this.list.scrollTop, page: window.scrollY }
    this.returnKey = el && el.dataset && el.dataset.key ? el.dataset.key : `lead:${phone}`
    this.focusPanel = true
    this.setParams({ phone }, false)
  },
  close() { this.closing = true; this.setParams({ phone: undefined }, true) },
  noteInput(phone) { return this.panel.querySelector(`input[data-key="${cssq(`note:${phone}`)}"]`) },
  noteBtn(phone) { return this.panel.querySelector(`[data-key="${cssq(`notebtn:${phone}`)}"]`) },
  /** Save note is disabled until a non-space character is typed; the busy state is the shell's. */
  paintNote(phone) {
    const btn = this.noteBtn(phone)
    if (!btn) return
    const on = Boolean(String(this.drafts[phone] || '').trim())
    if (on && !A.busyNow('leads')) btn.removeAttribute('aria-disabled'); else btn.setAttribute('aria-disabled', 'true')
    if (this.saving === phone) { btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true') }
  },
  paintBusy() {
    const on = A.busyNow('leads')
    for (const el of this.root.querySelectorAll('[data-write="leads"]')) {
      if (on) { if (!el.classList.contains('is-busy')) el.setAttribute('aria-disabled', 'true') }
      else if (el.dataset.action === 'savenote') this.paintNote(el.dataset.phone)
      else el.removeAttribute('aria-disabled')
    }
  },
  fuAction(btn) {
    const a = btn.dataset.action
    const fu = followUpsOf(A.state).find((f) => f.id === btn.dataset.fu)
    if (!fu) return
    if (a === 'done') A.setFollowUpStatus(fu, 'done', { button: btn })
    else if (a === 'skip') A.setFollowUpStatus(fu, 'skipped', { verb: 'not needed', button: btn })
    else if (a === 'back') A.setFollowUpStatus(fu, 'scheduled', { button: btn })
    else if (a === 'handled') A.setFollowUpStatus(fu, 'done', { verb: 'handled', button: btn })
  },
  reread() { return A.api.get('/api/leads').then((d) => { A.apply('leads', d) }, () => { /* the next poll will try again */ }) },
  async saveNote(phone, btn) {
    const input = this.noteInput(phone)
    const body = String(this.drafts[phone] || (input && input.value) || '').trim()
    if (!phone || !body || A.busyNow('leads') || this.saving) return
    this.saving = phone
    if (btn && btn.isConnected) { btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true') }
    if (input) input.readOnly = true
    try {
      const res = await A.busy('leads', A.api.post('/api/leads', { action: 'note', phone, text: body }, { doing: 'saving a note' }))
      this.saving = null
      this.drafts[phone] = ''
      A.apply('leads', res)
      A.toast('Note saved', { kind: 'ok', key: `note:${phone}` })
      const again = this.noteInput(phone)
      if (again) { again.value = ''; again.readOnly = false; try { again.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
      this.paintNote(phone)
    } catch (e) {
      this.saving = null
      if (e.signedOut) return
      if (btn && btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') }
      const again = this.noteInput(phone)
      if (again) again.readOnly = false
      this.paintNote(phone)
      if (e.status === 404) A.toast('This caller was removed by someone else. The list has been refreshed.', { kind: 'warn' })
      else A.toast("Couldn't save that note. Your text is still here — try again.", { kind: 'error', actions: [{ label: 'Try again', fn: () => { this.saveNote(phone, this.noteBtn(phone)) } }] })
      this.reread()
    }
  },
  async setName(p, btn) {
    const has = Boolean(p.name)
    const v = await A.prompt("What's their name?", { title: has ? 'Edit name' : 'Set name', placeholder: 'e.g. Dana W.', value: p.name || '', confirmLabel: 'Save name', required: true, maxLength: 120 })
    if (v == null || !String(v).trim()) return
    await this.postName(p.phone, String(v).trim(), btn)
  },
  async postName(phone, name, btn) {
    if (!phone || !name || A.busyNow('leads')) return
    if (btn && btn.isConnected) { btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true') }
    try {
      const res = await A.busy('leads', A.api.post('/api/leads', { action: 'note', phone, text: `name: ${name}` }, { doing: 'saving a name' }))
      A.apply('leads', res)
      A.toast('Name saved', { kind: 'ok', key: `name:${phone}` })
    } catch (e) {
      if (e.signedOut) return
      if (e.status === 404) A.toast('This caller was removed by someone else. The list has been refreshed.', { kind: 'warn' })
      else A.toast("Couldn't save that name. Nothing changed — try again.", { kind: 'error', actions: [{ label: 'Try again', fn: () => { this.postName(phone, name, null) } }] })
      this.reread()
    } finally { if (btn && btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') } }
  },
  render(s) {
    if (!this.root) return
    const p = this.params()
    let tab = TABS.some(([k]) => k === p.tab) ? p.tab : null
    if (!tab && (p.stage || p.q)) tab = 'all'
    if (!tab) { try { const v = localStorage.getItem('atrium.leads.tab'); if (TABS.some(([k]) => k === v)) tab = v } catch (e) { /* default */ } }
    this.tab = tab || 'todo'
    this.q = String(p.q || '').trim()
    this.stage = STAGES.some(([k]) => k === p.stage) ? p.stage : 'all'
    this.wrap.dataset.tab = this.tab
    const wantPhone = p.phone ? String(p.phone) : null
    const loaded = Boolean(s.loaded.leads)
    const profiles = profilesOf(s), fus = followUpsOf(s)
    if (document.activeElement !== this.search && this.search.value !== this.q) this.search.value = this.q
    // a phone that is not on the list: a stale link gets a toast; a panel that was open says so in place
    let gone = false
    if (wantPhone && loaded && !profiles.some((x) => x.phone === wantPhone)) {
      if (this.openPhone === wantPhone) gone = true
      else {
        if (!this.warnedStale.has(wantPhone)) { this.warnedStale.add(wantPhone); A.toast("That item isn't on the list any more.", { kind: 'info' }) }
        this.setParams({ phone: undefined }, true)
        return
      }
    }
    // tabs, note, tools
    const scheduledN = fus.filter((f) => f.status === 'scheduled').length
    for (const b of this.tabsEl.querySelectorAll('.tab')) {
      const k = b.dataset.tab, lbl = (TABS.find(([x]) => x === k) || [k, k])[1]
      const n = k === 'todo' ? scheduledN : profiles.length
      const txt = loaded ? `${lbl} · ${n}` : lbl
      if (b.textContent !== txt) b.textContent = txt
      b.setAttribute('aria-selected', k === this.tab ? 'true' : 'false')
      b.setAttribute('tabindex', k === this.tab ? '0' : '-1')
    }
    this.list.setAttribute('aria-labelledby', `leads-tab-${this.tab}`)
    this.noteEl.hidden = !(this.tab === 'todo' && loaded && s.leads && s.leads.outboundEnabled === false)
    this.tools.hidden = this.tab !== 'all'
    // banners
    let banners = ''
    if (s.errors.leads) banners += A.html.banner('warn', `We can't load callers right now.${loaded && s.lastGoodAt.leads ? ` Showing what we had at ${fmt.time(s.lastGoodAt.leads)}.` : ''}`)
    const store = s.leads && s.leads.store
    if (loaded && store && store.durable === false) banners += A.html.banner('warn', '', { raw: `<a href="#/status" style="color:inherit;text-decoration:none">Heads up: callers and to-dos aren't being saved right now. Anything you mark here may disappear. Ask Atrium support.</a>` })
    if (banners !== this.bannerHtml) { this.bannerHtml = banners; this.banners.innerHTML = banners }
    // the list
    let listHtml = ''
    if (!loaded && !s.errors.leads) listHtml = `<div class="skeleton" aria-busy="true" style="padding:12px"><span class="vh">Loading…</span><div class="skeleton-line"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`
    else if (!loaded) listHtml = ''
    else if (this.tab === 'todo') listHtml = todoListHtml(s)
    else {
      const ev = computeEveryone(s, this.q, this.stage)
      for (const b of this.chipsEl.querySelectorAll('.chip-filter')) {
        const k = b.dataset.stage, lbl = (STAGES.find(([x]) => x === k) || [k, k])[1]
        const txt = `${lbl} · ${ev.counts[k] || 0}`
        const span = b.querySelector('span:last-child')
        if (span.textContent !== txt) span.textContent = txt
        b.setAttribute('aria-pressed', k === this.stage ? 'true' : 'false')
        if (k !== 'all' && !ev.counts[k] && k !== this.stage) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled')
      }
      listHtml = everyoneListHtml(ev, s, this.q, this.stage, wantPhone && !gone ? wantPhone : null)
    }
    if (listHtml !== this.listHtml || this.listTab !== this.tab) {
      this.listHtml = listHtml; this.listTab = this.tab
      const focusKey = this.list.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key : null
      const wasOpen = new Set([...this.list.querySelectorAll('details[open]')].map((d) => d.dataset.key))
      const top = this.list.scrollTop
      this.list.innerHTML = listHtml
      for (const d of this.list.querySelectorAll('details')) if (wasOpen.has(d.dataset.key)) d.open = true
      this.list.scrollTop = top
      if (focusKey) { const el = this.list.querySelector(`[data-key="${cssq(focusKey)}"]`); if (el) { try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
    }
    // the panel
    const openRec = wantPhone && !gone ? profiles.find((x) => x.phone === wantPhone) || null : null
    const hasPanel = Boolean(openRec || gone)
    let panelHtml_
    if (gone) panelHtml_ = gonePanelHtml()
    else if (openRec) panelHtml_ = leadPanelHtml(openRec, s)
    else if (isSplit()) {
      // The placeholder names the gesture the tab offers, and says nothing when there is nobody to pick.
      const anyone = this.tab === 'todo' ? fus.some((f) => f.status === 'scheduled') : Boolean(this.list.querySelector('.lead-row'))
      panelHtml_ = anyone ? `<div class="panel-empty">${A.html.empty({ icon: 'leads', title: this.tab === 'todo' ? "Click a name to see what they're looking for." : "Pick someone to see what they're looking for." })}</div>` : ''
    } else panelHtml_ = ''
    this.split.classList.toggle('has-panel', hasPanel)
    this.wrap.classList.toggle('has-panel', hasPanel)
    if (panelHtml_ !== this.panelHtml) {
      const samePerson = hasPanel && this.openPhone === wantPhone
      const wasOpen = new Set([...this.panel.querySelectorAll('details[open]')].map((d) => d.dataset.key))
      const active = document.activeElement, inPanel = this.panel.contains(active)
      const focusKey = inPanel && active.dataset ? active.dataset.key : null
      const sel = inPanel && active.tagName === 'INPUT' && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null
      const top = this.panel.scrollTop
      this.panelHtml = panelHtml_
      this.panel.innerHTML = panelHtml_
      if (samePerson) { for (const d of this.panel.querySelectorAll('details')) if (wasOpen.has(d.dataset.key)) d.open = true; this.panel.scrollTop = top }
      const inp = this.panel.querySelector('input[data-phone]')
      if (inp) { inp.value = this.drafts[inp.dataset.phone] || ''; if (this.saving === inp.dataset.phone) inp.readOnly = true; this.paintNote(inp.dataset.phone) }
      if (focusKey) {
        const el = this.panel.querySelector(`[data-key="${cssq(focusKey)}"]`)
        if (el) { try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ } if (sel && el.tagName === 'INPUT') { try { el.setSelectionRange(sel[0], sel[1]) } catch (e) { /* ignore */ } } }
      }
    }
    const prevOpen = this.openPhone
    this.openPhone = hasPanel ? wantPhone : null
    if (hasPanel && this.focusPanel) {
      this.focusPanel = false
      const h2 = this.panel.querySelector('h2')
      if (h2) { try { h2.focus({ preventScroll: isSplit() }) } catch (e) { /* ignore */ } }
      if (!isSplit()) window.scrollTo({ top: 0, behavior: 'auto' })
    } else if (!hasPanel && prevOpen && this.closing) {
      this.closing = false
      const back = this.returnKey ? this.list.querySelector(`[data-key="${cssq(this.returnKey)}"]`) : null
      if (this.savedScroll) { this.list.scrollTop = this.savedScroll.list; window.scrollTo({ top: this.savedScroll.page, behavior: 'auto' }) }
      if (back) {
        if (back.classList.contains('lead-row')) for (const r of this.list.querySelectorAll('.lead-row')) r.setAttribute('tabindex', r === back ? '0' : '-1')
        try { back.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
      } else { const h1 = this.root.querySelector('h1'); if (h1) { try { h1.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
    }
    if (reduced()) { /* nothing animates here; the shell's reduced-motion rule covers the panel slide */ }
    this.paintBusy()
  },
  badge(s) { return derive.dueTodayCount(s) || null },
}
A.register('leads', view)
})()
