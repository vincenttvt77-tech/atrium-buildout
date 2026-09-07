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

const config = assistantConfig({
  buildingName: property.buildingName,
  address: property.address,
  neighborhood: property.neighborhood,
  leasingHours: property.leasingHours,
  managementCompany: property.managementCompany ?? 'the management office',
  serverUrl: `${serverUrl.replace(/\/$/, '')}/api/vapi`,
  firstMessage: `Thanks for calling ${property.buildingName}. I'm an AI assistant for the building and this call is recorded — how can I help?`,
})

await writeFile('vapi-assistant.json', JSON.stringify(config, null, 2))
console.log(JSON.stringify(config, null, 2))
console.error(`\n→ Written to vapi-assistant.json`)
console.error(`→ Server URL: ${config.server.url}`)
