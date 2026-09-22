/**
 * Assembles the deployment file tree and writes it to .vercel-build/deploy-files.json.
 *
 * Static files go at the root rather than under public/, and vercel.json ships with
 * framework: null. Both matter: the target project auto-detects a framework it does not
 * have, and a stored project setting overrides deployment-time projectSettings — only a
 * vercel.json in the payload wins.
 */
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const files = []
const TEXT = /\.(html|css|js|mjs|json|svg|txt|xml|webmanifest)$/i

async function addFile(diskPath, deployPath) {
  files.push({ file: deployPath, data: await readFile(diskPath, 'utf8') })
}

async function addTree(dir, prefix = '') {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    const deployPath = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) { await addTree(full, deployPath); continue }
    if (!TEXT.test(e.name)) {
      console.warn(`  skipped (binary): ${deployPath}`)
      continue
    }
    await addFile(full, deployPath)
  }
}

await mkdir('.vercel-build', { recursive: true })

// The bundled functions. Every one of them: api/dashboard.mjs is the only way the
// operations page is reachable now that it is not a static file, so a manifest that
// listed vapi.mjs by hand would ship a dashboard route that 404s.
for (const f of (await readdir('.vercel-build/api')).filter((f) => f.endsWith('.mjs')).sort()) {
  await addFile(join('.vercel-build/api', f), `api/${f}`)
}

// The website, flattened to the deployment root.
await addTree('public')

files.push({
  file: 'vercel.json',
  data: JSON.stringify({
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    buildCommand: null,
    installCommand: null,
    outputDirectory: null,
    headers: [{
      source: '/api/(.*)',
      headers: [
        { key: 'cache-control', value: 'no-store' },
        // The dashboard and its log live under /api. Neither belongs in a search index.
        { key: 'x-robots-tag', value: 'noindex, nofollow, noarchive, nosnippet' },
        { key: 'referrer-policy', value: 'no-referrer' },
        { key: 'x-content-type-options', value: 'nosniff' },
      ],
    }],
  }, null, 2),
})

files.push({
  file: 'package.json',
  data: JSON.stringify({ name: 'atrium', private: true, type: 'module', engines: { node: '22.x' } }, null, 2),
})

await writeFile('.vercel-build/deploy-files.json', JSON.stringify(files))

const kb = (n) => `${(n / 1024).toFixed(1)} kB`
console.log(`\n${files.length} files, ${kb(files.reduce((s, f) => s + f.data.length, 0))} total`)
for (const f of files.sort((a, b) => b.data.length - a.data.length).slice(0, 15)) {
  console.log(`  ${f.file.padEnd(38)} ${kb(f.data.length)}`)
}
