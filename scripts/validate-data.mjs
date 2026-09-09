/**
 * Checks the property data against the contracts the agent enforces at runtime.
 *
 * The point is to catch a knowledge article that quotes a rent, or one filed under a
 * restricted topic, BEFORE it reaches a caller. A stale rent in the knowledge base defeats
 * the entire live-inventory discipline, and it is invisible until someone is quoted it.
 */
import { readFile } from 'node:fs/promises'
import { findRentFigure } from './rent-guard.mjs'
import { findRestrictedContent } from './restricted-guard.mjs'

const VOLATILE = new Set(['unit_availability', 'pricing', 'tour_slot_availability',
  'application_status', 'account_status', 'work_order_status'])
const RESTRICTED = new Set(['fair_housing', 'reasonable_accommodation', 'eligibility_or_denial',
  'legal_question', 'dispute', 'money_movement', 'protected_class_inquiry'])
const POLICY = new Set(['pet_policy', 'parking', 'amenities', 'hours', 'utilities',
  'application_requirements', 'building_access', 'move_logistics', 'general_property_fact'])

const PHONE = '+1 (516) 990-9252'
const NOW = new Date()

const problems = []
const fail = (where, msg) => problems.push({ severity: 'error', where, msg })
const warn = (where, msg) => problems.push({ severity: 'warn', where, msg })

const read = async (f) => { try { return JSON.parse(await readFile(`data/${f}`, 'utf8')) } catch { return null } }

const property = await read('property.json')
const plans = await read('floorplans.json')
const units = await read('inventory.json')
const articles = await read('knowledge.json')

if (!property) fail('property.json', 'missing')
else if (property.leasingPhone !== PHONE) fail('property.json', `leasingPhone is "${property.leasingPhone}", must be "${PHONE}"`)

// ---- the residential stack has to close
// A residence count that does not add up is invisible on the page and fatal on the phone:
// the agent quotes a building that cannot exist. Recompute it from the tiers every build
// instead of trusting the headline number.
const stack = property?.buildingFacts?.stack
if (property && !stack?.tiers?.length) {
  fail('property.json', 'buildingFacts.stack.tiers is missing — the residence count cannot be checked')
} else if (property) {
  let counted = 0
  for (const t of stack.tiers) {
    const w = `property.json stack "${t.name}"`
    if (!(t.floorCount > 0) || !(t.residencesPerFloor > 0)) {
      fail(w, 'floorCount and residencesPerFloor must both be positive')
      continue
    }
    const product = t.floorCount * t.residencesPerFloor
    if (t.residences !== product)
      fail(w, `${t.floorCount} floors x ${t.residencesPerFloor} a floor = ${product}, but residences says ${t.residences}`)
    counted += product
  }
  if (counted !== property.totalUnits)
    fail('property.json', `the stack holds ${counted} residences but totalUnits is ${property.totalUnits}`)

  const tower = stack.tiers.find((t) => t.name === 'Tower')
  if (tower && property.buildingFacts?.residencesPerTypicalFloor !== tower.residencesPerFloor)
    fail('property.json', `residencesPerTypicalFloor is ${property.buildingFacts?.residencesPerTypicalFloor}, the Tower tier is ${tower.residencesPerFloor}`)

  // The prose count and the tier count are the same number written twice.
  const west = stack.tiers.find((t) => t.name === 'West Collection')
  const prose = /(\d+) residences/.exec((property.residenceFinishes?.westCollection ?? []).join(' '))
  if (west && prose && Number(prose[1]) !== west.residences)
    fail('property.json', `residenceFinishes.westCollection says ${prose[1]} residences, the stack says ${west.residences}`)

  // And the plan set is the other half of the same arithmetic: lines x floors on 28-33.
  const wcPlans = (plans ?? []).filter((p) => p.collection)
  const ranges = new Set(wcPlans.map((p) => p.floorRange))
  if (west && wcPlans.length > 0 && ranges.size === 1) {
    const [lo, hi] = [...ranges][0].split('-').map(Number)
    const lines = new Set(wcPlans.flatMap((p) => p.lines ?? []))
    const fromPlans = lines.size * (hi - lo + 1)
    if (Number.isFinite(fromPlans) && fromPlans !== west.residences)
      fail('floorplans.json', `${lines.size} ${west.name} lines x ${hi - lo + 1} floors = ${fromPlans}, but property.json says ${west.residences}`)
  } else if (west && ranges.size > 1) {
    warn('floorplans.json', `${west.name} plans span ${ranges.size} floor ranges — the line count cannot be checked`)
  }

  // Market plus affordable is 318 counted a second way, and the set-aside has to be one a
  // 421-a option actually grants: 22.6% at 130% AMI would never have earned the exemption.
  const f = property.buildingFacts ?? {}
  if (f.marketRateResidences + f.affordableResidences !== property.totalUnits)
    fail('property.json', `marketRate ${f.marketRateResidences} + affordable ${f.affordableResidences} != totalUnits ${property.totalUnits}`)
  const share = f.affordableResidences / property.totalUnits
  if (/130%\s*AMI/i.test(`${f.affordableSetAside ?? ''} ${f.affordableNote ?? ''}`) && share < 0.3)
    fail('property.json', `set-aside is ${(share * 100).toFixed(1)}% at 130% AMI — the 130% band is 421-a Option C, which is 30%`)
}

// Availability and rent belong to the live feed. A snapshot in the property record gets
// bundled into the serverless function and goes stale where nobody can see it.
if (property?.availabilitySample)
  fail('property.json', 'availabilitySample is back — availability and rent come from inventory.json through loadInventory() only')

// ---- floor plans and units must agree
const planById = new Map((plans ?? []).map((p) => [p.id, p]))
if (!plans?.length) fail('floorplans.json', 'no floor plans')
if (!units?.length) fail('inventory.json', 'no units')

for (const u of units ?? []) {
  const w = `inventory.json ${u.unitId}`
  const p = planById.get(u.floorPlanId)
  if (!p) { fail(w, `floorPlanId "${u.floorPlanId}" does not exist`); continue }
  if (u.bedrooms !== undefined && u.bedrooms !== p.bedrooms)
    fail(w, `bedrooms ${u.bedrooms} != plan ${p.id} (${p.bedrooms})`)
  if (u.bathrooms !== undefined && u.bathrooms !== p.bathrooms)
    fail(w, `bathrooms ${u.bathrooms} != plan ${p.id} (${p.bathrooms})`)
  if (!(u.monthlyRent > 0)) fail(w, 'monthlyRent must be positive')
  if (Number.isNaN(Date.parse(u.availableFrom ?? ''))) fail(w, `availableFrom "${u.availableFrom}" unparseable`)
  if (property?.floors && u.floor > property.floors)
    fail(w, `floor ${u.floor} above the building's ${property.floors}`)
}

const available = (units ?? []).filter((u) => u.status === 'available')
if (available.length === 0) fail('inventory.json', 'nothing is available — the agent can never quote')

/*
 * Every other place a rent appears is derived from inventory.json by `npm run build:site`:
 * the "starting" rent on each plan record, and the inventory the public site inlines. The
 * phone quoted the recalibrated rents while the website showed the old ones for three
 * hours, because those copies were typed once and never regenerated. They are checked here
 * so the mismatch cannot ship again.
 */
const onBoard = (units ?? []).filter((u) => u.status === 'available' || u.status === 'pending')
const startingFor = (id) => {
  const mine = onBoard.filter((u) => u.floorPlanId === id).map((u) => u.monthlyRent)
  return mine.length ? Math.min(...mine) : null
}
for (const p of plans ?? []) {
  const want = startingFor(p.id)
  if (want !== null && p.startingRent !== want)
    fail(`floorplans.json ${p.id}`, `startingRent ${p.startingRent} but the lowest on the board is ${want} — run npm run build:site`)
}
for (const t of property?.floorPlanTypes ?? []) {
  const want = startingFor(t.code)
  if (want !== null && t.startingRent !== want)
    fail(`property.json floorPlanTypes ${t.code}`, `startingRent ${t.startingRent} but the lowest on the board is ${want} — run npm run build:site`)
}
try {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  const block = /const INVENTORY = \[\n([\s\S]*?)\n\];/.exec(app)
  const site = new Map((block ? block[1].split('\n') : []).map((l) => JSON.parse(l.trim().replace(/,$/, ''))).map((u) => [u.unitId, u]))
  for (const u of units ?? []) {
    const s = site.get(u.unitId)
    if (!s) fail(`public/app.js ${u.unitId}`, 'missing from the site — run npm run build:site')
    else if (s.monthlyRent !== u.monthlyRent || s.availableFrom !== u.availableFrom || s.status !== u.status || (s.concession ?? null) !== (u.concession ?? null))
      fail(`public/app.js ${u.unitId}`, `differs from inventory.json (rent ${s.monthlyRent} vs ${u.monthlyRent}) — run npm run build:site`)
  }
} catch (err) {
  warn('public/app.js', `could not check the inlined inventory: ${err.message}`)
}

// ---- knowledge base
const seen = new Set()

for (const a of articles ?? []) {
  const w = `knowledge.json ${a.id ?? '(no id)'}`
  if (seen.has(a.id)) fail(w, 'duplicate article id')
  seen.add(a.id)

  if (VOLATILE.has(a.topic)) fail(w, `topic "${a.topic}" is volatile — must come from live inventory, never the KB`)
  else if (RESTRICTED.has(a.topic)) fail(w, `topic "${a.topic}" is restricted — must escalate, never be answered`)
  else if (!POLICY.has(a.topic)) fail(w, `topic "${a.topic}" is not a valid PolicyTopic`)

  // in_review and draft are legitimate states — the article simply will not be served.
  // Published-with-no-approver is the dangerous one: it claims approval it does not have.
  if (a.status !== 'published') warn(w, `status "${a.status}" — will not be served`)
  else if (!a.approvedBy) fail(w, 'published but approvedBy is null — an AI answer cannot become approved policy')
  if (Number.isNaN(Date.parse(a.reviewBy ?? ''))) fail(w, 'reviewBy unparseable')
  else if (new Date(a.reviewBy) <= NOW) fail(w, `reviewBy ${a.reviewBy} is past — will not be served`)
  if (!a.source) warn(w, 'no source cited')

  const rent = findRentFigure(a.answer)
  if (rent) fail(w, `answer freezes a rent: ${rent.matched} — "${rent.context.slice(0, 70)}…". Rents come from live inventory only.`)

  const q = (a.question ?? '').toLowerCase()
  for (const [pat, why] of [
    [/section 8|voucher|cityfheps|housing choice/, 'housing vouchers'],
    [/emotional support|service animal|accommodat/, 'reasonable accommodation'],
    [/\bdenied\b|\bdenial\b|credit score requirement/, 'eligibility or denial'],
  ]) if (pat.test(q)) fail(w, `question concerns ${why} — must escalate, not be answered by an article`)

  /*
   * The same subjects, checked in the ANSWER.
   *
   * Checking only the question is what let this through: an article titled "What do I need
   * to apply?" is filed under a PolicyTopic and looks harmless, and its body answered source
   * of income, criminal history, and housing court history anyway. tools.ts hands
   * decideAnswer() every article filed under the classified topic, so a caller asking "do you
   * take Section 8?" that classifies as application_requirements is answered from the KB with
   * escalation bypassed entirely — and those terms are near-hapax in the corpus, so IDF
   * weighting pins the article at ceiling confidence. The restricted subject has to be absent
   * from the body, not just off the title.
   *
   * Checked at every status, published or not. tools.ts runs retrieve() over every article
   * filed under the topic and only then filters to the servable ones, so an in_review or
   * retired article still sets the confidence the servable winner is judged at. Unpublishing
   * the text is not the same as removing it: leave "vouchers" in a held draft and
   * "do you take Section 8?" still scores at the ceiling, then answers from whatever
   * servable article ranked next. So a derived article held by derive-knowledge.mjs fails
   * this check until a human actually redacts it, which is the point.
   */
  const restricted = findRestrictedContent(a.answer, a.topic)
  if (restricted) fail(w, `answer states ${restricted.why} ("${restricted.matched}") — a RestrictedTopic decideAnswer() must escalate. Remove it so no article can serve the question.`)

  /*
   * A fee answer that closes the list is the most authoritative-sounding way to be wrong.
   *
   * "The garage and private storage are the only two things billed separately" was published
   * and approved over a schedule carrying roughly twenty more charges, and a caller has no
   * reason to doubt it. Scoped by money context in the sentence rather than by article topic,
   * because the offending article was filed under "amenities", not under a fee topic — and so
   * "your fob is the only key you need" is left alone.
   */
  for (const sentence of (a.answer ?? '').split(/(?<=[.!?])\s+/)) {
    const exhaustive = /\b(the only|only two things?|only thing|nothing else|that is (?:all|everything)|and that is it)\b/i
    const money = /\$\d|\bfees?\b|\bcharges?\b|\bbill(?:ed|s)?\b|\bdeposits?\b|\bper month\b|\ba month\b/i
    if (exhaustive.test(sentence) && money.test(sentence))
      fail(w, `answer closes the fee list: "${sentence.trim().slice(0, 90)}…". Point at the full fee schedule instead of claiming it is exhaustive.`)
  }
}

const servable = (articles ?? []).filter((a) => a.status === 'published' && a.approvedBy)
if (servable.length < 10) warn('knowledge.json', `only ${servable.length} servable articles — the agent will refuse a lot`)

// Two published articles answering the same question is an error, not a note.
//
// Retrieval scores them, the agent serves whichever wins, and nobody finds out which. That
// was survivable while the duplicates agreed; it stopped being survivable when
// "what utilities are included in the rent" had one article saying heat and cooling are
// electric and on your Con Edison bill and another saying they come off the building's
// central plant and are included. Both were published, both were approved, and the answer a
// caller got depended on the scoring function. One question, one published answer — retire
// the loser or merge them.
const byQuestion = new Map()
for (const a of servable) {
  const k = (a.question ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  if (!byQuestion.has(k)) byQuestion.set(k, [])
  byQuestion.get(k).push(a.id)
}
for (const [q, ids] of byQuestion) {
  if (ids.length > 1)
    fail('knowledge.json', `${ids.length} published answers to the same question "${q}": ${ids.join(', ')} — retire all but one`)
}

// ---- report
const errors = problems.filter((p) => p.severity === 'error')
const warns = problems.filter((p) => p.severity === 'warn')

console.log(`\nfloor plans ${plans?.length ?? 0} · units ${units?.length ?? 0} (${available.length} available) · articles ${articles?.length ?? 0}`)
for (const p of errors) console.log(`  ERROR  ${p.where}: ${p.msg}`)
for (const p of warns) console.log(`  warn   ${p.where}: ${p.msg}`)
console.log(errors.length === 0 ? '\nData valid.' : `\n${errors.length} errors, ${warns.length} warnings.`)
process.exit(errors.length === 0 ? 0 : 1)
