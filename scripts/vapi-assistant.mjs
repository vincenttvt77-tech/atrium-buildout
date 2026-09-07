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
  // Only the two transit facts a caller asks about unprompted. The rest is in the
  // knowledge base, where it costs nothing until someone actually asks.
  for (const t of (p.neighborhood?.transit ?? []).slice(0, 2)) f.push(`Transit: ${t}`)
  return f
}

const config = assistantConfig({
  buildingName: property.buildingName,
  address: property.address,
  neighborhood: neighborhoodText(property.neighborhood),
  leasingHours: property.leasingHours,
  managementCompany: property.managementCompany ?? 'the management office',
  facts: buildingFacts(property),
  today: new Date(),
  serverUrl: `${serverUrl.replace(/\/$/, '')}/api/vapi`,
  firstMessage: `Thanks for calling ${property.buildingName}. I'm an AI assistant for the building and this call is recorded — how can I help?`,
})

await writeFile('vapi-assistant.json', JSON.stringify(config, null, 2))

/*
 * A second file with the tools removed.
 *
 * Vapi's tool schema is the part most likely to be rejected, and its validator reports the
 * failure without naming which tool. Importing this one first proves the rest of the
 * assistant is well formed and isolates the problem to the tools block — and it leaves a
 * working assistant to attach tools to by hand in the meantime.
 */
const { tools, ...modelWithoutTools } = config.model
await writeFile(
  'vapi-assistant-no-tools.json',
  JSON.stringify({ ...config, model: modelWithoutTools }, null, 2),
)
console.log(JSON.stringify(config, null, 2))
console.error(`\n→ vapi-assistant.json (full)`)
console.error(`→ vapi-assistant-no-tools.json (fallback — import this if the full one is rejected)`)
console.error(`→ Server URL: ${config.server.url}`)
