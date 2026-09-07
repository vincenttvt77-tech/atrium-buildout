/**
 * Regenerates every price the public website prints from data/inventory.json.
 *
 * The site inlines its inventory (public/app.js) and pre-renders its availability tables
 * (public/floorplans.html), so when the rents in data/ were recalibrated the phone line
 * quoted the new figures and the website kept showing the old ones — a caller with the
 * site open heard a different number from the one on the screen, which is the single most
 * damaging thing a leasing line can do. This script is the only way those pages get a
 * rent, and src/inventory/test/site-data.test.ts fails if they drift from data/.
 *
 * Rents are net effective. The lease figure is grossed up over the term exactly as
 * src/inventory/pricing.ts does it for the phone.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const TEL = 'tel:+15169909252'

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`
const num = (n) => Number(n).toLocaleString('en-US')
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 }

export function concessionTerms(text) {
  const m = /(\w+)\s+(month|months|week|weeks)\s+free\s+on\s+an?\s+(\d+)[- ]month\s+lease/i.exec(text ?? '')
  if (!m) return null
  const qty = WORDS[m[1].toLowerCase()] ?? Number(m[1])
  const freeMonths = /week/i.test(m[2]) ? qty / 4 : qty
  const termMonths = Number(m[3])
  return Number.isFinite(qty) && termMonths > freeMonths ? { freeMonths, termMonths, qty, weeks: /week/i.test(m[2]) } : null
}
export const leaseRent = (u) => {
  const t = concessionTerms(u.concession)
  return t ? Math.round(u.monthlyRent * t.termMonths / (t.termMonths - t.freeMonths)) : u.monthlyRent
}
/** Mirrors shortConcession() in public/app.js so both surfaces read identically. */
export function shortConcession(text) {
  const t = concessionTerms(text)
  if (!text) return 'No concession'
  if (!t) return text
  const unit = t.weeks ? (t.qty === 1 ? 'week' : 'weeks') : (t.qty === 1 ? 'month' : 'months')
  return `${t.qty} ${unit} free · ${t.termMonths}-mo lease`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function availability(iso, today) {
  const [y, m, d] = iso.split('-').map(Number)
  const now = iso <= today
  return { text: now ? 'Immediate' : `${MONTHS[m - 1]} ${d}, ${y}`, now }
}
const bedsBaths = (b, ba) => `${b === 0 ? 'Studio' : b} / ${ba}`
const onBoard = (u) => u.status === 'available' || u.status === 'pending'

/** The published page contents, computed; nothing is written here. */
export async function renderSite(opts = {}) {
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const units = JSON.parse(await readFile(join(root, 'data', 'inventory.json'), 'utf8'))
  const app = await readFile(join(root, 'public', 'app.js'), 'utf8')
  const fpHtml = await readFile(join(root, 'public', 'floorplans.html'), 'utf8')
  const index = await readFile(join(root, 'public', 'index.html'), 'utf8')

  // Plan metadata (lines, floor range, square-foot range) lives only in app.js.
  const fpBlock = /const FLOORPLANS = \[\n([\s\S]*?)\n\];/.exec(app)
  if (!fpBlock) throw new Error('public/app.js: FLOORPLANS block not found')
  const plans = fpBlock[1].split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l.trim().replace(/,$/, '')))

  const board = units.filter(onBoard)
  const byPlan = new Map(plans.map((p) => [p.id, board.filter((u) => u.floorPlanId === p.id)]))
  for (const p of plans) {
    const mine = byPlan.get(p.id)
    if (mine.length) p.startingRent = Math.min(...mine.map((u) => u.monthlyRent))
  }

  // ---- app.js: the two data blocks
  const KEYS = ['unitId', 'floorPlanId', 'floor', 'bedrooms', 'bathrooms', 'sqft', 'monthlyRent', 'availableFrom', 'exposure', 'view', 'status', 'concession']
  const unitLines = units.map((u) => '  ' + JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, u[k] ?? null])))).join(',\n')
  const planLines = plans.map((p) => '  ' + JSON.stringify(p)).join(',\n')
  let appOut = app.replace(/const FLOORPLANS = \[\n[\s\S]*?\n\];/, () => `const FLOORPLANS = [\n${planLines}\n];`)
  appOut = appOut.replace(/const INVENTORY = \[\n[\s\S]*?\n\];/, () => `const INVENTORY = [\n${unitLines}\n];`)
  // The concession text carries a signing deadline now; the short label must still parse it.
  appOut = appOut.replace(/\(\\d\+\)-month lease\$\/i\);/, '(\\d+)-month lease/i);')

  // ---- floorplans.html: plan index, per-plan price, availability heading and rows
  let fp = fpHtml
  const indexRows = plans.map((p) => {
    const mine = byPlan.get(p.id)
    const pending = mine.filter((u) => u.status === 'pending').length
    const sub = mine.length && mine.every((u) => !concessionTerms(u.concession)) ? 'gross' : 'net effective'
    const lines = p.lines.length === 1 ? `Line ${p.lines[0]}` : `Lines ${p.lines.join(', ')}`
    return `<tr><td data-label="Plan"><span class="u-res"><a href="#plan-${p.id.toLowerCase()}">${esc(p.id)}</a></span><span class="u-floor">${esc(p.name)}</span></td>` +
      `<td data-label="Beds / baths">${bedsBaths(p.bedrooms, p.bathrooms)}</td>` +
      `<td data-label="Square feet" class="num">${num(p.sqftMin)} &ndash; ${num(p.sqftMax)}</td>` +
      `<td data-label="Stack">${esc(lines)}<span class="u-view">Floors ${esc(p.floorRange)}</span></td>` +
      `<td data-label="From" class="num"><span class="u-rent">${money(p.startingRent)}</span><span class="u-sub">${sub}</span></td>` +
      `<td data-label="Residences" class="num">${mine.length ? `<b>${mine.length}</b>` : '&mdash;'}${pending ? `<span class="u-sub">${pending} under application</span>` : ''}</td></tr>`
  }).join('')
  fp = fp.replace(/(<table class="avail-table fp-index">[\s\S]*?<tbody>)[\s\S]*?(<\/tbody>)/, (_, a, b) => `${a}${indexRows}${b}`)

  for (const p of plans) {
    const mine = byPlan.get(p.id).slice().sort((a, b) => a.monthlyRent - b.monthlyRent)
    const pending = mine.filter((u) => u.status === 'pending').length
    const start = fp.indexOf(`<article class="fp" id="plan-${p.id.toLowerCase()}"`)
    const end = fp.indexOf('</article>', start)
    if (start < 0 || end < 0) throw new Error(`floorplans.html: article for ${p.id} not found`)
    let art = fp.slice(start, end)
    art = art.replace(/(<p class="plan-panel__price"><b>)[^<]*(<\/b>)/, (_, a, b) => `${a}${money(p.startingRent)}${b}`)
    const heading = `${mine.length} residence${mine.length === 1 ? '' : 's'}${pending ? ` &middot; ${pending} under application` : ''}`
    art = art.replace(/(<h3 class="sub">Availability <em>)[^<]*(<\/em><\/h3>)/, (_, a, b) => `${a}${heading}${b}`)
    const rows = mine.map((u) => {
      const avail = availability(u.availableFrom, today)
      const tags = (p.collection ? '<span class="u-tag">West Collection</span> ' : '') +
        (u.status === 'pending' ? '<span class="u-tag u-tag--pending">Application pending</span>' : '')
      return `<tr><td data-label="Residence"><span class="u-res">${esc(u.unitId)}</span><span class="u-floor">Floor ${u.floor}, line ${esc(u.unitId.slice(-1))}</span>${tags ? `<span class="u-tags">${tags.trim()}</span>` : ''}</td>` +
        `<td data-label="Sq ft" class="num">${num(u.sqft)}</td>` +
        `<td data-label="Exposure"><span class="u-val">${esc(u.exposure)}<span class="u-view">${esc(u.view)}</span></span></td>` +
        `<td data-label="Available"><span class="u-date${avail.now ? ' u-date--now' : ''}">${avail.text}</span></td>` +
        `<td data-label="Rent" class="num"><span class="u-val"><span class="u-rent">${money(u.monthlyRent)} <small>/mo net effective</small></span>` +
        `<span class="u-gross">Gross <b>${money(leaseRent(u))}</b>/mo</span><span class="u-conc">${esc(shortConcession(u.concession))}</span></span></td>` +
        `<td><a class="u-call" href="${TEL}">Ask about ${esc(u.unitId)}</a></td></tr>`
    }).join('')
    if (mine.length) {
      art = art.replace(/(<table class="avail-table">[\s\S]*?<tbody>)[\s\S]*?(<\/tbody>)/, (_, a, b) => `${a}${rows}${b}`)
    }
    fp = fp.slice(0, start) + art + fp.slice(end)
  }
  // The plan records carry a "starting" rent as well; it is derived, never typed. The old
  // site was generated from those fields, which is how it kept the pre-recalibration rents.
  // Edited in place by regex rather than re-serialised, so the hand-formatted records keep
  // their layout and a diff shows only the numbers that changed.
  let fpJson = await readFile(join(root, 'data', 'floorplans.json'), 'utf8')
  let propJson = await readFile(join(root, 'data', 'property.json'), 'utf8')
  for (const p of plans) {
    fpJson = fpJson.replace(new RegExp(`("id":\\s*"${p.id}"[\\s\\S]*?"startingRent":\\s*)\\d+`), `$1${p.startingRent}`)
    propJson = propJson.replace(new RegExp(`("code":\\s*"${p.id}"[^}]*"startingRent":\\s*)\\d+`), `$1${p.startingRent}`)
  }

  const rents = board.map((u) => u.monthlyRent)
  const lo = money(Math.min(...rents)), hi = money(Math.max(...rents))
  const available = board.filter((u) => u.status === 'available').length
  const pendingAll = board.length - available
  fp = fp.replace(/(<span><b>)\d+(<\/b> residences available<\/span>)/, (_, a, b) => `${a}${available}${b}`)
    .replace(/(<span><b>)\d+(<\/b> under application<\/span>)/, (_, a, b) => `${a}${pendingAll}${b}`)
    .replace(/(<span><b>)\$[\d,]+ &ndash; \$[\d,]+(<\/b> net effective<\/span>)/, (_, a, b) => `${a}${lo} &ndash; ${hi}${b}`)

  const indexOut = index.replace(/\$[\d,]+ to \$[\d,]+\. Call the leasing office/, `${lo} to ${hi}. Call the leasing office`)

  return {
    'public/app.js': appOut, 'public/floorplans.html': fp, 'public/index.html': indexOut,
    'data/floorplans.json': fpJson,
    'data/property.json': propJson,
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const out = await renderSite()
  for (const [rel, text] of Object.entries(out)) await writeFile(join(root, rel), text)
  console.log(`site rebuilt from data/inventory.json: ${Object.keys(out).join(', ')}`)
}
