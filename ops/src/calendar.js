/*
 * Tour calendar view (brief §10). Owner: calendar. Registers 'calendar' on window.Atrium at
 * load; app.js boots on DOMContentLoaded after every module script ran, so this module is
 * mounted the first time #/calendar is shown. Constraint 7 holds throughout: the grid draws
 * exactly the slots /api/calendar returned, positioned by their New York minutes; slot ids and
 * times are never computed; merged bands are presentation only; every write targets a slotId
 * or a YYYY-MM-DD the API gave us. Nothing here calls fetch — Atrium.api/busy/apply only.
 *
 * Build note: scripts/build-ops.mjs splices this file in with String.prototype.replace, so a
 * dollar sign is only ever written here as part of a template expression.
 */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml
const { fmt, derive, text, href } = A
const ico = (n) => `<span class="ico">${A.icon(n)}</span>`
const cssq = (s) => (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, (c) => '\\' + c)
const arr = (v) => (Array.isArray(v) ? v : [])
const isMobile = () => matchMedia('(max-width: 959px)').matches
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const ROW_H = 40, HEAD_H = 76
const QUICK = ['Painting', 'Staff out', 'Maintenance', 'Holiday', 'Private showing']
const KEYS_HINT = 'Use the arrow keys to move, Enter to open, Shift + arrows to select a range.'

// ---------------------------------------------------------------------------------------
// Words — every date word comes from Atrium.fmt (New York); the hour label is an integer
// formatter for the gutter only (layout, not data).
// ---------------------------------------------------------------------------------------

const weekStart = (ymd) => fmt.addDays(ymd, -fmt.dayOfWeek(ymd))
const ymdNoon = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d, 12) }
const dayDiff = (a, b) => Math.round((ymdNoon(b) - ymdNoon(a)) / 86400000)
const longDay = (ymd) => fmt.dayLong(ymd).split(',')[0]
const shortDay = (ymd) => fmt.day(ymd).split(',')[0]
const monthDayNoYear = (ymd) => fmt.monthDay(ymd).split(',')[0]
const longMonthDay = (ymd) => fmt.dayLong(ymd).split(', ').slice(1).join(', ')
/** 'Thursday, Sep 10' (+ ', 2027' when not this year). */
const dayLabel = (ymd) => `${longDay(ymd)}, ${fmt.monthDay(ymd)}`
const hourLabel = (h) => { h = ((h % 24) + 24) % 24; return h === 0 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM` }
const clock = (iso) => fmt.time(iso).replace(/ [AP]M$/, '')
const toRange = (a, b) => fmt.timeRange(a, b).replace(' – ', ' to ')
/** The server's default word 'blocked', or an empty reason, is treated as no reason. A reason is a
 *  person's own words: shown as typed (escaped at render), never rewritten by text.staff(). */
function reasonOf(raw) { const r = String(raw ?? '').trim(); return !r || /^blocked$/i.test(r) ? '' : r }
function shortName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'Tour'
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`
}
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Tour'
const plural = (n, one, many) => text.plural(n, one, many)

// ---------------------------------------------------------------------------------------
// The model: slots → rows and columns, per-day items (open cells, tours, merged bands, day
// bands), header status, the pageable range and the old-blocks list.
// ---------------------------------------------------------------------------------------

function buildModel(s, opts) {
  const c = s.calendar
  const today = fmt.nyNow().ymd
  const rawSlots = c ? arr(c.slots) : []
  const blocks = c ? arr(c.blocks).filter((b) => b && b.target != null) : []
  const bookings = c ? arr(c.bookings).filter((b) => b && b.slotId != null) : []
  const slots = [], byId = new Map(), byDate = new Map()
  let lo = Infinity, hi = -Infinity, lastDate = null
  for (const raw of rawSlots) {
    if (!raw || raw.slotId == null) continue
    const ps = fmt.nyParts(raw.startsAt), pe = fmt.nyParts(raw.endsAt)
    if (!ps) continue
    const date = isYmd(raw.date) ? raw.date : ps.ymd
    const startMin = ps.minutes
    let endMin = pe ? pe.minutes + (pe.ymd !== ps.ymd ? 1440 : 0) : startMin + 30
    if (endMin <= startMin) endMin = startMin + 30
    const status = raw.status === 'booked' || raw.status === 'blocked' ? raw.status : 'open'
    const sl = {
      id: String(raw.slotId), date, startsAt: raw.startsAt, endsAt: raw.endsAt, startMin, endMin, status,
      rawReason: status === 'blocked' ? String((raw.block && raw.block.reason) ?? '') : '',
      reason: status === 'blocked' ? reasonOf(raw.block && raw.block.reason) : '',
      wholeDay: status === 'blocked' && Boolean(raw.block && raw.block.wholeDay),
      name: status === 'booked' ? String((raw.booking && raw.booking.prospectName) ?? '').trim() : '',
      unitId: status === 'booked' && raw.booking && raw.booking.unitId != null && raw.booking.unitId !== '' ? String(raw.booking.unitId) : null,
    }
    slots.push(sl); byId.set(sl.id, sl)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(sl)
    lo = Math.min(lo, startMin); hi = Math.max(hi, endMin)
    if (!lastDate || date > lastDate) lastDate = date
  }
  for (const list of byDate.values()) list.sort((a, b) => a.startMin - b.startMin)
  const minM = lo === Infinity ? 600 : Math.floor(lo / 60) * 60
  const maxM = hi === -Infinity ? 1140 : Math.max(minM + 60, Math.ceil(hi / 60) * 60)
  const rows = Math.round((maxM - minM) / 30)
  const rowOf = (sl) => Math.max(0, Math.min(rows - 1, Math.round((sl.startMin - minM) / 30)))
  const spanOf = (sl) => Math.max(1, Math.min(rows - rowOf(sl), Math.round((sl.endMin - sl.startMin) / 30)))
  const lastSlotDate = lastDate || today
  const firstWeek = weekStart(today)
  const lastWeek = weekStart(lastSlotDate > today ? lastSlotDate : today)
  const lastDay = fmt.addDays(lastWeek, 6)
  const mobile = isMobile()
  const view = mobile ? 'day' : (opts.view === 'day' ? 'day' : 'week')
  let date = isYmd(opts.date) ? opts.date : today
  if (date < firstWeek) date = firstWeek
  if (date > lastDay) date = lastDay
  const ws = weekStart(date)
  const days = view === 'week' ? [0, 1, 2, 3, 4, 5, 6].map((i) => fmt.addDays(ws, i)) : [date]
  const dayBlocks = new Map()
  for (const b of blocks) if (isYmd(b.target) && !dayBlocks.has(b.target)) dayBlocks.set(b.target, b)
  const bookingBySlot = new Map()
  for (const b of bookings) if (!bookingBySlot.has(String(b.slotId))) bookingBySlot.set(String(b.slotId), b)

  const tourItem = (sl) => ({ kind: 'tour', key: `tour:${sl.id}`, ymd: sl.date, slot: sl, slots: [sl], row: rowOf(sl), span: spanOf(sl) })
  /** Consecutive own-block slots with one reason inside a day band are one labelled segment (presentation only). */
  function mergeSegs(own, first) {
    const out = []
    for (const x of own) {
      const prev = out[out.length - 1]
      if (prev && prev.slot.rawReason === x.rawReason && x.startMin === prev.slots[prev.slots.length - 1].endMin) { prev.slots.push(x); prev.span += spanOf(x); continue }
      out.push({ slot: x, slots: [x], row: rowOf(x) - rowOf(first), span: spanOf(x) })
    }
    return out
  }
  function dayModel(ymd) {
    const list = byDate.get(ymd) || []
    const dayBlock = dayBlocks.get(ymd) || null
    const open = list.filter((x) => x.status === 'open'), tours = list.filter((x) => x.status === 'booked')
    const items = []
    if (dayBlock && list.length) {
      const first = list[0], last = list[list.length - 1]
      const blocked = list.filter((x) => x.status === 'blocked')
      items.push({
        kind: 'dayband', key: `dayband:${ymd}`, ymd, slots: blocked, first, last, row: rowOf(first), span: rowOf(last) + spanOf(last) - rowOf(first),
        reason: reasonOf(dayBlock.reason), block: dayBlock, tours: tours.length,
        segs: mergeSegs(blocked.filter((x) => !x.wholeDay), first),
      })
      for (const t of tours) items.push(tourItem(t))
    } else {
      let i = 0
      while (i < list.length) {
        const sl = list[i]
        if (sl.status === 'open') { items.push({ kind: 'open', key: `cell:${sl.id}`, ymd, slot: sl, slots: [sl], row: rowOf(sl), span: spanOf(sl) }); i++; continue }
        if (sl.status === 'booked') { items.push(tourItem(sl)); i++; continue }
        const run = [sl]
        let j = i + 1
        while (j < list.length && list[j].status === 'blocked' && list[j].rawReason === sl.rawReason && list[j].wholeDay === sl.wholeDay && list[j].startMin === list[j - 1].endMin) { run.push(list[j]); j++ }
        const last = run[run.length - 1]
        items.push({ kind: 'band', key: `band:${sl.id}`, ymd, slots: run, first: sl, last, row: rowOf(sl), span: rowOf(last) + spanOf(last) - rowOf(sl), reason: sl.reason, rawReason: sl.rawReason, wholeDay: sl.wholeDay })
        i = j
      }
    }
    items.sort((a, b) => a.row - b.row || (a.kind === 'dayband' ? -1 : b.kind === 'dayband' ? 1 : 0))
    const stops = items.filter((x) => x.kind !== 'tour' || true).slice().sort((a, b) => a.row - b.row)
    let status
    if (ymd < today) status = { text: 'Past', kind: 'past', sr: 'past' }
    else if (dayBlock) { const r = reasonOf(dayBlock.reason); status = { text: r ? `Blocked · ${r}` : 'Blocked', kind: 'blocked', sr: `blocked all day${r ? `, ${r}` : ''}` } }
    else if (ymd === today && !open.length && !tours.length) status = { text: 'No more times today', kind: 'none', sr: 'no more times today' }
    else if (list.length && !open.length && tours.length) status = { text: 'Fully booked', kind: 'full', sr: `fully booked, ${plural(tours.length, 'tour')}` }
    else if (ymd > lastSlotDate) status = { text: 'Not open yet', kind: 'none', sr: 'not open yet' }
    else if (!list.length) status = { text: 'Closed', kind: 'none', sr: 'closed' }
    else status = { text: `${open.length} open${tours.length ? ` · ${plural(tours.length, 'tour')}` : ''}`, kind: 'open', sr: `${plural(open.length, 'open time')}${tours.length ? `, ${plural(tours.length, 'tour')}` : ''}` }
    const operable = ymd < today ? null : dayBlock ? 'blocked' : list.length ? 'block' : null
    return { ymd, list, open, tours, dayBlock, items, stops, status, operable, hasBlock: Boolean(dayBlock) || list.some((x) => x.status === 'blocked') }
  }
  const dayModels = days.map(dayModel)
  const old = blocks.filter((b) => (isYmd(b.target) ? b.target < today : !byId.has(String(b.target))))
  return {
    loaded: Boolean(c), today, slots, byId, byDate, blocks, bookings, bookingBySlot, dayBlocks, minM, maxM, rows, rowOf, spanOf,
    lastSlotDate, hasSlots: slots.length > 0, firstWeek, lastWeek, lastDay, mobile, view, date, weekStart: ws, days, dayModels, dayModel, old,
    nowMin: fmt.nyNow().minutes,
  }
}

/** The lead join for a booked slot (never prospectPhone — contract §5.4). */
function tourInfo(s, m, sl) {
  const booking = m.bookingBySlot.get(sl.id) || null
  let profile = null, lb = null
  for (const p of arr(s.leads && s.leads.profiles)) {
    const b = arr(p && p.bookings).find((x) => x && x.slotId === sl.id)
    if (b) { profile = p; lb = b; if (b.status === 'confirmed') break }
  }
  const rawCallId = (lb && lb.callId) || (booking && String(booking.externalId ?? '').split('|')[1]) || null
  const callId = rawCallId && derive.callRecords(s).some((r) => r.id === rawCallId) ? rawCallId : null
  return {
    name: sl.name || (profile && profile.name) || 'Tour', profile, phone: profile && profile.phone !== 'unknown' ? profile.phone : null,
    email: (profile && profile.email) || null, unitId: sl.unitId != null ? sl.unitId : (lb && lb.unitId != null ? String(lb.unitId) : null),
    bookedAt: booking ? booking.bookedAt : null, callId,
  }
}

/** Range label + live-region sentence for the toolbar (§10.2). */
function rangeText(m) {
  if (m.view === 'day') {
    const diff = dayDiff(m.today, m.date)
    const when = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : ''
    return { when, range: fmt.day(m.date), live: `Showing ${fmt.dayLong(m.date)}` }
  }
  const s = m.weekStart, e = fmt.addDays(s, 6)
  const [sm, sd] = monthDayNoYear(s).split(' '), [em, ed] = monthDayNoYear(e).split(' ')
  const ey = e.slice(0, 4), cy = m.today.slice(0, 4)
  let range = sm === em && s.slice(0, 4) === ey ? `${sm} ${sd} – ${ed}` : `${sm} ${sd} – ${em} ${ed}`
  if (ey !== cy) range += `, ${ey}`
  const when = s === m.firstWeek ? 'This week' : s === fmt.addDays(m.firstWeek, 7) ? 'Next week' : ''
  const [lsm, lsd] = longMonthDay(s).split(' '), [lem, led] = longMonthDay(e).split(' ')
  const longRange = lsm === lem ? `${lsm} ${lsd} to ${led}` : `${lsm} ${lsd} to ${lem} ${led}`
  return { when, range, live: `Showing ${when ? `${when.toLowerCase()}, ` : ''}${longRange}${ey !== cy ? `, ${ey}` : ''}` }
}

/** Screen-reader label of a grid item. */
function itemLabel(m, it) {
  const day = fmt.dayLong(it.ymd)
  if (it.kind === 'open') return `${day}, ${fmt.time(it.slot.startsAt)}, open. ${cal.slotBlocksFail ? 'Block this day' : 'Block this time'}`
  if (it.kind === 'tour') return `${day}, ${fmt.time(it.slot.startsAt)}, tour with ${it.slot.name || 'a caller'}${it.slot.unitId ? `, apartment ${it.slot.unitId}` : ''}, confirmed`
  if (it.kind === 'band') return `${day}, blocked ${it.slots.length > 1 ? toRange(it.first.startsAt, it.last.endsAt) : fmt.time(it.first.startsAt)}${it.reason ? `, ${it.reason}` : ''}. Reopen`
  return `${day}, blocked all day${it.reason ? `, ${it.reason}` : ''}. Reopen ${longDay(it.ymd)}`
}

// ---------------------------------------------------------------------------------------
// Module state (§10.1) — data truth is always Atrium.state; this is view state only.
// ---------------------------------------------------------------------------------------

const cal = {
  root: null, view: 'week', sel: null, pop: null, focusKey: null, focusDate: null, sig: null, model: null,
  scrolled: false, keysShown: false, pendingSlot: null, drag: null, warnedStale: new Set(), sheet: null,
  lastLive: 0, liveTimer: null, parts: {}, inert: false, kbd: false, lastView: null,
  // slotBlocksFail: set for the rest of the session the first time the server answers a slot-level block
  // with its known 400 (contract §5.1 — the handler only accepts whole days today). While set, the sheet
  // opens on All day with the reason said inline, cells stop promising "+ Block", and a slot reopen
  // offers no Undo it could not honour. picked: the ?date= a link arrived with, marked in the week header.
  // focusBy: who last set the roving tab stop ('kbd' | 'mouse'), so Tab into the grid lands per §10.7.
  slotBlocksFail: false, picked: null, pickedShown: null, wasCalendar: false, focusBy: null, entering: false,
}
try { const v = localStorage.getItem('atrium.calendar.view'); if (v === 'day' || v === 'week') cal.view = v } catch (e) { /* no local state */ }

/** The polite live region, never more than once per 2 s (the latest sentence wins). */
function say(msg) {
  const now = Date.now(), wait = 2000 - (now - cal.lastLive)
  clearTimeout(cal.liveTimer)
  if (wait <= 0) { cal.lastLive = now; A.announce(msg); return }
  cal.liveTimer = setTimeout(() => { cal.lastLive = Date.now(); A.announce(msg) }, wait)
}

// ---------------------------------------------------------------------------------------
// HTML — everything from the API or a person passes through esc()
// ---------------------------------------------------------------------------------------

function stripHtml(s, m) {
  const tours = derive.toursOn(s, m.today)
  if (!tours.length) return '<p class="cal-today-strip">Today: no tours.</p>'
  const items = tours.map((t) => {
    const name = t.profile && href.tel(t.phone) !== null ? `<a href="${esc(A.hashFor('leads', { phone: t.phone }))}">${esc(t.name)}</a>` : esc(t.name)
    return `<span class="cal-strip-item${t.past ? ' is-past' : ''}"><span class="num">${esc(fmt.time(t.startsAt))}</span> ${name}${t.unitId ? ` (${esc(t.unitId)})` : ''}</span>`
  })
  return `<p class="cal-today-strip">Today: ${esc(plural(tours.length, 'tour'))} — ${items.join(' · ')}</p>`
}

function bannersHtml(s, m) {
  if (s.notConfigured) return ''
  let out = ''
  const store = s.calendar && s.calendar.store
  if (m.loaded && store && store.durable === false) {
    out += A.html.banner('warn', '', { raw: '<a class="banner-link" href="#/status">Heads up: calendar changes aren\'t being saved right now. Blocks you add may disappear. Ask Atrium support.</a>' })
  }
  const err = s.errors.calendar
  if (err && m.loaded) out += A.html.banner('info', `Showing the calendar as of ${s.lastGoodAt.calendar ? fmt.time(s.lastGoodAt.calendar) : 'a moment ago'} — trying to reconnect.`)
  else if (err && !m.loaded) out += A.html.banner('warn', "We can't reach the calendar right now, so this may look emptier than it is. Hold off on changes until it's back.")
  return out
}

const navBtn = (action, label, disabled) => `<button type="button" class="btn-icon" data-action="${action}" data-key="${action}" aria-label="${esc(label)}"${disabled ? ' aria-disabled="true"' : ''}>${A.icon(action === 'prev' ? 'chevron-left' : 'chevron-right')}</button>`
const dis = (on) => (on ? ' aria-disabled="true"' : '')

function toolbarHtml(m) {
  const rt = rangeText(m)
  const unit = m.view === 'week' ? 'week' : 'day'
  const prevOff = m.view === 'week' ? m.weekStart <= m.firstWeek : m.date <= m.firstWeek
  const nextOff = m.view === 'week' ? m.weekStart >= m.lastWeek : m.date >= m.lastDay
  const busy = A.busyNow('calendar') || cal.inert
  return `<div class="cal-toolbar"><div class="cal-nav">${navBtn('prev', `Previous ${unit}`, prevOff)}<button type="button" class="btn" data-action="today" data-key="today">Today</button>${navBtn('next', `Next ${unit}`, nextOff)}</div>` +
    `<h2 class="cal-range" aria-live="polite" data-key="range">${rt.when ? `<span class="cal-range-when">${esc(rt.when)} · </span>` : ''}${esc(rt.range)}</h2><span class="cal-spacer"></span>` +
    `<div class="cal-tools"><div class="seg cal-seg" role="radiogroup" aria-label="Layout"><button type="button" class="tab" role="radio" aria-checked="${m.view === 'week' ? 'true' : 'false'}" data-action="view-week" data-key="view-week">Week</button><button type="button" class="tab" role="radio" aria-checked="${m.view === 'day' ? 'true' : 'false'}" data-action="view-day" data-key="view-day">Day</button></div>` +
    `<button type="button" class="btn btn-primary" data-action="block" data-key="block" data-write="calendar"${dis(busy)}>Block time…</button>` +
    `<button type="button" class="btn-icon" data-action="more" data-key="more" aria-label="More calendar actions" aria-haspopup="dialog" data-write="calendar"${dis(busy)}>${A.icon('more')}</button></div></div>` +
    `<div class="cal-progress"${A.busyNow('calendar') ? '' : ' hidden'}></div>`
}

function itemHtml(m, it, col) {
  const r = it.row, isHour = (m.minM + r * 30) % 60 === 0
  const place = `grid-row:${r + 2} / span ${it.span};grid-column:${col}`
  const common = `data-key="${esc(it.key)}" data-date="${esc(it.ymd)}" data-row="${r}" data-col="${col - 2}" data-kind="${it.kind}"`
  if (it.kind === 'open') {
    const sel = cal.sel && cal.sel.date === it.ymd && cal.sel.slotIds.includes(it.slot.id)
    let caption = ''
    if (sel && cal.sel.slotIds[0] === it.slot.id) {
      const first = m.byId.get(cal.sel.slotIds[0]), last = m.byId.get(cal.sel.slotIds[cal.sel.slotIds.length - 1])
      if (first && last) caption = `<span class="cal-sel-caption" aria-hidden="true">${esc(fmt.timeRange(first.startsAt, last.endsAt))} · ${esc(plural(cal.sel.slotIds.length, 'time'))}</span>`
    }
    const lastCol = col === m.days.length + 1 && m.days.length > 1 // the caption hangs leftwards there, or the scroll box would clip it
    return `<button type="button" class="cal-cell cal-open${isHour ? '' : ' is-half'}${lastCol ? ' cal-last-col' : ''}" role="gridcell" aria-colindex="${col}" ${common} data-slot="${esc(it.slot.id)}" tabindex="-1" aria-label="${esc(itemLabel(m, it))}" aria-selected="${sel ? 'true' : 'false'}" style="${place}">${caption}${cal.slotBlocksFail ? '' : '<span class="cal-plus" aria-hidden="true">+ Block</span>'}</button>`
  }
  if (it.kind === 'tour') {
    const sl = it.slot, past = (Date.parse(sl.startsAt) || 0) < Date.now()
    const over = m.dayBlocks.has(it.ymd)
    const full = m.view === 'day'
      ? `${sl.name || 'Tour'}${sl.unitId ? ` · apartment ${sl.unitId}` : ''} · ${fmt.timeRange(sl.startsAt, sl.endsAt)}`
      : `${clock(sl.startsAt)} ${shortName(sl.name)}${sl.unitId ? ` · ${sl.unitId}` : ''}`
    const short = m.view === 'day' ? full : `${clock(sl.startsAt)} ${firstName(sl.name)}`
    return `<div class="cal-cell cal-slot${isHour ? '' : ' is-half'}${over ? ' is-over' : ''}" role="presentation" style="${place}">` +
      `<button type="button" class="cal-tour${past ? ' is-past' : ''}" role="gridcell" aria-colindex="${col}" ${common} data-slot="${esc(sl.id)}" tabindex="-1" aria-label="${esc(itemLabel(m, it))}">${ico('person')}<span class="cal-ev-text"><span class="cal-ev-name-full">${esc(full)}</span><span class="cal-ev-name-short">${esc(short)}</span></span></button></div>`
  }
  // band or dayband
  const n = it.span
  const topSegs = it.kind === 'dayband' ? it.segs.filter((sg) => sg.row === 0) : []
  const nextSeg = it.kind === 'dayband' ? it.segs.find((sg) => sg.row > 0) : null
  const linesFor = (rows) => Math.max(2, Math.min(6, Math.floor((rows * ROW_H - 8) / 15)))
  const lines = nextSeg ? Math.max(1, Math.min(linesFor(n), linesFor(nextSeg.row))) : linesFor(n)
  let words
  if (it.kind === 'dayband') words = `Blocked all day${it.reason ? ` · ${it.reason}` : ''}${topSegs.map((sg) => `\n· ${sg.slot.reason || 'Blocked'}`).join('')}`
  else if (it.slots.length > 1) words = `Blocked ${fmt.timeRange(it.first.startsAt, it.last.endsAt)}${it.reason ? (n >= 2 ? '\n' : ' · ') + it.reason : ''}`
  else words = `Blocked${it.reason ? ` · ${it.reason}` : ''}`
  let hits = ''
  for (let i = 0; i < n; i++) hits += i === 0
    ? `<div class="cal-band-hit" role="gridcell" aria-colindex="${col}" aria-rowspan="${n}" tabindex="-1" aria-label="${esc(itemLabel(m, it))}" style="top:0"></div>`
    : `<div class="cal-band-hit" aria-hidden="true" style="top:${i * ROW_H}px"></div>`
  const segs = it.kind === 'dayband' ? it.segs.map((sg) => `<div class="cal-band-seg" aria-hidden="true" style="top:${sg.row * ROW_H}px;height:${sg.span * ROW_H}px" data-seg="${esc(sg.slot.id)}">${sg.row === 0 ? '' : `<span class="cal-band-words">· ${esc(sg.slot.reason || 'Blocked')}</span>`}</div>`).join('') : ''
  const slotList = it.slots.map((x) => x.id).join(' ')
  return `<div class="cal-cell cal-slot${isHour ? '' : ' is-half'}" role="presentation" style="${place}">` +
    `<div class="cal-band${n >= 2 ? ' is-tall' : ''}" ${common} data-slots="${esc(slotList)}" style="--cal-lines:${lines}"><span class="cal-band-text">${ico('slash')}<span class="cal-band-words">${esc(words).replace(/\n/g, '<br>')}</span></span>${segs}${hits}</div></div>`
}

function gridHtml(m) {
  const cols = m.days.length
  let label
  if (m.view === 'week') {
    const [sm, sd] = longMonthDay(m.weekStart).split(' '), [em, ed] = longMonthDay(fmt.addDays(m.weekStart, 6)).split(' ')
    label = `Tour calendar, week of ${sm === em ? `${sm} ${sd} to ${ed}` : `${sm} ${sd} to ${em} ${ed}`}`
  } else label = `Tour calendar, ${fmt.dayLong(m.date)}`
  let out = `<div class="cal-grid" role="grid" aria-label="${esc(label)}" aria-rowcount="${m.rows + 1}" aria-colcount="${cols + 1}" aria-describedby="cal-keys-hint" style="--cal-cols:${cols};--cal-rows:${m.rows}">`
  out += '<div role="row" aria-rowindex="1" style="display:contents"><div class="cal-corner" role="columnheader" aria-colindex="1" aria-label="Time" style="grid-row:1;grid-column:1"></div>'
  m.dayModels.forEach((d, i) => {
    const isToday = d.ymd === m.today, col = i + 2
    const isPicked = cal.pickedShown === d.ymd
    const kindCls = d.status.kind === 'blocked' ? ' is-blocked' : (d.status.kind === 'open' && d.tours.length ? ' is-ok' : '')
    const inner = `<span class="cal-wd">${esc(shortDay(d.ymd))}</span><span class="cal-dn num">${Number(d.ymd.slice(8, 10))}</span><span class="cal-ds${kindCls}">${d.status.kind === 'blocked' ? ico('slash') : ''}${esc(d.status.text)}</span>`
    const label_ = `${fmt.dayLong(d.ymd)}, ${d.status.sr}${isPicked ? ', the day you picked' : ''}`
    const common = `role="columnheader" aria-colindex="${col}" data-key="day:${esc(d.ymd)}" data-date="${esc(d.ymd)}" data-col="${i}" style="grid-row:1;grid-column:${col}"${isToday ? ' aria-current="date"' : ''}${isPicked ? ' aria-selected="true"' : ''}`
    const cls = `cal-dayhead${isPicked ? ' is-picked' : ''}`
    if (d.operable) out += `<button type="button" class="${cls}" ${common} data-kind="head" data-op="${d.operable}" tabindex="-1" aria-label="${esc(`${label_}. ${d.operable === 'block' ? 'Block the whole day' : 'Open the details'}`)}">${inner}</button>`
    else out += `<div class="${cls}" ${common} aria-label="${esc(label_)}">${inner}</div>`
  })
  out += '</div>'
  const covered = m.dayModels.map((d) => { const c = new Array(m.rows).fill(false); for (const it of d.items) for (let r = it.row; r < Math.min(m.rows, it.row + it.span); r++) c[r] = true; return c })
  const starts = m.dayModels.map((d) => { const map = new Map(); for (const it of d.items) { if (!map.has(it.row)) map.set(it.row, []); map.get(it.row).push(it) } return map })
  for (let r = 0; r < m.rows; r++) {
    const min = m.minM + r * 30, isHour = min % 60 === 0
    const gl = isHour ? hourLabel(min / 60) : hourLabel(Math.floor(min / 60)).replace(' ', ':30 ')
    out += `<div role="row" aria-rowindex="${r + 2}" style="display:contents"><div class="cal-gutter ${isHour ? 'is-hour' : 'is-half'}" role="rowheader" aria-colindex="1" aria-label="${esc(gl)}" style="grid-row:${r + 2};grid-column:1">${isHour ? `<span class="num">${esc(gl)}</span>` : ''}</div>`
    m.dayModels.forEach((d, i) => {
      const col = i + 2
      for (const it of (starts[i].get(r) || [])) out += itemHtml(m, it, col)
      if (!covered[i][r]) out += `<div class="cal-cell cal-na${isHour ? '' : ' is-half'}" aria-hidden="true" style="grid-row:${r + 2};grid-column:${col}"></div>`
    })
    out += '</div>'
  }
  out += nowHtml(m)
  return out + '</div>'
}

function nowHtml(m) {
  const col = m.days.indexOf(m.today)
  const nowMin = fmt.nyNow().minutes
  if (col < 0 || nowMin < m.minM || nowMin >= m.maxM) return ''
  const row = Math.floor((nowMin - m.minM) / 30), off = Math.round(((nowMin - m.minM) % 30) / 30 * ROW_H)
  return `<div class="cal-now-faint" aria-hidden="true" style="grid-row:${row + 2};grid-column:2 / -1;transform:translateY(${off}px)"></div>` +
    `<div class="cal-now" aria-hidden="true" style="grid-row:${row + 2};grid-column:${col + 2};transform:translateY(${off}px)"></div>`
}

function agendaHtml(m) {
  const d = m.dayModels[0]
  const diff = dayDiff(m.today, d.ymd)
  const when = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : ''
  let out = `<div class="cal-agenda-head"><div class="cal-agenda-nav">${navBtn('prev', 'Previous day', m.date <= m.firstWeek)}` +
    `<h2 class="cal-range" aria-live="polite" data-key="range">${esc(fmt.day(d.ymd))}${when ? ` <span class="cal-range-when">· ${when}</span>` : ''}</h2>${navBtn('next', 'Next day', m.date >= m.lastDay)}</div>`
  out += '<div class="cal-strip" role="group" aria-label="Days this week">'
  for (let i = 0; i < 7; i++) {
    const ymd = fmt.addDays(m.weekStart, i), dm = m.dayModel(ymd)
    const tours = dm.tours.length
    const label = `${longDay(ymd)} ${Number(ymd.slice(8, 10))}${tours ? `, ${plural(tours, 'tour')}` : ''}${dm.hasBlock ? ', blocked time' : ''}${ymd === m.today ? ', today' : ''}`
    out += `<button type="button" class="cal-strip-day${ymd === m.today ? ' is-today' : ''}${ymd < m.today ? ' is-past' : ''}" data-action="strip" data-date="${esc(ymd)}" data-key="strip:${esc(ymd)}" aria-pressed="${ymd === d.ymd ? 'true' : 'false'}" aria-label="${esc(label)}">` +
      `<span class="cal-wd" aria-hidden="true">${esc(shortDay(ymd).slice(0, 1))}</span><span class="cal-dn num">${Number(ymd.slice(8, 10))}</span><span class="cal-marks" aria-hidden="true">${'<span class="cal-dot"></span>'.repeat(Math.min(3, tours))}${dm.hasBlock ? '<span class="cal-dash"></span>' : ''}</span></button>`
  }
  out += '</div></div>'
  const inert = (txt, lead) => `<div class="row cal-arow is-inert"><span class="row-lead num">${esc(lead || '')}</span><span class="row-body">${esc(txt)}</span></div>`
  const arow = (cls, lead, body, attrs, label) => `<button type="button" class="row row-click cal-arow ${cls}" ${attrs} aria-label="${esc(label)}"><span class="row-lead num"><span class="row-lead-bar">${esc(lead)}</span></span><span class="row-body">${body}</span><span class="cal-chev" aria-hidden="true">${ico('chevron-right')}</span></button>`
  const rows = []
  if (d.ymd < m.today) rows.push(inert('Past — not offered'))
  else if (d.ymd > m.lastSlotDate && !d.dayBlock) rows.push(inert(`Not open yet — the assistant offers tour times through ${fmt.day(m.lastSlotDate)}.`))
  else {
    // "Earlier today" exists only once the day's first listed time has passed; before that (at
    // midnight, say) nothing has been withheld and the row would claim otherwise.
    if (d.ymd === m.today) { if (!d.list.length) rows.push(inert('No more times today')); else if (m.nowMin >= d.list[0].startMin) rows.push(inert('Earlier today · Not offered')) }
    else if (!d.list.length && !d.dayBlock) rows.push(inert('Closed'))
    if (d.dayBlock && !d.list.length) rows.push(arow('is-blocked', 'All day', `${ico('slash')}<span>Blocked all day${d.items.length && d.items[0].reason ? ` · ${esc(d.items[0].reason)}` : (reasonOf(d.dayBlock.reason) ? ` · ${esc(reasonOf(d.dayBlock.reason))}` : '')}</span>`, `data-action="agenda-day" data-date="${esc(d.ymd)}" data-key="dayband:${esc(d.ymd)}"`, `Blocked all day${reasonOf(d.dayBlock.reason) ? `, ${reasonOf(d.dayBlock.reason)}` : ''}. Open the details`))
    const items = d.items.slice().sort((a, b) => a.row - b.row)
    let i = 0
    while (i < items.length) {
      const it = items[i]
      if (it.kind === 'open') {
        const run = [it]
        let j = i + 1
        while (j < items.length && items[j].kind === 'open' && items[j].slot.startMin === run[run.length - 1].slot.endMin) { run.push(items[j]); j++ }
        const first = run[0].slot, last = run[run.length - 1].slot
        const times = run.map((x) => fmt.time(x.slot.startsAt)).join(', ')
        rows.push(arow('is-open', fmt.timeRange(first.startsAt, last.endsAt), `<span>Open</span><span class="cal-ar-count">· ${esc(plural(run.length, 'time'))}</span>`,
          `data-action="agenda-open" data-first="${esc(first.id)}" data-last="${esc(last.id)}" data-key="open:${esc(first.id)}"`,
          `${fmt.timeRange(first.startsAt, last.endsAt)}, open, ${plural(run.length, 'time')}: ${times}. ${cal.slotBlocksFail ? 'Block this day' : 'Block these times'}`))
        i = j
      } else if (it.kind === 'tour') {
        const sl = it.slot
        rows.push(arow('is-tour', fmt.timeRange(sl.startsAt, sl.endsAt), `${ico('person')}<span>${esc(sl.name || 'Tour')}</span>${sl.unitId ? `<span class="cal-ar-sub">· apartment ${esc(sl.unitId)}</span>` : ''}<span class="cal-ar-sub">· Confirmed</span>`,
          `data-action="agenda-tour" data-slot="${esc(sl.id)}" data-key="tour:${esc(sl.id)}"`, `${fmt.timeRange(sl.startsAt, sl.endsAt)}, tour with ${sl.name || 'a caller'}${sl.unitId ? `, apartment ${sl.unitId}` : ''}, confirmed. Open the details`))
        i++
      } else {
        const lead = it.kind === 'dayband' ? fmt.timeRange(it.first.startsAt, it.last.endsAt) : (it.slots.length > 1 ? fmt.timeRange(it.first.startsAt, it.last.endsAt) : fmt.time(it.first.startsAt))
        const words = it.kind === 'dayband' ? 'Blocked all day' : 'Blocked'
        rows.push(arow('is-blocked', lead, `${ico('slash')}<span>${esc(words)}${it.reason ? ` · ${esc(it.reason)}` : ''}</span>`,
          `data-action="agenda-band" data-key="${esc(it.key)}"`, `${itemLabel(m, it).replace(/^[^,]+, /, '')}`))
        i++
      }
    }
  }
  out += `<div class="cal-agenda-rows"><div class="card rows">${rows.join('')}</div></div>`
  return out
}

function footHtml(m) {
  let out = '<div class="cal-foot">'
  out += `<div class="cal-legend" role="list" aria-label="Legend"><span class="muted" aria-hidden="true">Legend:</span>` +
    `<span class="cal-lg" role="listitem"><span class="cal-sw" aria-hidden="true"></span>Open</span>` +
    `<span class="cal-lg" role="listitem"><span class="cal-sw cal-sw-na" aria-hidden="true"></span>Not offered (past, or outside tour hours)</span>` +
    `<span class="cal-lg cal-lg-tour" role="listitem"><span class="cal-sw cal-sw-tour" aria-hidden="true"></span>${ico('person')}Tour</span>` +
    `<span class="cal-lg cal-lg-blocked" role="listitem"><span class="cal-sw cal-sw-blocked" aria-hidden="true"></span>${ico('slash')}Blocked</span></div>`
  if (m.hasSlots) out += `<p class="cal-through small">The assistant offers tour times through ${esc(fmt.day(m.lastSlotDate))}.</p>`
  if (m.old.length) {
    const n = m.old.length, allDates = m.old.every((b) => isYmd(b.target))
    const desc = (b) => `${monthDayNoYear(b.target)}${reasonOf(b.reason) ? ` · ${reasonOf(b.reason)}` : ''}`
    let line
    if (allDates && n === 1) line = `1 block is on a day that's already passed (${desc(m.old[0])}) —`
    else if (allDates) line = `${n} blocks are on days that have already passed (${m.old.map(desc).join(', ')}) —`
    else line = n === 1 ? "1 block is on a time that's no longer offered —" : `${n} blocks are on times that are no longer offered —`
    out += `<div class="cal-old"><span>${esc(line)}</span><button type="button" class="btn btn-quiet" data-action="remove-old" data-key="remove-old" data-write="calendar"${dis(A.busyNow('calendar') || cal.inert)}>Remove old blocks</button></div>`
  }
  out += `<p class="cal-hint small${cal.keysShown && !m.mobile ? '' : ' vh'}" id="cal-keys-hint">${KEYS_HINT}</p>`
  return out + '</div>'
}

const skeletonHtml = () => `<div class="cal-skeleton" aria-busy="true"><span class="vh">Loading the calendar…</span><div class="cal-sk-col"><div class="skeleton-line"></div></div>${'<div class="cal-sk-col"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>'.repeat(7)}</div>`
const emptyHtml = () => `<div class="cal-empty-card">${A.html.empty({ icon: 'calendar', title: 'No tour times to show.', text: 'The assistant only offers times during tour hours and at least a couple of hours out. As soon as some are open they appear here.' })}</div>`

// ---------------------------------------------------------------------------------------
// Writes (§10.5, §10.6, §12.2) — every one inside Atrium.busy('calendar', …), painted from
// the server's response through Atrium.apply, re-read after any failure.
// ---------------------------------------------------------------------------------------

const post = (body, doing) => A.api.post('/api/calendar', body, { doing })
const signedOut = (e) => Boolean(e && e.signedOut)
function reread() { return A.api.get('/api/calendar').then((d) => { A.apply('calendar', d) }, () => { /* the poll will try again */ }) }
const isKnown400 = (e) => Boolean(e) && e.status === 400 && /^target must be/i.test(String(e.message))

/** One POST after another, each 200 applied at once so the calendar grows as blocks land. */
async function sequential(bodies, doing, onEach) {
  const done = []
  for (let i = 0; i < bodies.length; i++) {
    try {
      const res = await post(bodies[i], doing)
      A.apply('calendar', res)
      done.push(bodies[i])
      if (onEach) onEach(i + 1, bodies.length)
    } catch (e) { return { done, failed: { index: i, error: e } } }
  }
  return { done, failed: null }
}

const rawReasonFor = (target) => { const b = arr(A.state.calendar && A.state.calendar.blocks).find((x) => x && x.target === target); return b ? b.reason : undefined }
const blockBody = (t) => { const b = { action: 'block', target: t.target }; if (t.reason != null && String(t.reason).trim() && !/^blocked$/i.test(String(t.reason).trim())) b.reason = String(t.reason).slice(0, 120); return b }

/** Undo of a block: unblock each target. Rejects so the toast reads "Couldn't undo that". */
function undoBlocks(targets) {
  return A.busy('calendar', (async () => {
    const r = await sequential(targets.map((t) => ({ action: 'unblock', target: t })), 'undoing a block')
    if (r.failed) { if (!signedOut(r.failed.error)) reread(); throw r.failed.error }
  })())
}
/** Undo of a reopen / of removing old blocks: block each target again with its original reason. */
function reblock(targets, handle) {
  return A.busy('calendar', (async () => {
    const r = await sequential(targets.map(blockBody), 'putting a block back')
    if (r.failed) {
      const e = r.failed.error
      if (signedOut(e)) throw e
      reread()
      if (isKnown400(e)) {
        cal.slotBlocksFail = true
        if (handle) handle.close()
        A.toast("Couldn't put the block back — individual times can't be blocked right now. Block the whole day from Block time… if you need to.", { kind: 'error' })
      }
      throw e
    }
  })())
}

function blockLabel(date, slots) {
  if (!slots.length) return longDay(date)
  if (slots.length === 1) return `${shortDay(date)} ${fmt.time(slots[0].startsAt)}`
  return `${shortDay(date)} ${fmt.timeRange(slots[0].startsAt, slots[slots.length - 1].endsAt)}`
}

// --- reopen (unblock) ---------------------------------------------------------------------

async function reopen(it) {
  if (A.busyNow('calendar') || cal.inert || !it) return
  const ymd = it.ymd
  if (it.kind === 'dayband' || it.kind === 'day') {
    closePopover(true)
    const ok = await A.confirm(`The assistant will offer tour times on ${longDay(ymd)} again.`, { title: `Reopen ${dayLabel(ymd)}?`, confirmLabel: `Reopen ${longDay(ymd)}` })
    if (!ok) return
    await runReopen([{ target: ymd, reason: it.block ? it.block.reason : rawReasonFor(ymd) }], `Reopened ${longDay(ymd)}`, `day:${ymd}`, ymd)
    return
  }
  const targets = it.slots.map((sl) => ({ target: sl.id, reason: rawReasonFor(sl.id) }))
  const label = it.slots.length > 1 ? `${shortDay(ymd)} ${fmt.timeRange(it.first.startsAt, it.last.endsAt)}` : `${shortDay(ymd)} ${fmt.time(it.first.startsAt)}`
  await runReopen(targets, `Reopened ${label}`, `cell:${it.first.id}`, ymd)
}
async function runReopen(targets, toastText, focusKey, ymd) {
  closePopover(false)
  const r = await A.busy('calendar', sequential(targets.map((t) => ({ action: 'unblock', target: t.target })), 'reopening a time'))
  if (r.failed) {
    if (signedOut(r.failed.error)) return
    const rest = targets.slice(r.failed.index)
    A.toast("Couldn't reopen that time. The calendar hasn't changed — try again in a moment.", { kind: 'error', actions: [{ label: 'Try again', fn: () => { runReopen(rest, toastText, focusKey, ymd) } }] })
    reread()
    return
  }
  cal.focusKey = focusKey; cal.focusDate = ymd
  focusKeyNow()
  // No Undo for a slot-level reopen once slot blocks are known to fail — the page never offers an action it cannot honour.
  const canUndo = !(cal.slotBlocksFail && targets.some((t) => !isYmd(t.target)))
  const h = A.toast(toastText, { kind: 'ok', key: `cal:${ymd}`, actions: canUndo ? [{ label: 'Undo', fn: () => reblock(targets, h) }] : [] })
}

// --- remove all / remove old -----------------------------------------------------------------

async function removeAll() {
  if (A.busyNow('calendar') || cal.inert) return
  const n = arr(A.state.calendar && A.state.calendar.blocks).length
  const ok = await A.confirm('The assistant will offer all of these times again. Tours already booked stay.', { title: 'Remove every block?', confirmLabel: 'Remove all blocks', danger: true })
  if (!ok) return
  try {
    const res = await A.busy('calendar', post({ action: 'clear_blocks' }, 'removing all blocks'))
    A.apply('calendar', res)
    A.toast(`Removed ${plural(n, 'block')}`, { kind: 'ok' })
  } catch (e) {
    if (signedOut(e)) return
    A.toast("Couldn't do that. Nothing changed — try again.", { kind: 'error' })
    reread()
  }
}
async function removeOld() {
  if (A.busyNow('calendar') || cal.inert) return
  const old = cal.model ? cal.model.old : []
  if (!old.length) return
  const ok = await A.confirm("They're on days that have passed.", { title: `Remove ${plural(old.length, 'old block')}?`, confirmLabel: 'Remove old blocks' })
  if (!ok) return
  const targets = old.map((b) => ({ target: String(b.target), reason: b.reason }))
  const r = await A.busy('calendar', sequential(targets.map((t) => ({ action: 'unblock', target: t.target })), 'removing old blocks'))
  if (r.failed) { if (signedOut(r.failed.error)) return; A.toast("Couldn't do that. Nothing changed — try again.", { kind: 'error' }); reread(); return }
  const canUndo = !(cal.slotBlocksFail && targets.some((t) => !isYmd(t.target)))
  const h = A.toast(`Removed ${plural(targets.length, 'old block')}`, { kind: 'ok', actions: canUndo ? [{ label: 'Undo', fn: () => reblock(targets, h) }] : [] })
}

// --- the Block sheet (§10.5) -----------------------------------------------------------------

/** preset: { date, mode:'day'|'range', from, to, reason, only:Set } */
function openSheet(preset) {
  if (A.busyNow('calendar') || cal.inert) return
  if (cal.sheet) return
  closePopover(false)
  const p = preset || {}
  const m0 = cal.model || buildModel(A.state, {})
  // With no day preset, start on the first day from today that still has an open time (late in the
  // day that is tomorrow), so the sheet never opens with nothing to block.
  const firstOpenDay = (m) => { for (let d = m.today; d <= m.lastSlotDate; d = fmt.addDays(d, 1)) if ((m.byDate.get(d) || []).some((x) => x.status === 'open')) return d; return m.today }
  const st = { date: isYmd(p.date) ? p.date : firstOpenDay(m0), mode: p.mode === 'range' && !cal.slotBlocksFail ? 'range' : 'day', from: p.from || null, to: p.to || null, only: p.only || null, fallback: false, reason: String(p.reason || '') }
  const base = `cal-sheet-${Date.now()}`
  const model = () => cal.model || buildModel(A.state, {})
  const daySlots = () => model().byDate.get(st.date) || []
  const dayList = () => {
    const m = model(), out = []
    const end = m.hasSlots ? m.lastSlotDate : fmt.addDays(m.today, 14)
    for (let d = m.today; d <= end; d = fmt.addDays(d, 1)) {
      const has = (m.byDate.get(d) || []).length > 0
      out.push({ ymd: d, label: d === m.today ? `Today · ${fmt.day(d)}` : dayLabel(d), disabled: m.hasSlots && !has })
    }
    return out
  }
  const isOpen = (x) => x.status === 'open' && (!st.only || st.only.has(x.id))
  const range = () => {
    const list = daySlots()
    if (st.mode === 'day') return { all: list, targets: list.filter((x) => x.status === 'open') }
    const i = list.findIndex((x) => x.id === st.from), j = list.findIndex((x) => x.id === st.to)
    if (i < 0 || j < 0 || j < i) return { all: [], targets: [] }
    const all = list.slice(i, j + 1)
    return { all, targets: all.filter(isOpen) }
  }
  let api = null, els = {}
  function optionsHtml() {
    const list = daySlots()
    const i = list.findIndex((x) => x.id === st.from)
    els.from.innerHTML = list.map((x) => `<option value="${esc(x.id)}"${x.id === st.from ? ' selected' : ''}>${esc(fmt.time(x.startsAt))}</option>`).join('')
    els.to.innerHTML = list.map((x, k) => `<option value="${esc(x.id)}"${x.id === st.to ? ' selected' : ''}${k < i ? ' disabled' : ''}>${esc(fmt.time(x.endsAt))}</option>`).join('')
  }
  function update() {
    if (!api || st.fallback) return
    const m = model(), list = daySlots()
    if (st.mode === 'range' && list.length) {
      if (!list.some((x) => x.id === st.from)) { const f = list.find(isOpen) || list[0]; st.from = f.id }
      if (!list.some((x) => x.id === st.to) || list.findIndex((x) => x.id === st.to) < list.findIndex((x) => x.id === st.from)) {
        const i = list.findIndex((x) => x.id === st.from)
        let j = i; while (j + 1 < list.length && isOpen(list[j + 1]) && list[j + 1].startMin === list[j].endMin) j++
        st.to = (st.only ? list[j] : list[i]).id
      }
      optionsHtml()
    }
    els.range.hidden = st.mode !== 'range'
    const { all, targets } = range()
    const notes = []
    const dayBlocked = m.dayBlocks.has(st.date)
    if (st.mode === 'day' && dayBlocked) notes.push({ icon: 'slash', text: `${longDay(st.date)} is already blocked all day.` })
    for (const x of all) {
      if (x.status === 'booked') notes.push({ icon: 'person', text: `${fmt.time(x.startsAt)} already has a tour (${shortName(x.name)}) and won't be blocked.` })
      else if (x.status === 'blocked' && st.mode === 'range') notes.push({ icon: 'slash', text: `${fmt.time(x.startsAt)} is already blocked and will be skipped.` })
    }
    els.notes.innerHTML = notes.map((n) => `<li>${ico(n.icon)}<span>${esc(n.text)}</span></li>`).join('')
    els.notes.hidden = !notes.length
    const noSlotsAtAll = !m.hasSlots
    let label, disabled
    if (st.mode === 'day') { label = `Block ${longDay(st.date)}`; disabled = dayBlocked || (!noSlotsAtAll && !targets.length) }
    else { label = targets.length ? `Block ${blockLabel(st.date, targets)}` : `Block ${shortDay(st.date)}`; disabled = !targets.length }
    if (st.mode === 'range' && !list.some(isOpen) && cal.sheetOpened) api.setError('Those times just changed — pick again.')
    api.setPrimary({ label, disabled })
    for (const b of els.chips) b.setAttribute('aria-pressed', els.reason.value.trim() === b.dataset.reason ? 'true' : 'false')
  }
  function build(body, d) {
    api = d
    body.innerHTML = `<div class="cal-sheet">` +
      `<div class="field"><label class="field-label" for="${base}-day">Day</label><select class="select" id="${base}-day">${dayList().map((x) => `<option value="${esc(x.ymd)}"${x.ymd === st.date ? ' selected' : ''}${x.disabled ? ' disabled' : ''}>${esc(x.label)}${x.disabled ? ' (closed)' : ''}</option>`).join('')}</select></div>` +
      `<div class="cal-mode" role="radiogroup" aria-label="How much of the day"><label><input type="radio" name="${base}-mode" value="day"${st.mode === 'day' ? ' checked' : ''}> All day</label><label><input type="radio" name="${base}-mode" value="range"${st.mode === 'range' ? ' checked' : ''}${model().hasSlots && !cal.slotBlocksFail ? '' : ' disabled'}${cal.slotBlocksFail ? ` aria-describedby="${base}-modenote"` : ''}> Part of the day</label>` +
      (cal.slotBlocksFail ? `<p class="cal-mode-note" id="${base}-modenote">Individual times can't be blocked right now — only whole days.</p>` : '') + `</div>` +
      `<div class="cal-range-fields" hidden><div class="field"><label class="field-label" for="${base}-from">From</label><select class="select" id="${base}-from"></select></div><div class="field"><label class="field-label" for="${base}-to">To</label><select class="select" id="${base}-to"></select></div></div>` +
      `<div class="field"><label class="field-label" for="${base}-reason">Reason</label><input class="input" id="${base}-reason" type="text" maxlength="120" placeholder="e.g. painting, staff out" autocomplete="off" aria-describedby="${base}-hint" value="${esc(st.reason)}"><span class="field-hint" id="${base}-hint">optional · up to 120 characters</span>` +
      `<div class="chips cal-chips" role="group" aria-label="Quick reasons">${QUICK.map((q) => `<button type="button" class="chip-filter" data-reason="${esc(q)}" aria-pressed="false">${ico('check')}<span>${esc(q)}</span></button>`).join('')}</div></div>` +
      `<ul class="cal-notes" hidden></ul><p class="cal-consequence">The assistant will stop offering these times. Tours already booked stay.</p></div>`
    els = { day: body.querySelector(`#${base}-day`), from: body.querySelector(`#${base}-from`), to: body.querySelector(`#${base}-to`), range: body.querySelector('.cal-range-fields'), reason: body.querySelector(`#${base}-reason`), notes: body.querySelector('.cal-notes'), chips: [...body.querySelectorAll('.cal-chips .chip-filter')] }
    els.day.addEventListener('change', () => { st.date = els.day.value; st.from = null; st.to = null; st.only = null; api.setError(null); update() })
    body.querySelectorAll(`input[name="${base}-mode"]`).forEach((r) => r.addEventListener('change', () => { if (r.checked) { st.mode = r.value; api.setError(null); update() } }))
    els.from.addEventListener('change', () => { st.from = els.from.value; st.only = null; update() })
    els.to.addEventListener('change', () => { st.to = els.to.value; st.only = null; update() })
    els.reason.addEventListener('input', () => { st.reason = els.reason.value; update() })
    els.reason.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = d.el.querySelector('.dlg-primary'); if (b && b.getAttribute('aria-disabled') !== 'true') b.click() } })
    for (const b of els.chips) b.addEventListener('click', () => { els.reason.value = b.dataset.reason; st.reason = els.reason.value; update(); els.reason.focus() })
    setTimeout(() => { update(); cal.sheetOpened = true }, 0)
  }
  async function submit(d) {
    d.setError(null)
    const reason = String(els.reason ? els.reason.value : st.reason).trim().slice(0, 120)
    const date = st.date
    if (st.mode === 'day' || st.fallback) {
      const body = { action: 'block', target: date }
      if (reason) body.reason = reason
      try {
        const res = await A.busy('calendar', post(body, `blocking ${longDay(date)}`))
        A.apply('calendar', res)
        d.close()
        cal.sel = null; cal.focusKey = `dayband:${date}`; cal.focusDate = date
        focusKeyNow()
        A.toast(`Blocked ${longDay(date)}${reason ? ` (${reasonOf(reason)})` : ''}`, { kind: 'ok', key: `cal:${date}`, actions: [{ label: 'Undo', fn: () => undoBlocks([date]) }] })
      } catch (e) {
        if (signedOut(e)) return
        reread()
        d.setError("Couldn't block that time. The calendar hasn't changed — try again.")
        d.setPrimary({ label: 'Try again', disabled: false })
      }
      return
    }
    const { targets } = range()
    if (!targets.length) { d.setError('Those times just changed — pick again.'); update(); return }
    const bodies = targets.map((sl) => { const b = { action: 'block', target: sl.id }; if (reason) b.reason = reason; return b })
    const r = await A.busy('calendar', sequential(bodies, `blocking ${blockLabel(date, targets)}`, (n, total) => { if (n < total) d.setBusy(`Blocking ${n + 1} of ${total}…`) }))
    if (!r.failed) {
      d.close()
      cal.sel = null; cal.focusKey = `cell:${targets[0].id}`; cal.focusDate = date
      focusKeyNow()
      A.toast(`Blocked ${blockLabel(date, targets)}`, { kind: 'ok', key: `cal:${date}`, actions: [{ label: 'Undo', fn: () => undoBlocks(targets.map((x) => x.id)) }] })
      return
    }
    const e = r.failed.error
    if (signedOut(e)) return
    reread()
    if (r.failed.index === 0) {
      if (isKnown400(e)) {
        st.fallback = true
        cal.slotBlocksFail = true
        // The sheet changes under the keyboard user: keep focus inside it (on the new primary) and
        // say why through a live region, not only through the relabelled button.
        const sentence = `Individual times can't be blocked right now — only whole days. Block ${longDay(date)} all day instead?`
        d.body.innerHTML = `<div class="cal-sheet"><p class="prose" role="status">${esc(sentence)}</p></div>`
        els = {}
        d.setPrimary({ label: `Block ${longDay(date)} all day`, disabled: false })
        const pb = d.el.querySelector('.dlg-primary'); if (pb) { try { pb.focus() } catch (e2) { /* ignore */ } }
        A.announce(sentence)
        return
      }
      d.setError("Couldn't block that time. The calendar hasn't changed — try again.")
      d.setPrimary({ label: 'Try again', disabled: false })
      return
    }
    const done = targets.slice(0, r.failed.index), rest = targets.slice(r.failed.index)
    d.close()
    A.toast(`Blocked ${fmt.timeRange(done[0].startsAt, done[done.length - 1].endsAt)}, but couldn't block ${fmt.time(rest[0].startsAt)} onward.`, {
      kind: 'error', sticky: true, key: `cal:${date}`,
      actions: [
        { label: 'Try the rest again', fn: () => { openSheet({ date, mode: 'range', from: rest[0].id, to: rest[rest.length - 1].id, reason, only: new Set(rest.map((x) => x.id)) }) } },
        { label: 'Undo', fn: () => undoBlocks(done.map((x) => x.id)) },
      ],
    })
  }
  cal.sheetOpened = false
  cal.sheet = {
    refresh() { if (api && !api.isBusy() && !st.fallback) update() },
  }
  A.dialog({
    title: 'Block time', build,
    primary: { label: `Block ${longDay(st.date)}`, busyLabel: 'Blocking…', onClick: (d) => submit(d) },
    secondary: { label: 'Cancel' },
    onClose() { cal.sheet = null; clearSel() },
  })
}

// ---------------------------------------------------------------------------------------
// Lookups and focus
// ---------------------------------------------------------------------------------------

const q = (sel) => (cal.root ? cal.root.querySelector(sel) : null)
const byKey = (key) => (key ? q(`[data-key="${cssq(key)}"]`) : null)
const keyOf = (el) => { const k = el && el.closest ? el.closest('[data-key]') : null; return k ? k.dataset.key : null }
function findItem(key) { const m = cal.model; if (!m) return null; for (const d of m.dayModels) for (const it of d.items) if (it.key === key) return it; return null }
function itemForSlot(id) { const m = cal.model; if (!m) return null; for (const d of m.dayModels) for (const it of d.items) if (it.slots.some((x) => x.id === id)) return it; return null }
function focusable(el) { if (!el) return null; return el.classList.contains('cal-band') ? el.querySelector('.cal-band-hit[role="gridcell"]') : el }
/** Every programmatic focus move goes through here; cal.entering tells the focusin handler not to redirect it. */
function focusEl(el) { const f = focusable(el); if (!f) return false; cal.entering = true; try { f.focus({ preventScroll: true }) } catch (e) { /* ignore */ } cal.entering = false; return true }
function focusKeyNow() {
  let el = byKey(cal.focusKey)
  if (!el && cal.focusKey && /^(cell|tour|band):/.test(cal.focusKey)) { const id = cal.focusKey.replace(/^[a-z]+:/, ''); el = q(`[data-slot="${cssq(id)}"], [data-slots~="${cssq(id)}"]`) }
  if (!el && cal.focusDate) el = q(`.cal-grid [data-date="${cssq(cal.focusDate)}"][tabindex]`)
  if (el) { setRoving(el); focusEl(el) }
}
function setRoving(el) {
  const grid = q('.cal-grid'); if (!grid) return
  for (const x of grid.querySelectorAll('[tabindex="0"]')) x.setAttribute('tabindex', '-1')
  const f = focusable(el); if (f) f.setAttribute('tabindex', '0')
  cal.focusKey = keyOf(el); cal.focusDate = (el.closest('[data-date]') || {}).dataset ? el.closest('[data-date]').dataset.date : cal.focusDate
}
/** Bring a grid stop into view inside .cal-scroll (and the page) with the least movement. */
function showEl(el) { if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch (e) { /* ignore */ } } }

// ---------------------------------------------------------------------------------------
// Popovers (§10.6): a .popover on desktop, an Atrium.dialog bottom sheet on mobile
// ---------------------------------------------------------------------------------------

let popSeq = 0
const popSig = (it) => JSON.stringify([it.kind, it.slots.map((x) => [x.id, x.status, x.rawReason, x.name, x.unitId]), it.reason || '', it.kind === 'dayband' && it.block ? it.block.blockedAt : ''])

function closePopover(returnFocus) {
  const p = cal.pop
  if (!p) return
  cal.pop = null
  if (p.el) { p.el.remove(); document.removeEventListener('pointerdown', p.onDown, true); A.escape.remove(p.onEsc) }
  if (p.dialog) { try { p.dialog.close() } catch (e) { /* ignore */ } }
  if (returnFocus && p.anchorKey) {
    const el = byKey(p.anchorKey)
    if (el) focusEl(el)
    else {
      // the anchor was re-rendered away (a reopened band, a day that changed): the nearest stop on that day, else the heading
      focusKeyNow()
      const a = document.activeElement
      if (!a || a === document.body || !(cal.root && cal.root.contains(a))) { const h1 = q('h1'); if (h1) { try { h1.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
    }
  }
}
function position(el, anchor, host) {
  const hr = host.getBoundingClientRect(), ar = anchor.getBoundingClientRect()
  el.style.left = '0px'; el.style.top = '0px'
  const pw = el.offsetWidth, ph = el.offsetHeight
  let left = ar.left - hr.left, top = ar.bottom - hr.top + 4
  if (left + pw > hr.width - 4) left = Math.max(4, hr.width - pw - 4)
  if (window.innerHeight - ar.bottom < ph + 8 && ar.top - ph - 4 > 0) top = ar.top - hr.top - ph - 4
  el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(Math.max(0, top))}px`
}
function tourContent(s, m, it) {
  const sl = it.slot, t = tourInfo(s, m, sl)
  const tel = t.phone ? href.tel(t.phone) : null, mail = t.email ? href.mailto(t.email) : null
  const contact = []
  if (tel) contact.push(`<a href="${esc(tel)}">${esc(fmt.phone(t.phone))}</a>`)
  if (mail) contact.push(`<a href="${esc(mail)}">${esc(t.email)}</a>`)
  let body = `<p>${esc(dayLabel(sl.date))} · ${esc(fmt.timeRange(sl.startsAt, sl.endsAt))}</p><p>${t.unitId ? `Apartment ${esc(t.unitId)}` : 'No apartment picked yet'}</p><p>${contact.length ? contact.join(' · ') : 'No phone on file'}</p>`
  if (t.bookedAt && fmt.dateTime(t.bookedAt) !== '—') body += `<p>Booked by the assistant ${esc(fmt.dateTime(t.bookedAt))}</p>`
  const actions = []
  if (tel) actions.push(`<a class="btn" href="${esc(tel)}">Call</a>`)
  if (t.profile) actions.push(`<a class="btn btn-quiet" href="${esc(A.hashFor('leads', { phone: t.profile.phone }))}">Open lead</a>`)
  if (t.callId) actions.push(`<a class="btn btn-quiet" href="${esc(A.hashFor('calls', { id: t.callId }))}">See the call</a>`)
  const who = t.name === 'Tour' ? 'them' : firstName(t.name)
  return { title: t.name, body, actions: actions.join(''), note: `To move or cancel this tour, call ${esc(who)} — the assistant can't change tours yet.` }
}
function blockedContent(m, it, seg) {
  const ymd = it.ymd
  let title, reopenLabel, block
  if (it.kind === 'dayband' || it.kind === 'day') { title = `Blocked all day · ${dayLabel(ymd)}`; reopenLabel = `Reopen ${longDay(ymd)}`; block = it.block }
  else {
    const rangeTxt = it.slots.length > 1 ? fmt.timeRange(it.first.startsAt, it.last.endsAt) : fmt.time(it.first.startsAt)
    title = `Blocked · ${fmt.day(ymd)} · ${rangeTxt}`; reopenLabel = `Reopen ${rangeTxt}`
    const all = arr(A.state.calendar && A.state.calendar.blocks)
    const entries = it.slots.map((x) => all.find((b) => b && b.target === x.id)).filter(Boolean).sort((a, b) => String(a.blockedAt).localeCompare(String(b.blockedAt)))
    block = entries[0] || null
  }
  const reason = reasonOf(block && block.reason) || it.reason || ''
  const added = block && block.blockedAt && fmt.dateTime(block.blockedAt) !== '—' ? ` · added ${fmt.dateTime(block.blockedAt)}` : ''
  let body = `<p>${reason ? esc(reason) : 'No reason given'}${esc(added)}</p>`
  if (it.kind === 'dayband' && it.tours) body += `<p>Tours already booked on ${esc(longDay(ymd))} stay on the calendar.</p>`
  if (seg) body += `<p>This time also has its own block: ${seg.reason ? esc(seg.reason) : 'no reason given'}.</p>`
  const actions = `<button type="button" class="btn" data-pop="reopen" data-write="calendar"${dis(A.busyNow('calendar'))}>${esc(reopenLabel)}</button><button type="button" class="btn btn-quiet" data-pop="close">Close</button>`
  return { title, body, actions, reopenLabel }
}
function showDetails(kind, it, anchorEl, seg) {
  if (!it) return
  if (cal.pop && cal.pop.key === it.key && cal.pop.kind === kind && cal.pop.el) { closePopover(true); return }
  closePopover(false)
  const s = A.state, m = cal.model
  const content = kind === 'tour' ? tourContent(s, m, it) : blockedContent(m, it, seg)
  if (isMobile() || !anchorEl) {
    const spec = {
      title: content.title,
      build(body) {
        body.innerHTML = `<div class="popover-body">${content.body}${content.note ? `<p class="muted-line">${content.note}</p>` : ''}</div>${kind === 'tour' && content.actions ? `<div class="cal-sheet-links">${content.actions}</div>` : ''}`
      },
      secondary: { label: 'Close' },
      onClose() { if (cal.pop && cal.pop.dialog === d) cal.pop = null },
    }
    if (kind === 'blocked') spec.primary = { label: content.reopenLabel, onClick(dd) { dd.close(); reopen(findItem(it.key) || it) } }
    const d = A.dialog(spec)
    cal.pop = { kind, key: it.key, sig: popSig(it), dialog: d, seg: seg ? seg.id : null }
    return
  }
  const host = q('.cal-wrap'); if (!host) return
  const id = `cal-pop-${++popSeq}`
  const el = document.createElement('div')
  el.className = 'popover cal-popover'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-labelledby', id)
  el.innerHTML = `<button type="button" class="btn-icon btn-quiet popover-x" aria-label="Close" data-pop="close">${A.icon('x')}</button>` +
    `<div class="popover-title" id="${id}">${esc(content.title)}</div><div class="popover-body">${content.body}${content.note ? `<p class="muted-line">${content.note}</p>` : ''}</div>` +
    `<div class="popover-actions">${content.actions}</div>`
  host.appendChild(el)
  position(el, anchorEl, host)
  const anchorKey = keyOf(anchorEl)
  const onDown = (e) => {
    if (el.contains(e.target)) return
    const onAnchor = anchorKey && e.target.closest && e.target.closest(`[data-key="${cssq(anchorKey)}"]`)
    closePopover(false)
    if (onAnchor) cal.suppress = { key: anchorKey, at: Date.now() }
  }
  const onEsc = () => { if (cal.pop && cal.pop.el === el) { closePopover(true); return true } return false }
  document.addEventListener('pointerdown', onDown, true)
  A.escape.push(onEsc)
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pop]'); if (!b) return
    if (b.dataset.pop === 'close') closePopover(true)
    else if (b.dataset.pop === 'reopen' && b.getAttribute('aria-disabled') !== 'true') reopen(findItem(it.key) || it)
  })
  cal.pop = { kind, key: it.key, sig: popSig(it), anchorKey, el, onDown, onEsc, seg: seg ? seg.id : null }
  const first = el.querySelector('.popover-actions .btn, .popover-actions a') || el.querySelector('.popover-x')
  if (first) { try { first.focus() } catch (e) { /* ignore */ } }
}
/** After a re-render: keep the popover if its anchor is unchanged, else close it and say so. */
function refreshPopover() {
  const p = cal.pop
  if (!p || p.kind === 'menu') return
  const it = findItem(p.key)
  if (!it && /^dayband:/.test(p.key) && cal.model && cal.model.dayBlocks.has(p.key.slice(8))) return
  if (it && popSig(it) === p.sig) {
    if (p.el) { const anchor = byKey(p.key); const host = q('.cal-wrap'); if (anchor && host) position(p.el, focusable(anchor) || anchor, host); else { closePopover(false) } }
    return
  }
  closePopover(false)
  A.toast('That time just changed — the calendar has been refreshed.', { kind: 'info' })
}

// --- the ⋯ menu ---------------------------------------------------------------------------

const menuButtons = () => `<button type="button" class="btn btn-quiet" data-menu="remove-all">${ico('slash')}Remove all blocks…</button><button type="button" class="btn btn-quiet" data-menu="goto">${ico('calendar')}Go to date…</button>`
function runMenu(a) { if (a === 'remove-all') removeAll(); else if (a === 'goto') goToDate() }
function openMenu(anchorEl) {
  if (A.busyNow('calendar') || cal.inert) return
  if (cal.pop && cal.pop.kind === 'menu') { closePopover(true); return }
  closePopover(false)
  if (isMobile()) {
    const d = A.dialog({ title: 'More calendar actions', build(body) { body.innerHTML = `<div class="stack">${menuButtons()}</div>`; body.addEventListener('click', (e) => { const b = e.target.closest('[data-menu]'); if (!b) return; d.close(); runMenu(b.dataset.menu) }) }, secondary: { label: 'Close' } })
    return
  }
  const host = q('.cal-wrap'); if (!host) return
  const id = `cal-pop-${++popSeq}`
  const el = document.createElement('div')
  el.className = 'popover cal-popover cal-menu'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-labelledby', id)
  el.innerHTML = `<span class="vh" id="${id}">More calendar actions</span><div class="stack">${menuButtons()}</div>`
  host.appendChild(el)
  position(el, anchorEl, host)
  const onDown = (e) => { if (el.contains(e.target)) return; closePopover(false); if (anchorEl.contains(e.target)) cal.suppress = { key: 'more', at: Date.now() } }
  const onEsc = () => { if (cal.pop && cal.pop.el === el) { closePopover(true); return true } return false }
  document.addEventListener('pointerdown', onDown, true)
  A.escape.push(onEsc)
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-menu]'); if (!b) return; closePopover(false); runMenu(b.dataset.menu) })
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...el.querySelectorAll('[data-menu]')], i = items.indexOf(document.activeElement)
    e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
  })
  cal.pop = { kind: 'menu', key: 'menu', sig: '', anchorKey: 'more', el, onDown, onEsc }
  el.querySelector('[data-menu]').focus()
}

// --- go to date ---------------------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
const monthNum = (w) => { const k = String(w || ''); for (const c of [k, k.slice(0, 3)]) if (Object.prototype.hasOwnProperty.call(MONTHS, c)) return MONTHS[c]; return null }
function parseDate(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
  const today = fmt.nyNow().ymd, yearNow = Number(today.slice(0, 4))
  if (s === 'today') return today
  if (s === 'tomorrow') return fmt.addDays(today, 1)
  let y = null, mo = null, d = null, mm
  if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = Number(mm[1]); mo = Number(mm[2]); d = Number(mm[3]) }
  else if ((mm = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) { mo = Number(mm[1]); d = Number(mm[2]); y = mm[3] ? (mm[3].length === 2 ? 2000 + Number(mm[3]) : Number(mm[3])) : null }
  else if ((mm = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s))) { mo = monthNum(mm[1]); d = Number(mm[2]); y = mm[3] ? Number(mm[3]) : null }
  else if ((mm = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/.exec(s))) { d = Number(mm[1]); mo = monthNum(mm[2]); y = mm[3] ? Number(mm[3]) : null }
  if (!mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const make = (yy) => { const dt = new Date(Date.UTC(yy, mo - 1, d, 12)); return isNaN(dt.getTime()) || dt.getUTCMonth() !== mo - 1 ? null : dt.toISOString().slice(0, 10) }
  if (y != null) return make(y)
  const thisYear = make(yearNow)
  if (!thisYear) return null
  return thisYear < today && dayDiff(thisYear, today) > 200 ? make(yearNow + 1) : thisYear
}
async function goToDate() {
  const v = await A.prompt('Which day?', { title: 'Go to date', placeholder: 'e.g. Sep 10', confirmLabel: 'Go' })
  if (v === null) return
  const ymd = parseDate(v)
  if (!ymd) { A.toast('Try a date like "Sep 10".', { kind: 'warn' }); return }
  const m = cal.model || buildModel(A.state, {})
  if (ymd < m.firstWeek || ymd > m.lastDay) { A.toast('The calendar only shows the next two weeks.', { kind: 'info' }); return }
  cal.picked = ymd
  setParams({ date: ymd }, undefined, { keepPicked: true })
}

// --- navigation ---------------------------------------------------------------------------

const params = () => A.route().params
/** Every in-view navigation drops the picked-day mark (paging, Today, the strip); Go to date keeps it. */
function setParams(patch, replace, opts) {
  if (!(opts && opts.keepPicked)) cal.picked = null
  const p = { ...params(), ...patch }
  for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === null || p[k] === '') delete p[k]
  A.navigate('calendar', p, { replace: replace !== false })
}
function page(dir) {
  const m = cal.model; if (!m) return
  let next = m.view === 'week' ? fmt.addDays(m.date, 7 * dir) : fmt.addDays(m.date, dir)
  if (next < m.firstWeek) next = m.firstWeek
  if (next > m.lastDay) next = m.lastDay
  if (next === m.date || (m.view === 'week' && weekStart(next) === m.weekStart)) return
  setParams({ date: next })
}
function setView(v) {
  cal.view = v
  try { localStorage.setItem('atrium.calendar.view', v) } catch (e) { /* no local state */ }
  setParams({ view: v })
}

// ---------------------------------------------------------------------------------------
// Selection (drag / Shift+arrows) — open slots only, one day, contiguous
// ---------------------------------------------------------------------------------------

function paintSelection() {
  const grid = q('.cal-grid'); if (!grid) return
  for (const c of grid.querySelectorAll('.cal-sel-caption')) c.remove()
  const ids = cal.sel ? cal.sel.slotIds : []
  for (const c of grid.querySelectorAll('.cal-open')) c.setAttribute('aria-selected', ids.includes(c.dataset.slot) ? 'true' : 'false')
  if (cal.sel && ids.length) {
    const first = cal.model.byId.get(ids[0]), last = cal.model.byId.get(ids[ids.length - 1])
    const cell = grid.querySelector(`.cal-open[data-slot="${cssq(ids[0])}"]`)
    if (first && last && cell) cell.insertAdjacentHTML('afterbegin', `<span class="cal-sel-caption" aria-hidden="true">${esc(fmt.timeRange(first.startsAt, last.endsAt))} · ${esc(plural(ids.length, 'time'))}</span>`)
  }
}
function announceSel() {
  if (!cal.sel || !cal.sel.slotIds.length) return
  const first = cal.model.byId.get(cal.sel.slotIds[0]), last = cal.model.byId.get(cal.sel.slotIds[cal.sel.slotIds.length - 1])
  if (first && last) say(`Selected ${toRange(first.startsAt, last.endsAt)} on ${fmt.dayLong(cal.sel.date)}. Press Enter to block, Escape to clear.`)
}
function clearSel(paint) { if (!cal.sel) return; cal.sel = null; if (paint !== false) paintSelection() }
/** The contiguous run of open cells in one column between two rows, clipped at the first non-open slot. */
function runBetween(date, a, b) {
  const grid = q('.cal-grid'); if (!grid) return []
  const open = new Map()
  for (const c of grid.querySelectorAll(`.cal-open[data-date="${cssq(date)}"]`)) open.set(Number(c.dataset.row), c.dataset.slot)
  const dir = b >= a ? 1 : -1, ids = []
  for (let r = a; dir > 0 ? r <= b : r >= b; r += dir) { if (!open.has(r)) break; ids.push(open.get(r)) }
  return dir > 0 ? ids : ids.reverse()
}
function openSheetForSel() {
  if (!cal.sel || !cal.sel.slotIds.length) return
  const ids = cal.sel.slotIds
  openSheet({ date: cal.sel.date, mode: 'range', from: ids[0], to: ids[ids.length - 1] })
}
function extendSel(cur, dir) {
  const date = cur.dataset.date, row = Number(cur.dataset.row), id = cur.dataset.slot
  const next = q(`.cal-grid .cal-open[data-date="${cssq(date)}"][data-row="${row + dir}"]`)
  if (!next) return
  let ids = cal.sel && cal.sel.date === date && cal.sel.slotIds.includes(id) ? cal.sel.slotIds.slice() : [id]
  const nid = next.dataset.slot
  if (ids.includes(nid)) ids = ids.filter((x) => x !== id)
  else ids = dir > 0 ? ids.concat([nid]) : [nid].concat(ids)
  const rowOfId = (x) => { const sl = cal.model.byId.get(x); return sl ? sl.startMin : 0 }
  ids.sort((x, y) => rowOfId(x) - rowOfId(y))
  cal.sel = { date, slotIds: ids }
  paintSelection(); setRoving(next); focusEl(next); cal.focusBy = 'kbd'; announceSel()
}

// ---------------------------------------------------------------------------------------
// Activation (click / Enter / Space)
// ---------------------------------------------------------------------------------------

function activate(el, seg) {
  if (!el || cal.inert || A.busyNow('calendar')) return
  const key = keyOf(el)
  if (cal.suppress && cal.suppress.key === key && Date.now() - cal.suppress.at < 500) { cal.suppress = null; return }
  cal.suppress = null
  if (el.classList.contains('cal-dayhead')) {
    const d = cal.model.dayModel(el.dataset.date)
    if (d.operable === 'block') openSheet({ date: d.ymd, mode: 'day' })
    else if (d.operable === 'blocked') {
      const dit = d.items.find((x) => x.kind === 'dayband') || { kind: 'day', key: `dayband:${d.ymd}`, ymd: d.ymd, block: d.dayBlock, slots: [], tours: d.tours.length, reason: reasonOf(d.dayBlock && d.dayBlock.reason) }
      showDetails('blocked', dit, el)
    }
    return
  }
  const it = findItem(key)
  if (!it) return
  if (it.kind === 'open') {
    if (cal.sel && cal.sel.date === it.ymd && cal.sel.slotIds.includes(it.slot.id) && cal.sel.slotIds.length > 1) openSheetForSel()
    else openSheet({ date: it.ymd, mode: 'range', from: it.slot.id, to: it.slot.id })
  } else if (it.kind === 'tour') showDetails('tour', it, focusable(el) || el)
  else showDetails('blocked', it, focusable(el) || el, seg)
}
function segAt(bandEl, it, clientY) {
  if (!it || it.kind !== 'dayband' || !it.segs.length) return null
  const r = Math.floor((clientY - bandEl.getBoundingClientRect().top) / ROW_H)
  const sg = it.segs.find((x) => r >= x.row && r < x.row + x.span)
  return sg ? sg.slot : null
}

// ---------------------------------------------------------------------------------------
// Keyboard (§10.7) — the grid is one tab stop with a roving tabindex
// ---------------------------------------------------------------------------------------

const STOP_SEL = '.cal-open, .cal-tour, .cal-band'
function stopsIn(col) {
  const grid = q('.cal-grid'); if (!grid) return []
  return [...grid.querySelectorAll(STOP_SEL)].filter((x) => Number(x.dataset.col) === col).sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))
}
const headIn = (col) => q(`.cal-grid button.cal-dayhead[data-col="${col}"]`)
const spanOfEl = (el) => { const it = findItem(keyOf(el)); return it ? it.span : 1 }
function nearestStop(col, row) {
  const stops = stopsIn(col)
  if (!stops.length) return null
  let best = null, bestD = Infinity
  for (const s of stops) {
    const r0 = Number(s.dataset.row), r1 = r0 + spanOfEl(s) - 1
    const d = row < r0 ? r0 - row : row > r1 ? row - r1 : 0
    if (d < bestD) { bestD = d; best = s }
    if (d === 0) break
  }
  return best
}
function currentStop() {
  const a = document.activeElement
  if (!a || !cal.root || !cal.root.contains(a)) return null
  if (a.classList.contains('cal-dayhead')) return a
  return a.classList.contains('cal-band-hit') ? a.closest('.cal-band') : (a.matches(STOP_SEL) ? a : null)
}
function moveTo(el) { if (el) { setRoving(el); focusEl(el); cal.focusBy = 'kbd' } }
function gridKey(e) {
  const cur = currentStop()
  if (!cur) return
  const k = e.key, isHead = cur.classList.contains('cal-dayhead')
  const col = Number(cur.dataset.col), row = isHead ? -1 : Number(cur.dataset.row)
  const cols = cal.model ? cal.model.days.length : 1
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault()
    if (e.shiftKey && cur.classList.contains('cal-open')) { extendSel(cur, k === 'ArrowDown' ? 1 : -1); return }
    const stops = stopsIn(col)
    if (isHead) { if (k === 'ArrowDown') moveTo(stops[0]); return }
    const i = stops.indexOf(cur)
    if (k === 'ArrowDown') { if (i + 1 < stops.length) moveTo(stops[i + 1]) }
    else if (i > 0) moveTo(stops[i - 1]); else moveTo(headIn(col))
    return
  }
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault()
    const dir = k === 'ArrowRight' ? 1 : -1
    for (let c = col + dir; c >= 0 && c < cols; c += dir) {
      const t = isHead ? headIn(c) : nearestStop(c, row)
      if (t) { moveTo(t); return }
    }
    return
  }
  if (k === 'Home' || k === 'End') { e.preventDefault(); const stops = stopsIn(col); moveTo(k === 'Home' ? stops[0] : stops[stops.length - 1]); return }
  if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); cal.pendingFocus = { col, row, head: isHead }; page(k === 'PageDown' ? 1 : -1); return }
  if (k === 'Enter' || k === ' ') { e.preventDefault(); activate(cur); return }
  if ((k === 'Delete' || k === 'Backspace') && cur.classList.contains('cal-band')) { e.preventDefault(); const it = findItem(keyOf(cur)); if (it) reopen(it); return }
  if (k === 'Escape') {
    if (cal.pop) { e.preventDefault(); e.stopPropagation(); closePopover(true); return }
    if (cal.sel) { e.preventDefault(); e.stopPropagation(); clearSel() }
  }
}

// ---------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------

function paintBusy() {
  const root = cal.root; if (!root) return
  const on = A.busyNow('calendar')
  root.classList.toggle('is-writing', on)
  root.classList.toggle('is-inert', cal.inert)
  const bar = q('.cal-progress'); if (bar) bar.hidden = !on
  for (const el of root.querySelectorAll('[data-write="calendar"]')) { if (on || cal.inert) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled') }
}
function paintNow() {
  const grid = q('.cal-grid'); if (!grid || !cal.model) return
  for (const el of grid.querySelectorAll('.cal-now, .cal-now-faint')) el.remove()
  grid.insertAdjacentHTML('beforeend', nowHtml(cal.model))
}
function defaultStop(m) {
  const grid = q('.cal-grid'); if (!grid) return null
  const tcol = m.days.indexOf(m.today)
  if (tcol >= 0) { const s = stopsIn(tcol).find((x) => x.classList.contains('cal-open')); if (s) return s }
  for (let c = 0; c < m.days.length; c++) { const s = stopsIn(c)[0]; if (s) return s; const h = headIn(c); if (h) return h }
  return null
}
function setPart(name, html) {
  const host = cal.hosts[name]
  if (!host || cal.parts[name] === html) return false
  cal.parts[name] = html
  host.innerHTML = html
  return true
}

const view = {
  title: 'Calendar', icon: A.icons.calendar,
  mount(root) {
    cal.root = root
    root.classList.add('cal-view')
    root.innerHTML = '<div class="cal-head"></div><div class="cal-banners"></div><div class="cal-wrap"><div class="cal-toolbar-host"></div><div class="cal-body"></div><div class="cal-foot-host"></div></div>'
    cal.hosts = { head: root.querySelector('.cal-head'), banners: root.querySelector('.cal-banners'), toolbar: root.querySelector('.cal-toolbar-host'), body: root.querySelector('.cal-body'), foot: root.querySelector('.cal-foot-host') }
    root.addEventListener('click', (e) => this.onClick(e))
    root.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('.cal-grid')) { gridKey(e); if (e.defaultPrevented) return }
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')
      if ((e.key === 't' || e.key === 'T') && !inField && !e.ctrlKey && !e.metaKey && !e.altKey && cal.model) { e.preventDefault(); setParams({ date: cal.model.today }) }
    })
    root.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    root.addEventListener('pointermove', (e) => this.onPointerMove(e))
    root.addEventListener('pointerup', (e) => this.onPointerUp(e))
    root.addEventListener('pointercancel', () => { cal.drag = null })
    root.addEventListener('focusin', (e) => {
      const grid = e.target.closest && e.target.closest('.cal-grid')
      if (!grid) return
      const entering = !(e.relatedTarget && grid.contains(e.relatedTarget))
      // Tab into the grid lands on today's first open time (§10.7) unless the keyboard user left a
      // spot of their own; a stop remembered from a mouse click is not that. Whatever gets focus is
      // scrolled into view, so the ring is never off screen.
      if (entering && !cal.entering && cal.kbd && cal.lastKey === 'Tab' && cal.focusBy !== 'kbd' && cal.model) {
        const d = defaultStop(cal.model), f = d ? focusable(d) : null
        if (f && f !== e.target) { setRoving(d); focusEl(d); showEl(f); return }
      }
      const stop = currentStop(); if (stop) setRoving(stop)
      // only a focus the browser moved (Tab, a click, a dialog handing focus back) says who owns the
      // spot; the page's own returns (popover close, focusKeyNow, a re-render) leave that alone
      if (!cal.entering) cal.focusBy = cal.kbd ? 'kbd' : 'mouse'
      if (entering) showEl(e.target)
      if (cal.kbd && !cal.keysShown && A.hint('calendar-keys')) { cal.keysShown = true; const h = q('.cal-hint'); if (h) h.classList.remove('vh') }
    })
    let tx = null, ty = null
    root.addEventListener('touchstart', (e) => { const t = e.touches[0]; tx = t.clientX; ty = t.clientY }, { passive: true })
    root.addEventListener('touchend', (e) => {
      if (tx == null || !cal.model || !cal.model.mobile || !e.target.closest('.cal-body')) return
      const t = e.changedTouches[0], dx = t.clientX - tx, dy = t.clientY - ty
      tx = null; ty = null
      if (Math.abs(dx) >= 48 && Math.abs(dx) > 2 * Math.abs(dy)) page(dx < 0 ? 1 : -1)
    }, { passive: true })
    document.addEventListener('keydown', (e) => { cal.kbd = true; cal.lastKey = e.key }, true)
    document.addEventListener('pointerdown', () => { cal.kbd = false }, true)
    A.escape.push(() => { if (cal.root && !cal.root.hidden && cal.sel && !cal.pop) { clearSel(); return true } return false })
    const repaint = () => { if (cal.root && !cal.root.hidden) this.render(A.state) }
    A.on('data', repaint)
    A.on('minute', () => { paintNow(); repaint() })
    A.on('busy', () => { paintBusy(); if (cal.sheet) cal.sheet.refresh() })
    A.on('route', (r) => {
      if (r.name !== 'calendar') { closePopover(false); document.body.classList.remove('has-cal-fab'); cal.wasCalendar = false; return }
      // arriving from another view (or a fresh load) with ?date= marks that day in the week header
      if (!cal.wasCalendar && isYmd(r.params.date)) { cal.picked = r.params.date; if (cal.root && !cal.root.hidden) this.render(A.state) }
      cal.wasCalendar = true
    })
    let rt = null
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (cal.model && cal.model.mobile !== isMobile()) { cal.parts = {}; closePopover(false) } repaint() }, 150) })
  },
  onClick(e) {
    const btn = e.target.closest('[data-action]')
    if (btn && cal.root.contains(btn)) {
      if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return }
      const a = btn.dataset.action
      if (a === 'prev') page(-1)
      else if (a === 'next') page(1)
      else if (a === 'today') setParams({ date: cal.model ? cal.model.today : undefined })
      else if (a === 'view-week') setView('week')
      else if (a === 'view-day') setView('day')
      else if (a === 'block') openSheet({ date: cal.model && cal.model.view === 'day' ? cal.model.date : undefined, mode: 'day' })
      else if (a === 'more') openMenu(btn)
      else if (a === 'remove-old') removeOld()
      else if (a === 'strip') setParams({ date: btn.dataset.date })
      else if (a === 'agenda-open') openSheet({ date: cal.model.date, mode: 'range', from: btn.dataset.first, to: btn.dataset.last })
      else if (a === 'agenda-tour') showDetails('tour', itemForSlot(btn.dataset.slot), null)
      else if (a === 'agenda-band') showDetails('blocked', findItem(btn.dataset.key), null)
      else if (a === 'agenda-day') { const d = cal.model.dayModel(btn.dataset.date); showDetails('blocked', { kind: 'day', key: `dayband:${d.ymd}`, ymd: d.ymd, block: d.dayBlock, slots: [], tours: d.tours.length, reason: reasonOf(d.dayBlock && d.dayBlock.reason) }, null) }
      return
    }
    if (cal.dragEnded && Date.now() - cal.dragEnded < 400) return
    const head = e.target.closest('button.cal-dayhead')
    if (head) { activate(head); return }
    const band = e.target.closest('.cal-band')
    if (band) { activate(band, segAt(band, findItem(keyOf(band)), e.clientY)); return }
    const cell = e.target.closest('.cal-open, .cal-tour')
    if (cell) activate(cell)
  },
  onPointerDown(e) {
    const cell = e.target.closest && e.target.closest('.cal-open')
    if (!cell || e.button !== 0 || e.pointerType === 'touch' || cal.inert || A.busyNow('calendar')) return
    const rect = cell.getBoundingClientRect()
    cal.drag = { id: e.pointerId, date: cell.dataset.date, row: Number(cell.dataset.row), x: e.clientX, y: e.clientY, left: rect.left, right: rect.right, moved: false, cell }
    try { cell.setPointerCapture(e.pointerId) } catch (err) { /* ignore */ }
  },
  onPointerMove(e) {
    const d = cal.drag
    if (!d || e.pointerId !== d.id) return
    if (!d.moved && Math.abs(e.clientX - d.x) < 4 && Math.abs(e.clientY - d.y) < 4) return
    d.moved = true
    if (e.clientX < d.left - 2 || e.clientX > d.right + 2) { cal.drag = null; cal.dragEnded = Date.now(); clearSel(); return }
    const grid = q('.cal-grid'); if (!grid) return
    const top = grid.getBoundingClientRect().top + HEAD_H
    const row = Math.max(0, Math.min(cal.model.rows - 1, Math.floor((e.clientY - top) / ROW_H)))
    const ids = runBetween(d.date, d.row, row)
    cal.sel = ids.length ? { date: d.date, slotIds: ids } : null
    paintSelection()
  },
  onPointerUp(e) {
    const d = cal.drag
    if (!d || e.pointerId !== d.id) return
    cal.drag = null
    if (!d.moved) return
    cal.dragEnded = Date.now()
    if (cal.sel && cal.sel.slotIds.length) { announceSel(); openSheetForSel() }
  },
  render(s) {
    if (!cal.root) return
    const p = params()
    const m = buildModel(s, { date: p.date, view: p.view === 'day' || p.view === 'week' ? p.view : cal.view })
    cal.model = m
    cal.inert = !m.loaded || Boolean(s.notConfigured)
    const loading = !m.loaded && !s.errors.calendar && !s.notConfigured
    // a selection survives only while every slot in it is still open
    if (cal.sel && (cal.sel.slotIds.some((id) => { const sl = m.byId.get(id); return !sl || sl.status !== 'open' }) || !m.days.includes(cal.sel.date))) {
      const changed = cal.sel.slotIds.some((id) => m.byId.has(id) && m.byId.get(id).status !== 'open') || cal.sel.slotIds.some((id) => !m.byId.has(id))
      cal.sel = null
      if (changed && m.loaded) say('Some of those times changed — selection cleared')
    }
    cal.pickedShown = cal.picked && m.view === 'week' && m.days.includes(cal.picked) && cal.picked !== m.today ? cal.picked : null
    const moreBtn = `<button type="button" class="btn-icon" data-action="more" data-key="more" aria-label="More calendar actions" aria-haspopup="dialog" data-write="calendar"${dis(A.busyNow('calendar') || cal.inert)}>${A.icon('more')}</button>`
    setPart('head', `<div class="view-head${m.mobile ? ' cal-head-mobile' : ''}"><div class="cal-head-main"><h1 tabindex="-1">Tour calendar</h1>${m.loaded || s.loaded.leads ? stripHtml(s, m) : ''}</div>${m.mobile ? `<div class="cal-head-tools">${moreBtn}</div>` : ''}</div>`)
    setPart('banners', bannersHtml(s, m))
    const rt = rangeText(m)
    if (m.mobile) setPart('toolbar', `<div class="cal-progress"${A.busyNow('calendar') ? '' : ' hidden'}></div>`)
    else setPart('toolbar', toolbarHtml(m))
    let body
    if (loading) body = skeletonHtml()
    else if (m.mobile) body = agendaHtml(m) + `<button type="button" class="btn btn-primary cal-fab" data-action="block" data-key="fab" data-write="calendar"${dis(cal.inert)}>${ico('plus')}Block time…</button>`
    else if (!m.hasSlots) body = emptyHtml()
    else body = `<div class="cal-scroll">${gridHtml(m)}</div>`
    const active = document.activeElement
    const hadFocus = active && cal.hosts.body.contains(active)
    const focusKey = hadFocus ? keyOf(active) : null
    const scrollEl = q('.cal-scroll'), scrollTop = scrollEl ? scrollEl.scrollTop : null
    const bodyChanged = setPart('body', body)
    setPart('foot', loading ? '' : footHtml(m))
    // the floating Block time… button owns the bottom edge on mobile; toasts stack above it (calendar.css)
    document.body.classList.toggle('has-cal-fab', Boolean(m.mobile && !loading && !cal.root.hidden))
    if (bodyChanged) {
      const grid = q('.cal-grid')
      if (grid) {
        paintNow()
        const sc = q('.cal-scroll')
        if (sc) {
          if (!cal.scrolled) {
            const tcol = m.days.indexOf(m.today)
            const firstOpen = tcol >= 0 ? m.dayModels[tcol].open[0] : null
            const row = firstOpen ? m.rowOf(firstOpen) : Math.max(0, Math.round((600 - m.minM) / 30))
            sc.scrollTop = row * ROW_H
            cal.scrolled = true
          } else if (scrollTop != null) sc.scrollTop = scrollTop
        }
        let target = null
        if (cal.pendingFocus) { const pf = cal.pendingFocus; cal.pendingFocus = null; target = pf.head ? headIn(pf.col) : nearestStop(pf.col, pf.row) }
        // the remembered stop is restored only while focus is in the grid; otherwise the tab stop
        // returns to today's first open time so entering the grid behaves per §10.7 (writes that
        // want a specific stop set cal.focusKey and call focusKeyNow() after this render)
        if (!target && hadFocus && (focusKey || cal.focusKey)) {
          target = byKey(focusKey || cal.focusKey)
          if (!target && cal.focusDate) target = nearestStop(m.days.indexOf(cal.focusDate), 0)
        }
        if (!target) target = defaultStop(m)
        if (target) { setRoving(target); if (hadFocus) focusEl(target) }
      } else if (hadFocus && focusKey) {
        const el = byKey(focusKey); if (el) focusEl(el)
      }
      refreshPopover()
    }
    paintBusy()
    if (cal.sheet) cal.sheet.refresh()
    const rangeKey = `${m.view}:${m.view === 'week' ? m.weekStart : m.date}`
    if (cal.lastRange && cal.lastRange !== rangeKey) say(rt.live)
    cal.lastRange = rangeKey
    // ?slot= is consumed once: open that slot, then take it out of the hash
    if (p.slot && m.loaded) {
      const id = String(p.slot)
      setParams({ slot: undefined })
      const sl = m.byId.get(id)
      if (!sl) { if (!cal.warnedStale.has(id)) { cal.warnedStale.add(id); A.toast("That item isn't on the list any more.", { kind: 'info' }) } return }
      if (sl.date !== m.date && (m.view === 'day' || !m.days.includes(sl.date))) { cal.pendingSlot = id; setParams({ date: sl.date }); return }
      this.openSlot(id)
    } else if (cal.pendingSlot && m.loaded) { const id = cal.pendingSlot; cal.pendingSlot = null; this.openSlot(id) }
  },
  openSlot(id) {
    const m = cal.model, sl = m.byId.get(id)
    if (!sl) return
    if (sl.status === 'open') { openSheet({ date: sl.date, mode: 'range', from: id, to: id }); return }
    const it = itemForSlot(id)
    if (!it) return
    const anchor = byKey(it.key)
    if (sl.status === 'booked') showDetails('tour', it, anchor ? focusable(anchor) : null)
    else showDetails('blocked', it, anchor ? focusable(anchor) : null, it.kind === 'dayband' && !sl.wholeDay ? sl : null)
  },
  badge(s) { return derive.toursOn(s, fmt.nyNow().ymd).length || null },
}
A.register('calendar', view)
})()
