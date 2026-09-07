/**
 * Derives knowledge base articles from the property's amenity and policy records.
 *
 * This is how onboarding a real building should work: import what the property already
 * has, generate proposed articles, and put them in front of a human to approve. SOW 14.1
 * wants a non-technical operator to launch a building without a developer; hand-writing
 * forty articles per property is the opposite of that.
 *
 * Everything produced here is marked `in_review` with approvedBy null. Nothing derived by a
 * script can serve a caller — that is the point. Pass --approve to stamp them approved for
 * the demo property only.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { findRentFigure } from './rent-guard.mjs'
import { findRestrictedContent } from './restricted-guard.mjs'

const approve = process.argv.includes('--approve')
const OWNER = 'person-manager-1'
const REVIEW_BY = '2027-09-07T00:00:00.000Z'
const APPROVED_AT = '2026-09-01T00:00:00.000Z'

const read = async (f) => { try { return JSON.parse(await readFile(`data/${f}`, 'utf8')) } catch { return null } }

const property = await read('property.json')
const amenities = await read('amenities.json') ?? []
const policiesFile = await read('policies.json') ?? {}
// The policy record may be flat or wrapped in a { meta, policies } envelope.
const policies = policiesFile.policies ?? policiesFile
const existing = await read('knowledge.json') ?? []

const articles = []
const skipped = []
const held = []
let n = 0

const SYNONYMS = {
  fitness: ['gym', 'fitness', 'workout', 'exercise', 'weights', 'cardio'],
  outdoor: ['outside', 'terrace', 'deck', 'roof', 'rooftop', 'patio'],
  social: ['lounge', 'party', 'entertain', 'events'],
  work: ['coworking', 'office', 'desk', 'wifi', 'zoom', 'conference'],
  pet: ['dog', 'cat', 'pet', 'puppy'],
  parking: ['car', 'garage', 'parking', 'vehicle', 'ev'],
  service: ['package', 'delivery', 'storage', 'laundry'],
  pets: ['pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'pet fee', 'pet deposit', 'pet rent', 'breed', 'breeds', 'weight limit', 'how many pets'],
}

function add(topic, question, answer, source, keywords, hold) {
  if (!answer || String(answer).trim().length < 8) return
  /*
   * A policy summary can carry restricted subject matter in its body while sitting under a
   * perfectly ordinary topic. Deriving it would put an answerable article in front of a
   * question that must reach a human, so these are dropped rather than held: an in_review
   * article still influences retrieval confidence, so holding is not the same as removing.
   */
  const restricted = findRestrictedContent(answer, topic)
  if (restricted) {
    skipped.push(`${topic} / "${question}" — states ${restricted.why}; must escalate`)
    return
  }

  const rent = findRentFigure(answer)
  if (rent) {
    skipped.push(`${topic} / "${question}" — $${rent.amount.toLocaleString()} in rent context`)
    return
  }

  // `hold` outranks --approve. A held article is still written out, because a human needs
  // to see the text to redact it, but it can never carry an approval.
  const publish = approve && !hold
  if (hold) held.push(`${topic} / "${question}" — ${hold.reason}`)

  articles.push({
    id: `art-derived-${String(++n).padStart(3, '0')}`,
    topic,
    question,
    answer: String(answer).trim(),
    propertyScope: ['prop-demo'],
    jurisdictionScope: ['NY'],
    status: publish ? 'published' : 'in_review',
    version: 1,
    source,
    ownerId: OWNER,
    ...(keywords && keywords.length ? { keywords: [...new Set(keywords)] } : {}),
    approvedBy: publish ? OWNER : null,
    approvedAt: publish ? APPROVED_AT : null,
    reviewBy: REVIEW_BY,
    ...(hold ? { reviewNote: hold.note } : {}),
  })
}

// ---- amenities
for (const a of amenities) {
  const name = a.name ?? a.id
  // The amenity is already called "The Works"; templating "the {name}" yields "the The Works".
  const bare = String(name).replace(/^the\s+/i, '')
  // The amenity's own description names the things callers ask for — "pool", "sauna",
  // "screening room" — which the category synonyms alone will never cover.
  const FEATURE_WORDS = /\b(pool|sauna|plunge|gym|yoga|pilates|grill|firepit|fire pit|screening|theater|theatre|playroom|dog run|bike|bicycle|golf|simulator|sim|conference|phone booth|kitchen|dining|terrace|deck|lounge|library|parking|garage|ev|charger|charging|locker|storage|laundry|spa|turf|basketball|putting)\b/gi
  const fromDescription = [...String(a.description ?? '').matchAll(FEATURE_WORDS)].map((m) => m[0].toLowerCase())
  const kw = [bare, ...(SYNONYMS[a.category] ?? []), a.category, ...fromDescription].filter(Boolean)
  if (a.description) {
    // "what floor is the gym on" — the floor is in every description, so the words a caller
    // uses to ask for it are keywords on every amenity and weigh nothing between them.
    add('amenities', `Tell me about ${name}`, a.description, `Amenity record: ${name}`,
      [...kw, 'amenities', 'amenity', 'floor', 'where', 'located', 'location'])
  }
  if (a.hours) {
    add('hours', `What are the hours for ${name}?`,
      `${name}${a.floor ? ` on ${a.floor}` : ''} is open ${a.hours}.`, `Amenity record: ${name}`,
      [...kw, 'hours', 'open', 'close', 'closes', 'late', 'early', 'time'])
  }
  if (a.bookable && a.bookingRules) {
    const r = a.bookingRules
    const bits = []
    if (r.maxDurationMinutes) bits.push(`up to ${r.maxDurationMinutes} minutes at a time`)
    if (r.maxAdvanceDays) bits.push(`as much as ${r.maxAdvanceDays} days ahead`)
    if (r.guestLimit) bits.push(`with up to ${r.guestLimit} guests`)
    if (r.simultaneousBookings) bits.push(`${r.simultaneousBookings} reservation${r.simultaneousBookings > 1 ? 's' : ''} at a time per residence`)
    if (bits.length) {
      add('amenities', `How do I reserve ${name}?`,
        `You can book the ${name} ${bits.join(', ')}.${r.blackoutNote ? ` ${r.blackoutNote}` : ''}`,
        `Amenity booking rules: ${name}`, kw)
    }
  }
}

// ---- policies
const POLICY_TOPIC = {
  pets: 'pet_policy', parking: 'parking', guests: 'building_access',
  moving: 'move_logistics', trash: 'general_property_fact', recycling: 'general_property_fact',
  trashAndRecycling: 'general_property_fact',
  wifi: 'utilities', utilities: 'utilities', wifiAndUtilities: 'utilities',
  packages: 'general_property_fact',
  buildingAccess: 'building_access', access: 'building_access', smoking: 'general_property_fact',
  noise: 'general_property_fact', quietHours: 'general_property_fact',
  noiseAndQuietHours: 'general_property_fact',
  subletting: 'general_property_fact', sublettingAndShortTermRentals: 'general_property_fact',
  insurance: 'application_requirements',
  application: 'application_requirements', applicationRequirements: 'application_requirements',
  leaseTerms: 'application_requirements', renewal: 'general_property_fact',
  storage: 'general_property_fact', feeSchedule: 'application_requirements',
}

const QUESTION = {
  pets: 'What is your pet policy?', parking: 'Do you have parking?',
  guests: 'What is the guest policy?', moving: 'How does move-in work?',
  trash: 'Where does the trash go?', recycling: 'How does recycling work?',
  trashAndRecycling: 'How does trash and recycling work?',
  wifi: 'Is wifi included?', utilities: 'What utilities are included?',
  wifiAndUtilities: 'What utilities are included in the rent?',
  noiseAndQuietHours: 'What are the quiet hours?',
  sublettingAndShortTermRentals: 'Can I sublet or list on Airbnb?',
  storage: 'Is there storage available?', feeSchedule: 'What fees should I expect?',
  packages: 'How do packages work?', buildingAccess: 'How do I get into the building?',
  access: 'How does building access work?', smoking: 'What is the smoking policy?',
  noise: 'What are the quiet hours?', quietHours: 'What are the quiet hours?',
  subletting: 'Can I sublet or use Airbnb?', insurance: 'Do I need renters insurance?',
  application: 'What do I need to apply?', applicationRequirements: 'What do I need to apply?',
  leaseTerms: 'What lease terms do you offer?', renewal: 'How does renewal work?',
}

/*
 * A policy block that carries `escalationTopic` can never emit a published article.
 *
 * The flag says the block mixes ordinary policy facts with content the agent must never
 * state on its own: an accommodation ruling, an eligibility test, a legal characterisation.
 * Flattening the block's residentSummary into an article dropped the flag silently, and
 * because the article is then filed under a PolicyTopic, decideAnswer() never sees a
 * restricted topic to escalate. That is how "housing vouchers are accepted" and "service
 * animals pay no fee and the breed limits do not apply" became published, approved answers
 * with escalation bypassed.
 *
 * A script cannot tell which half of a summary is safe, so it does not try. The article is
 * still written out — a human needs the text in front of them to redact it — but it goes out
 * in_review with approvedBy null, and --approve does not override that.
 */
for (const [key, value] of Object.entries(policies)) {
  const topic = POLICY_TOPIC[key]
  if (!topic || !value || typeof value !== 'object') continue
  const summary = value.residentSummary ?? value.summary
  if (!summary) continue

  /*
   * pet_policy is the one block that must mention the escalation subject to be complete —
   * a breed list stated without the service-animal exemption is the Fair Housing exposure.
   * findRestrictedContent() knows the routing-language exception for that topic, so a pets
   * summary that passes it carries no ruling and is publishable. Every other block with the
   * flag is held.
   */
  const routingOnly = topic === 'pet_policy' && !findRestrictedContent(summary, topic)
  const hold = value.escalationTopic && !routingOnly
    ? {
        reason: `policies.json "${key}" carries escalationTopic "${value.escalationTopic}"`,
        note: `Held out of the published set by derive-knowledge.mjs. The source block ` +
          `policies.json "${key}" declares escalationTopic "${value.escalationTopic}"` +
          (value.escalationNote ? `: ${value.escalationNote}` : '.') +
          ` A derived summary cannot carry that flag, so this article is never auto-approved. ` +
          `Redact every sentence covering the escalation subject before publishing, and leave ` +
          `those subjects with no article at all so decideAnswer() falls through to escalate. ` +
          `To publish the redacted remainder, set status to published, approvedBy to ${OWNER}, ` +
          `and approvedAt to a timestamp.`,
      }
    : null

  add(topic, QUESTION[key] ?? `Tell me about ${key}`, summary, `House Rules: ${key}`,
    SYNONYMS[key] ?? [key.replace(/([A-Z])/g, ' $1').toLowerCase()], hold)
}

// ---- floor plans, by name and as an overview. Never a rent — that is check_availability's.
const plans = await read('floorplans.json') ?? []
for (const fp of plans) {
  const beds = fp.bedrooms === 0 ? 'a studio' : `${fp.bedrooms} bedroom${fp.bedrooms > 1 ? 's' : ''}`
  const feats = (fp.features ?? []).slice(0, 4).join(', ')
  add('general_property_fact', `Tell me about the ${fp.name ?? fp.id} floor plan`,
    `The ${fp.name ?? fp.id} is ${beds}, ${fp.bathrooms} bath${fp.bathrooms !== 1 ? 's' : ''}, about ${fp.sqft} square feet.${fp.description ? ' ' + String(fp.description).trim() : ''}${feats ? ' It comes with ' + feats + '.' : ''} Want me to check which ${fp.name ?? fp.id} residences are open right now?`,
    `Floor plan record: ${fp.id}`,
    [String(fp.id).toLowerCase(), fp.name ?? '', 'floor plan', 'layout', 'plan', beds, `${fp.bedrooms} bed`, `${fp.sqft} sq ft`])
}
if (plans.length) {
  const byBeds = {}
  for (const fp of plans) (byBeds[fp.bedrooms] ??= []).push(fp)
  const line = Object.keys(byBeds).sort().map((b) => {
    const list = byBeds[b].map((fp) => fp.name ?? fp.id).join(', ')
    const label = b === '0' ? 'studios' : `${b}-bedrooms`
    return `${label}: ${list}`
  }).join('; ')
  add('general_property_fact', 'What floor plans do you have?',
    `We have ${plans.length} plans. ${line}. Tell me how many bedrooms you're after and I'll pull up what's open in that size.`,
    'Floor plan catalogue', ['floor plans', 'layouts', 'plans', 'what layouts', 'unit types', 'floorplan'])
}

// ---- what is inside a residence: finishes and appliances, from the property record.
const wc = (property?.residenceFinishes?.westCollection ?? []).join(' ')
const standard = property?.residenceFinishes?.standard ?? []
if (standard.length) {
  add('general_property_fact', 'What finishes and appliances come in the residences?',
    `Every residence has ${standard.map((f) => String(f).replace(/\.$/, '')).map((f) => f.charAt(0).toLowerCase() + f.slice(1)).join('; ')}.${wc ? ' The West Collection on floors 28 through 33 steps up from there — taller ceilings, a quartzite island, and Fisher & Paykel refrigeration.' : ''}`,
    'Property record: residenceFinishes.standard',
    ['finishes', 'appliances', 'kitchen', 'washer', 'dryer', 'laundry in unit', 'in-unit laundry', 'windows',
     'floor to ceiling', 'ceilings', 'ceiling height', 'flooring', 'floors', 'hardwood', 'oak', 'bosch', 'countertops',
     'closets', 'dishwasher', 'stove', 'gas', 'air conditioning', 'heating', 'cooling', 'bathroom', 'shades'])
}

// ---- size and comparison by bedroom count: "how big is a one bedroom", "B1 versus B2".
{
  const byBeds = {}
  for (const fp of plans) (byBeds[fp.bedrooms] ??= []).push(fp)
  for (const [b, list] of Object.entries(byBeds)) {
    const n = Number(b)
    const label = n === 0 ? 'studio' : n === 1 ? 'one bedroom' : n === 2 ? 'two bedroom' : n === 3 ? 'three bedroom' : `${n} bedroom`
    const sizes = list.map((fp) => fp.sqft).filter(Number.isFinite)
    const range = sizes.length ? `${Math.min(...sizes)} to ${Math.max(...sizes)} square feet` : ''
    const each = list.map((fp) => {
      const first = (fp.features ?? []).find((f) => !/oak|bosch|washer|ceilings 9/i.test(f))
      return `the ${fp.name} (${fp.id}) at about ${fp.sqft} square feet${first ? ` — ${String(first).charAt(0).toLowerCase() + String(first).slice(1)}` : ''}`
    })
    add('general_property_fact', `How big are the ${label}s and how do they compare?`,
      `${label.charAt(0).toUpperCase() + label.slice(1)}s run ${range}. There ${list.length === 1 ? 'is one layout' : `are ${list.length} layouts`}: ${each.join('; ')}. Want me to check what's open in one of them?`,
      'Floor plan catalogue',
      [label, `${label}s`, `${n} bedroom`, `${n} bed`, `${n}br`, 'how big', 'size', 'square feet', 'sqft', 'square footage',
       'difference', 'compare', 'versus', 'vs', 'bigger', 'larger', 'smaller', 'layouts',
       ...list.map((fp) => String(fp.id).toLowerCase())])
  }
}

// ---- terraces and balconies, from the property record's finish tiers.
const terrace = /terrace/i.test(wc)
const balconyPlans = plans.filter((fp) => /balcon/i.test([fp.name, ...(fp.features ?? [])].join(' ')))
const balconyLine = balconyPlans.map((fp) => {
  const size = (fp.features ?? []).map((f) => /balcony,?\s*([\d]+ to [\d]+ square feet)/i.exec(f)?.[1]).find(Boolean)
  return `the ${fp.name} (${fp.id})${size ? `, ${size}` : ''}`
}).join(' and ')
const parts = []
if (balconyPlans.length) parts.push(`Yes — ${balconyLine} have a private balcony off the living room with a full-height slider.`)
if (terrace) parts.push('The West Collection on floors 28 through 33 has private terraces of 90 to 240 square feet on the D and A lines.')
parts.push(balconyPlans.length || terrace
  ? 'The other layouts don\'t have private outdoor space, but The Terrace on four and the sky terrace on thirty-four are open to everyone. Want me to check what\'s open in one of the balcony layouts?'
  : 'The residences don\'t have private balconies, but the building has shared outdoor space on the amenity floors.')
add('general_property_fact', 'Do the residences have balconies or terraces?', parts.join(' '),
  'Floor plan catalogue and property record: residenceFinishes.westCollection',
  ['balcony', 'balconies', 'terrace', 'terraces', 'patio', 'outdoor space', 'private outdoor', 'west collection',
   ...balconyPlans.map((fp) => String(fp.id).toLowerCase())])

// ---- the current promotion, from what the inventory actually carries. Stated as a
// programme with a deadline, never as a rent, and pointing at the live check for specifics.
const inv = await read('inventory.json') ?? []
const concessions = [...new Set(inv.map((u) => u.concession).filter(Boolean))]
if (concessions.length) {
  const deadline = (concessions[0].match(/signed by ([A-Za-z]+ \d{1,2}, \d{4})/) ?? [])[1]
  const twoMonths = concessions.some((c) => /two months/i.test(c))
  add('application_requirements', 'Do you have any specials or concessions right now?',
    `Yes. Right now most residences come with one month free on a 14-month lease${twoMonths ? ', and a few carry two months free' : ''}${deadline ? ', as long as you sign by ' + deadline : ''}. There\'s no broker fee either — we lease in-house. It\'s set per residence, so when we look at what\'s open I\'ll tell you exactly what each one carries.`,
    'Inventory concession terms',
    ['concession', 'special', 'promotion', 'promo', 'deal', 'month free', 'free month', 'offer', 'expire', 'expires', 'deadline', 'broker fee', 'no fee', 'incentive'])
}

const kept = existing.filter((a) => !String(a.id).startsWith('art-derived-'))
const out = [...kept, ...articles]
await writeFile('data/knowledge.json', JSON.stringify(out, null, 2) + '\n')

console.log(`Derived ${articles.length} articles from ${amenities.length} amenities and ${Object.keys(policies).length} policy areas.`)
console.log(`Kept ${kept.length} hand-written. Total ${out.length}.`)
if (skipped.length) {
  console.log(`\nSkipped ${skipped.length} — rent-shaped figures must come from live inventory:`)
  for (const s of skipped) console.log(`  ${s}`)
}
if (held.length) {
  console.log(`\nHeld ${held.length} in_review regardless of --approve — the source block escalates:`)
  for (const h of held) console.log(`  ${h}`)
}
console.log(approve
  ? 'Stamped published/approved for the demo property.'
  : 'Marked in_review with approvedBy null — they will NOT be served until a human approves.')
