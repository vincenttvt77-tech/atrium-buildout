#!/usr/bin/env node
/**
 * Local preview server for the operations dashboard.
 *
 *   npm run dev:ops              → http://localhost:4300/   (passcode: demo)
 *   node scripts/dev-ops.mjs --no-seed
 *   PORT=5000 node scripts/dev-ops.mjs
 *
 * What it does, and why it is shaped this way:
 *
 *   - Mounts the REAL handlers in `api/*.ts` (Node strips the types; no build step) behind a
 *     small Vercel-style req/res shim. Sign-in, cookies, the passcode gate, the calendar and
 *     the lead pipeline are the production code paths, not a mock of them.
 *   - Forces the in-memory stores: `OPS_DASHBOARD_PASSCODE=demo` unless one is already set,
 *     and no KV variables, so nothing here can touch a real database. State resets on restart.
 *   - `GET /api/vapi` answers from `scripts/dev-fixtures/calls.json` when no Vapi key is set,
 *     so the Calls view has realistic transcripts and tool calls to render. With a key set the
 *     real Vapi history is used unchanged.
 *   - `--seed` (default) replays the fixture's calls through the real webhook — Vapi-shaped
 *     `transcript`, `tool-calls` and `end-of-call-report` posts — so the leads, follow-ups,
 *     bookings and decision events exist exactly as production would have written them. Each
 *     call is replayed under a clock set to its own start time (see `withClock`), which is the
 *     only way the real code can produce a tour that is already in the past ("toured").
 *   - Serves `/` through `api/dashboard.ts` so the login form and cookie flow are real. On a
 *     200 the body is the page composed live from `ops/src/` (what `npm run build:ops` would
 *     write), so builders edit, refresh, and see it — `--built` serves the embedded build
 *     instead.
 *
 * No npm dependencies. Plain Node 22.
 */
import { createServer } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const RealDate = Date
const DAY = 86_400_000
const ZONE = 'America/New_York'
const root = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE_PATH = join(root, 'scripts', 'dev-fixtures', 'calls.json')

// ---------------------------------------------------------------------------------------
// CLI and environment — before any handler is imported, because the stores and the passcode
// are read at import time (`api/calendar.ts`, `api/leads.ts`, `api/vapi.ts`).
// ---------------------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    seed: { type: 'boolean', default: true },
    built: { type: 'boolean', default: false },
    port: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowNegative: true,
})

if (flags.help) {
  console.log(`Usage: node scripts/dev-ops.mjs [--no-seed] [--built] [--port N]

  --no-seed   start with an empty store (fixture calls are still served on GET /api/vapi)
  --built     serve ops/dashboard.page.json as embedded at startup instead of composing ops/src live
  --port N    listen on N (default 4300; the PORT environment variable also works)
`)
  process.exit(0)
}

const defaultPasscode = !(process.env.OPS_DASHBOARD_PASSCODE ?? '').trim()
if (defaultPasscode) process.env.OPS_DASHBOARD_PASSCODE = 'demo'
for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
  if (process.env[name] !== undefined) {
    console.warn(`[dev-ops] ignoring ${name}: the preview always uses the in-memory store`)
    delete process.env[name]
  }
}
const PASSCODE = process.env.OPS_DASHBOARD_PASSCODE
const VAPI_KEY_SET = Boolean((process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY ?? '').trim())
const WEBHOOK_SECRET = (process.env.VAPI_WEBHOOK_SECRET ?? '').trim()
const PORT = Number(flags.port ?? process.env.PORT ?? 4300)

const load = (rel) => import(pathToFileURL(join(root, rel)).href)

// `api/dashboard.ts` imports ops/dashboard.page.json at load, so it has to exist first.
const buildOps = await load('scripts/build-ops.mjs')
try {
  await access(buildOps.OUTPUT)
} catch {
  console.log('[dev-ops] ops/dashboard.page.json is missing — running build:ops once')
  await buildOps.buildOpsPage()
}

const [dashboard, calendar, leads, vapi, health, ny, vapiCalls, calendarStore] = await Promise.all([
  load('api/dashboard.ts'), load('api/calendar.ts'), load('api/leads.ts'), load('api/vapi.ts'),
  load('api/health.ts'), load('src/time/ny.ts'), load('src/ops/vapi-calls.ts'), load('src/calendar/store.ts'),
])

const ROUTES = {
  '/api/dashboard': dashboard.default,
  '/api/calendar': calendar.default,
  '/api/leads': leads.default,
  '/api/vapi': vapi.default,
  '/api/health': health.default,
}

// ---------------------------------------------------------------------------------------
// Vercel-style request/response shim. Every member the handlers touch is here:
//   req: method, url, headers, body, query, cookies, socket
//   res: status().json()/.send()/.end(), setHeader/getHeader/removeHeader/hasHeader,
//        writeHead, write, redirect, statusCode, headersSent
// `invoke` runs a handler against plain objects and resolves with what it wrote, so the same
// code serves HTTP requests and drives the handlers in-process while seeding.
// ---------------------------------------------------------------------------------------

function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || Object.hasOwn(out, name)) continue
    const value = part.slice(eq + 1).trim()
    try { out[name] = decodeURIComponent(value) } catch { out[name] = value }
  }
  return out
}

function parseQuery(searchParams) {
  const out = {}
  for (const [k, v] of searchParams) {
    if (out[k] === undefined) out[k] = v
    else out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v]
  }
  return out
}

/** What Vercel hands a function as `req.body` for each content type. */
function parseBody(raw, contentType) {
  if (raw === undefined || raw === null) return undefined
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') return raw // already an object (seeding)
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length === 0) return undefined
  const type = String(contentType ?? '').toLowerCase()
  const text = buf.toString('utf8')
  if (type.includes('application/json')) {
    // A malformed body is handed over as the raw string so the handler's own error path runs
    // (api/vapi.ts parses inside its try for exactly this reason).
    try { return JSON.parse(text) } catch { return text }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text))
  if (type.startsWith('text/')) return text
  return buf
}

function shimRequest({ method, url, headers = {}, body, socket }) {
  const parsed = new URL(url, 'http://localhost')
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  // Plain http in front of a handler that decides `Secure` from x-forwarded-proto: say so, the
  // way a local proxy would, so the session cookie also works on a non-localhost hostname.
  if (lower['x-forwarded-proto'] === undefined) lower['x-forwarded-proto'] = 'http'
  return {
    method,
    url,
    headers: lower,
    query: parseQuery(parsed.searchParams),
    cookies: parseCookies(lower.cookie),
    body: parseBody(body, lower['content-type']),
    socket: socket ?? { remoteAddress: '127.0.0.1' },
  }
}

function shimResponse() {
  const headers = new Map()
  const chunks = []
  let statusCode = 200
  let ended = false
  let json
  let resolve
  const done = new Promise((r) => { resolve = r })

  const finish = (body) => {
    if (ended) return
    ended = true
    if (body !== undefined && body !== null && body !== '') chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    resolve({ status: statusCode, headers, body: Buffer.concat(chunks), json })
  }

  const res = {
    get statusCode() { return statusCode },
    set statusCode(v) { statusCode = Number(v) },
    get headersSent() { return ended },
    get finished() { return ended },
    status(n) { statusCode = Number(n); return res },
    setHeader(k, v) { headers.set(String(k).toLowerCase(), v); return res },
    getHeader(k) { return headers.get(String(k).toLowerCase()) },
    getHeaders() { return Object.fromEntries(headers) },
    hasHeader(k) { return headers.has(String(k).toLowerCase()) },
    removeHeader(k) { headers.delete(String(k).toLowerCase()); return res },
    writeHead(n, extra) {
      statusCode = Number(n)
      if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) res.setHeader(k, v)
      return res
    },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true },
    json(obj) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
      json = obj
      finish(JSON.stringify(obj))
      return res
    },
    send(body) {
      if (body === undefined || body === null) return res.end()
      if (typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body)
      if (!headers.has('content-type')) {
        headers.set('content-type', Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/html; charset=utf-8')
      }
      finish(body)
      return res
    },
    end(body) { finish(body); return res },
    redirect(a, b) {
      const [status, url] = typeof a === 'number' ? [a, b] : [307, a]
      statusCode = status
      headers.set('location', url)
      finish('')
      return res
    },
  }
  return { res, done }
}

/** Runs one handler to completion. Never rejects: a thrown handler becomes a 500. */
async function invoke(handler, request) {
  const req = shimRequest(request)
  const { res, done } = shimResponse()
  const timeout = new Promise((r) => setTimeout(() => r({ timedOut: true }), 30_000).unref())
  try {
    await handler(req, res)
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
    console.error('[dev-ops] handler threw:', err)
  }
  const out = await Promise.race([done, timeout])
  if (out.timedOut) {
    return { status: 500, headers: new Map([['content-type', 'application/json; charset=utf-8']]),
      body: Buffer.from(JSON.stringify({ error: 'handler did not respond within 30s' })), json: null }
  }
  return out
}

const opsHeaders = (extra = {}) => ({ 'x-ops-passcode': PASSCODE, accept: 'application/json', ...extra })

async function api(handler, method, url, body) {
  const headers = opsHeaders(body === undefined ? {} : { 'content-type': 'application/json' })
  const out = await invoke(handler, { method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  if (out.status >= 400) {
    const message = out.json?.error ?? out.body.toString('utf8').slice(0, 200)
    throw new Error(`${method} ${url} → ${out.status}: ${message}`)
  }
  return out.json
}

// ---------------------------------------------------------------------------------------
// A clock the handlers believe. They call `new Date()` and `Date.now()`; every date they build
// from an argument still works, because only the zero-argument forms are redirected.
// Seeding is strictly sequential and finishes before the server listens, so nothing else can
// observe the substituted clock.
// ---------------------------------------------------------------------------------------

async function withClock(at, fn) {
  const fixed = at.getTime()
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args) }
    static now() { return fixed }
  }
  globalThis.Date = FakeDate
  try { return await fn() } finally { globalThis.Date = RealDate }
}

// ---------------------------------------------------------------------------------------
// Fixture: scripts/dev-fixtures/calls.json (format documented in scripts/dev-fixtures/README.md)
// ---------------------------------------------------------------------------------------

const STARTED = new RealDate()
const nyDayOffset = (n) => ny.nyDate(new RealDate(STARTED.getTime() + n * DAY))
const wallMinutes = (iso) => { const w = ny.nyWall(new RealDate(iso)); return w.hour * 60 + w.minute }

const fmtSlot = (d) => d.toLocaleString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ZONE,
})

/** "-3d 14:40" → that New York wall time N days before today; an ISO instant passes through. */
function resolveWhen(spec, durationSeconds) {
  const m = /^([+-]?\d+)d\s+(\d{1,2}):(\d{2})$/.exec(String(spec).trim())
  if (!m) {
    const t = new RealDate(spec)
    if (Number.isNaN(t.getTime())) throw new Error(`calls.json: cannot read startedAt "${spec}"`)
    return t
  }
  let w = ny.nyWall(new RealDate(STARTED.getTime() + Number(m[1]) * DAY))
  let at = ny.nyInstant(w.year, w.month, w.day, Number(m[2]), Number(m[3]))
  // A call cannot end in the future. Started early in the day, "today 12:30" moves to yesterday.
  while (at.getTime() + durationSeconds * 1000 > STARTED.getTime() - 60_000) {
    w = ny.nyWall(new RealDate(at.getTime() - DAY))
    at = ny.nyInstant(w.year, w.month, w.day, Number(m[2]), Number(m[3]))
  }
  return at
}

/** "+1@14:00" → the slot on today+1 (NY) at 14:00, else the first at/after it, else the first that day. */
function pickSlot(slots, spec, { open }) {
  const m = /^([+-]?\d+)(?:@(\d{1,2}):(\d{2}))?$/.exec(String(spec).trim())
  if (!m) throw new Error(`cannot read slot spec "${spec}" (expected e.g. "+1@14:00")`)
  const date = nyDayOffset(Number(m[1]))
  const wanted = m[2] ? Number(m[2]) * 60 + Number(m[3]) : 0
  const day = slots.filter((s) => s.date === date && (!open || s.status === 'open'))
  return day.find((s) => wallMinutes(s.startsAt) === wanted)
    ?? day.find((s) => wallMinutes(s.startsAt) >= wanted)
    ?? day[0]
    ?? null
}

async function readCalendarSlots() {
  return (await api(calendar.default, 'GET', '/api/calendar')).slots
}

async function loadFixture() {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))
  const CALL_KEYS = Object.keys(vapiCalls.normaliseCall({}))
  const TOOL_KEYS = ['name', 'arguments', 'result']
  const calls = raw.calls.map((c, i) => {
    const extra = Object.keys(c).filter((k) => !CALL_KEYS.includes(k))
    const missing = CALL_KEYS.filter((k) => !(k in c))
    if (extra.length || missing.length) {
      throw new Error(`calls.json call #${i + 1} (${c.id ?? '?'}): keys must be exactly ${CALL_KEYS.join(', ')}` +
        (extra.length ? `; unexpected: ${extra.join(', ')}` : '') + (missing.length ? `; missing: ${missing.join(', ')}` : ''))
    }
    for (const t of c.toolCalls) {
      const bad = Object.keys(t).filter((k) => !TOOL_KEYS.includes(k))
      if (bad.length || TOOL_KEYS.some((k) => !(k in t))) throw new Error(`calls.json call ${c.id}: tool calls need exactly ${TOOL_KEYS.join(', ')}`)
    }
    const duration = Number(c.durationSeconds ?? 0)
    const startedAt = c.startedAt === null ? null : resolveWhen(c.startedAt, duration)
    const endedAt = c.endedAt ? new RealDate(c.endedAt) : startedAt ? new RealDate(startedAt.getTime() + duration * 1000) : null
    return {
      ...structuredClone(c),
      startedAt: startedAt ? startedAt.toISOString() : null,
      endedAt: endedAt ? endedAt.toISOString() : null,
      durationSeconds: startedAt && endedAt ? Math.round((endedAt - startedAt) / 1000) : c.durationSeconds ?? null,
    }
  })
  calls.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
  return { calls, blocks: raw.blocks ?? [], staff: raw.staff ?? [] }
}

/** Replace the slot placeholder in a call's book_tour and remember the slot for the text tokens. */
async function resolveCallSlots(call) {
  const bookings = call.toolCalls.filter((t) => t.name === 'book_tour' && /^\$slot:/.test(String(t.arguments?.slotId ?? '')))
  if (bookings.length === 0) return
  const slots = await readCalendarSlots()
  for (const t of bookings) {
    const spec = String(t.arguments.slotId).slice('$slot:'.length)
    const slot = pickSlot(slots, spec, { open: true })
    if (!slot) throw new Error(`call ${call.id}: no open slot for "${t.arguments.slotId}" (is that day blocked or in the past?)`)
    t.arguments.slotId = slot.slotId
    call.tour = slot
  }
}

function applyTokens(call) {
  if (!call.tour) return
  const at = new RealDate(call.tour.startsAt)
  const tokens = {
    tour_when: fmtSlot(at),
    tour_day: at.toLocaleString('en-US', { weekday: 'long', timeZone: ZONE }),
    tour_date: at.toLocaleString('en-US', { month: 'long', day: 'numeric', timeZone: ZONE }),
    tour_time: at.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ZONE }),
    tour_iso: ny.nyDate(at),
  }
  const sub = (s) => typeof s === 'string' ? s.replace(/\{\{(\w+)\}\}/g, (m, k) => tokens[k] ?? m) : s
  call.transcript = sub(call.transcript)
  for (const t of call.toolCalls) {
    t.result = sub(t.result)
    for (const [k, v] of Object.entries(t.arguments ?? {})) t.arguments[k] = sub(v)
  }
}

/** Without seeding, the slot list the agent "read out" is still built from the real calendar. */
async function refreshSlotListings(call) {
  for (const t of call.toolCalls) {
    if (t.name !== 'list_tour_slots') continue
    const next = (await readCalendarSlots()).filter((s) => s.status === 'open').slice(0, 6)
    t.result = next.length === 0
      ? 'No tour times are open. Offer to have someone call them back.'
      : `Real open tour times — offer only these, and use the slotId when booking:\n${next.map((s) => `${s.slotId} — ${fmtSlot(new RealDate(s.startsAt))}`).join('\n')}`
  }
}

// ---------------------------------------------------------------------------------------
// Seeding: the fixture replayed through the real webhook, plus the calendar blocks and the
// staff actions (notes, follow-ups marked done) through the real dashboard endpoints.
// ---------------------------------------------------------------------------------------

const callRef = (call) => ({
  id: call.id,
  type: 'inboundPhoneCall',
  ...(call.customerNumber ? { customer: { number: call.customerNumber } } : {}),
})

async function postVapi(message) {
  const headers = opsHeaders({ 'content-type': 'application/json', ...(WEBHOOK_SECRET ? { 'x-vapi-secret': WEBHOOK_SECRET } : {}) })
  const out = await invoke(vapi.default, { method: 'POST', url: '/api/vapi', headers, body: JSON.stringify({ message }) })
  if (out.status !== 200) throw new Error(`POST /api/vapi (${message.type}) → ${out.status}: ${out.body.toString('utf8').slice(0, 200)}`)
  return out.json
}

/** One call, replayed at its own time: what the caller said, what the tools did, the report. */
async function seedCall(call) {
  const results = []
  await withClock(new RealDate(call.startedAt), async () => {
    await resolveCallSlots(call)
    for (const line of String(call.transcript ?? '').split('\n')) {
      if (!line.startsWith('User: ')) continue
      await postVapi({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: line.slice(6), call: callRef(call) })
    }
    let n = 0
    for (const t of call.toolCalls) {
      const id = `${call.id}-tc${++n}`
      const out = await postVapi({
        type: 'tool-calls',
        call: callRef(call),
        toolCallList: [{ id, type: 'function', function: { name: t.name, arguments: t.arguments } }],
      })
      results.push(out?.results?.[0]?.result ?? null)
    }
  })
  await withClock(new RealDate(call.endedAt), () => postVapi({
    type: 'end-of-call-report',
    endedReason: call.endedReason,
    call: { ...callRef(call), startedAt: call.startedAt, endedAt: call.endedAt },
    ...(call.customerNumber ? { customer: { number: call.customerNumber } } : {}),
    durationSeconds: call.durationSeconds,
    cost: call.cost,
    transcript: call.transcript,
    recordingUrl: call.recordingUrl,
    artifact: { transcript: call.transcript },
  }))
  call.toolCalls.forEach((t, i) => { if (results[i] != null) t.result = results[i] })
}

async function seedBlocks(blocks) {
  let slots = null
  const outcomes = []
  for (const b of blocks) {
    let target
    if (/^[+-]?\d+$/.test(String(b.target))) target = nyDayOffset(Number(b.target))
    else {
      slots ??= await readCalendarSlots()
      const slot = pickSlot(slots, b.target, { open: false })
      if (!slot) { console.warn(`[dev-ops] block "${b.target}": no slot found, skipped`); continue }
      target = slot.slotId
    }
    try {
      await api(calendar.default, 'POST', '/api/calendar', { action: 'block', target, reason: b.reason })
      outcomes.push({ target, via: 'api' })
    } catch (err) {
      if (!/^slot-/.test(target)) throw err
      // Known handler defect: api/calendar.ts validates block targets with a regex written for
      // hour-precision ids and rejects the minute-precision ids the API itself emits. Until that
      // is fixed, write the block straight into the same in-memory store so the calendar still
      // shows what a slot-level block looks like. Loud, so nobody mistakes this for the API.
      console.warn(`[dev-ops] POST /api/calendar rejected slot block ${target} (${String(err.message).split(': ').pop()}); writing it to the store directly`)
      const store = calendarStore.calendarStoreFromEnv()
      await store.mutate((s) => s.blocks.some((x) => x.target === target) ? s
        : { ...s, blocks: [...s.blocks, { target, reason: String(b.reason ?? 'blocked').slice(0, 120), blockedAt: new RealDate().toISOString() }] })
      outcomes.push({ target, via: 'store' })
    }
  }
  return outcomes
}

async function seedStaff(actions) {
  let count = 0
  for (const a of actions) {
    if (a.action === 'note') {
      await api(leads.default, 'POST', '/api/leads', { action: 'note', phone: a.phone, text: a.text })
      count++
    } else if (a.action === 'followup_status') {
      const { followUps } = await api(leads.default, 'GET', '/api/leads')
      const match = followUps.find((f) => f.phone === a.phone && f.kind === a.kind)
      if (!match) { console.warn(`[dev-ops] staff action: no ${a.kind} follow-up for ${a.phone}, skipped`); continue }
      await api(leads.default, 'POST', '/api/leads', { action: 'followup_status', id: match.id, status: a.status })
      count++
    } else {
      console.warn(`[dev-ops] staff action "${a.action}" is not known, skipped`)
    }
  }
  return count
}

async function seed(fixture) {
  // The inventory snapshot is cached with the clock of the first tool call and judged stale
  // after 15 minutes (src/inventory/match.ts). Warm it now, at the latest time any seeded
  // call will see, so calls replayed in the past never trip the stale branch.
  await postVapi({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'hello', call: { id: 'dev-warmup' } })

  const blocks = await seedBlocks(fixture.blocks)
  for (const call of fixture.calls) await seedCall(call)
  const staff = await seedStaff(fixture.staff)

  const [leadState, calState] = await Promise.all([
    api(leads.default, 'GET', '/api/leads'), api(calendar.default, 'GET', '/api/calendar'),
  ])
  return { blocks, staff, profiles: leadState.profiles, followUps: leadState.followUps, bookings: calState.bookings }
}

// ---------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------

const fixture = await loadFixture()
let summary = null
if (flags.seed) {
  summary = await seed(fixture)
} else {
  for (const call of fixture.calls) {
    await withClock(new RealDate(call.startedAt ?? STARTED), async () => {
      await resolveCallSlots(call)
      await refreshSlotListings(call)
    })
  }
}
for (const call of fixture.calls) { applyTokens(call); delete call.tour }
const fixtureCalls = [...fixture.calls].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))

let composeWarned = false
async function livePage(fallback) {
  try {
    const { html } = await buildOps.composeOpsPage()
    composeWarned = false
    return html
  } catch (err) {
    if (!composeWarned) console.warn(`[dev-ops] could not compose ops/src (${err.message}); serving the embedded build`)
    composeWarned = true
    return fallback
  }
}

async function readRequestBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('request body over 2 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  const t0 = performance.now()
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname === '/' ? '/api/dashboard' : url.pathname
  const handler = ROUTES[path]
  let status = 0

  try {
    if (!handler) {
      status = url.pathname === '/favicon.ico' ? 204 : 404
      res.statusCode = status
      if (status === 404) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: `no route for ${url.pathname}`, routes: ['/', ...Object.keys(ROUTES)] }))
      } else res.end()
      return
    }

    const out = await invoke(handler, {
      method: req.method, url: req.url, headers: req.headers, body: await readRequestBody(req), socket: req.socket,
    })
    let body = out.body

    if (path === '/api/vapi' && req.method === 'GET' && !VAPI_KEY_SET && out.status === 200 && out.json) {
      body = Buffer.from(JSON.stringify({
        ...out.json,
        calls: fixtureCalls,
        callsError: null,
        callsConfigured: true,
        note: 'Calls from scripts/dev-fixtures/calls.json (local preview, no Vapi key). Decision events are in-process and reset when the server restarts.',
      }))
    } else if (path === '/api/dashboard' && !flags.built && req.method === 'GET' && out.status === 200
      && String(out.headers.get('content-type') ?? '').includes('text/html')) {
      body = Buffer.from(await livePage(out.body.toString('utf8')))
    }

    status = out.status
    for (const [k, v] of out.headers) res.setHeader(k, v)
    res.statusCode = status
    res.end(body)
  } catch (err) {
    status = 500
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
    }
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  } finally {
    const ms = (performance.now() - t0).toFixed(0)
    console.log(`${new RealDate().toISOString().slice(11, 19)} ${req.method} ${url.pathname}${url.search} → ${status} ${ms}ms`)
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[dev-ops] port ${PORT} is already in use — pass --port N or set PORT`)
  else console.error('[dev-ops] server error', err)
  process.exit(1)
})

server.listen(PORT, () => {
  const stages = {}
  for (const p of summary?.profiles ?? []) stages[p.stage] = (stages[p.stage] ?? 0) + 1
  const lines = [
    '',
    'Atrium operations dashboard — local preview',
    `  Open      http://localhost:${PORT}/`,
    `  Sign in   passcode: ${defaultPasscode ? 'demo' : '(OPS_DASHBOARD_PASSCODE from your environment)'}`,
    `  Calls     ${fixtureCalls.length} from scripts/dev-fixtures/calls.json` + (VAPI_KEY_SET ? ' — NOT used: a Vapi key is set, GET /api/vapi reads real history' : ''),
    summary
      ? `  Seeded    ${summary.profiles.length} leads (${Object.entries(stages).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}), ` +
        `${summary.followUps.length} follow-ups, ${summary.bookings.length} bookings, ${summary.blocks.length} blocks` +
        (summary.blocks.some((b) => b.via === 'store') ? ' (slot blocks written to the store — see the warning above)' : '')
      : '  Seeded    nothing (--no-seed): the store is empty until something calls the webhook',
    `  Page      ${flags.built ? 'ops/dashboard.page.json as embedded at startup (restart after build:ops)' : 'composed live from ops/src on every load (--built to serve the embedded build)'}`,
    '  Store     in memory — restart to reset; nothing here reaches a real database',
    `  curl      curl -H 'x-ops-passcode: ${defaultPasscode ? 'demo' : '…'}' http://localhost:${PORT}/api/leads`,
    '',
  ]
  console.log(lines.join('\n'))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); process.exit(0) })
}
