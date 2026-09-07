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

const approve = process.argv.includes('--approve')
const OWNER = 'person-manager-1'
const REVIEW_BY = '2027-09-07T00:00:00.000Z'
const APPROVED_AT = '2026-09-01T00:00:00.000Z'

const read = async (f) => { try { return JSON.parse(await readFile(`data/${f}`, 'utf8')) } catch { return null } }

const property = await read('property.json')
const amenities = await read('amenities.json') ?? []
const policies = await read('policies.json') ?? {}
const existing = await read('knowledge.json') ?? []

const articles = []
let n = 0

function add(topic, question, answer, source) {
  if (!answer || String(answer).trim().length < 8) return
  // A rent figure in the knowledge base defeats the live-inventory discipline entirely.
  if (/\$\s?\d{1,2},?\d{3}\b/.test(answer) && topic !== 'parking' && topic !== 'application_requirements') return
  articles.push({
    id: `art-derived-${String(++n).padStart(3, '0')}`,
    topic,
    question,
    answer: String(answer).trim(),
    propertyScope: ['prop-demo'],
    jurisdictionScope: ['NY'],
    status: approve ? 'published' : 'in_review',
    version: 1,
    source,
    ownerId: OWNER,
    approvedBy: approve ? OWNER : null,
    approvedAt: approve ? APPROVED_AT : null,
    reviewBy: REVIEW_BY,
  })
}

// ---- amenities
for (const a of amenities) {
  const name = a.name ?? a.id
  if (a.description) {
    add('amenities', `Tell me about the ${name}`, a.description, `Amenity record: ${name}`)
  }
  if (a.hours) {
    add('hours', `What are the hours for the ${name}?`,
      `The ${name}${a.floor ? ` on ${a.floor}` : ''} is open ${a.hours}.`, `Amenity record: ${name}`)
  }
  if (a.bookable && a.bookingRules) {
    const r = a.bookingRules
    const bits = []
    if (r.maxDurationMinutes) bits.push(`up to ${r.maxDurationMinutes} minutes at a time`)
    if (r.maxAdvanceDays) bits.push(`as much as ${r.maxAdvanceDays} days ahead`)
    if (r.guestLimit) bits.push(`with up to ${r.guestLimit} guests`)
    if (r.simultaneousBookings) bits.push(`${r.simultaneousBookings} reservation${r.simultaneousBookings > 1 ? 's' : ''} at a time per residence`)
    if (bits.length) {
      add('amenities', `How do I reserve the ${name}?`,
        `You can book the ${name} ${bits.join(', ')}.${r.blackoutNote ? ` ${r.blackoutNote}` : ''}`,
        `Amenity booking rules: ${name}`)
    }
  }
}

// ---- policies
const POLICY_TOPIC = {
  pets: 'pet_policy', parking: 'parking', guests: 'building_access',
  moving: 'move_logistics', trash: 'general_property_fact', recycling: 'general_property_fact',
  wifi: 'utilities', utilities: 'utilities', packages: 'general_property_fact',
  buildingAccess: 'building_access', access: 'building_access', smoking: 'general_property_fact',
  noise: 'general_property_fact', quietHours: 'general_property_fact',
  subletting: 'general_property_fact', insurance: 'application_requirements',
  application: 'application_requirements', applicationRequirements: 'application_requirements',
  leaseTerms: 'application_requirements', renewal: 'general_property_fact',
}

const QUESTION = {
  pets: 'What is your pet policy?', parking: 'Do you have parking?',
  guests: 'What is the guest policy?', moving: 'How does move-in work?',
  trash: 'Where does the trash go?', recycling: 'How does recycling work?',
  wifi: 'Is wifi included?', utilities: 'What utilities are included?',
  packages: 'How do packages work?', buildingAccess: 'How do I get into the building?',
  access: 'How does building access work?', smoking: 'What is the smoking policy?',
  noise: 'What are the quiet hours?', quietHours: 'What are the quiet hours?',
  subletting: 'Can I sublet or use Airbnb?', insurance: 'Do I need renters insurance?',
  application: 'What do I need to apply?', applicationRequirements: 'What do I need to apply?',
  leaseTerms: 'What lease terms do you offer?', renewal: 'How does renewal work?',
}

for (const [key, value] of Object.entries(policies)) {
  const topic = POLICY_TOPIC[key]
  if (!topic || !value || typeof value !== 'object') continue
  const summary = value.residentSummary ?? value.summary
  if (summary) add(topic, QUESTION[key] ?? `Tell me about ${key}`, summary, `House Rules: ${key}`)
}

const kept = existing.filter((a) => !String(a.id).startsWith('art-derived-'))
const out = [...kept, ...articles]
await writeFile('data/knowledge.json', JSON.stringify(out, null, 2) + '\n')

console.log(`Derived ${articles.length} articles from ${amenities.length} amenities and ${Object.keys(policies).length} policy areas.`)
console.log(`Kept ${kept.length} hand-written. Total ${out.length}.`)
console.log(approve
  ? 'Stamped published/approved for the demo property.'
  : 'Marked in_review with approvedBy null — they will NOT be served until a human approves.')
