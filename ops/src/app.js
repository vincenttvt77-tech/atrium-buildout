/*
 * Front desk shell — window.Atrium. Owner: shell. Plain ES2020 script; no modules, no deps.
 *
 * BOOT: this file registers only `window.Atrium` while it loads. The other scripts
 * (calls.js, calendar.js, leads.js) run after it and call `Atrium.register(name, module)` at
 * load. On DOMContentLoaded the shell registers its own views (today, status), paints the
 * chrome, resolves the hash route, starts polling, and fetches /api/health once. There is no
 * inline boot call in index.html. `Atrium.boot()` is idempotent.
 *
 * THE CONTRACT (CONSTRAINTS.md "The shell contract" + brief §5) — every member, in order:
 *
 *   Atrium.escapeHtml(s)      String(s ?? '') with & < > " ' escaped — the only path to innerHTML.
 *   Atrium.fmt.day(v)         'Tue, Sep 8' (+ ', 2027' when not the current NY year); 'YYYY-MM-DD'
 *                             and UTC-midnight instants render as the calendar day they encode.
 *   Atrium.fmt.dayLong(v)     'Tuesday, September 8'
 *   Atrium.fmt.time(iso)      '2:00 PM' (New York)
 *   Atrium.fmt.dateTime(iso)  'Today 2:14 PM' | 'Yesterday 6:40 PM' | 'Tomorrow 10:00 AM' | 'Tue, Sep 8, 2:14 PM'
 *                             (iso, { inSentence: true }) lower-cases the day word for use after another word
 *   Atrium.fmt.relative(iso)  'just now' | '3 min ago' | '2 hours ago' | 'yesterday' | '3 days ago' | 'Tue, Sep 1'
 *                             future: 'in 5 min' | 'in 2 hours' | 'tomorrow' | 'in 3 days' | 'Tue, Sep 15'
 *   Atrium.fmt.duration(s)    '7 min' (≥ 60 s, rounded) | '45 sec' | '—' when null. The brief's
 *                             staff wording replaces the contract's '4m 12s' example on purpose.
 *   Atrium.fmt.money(n)       a dollar sign then 4,200 (USD + n; see the build note below)
 *   Atrium.fmt.phone(s)       '(516) 990-9252' when US-shaped, else the input; 'unknown'/null → ''
 *   Atrium.fmt.nyDate(v)      'YYYY-MM-DD' in New York
 *   Atrium.fmt.nyNow()        { ymd, hour, minute, minutes, dayOfWeek } in New York right now
 *   Atrium.fmt.nyParts(iso)   the same shape for any instant (null when unparseable)
 *   Atrium.fmt.addDays(ymd,n) 'YYYY-MM-DD' arithmetic via UTC noon
 *   Atrium.fmt.dayOfWeek(ymd) 0..6, Sunday = 0
 *   Atrium.fmt.timeRange(a,b) '1:00 – 4:00 PM' | '10:30 AM – 12:00 PM'
 *   Atrium.fmt.dayPhrase(v)   'today' | 'tomorrow' | 'yesterday' | 'Thu' (next 6 days) | 'Sep 22'
 *   Atrium.fmt.duePhrase(iso) 'Due 2:00 PM' | 'Due tomorrow 10:00 AM' | 'Due Thu 11:00 AM' | 'Due Sep 22'
 *                             overdue: 'Was due 4 hours ago' | 'Was due yesterday 10:00 AM' | 'Was due Sun, Sep 6'
 *   Atrium.fmt.respondPhrase(iso) 'respond by 4:00 PM today' | 'respond by tomorrow 10:00 AM' | … | 'was due 2 hours ago'
 *   Atrium.fmt.elapsed(ms)    '14 hours' | '20 min' | '2 days' — for "oldest waiting …"
 *   Atrium.api.get(path)      parsed JSON; 401 signs out; revoked property access retires the document
 *   Atrium.api.post(path, body, { doing }) same; JSON body; throws Error(server {error}) with .status;
 *                             a failed write is remembered as state.lastWriteError (Status › For support)
 *   Atrium.gate()             session over: stop polling, no more requests, location.reload()
 *   Atrium.toast(text, { kind:'ok'|'info'|'warn'|'error', ms, actions:[{label, fn}] (max 2), sticky, key })
 *                             → { el, close(), update(text, opts) }. An action whose fn returns a promise
 *                             is busy while it settles ('Undoing…'); an Undo that resolves reads 'Undone'.
 *   Atrium.confirm(text, { title, confirmLabel, danger }) → Promise<boolean>
 *   Atrium.prompt(text, { title, placeholder, confirmLabel, required, value, maxLength }) → Promise<string|null>
 *   Atrium.dialog({ title, build(bodyEl, api), primary:{ label, danger, disabled, onClick(api) }, secondary:{ label }, onClose })
 *                             → api = { el, body, close(), setPrimary({label, disabled}), setBusy(text|null), setError(text|null), setProgress(text|null) }
 *                             one implementation behind confirm/prompt/module sheets: scrim, focus trap, Esc, return focus, mobile bottom sheet
 *   Atrium.register(name, module)   module: { title, icon, mount(rootEl), render(state), badge?(state) → number|null }
 *   Atrium.navigate(name, params?, { replace }?)   switches view, updates the hash; replace → history.replaceState
 *   Atrium.route()            { name, params } from the hash (unknown → today)
 *   Atrium.hashFor(name, params) '#/leads?phone=%2B1516…' — build links with this
 *   Atrium.state              { calls, events, calendar, leads, health, updatedAt, errors, callsError, callsConfigured,
 *                               loaded:{calls,calendar,leads}, lastGoodAt, failedRounds, notConfigured, lastWriteError }
 *                             read-only for modules
 *   Atrium.on('data', fn)     fn(state, changed:Set<'calls'|'calendar'|'leads'>) after a poll or apply that changed a
 *                             resource's data OR its failed/ok state; returns an unsubscribe function
 *   Atrium.on('route', fn)    fn(route) after each hash change
 *   Atrium.on('poll', fn)     fn(state, { changed, ok, failed }) after every poll round
 *   Atrium.on('minute', fn)   fn(state) once a minute (due groups, relative phrases)
 *   Atrium.busy(resource, promise)  marks 'calendar'|'leads' busy until settled; its polls are dropped
 *   Atrium.busyNow(resource)  boolean
 *   Atrium.apply(resource, data)    replace that resource's state from a write response; emits 'data'
 *   Atrium.refresh()          one forced poll round of all three resources (+ /api/health) → Promise
 *   Atrium.icons / Atrium.icon(name)  inline SVG strings (24px, currentColor); '' for an unknown name
 *   Atrium.property           safe property display facts from server bootstrap (legacy fixture defaults only)
 *   Atrium.normalisePhone(s)  the server's rule: 10 digits → '+1…', 11 starting 1 → '+…', other → '+digits', empty → 'unknown'
 *   Atrium.labels / Atrium.label(map, key, fallback)  §6 vocabulary; own-property lookup, humanised fallback
 *   Atrium.derive.*           windowStart, personName, displayName, displayStage, needsPerson, callBackToday,
 *                             dueTodayCount, toursOn, callRecords, callStory, todoSentence, escalationText, lossText,
 *                             summarySentence, availabilityText, moveInText, profileByPhone, profileForCall
 *   Atrium.hint(key)          localStorage one-time flag (true the first time only)
 *   Atrium.text               plural(n, one, many), list(items), truncate(s, n), humanise(s), capitalise(s),
 *                             staff(s) — 'the agent' → 'the assistant', 'residence' → 'apartment'
 *   Atrium.href               tel(phone), sms(phone), mailto(email), recording(url) — safe hrefs or null
 *   Atrium.html               chip(cls, icon, text), banner(kind, text, {actionsHtml}), empty({icon,title,text,actionHtml}),
 *                             skeletonRows(n) — small HTML builders (everything passed in is escaped here)
 *   Atrium.announce(text)     the visually hidden polite live region
 *   Atrium.escape.push(fn) / .remove(fn)   Esc handlers (popover/panel) tried newest-first before the newest toast closes
 *   Atrium.setFollowUpStatus(fu, status, { verb, button }) the §9.2 write behaviour shared by Today, Leads and Calls
 *   Atrium.boot()             idempotent; runs on DOMContentLoaded
 *
 * BUILD NOTE: scripts/build-ops.mjs splices each file in with String.prototype.replace and a
 * string replacement, so a dollar sign followed by an ampersand, another dollar sign, an
 * apostrophe, a backtick or a digit is rewritten at compose time in ANY included source (two
 * dollar signs collapse to one; dollar-ampersand becomes the include directive; dollar-apostrophe
 * duplicates the rest of the page). Even a single-quoted dollar-sign string literal trips it, so
 * money strings are built with the double-quoted USD constant below. Reviewers: grep sources.
 *
 * Polling: one round every 5 s = /api/vapi, /api/calendar, /api/leads in parallel with
 * credentials:'same-origin', cache:'no-store', accept:'application/json'. Paused while
 * document.hidden; one immediate round on visibilitychange back and on window focus. Each
 * resource keeps its own JSON signature (generatedAt/note excluded); a response that lands
 * after apply() bumped that resource's seq is discarded; a resource with a write in flight is
 * skipped. Two rounds in a row with no success turn the status cluster amber; errors sit in
 * state.errors[resource] and appear as banners inside views and under Status › For support.
 */
(function () {
'use strict'

const LEGACY_TIME_ZONE = 'America/New_York'
const databaseMode = window.ATRIUM_RUNTIME_MODE === 'postgres'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const PERMISSIONS = ['read', 'operate', 'configure', 'manage_members', 'manage_organization']
let documentScope = null
let displayProperty = null
let documentAccessIssue = null
function permissionAllowed(permission) {
  return !documentAccessIssue && (!databaseMode || documentScope.permissions.includes(permission))
}
function displayText(value, max = 200) { return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) }
function scopeIdentity(value) {
  return value && typeof value === 'object' && typeof value.organizationId === 'string' && typeof value.propertyId === 'string'
    && ID_PATTERN.test(value.organizationId) && ID_PATTERN.test(value.propertyId)
}
function validatedBootstrap(value) {
  if (!scopeIdentity(value) || !Number.isSafeInteger(value.configurationVersion) || value.configurationVersion < 1
    || !displayText(value.permissionVersion) || !value.permissionVersion
    || !Array.isArray(value.permissions) || !value.permissions.includes('read')
    || value.permissions.some(p => !PERMISSIONS.includes(p)) || new Set(value.permissions).size !== value.permissions.length
    || !displayText(value.buildingName) || !value.buildingName.trim()
    || !displayText(value.locationLabel ?? '', 300) || !value.hours || typeof value.hours !== 'object' || Array.isArray(value.hours)) throw new Error('Invalid property bootstrap')
  const hours = {}
  for (const [day, range] of Object.entries(value.hours)) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(range) || range.length !== 2
      || range.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 24) || range[1] <= range[0]) throw new Error('Invalid property hours')
    hours[day] = Object.freeze([...range])
  }
  for (const key of ['leasingPhone', 'leasingPhoneDisplay']) if (value[key] != null && !displayText(value[key], 80)) throw new Error('Invalid property contact')
  documentScope = Object.freeze({ organizationId: value.organizationId, propertyId: value.propertyId,
    configurationVersion: value.configurationVersion, permissionVersion: value.permissionVersion,
    permissions: Object.freeze([...value.permissions]) })
  return Object.freeze({ name: value.buildingName, locationLabel: value.locationLabel || '',
    leasingPhone: value.leasingPhone || null, leasingPhoneDisplay: value.leasingPhoneDisplay || value.leasingPhone || null,
    hours: Object.freeze(hours) })
}
function validatedTimeZone(value) {
  if (typeof value !== 'string' || !/^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)) throw new Error('Invalid property timezone')
  return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
}
let propertyTimeZone
try {
  if (window.ATRIUM_RUNTIME_MODE !== undefined && !['legacy', 'postgres'].includes(window.ATRIUM_RUNTIME_MODE)) throw new Error('Unknown runtime mode')
  if (databaseMode) displayProperty = validatedBootstrap(window.ATRIUM_PROPERTY)
  const supplied = window.ATRIUM_PROPERTY && Object.prototype.hasOwnProperty.call(window.ATRIUM_PROPERTY, 'timeZone')
    ? window.ATRIUM_PROPERTY.timeZone : databaseMode ? null : LEGACY_TIME_ZONE
  propertyTimeZone = validatedTimeZone(supplied)
} catch {
  document.body.textContent = databaseMode
    ? 'Property configuration needs attention. The property details or timezone are invalid; ask an administrator to correct them, then reload.'
    : 'Property configuration needs attention. The timezone is invalid; ask an administrator to correct it, then reload.'
  return
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_MS = 86400000
const isDemo = window.ATRIUM_DEMO === true
const isPersistentDemo = isDemo && window.ATRIUM_DEMO_PERSISTENT === true
const USD = "$"

/** DB mode never inherits another building's phone, hours, name or location. */
const property = Object.freeze({
  ...(displayProperty || { name: 'The Larkin', locationLabel: 'Long Island City, NY',
    leasingPhone: '+15169909252', leasingPhoneDisplay: '(516) 990-9252',
    hours: { 0: [11, 16], 1: [10, 18], 2: [10, 18], 3: [10, 19], 4: [10, 19], 5: [10, 18], 6: [10, 17] } }),
  timeZone: propertyTimeZone,
  timeZoneLabel: new Intl.DateTimeFormat('en-US', { timeZone: propertyTimeZone, timeZoneName: 'longGeneric' })
    .formatToParts(new Date()).find(part => part.type === 'timeZoneName').value,
})

// ---------------------------------------------------------------------------------------
// Escaping and text
// ---------------------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** The only way a caller/server string reaches innerHTML — text and attribute positions alike. */
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]) }
const esc = escapeHtml

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const cssq = (s) => (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, (c) => '\\' + c)

const text = {
  plural(n, one, many) { n = Number(n) || 0; return `${n} ${n === 1 ? one : (many ?? one + 's')}` },
  list(items, conj = 'and') {
    const a = (items || []).map((x) => String(x)).filter(Boolean)
    if (a.length <= 1) return a.join('')
    if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`
    return `${a.slice(0, -1).join(', ')} ${conj} ${a[a.length - 1]}`
  },
  truncate(s, n) { s = String(s ?? ''); return s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s },
  humanise(s) { s = String(s ?? '').replace(/_/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : '' },
  capitalise(s) { s = String(s ?? ''); return s ? s[0].toUpperCase() + s.slice(1) : '' },
  firstName(name) { return String(name ?? '').trim().split(/\s+/)[0] || '' },
  /** Server sentences rewritten for staff: the agent → the assistant, residence → apartment, ceiling → budget. */
  staff(s) {
    return String(s ?? '')
      .replace(/\bthe agent\b/gi, (m) => (m[0] === 'T' ? 'The assistant' : 'the assistant'))
      .replace(/\bresidences\b/gi, (m) => (m[0] === 'R' ? 'Apartments' : 'apartments'))
      .replace(/\bresidence\b/gi, (m) => (m[0] === 'R' ? 'Apartment' : 'apartment'))
      .replace(/\bunits\b/g, 'apartments').replace(/\bunit\b/g, 'apartment')
      .replace(/over (?:the )?stated(?: \$[\d,]+)? ceiling/gi, 'over their budget')
  },
}

// ---------------------------------------------------------------------------------------
// Time — the server-authorized property timezone, never the viewer's zone.
// ---------------------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: propertyTimeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
})
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: propertyTimeZone, hour: 'numeric', minute: '2-digit' })
const tidy = (s) => String(s).replace(/[\u202f\u00a0]/g, ' ')

function toTime(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return isNaN(v) ? null : v
  const t = Date.parse(String(v))
  return isNaN(t) ? null : t
}
const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
/** 'YYYY-MM-DD' for a date-only string or a UTC-midnight instant (which encodes a calendar day), else null. */
function dayValue(v) {
  if (isYmd(v)) return v
  const s = String(v ?? '')
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.\d{3})?Z$/.test(s) ? s.slice(0, 10) : null
}
function nyParts(v) {
  const t = toTime(v)
  if (t == null) return null
  const o = {}
  for (const p of partsFmt.formatToParts(new Date(t))) o[p.type] = p.value
  const hour = Number(o.hour) % 24
  const minute = Number(o.minute)
  return { ymd: `${o.year}-${o.month}-${o.day}`, hour, minute, minutes: hour * 60 + minute, dayOfWeek: WD.indexOf(o.weekday) }
}
const ymdNoon = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d, 12) }
const addDays = (ymd, n) => new Date(ymdNoon(ymd) + n * DAY_MS).toISOString().slice(0, 10)
const dayOfWeek = (ymd) => new Date(ymdNoon(ymd)).getUTCDay()
const daysBetween = (a, b) => Math.round((ymdNoon(b) - ymdNoon(a)) / DAY_MS)
const nyDate = (v) => (isYmd(v) ? v : (nyParts(v) || {}).ymd || null)
const nyNow = () => nyParts(Date.now())
/** The instant of a property-local wall-clock time; ny* names remain module compatibility aliases. */
function nyInstant(ymd, hour, minute) {
  const [y, m, d] = ymd.split('-').map(Number)
  const want = Date.UTC(y, m - 1, d, hour, minute)
  let t = want
  for (let i = 0; i < 2; i++) {
    const p = nyParts(t)
    const [py, pm, pd] = p.ymd.split('-').map(Number)
    t += want - Date.UTC(py, pm - 1, pd, p.hour, p.minute)
  }
  return t
}
const ymdBits = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return { y, m, d, dow: dayOfWeek(ymd) } }
const yearSuffix = (y) => (String(y) === nyNow().ymd.slice(0, 4) ? '' : `, ${y}`)
/** A day value renders as itself; a timestamp uses its property-local calendar day. */
const dayOf = (v) => dayValue(v) || nyDate(v)

const fmt = {
  nyParts, nyDate, nyNow, addDays, dayOfWeek,
  day(v) {
    const ymd = dayOf(v); if (!ymd) return '—'
    const b = ymdBits(ymd)
    return `${WD[b.dow]}, ${MON[b.m - 1]} ${b.d}${yearSuffix(b.y)}`
  },
  dayLong(v) {
    const ymd = dayOf(v); if (!ymd) return '—'
    const b = ymdBits(ymd)
    return `${WD_LONG[b.dow]}, ${MON_LONG[b.m - 1]} ${b.d}${yearSuffix(b.y)}`
  },
  monthDay(v) {
    const ymd = dayOf(v); if (!ymd) return '—'
    const b = ymdBits(ymd)
    return `${MON[b.m - 1]} ${b.d}${yearSuffix(b.y)}`
  },
  time(iso) { const t = toTime(iso); return t == null ? '—' : tidy(timeFmt.format(new Date(t))) },
  /** 'Today 2:14 PM' at the start of a line; { inSentence: true } → 'today 2:14 PM' after a word ("called today 2:14 PM"). */
  dateTime(iso, opts) {
    const p = nyParts(iso); if (!p) return '—'
    const today = nyNow().ymd
    const diff = daysBetween(today, p.ymd)
    const time = fmt.time(iso)
    const low = Boolean(opts && opts.inSentence)
    if (diff === 0) return `${low ? 'today' : 'Today'} ${time}`
    if (diff === -1) return `${low ? 'yesterday' : 'Yesterday'} ${time}`
    if (diff === 1) return `${low ? 'tomorrow' : 'Tomorrow'} ${time}`
    return `${fmt.day(p.ymd)}, ${time}`
  },
  /** Mid-sentence form of dateTime: 'at 3:02 AM' | 'yesterday at 1:05 PM' | 'tomorrow at 10:00 AM' | 'on Tue, Sep 1 at 2:14 PM'. */
  whenPhrase(iso) {
    const p = nyParts(iso); if (!p) return ''
    const diff = daysBetween(nyNow().ymd, p.ymd)
    const time = fmt.time(iso)
    if (diff === 0) return `at ${time}`
    if (diff === -1) return `yesterday at ${time}`
    if (diff === 1) return `tomorrow at ${time}`
    return `on ${fmt.day(p.ymd)} at ${time}`
  },
  timeRange(a, b) {
    const ta = fmt.time(a), tb = fmt.time(b)
    if (ta === '—' || tb === '—') return ta === '—' ? tb : ta
    const ma = ta.slice(-2), mb = tb.slice(-2)
    return ma === mb ? `${ta.slice(0, -3)} – ${tb}` : `${ta} – ${tb}`
  },
  dayPhrase(v) {
    const ymd = dayOf(v); if (!ymd) return '—'
    const diff = daysBetween(nyNow().ymd, ymd)
    if (diff === 0) return 'today'
    if (diff === 1) return 'tomorrow'
    if (diff === -1) return 'yesterday'
    if (diff > 1 && diff <= 6) return WD[dayOfWeek(ymd)]
    return fmt.monthDay(ymd)
  },
  relative(iso) {
    const t = toTime(iso); if (t == null) return '—'
    const now = Date.now(), diff = now - t, abs = Math.abs(diff)
    const p = nyParts(t), today = nyNow().ymd, dayDiff = daysBetween(today, p.ymd)
    if (abs < 45000) return 'just now'
    if (diff > 0) {
      if (abs < 3600000) return `${Math.round(abs / 60000)} min ago`
      if (abs < DAY_MS) { const h = Math.round(abs / 3600000); return `${h} ${h === 1 ? 'hour' : 'hours'} ago` }
      if (dayDiff === -1) return 'yesterday'
      if (abs < 7 * DAY_MS) return `${-dayDiff} days ago`
      return fmt.day(p.ymd)
    }
    if (abs < 3600000) return `in ${Math.round(abs / 60000)} min`
    if (abs < DAY_MS) { const h = Math.round(abs / 3600000); return `in ${h} ${h === 1 ? 'hour' : 'hours'}` }
    if (dayDiff === 1) return 'tomorrow'
    if (abs < 7 * DAY_MS) return `in ${dayDiff} days`
    return fmt.day(p.ymd)
  },
  /** 'Due 2:00 PM' … / 'Was due 4 hours ago' … (see the header comment). */
  duePhrase(iso) {
    const t = toTime(iso); if (t == null) return '—'
    const p = nyParts(t), today = nyNow().ymd, dayDiff = daysBetween(today, p.ymd), time = fmt.time(t)
    if (t <= Date.now()) {
      if (dayDiff === 0) return `Was due ${fmt.relative(t)}`
      if (dayDiff === -1) return `Was due yesterday ${time}`
      return `Was due ${fmt.day(p.ymd)}`
    }
    if (dayDiff === 0) return `Due ${time}`
    if (dayDiff === 1) return `Due tomorrow ${time}`
    if (dayDiff <= 6) return `Due ${WD[p.dayOfWeek]} ${time}`
    return `Due ${fmt.monthDay(p.ymd)}`
  },
  respondPhrase(iso) {
    const t = toTime(iso); if (t == null) return ''
    const p = nyParts(t), today = nyNow().ymd, dayDiff = daysBetween(today, p.ymd), time = fmt.time(t)
    if (t <= Date.now()) {
      if (dayDiff === 0) return `was due ${fmt.relative(t)}`
      if (dayDiff === -1) return `was due yesterday ${time}`
      return `was due ${fmt.day(p.ymd)}`
    }
    if (dayDiff === 0) return `respond by ${time} today`
    if (dayDiff === 1) return `respond by tomorrow ${time}`
    if (dayDiff <= 6) return `respond by ${WD[p.dayOfWeek]} ${time}`
    return `respond by ${fmt.monthDay(p.ymd)}`
  },
  duration(seconds) {
    const s = Number(seconds)
    if (seconds == null || isNaN(s) || s < 0) return '—'
    if (s < 60) return `${Math.round(s)} sec`
    return `${Math.max(1, Math.round(s / 60))} min`
  },
  elapsed(ms) {
    const m = Math.max(0, Math.round(ms / 60000))
    if (m < 1) return 'a minute'
    if (m < 60) return `${m} min`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'}`
    return `${Math.round(h / 24)} days`
  },
  money(n) { const v = Number(n); return isNaN(v) ? '—' : USD + Math.round(v).toLocaleString('en-US') },
  phone(s) {
    if (s == null || s === 'unknown') return ''
    const raw = String(s)
    let d = raw.replace(/\D/g, '')
    if (d.length === 11 && d[0] === '1') d = d.slice(1)
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
    return raw
  },
}

/** src/leads/profile.ts rule, so a Vapi number and a profile phone compare equal. */
function normalisePhone(s) {
  const d = String(s ?? '').replace(/\D/g, '')
  if (!d) return 'unknown'
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d[0] === '1') return `+${d}`
  return `+${d}`
}

const href = {
  tel(phone) { const d = String(phone ?? '').replace(/[^\d+]/g, ''); return /\d/.test(d) && phone !== 'unknown' ? `tel:${d}` : null },
  sms(phone) { const d = String(phone ?? '').replace(/[^\d+]/g, ''); return /\d/.test(d) && phone !== 'unknown' ? `sms:${d}` : null },
  mailto(email) { const e = String(email ?? '').trim(); return e.includes('@') && !/\s/.test(e) ? `mailto:${e}` : null },
  recording(url) { const u = String(url ?? ''); return /^https:\/\//.test(u) ? u : null },
}

// ---------------------------------------------------------------------------------------
// Vocabulary (§6) — the only way an API enum reaches the screen
// ---------------------------------------------------------------------------------------

const labels = {
  stage: { new: 'New', qualified: 'Interested', tour_scheduled: 'Tour booked', toured: 'Toured', lost: "Didn't work out", escalated: 'Needs a person' },
  stageChip: { new: 'chip-neutral', qualified: 'chip-neutral', tour_scheduled: 'chip-ok', toured: 'chip-ok', lost: 'chip-lost', escalated: 'chip-warn' },
  stageIcon: { new: 'person', qualified: 'person', tour_scheduled: 'calendar', toured: 'check', lost: 'x', escalated: 'hand' },
  followUpStatus: { scheduled: 'To do', done: 'Done', skipped: 'Not needed' },
  channelVerb: { call: 'Call', sms: 'Text', email: 'Email' },
  channelIcon: { call: 'phone', sms: 'message', email: 'mail' },
  bookingStatus: {
    confirmed: 'Confirmed', arranging: 'Being arranged — not confirmed yet',
    failed: "Couldn't be booked — needs a person", slot_taken: 'Time was taken — offered other times',
  },
  bookingChip: { confirmed: 'chip-ok', arranging: 'chip-warn', failed: 'chip-warn', slot_taken: 'chip-info' },
  bookingIcon: { confirmed: 'check', arranging: 'clock', failed: 'hand', slot_taken: 'info' },
  lossReason: {
    priced_out: 'Priced out', timing_mismatch: "Timing didn't line up", no_availability: 'Nothing available',
    bedroom_mismatch: 'Wrong number of bedrooms', pets: 'Pet policy', parking: 'Parking', policy: 'A building policy',
    competitor: 'Chose somewhere else', application_friction: 'Application was too much hassle',
    feature_missing: "Wanted something we don't have", went_quiet: 'Stopped responding', not_qualified: "Didn't qualify",
  },
  trigger: {
    'restricted:reasonable_accommodation': 'an accommodation request',
    'restricted:fair_housing': 'a fair-housing question',
    'restricted:protected_class_inquiry': 'something fair-housing rules cover',
    'restricted:eligibility_or_denial': 'eligibility',
    'restricted:legal_question': 'a legal question',
    'restricted:dispute': 'a dispute',
    'restricted:money_movement': 'a payment',
    emergency: 'an emergency',
  },
  reassurance: {
    'restricted:reasonable_accommodation': "The assistant doesn't answer accommodation questions — it said someone would call.",
    'restricted:fair_housing': "The assistant doesn't answer fair-housing questions — it said someone would call.",
    'restricted:protected_class_inquiry': "That's a question only a person can answer — the assistant took their details and said someone would call.",
    'restricted:eligibility_or_denial': "The assistant doesn't discuss eligibility or denials — it said someone would call.",
    'restricted:legal_question': "The assistant doesn't answer legal questions — it said someone would call.",
    'restricted:dispute': "The assistant doesn't handle disputes — it said someone would call.",
    'restricted:money_movement': "The assistant doesn't move or discuss money — it said someone would call.",
    emergency: 'The assistant treated it as an emergency.',
  },
  emergency: {
    gas: 'a possible gas leak', smoke_or_fire: 'smoke or fire', carbon_monoxide: 'carbon monoxide', flooding: 'flooding',
    no_heat: 'no heat', injury: 'an injury', intruder: 'an intruder', structural: 'structural damage',
  },
  ended: {
    'silence-timed-out': 'Ended after silence', 'exceeded-max-duration': 'Hit the time limit',
    'assistant-forwarded-call': 'Transferred to a person', voicemail: 'Went to voicemail',
  },
  tool: {
    capture_signal: 'Noted what they want', check_availability: "Checked what's available", answer_question: 'Answered a question',
    list_tour_slots: 'Offered tour times', book_tour: 'Booked a tour', capture_loss_reason: 'Noted why it might not work out',
  },
  signal: { moveInTiming: 'Move-in', budget: 'Budget', bedrooms: 'Bedrooms', pets: 'Pets', parking: 'Parking' },
  signalPhrase: { moveInTiming: 'when they want to move', budget: 'their budget', bedrooms: 'how many bedrooms', pets: 'their pet', parking: 'parking' },
  signalShort: { moveInTiming: 'move-in date', budget: 'budget', bedrooms: 'bedrooms', pets: 'pets', parking: 'parking' },
  topic: {
    pet_policy: 'the pet policy', parking: 'parking', amenities: 'the amenities', hours: 'office hours', utilities: 'utilities',
    application_requirements: 'what the application needs', building_access: 'building access', move_logistics: 'moving in',
    general_property_fact: 'the building', pricing: 'rent', unit_availability: "what's available", tour_slot_availability: 'tour times',
    fair_housing: 'fair housing', reasonable_accommodation: 'an accommodation', eligibility_or_denial: 'eligibility',
    legal_question: 'a legal matter', dispute: 'a dispute', money_movement: 'a payment', protected_class_inquiry: 'a fair-housing matter',
    application_status: 'their application', account_status: 'their account', work_order_status: 'a work order',
  },
  availability: {
    stale: 'The availability list was out of date, so it re-checked before quoting',
    no_availability: 'Nothing available for what they want', bedroom_mismatch: 'No apartments with that many bedrooms',
    timing_mismatch: 'Nothing available for their move-in date',
  },
}
/** Own-property lookup: a server value of 'constructor' or '__proto__' falls to the fallback, never a prototype member. */
function label(map, key, fallback) {
  const k = String(key ?? '')
  if (map && hasOwn(map, k)) return map[k]
  return fallback === undefined ? text.humanise(k) : fallback
}
function endedPhrase(reason) {
  const r = String(reason ?? '')
  if (!r) return ''
  if (hasOwn(labels.ended, r)) return labels.ended[r]
  if (/error|failed|pipeline/i.test(r)) return 'The call dropped'
  return ''
}

// ---------------------------------------------------------------------------------------
// Icons — inline SVG, 24px viewBox, currentColor (Feather/Lucide outlines)
// ---------------------------------------------------------------------------------------

const ICON_PATHS = {
  today: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  calls: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  leads: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  status: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  person: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  slash: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v1H5z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.929 4.929.707.707"/><path d="M12 12v6"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  external: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  note: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  'cloud-off': '<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
}
ICON_PATHS.phone = ICON_PATHS.calls
const icons = {}
for (const name of Object.keys(ICON_PATHS)) {
  icons[name] = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`
}
const icon = (name) => (hasOwn(icons, String(name)) ? icons[name] : '')
/** `<span class="ico">svg</span>` — the inline form used everywhere in text and buttons. */
const ico = (name, cls = '') => `<span class="ico${cls ? ` ${cls}` : ''}">${icon(name)}</span>`

// ---------------------------------------------------------------------------------------
// State and events
// ---------------------------------------------------------------------------------------

const state = {
  calls: [], events: [], calendar: null, leads: null, health: null,
  updatedAt: null, errors: {}, callsError: null, callsConfigured: null,
  loaded: { calls: false, calendar: false, leads: false },
  lastGoodAt: {}, lastPollAt: null, failedRounds: 0, notConfigured: false, lastWriteError: null,
}
const listeners = {}
function on(ev, fn) {
  if (!listeners[ev]) listeners[ev] = []
  listeners[ev].push(fn)
  return () => { const i = listeners[ev].indexOf(fn); if (i >= 0) listeners[ev].splice(i, 1) }
}
function emit(ev, ...args) {
  for (const fn of [...(listeners[ev] || [])]) {
    try { fn(...args) } catch (e) { console.error(`Atrium '${ev}' listener failed`, e) }
  }
}
const arr = (v) => (Array.isArray(v) ? v : [])

// ---------------------------------------------------------------------------------------
// API — immutable document scope; only 401 ends authentication
// ---------------------------------------------------------------------------------------

let gated = false
let scopeEpoch = 0
const PROPERTY_ENDPOINTS = new Set(['/api/vapi', '/api/calendar', '/api/leads', '/api/vapi-sync'])
const propertyEndpoint = path => PROPERTY_ENDPOINTS.has(String(path).split('?')[0])
const JSON_HEADERS = { accept: 'application/json' }
function accessError(message, status = 409) { const error = new Error(message); error.status = status; error.propertyAccess = true; return error }
function invalidateDocument(message, status = 409) {
  if (!documentAccessIssue) {
    documentAccessIssue = { message, status }; scopeEpoch += 1; stopPolling()
    for (const name of Object.keys(seq)) { seq[name] += 1; sig[name] = '' }
    Object.assign(state, { calls: [], events: [], calendar: null, leads: null, callsError: null, callsConfigured: null,
      loaded: { calls: false, calendar: false, leads: false }, errors: {}, lastWriteError: null, lastGoodAt: {}, updatedAt: null })
    crCache = { key: null, value: [] }
    if (booted) {
      for (const item of [...dialogs]) item.close()
      for (const item of [...toasts]) item.close()
      for (const media of document.querySelectorAll('audio, video')) media.pause()
      // Retire every view, including hidden views with cached caller details. A new
      // authorized document is required; hash navigation must not revive them.
      for (const view of document.querySelectorAll('.view')) { view.hidden = true; view.replaceChildren() }
      const live = document.getElementById('live'); if (live) live.textContent = ''
      paintChrome()
    }
  }
  return accessError(message, status)
}
function checkResponseScope(data) {
  if (!databaseMode) return
  if (documentAccessIssue) throw accessError(documentAccessIssue.message, documentAccessIssue.status)
  const scope = data && data.scope
  if (!scope || scope.organizationId !== documentScope.organizationId || scope.propertyId !== documentScope.propertyId
    || scope.configurationVersion !== documentScope.configurationVersion || scope.permissionVersion !== documentScope.permissionVersion) {
    throw invalidateDocument('The property or your access changed. Reload this property before viewing or making changes.')
  }
}
function signedOut() { const e = new Error('Signed out'); e.signedOut = true; e.status = 401; return e }
function gate() {
  if (gated) return
  gated = true
  stopPolling()
  try { location.reload() } catch (e) { /* nothing else to do */ }
}
async function request(path, init) {
  if (gated) throw signedOut()
  const scoped = databaseMode && propertyEndpoint(path)
  if (scoped && documentAccessIssue) throw accessError(documentAccessIssue.message, documentAccessIssue.status)
  const epoch = scopeEpoch
  const headers = { ...(init && init.headers), ...(scoped ? {
    'x-atrium-organization-id': documentScope.organizationId, 'x-atrium-property-id': documentScope.propertyId,
    'x-atrium-config-version': String(documentScope.configurationVersion),
  } : {}) }
  let r
  try {
    r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, headers })
  } catch (e) {
    const err = new Error("Couldn't reach the server"); err.status = 0; err.network = true; throw err
  }
  if (r.status === 401) { if (databaseMode) invalidateDocument('Your session ended. Sign in again.', 401); gate(); throw signedOut() }
  let body = null, parsed = false
  try { body = await r.json(); parsed = true } catch (e) { parsed = false }
  if (scoped && epoch !== scopeEpoch) throw accessError('This response belongs to an earlier property session. Reload the property.')
  if (!r.ok) {
    if (scoped && r.status === 403) throw invalidateDocument('Access to this property or operation is no longer available. Choose a property you can access or reload to refresh your permissions.', 403)
    if (scoped && (r.status === 428 || (r.status === 409 && /property|configuration|scope/.test(String(body && body.code))))) {
      throw invalidateDocument('The property configuration changed. Reload this property before continuing.')
    }
    const msg = body && typeof body.error === 'string' ? body.error : `HTTP ${r.status}`
    if (r.status === 503 && /OPS_DASHBOARD_PASSCODE/.test(msg)) state.notConfigured = true
    const err = new Error(msg); err.status = r.status; err.body = body; throw err
  }
  if (!parsed || body === null || typeof body !== 'object') { const err = new Error('Unexpected response'); err.status = r.status; err.badJson = true; throw err }
  if (scoped) checkResponseScope(body)
  if (path.split('?')[0] === '/api/calendar') checkCalendarTimeZone(body)
  return body
}
function checkCalendarTimeZone(data) {
  let zone
  try { zone = validatedTimeZone(data.timeZone === undefined && !databaseMode ? LEGACY_TIME_ZONE : data.timeZone) }
  catch {
    const message = 'The calendar returned an invalid property timezone. Reload after the configuration is corrected.'
    if (databaseMode) throw invalidateDocument(message, 503)
    const error = new Error(message); error.status = 503; throw error
  }
  if (zone !== propertyTimeZone) {
    const message = 'The property timezone changed. Reload the portal before viewing or changing tours.'
    if (databaseMode) throw invalidateDocument(message)
    const error = new Error(message); error.status = 409; throw error
  }
}
const api = {
  get(path) { return request(path, { headers: JSON_HEADERS }) },
  async post(path, body, opts) {
    try {
      const endpoint = String(path).split('?')[0]
      const needed = endpoint === '/api/vapi-sync' || (endpoint === '/api/calendar' && body && body.action === 'settings') ? 'configure' : 'operate'
      if (propertyEndpoint(path) && !permissionAllowed(needed)) throw accessError('Your access is view only for this operation.', 403)
      if (endpoint === '/api/calendar') body = { ...body, ...calendarRequestRange(), expectedTimeZone: propertyTimeZone }
      return await request(path, {
        method: 'POST', headers: { ...JSON_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      })
    } catch (e) {
      if (!e.signedOut) {
        state.lastWriteError = { message: e.message, status: e.status ?? null, at: new Date().toISOString(), doing: (opts && opts.doing) || null }
      }
      throw e
    }
  },
}

// ---------------------------------------------------------------------------------------
// Polling — one round every 5 s, per-resource signatures, busy and seq guards
// ---------------------------------------------------------------------------------------

const RESOURCES = { calls: '/api/vapi', calendar: '/api/calendar', leads: '/api/leads' }
const sig = { calls: '', calendar: '', leads: '' }
const seq = { calls: 0, calendar: 0, leads: 0 }
const inflight = {}
const busyMap = {}
let pollTimer = null
let lastRoundAt = 0
let calendarRange = null
function calendarRequestRange() {
  const today = nyNow().ymd
  return calendarRange || { from: today, to: addDays(today, 14) }
}
function calendarUrl() { return `/api/calendar?${new URLSearchParams(calendarRequestRange())}` }
function calendarRangeMatches(data) {
  const wanted = calendarRequestRange()
  return !data.range || (data.range.from === wanted.from && data.range.to === wanted.to)
}
/** Range changes invalidate older reads; responses never move the operator's selected date. */
function setCalendarRange(range) {
  const next = range ? { from: range.from, to: range.to } : null
  if (JSON.stringify(next) === JSON.stringify(calendarRange)) return Promise.resolve()
  calendarRange = next
  seq.calendar += 1
  delete state.errors.calendar
  if (gated || busyMap.calendar) return Promise.resolve()
  return fetchOne('calendar').then((result) => {
    if (!result.dropped) { emit('data', state, new Set(['calendar'])); paintChrome() }
  })
}

/** The comparable shape of a resource: generatedAt and note never take part. */
function snapshot(name, d) {
  if (name === 'calls') return { calls: arr(d.calls), events: arr(d.events), callsError: d.callsError ?? null, callsConfigured: typeof d.callsConfigured === 'boolean' ? d.callsConfigured : null }
  if (name === 'calendar') return { slots: arr(d.slots), blocks: arr(d.blocks), bookings: arr(d.bookings), store: d.store ?? null,
    timeZone: d.timeZone ?? LEGACY_TIME_ZONE, range: d.range ?? null, settings: d.settings ?? null, settingsRevision: d.settingsRevision ?? null }
  return { profiles: arr(d.profiles), followUps: arr(d.followUps), outboundEnabled: d.outboundEnabled === true, store: d.store ?? null }
}
function assign(name, snap) {
  if (name === 'calls') { state.calls = snap.calls; state.events = snap.events; state.callsError = snap.callsError; state.callsConfigured = snap.callsConfigured }
  else if (name === 'calendar') state.calendar = snap
  else state.leads = snap
  state.loaded[name] = true
}
/** Replace a resource from a payload; true when its signature changed. */
function ingest(name, data) {
  checkResponseScope(data)
  if (name === 'calendar') checkCalendarTimeZone(data || {})
  const snap = snapshot(name, data || {})
  const s = JSON.stringify(snap)
  const changed = s !== sig[name]
  sig[name] = s
  assign(name, snap)
  return changed
}
async function fetchOne(name) {
  const mySeq = ++seq[name]
  inflight[name] = mySeq
  const hadError = Boolean(state.errors[name])
  try {
    const data = await api.get(name === 'calendar' ? calendarUrl() : RESOURCES[name])
    if (seq[name] !== mySeq || busyMap[name] || (name === 'calendar' && !calendarRangeMatches(data))) return { name, dropped: true }
    const changed = ingest(name, data)
    delete state.errors[name]
    state.lastGoodAt[name] = new Date().toISOString()
    return { name, ok: true, changed: changed || hadError }
  } catch (e) {
    if (gated || e.signedOut || seq[name] !== mySeq) return { name, dropped: true }
    state.errors[name] = { message: e.message, status: e.status ?? null, at: new Date().toISOString() }
    return { name, ok: false, changed: !hadError }
  } finally {
    if (inflight[name] === mySeq) inflight[name] = false
  }
}
async function pollRound(force) {
  if (gated) return
  if (document.hidden && !force) return
  lastRoundAt = Date.now()
  const names = Object.keys(RESOURCES).filter((n) => !busyMap[n] && !inflight[n])
  if (!names.length) return
  const results = await Promise.all(names.map(fetchOne))
  const settled = results.filter((r) => !r.dropped)
  if (!settled.length || gated) return
  const changed = new Set()
  for (const r of settled) if (r.changed) changed.add(r.name)
  const ok = settled.some((r) => r.ok)
  const now = new Date().toISOString()
  state.lastPollAt = now
  if (ok) { state.updatedAt = now; state.failedRounds = 0 } else state.failedRounds += 1
  if (changed.size) emit('data', state, changed)
  emit('poll', state, { changed, ok, failed: settled.filter((r) => !r.ok).map((r) => r.name) })
  paintChrome()
}
function startPolling() {
  if (pollTimer || gated || documentAccessIssue) return
  pollTimer = setInterval(() => { pollRound(false) }, 5000)
  pollRound(true)
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null }
function pollSoon() {
  if (gated || !pollTimer) return
  if (Date.now() - lastRoundAt < 1000) return
  pollRound(true)
}
async function fetchHealth() {
  try {
    const h = await api.get('/api/health')
    state.health = { ok: h.ok === true, store: String(h.store ?? ''), durable: h.durable === true, callHistory: h.callHistory === true, hint: String(h.hint ?? ''), at: new Date().toISOString() }
  } catch (e) { /* the health probe is optional; nothing on a normal day needs it */ }
}
function refresh() { return Promise.all([pollRound(true), fetchHealth()]).then(() => { paintChrome() }) }

function busy(resource, promise) {
  busyMap[resource] = (busyMap[resource] || 0) + 1
  paintBusy(resource)
  const p = Promise.resolve(promise)
  const done = () => {
    busyMap[resource] -= 1
    if (busyMap[resource] <= 0) delete busyMap[resource]
    paintBusy(resource)
    emit('busy', state, resource)
  }
  return p.then((v) => { done(); return v }, (e) => { done(); throw e })
}
const busyNow = (resource) => Boolean(busyMap[resource])
/** Buttons marked data-write="leads"|"calendar" are disabled while a write for that resource runs. */
function paintBusy(resource) {
  const on = busyNow(resource)
  for (const el of document.querySelectorAll(`[data-write="${resource}"]`)) {
    if (on) { if (!el.classList.contains('is-busy')) el.setAttribute('aria-disabled', 'true') }
    else el.removeAttribute('aria-disabled')
  }
  paintPermissions()
}
function apply(resource, data) {
  checkResponseScope(data)
  if (resource === 'calendar' && data && !calendarRangeMatches(data)) return
  seq[resource] += 1
  const d = data || {}
  if (resource === 'calendar') {
    const cur = state.calendar || { slots: [], blocks: [], bookings: [], store: null }
    ingest('calendar', {
      scope: d.scope,
      slots: Array.isArray(d.slots) ? d.slots : cur.slots, blocks: Array.isArray(d.blocks) ? d.blocks : cur.blocks,
      bookings: Array.isArray(d.bookings) ? d.bookings : cur.bookings, store: d.store ?? cur.store,
      timeZone: d.timeZone ?? cur.timeZone ?? LEGACY_TIME_ZONE,
      range: d.range ?? cur.range, settings: d.settings ?? cur.settings, settingsRevision: d.settingsRevision ?? cur.settingsRevision,
    })
  } else if (resource === 'leads') {
    const cur = state.leads || { profiles: [], followUps: [], outboundEnabled: false, store: null }
    let profiles = Array.isArray(d.profiles) ? d.profiles : cur.profiles.slice()
    let followUps = Array.isArray(d.followUps) ? d.followUps : cur.followUps.slice()
    if (d.followUp && typeof d.followUp === 'object' && d.followUp.id != null) {
      const i = followUps.findIndex((f) => f && f.id === d.followUp.id)
      if (i >= 0) followUps[i] = d.followUp; else followUps.push(d.followUp)
      followUps = followUps.slice().sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    }
    if (d.profile && typeof d.profile === 'object' && d.profile.phone != null) {
      const i = profiles.findIndex((p) => p && p.phone === d.profile.phone)
      if (i >= 0) profiles[i] = d.profile; else profiles.unshift(d.profile)
    }
    ingest('leads', { scope: d.scope, profiles, followUps, outboundEnabled: typeof d.outboundEnabled === 'boolean' ? d.outboundEnabled : cur.outboundEnabled, store: d.store ?? cur.store })
  } else if (resource === 'calls') {
    ingest('calls', d)
  } else return
  delete state.errors[resource]
  state.lastGoodAt[resource] = new Date().toISOString()
  emit('data', state, new Set([resource]))
  paintChrome()
}

// ---------------------------------------------------------------------------------------
// Routing and views
// ---------------------------------------------------------------------------------------

const VIEWS = ['today', 'calls', 'leads', 'calendar', 'status']
const VIEW_LABEL = { today: 'Today', calls: 'Calls', leads: 'Leads', calendar: 'Calendar', status: 'Status' }
const VIEW_H1 = { today: 'Today', calls: 'Calls', leads: 'Leads', calendar: 'Tour calendar', status: 'Status' }
const modules = {}
let current = null
let booted = false

function route() {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(location.hash || '')
  if (!m || !VIEWS.includes(m[1])) return { name: 'today', params: {} }
  const params = {}
  try { for (const [k, v] of new URLSearchParams(m[2] || '')) params[k] = v } catch (e) { /* malformed query → no params */ }
  return { name: m[1], params }
}
function hashFor(name, params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return `#/${VIEWS.includes(name) ? name : 'today'}${s ? `?${s}` : ''}`
}
function navigate(name, params, opts) {
  const hash = hashFor(name, params)
  if (hash === location.hash) { applyRoute(); return }
  try {
    if (opts && opts.replace) history.replaceState(null, '', hash)
    else history.pushState(null, '', hash)
  } catch (e) { location.hash = hash; return }
  applyRoute()
}
function register(name, module) {
  if (!VIEWS.includes(name) || !module) return
  modules[name] = { module, mounted: false, root: null }
  if (booted && current && current.name === name) showView(current, false)
}
const viewRoot = (name) => document.querySelector(`.view[data-view="${name}"]`)
function placeholderView(name) {
  const rows = []
  for (let i = 0; i < 4; i++) rows.push('<div class="skeleton-row"></div>')
  return `<div class="view-placeholder"><div class="view-head"><h1 tabindex="-1">${esc(VIEW_H1[name])}</h1></div>` +
    `<div class="skeleton" aria-busy="true"><span class="vh">Loading…</span>${rows.join('')}</div>` +
    `<p class="faint" style="margin-top:12px">Loading…</p></div>`
}
function showView(r, moveFocus) {
  if (documentAccessIssue) return
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.dataset.view !== r.name
  for (const a of document.querySelectorAll('.nav-item')) {
    if (a.dataset.view === r.name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  }
  const bv = document.getElementById('brand-view')
  if (bv) bv.textContent = `· ${VIEW_LABEL[r.name]}`
  const root = viewRoot(r.name)
  const entry = modules[r.name]
  if (root && entry) {
    if (!entry.mounted) {
      entry.mounted = true; entry.root = root; root.innerHTML = ''; delete root.dataset.placeholder
      try { entry.module.mount(root) } catch (e) { console.error(`mount(${r.name}) failed`, e) }
    }
    try { entry.module.render(state) } catch (e) { console.error(`render(${r.name}) failed`, e) }
  } else if (root && !root.dataset.placeholder) {
    root.dataset.placeholder = '1'
    root.innerHTML = placeholderView(r.name)
  }
  if (moveFocus && root) {
    // a modal dialog keeps focus while it is open (its close handler then lands on this view's heading)
    const h1 = root.querySelector('h1')
    if (h1 && !dialogs.length) { if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1'); try { h1.focus({ preventScroll: false }) } catch (e) { /* ignore */ } }
    announce(VIEW_LABEL[r.name])
  }
}
function applyRoute() {
  const r = route()
  const prev = current
  current = r
  if (r.name !== 'calendar') setCalendarRange(null)
  const switched = !prev || prev.name !== r.name
  showView(r, switched && Boolean(prev))
  if (switched) window.scrollTo({ top: 0, behavior: 'auto' })
  emit('route', r)
}
function announce(msg) {
  const el = document.getElementById('live')
  if (!el) return
  el.textContent = ''
  setTimeout(() => { el.textContent = String(msg ?? '') }, 30)
}

// ---------------------------------------------------------------------------------------
// Chrome: nav badges, status cluster, date line, global banners
// ---------------------------------------------------------------------------------------

function statusRows() {
  const leadsStore = state.leads && state.leads.store
  const calStore = state.calendar && state.calendar.store
  const savingOff = (s) => Boolean(s) && s.durable === false
  const kvUnreachable = (s) => Boolean(s) && s.kind === 'kv' && s.durable === false
  const rows = {
    leadsSaving: !state.loaded.leads ? null : (savingOff(leadsStore) ? (kvUnreachable(leadsStore) ? 'temp' : 'off') : 'on'),
    calendarSaving: !state.loaded.calendar ? null : (savingOff(calStore) ? (kvUnreachable(calStore) ? 'temp' : 'off') : 'on'),
    recordings: !state.loaded.calls ? null : (state.callsConfigured === false ? 'off' : (state.callsError ? 'down' : 'on')),
    reconnecting: state.failedRounds >= 2,
  }
  rows.ok = rows.leadsSaving !== 'off' && rows.leadsSaving !== 'temp' && rows.calendarSaving !== 'off' && rows.calendarSaving !== 'temp' &&
    rows.recordings !== 'off' && rows.recordings !== 'down' && !rows.reconnecting && !state.notConfigured
  return rows
}
function badgeFor(name) {
  const entry = modules[name]
  if (entry && typeof entry.module.badge === 'function') {
    try { const n = entry.module.badge(state); if (n != null) return Number(n) || 0 } catch (e) { /* fall through */ }
  }
  if (name === 'today') return derive.needsPerson(state).length
  if (name === 'leads') return derive.dueTodayCount(state)
  if (name === 'calendar') return derive.toursOn(state, nyNow().ymd).length
  return 0
}
function paintChrome() {
  const account = window.ATRIUM_ACCOUNT
  document.title = `Atrium — ${property.name}`
  document.querySelectorAll('[data-property-name]').forEach(node => { node.textContent = property.name })
  document.querySelectorAll('[data-property-location]').forEach(node => { node.textContent = property.locationLabel ? `/ ${property.locationLabel}` : '' })
  document.querySelectorAll('[data-workspace-name]').forEach(node => { node.textContent = databaseMode ? property.name : account ? account.displayName : property.name })
  document.querySelectorAll('[data-property-switch]').forEach(node => { node.hidden = !databaseMode })
  document.querySelectorAll('[data-view-only]').forEach(node => { node.hidden = !databaseMode || permissionAllowed('operate') })
  if (account) {
    document.querySelectorAll('[data-account-name]').forEach((node) => { node.textContent = account.username })
    document.querySelectorAll('[data-account-avatar]').forEach(node => { node.textContent = String(account.displayName || account.username || 'A').trim().slice(0, 1).toUpperCase() })
  }
  paintPermissions()
  const needs = derive.needsPerson(state)
  const live = needs.some((n) => n.type === 'emergency')
  const badges = {
    today: { n: badgeFor('today'), cls: live ? 'badge-danger' : 'badge-warn', label: (n) => `${n} need a person` },
    leads: { n: badgeFor('leads'), cls: '', label: (n) => `${n} to do today` },
    calendar: { n: badgeFor('calendar'), cls: '', label: (n) => `${n} tours today` },
  }
  for (const [name, b] of Object.entries(badges)) {
    const host = document.querySelector(`[data-badge="${name}"]`)
    if (!host) continue
    host.innerHTML = b.n > 0 ? `<span class="badge ${b.cls}" aria-label="${esc(b.label(b.n))}">${b.n}</span>` : ''
  }
  const rows = statusRows()
  const dot = document.querySelector('[data-badge="status"]')
  if (dot) dot.innerHTML = rows.ok ? '' : '<span class="nav-dot" role="img" aria-label="Something needs attention"></span>'
  paintCluster(rows)
  const dateEl = document.getElementById('brand-date')
  if (dateEl) dateEl.textContent = fmt.dayLong(nyNow().ymd)
  paintGlobalBanners()
}
function paintCluster(rows) {
  const el = document.getElementById('cluster')
  if (!el) return
  const at = state.updatedAt ? fmt.time(state.updatedAt) : ''
  let iconName = 'refresh', l1 = 'Loading…', l2 = '', mobile = 'Loading…', cls = ''
  const anyLoaded = state.loaded.leads || state.loaded.calendar || state.loaded.calls
  if (rows.reconnecting) { iconName = 'refresh'; l1 = 'Trying to reconnect…'; l2 = at ? `Showing what we had at ${at}` : ''; mobile = 'Reconnecting…'; cls = 'cluster-warn' }
  else if (anyLoaded && (rows.leadsSaving === 'off' || rows.leadsSaving === 'temp' || rows.calendarSaving === 'off' || rows.calendarSaving === 'temp')) {
    iconName = 'cloud-off'; l1 = isDemo && !isPersistentDemo ? 'Demo workspace' : "Changes aren't being saved"; l2 = isDemo && !isPersistentDemo ? 'Sample data resets on restart' : at ? `Updated ${at}` : ''; mobile = isDemo && !isPersistentDemo ? 'Demo' : 'Not saving'; cls = isDemo && !isPersistentDemo ? '' : 'cluster-warn'
  } else if (anyLoaded) { iconName = 'check-circle'; l1 = isPersistentDemo ? 'Local demo workspace' : 'Changes are being saved'; l2 = isPersistentDemo ? 'Sample data saved locally' : at ? `Updated ${at}` : ''; mobile = isPersistentDemo ? 'Local demo' : at ? `Updated ${at}` : 'Updated'; cls = 'cluster-ok' }
  el.innerHTML = `<span class="cluster-desk ${cls}">${ico(iconName)}<span><span class="cluster-l1">${esc(l1)}</span>${l2 ? `<span class="cluster-l2">${esc(l2)}</span>` : ''}</span></span>` +
    `<span class="cluster-mobile ${cls}">${ico(iconName)}<span>${esc(mobile)}</span></span>`
  el.setAttribute('aria-label', l2 ? `${l1}${/[.…!?]$/.test(l1) ? '' : '.'} ${l2}` : l1)
}
function paintGlobalBanners() {
  const host = document.getElementById('global-banners')
  if (!host) return
  const html = documentAccessIssue ? html_.banner('warn', documentAccessIssue.message, { actionsHtml:
    `<a class="btn" href="${esc(propertyUrl(documentScope))}">Reload property</a><a class="btn btn-quiet" href="/api/dashboard">Choose a property</a>` })
    : state.notConfigured ? html_.banner('warn', "This page isn't set up yet. Ask Atrium support.") : ''
  if (host.innerHTML !== html) host.innerHTML = html
}

/** UI affordances follow bootstrap permissions; the server independently authorizes writes. */
function paintPermissions(root = document) {
  if (!databaseMode || typeof root.querySelectorAll !== 'function') return
  for (const control of root.querySelectorAll('[data-write], [data-permission]')) {
    const permission = control.dataset.permission || 'operate'
    const allowed = permissionAllowed(permission)
    if (!allowed) { control.hidden = true; control.setAttribute('aria-disabled', 'true'); if ('disabled' in control) control.disabled = true }
  }
  if (root === document && document.body.classList) {
    document.body.classList.toggle('portal-read-only', !permissionAllowed('operate'))
    document.body.classList.toggle('portal-no-configure', !permissionAllowed('configure'))
  }
}

function propertyUrl(scope) {
  if (!scopeIdentity(scope)) return '/api/dashboard'
  return `/api/dashboard?${new URLSearchParams({ organizationId: scope.organizationId, propertyId: scope.propertyId })}`
}

async function openPropertySwitcher() {
  if (!databaseMode) return
  let list
  const panel = dialog({ title: 'Switch property', secondary: { label: 'Close' }, build(body) {
    list = document.createElement('div'); list.className = 'property-list'; list.textContent = 'Loading your properties…'; body.append(list)
  } })
  try {
    const result = await api.get('/api/properties')
    if (!Array.isArray(result.properties)) throw new Error('The property list could not be verified.')
    const seen = new Set()
    const properties = result.properties.map(item => {
      const selection = { organizationId: item && item.organizationId, propertyId: item && item.id }
      if (!scopeIdentity(selection) || !displayText(item.name) || !item.name.trim() || !displayText(item.organizationName)
        || seen.has(propertyUrl(selection))) throw new Error('The property list could not be verified.')
      seen.add(propertyUrl(selection))
      return { ...selection, name: item.name, organizationName: item.organizationName }
    })
    list.innerHTML = properties.length ? properties.map(item => {
      const current = item.organizationId === documentScope.organizationId && item.propertyId === documentScope.propertyId
      return `<a class="property-choice${current ? ' is-current' : ''}" href="${esc(propertyUrl(item))}"${current ? ' aria-current="page"' : ''}><span><strong>${esc(item.name)}</strong><small>${esc(item.organizationName)}</small></span><span>${current ? 'Current property' : 'Open property'} ${ico('chevron-right')}</span></a>`
    }).join('') : '<p class="muted">You do not currently have access to any properties. Contact your administrator.</p>'
  } catch (error) { list.textContent = ''; panel.setError(error.message || 'The property list is unavailable.') }
}

// ---------------------------------------------------------------------------------------
// Small HTML builders (everything passed in is escaped here), hints, Esc stack
// ---------------------------------------------------------------------------------------

const html_ = {
  chip(cls, iconName, txt) { return `<span class="chip ${esc(cls)}">${iconName ? ico(iconName) : ''}<span>${esc(txt)}</span></span>` },
  banner(kind, txt, opts) {
    const o = opts || {}
    const iconName = o.icon || (kind === 'danger' ? 'siren' : kind === 'warn' ? 'warning' : 'info')
    const extra = o.attrs || ''
    return `<div class="banner banner-${esc(kind)}"${extra}>${ico(iconName)}<div class="banner-body">${o.raw ? o.raw : esc(txt)}${o.actionsHtml ? `<div class="banner-actions">${o.actionsHtml}</div>` : ''}</div></div>`
  },
  empty(o) {
    return `<div class="empty">${o.icon ? ico(o.icon) : ''}<div class="empty-title">${esc(o.title)}</div>${o.text ? `<div class="empty-text">${esc(o.text)}</div>` : ''}${o.actionHtml || ''}</div>`
  },
  skeletonRows(n) {
    const rows = []
    for (let i = 0; i < (n || 3); i++) rows.push('<div class="skeleton-row"></div>')
    return `<div class="skeleton" aria-busy="true"><span class="vh">Loading…</span>${rows.join('')}</div>`
  },
}
function hint(key) {
  const k = preferenceKey(`hint.${String(key)}`)
  try {
    if (localStorage.getItem(k)) return false
    localStorage.setItem(k, '1')
    return true
  } catch (e) { return true }
}
const preferenceIdentity = databaseMode ? JSON.stringify([documentScope.organizationId, documentScope.propertyId, window.ATRIUM_ACCOUNT?.userId || '']) : window.ATRIUM_ACCOUNT?.tenantId || 'legacy'
function preferenceKey(key) {
  const identity = preferenceIdentity
  return `atrium.${identity}.${String(key)}`
}
const escStack = []
const escape_ = {
  push(fn) { if (typeof fn === 'function') escStack.push(fn) },
  remove(fn) { const i = escStack.lastIndexOf(fn); if (i >= 0) escStack.splice(i, 1) },
}

// ---------------------------------------------------------------------------------------
// Toasts (§12.3)
// ---------------------------------------------------------------------------------------

const TOAST_MS = { ok: 5000, info: 5000, warn: 8000, error: 10000 }
const TOAST_ICON = { ok: 'check', info: 'info', warn: 'warning', error: 'x' }
const toasts = []
function toast(txt, opts) {
  const o = opts || {}
  const kind = hasOwn(TOAST_MS, String(o.kind)) ? o.kind : 'info'
  const stack = document.getElementById('toasts')
  if (!stack) return { el: null, close() {}, update() {} }
  if (o.key) for (const t of toasts.slice()) if (t.key === o.key) t.close()
  const actions = arr(o.actions).slice(0, 2)
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  const handle = { el, key: o.key || null, close, update }
  let timer = null, remaining = 0, startedAt = 0
  const ms = o.sticky ? Infinity : Math.max(Number(o.ms) || TOAST_MS[kind], actions.length ? 8000 : 0)
  function paint(t, acts) {
    el.innerHTML = `<span class="toast-icon">${icon(TOAST_ICON[kind])}</span><span class="toast-text">${esc(t)}</span>` +
      (acts.length ? `<span class="toast-actions">${acts.map((a, i) => `<button type="button" class="btn-link toast-action" data-i="${i}">${esc(a.label)}</button>`).join('')}</span>` : '') +
      `<button type="button" class="toast-close btn-icon" aria-label="Close">${icon('x')}</button>`
    el.querySelector('.toast-close').addEventListener('click', close)
    el.querySelectorAll('.toast-action').forEach((b) => {
      b.addEventListener('click', () => {
        const a = acts[Number(b.dataset.i)]
        if (!a || typeof a.fn !== 'function') { close(); return }
        let result
        try { result = a.fn() } catch (e) { result = Promise.reject(e) }
        if (!(result && typeof result.then === 'function')) { close(); return }
        const isUndo = /^undo$/i.test(String(a.label))
        pause()
        b.textContent = a.busyLabel || (isUndo ? 'Undoing…' : `${a.label}…`)
        b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-disabled', 'true')
        // a repaint replaces the button the keyboard user is on; keep them in the toast (its Close)
        const keep = () => { if (el.contains(document.activeElement) || document.activeElement === document.body) { const c = el.querySelector('.toast-close'); if (c) { try { c.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } } }
        result.then(() => {
          if (isUndo || a.doneText) { paint(a.doneText || 'Undone', []); el.className = 'toast toast-ok'; arm(4000); keep() } else close()
        }, () => {
          if (isUndo) { paint("Couldn't undo that. Nothing changed.", []); el.className = 'toast toast-error'; arm(TOAST_MS.error); keep() } else close()
        })
      })
    })
  }
  function arm(t) { clearTimeout(timer); remaining = t; if (t === Infinity) return; startedAt = Date.now(); timer = setTimeout(close, t) }
  function pause() { if (timer) { clearTimeout(timer); timer = null; remaining = Math.max(1500, remaining - (Date.now() - startedAt)) } }
  function resume() { if (!timer && remaining !== Infinity && el.isConnected) arm(remaining) }
  function close() {
    clearTimeout(timer)
    const i = toasts.indexOf(handle); if (i >= 0) toasts.splice(i, 1)
    const hadFocus = el.contains(document.activeElement)
    if (el.isConnected) el.remove()
    // closing the toast under the keyboard user: the newest remaining toast, else the view's heading
    if (hadFocus) {
      const next = toasts.length ? toasts[toasts.length - 1].el : null
      const target = (next && (next.querySelector('.toast-action') || next.querySelector('.toast-close'))) || document.querySelector('.view:not([hidden]) h1')
      if (target) { try { target.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
    }
  }
  function update(t, u) { paint(t, arr(u && u.actions).slice(0, 2)); if (u && u.kind) el.className = `toast toast-${u.kind}`; arm(u && u.sticky ? Infinity : (Number(u && u.ms) || ms)) }
  el.addEventListener('mouseenter', pause); el.addEventListener('mouseleave', resume)
  el.addEventListener('focusin', pause); el.addEventListener('focusout', resume)
  paint(txt, actions)
  stack.appendChild(el)
  toasts.push(handle)
  while (toasts.length > 3) toasts[0].close()
  arm(ms)
  return handle
}

// ---------------------------------------------------------------------------------------
// Dialogs (§12.5) — one implementation behind confirm, prompt and module sheets
// ---------------------------------------------------------------------------------------

const dialogs = []
let dialogSeq = 0
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function dialog(spec) {
  const o = spec || {}
  const host = document.getElementById('dialogs') || document.body
  // The opener is remembered by reference AND by its data-key + view: a view that repaints while
  // the dialog is open (Status every poll, any list a colleague changes) replaces the button, and
  // focus must still land on its successor, not on <body>.
  const opener = document.activeElement
  const openerKey = opener && opener.dataset && opener.dataset.key ? opener.dataset.key : null
  const openerView = opener && opener.closest ? opener.closest('.view') : null
  const id = `dlg-title-${++dialogSeq}`
  const backdrop = document.createElement('div')
  backdrop.className = 'dlg-backdrop'
  const primary = o.primary || null
  const secondaryLabel = (o.secondary && o.secondary.label) || 'Cancel'
  backdrop.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="${id}">` +
    `<div class="dlg-handle" aria-hidden="true"></div>` +
    `<div class="dlg-head"><h3 class="dlg-title" id="${id}">${esc(o.title || '')}</h3><button type="button" class="btn-icon btn-quiet dlg-x" aria-label="Close">${icon('x')}</button></div>` +
    `<div class="dlg-body"></div>` +
    `<div class="dlg-error" role="alert" hidden>${ico('warning')}<span class="dlg-error-text"></span></div>` +
    `<div class="dlg-progress" aria-live="polite" hidden></div>` +
    `<div class="dlg-actions"><button type="button" class="btn dlg-secondary">${esc(secondaryLabel)}</button>` +
    (primary ? `<button type="button" class="btn ${primary.danger ? 'btn-danger' : 'btn-primary'} dlg-primary" aria-live="polite">${esc(primary.label || 'OK')}</button>` : '') +
    `</div></div>`
  const el = backdrop.querySelector('.dlg')
  const body = el.querySelector('.dlg-body')
  const errEl = el.querySelector('.dlg-error')
  const progEl = el.querySelector('.dlg-progress')
  const primaryBtn = el.querySelector('.dlg-primary')
  const secondaryBtn = el.querySelector('.dlg-secondary')
  let closed = false, busyText = null
  const api_ = {
    el, body,
    close() {
      if (closed) return
      closed = true
      const i = dialogs.indexOf(api_); if (i >= 0) dialogs.splice(i, 1)
      backdrop.remove()
      if (!dialogs.length) document.body.classList.remove('has-dialog')
      // An opener that now sits in a hidden view (the hash changed while the dialog was open) cannot
      // take focus; it counts as gone, and the same key is looked for in the view that is showing.
      const visible = (el) => Boolean(el) && !el.closest('.view[hidden]')
      let back = opener && typeof opener.focus === 'function' && opener.isConnected && opener !== document.body && visible(opener) ? opener : null
      if (!back && openerKey) {
        const v = (openerView && openerView.isConnected && !openerView.hidden ? openerView : null) || document.querySelector('.view:not([hidden])')
        back = v ? v.querySelector(`[data-key="${cssq(openerKey)}"]`) : null
      }
      const viewH1 = () => { const v = document.querySelector('.view:not([hidden])'); return v ? v.querySelector('h1') : null }
      if (!back) back = viewH1()
      if (back) { try { back.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
      // last resort: focus that landed nowhere (on <body>, or somewhere not on screen) goes to the view's heading
      const a = document.activeElement
      if (!a || a === document.body || !a.closest('.view:not([hidden]), .side, .toast-stack, .dlg')) { const h = viewH1(); if (h) { try { h.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
      if (typeof o.onClose === 'function') { try { o.onClose() } catch (e) { console.error(e) } }
    },
    setPrimary(p) {
      if (!primaryBtn) return
      if (p && p.label != null) primaryBtn.textContent = String(p.label)
      if (p && p.disabled != null) { if (p.disabled) primaryBtn.setAttribute('aria-disabled', 'true'); else primaryBtn.removeAttribute('aria-disabled') }
      if (p && p.danger != null) { primaryBtn.classList.toggle('btn-danger', Boolean(p.danger)); primaryBtn.classList.toggle('btn-primary', !p.danger) }
    },
    setBusy(t) {
      busyText = t == null ? null : String(t)
      if (!primaryBtn) return
      if (busyText != null) { primaryBtn.textContent = busyText; primaryBtn.setAttribute('aria-busy', 'true'); primaryBtn.setAttribute('aria-disabled', 'true'); secondaryBtn.setAttribute('aria-disabled', 'true') }
      else { primaryBtn.removeAttribute('aria-busy'); primaryBtn.removeAttribute('aria-disabled'); secondaryBtn.removeAttribute('aria-disabled') }
    },
    setError(t) {
      if (t == null || t === '') { errEl.hidden = true; errEl.querySelector('.dlg-error-text').textContent = '' }
      else { errEl.querySelector('.dlg-error-text').textContent = String(t); errEl.hidden = false }
    },
    setProgress(t) { if (t == null || t === '') { progEl.hidden = true; progEl.textContent = '' } else { progEl.textContent = String(t); progEl.hidden = false } },
    isBusy() { return busyText != null },
  }
  if (typeof o.build === 'function') { try { o.build(body, api_) } catch (e) { console.error('dialog build failed', e) } }
  if (primary && primary.disabled) primaryBtn.setAttribute('aria-disabled', 'true')
  const closeIfIdle = () => { if (busyText == null) api_.close() }
  el.querySelector('.dlg-x').addEventListener('click', closeIfIdle)
  secondaryBtn.addEventListener('click', () => {
    if (busyText != null) return
    if (o.secondary && typeof o.secondary.onClick === 'function') o.secondary.onClick(api_); else api_.close()
  })
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeIfIdle() })
  if (primaryBtn) primaryBtn.addEventListener('click', () => {
    if (busyText != null || primaryBtn.getAttribute('aria-disabled') === 'true') return
    if (typeof primary.onClick !== 'function') { api_.close(); return }
    let result
    try { result = primary.onClick(api_) } catch (e) { api_.setError(e && e.message ? e.message : 'Something went wrong.'); return }
    if (result && typeof result.then === 'function') {
      const label = primaryBtn.textContent
      api_.setBusy(primary.busyLabel || `${label.replace(/…$/, '')}…`)
      result.then(() => { if (!closed) api_.setBusy(null) }, (e) => { if (!closed) { api_.setBusy(null); if (e && e.message && !e.handled) api_.setError(e.message) } })
    }
  })
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeIfIdle(); return }
    if (e.key === 'Tab') {
      const items = [...el.querySelectorAll(FOCUSABLE)].filter((x) => !x.hidden && x.offsetParent !== null && x.getAttribute('aria-disabled') !== 'true')
      if (!items.length) { e.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  })
  host.appendChild(backdrop)
  dialogs.push(api_)
  document.body.classList.add('has-dialog')
  const firstField = body.querySelector('input:not([type="hidden"]), select, textarea')
  const target = firstField || (o.focusPrimary && primaryBtn) || secondaryBtn
  try { target.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
  return api_
}
function confirm(txt, opts) {
  const o = opts || {}
  return new Promise((resolve) => {
    let yes = false
    dialog({
      title: o.title || 'Are you sure?',
      build(body) { body.innerHTML = `<p class="prose">${esc(txt)}</p>` },
      primary: { label: o.confirmLabel || 'OK', danger: Boolean(o.danger), onClick(d) { yes = true; d.close() } },
      onClose() { resolve(yes) },
    })
  })
}
function prompt(txt, opts) {
  const o = opts || {}
  return new Promise((resolve) => {
    let value = null
    const inputId = `dlg-input-${++dialogSeq}`
    const maxLength = Number(o.maxLength) > 0 ? Number(o.maxLength) : 500
    dialog({
      title: o.title || '',
      build(body, d) {
        body.innerHTML = (o.intro ? `<p class="prose">${esc(o.intro)}</p>` : '') + `<div class="field"><label class="field-label" for="${inputId}">${esc(txt)}</label>` +
          `<input class="input" id="${inputId}" type="text" maxlength="${maxLength}" placeholder="${esc(o.placeholder || '')}" value="${esc(o.value || '')}" autocomplete="off"></div>`
        const input = body.querySelector('input')
        const check = () => d.setPrimary({ disabled: Boolean(o.required) && !input.value.trim() })
        input.addEventListener('input', check)
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (!(o.required && !input.value.trim())) { value = input.value.trim(); d.close() } }
        })
        setTimeout(check, 0)
        setTimeout(() => { try { input.select() } catch (e) { /* ignore */ } }, 0)
      },
      primary: { label: o.confirmLabel || 'OK', danger: Boolean(o.danger), disabled: Boolean(o.required) && !(o.value || '').trim(),
        onClick(d) { value = d.body.querySelector('input').value.trim(); d.close() } },
      onClose() { resolve(value) },
    })
  })
}

// Global keys: Esc closes topmost popover/panel (module handlers) then the newest toast;
// `/` focuses the active view's search box when focus is not in a field.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable)
  if (e.key === 'Escape') {
    if (dialogs.length) return
    for (let i = escStack.length - 1; i >= 0; i--) {
      let handled = false
      try { handled = escStack[i](e) === true } catch (err) { console.error(err) }
      if (handled) { e.preventDefault(); return }
    }
    if (toasts.length) { toasts[toasts.length - 1].close(); e.preventDefault() }
    return
  }
  if (e.key === '/' && !inField && !e.ctrlKey && !e.metaKey && !e.altKey && !dialogs.length) {
    const box = document.querySelector('.view:not([hidden]) input[data-key="search"]')
    if (box) { e.preventDefault(); box.focus(); try { box.select() } catch (err) { /* ignore */ } }
  }
})

// ---------------------------------------------------------------------------------------
// derive — pure functions over Atrium.state (§5.3, §6, §7.2, §8.1, §8.4)
// ---------------------------------------------------------------------------------------

const profilesOf = (s) => arr(s.leads && s.leads.profiles)
const followUpsOf = (s) => arr(s.leads && s.leads.followUps)
function profileByPhone(s, phone) { return profilesOf(s).find((p) => p && p.phone === phone) || null }
function profileForCall(s, callId) { return profilesOf(s).find((p) => p && arr(p.calls).some((c) => c && c.callId === callId)) || null }
const callAt = (profile, callId) => { const c = profile && arr(profile.calls).find((x) => x && x.callId === callId); return c ? c.at : null }

function personName(profile) {
  if (profile && profile.name) return String(profile.name)
  const ph = profile && profile.phone
  const shown = fmt.phone(ph)
  return shown ? `the caller from ${shown}` : 'the caller with a hidden number'
}
function displayName(profile) {
  if (profile && profile.name) return String(profile.name)
  const shown = fmt.phone(profile && profile.phone)
  return shown || 'Callers with hidden numbers'
}
function windowStart() {
  const y = addDays(nyNow().ymd, -1)
  return new Date(nyInstant(y, 18, 0)).toISOString()
}
function lossText(reason) {
  if (!reason) return ''
  const phrase = label(labels.lossReason, reason.kind)
  const detail = text.staff(reason.detail || '').trim()
  return detail ? `${phrase} — ${detail}` : phrase
}
function escalationText(esc_, fallbackDetail) {
  const detail = String((esc_ && esc_.detail) ?? fallbackDetail ?? '').trim()
  const trigger = String((esc_ && esc_.trigger) ?? 'other')
  const words = detail ? detail.split(/\s+/).length : 0
  const phrase = label(labels.trigger, trigger, /^restricted:/.test(trigger) || trigger === 'other' ? 'something only a person can answer' : 'something only a person can answer')
  const reassurance = label(labels.reassurance, trigger, 'The assistant passed this to a person.')
  if (detail && (detail.endsWith('?') || words >= 4)) return { headline: `asked "${text.truncate(detail, 90)}"`, quote: null, reassurance, phrase, detail }
  return { headline: `asked about ${phrase}`, quote: detail || null, reassurance, phrase, detail }
}
const escalationFor = (profile, callId) => {
  const list = arr(profile && profile.escalations)
  return list.find((e) => e && e.callId === callId) || (list.length ? list[list.length - 1] : null)
}
/**
 * What the assistant did about an emergency, said only as far as it can be shown. With a transcript,
 * the assistant's own lines decide (911 and leave / 911 / neither); without one, the fixed safety
 * instruction the server gives for that kind (src/escalation/emergency.ts) — gas, smoke or fire and
 * carbon monoxide say leave and call 911, an injury or intruder says call 911, and flooding, no heat
 * or structural damage give other instructions, so those are only "treated it as an emergency".
 */
const LEAVE_AND_911 = ['gas', 'smoke_or_fire', 'carbon_monoxide'], CALL_911 = ['injury', 'intruder']
function emergencyAction(kind, transcript) {
  const t = String(transcript ?? '')
  if (t.trim()) {
    const assistant = t.split('\n').filter((l) => /^AI:/.test(l)).join('\n')
    const said911 = /\b911\b/.test(assistant)
    const saidLeave = /\b(?:leave the (?:apartment|building)|get (?:everyone )?out|outside)\b/i.test(assistant)
    if (said911 && saidLeave) return 'The assistant told them to leave and call 911.'
    if (said911) return 'The assistant told them to call 911.'
    return 'The assistant treated it as an emergency.'
  }
  const k = String(kind ?? '')
  if (LEAVE_AND_911.includes(k)) return 'The assistant told them to leave and call 911.'
  if (CALL_911.includes(k)) return 'The assistant told them to call 911.'
  return 'The assistant treated it as an emergency.'
}
/** Which needs-a-person item, if any, is open for a phone (used by displayStage and the flag chip). */
function openItemsFor(s, phone) { return needsPerson(s).filter((n) => n.phone === phone) }
function displayStage(profile, s) {
  const stage = String((profile && profile.stage) ?? '')
  const out = { key: stage, label: label(labels.stage, stage), chipClass: label(labels.stageChip, stage, 'chip-neutral'), icon: label(labels.stageIcon, stage, '') }
  // The clock does not establish attendance; keep the evidence-derived server stage.
  if (stage === 'escalated' && s && !openItemsFor(s, profile.phone).length) return { key: 'handled', label: 'Handled by a person', chipClass: 'chip-neutral', icon: 'check' }
  return out
}
const CALLBACK_RE = /could not handle: ([\s\S]*?)\. A person needs to call\.$/
function callbackQuestion(fu, profile) {
  const m = CALLBACK_RE.exec(String(fu.reason ?? ''))
  const esc_ = escalationFor(profile, fu.createdFromCall)
  const detail = m ? m[1] : (esc_ && esc_.detail) || ''
  const trigger = (esc_ && esc_.trigger) || 'other'
  return { detail, trigger, escalation: esc_ }
}
let npCache = { key: null, value: [] }
function needsPerson(s) {
  const key = `${sig.calls}|${sig.leads}|${Math.floor(Date.now() / 60000)}`
  if (npCache.key === key) return npCache.value
  const now = Date.now()
  const items = [], seen = new Set()
  const records = callRecords(s)
  const byId = new Map(records.map((r) => [r.id, r]))
  const emergencies = arr(s.events).filter((e) => e && e.kind === 'emergency' && now - (toTime(e.at) ?? 0) < DAY_MS)
  for (const e of emergencies.slice().sort((a, b) => (toTime(b.at) ?? 0) - (toTime(a.at) ?? 0))) {
    if (seen.has(e.callId)) continue
    seen.add(e.callId)
    const rec = byId.get(e.callId)
    const profile = (rec && rec.profile) || profileForCall(s, e.callId)
    const phone = (rec && rec.phone) || (profile && profile.phone) || 'unknown'
    items.push({ type: 'emergency', callId: e.callId, phone, name: (profile && profile.name) || null, profile,
      phrase: label(labels.emergency, e.emergencyKind, 'an emergency'), matched: String(e.matched ?? ''), at: e.at, sortAt: toTime(e.at) ?? 0,
      action: emergencyAction(e.emergencyKind, rec && rec.call && rec.call.transcript) })
  }
  const callbacks = followUpsOf(s).filter((f) => f && f.kind === 'callback' && f.status === 'scheduled')
    .sort((a, b) => (toTime(a.dueAt) ?? 0) - (toTime(b.dueAt) ?? 0))
  for (const fu of callbacks) {
    const profile = profileByPhone(s, fu.phone)
    const q = callbackQuestion(fu, profile)
    const calledAt = callAt(profile, fu.createdFromCall) || fu.createdAt
    const callId = (q.escalation && q.escalation.callId) || fu.createdFromCall
    if (seen.has(callId)) continue
    seen.add(callId)
    items.push({ type: 'callback', fu, profile, phone: fu.phone, name: (profile && profile.name) || null, question: q.detail, trigger: q.trigger,
      respondBy: fu.dueAt, calledAt, callId, at: calledAt, sortAt: toTime(fu.dueAt) ?? 0 })
  }
  const stuck = []
  for (const p of profilesOf(s)) {
    if (!p) continue
    const hasCallback = callbacks.some((f) => f.phone === p.phone)
    if (hasCallback) continue
    for (const b of arr(p.bookings)) {
      if (!b || (b.status !== 'failed' && b.status !== 'arranging')) continue
      const at = callAt(p, b.callId)
      if (at == null || now - (toTime(at) ?? 0) > 2 * DAY_MS) continue
      if (arr(p.bookings).some((o) => o && o.status === 'confirmed' && o.slotId === b.slotId)) continue
      if (seen.has(b.callId)) continue
      seen.add(b.callId)
      stuck.push({ type: 'stuckTour', booking: b, profile: p, phone: p.phone, name: p.name || null, calledAt: at, callId: b.callId, at, sortAt: toTime(at) ?? 0 })
    }
  }
  stuck.sort((a, b) => b.sortAt - a.sortAt)
  const value = items.filter((i) => i.type === 'emergency').concat(items.filter((i) => i.type === 'callback'), stuck)
  npCache = { key, value }
  return value
}
function callBackToday(s) {
  const today = nyNow().ymd
  return followUpsOf(s).filter((f) => f && f.status === 'scheduled' && f.kind !== 'callback' && (nyDate(f.dueAt) || '9999') <= today)
    .sort((a, b) => (toTime(a.dueAt) ?? 0) - (toTime(b.dueAt) ?? 0))
}
function dueTodayCount(s) {
  const today = nyNow().ymd
  return followUpsOf(s).filter((f) => f && f.status === 'scheduled' && (nyDate(f.dueAt) || '9999') <= today).length
}
function toursOn(s, ymd) {
  const now = Date.now()
  const cal = s.calendar
  const calLoaded = Boolean(cal)
  const calBookingIds = new Set(arr(cal && cal.bookings).map((b) => b && b.slotId))
  const out = [], seen = new Set()
  for (const p of profilesOf(s)) {
    for (const b of arr(p && p.bookings)) {
      if (!b || b.status !== 'confirmed' || nyDate(b.startsAt) !== ymd) continue
      if (calLoaded && !calBookingIds.has(b.slotId)) continue
      // Two tours can share a time (two model residences): dedupe per tour, not per time.
      const matches = arr(cal && cal.bookings).filter((x) => x && x.slotId === b.slotId && (x.unitId ?? '') === (b.unitId ?? ''))
      const cb = matches.find((x) => (p.phone && p.phone !== 'unknown' && x.prospectPhone === p.phone) || (p.name && x.prospectName === p.name)) || (matches.length === 1 ? matches[0] : null)
      const key = (cb && cb.externalId) || `${b.slotId}|${(b.unitId ?? '')}|${(p.name || '').trim()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ slotId: b.slotId, startsAt: (cb && cb.startsAt) || b.startsAt, endsAt: (cb && cb.endsAt) || null, name: p.name || (cb && cb.prospectName) || 'Tour', phone: p.phone, email: p.email || null,
        unitId: b.unitId ?? (cb && cb.unitId) ?? null, callId: b.callId, source: 'lead', profile: p, past: (toTime(b.startsAt) ?? 0) < now })
    }
  }
  // The staff calendar fetches only its displayed range. Saved bookings still cover every
  // date, so Today remains correct after someone browses a distant week or removes a lead.
  for (const b of arr(cal && cal.bookings)) {
    if (!b) continue
    const sl = arr(cal && cal.slots).find((slot) => slot && slot.slotId === b.slotId)
    const legacyStart = /^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.slotId || '') ? `${b.slotId.slice(5)}:00.000Z` : null
    const startsAt = b.startsAt || (sl && sl.startsAt) || legacyStart
    if (!startsAt || nyDate(startsAt) !== ymd) continue
    const name = String(b.prospectName ?? '').trim()
    const key = b.externalId || `${b.slotId}|${b.unitId ?? ''}|${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ slotId: b.slotId, startsAt, endsAt: b.endsAt || (sl && sl.endsAt) || null, name: name || 'Tour',
      phone: normalisePhone(b.prospectPhone) || null, email: b.prospectEmail || null,
      unitId: b.unitId ?? null, callId: null, source: 'calendar', profile: null, past: (toTime(startsAt) ?? 0) < now })
  }
  for (const sl of arr(cal && cal.slots)) {
    if (!sl || sl.date !== ymd) continue
    const onSlot = arr(sl.bookings).length ? arr(sl.bookings) : (sl.booking ? [sl.booking] : [])
    for (const b of onSlot) {
      if (!b || (b.startsAt && toTime(b.startsAt) !== toTime(sl.startsAt))) continue
      const name = String(b.prospectName ?? '').trim()
      const key = b.externalId || `${sl.slotId}|${(b.unitId ?? '')}|${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ slotId: sl.slotId, startsAt: b.startsAt || sl.startsAt, endsAt: b.endsAt || sl.endsAt, name: name || 'Tour', phone: null, email: null,
        unitId: b.unitId ?? null, callId: null, source: 'calendar', profile: null, past: (toTime(sl.startsAt) ?? 0) < now })
    }
  }
  return out.sort((a, b) => (toTime(a.startsAt) ?? 0) - (toTime(b.startsAt) ?? 0))
}

let crCache = { key: null, value: [] }
function callRecords(s) {
  const key = `${sig.calls}|${sig.leads}`
  if (crCache.key === key) return crCache.value
  const records = new Map()
  const byCallId = new Map()
  for (const p of profilesOf(s)) for (const c of arr(p && p.calls)) if (c && c.callId) byCallId.set(c.callId, { profile: p, summary: c })
  for (const call of arr(s.calls)) {
    if (!call || call.id == null) continue
    const id = String(call.id)
    const phone = normalisePhone(call.customerNumber)
    const known = byCallId.get(id)
    const profile = (known && known.profile) || profileByPhone(s, phone)
    records.set(id, { id, phone, profile, call, events: [], summary: (known && known.summary) || null, startedAt: call.startedAt || null, durationSeconds: call.durationSeconds ?? null })
  }
  for (const [id, { profile, summary }] of byCallId) {
    if (records.has(id)) continue
    const end = toTime(summary.at)
    const startedAt = end != null ? new Date(end - (Number(summary.durationSeconds) || 0) * 1000).toISOString() : null
    records.set(id, { id, phone: profile.phone, profile, call: null, events: [], summary, startedAt, durationSeconds: summary.durationSeconds ?? null })
  }
  const grouped = new Map()
  for (const e of arr(s.events)) {
    if (!e || e.callId == null) continue
    const id = String(e.callId)
    if (!grouped.has(id)) grouped.set(id, [])
    grouped.get(id).push(e)
  }
  for (const [id, evs] of grouped) {
    if (records.has(id)) { records.get(id).events = evs; continue }
    const profile = profileForCall(s, id)
    records.set(id, { id, phone: (profile && profile.phone) || 'unknown', profile, call: null, events: evs, summary: null, startedAt: evs[0].at || null, durationSeconds: null })
  }
  for (const r of records.values()) {
    r.name = (r.profile && r.profile.name) || null
    r.displayName = r.name || fmt.phone(r.phone) || 'Hidden number'
  }
  const value = [...records.values()].sort((a, b) => (toTime(b.startedAt) ?? -1) - (toTime(a.startedAt) ?? -1))
  crCache = { key, value }
  return value
}

// --- the story (§8.4) ---------------------------------------------------------------

const sizeWord = (v) => {
  const n = (v === 'studio' || v === 0 || v === '0') ? 0 : Number(v)
  if (v == null || v === '' || isNaN(n)) return null
  return n === 0 ? 'a studio' : `a ${n}-bedroom`
}
const sizeNoun = (v) => { const w = sizeWord(v); return w ? w.replace(/^a /, '') : null }
const bedroomsText = (v) => { const n = (v === 'studio' || v === '0' || v === 0) ? 0 : Number(v); return isNaN(n) ? String(v ?? '') : (n === 0 ? 'Studio or larger' : `${n} or more`) }
function moveInText(value) {
  if (value == null) return ''
  if (typeof value === 'string') {
    const day = value ? fmt.monthDay(value) : ''
    return day && day !== '—' ? `from ${day}` : ''
  }
  const a = value.earliest, b = value.latest
  if (a && b) return `${fmt.monthDay(a)} – ${fmt.monthDay(b)}`
  if (a) return `from ${fmt.monthDay(a)}`
  return ''
}
/** Preserve a stated minimum/range; a premium shopper never becomes priced out. */
function budgetText(value) {
  const amount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
  if (value && typeof value === 'object') {
    const min = amount(value.minMonthly), max = amount(value.maxMonthly)
    if (min != null && max != null && min <= max) return `${fmt.money(min)}–${fmt.money(max)}/mo`
    if (min != null && max == null) return `${fmt.money(min)}+/mo`
    if (max != null && min == null) return `up to ${fmt.money(max)}/mo`
    return ''
  }
  if (amount(value) != null) return `up to ${fmt.money(value)}/mo`
  // Older call events retain the caller's words, not a normalized budget range.
  return typeof value === 'string' ? value : ''
}
function factValue(signal, value) {
  if (signal === 'budget') return budgetText(value)
  if (signal === 'bedrooms') return bedroomsText(value)
  if (signal === 'moveInTiming') return moveInText(typeof value === 'object' ? value : String(value ?? '')) || String(value ?? '')
  return String(value ?? '')
}
const unitIdsIn = (s, re) => { const out = []; let m; const rx = new RegExp(re.source, 'gm'); while ((m = rx.exec(String(s ?? '')))) if (!out.includes(m[1])) out.push(m[1]); return out }
const apt = (id) => (id ? `apartment ${id}` : '')
function availabilityText(ev) {
  const o = String((ev && ev.outcome) ?? '')
  const ids = arr(ev && ev.unitsOffered)
  if (o === 'matches') return ids.length ? `Told them about ${text.list(ids)}` : "Checked what's available"
  if (o === 'priced_out') return `Nothing under ${fmt.money(ev.budgetMax)} — our lowest is ${fmt.money(ev.cheapestAvailable)}, so they're ${fmt.money(ev.gap)} short`
  if (hasOwn(labels.availability, o)) return labels.availability[o]
  if (o === 'unit_lookup') return `Looked up ${apt(ev.unitId)}`
  if (o === 'unit_not_found') return `Asked about an apartment we don't list (${ev.unitId})`
  if (o === 'unit_pending') return `Apartment ${ev.unitId} has an application in on it`
  if (/^unit_/.test(o)) return `Apartment ${ev.unitId} isn't available`
  if (o === 'plan_lookup') return `Looked up the ${ev.floorPlanId} layout`
  if (o === 'plan_none_open') return `Nothing open in the ${ev.floorPlanId} layout`
  return "Checked what's available"
}
function summarySentence(outcome) {
  const o = String(outcome ?? '').trim()
  let m
  if ((m = /^Escalated: ([\s\S]*)$/.exec(o))) return `They asked "${text.truncate(m[1].trim(), 90)}" — that's for a person to answer.`
  if ((m = /^Booked a tour of (.+)$/.exec(o))) return `The assistant booked a tour of apartment ${m[1].trim()}.`
  if (o === 'Booked a tour') return 'The assistant booked a tour.'
  if ((m = /^Lost — ([^:]+): ([\s\S]*)$/.exec(o))) return `It may not work out: ${label(labels.lossReason, m[1].trim().replace(/ /g, '_'))} — ${text.staff(m[2].trim())}.`
  if ((m = /^Discussed (.+)$/.exec(o))) return `The assistant told them about ${text.list(m[1].split(',').map((x) => x.trim()).filter(Boolean))}.`
  if (o === 'Enquired') return 'They asked about apartments.'
  return o ? text.staff(o) : ''
}
const PRICED_OUT_RE = /^Nothing(?: [^\r\n]{1,40})? is available at or below \$/
const num = (s) => Number(String(s).replace(/,/g, ''))
/** Budget / cheapest / gap from either wording of the priced-out result; nulls when unreadable. */
function pricedOutNumbers(res) {
  const r = String(res ?? '')
  const b = /at or below \$([\d,]+)/.exec(r)
  const budget = b ? num(b[1]) : null
  let m
  if ((m = /The lowest available right now is \$([\d,]+) — \$([\d,]+) above/.exec(r))) return { budget, cheapest: num(m[1]), gap: num(m[2]) }
  if ((m = /The closest is \$([\d,]+)(?:\/month)? above/.exec(r))) return { budget, cheapest: budget != null ? budget + num(m[1]) : null, gap: num(m[1]) }
  return { budget, cheapest: null, gap: null }
}
function parseWhen(result) { const m = /I've got you down for ([^.]+?)\./.exec(String(result ?? '')); return m ? m[1].trim() : null }
function gateMissing(result) {
  const m = /Ask about (moveInTiming|bedrooms|budget|their needs)/.exec(String(result ?? ''))
  return { moveInTiming: 'their move-in date', bedrooms: 'how many bedrooms', budget: 'their budget' }[m ? m[1] : ''] || 'more'
}

function callStory(record, s) {
  const r = record || {}
  const call = r.call || null
  const events = arr(r.events)
  const profile = r.profile || null
  const tools = call ? arr(call.toolCalls).map((tc) => ({
    name: String((tc && tc.name) ?? 'unknown'),
    args: tc && tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
    // Keep the dated demo declaration in raw history, but classify the actual answer.
    result: tc && typeof tc.result === 'string'
      ? tc.result.replace(/^\[Inventory source:[^\]\r\n]{1,2000}\]\s*/, '') : null,
  })) : []
  const ev = (kind, pred) => events.filter((e) => e && e.kind === kind && (!pred || pred(e)))
  const f = {
    emergency: null, restricted: null, booked: null, arranging: null, bookFailed: false, slotTaken: false, bookInvalid: false,
    pricedOut: null, loss: null, units: [], stretch: [], later: [], refused: null, bedroomMismatch: false, noMatch: false, stale: false,
    answered: [], captured: {}, unreadable: [], slots: null, noSlots: false, dropped: false, crash: false,
  }
  // events first (structured numbers), then tool calls (authoritative wording) overwrite or fill
  for (const e of ev('emergency')) f.emergency = { phrase: label(labels.emergency, e.emergencyKind, 'an emergency'), matched: String(e.matched ?? ''), kind: String(e.emergencyKind ?? '') }
  for (const e of ev('escalated')) {
    if (e.trigger === 'emergency') { if (!f.emergency) f.emergency = { phrase: 'an emergency', matched: '', kind: '' } }
    else if (/^restricted:/.test(String(e.trigger))) f.restricted = { question: String(e.detail ?? ''), trigger: String(e.trigger) }
  }
  for (const e of ev('signal_captured')) if (e.captured !== false) f.captured[e.signal] = { signal: String(e.signal), value: e.value, excerpt: String(e.excerpt ?? '') }
  for (const e of ev('availability_checked')) {
    if (e.outcome === 'priced_out') f.pricedOut = { budget: e.budgetMax, cheapest: e.cheapestAvailable, gap: e.gap }
    if (e.outcome === 'matches') for (const id of arr(e.unitsOffered)) if (!f.units.includes(id)) f.units.push(id)
    if (e.outcome === 'bedroom_mismatch') f.bedroomMismatch = true
    if (e.outcome === 'no_availability' || e.outcome === 'timing_mismatch') f.noMatch = true
    if (e.outcome === 'stale') f.stale = true
  }
  for (const e of ev('question_answered', (x) => x.decision === 'answer')) f.answered.push({ question: String(e.question ?? ''), topic: String(e.topic ?? '') })
  for (const e of ev('question_refused')) f.refused = { question: String(e.question ?? ''), timesAsked: Number(e.timesAsked) || 1 }
  for (const e of ev('tour_booked')) {
    if (e.status === 'confirmed') f.booked = { unitId: e.unitId || null, when: String(e.slot ?? '') || null, email: e.prospectEmail || null }
    else if (e.status === 'arranging') f.arranging = { unitId: e.unitId || null }
    else if (e.status === 'failed') f.bookFailed = true
    else if (e.status === 'slot_taken') f.slotTaken = true
  }
  for (const e of ev('loss_reason')) if (e.reason) f.loss = { kind: String(e.reason.kind ?? ''), detail: String(e.reason.detail ?? ''), evidence: String(e.reason.evidence ?? '') }
  for (const e of ev('slots_listed')) f.slots = Number(e.count) || 0
  const bookedAt = { index: -1 }
  tools.forEach((t, i) => {
    const res = t.result
    if (res === null) { f.dropped = true; return }
    if (/^Something went wrong on my end/.test(res)) { f.crash = true; return }
    if (t.name === 'capture_signal') {
      const signal = String(t.args.signal ?? '')
      if (/^Got it/.test(res)) f.captured[signal] = { signal, value: t.args.value, excerpt: String(t.args.excerpt ?? '') }
      else if (/^Could not read/.test(res)) f.unreadable.push({ signal, value: t.args.value })
    } else if (t.name === 'check_availability') {
      if (PRICED_OUT_RE.test(res)) {
        if (!f.pricedOut) f.pricedOut = pricedOutNumbers(res)
      } else if (/^We do not have that bedroom count/.test(res)) f.bedroomMismatch = true
      else if (/^Nothing is available matching that/.test(res) || /^Nothing matches on any of size/.test(res)) f.noMatch = true
      else if (/^(?:I need to re-check|The inventory source is out of date)/.test(res)) f.stale = true
      else {
        for (const id of unitIdsIn(res, /^Unit ([A-Za-z0-9-]+)/)) if (!f.units.includes(id)) f.units.push(id)
        for (const id of unitIdsIn(res, /Slightly above their range: Unit ([A-Za-z0-9-]+)/)) if (!f.stretch.includes(id)) f.stretch.push(id)
        for (const id of unitIdsIn(res, /Coming up a bit later: Unit ([A-Za-z0-9-]+)/)) if (!f.later.includes(id)) f.later.push(id)
      }
    } else if (t.name === 'answer_question') {
      const question = String(t.args.question ?? '')
      if (/^That is something a member of the team/.test(res)) f.restricted = { question: question || (f.restricted && f.restricted.question) || '', trigger: (f.restricted && f.restricted.trigger) || `restricted:${String(t.args.topic ?? '')}` }
      else if (/^You do not have an approved answer/.test(res)) f.refused = { question, timesAsked: (f.refused && f.refused.timesAsked) || 1 }
      else if (!/^That is live information/.test(res)) { if (!f.answered.some((a) => a.question === question)) f.answered.push({ question, topic: String(t.args.topic ?? '') }) }
    } else if (t.name === 'list_tour_slots') {
      if (/^No tour times are open/.test(res)) { f.noSlots = true; f.slots = 0 }
      else if (f.slots == null) f.slots = (res.match(/^slot-/gm) || []).length
    } else if (t.name === 'book_tour') {
      if (/^You're all set/.test(res)) { f.booked = { unitId: t.args.unitId || (f.booked && f.booked.unitId) || null, when: (f.booked && f.booked.when) || parseWhen(res), email: t.args.prospectEmail || (f.booked && f.booked.email) || null }; bookedAt.index = i; f.slotTaken = false }
      else if (/^I'm getting that booked/.test(res)) f.arranging = { unitId: t.args.unitId || null }
      else if (/^I'm having trouble reaching the calendar/.test(res)) f.bookFailed = true
      else if (/^That time just went/.test(res)) { if (bookedAt.index < 0) f.slotTaken = true }
      else if (/^That slot is not on the calendar/.test(res)) f.bookInvalid = true
    } else if (t.name === 'capture_loss_reason') {
      f.loss = { kind: String(t.args.kind ?? ''), detail: String(t.args.detail ?? ''), evidence: String(t.args.evidence ?? '') }
    }
  })
  if (f.booked) f.slotTaken = false
  // Contract gap §5.3: after a cold start the decision events are gone, so an emergency call has no
  // 'emergency' event. The transcript is the fallback — the assistant's own emergency wording marks
  // the call, and the caller's words pick the kind and the quote.
  if (!f.emergency && call && call.transcript) {
    const lines = String(call.transcript).split('\n')
    const assistant = lines.filter((l) => /^AI:/.test(l)).join('\n')
    if (/\b911\b|as an emergency\b|this is an emergency|flagging this[^\n]{0,60}\bemergency\b|leave the (?:building|apartment) (?:now|right away)/i.test(assistant)) {
      const KINDS = [['gas', /\bgas\b/i], ['carbon_monoxide', /carbon monoxide|\bCO\b/], ['smoke_or_fire', /\b(smoke|fire|burning)\b/i], ['flooding', /flood|water (?:coming|pouring|everywhere)|leak/i],
        ['no_heat', /no heat|heat(?:ing)? (?:is )?(?:out|off|broken)/i], ['injury', /injur|hurt|bleeding|unconscious|fell/i], ['intruder', /intruder|break(?:ing)? in|burglar|someone in my/i], ['structural', /collaps|structural|ceiling (?:is )?(?:falling|caving)/i]]
      let kind = null, matched = ''
      for (const [k, re] of KINDS) {
        const line = lines.find((l) => /^User:/.test(l) && re.test(l))
        if (!line) continue
        kind = k
        // the clause with the word in it, as the server's own matcher quotes it ("kitchen is flooding")
        const clauses = line.replace(/^User:\s?/, '').split(/[.;!?,—]+/).map((c) => c.trim()).filter(Boolean)
        matched = text.truncate((clauses.find((c) => re.test(c)) || clauses[0] || '').replace(/[.!?]+$/, ''), 90)
        break
      }
      f.emergency = { phrase: label(labels.emergency, kind, 'an emergency'), matched, kind: kind || '', fromTranscript: true }
    }
  }
  // What it did is said only as far as the transcript (or, without one, the kind's fixed instruction) shows.
  if (f.emergency) f.emergency.action = emergencyAction(f.emergency.kind, call && call.transcript)

  // who / wants
  const who = (() => {
    const name = r.name ? r.name : (fmt.phone(r.phone) ? `The caller from ${fmt.phone(r.phone)}` : 'Someone with a hidden number')
    const p = r.startedAt ? nyParts(r.startedAt) : null
    let when = ''
    if (p) { const d = daysBetween(nyNow().ymd, p.ymd), t = fmt.time(r.startedAt); when = d === 0 ? `today at ${t}` : d === -1 ? `yesterday at ${t}` : d === 1 ? `tomorrow at ${t}` : `${fmt.day(p.ymd)} at ${t}` }
    const dur = r.durationSeconds != null ? fmt.duration(r.durationSeconds) : null
    return `${name} called${when ? ` ${when}` : ''}${dur && dur !== '—' ? ` for ${dur}` : ''}.`
  })()
  const wants = (() => {
    const c = f.captured
    const parts = []
    const size = c.bedrooms ? sizeWord(c.bedrooms.value) : null
    const budget = c.budget ? budgetText(c.budget.value) : null
    if (size || budget) parts.push(`looking for ${size || 'a place'}${budget ? ` with a budget of ${budget}` : ''}`)
    // Value phrases, not verbatim excerpts: the full quotes live in "What the assistant learned".
    // When only an excerpt exists it is cut to its first clause so the sentence still scans.
    const clause = (s) => { const t = String(s ?? '').trim(); const m = /^(.*?)[.!?](?:\s|$)/.exec(t); return text.truncate(m && m[1].trim() ? m[1].trim() : t, 40) }
    const q = (x) => `"${clause(x.excerpt || x.value)}"`
    const plainValue = (x) => { const v = String(x.value ?? '').trim(); return v && !/^(yes|no|true|false|y|n)$/i.test(v) ? v : '' }
    if (c.moveInTiming) parts.push(`moving ${moveInText(typeof c.moveInTiming.value === 'object' && c.moveInTiming.value ? c.moveInTiming.value : String(c.moveInTiming.value ?? '')) || q(c.moveInTiming)}`)
    if (c.pets) parts.push(`with ${plainValue(c.pets) || q(c.pets)}`)
    if (c.parking) parts.push(`parking ${plainValue(c.parking) ? `(${plainValue(c.parking)})` : q(c.parking)}`)
    return parts.length ? `${text.capitalise(parts.join(', '))}.` : ''
  })()

  // the sentence — first rule that matches, then the Also clause
  const bookedSentence = () => `The assistant booked a tour${f.booked.unitId ? ` of apartment ${f.booked.unitId}` : ''} for ${f.booked.when || 'a time on the calendar'}.`
  const askedSentence = () => `They asked "${text.truncate(f.restricted.question || label(labels.trigger, f.restricted.trigger, 'something only a person can answer'), 90)}" — that's for a person to answer, so the assistant took their details for a call back.`
  const rules = [
    { id: 1, hit: () => Boolean(f.emergency), say: () => `They reported ${f.emergency.phrase}${f.emergency.matched ? ` — "${f.emergency.matched}"` : ''}. ${f.emergency.action}` },
    { id: 2, hit: () => Boolean(f.restricted), say: askedSentence },
    { id: 3, hit: () => Boolean(f.booked), say: bookedSentence },
    { id: 4, hit: () => Boolean(f.arranging), say: () => `The assistant is arranging a tour${f.arranging.unitId ? ` of apartment ${f.arranging.unitId}` : ''} — it isn't confirmed yet.` },
    { id: 5, hit: () => f.bookFailed, say: () => "They wanted a tour but it couldn't be booked — the assistant said someone would call back with times." },
    { id: 6, hit: () => f.slotTaken, say: () => 'The time they wanted was taken; the assistant offered other times.' },
    { id: 7, hit: () => Boolean(f.pricedOut), say: () => (f.pricedOut.budget != null ? `Nothing was under ${fmt.money(f.pricedOut.budget)} — our lowest is ${fmt.money(f.pricedOut.cheapest)}, so they're ${fmt.money(f.pricedOut.gap)} short.` : 'Nothing was under their budget — the assistant said so plainly.') },
    { id: 8, hit: () => Boolean(f.loss), say: () => `It may not work out: ${lossText(f.loss)}.` },
    { id: 9, hit: () => f.units.length > 0, say: () => `The assistant told them about ${text.list(f.units)}${f.stretch.length ? ` and mentioned ${text.list(f.stretch)} as a little over budget` : ''}.` },
    { id: 10, hit: () => Boolean(f.refused), say: () => `They asked "${text.truncate(f.refused.question, 90)}" — the assistant didn't have an approved answer, so it offered a call back rather than guess.` },
    { id: 11, hit: () => f.bedroomMismatch, say: () => `They wanted ${(f.captured.bedrooms && sizeWord(f.captured.bedrooms.value)) || 'that size'} — none are available right now.` },
    { id: 12, hit: () => f.noMatch, say: () => 'Nothing was available for what they wanted; the assistant offered the waitlist.' },
    { id: 13, hit: () => f.stale, say: () => "The assistant looked for apartments, but the list was out of date, so it didn't quote anything." },
    { id: 14, hit: () => f.answered.length > 0, say: () => `They asked about ${text.list([...new Set(f.answered.map((a) => label(labels.topic, a.topic)))])} and the assistant answered from the approved information.` },
    { id: 15, hit: () => Object.keys(f.captured).length > 0, say: () => "They told the assistant what they're looking for; nothing was booked yet." },
    { id: 16, hit: () => Boolean(call) && tools.length === 0 && r.durationSeconds != null && r.durationSeconds < 20, say: () => 'A very short call — they hung up before saying what they needed.' },
    { id: 17, hit: () => Boolean(call) && tools.length === 0, say: () => 'The assistant answered without needing to look anything up.' },
  ]
  let fired = null, sentence = ''
  for (const rule of rules) { if (rule.hit()) { fired = rule.id; sentence = rule.say(); break } }
  if (!fired) {
    if (!call && r.summary) sentence = summarySentence(r.summary.outcome)
    if (!sentence) sentence = call ? 'The assistant answered without needing to look anything up.' : "Details weren't kept for this call."
    fired = 18
  }
  if (fired === 2 && f.booked) sentence += ` The assistant also booked a tour${f.booked.unitId ? ` of apartment ${f.booked.unitId}` : ''} for ${f.booked.when || 'a time on the calendar'}.`
  else if (fired === 3 && f.restricted) sentence += ` They also asked "${text.truncate(f.restricted.question || label(labels.trigger, f.restricted.trigger, 'something only a person can answer'), 90)}" — that's for a person to answer.`
  else if (fired === 1) { if (f.restricted) sentence += ` ${askedSentence()}`; else if (f.booked) sentence += ` ${bookedSentence()}` }

  const needsPersonFlag = Boolean(f.restricted) || f.bookFailed
  const chips = []
  if (f.emergency) chips.push({ text: 'Emergency', cls: 'chip-danger', icon: 'siren' })
  if (needsPersonFlag) chips.push({ text: 'Needs a person', cls: 'chip-warn', icon: 'hand' })
  if (f.booked) chips.push({ text: 'Tour booked', cls: 'chip-ok', icon: 'calendar' })
  if (f.pricedOut || (f.loss && f.loss.kind === 'priced_out')) chips.push({ text: 'Priced out', cls: 'chip-lost', icon: 'x' })
  if (f.loss && f.loss.kind !== 'priced_out') chips.push({ text: "Didn't work out", cls: 'chip-lost', icon: 'x' })
  if (f.dropped) chips.push({ text: 'Call dropped', cls: 'chip-info', icon: 'info' })

  // facts
  const facts = []
  for (const c of Object.values(f.captured)) facts.push({ signal: c.signal, label: label(labels.signal, c.signal), value: factValue(c.signal, c.value), excerpt: c.excerpt })
  for (const u of f.unreadable) if (!f.captured[u.signal]) facts.push({ signal: u.signal, label: label(labels.signal, u.signal), unreadable: true, value: String(u.value ?? '') })

  // steps, one per tool call in order; consecutive captures collapse
  const steps = []
  if (f.emergency) {
    const did = f.emergency.action.replace(/^The assistant /, '').replace(/\.$/, '')
    steps.push({ icon: 'siren', text: `Treated this as an emergency (${f.emergency.phrase})${/^told/.test(did) ? ` and ${did}` : ''}.` })
  }
  let run = []
  const flushRun = () => {
    if (!run.length) return
    if (run.length === 1) {
      const c = run[0]
      steps.push({ icon: 'note', text: `Noted ${label(labels.signalPhrase, c.signal, 'what they want')} (${factValue(c.signal, c.value)})${c.excerpt ? ` — "${c.excerpt}"` : ''}.` })
    } else steps.push({ icon: 'note', text: `Noted ${text.list(run.map((c) => label(labels.signalPhrase, c.signal, 'what they want')))}.` })
    run = []
  }
  for (const t of tools) {
    const res = t.result
    if (t.name === 'capture_signal' && res !== null && /^Got it/.test(res)) { run.push({ signal: String(t.args.signal ?? ''), value: t.args.value, excerpt: String(t.args.excerpt ?? '') }); continue }
    flushRun()
    if (res === null) { steps.push({ icon: 'x', text: 'This step never finished — the call may have dropped here.' }); continue }
    if (/^Something went wrong on my end/.test(res)) { steps.push({ icon: 'x', text: 'Something went wrong on our side; the assistant apologised and offered a call back.' }); continue }
    if (t.name === 'capture_signal') {
      const signal = String(t.args.signal ?? '')
      if (/^Could not read/.test(res)) steps.push({ icon: 'note', text: `Couldn't make out their ${label(labels.signalShort, signal, 'answer')} from "${String(t.args.value ?? '')}"; asked again differently.` })
      else steps.push({ icon: 'note', text: 'Noted what they want.' })
    } else if (t.name === 'check_availability') {
      let m
      if (/^Before I quote anything/.test(res)) steps.push({ icon: 'home', text: `Held off on rent until it knew ${gateMissing(res)}.` })
      else if (PRICED_OUT_RE.test(res)) {
        const po = f.pricedOut || pricedOutNumbers(res)
        steps.push({ icon: 'home', text: po.budget != null ? `Checked what's available — nothing under ${fmt.money(po.budget)}; the lowest is ${fmt.money(po.cheapest)}, ${fmt.money(po.gap)} over. The assistant said so plainly.` : "Checked what's available — nothing under their budget. The assistant said so plainly." })
      } else if (/^We do not have that bedroom count/.test(res)) {
        const size = f.captured.bedrooms ? sizeNoun(f.captured.bedrooms.value) : null
        steps.push({ icon: 'home', text: size ? `Checked what's available — no ${size} apartments.` : "Checked what's available — no apartments of that size." })
      } else if (/^Nothing is available matching that/.test(res)) steps.push({ icon: 'home', text: "Checked what's available — nothing for what they wanted; offered the waitlist." })
      else if (/^Nothing matches on any of size/.test(res)) steps.push({ icon: 'home', text: "Checked what's available — nothing matched on size, date or budget; asked what they'd be flexible on." })
      else if (/^No currently listed residences meet that spending minimum/.test(res)) steps.push({ icon: 'home', text: "Checked what's available — none met their spending minimum; asked whether they'd consider a lower price." })
      else if (/^(?:I need to re-check|The inventory source is out of date)/.test(res)) steps.push({ icon: 'home', text: "Checked what's available — the list was out of date, so it didn't quote." })
      else if ((m = /^Residence (\S+) is available:[^$]*\$([\d,]+)\/month/.exec(res))) steps.push({ icon: 'home', text: `Looked up apartment ${m[1]}: available at ` + USD + m[2] + '.' })
      else if ((m = /^There is no residence (\S+?) /i.exec(res))) steps.push({ icon: 'home', text: `Looked up apartment ${m[1]}: not on the list.` })
      else if ((m = /^Residence (\S+) is pending/.exec(res))) steps.push({ icon: 'home', text: `Looked up apartment ${m[1]}: pending an application.` })
      else if ((m = /^Residence (\S+) is not currently available/.exec(res))) steps.push({ icon: 'home', text: `Looked up apartment ${m[1]}: not available.` })
      else if ((m = /^(.+?) \((\w+)\): [\s\S]*?Open now/.exec(res))) { const ids = unitIdsIn(res, /^Unit ([A-Za-z0-9-]+)/); steps.push({ icon: 'home', text: `Looked up the ${m[2]} layout: ${ids.length ? `${text.list(ids)} open` : 'open now'}.` }) }
      else if ((m = /^No (.+?) \((\w+)\) residences are open/.exec(res))) steps.push({ icon: 'home', text: `Looked up the ${m[2]} layout: none open.` })
      else {
        const ids = unitIdsIn(res, /^Unit ([A-Za-z0-9-]+)/), stretch = unitIdsIn(res, /Slightly above their range: Unit ([A-Za-z0-9-]+)/), later = unitIdsIn(res, /Coming up a bit later: Unit ([A-Za-z0-9-]+)/)
        let txt = ids.length ? `Checked what's available and told them about ${text.list(ids)}.` : "Checked what's available."
        if (stretch.length) txt += ` Mentioned ${text.list(stretch)} as a little over their budget.`
        if (later.length) txt += ` Mentioned ${text.list(later)} opening later.`
        steps.push({ icon: 'home', text: txt })
      }
    } else if (t.name === 'answer_question') {
      const q = String(t.args.question ?? '')
      if (/^That is something a member of the team/.test(res)) steps.push({ icon: 'hand', text: `Asked "${q}" — passed to a person; took their details.` })
      else if (/^That is live information/.test(res)) steps.push({ icon: 'message', text: `Asked "${q}" — checked the live list instead of answering from memory.` })
      else if (/^You do not have an approved answer/.test(res)) steps.push({ icon: 'message', text: `Asked "${q}" — no approved answer, so the assistant offered a call back rather than guess.${f.refused && f.refused.timesAsked >= 2 ? ' Asked twice.' : ''}` })
      else steps.push({ icon: 'message', text: `Answered "${q}" from ${label(labels.topic, t.args.topic, 'the approved information')}: "${text.truncate(text.staff(res.replace(/\s+/g, ' ').trim()), 140)}"` })
    } else if (t.name === 'list_tour_slots') {
      if (/^No tour times are open/.test(res)) steps.push({ icon: 'calendar', text: 'No tour times were open, so offered a call back.' })
      else steps.push({ icon: 'calendar', text: `Offered ${text.plural((res.match(/^slot-/gm) || []).length, 'tour time')}.` })
    } else if (t.name === 'book_tour') {
      if (/^You're all set/.test(res)) steps.push({ icon: 'calendar', text: `Booked a tour${t.args.unitId ? ` of apartment ${t.args.unitId}` : ''} for ${(f.booked && f.booked.when) || parseWhen(res) || 'a time on the calendar'}${t.args.prospectEmail ? `; email recorded: ${t.args.prospectEmail}` : ''}.` })
      else if (/^I'm getting that booked/.test(res)) steps.push({ icon: 'calendar', text: 'Started arranging a tour; not confirmed yet.' })
      else if (/^That time just went/.test(res)) steps.push({ icon: 'calendar', text: 'The time was taken while booking; offered other times.' })
      else if (/^I'm having trouble reaching the calendar/.test(res)) steps.push({ icon: 'hand', text: "Couldn't reach the calendar; flagged this for a call back." })
      else if (/^That slot is not on the calendar/.test(res)) steps.push({ icon: 'calendar', text: "Tried a time that wasn't on the calendar and was told to list real times." })
      else steps.push({ icon: 'calendar', text: 'Tried to book a tour.' })
    } else if (t.name === 'capture_loss_reason') {
      steps.push({ icon: 'x', text: `Noted it may not work out: ${lossText({ kind: t.args.kind, detail: t.args.detail })}${t.args.evidence ? ` ("${String(t.args.evidence)}")` : ''}.` })
    } else steps.push({ icon: 'x', text: "Tried something the assistant can't do." })
  }
  flushRun()

  return {
    who, wants, sentence, chips, facts, steps, findings: f,
    ended: call ? endedPhrase(call.endedReason) : '',
    needsPerson: needsPersonFlag, emergency: Boolean(f.emergency), dropped: f.dropped, booked: f.booked, restricted: f.restricted,
  }
}

// --- the to-do sentence (§6.3) ---------------------------------------------------------

function todoSentence(fu, profile, s) {
  const p = profile || profileByPhone(s || state, fu.phone) || { phone: fu.phone, name: null }
  const name = personName(p)
  const kind = String(fu.kind ?? '')
  const today = nyNow().ymd
  const verbFor = (ch) => label(labels.channelVerb, ch, 'Call')
  const bookingOn = (ymd) => arr(p.bookings).find((b) => b && b.status === 'confirmed' && nyDate(b.startsAt) === ymd) || null
  const tourPhrase = (b) => `${fmt.time(b.startsAt)} tour${b.unitId ? ` of apartment ${b.unitId}` : ''}`
  const dayWord = (ymd) => { const d = daysBetween(today, ymd); return d === 0 ? "today's" : d === 1 ? "tomorrow's" : `${WD_LONG[dayOfWeek(ymd)]}'s` }
  const reason = String(fu.reason ?? '')
  let verb = 'Call', before = 'Call ', after = '', needs = false, m
  if (kind === 'confirm_tour') {
    const tour = bookingOn(nyDate(fu.dueAt))
    if (tour) after = ` to confirm ${dayWord(nyDate(tour.startsAt))} ${tourPhrase(tour)}`
    else if ((m = /still coming at (\d{1,2}:\d{2} [AP]M)(?: to see (\S+?))?\.$/.exec(reason))) after = ` to confirm their ${m[1]} tour${m[2] ? ` of apartment ${m[2]}` : ''}`
    else after = ' to confirm their tour'
  } else if (kind === 'remind_tour') {
    verb = verbFor(fu.channel); before = `${verb} `
    const tour = bookingOn(addDays(nyDate(fu.dueAt) || today, 1))
    after = ` a reminder about tomorrow's ${tour ? tourPhrase(tour) : 'tour'}`
  } else if (kind === 'post_tour') {
    const past = arr(p.bookings).filter((b) => b && b.status === 'confirmed' && (toTime(b.startsAt) ?? Infinity) < Date.now()).sort((a, b) => (toTime(b.startsAt) ?? 0) - (toTime(a.startsAt) ?? 0))
    let unit = past.length ? past[0].unitId : null
    if (!unit && (m = /(?:toured|was scheduled to tour)(?: residence (\S+?))? —/.exec(reason))) unit = m[1] || null
    after = ` to check whether they attended the tour${unit ? ` of apartment ${unit}` : ''}. If so, ask how it went and whether they want to apply.`
  } else if (kind === 'priced_out_watch') {
    verb = verbFor(fu.channel); before = `${verb} `
    const range = p.signals && p.signals.budgetRange && budgetText(p.signals.budgetRange.value)
    const budget = p.signals && p.signals.budget && p.signals.budget.value
    if (range) after = ` if anything in their ${range} range opens up`
    else if (budget != null && !isNaN(Number(budget))) after = ` if anything under ${fmt.money(budget)} opens up`
    else if ((m = /priced out \((.+?)\)/.exec(reason))) after = ` if anything in their range opens up (${text.staff(m[1])})`
    else after = ' if anything in their range opens up'
  } else if (kind === 'nurture') {
    after = " — interested but didn't book. Offer a tour again."
  } else if (kind === 'callback') {
    const q = callbackQuestion(fu, p)
    const t = escalationText({ trigger: q.trigger, detail: q.detail })
    if (q.trigger === 'emergency' || /^Emergency reported by /.test(reason)) {
      verb = 'Review'; before = 'Review the emergency reported by '
      after = " now. No automatic notification has been sent; follow the building's emergency protocol."
    } else after = ` back — ${t.headline}`
    needs = true
  } else if (kind === 'collect_email') {
    if (p.name) { before = 'Get '; after = "'s email so the tour confirmation can go out" }
    else { before = 'Get an email address for '; after = ' so the tour confirmation can go out' }
  } else {
    verb = verbFor(fu.channel); before = `${verb} `
    after = reason ? ` — ${text.staff(reason)}` : ''
  }
  return { verb, before, name, after, text: `${before}${name}${after}`, needsPerson: needs, channel: String(fu.channel ?? 'call') }
}

const derive = {
  /** The API resolves saved UTC bounds against the current property timezone. */
  wholeDayBlockDates(block) {
    if (Array.isArray(block && block.wholeDayDates)) return block.wholeDayDates.filter(isYmd)
    // Date-only legacy records have no preserved interval. Timestamped records
    // without coverage metadata must not be presented as covering an entire day.
    return block && isYmd(block.target) && !block.startsAt && !block.endsAt ? [block.target] : []
  },
  windowStart, personName, displayName, displayStage, needsPerson, callBackToday, dueTodayCount, toursOn, callRecords, callStory,
  todoSentence, escalationText, lossText, summarySentence, availabilityText, moveInText, budgetText, profileByPhone, profileForCall, factValue, bedroomsText, emergencyAction,
}

// ---------------------------------------------------------------------------------------
// Shared write: follow-up status (§9.2, §12.2, §12.3) — identical on Today, Leads, Calls
// ---------------------------------------------------------------------------------------

function reread(resource) {
  if (!RESOURCES[resource] || gated) return Promise.resolve()
  return api.get(resource === 'calendar' ? calendarUrl() : RESOURCES[resource]).then((d) => { apply(resource, d) }, () => { /* the poll will try again */ })
}
/**
 * Where keyboard focus goes when the control that started a write leaves the list with its row:
 * the same action on the next row, else on the previous row, else the group's heading or
 * summary, else the section's heading (each carries data-key and, for headings, tabindex=-1).
 * restoreFocus() tries them in order, then the toast's first action, then the view's H1 — focus
 * never falls to <body> after a write.
 */
function focusFallbacks(btn) {
  const keys = []
  if (!btn || !btn.closest) return keys
  const action = String(btn.dataset.action || '')
  const row = btn.closest('.row')
  const keyIn = (r) => { if (!r) return null; const b = r.querySelector(`[data-action="${cssq(action)}"][data-key]`) || r.querySelector('button[data-key], a[data-key]'); return b ? b.dataset.key : null }
  if (row && row.parentElement) {
    const rows = [...row.parentElement.children].filter((x) => x.classList.contains('row'))
    const i = rows.indexOf(row)
    keys.push(keyIn(rows[i + 1]), keyIn(rows[i - 1]))
    const prev = row.parentElement.previousElementSibling
    if (prev && prev.dataset && prev.dataset.key && /^(H2|H3|H4|SUMMARY)$/.test(prev.tagName)) keys.push(prev.dataset.key)
  }
  const det = btn.closest('details'), sm = det && det.querySelector('summary[data-key]')
  if (sm) keys.push(sm.dataset.key)
  const scope = btn.closest('section, .panel-section, .panel-body, .view')
  const head = scope && scope.querySelector('h2[data-key], h3[data-key], summary[data-key]')
  if (head) keys.push(head.dataset.key)
  return keys.filter(Boolean)
}
function restoreFocus(keys, toastHandle) {
  const a = document.activeElement
  if (a && a !== document.body && a.isConnected) return
  const view = document.querySelector('.view:not([hidden])')
  const tryFocus = (el) => { if (!el) return false; try { el.focus({ preventScroll: true }) } catch (e) { return false } return document.activeElement === el }
  for (const k of keys) { if (view) for (const el of view.querySelectorAll(`[data-key="${cssq(k)}"]`)) if (tryFocus(el)) return }
  if (toastHandle && toastHandle.el && tryFocus(toastHandle.el.querySelector('.toast-action'))) return
  if (view) tryFocus(view.querySelector('h1'))
}
async function setFollowUpStatus(fu, status, opts) {
  const o = opts || {}
  if (!fu || !fu.id || busyNow('leads')) return false
  const btn = o.button || null
  const row = btn ? btn.closest('.row') : null
  const verb = o.verb || (status === 'done' ? 'done' : status === 'skipped' ? 'not needed' : 'back')
  const fallbacks = focusFallbacks(btn)
  if (btn) { btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true') }
  if (row) row.classList.add('row-busy')
  try {
    const res = await busy('leads', api.post('/api/leads', { action: 'followup_status', id: fu.id, status }, { doing: `marking a to-do ${verb}` }))
    if (row && row.isConnected && status !== 'scheduled') { row.classList.add('row-leaving'); await new Promise((r) => setTimeout(r, 120)) }
    apply('leads', res)
    let h
    if (status === 'scheduled') h = toast('Put back on the list', { kind: 'ok', key: `fu:${fu.id}` })
    else h = toast(`Marked ${verb}`, { kind: 'ok', key: `fu:${fu.id}`, actions: [{ label: 'Undo', fn: () => busy('leads', api.post('/api/leads', { action: 'followup_status', id: fu.id, status: 'scheduled' }, { doing: 'undoing a to-do change' })).then((r) => { apply('leads', r) }) }] })
    restoreFocus(fallbacks, h)
    return true
  } catch (e) {
    if (e.signedOut) return false
    if (btn && btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') }
    if (row && row.isConnected) row.classList.remove('row-busy', 'row-leaving')
    if (e.status === 404) toast('That to-do was removed by someone else. The list has been refreshed.', { kind: 'warn' })
    else toast("Couldn't update that to-do. Nothing changed — try again.", { kind: 'error', actions: [{ label: 'Try again', fn: () => { setFollowUpStatus(fu, status, { verb }) } }] })
    reread('leads')
    return false
  }
}

// ---------------------------------------------------------------------------------------
// Today (§7)
// ---------------------------------------------------------------------------------------

const link = (name, params, txt, cls) => `<a class="${cls || 'btn btn-quiet'}" href="${esc(hashFor(name, params))}">${esc(txt)}</a>`
const telBtn = (phone, txt, cls) => { const h = href.tel(phone); return h ? `<a class="${cls || 'btn btn-call'}" href="${esc(h)}">${esc(txt || 'Call')}</a>` : '' }
const telLink = (phone) => { const h = href.tel(phone), shown = fmt.phone(phone); return h && shown ? `<a href="${esc(h)}">${esc(shown)}</a>` : esc(shown) }
/** A person's name as the link to their lead (every person mention links onward, §2.6). */
const personLink = (phone, name) => `<a class="name" href="${esc(hashFor('leads', { phone: phone || 'unknown' }))}">${esc(name)}</a>`
const mailLink = (email) => { const h = href.mailto(email); return h ? `<a href="${esc(h)}">${esc(email)}</a>` : esc(email || '') }
const chipHtml = (c) => html_.chip(c.cls, c.icon, c.text)
const isAfterHours = (t) => { const p = nyParts(t); if (!p || !Object.keys(property.hours).length) return false; const h = property.hours[p.dayOfWeek]; if (!h) return true; const x = p.hour + p.minute / 60; return x < h[0] || x >= h[1] }
function sectionHead(title, count, trailing) {
  // tabindex=-1 + data-key: where keyboard focus lands when the row it was on has just left the list
  return `<div class="section-head"><h2 tabindex="-1" data-key="section:${esc(title)}">${esc(title)}${count != null ? ` <span class="count">· ${count}</span>` : ''}</h2>${trailing || ''}</div>`
}

function todayModel(s) {
  const now = Date.now(), today = nyNow().ymd, tomorrow = addDays(today, 1)
  const ws = windowStart(), wsT = toTime(ws)
  const records = callRecords(s)
  const needs = needsPerson(s)
  const emergencies = needs.filter((n) => n.type === 'emergency')
  const people = needs.filter((n) => n.type !== 'emergency')
  const callBacks = callBackToday(s)
  const tours = toursOn(s, today), toursTomorrow = toursOn(s, tomorrow)
  const callsKnown = s.loaded.calls || s.loaded.leads
  let callIds = 0, afterHours = 0
  for (const r of records) { const t = toTime(r.startedAt); if (t != null && t >= wsT) { callIds++; if (isAfterHours(t)) afterHours++ } }
  const allTwenty = arr(s.calls).length >= 20 && arr(s.calls).every((c) => (toTime(c.startedAt) ?? 0) >= wsT)
  const callsValue = !callsKnown ? '—' : (allTwenty ? '20+' : String(callIds))
  const callsNote = !callsKnown ? '' : (s.callsConfigured === false && callIds === 0 ? 'notConnected' : (afterHours ? `${afterHours} after hours` : ''))
  let toursBooked = null
  if (s.calendar) toursBooked = arr(s.calendar.bookings).filter((b) => b && (toTime(b.bookedAt) ?? 0) >= wsT).length
  else if (s.loaded.leads) {
    toursBooked = 0
    for (const p of profilesOf(s)) for (const b of arr(p.bookings)) if (b && b.status === 'confirmed' && (toTime(callAt(p, b.callId)) ?? 0) >= wsT) toursBooked++
  }
  const nextTour = tours.find((t) => !t.past)
  const needValue = s.loaded.leads ? needs.length : null
  const oldest = needs.length ? Math.min(...needs.map((n) => toTime(n.at) ?? now)) : null
  const leadsStore = s.leads && s.leads.store, calStore = s.calendar && s.calendar.store
  const leadsOff = Boolean(leadsStore) && leadsStore.durable === false, calOff = Boolean(calStore) && calStore.durable === false
  let briefing = ''
  if (callsKnown) {
    if (callsValue === '0') briefing = 'Since 6 PM yesterday: no calls yet.'
    else {
      const toursPart = toursBooked == null ? '' : `, ${toursBooked === 0 ? 'no tours booked' : text.plural(toursBooked, 'tour booked', 'tours booked')}`
      // Two distinct phrases with the same numbers as the tile ("Need a person") and the "Call back
      // today" section, so nothing in the sentence is left for the reader to reconcile (§17 item 1).
      const parts = []
      if (needs.length) parts.push(needs.length === 1 ? '1 needs a person' : `${needs.length} need a person`)
      if (callBacks.length) parts.push(`${callBacks.length} to call back`)
      const callsPart = text.plural(callsValue === '20+' ? 20 : Number(callsValue), 'call').replace(/^20 /, '20+ ')
      briefing = parts.length ? `Since 6 PM yesterday: ${callsPart}${toursPart}, ${parts.join(', ')}.`
        : `Since 6 PM yesterday: ${callsPart}${toursPart}. Nothing needs you right now.`
    }
  }
  return {
    today, now, ws, records, needs, emergencies, people, callBacks, tours, toursTomorrow, callsKnown, callsValue, callsNote, toursBooked,
    nextTour: nextTour ? fmt.time(nextTour.startsAt) : null, needValue, oldest, leadsOff, calOff, briefing,
    errors: { calls: Boolean(s.errors.calls), calendar: Boolean(s.errors.calendar), leads: Boolean(s.errors.leads) },
    loaded: { ...s.loaded }, notConfigured: s.notConfigured, callsConfigured: s.callsConfigured,
  }
}
function pollBanner(s, resource, what) {
  const err = s.errors[resource]
  if (!err) return ''
  const at = s.lastGoodAt[resource]
  return html_.banner('warn', `We can't load ${what} right now.${at ? ` Showing what we had at ${fmt.time(at)}.` : ''}`)
}
function personRowHtml(item, s) {
  const phone = item.phone, shown = fmt.phone(phone)
  const rec = callRecords(s).find((r) => r.id === item.callId)
  const actions = []
  if (item.type === 'emergency') {
    // The emergency is the first item of the list as well as the banner above, so the section's count,
    // the tile, the badge and the briefing sentence all count the same things.
    if (shown) actions.push(telBtn(phone, 'Call'))
    if (item.profile) actions.push(link('leads', { phone }, 'Open lead', 'btn btn-quiet link-action'))
    if (rec) actions.push(link('calls', { id: item.callId }, 'See the call', 'btn btn-quiet link-action'))
    const by = item.name ? esc(item.name) : (shown ? telLink(phone) : 'a caller with a hidden number')
    return `<div class="row" data-key="np:${esc(item.callId)}">` +
      `<span class="row-lead"><span class="row-lead-icon danger-text">${ico('siren')}</span></span><span class="row-body">` +
      `<span class="row-title"><span class="name">Emergency — ${esc(item.phrase)}</span> — reported by ${by} ${esc(fmt.whenPhrase(item.at) || fmt.dateTime(item.at, { inSentence: true }))}</span>` +
      (item.matched ? `<span class="quote">"${esc(item.matched)}"</span>` : '') +
      `<span class="reassure">${esc(item.action)}</span>` +
      `<span class="meta">${item.name && shown ? `${telLink(phone)} · ` : ''}stays on this page for a day</span>` +
      `</span><span class="row-actions">${actions.join('')}</span></div>`
  }
  if (item.type === 'callback') {
    const t = escalationText({ trigger: item.trigger, detail: item.question })
    const overdue = (toTime(item.respondBy) ?? Infinity) <= Date.now()
    actions.push(telBtn(phone, 'Call'))
    actions.push(`<button type="button" class="btn" data-action="handled" data-fu="${esc(item.fu.id)}" data-key="fu:${esc(item.fu.id)}:done" data-write="leads">Mark handled</button>`)
    actions.push(link('leads', { phone }, 'Open lead', 'btn btn-quiet link-action'))
    if (rec) actions.push(link('calls', { id: item.callId }, 'See the call', 'btn btn-quiet link-action'))
    return `<div class="row" data-key="np:${esc(item.callId)}">` +
      `<span class="row-lead"><span class="row-lead-icon warn-text">${ico('hand')}</span></span><span class="row-body">` +
      `<span class="row-title"><span class="name">Call ${esc(personName(item.profile || { phone }))} back</span> — ${esc(t.headline)}</span>` +
      (t.quote ? `<span class="quote">"${esc(t.quote)}"</span>` : '') +
      `<span class="reassure">${esc(t.reassurance)}</span>` +
      `<span class="meta">${shown ? `${telLink(phone)} · ` : ''}called ${esc(fmt.dateTime(item.calledAt, { inSentence: true }))} · <span class="${overdue ? 'overdue' : ''}">${esc(fmt.respondPhrase(item.respondBy))}</span></span>` +
      `</span><span class="row-actions">${actions.join('')}</span></div>`
  }
  const b = item.booking
  const name = item.name || personName(item.profile)
  const failed = b.status === 'failed'
  actions.push(telBtn(phone, 'Call'))
  actions.push(link('leads', { phone }, 'Open lead', 'btn btn-quiet link-action'))
  actions.push(link('calendar', { date: nyDate(b.startsAt) || undefined }, 'Calendar', 'btn btn-quiet link-action'))
  return `<div class="row" data-key="np:${esc(item.callId)}">` +
    `<span class="row-lead"><span class="row-lead-icon warn-text">${ico('hand')}</span></span><span class="row-body">` +
    `<span class="row-title"><span class="name">${esc(name)}'s tour ${failed ? "wasn't booked" : "isn't confirmed yet"}</span> — ${failed ? "the assistant couldn't reach the calendar" : 'the assistant is still arranging it'}</span>` +
    `<span class="meta">${shown ? `${telLink(phone)} · ` : ''}called ${esc(fmt.dateTime(item.calledAt, { inSentence: true }))} · wanted ${esc(fmt.day(b.startsAt))} at ${esc(fmt.time(b.startsAt))}${b.unitId ? ` (${esc(b.unitId)})` : ''}</span>` +
    `<span class="reassure">${failed ? 'Call to set a time, then book it on the calendar.' : "If it isn't confirmed within the hour, call."}</span>` +
    `</span><span class="row-actions">${actions.join('')}</span></div>`
}
function followUpRowHtml(fu, s) {
  const profile = profileByPhone(s, fu.phone)
  const sen = todoSentence(fu, profile, s)
  const overdue = (toTime(fu.dueAt) ?? Infinity) <= Date.now()
  const channel = String(fu.channel ?? 'call')
  const email = profile && profile.email
  const from = callAt(profile, fu.createdFromCall) || fu.createdAt
  let primary = ''
  if (channel === 'email' && href.mailto(email)) primary = `<a class="btn btn-call" href="${esc(href.mailto(email))}">Email</a>`
  else if (channel === 'sms' && href.sms(fu.phone)) primary = `<a class="btn btn-call" href="${esc(href.sms(fu.phone))}">Text</a>`
  else primary = telBtn(fu.phone, 'Call')
  return `<div class="row row-stack" data-key="fu:${esc(fu.id)}">` +
    `<span class="row-lead"><span class="${overdue ? 'overdue' : ''}">${overdue ? ico('clock') : ''} ${esc(fmt.duePhrase(fu.dueAt))}</span><span class="row-lead-icon">${ico(label(labels.channelIcon, channel, 'phone'))}</span></span>` +
    `<span class="row-body"><span class="row-title">${esc(sen.before)}${personLink(fu.phone, sen.name)}${esc(sen.after)}</span>` +
    `<span class="row-sub">${fmt.phone(fu.phone) ? `${telLink(fu.phone)} · ` : ''}${channel === 'email' && email ? `${mailLink(email)} · ` : ''}from their call ${esc(fmt.dateTime(from, { inSentence: true }))}</span></span>` +
    `<span class="row-actions">${primary}` +
    `<button type="button" class="btn" data-action="done" data-fu="${esc(fu.id)}" data-key="fu:${esc(fu.id)}:done" data-write="leads">Done</button>` +
    `<button type="button" class="btn" data-action="skip" data-fu="${esc(fu.id)}" data-key="fu:${esc(fu.id)}:skip" data-write="leads">Not needed</button></span></div>`
}
function tourRowHtml(t, s, today) {
  const confirmPending = t.phone && followUpsOf(s).some((f) => f && f.kind === 'confirm_tour' && f.status === 'scheduled' && f.phone === t.phone)
  const actions = []
  if (confirmPending && href.tel(t.phone)) actions.push(telBtn(t.phone, 'Call to confirm', 'btn btn-call'))
  if (t.profile) actions.push(link('leads', { phone: t.phone }, 'Open lead', 'btn btn-quiet link-action'))
  actions.push(link('calendar', { date: today, slot: t.slotId }, 'Calendar', 'btn btn-quiet link-action'))
  const chip = t.past ? html_.chip('chip-ok', 'check', 'Toured') : html_.chip('chip-ok', 'check', 'Confirmed')
  return `<div class="row row-stack${t.past ? ' row-muted' : ''}" data-key="tour:${esc(t.slotId)}">` +
    `<span class="row-lead"><span class="num strong">${esc(fmt.time(t.startsAt))}</span></span>` +
    `<span class="row-body"><span class="row-title">${t.profile ? personLink(t.phone, t.name) : esc(t.name)} · ${t.unitId ? `apartment ${esc(t.unitId)}` : 'no apartment picked yet'}</span>` +
    `<span class="row-sub">${fmt.phone(t.phone) ? `${telLink(t.phone)} · Confirmed` : 'Confirmed · no phone on file'}</span></span>` +
    `<span class="row-actions">${chip}${actions.join('')}</span></div>`
}
function recentCallRowHtml(rec, s) {
  const story = callStory(rec, s)
  const iconName = story.emergency ? 'siren' : story.needsPerson ? 'hand' : 'phone'
  const cls = story.emergency ? 'danger-text' : story.needsPerson ? 'warn-text' : ''
  const dur = rec.durationSeconds != null ? fmt.duration(rec.durationSeconds) : '—'
  return `<a class="row row-click" href="${esc(hashFor('calls', { id: rec.id }))}" data-key="row:${esc(rec.id)}">` +
    `<span class="row-lead"><span class="row-lead-icon ${cls}">${ico(iconName)}</span></span>` +
    `<span class="row-body"><span class="row-title">${esc(rec.displayName)} <span class="muted" style="font-weight:400">· ${esc(fmt.dateTime(rec.startedAt, { inSentence: true }))}${dur !== '—' ? ` · ${esc(dur)}` : ''}</span></span>` +
    `<span class="row-sub">${esc(story.sentence)}</span></span>` +
    `<span class="row-actions">${story.chips.slice(0, 2).map(chipHtml).join('')}</span></a>`
}
function emergencyBannerHtml(item, announced) {
  const sameDay = nyDate(item.at) === nyNow().ymd
  const when = sameDay ? fmt.time(item.at) : fmt.dateTime(item.at)
  const until = (toTime(item.at) ?? Date.now()) + DAY_MS
  const untilText = nyDate(until) === addDays(nyNow().ymd, 1) ? `${fmt.time(until)} tomorrow` : fmt.dateTime(until, { inSentence: true })
  const shown = fmt.phone(item.phone)
  const raw = `<strong>Emergency — ${esc(item.phrase)}</strong> reported by ${shown ? esc(shown) : 'a caller with a hidden number'} ${esc(fmt.whenPhrase(item.at) || `at ${when}`)}.` +
    (item.matched ? ` They said "${esc(item.matched)}".` : '') + ` ${esc(item.action)}` +
    `<div class="small" style="margin-top:4px">Shown until ${esc(untilText)}.</div>`
  const actions = (shown ? telBtn(item.phone, `Call ${shown}`, 'btn') : '') + link('calls', { id: item.callId }, 'See the call', 'btn')
  const first = !announced.has(item.callId)
  announced.add(item.callId)
  return html_.banner('danger', '', { raw, actionsHtml: actions, attrs: first ? ' role="alert"' : '', icon: 'siren' })
}

const todayView = {
  title: 'Today', icon: icons.today, root: null, sigKey: null, announced: new Set(),
  mount(root) {
    this.root = root
    root.addEventListener('click', (e) => this.onClick(e))
    const repaint = () => { if (this.root && !this.root.hidden) this.render(state) }
    on('data', repaint); on('minute', repaint)
  },
  onClick(e) {
    const btn = e.target.closest('button[data-action]')
    if (!btn || btn.getAttribute('aria-disabled') === 'true') return
    const fu = followUpsOf(state).find((f) => f && f.id === btn.dataset.fu)
    if (!fu) return
    if (btn.dataset.action === 'done') setFollowUpStatus(fu, 'done', { button: btn })
    else if (btn.dataset.action === 'skip') setFollowUpStatus(fu, 'skipped', { verb: 'not needed', button: btn })
    else if (btn.dataset.action === 'handled') setFollowUpStatus(fu, 'done', { verb: 'handled', button: btn })
  },
  render(s) {
    const root = this.root
    if (!root) return
    const m = todayModel(s)
    const key = JSON.stringify([m.callsValue, m.callsNote, m.toursBooked, m.nextTour, m.needValue, m.oldest, m.leadsOff, m.calOff, m.briefing, m.errors, m.loaded, m.notConfigured, m.callsConfigured,
      m.emergencies.map((x) => [x.callId, x.at, x.matched, x.action, x.name]), m.people.map((x) => [x.type, x.callId, x.respondBy, x.calledAt, fmt.respondPhrase(x.respondBy), x.question, x.name]),
      m.callBacks.map((f) => [f.id, f.dueAt, f.status, fmt.duePhrase(f.dueAt), todoSentence(f, profileByPhone(s, f.phone), s).text]),
      m.tours.map((t) => [t.slotId, t.name, t.unitId, t.past, t.phone]), m.toursTomorrow.length,
      m.records.slice(0, 5).map((r) => [r.id, r.displayName, fmt.dateTime(r.startedAt), callStory(r, s).sentence]), busyNow('leads')])
    if (key === this.sigKey) return
    this.sigKey = key
    const focusKey = root.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key : null
    const loading = !m.callsKnown && !s.loaded.calendar && !m.errors.calls && !m.errors.leads
    let out = `<div class="view-head"><h1 tabindex="-1">Today</h1><p class="dateline small muted">${esc(fmt.dayLong(m.today))} · ${esc(property.name)}</p>${m.briefing ? `<p class="briefing muted">${esc(m.briefing)}</p>` : ''}</div>`
    if (m.notConfigured) { root.innerHTML = out; return }
    out += m.emergencies.map((x) => emergencyBannerHtml(x, this.announced)).join('')
    if (m.leadsOff || m.calOff) {
      const txt = isDemo && !isPersistentDemo ? 'Demo workspace: explore these sample calls, leads and tours. Changes last until the local preview restarts.' : m.leadsOff && m.calOff ? "Heads up: changes aren't being saved right now. Anything you mark may disappear. Ask Atrium support."
        : m.leadsOff ? "Heads up: callers and to-dos aren't being saved right now. Anything you mark here may disappear. Ask Atrium support."
          : "Heads up: calendar changes aren't being saved right now. Blocks you add may disappear. Ask Atrium support."
      out += html_.banner('warn', '', { raw: `<a class="banner-link" href="#/status" style="color:inherit;text-decoration:none">${esc(txt)}</a>` })
    }
    out += `<p class="label muted" style="margin-top:${m.emergencies.length || m.leadsOff || m.calOff ? '16px' : '0'}">Since 6 PM yesterday</p>`
    if (loading) {
      out += `<div class="tiles" aria-busy="true"><span class="vh">Loading today…</span><div class="skeleton-tile skeleton-row"></div><div class="skeleton-tile skeleton-row"></div><div class="skeleton-tile skeleton-row"></div></div>`
      for (const title of ['Needs a person', 'Call back today', 'Tours today']) out += `<section class="section">${sectionHead(title)}${html_.skeletonRows(2)}</section>`
      root.innerHTML = out
      return
    }
    const tile = (label_, value, note, extra) => `<a class="card big-number${extra || ''}" href="${esc(extra === ' big-number-warn' || label_.includes('person') ? '#needs-a-person' : (label_ === 'Calls' ? '#/calls' : '#/calendar'))}" data-key="tile:${esc(label_)}"><span class="big-number-label">${esc(label_)}</span><span class="big-number-value num">${esc(value)}</span><span class="big-number-note">${note}</span></a>`
    const callsNote = m.callsNote === 'notConnected' ? `<a href="#/status" class="link">Call history isn't connected</a>` : esc(m.callsNote || '')
    const toursVal = m.toursBooked == null ? '—' : String(m.toursBooked)
    const needVal = m.needValue == null ? '—' : String(m.needValue)
    out += `<div class="tiles">${tile('Calls', m.callsValue === '—' ? '—' : m.callsValue, callsNote)}` +
      `${tile(m.toursBooked === 1 ? 'Tour booked' : 'Tours booked', toursVal, esc(m.toursBooked == null ? '' : (m.nextTour ? `next one ${m.nextTour}` : 'none today')))}` +
      `${tile(m.needValue === 1 ? 'Needs a person' : 'Need a person', needVal, esc(m.needValue == null ? '' : (m.needs.length ? `oldest waiting ${fmt.elapsed(m.now - m.oldest)}` : 'all handled')), m.needValue > 0 ? ' big-number-warn' : '')}</div>`
    // Needs a person — every needsPerson item in order, the live emergency first (it is also the banner
    // above), so the count here is the tile's, the badge's and the briefing sentence's number.
    out += `<section class="section today-list" id="needs-a-person">${sectionHead('Needs a person', m.needs.length)}`
    out += pollBanner(s, 'leads', 'callers')
    if (m.needs.length) out += `<div class="card card-warn rows">${m.needs.map((p) => personRowHtml(p, s)).join('')}</div>`
    else if (s.loaded.leads) out += `<div class="card">${html_.empty({ title: 'Nothing needs a person right now.', text: "When the assistant hands something off — an accommodation question, a dispute, a tour it couldn't book — it shows up here." })}</div>`
    out += '</section>'
    // Call back today
    const more = m.callBacks.length > 6 ? link('leads', { tab: 'todo' }, `See all ${m.callBacks.length} in Leads ›`, 'btn-link') : ''
    out += `<section class="section today-list">${sectionHead('Call back today', m.callBacks.length, more)}`
    if (!m.needs.length) out += pollBanner(s, 'leads', 'callers')
    if (m.callBacks.length) out += `<div class="card rows">${m.callBacks.slice(0, 6).map((f) => followUpRowHtml(f, s)).join('')}</div>`
    else if (s.loaded.leads) out += `<div class="card">${html_.empty({ title: 'No one to call back today.', text: "To-dos the assistant creates — a tour to confirm, a question it couldn't answer — appear here on the day they're due." })}</div>`
    out += '</section>'
    // Tours today
    const tomorrowLink = m.toursTomorrow.length ? link('calendar', { date: addDays(m.today, 1) }, `Tomorrow: ${text.plural(m.toursTomorrow.length, 'tour')} ›`, 'btn-link') : ''
    out += `<section class="section today-list">${sectionHead('Tours today', m.tours.length, tomorrowLink)}`
    out += pollBanner(s, 'calendar', 'the calendar')
    if (m.tours.length) out += `<div class="card rows">${m.tours.map((t) => tourRowHtml(t, s, m.today)).join('')}</div>`
    else if (s.loaded.calendar || s.loaded.leads) out += `<div class="card">${html_.empty({ title: 'No tours today.', text: "When the assistant books one, it shows up here with the caller's name and apartment." })}</div>`
    out += '</section>'
    // Recent calls
    out += `<section class="section today-list">${sectionHead('Recent calls', null, link('calls', {}, 'All calls ›', 'btn-link'))}`
    out += pollBanner(s, 'calls', 'calls')
    if (s.callsConfigured === false) out += html_.banner('info', "Call recordings and transcripts aren't connected, so this list is built from the assistant's notes.")
    if (m.records.length) out += `<div class="card rows">${m.records.slice(0, 5).map((r) => recentCallRowHtml(r, s)).join('')}</div>`
    else if (s.loaded.calls || s.loaded.leads) out += `<div class="card">${html_.empty({ title: 'No calls yet.', text: 'Calls to the leasing line show up here within a minute of ending.' })}</div>`
    out += '</section>'
    root.innerHTML = out
    if (focusKey) { const el = root.querySelector(`[data-key="${cssq(focusKey)}"]`); if (el) { try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
    paintBusy('leads')
  },
  badge(s) { return needsPerson(s).length || null },
}
// The "Need a person" tile scrolls to its section rather than switching views.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href="#needs-a-person"]')
  if (!a) return
  e.preventDefault()
  const sec = document.getElementById('needs-a-person')
  if (!sec) return
  sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  const h = sec.querySelector('h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }) }
})

// ---------------------------------------------------------------------------------------
// Status and Demo tools (§11)
// ---------------------------------------------------------------------------------------

const ASSISTANT_PARA = "It answers the leasing line, learns what a caller is looking for, quotes only the apartments on the live availability list, answers questions from the approved building information, offers real tour times and books them on this calendar. It doesn't guess: if it hasn't been told something, it says so and offers a call back. It never handles accommodation requests, fair-housing or legal questions, disputes, eligibility or payments — those always go to a person, and you'll see them under \"Needs a person\". If a caller reports an emergency it gives them the safety instruction for it (get out and call 911 for gas, smoke or carbon monoxide), then flags it on Today. It doesn't make outgoing calls or send messages yet."

function storeLine(store) {
  if (!store) return 'not loaded yet'
  return `${String(store.kind ?? '?')} · ${store.durable ? 'durable' : 'not durable'} · "${String(store.note ?? '')}"`
}
const statusView = {
  title: 'Status', icon: icons.status, root: null, sigKey: null, busyAction: false, demoFocused: null,
  mount(root) {
    this.root = root
    root.addEventListener('click', (e) => this.onClick(e))
    const repaint = () => { if (this.root && !this.root.hidden) this.render(state) }
    on('data', repaint); on('poll', repaint); on('minute', repaint)
    on('route', () => { if (this.root && !this.root.hidden) this.focusDemo() })
  },
  render(s) {
    const root = this.root
    if (!root || this.busyAction) return
    const rows = statusRows()
    // "Updated just now" for a minute after Refresh now was pressed (the minute tick repaints it back to the clock time)
    const justNow = Boolean(this.refreshedAt) && Date.now() - this.refreshedAt < 60000
    const at = justNow ? 'just now' : (s.updatedAt ? fmt.time(s.updatedAt) : '')
    const counts = { calls: arr(s.calls).length, slots: arr(s.calendar && s.calendar.slots).length, leads: profilesOf(s).length, todos: followUpsOf(s).length }
    const week = this.weekDays(s)
    const model = { rows, at, errors: s.errors, lastWriteError: s.lastWriteError, health: s.health, counts, lastPollAt: s.lastPollAt, lstore: s.leads && s.leads.store, cstore: s.calendar && s.calendar.store,
      callsError: s.callsError, callsConfigured: s.callsConfigured, outbound: Boolean(s.leads && s.leads.outboundEnabled), notConfigured: s.notConfigured, weekDays: week.length, weekSkipped: week.skipped.length, calLoaded: Boolean(s.calendar) }
    const key = JSON.stringify(model)
    if (key === this.sigKey) return
    this.sigKey = key
    const focusKey = root.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key : null
    const savingRow = (labelText, v) => {
      if (v === null) return `<div class="status-row"><span class="dot dot-neutral"></span><span class="muted">${esc(labelText)}: not loaded yet</span></div>`
      const off = v !== 'on'
      const word = v === 'on' ? (isPersistentDemo ? 'Sample data saved locally' : 'Saving on') : v === 'temp' ? 'Saving temporarily unavailable — check the connection' : isDemo && !isPersistentDemo ? 'Demo data — resets when the preview restarts' : 'Saving off — changes may be lost'
      return `<div class="status-row"><span class="dot${off ? ' dot-warn' : ''}"></span><span class="${off ? 'warn-text' : ''}">${off ? ico('cloud-off') : ico('check')} ${esc(labelText)}: ${esc(word)}</span></div>`
    }
    const rec = rows.recordings
    const recText = isDemo ? 'Sample calls and transcripts are included for this demo account.' : rec === null ? 'Checking…' : rec === 'on' ? 'Connected — recordings and transcripts are available for the 20 most recent calls.'
      : rec === 'off' ? "Not connected yet — calls still show from the leads' records, without recordings or transcripts. Ask Atrium support." : 'Connected, but not answering right now — trying again.'
    const summaryOk = rows.ok
    let out = `<div class="view-head"><h1 tabindex="-1">Status</h1></div><div class="status-col">`
    out += `<div class="card status-summary ${summaryOk ? 'is-ok' : 'is-warn'}"><div style="display:flex;gap:10px;min-width:0">${ico(summaryOk ? 'check-circle' : 'warning')}<div><div class="summary-title">${summaryOk ? 'All connections are available.' : 'Something needs attention.'}</div>` +
      `<div class="summary-sub">${rows.reconnecting ? `Trying to reconnect…${at ? ` showing what we had at ${esc(at)}` : ''}` : (at ? `Updated ${esc(at)}` : 'Loading…')}</div></div></div>` +
      `<button type="button" class="btn" data-action="refresh" data-key="refresh">Refresh now</button></div>`
    out += `<section class="status-section"><h2>Saving</h2>${savingRow('Callers and to-dos', rows.leadsSaving)}${savingRow('Calendar', rows.calendarSaving)}` +
      (!isDemo && (rows.leadsSaving === 'off' || rows.calendarSaving === 'off') ? `<p class="status-p muted small">Ask Atrium support to turn saving on.</p>` : '') + '</section>'
    out += `<section class="status-section"><h2>Call recordings and transcripts</h2><div class="status-row"><span class="dot${rec === 'on' ? '' : rec === null ? ' dot-neutral' : ' dot-warn'}"></span><span class="${rec === 'on' || rec === null ? '' : 'warn-text'}">${esc(recText)}</span></div></section>`
    out += isDemo ? `<section class="status-section" id="phone-assistant"><h2>Phone assistant</h2><p class="status-p">This demo uses sample conversations. It does not update your live phone assistant.</p></section>` : `<section class="status-section" id="phone-assistant"><h2>Phone assistant</h2><p class="status-p">${databaseMode ? 'Phone assistant changes require an administrator and a verified property connection.' : 'Apply the latest leasing instructions and tools to your phone assistant. Your existing voice, model, and webhook authentication settings are preserved.'}</p>${!databaseMode ? '<div class="status-actions"><button type="button" class="btn" data-action="sync-assistant" data-key="sync-assistant" data-permission="configure">Update the phone assistant</button></div>' : ''}</section>`
    out += `<section class="status-section"><h2>Outgoing calls</h2><div class="status-row"><span class="dot dot-neutral"></span><span>${model.outbound ? 'The assistant can make outgoing calls.' : "The assistant answers calls; it doesn't make them. Everything under To do is for your team."}</span></div></section>`
    out += `<section class="status-section"><h2>Times</h2><p class="status-p">All times on this page use ${esc(property.timeZoneLabel)} (${esc(property.timeZone)}).</p></section>`
    out += `<section class="status-section"><h2>Signed in</h2><p class="status-p">${window.ATRIUM_ACCOUNT ? `Signed in as <strong>${esc(window.ATRIUM_ACCOUNT.username)}</strong> to ${esc(databaseMode ? property.name : window.ATRIUM_ACCOUNT.displayName)}. ` : "You're signed in on this device. "}${databaseMode && !permissionAllowed('operate') ? 'Your property access is view only. ' : ''}Sessions end after 8 hours. Sign out before switching accounts.</p><div class="status-actions"><button type="button" class="btn" data-action="signout" data-key="signout">Sign out</button></div></section>`
    out += `<section class="status-section"><h2>Who can see this</h2><p class="status-p">This page has callers' names, numbers and what they said. Keep it to the leasing team, don't screenshot it into a shared channel, and sign out when you're done.</p></section>`
    out += `<section class="status-section"><h2>What the assistant does and doesn't do</h2><p class="status-p">${esc(ASSISTANT_PARA)}</p></section>`
    const support = []
    support.push(['Callers and to-dos', storeLine(model.lstore)])
    support.push(['Calendar', storeLine(model.cstore)])
    support.push(['Call history', s.callsError ? `"${s.callsError}"` : (s.callsConfigured === true ? 'connected' : 'not loaded yet')])
    support.push(['Last error', s.lastWriteError ? `"${s.lastWriteError.message}" · ${fmt.dateTime(s.lastWriteError.at)}${s.lastWriteError.doing ? ` · ${s.lastWriteError.doing}` : ''}` : 'none'])
    support.push(['Last refresh', s.lastPollAt ? `${s.lastPollAt} · calls ${counts.calls} · slots ${counts.slots} · leads ${counts.leads} · to-dos ${counts.todos}` : 'not yet'])
    for (const [name, err] of Object.entries(s.errors)) support.push([`Can't load ${name}`, `"${err.message}"${err.status ? ` · HTTP ${err.status}` : ''} · ${fmt.dateTime(err.at)}`])
    if (s.health) support.push(['Health check', `${s.health.store} · ${s.health.durable ? 'durable' : 'not durable'} · call history ${s.health.callHistory ? 'on' : 'off'} · "${s.health.hint}"`])
    out += `<details class="support status-section" data-key="support"><summary>${ico('chevron-down')}For support</summary><dl class="facts">${support.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`
    const weekN = model.weekDays
    const weekNote = model.calLoaded && !weekN && model.weekSkipped ? ' Every remaining day of this week is already blocked.' : (model.weekSkipped ? ` ${text.plural(model.weekSkipped, 'day is', 'days are')} already blocked and will be left as ${model.weekSkipped === 1 ? 'it is' : 'they are'}.` : '')
    if (!databaseMode) out += `<section class="card card-demo status-section" id="demo-tools"><div class="demo-head" tabindex="-1" data-key="demo-head">${ico('warning')}<span>Demo tools</span></div><p class="demo-standing">These are for demos and testing. They change real data.</p>` +
      `<div class="demo-row"><p>Try it: call the leasing line and the call shows up on Today within a minute.</p><a class="btn" href="${esc(href.tel(property.leasingPhone))}">Call ${esc(property.leasingPhoneDisplay)}</a></div>` +
      `<div class="demo-row"><p>Blocks every remaining day of this week so a caller is told there's nothing available.${esc(weekNote)}</p><button type="button" class="btn" data-action="block-week" data-key="block-week" data-write="calendar"${model.calLoaded && weekN ? '' : ' aria-disabled="true"'}>Block the rest of this week</button><div class="demo-progress" hidden></div></div>` +
      `<div class="demo-row"><p>Removes every tour from the calendar, including real ones. Only for resetting a demo.</p><button type="button" class="btn btn-danger" data-action="clear-bookings" data-key="clear-bookings" data-write="calendar">Delete all tours</button></div>` +
      `<div class="demo-row"><p>Removes every caller and to-do so you can run a fresh demo. Don't use this with real callers.</p><button type="button" class="btn btn-danger" data-action="clear-leads" data-key="clear-leads" data-write="leads">Delete all callers</button></div></section>`
    out += '</div>'
    // an open "For support" and the focused control survive the re-render a poll causes
    const wasOpen = new Set([...root.querySelectorAll('details[open]')].map((d) => d.dataset.key))
    root.innerHTML = out
    for (const d of root.querySelectorAll('details')) if (wasOpen.has(d.dataset.key)) d.open = true
    if (focusKey) { const el = root.querySelector(`[data-key="${cssq(focusKey)}"]`); if (el) { try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ } } }
    paintBusy('leads'); paintBusy('calendar')
    this.focusDemo()
  },
  /** #/status?section=demo scrolls to and focuses the Demo tools heading once per hash. */
  focusDemo() {
    const r = route()
    if (!this.root || r.name !== 'status' || r.params.section !== 'demo' || this.demoFocused === location.hash) return
    const head = this.root.querySelector('.demo-head')
    if (!head) return
    this.demoFocused = location.hash
    head.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    head.focus({ preventScroll: true })
  },
  /** NY dates from today through this Saturday that have slots and are not already blocked all day;
   *  `.skipped` carries the ones left out because they are (a re-block is a no-op that keeps the old reason). */
  weekDays(s) {
    const cal = s.calendar
    const out = []
    out.skipped = []
    if (!cal) return out
    const today = nyNow().ymd, dow = dayOfWeek(today)
    const days = []
    for (let i = 0; dow + i <= 6; i++) days.push(addDays(today, i))
    const withSlots = new Set(arr(cal.slots).map((x) => x && x.date))
    const blocked = new Set(arr(cal.blocks).flatMap(derive.wholeDayBlockDates))
    for (const d of days) { if (!withSlots.has(d)) continue; if (blocked.has(d)) out.skipped.push(d); else out.push(d) }
    return out
  },
  onClick(e) {
    const btn = e.target.closest('button[data-action]')
    if (!btn || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('is-busy')) return
    const a = btn.dataset.action
    if (a === 'refresh') this.refreshNow(btn)
    else if (a === 'signout') this.signOut(btn)
    else if (a === 'block-week') this.blockWeek(btn)
    else if (a === 'clear-bookings') this.clearBookings(btn)
    else if (a === 'clear-leads') this.clearLeads(btn)
    else if (a === 'sync-assistant') this.syncAssistant(btn)
  },
  async syncAssistant(btn) {
    const ok = await confirm('This rewrites the phone assistant\'s script and tools in Vapi to match this system. Voice, timing and model settings in Vapi are kept.', { title: 'Update the phone assistant?', confirmLabel: 'Update' })
    if (!ok) return
    btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true')
    try {
      const r = await api.post('/api/vapi-sync', {}, { doing: 'updating the phone assistant' })
      const name = r && r.assistant && r.assistant.name ? `"${r.assistant.name}"` : 'the assistant'
      toast(`Updated ${name}: ${(r.updated || []).join(', ')}.`, { kind: 'ok', ms: 9000 })
    } catch (e) {
      if (e.signedOut) return
      toast(`Couldn't update the phone assistant. ${e.message || ''}`.trim(), { kind: 'error', ms: 12000 })
    } finally { if (btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') } }
  },
  /** A round finishes in a few ms, so the busy state is held for 600 ms and the result is said in a toast. */
  async refreshNow(btn) {
    this.busyAction = true
    btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true')
    const started = Date.now()
    const before = state.updatedAt
    try { await refresh() } finally {
      await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - started))))
      this.busyAction = false
      const fresh = state.updatedAt && state.updatedAt !== before && state.failedRounds === 0
      this.refreshedAt = fresh ? Date.now() : null
      this.sigKey = null; this.render(state)
      if (fresh) toast(`Up to date · ${fmt.time(state.updatedAt)}`, { kind: 'ok', key: 'refresh' })
      else toast(`Couldn't reach the server.${state.updatedAt ? ` Showing what we had at ${fmt.time(state.updatedAt)}.` : ''}`, { kind: 'warn', key: 'refresh' })
    }
  },
  async signOut(btn) {
    btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true')
    if (databaseMode) invalidateDocument('Signing out. Sign in again to continue.', 401)
    stopPolling(); gated = true
    try {
      await fetch('/api/dashboard', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { ...JSON_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) })
    } catch (e) { /* the reload lands on the sign-in page either way */ }
    location.reload()
  },
  async blockWeek(btn) {
    const days = this.weekDays(state)
    if (!days.length) { toast(state.calendar ? 'Every remaining day of this week is already blocked.' : "The calendar isn't reachable right now.", { kind: 'warn' }); return }
    const skipped = days.skipped.map((d) => WD_LONG[dayOfWeek(d)])
    const intro = `Callers will be told there's nothing open. Tours already booked stay.${skipped.length ? ` ${text.list(skipped)} ${skipped.length > 1 ? 'are' : 'is'} already blocked and will be left as ${skipped.length > 1 ? 'they are' : 'it is'}.` : ''}`
    const reason = await prompt('Reason (optional)', { title: 'Block the rest of this week?', placeholder: 'e.g. demo', confirmLabel: `Block ${text.plural(days.length, 'day')}`, intro })
    if (reason === null) return
    await this.blockDays(days, reason.trim().slice(0, 120), skipped)
  },
  async blockDays(days, reason, skipped) {
    const root = this.root
    const btn = root.querySelector('[data-action="block-week"]'), progress = root.querySelector('.demo-progress')
    this.busyAction = true
    if (btn) { btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true') }
    const blocked = []
    let failedDay = null, signedOutNow = false
    await busy('calendar', (async () => {
      for (const d of days) {
        if (progress) { progress.hidden = false; progress.textContent = `Blocking ${WD_LONG[dayOfWeek(d)]}…` }
        try {
          const body = { action: 'block', target: d }
          if (reason) body.reason = reason
          const res = await api.post('/api/calendar', body, { doing: 'blocking the rest of the week' })
          apply('calendar', res)
          blocked.push(d)
        } catch (e) { if (e.signedOut) { signedOutNow = true; return } failedDay = d; break }
      }
    })())
    this.busyAction = false
    if (signedOutNow) return
    if (progress) { progress.hidden = true; progress.textContent = '' }
    if (btn && btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') }
    const long = (d) => WD_LONG[dayOfWeek(d)], short = (d) => WD[dayOfWeek(d)]
    const sk = arr(skipped)
    const skippedNote = sk.length ? ` (${text.list(sk)} ${sk.length > 1 ? 'were' : 'was'} already blocked)` : ''
    if (!failedDay) toast((blocked.length > 1 ? `Blocked ${short(blocked[0])} – ${short(blocked[blocked.length - 1])}` : `Blocked ${long(blocked[0])}`) + skippedNote, { kind: 'ok' })
    else {
      const idx = days.indexOf(failedDay), rest = days.slice(idx)
      const retry = { label: 'Try again', fn: () => { this.blockDays(rest, reason, sk) } }
      if (!blocked.length) toast("Couldn't do that. Nothing changed — try again.", { kind: 'error', actions: [retry] })
      else toast(`Couldn't block ${long(failedDay)}. ${text.list(blocked.map(long))} ${blocked.length > 1 ? 'are' : 'is'} blocked${days[idx + 1] ? `; ${long(days[idx + 1])} onward isn't` : ''}.`, { kind: 'error', actions: [retry] })
      reread('calendar')
    }
    this.sigKey = null; this.render(state)
  },
  async clearBookings(btn) {
    const ok = await confirm('This removes every tour on the calendar, including real ones. Only for resetting a demo.', { title: 'Delete every tour?', confirmLabel: 'Delete all tours', danger: true })
    if (!ok) return
    btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true')
    try {
      const res = await busy('calendar', api.post('/api/calendar', { action: 'clear_bookings' }, { doing: 'deleting all tours' }))
      apply('calendar', res)
      toast('Deleted all tours', { kind: 'ok' })
    } catch (e) {
      if (e.signedOut) return
      toast("Couldn't do that. Nothing changed — try again.", { kind: 'error' })
      reread('calendar')
    } finally { if (btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') } }
  },
  async clearLeads(btn) {
    const ok = await confirm('This removes every caller and every to-do, including real ones. Only for resetting a demo.', { title: 'Delete every caller and to-do?', confirmLabel: 'Delete all callers', danger: true })
    if (!ok) return
    btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true')
    try {
      await busy('leads', api.post('/api/leads', { action: 'clear_leads' }, { doing: 'deleting all callers' }))
      apply('leads', { profiles: [], followUps: [] })
      toast('Deleted all callers and to-dos', { kind: 'ok' })
    } catch (e) {
      if (e.signedOut) return
      toast("Couldn't do that. Nothing changed — try again.", { kind: 'error' })
      reread('leads')
    } finally { if (btn.isConnected) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy') } }
  },
}

// ---------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------

function boot() {
  if (booted) return
  booted = true
  for (const button of document.querySelectorAll('[data-property-switch]')) button.addEventListener('click', openPropertySwitcher)
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon)
  // the Inter stylesheet arrived as media="print" so it never blocked first paint; apply it now (index.html)
  for (const l of document.querySelectorAll('link[data-font-swap]')) l.media = 'all'
  register('today', todayView)
  register('status', statusView)
  paintChrome()
  applyRoute()
  window.addEventListener('hashchange', applyRoute)
  window.addEventListener('popstate', applyRoute)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSoon() })
  window.addEventListener('focus', pollSoon)
  setInterval(() => { emit('minute', state); paintChrome() }, 60000)
  startPolling()
  fetchHealth().then(paintChrome)
}

window.Atrium = {
  escapeHtml, fmt, api, gate, toast, confirm, prompt, dialog, register, navigate, route, hashFor, state, on,
  busy, busyNow, apply, refresh, calendarUrl, setCalendarRange, icons, icon, property, normalisePhone, labels, label, derive, hint, text, href,
  can: permissionAllowed, paintPermissions, preferenceKey, propertyUrl, databaseMode,
  html: html_, announce, escape: escape_, setFollowUpStatus, boot, views: VIEWS.slice(),
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
})()
