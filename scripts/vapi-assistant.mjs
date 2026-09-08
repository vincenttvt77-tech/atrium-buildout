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
  entryPoints: ['src/vapi/config.ts'],
  outfile: '.vercel-build/assistant.mjs',
  bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
})
const { demoAssistantConfig } = await import('../.vercel-build/assistant.mjs')

const property = JSON.parse(await readFile('data/property.json', 'utf8'))

const config = demoAssistantConfig(property, serverUrl, new Date())

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
