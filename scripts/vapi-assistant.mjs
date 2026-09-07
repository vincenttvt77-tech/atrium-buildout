/**
 * Prints the Vapi assistant configuration to paste into the dashboard.
 *
 * Usage: node scripts/vapi-assistant.mjs https://your-deployment.vercel.app
 */
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { writeFile, mkdir } from 'node:fs/promises'

const serverUrl = process.argv[2]
if (!serverUrl) {
  console.error('Usage: node scripts/vapi-assistant.mjs <deployment-url>')
  process.exit(1)
}

// Bundle the config module so this script needs no TS runtime assumptions.
await mkdir('.vercel-build', { recursive: true })
await build({
  entryPoints: ['src/vapi/assistant.ts'],
  outfile: '.vercel-build/assistant.mjs',
  bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
})
const { assistantConfig } = await import('../.vercel-build/assistant.mjs')

const property = JSON.parse(await readFile('data/property.json', 'utf8'))

/** The property record nests transit and nearby places; the prompt wants prose. */
function neighborhoodText(n) {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return 'the neighborhood'
  return [...(n.transit ?? []), ...(n.nearby ?? [])].join('. ')
}

function buildingFacts(p) {
  const f = []
  if (p.buildingFacts?.height) f.push(`${p.floors} floors, ${p.buildingFacts.height} tall, completed ${p.yearBuilt}.`)
  if (p.totalUnits) f.push(`${p.totalUnits} residences.`)
  if (p.buildingFacts?.residenceNumbering) f.push(p.buildingFacts.residenceNumbering)
  if (p.leasingOffice) f.push(p.leasingOffice)
  if (p.team?.leasing) f.push(p.team.leasing)
  for (const t of (p.neighborhood?.transit ?? []).slice(0, 4)) f.push(`Transit: ${t}`)
  for (const n of (p.neighborhood?.nearby ?? []).slice(0, 4)) f.push(`Nearby: ${n}`)
  if (p.buildingFacts?.affordableNote) f.push(p.buildingFacts.affordableNote)
  return f
}

const config = assistantConfig({
  buildingName: property.buildingName,
  address: property.address,
  neighborhood: neighborhoodText(property.neighborhood),
  leasingHours: property.leasingHours,
  managementCompany: property.managementCompany ?? 'the management office',
  facts: buildingFacts(property),
  serverUrl: `${serverUrl.replace(/\/$/, '')}/api/vapi`,
  firstMessage: `Thanks for calling ${property.buildingName}. I'm an AI assistant for the building and this call is recorded — how can I help?`,
})

await writeFile('vapi-assistant.json', JSON.stringify(config, null, 2))
console.log(JSON.stringify(config, null, 2))
console.error(`\n→ Written to vapi-assistant.json`)
console.error(`→ Server URL: ${config.server.url}`)
