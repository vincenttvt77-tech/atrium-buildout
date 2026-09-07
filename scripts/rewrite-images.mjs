/**
 * Points the site's image references at the generated assets.
 *
 * The images live on the generator's CDN because this build environment's egress policy
 * blocks that host, so they could not be pulled into the repo. A visitor's browser reaches
 * them fine. For anything past a demo they should be downloaded and served from the site's
 * own origin — a third-party CDN URL is not a dependency you want under a client's
 * building, and it can disappear without warning.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const { images } = JSON.parse(await readFile('data/images.json', 'utf8'))

async function* htmlFiles(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* htmlFiles(full)
    else if (/\.(html|css|js)$/i.test(e.name)) yield full
  }
}

let rewritten = 0
const unresolved = new Set()

for await (const file of htmlFiles('public')) {
  const before = await readFile(file, 'utf8')

  const after = before.replace(
    /(["'(])\/?images\/([a-z0-9-]+)\.(?:jpg|jpeg|png|webp)(["')])/gi,
    (whole, open, slug, close) => {
      const url = images[slug]
      if (!url) { unresolved.add(slug); return whole }
      rewritten++
      return `${open}${url}${close}`
    },
  )

  if (after !== before) {
    await writeFile(file, after)
    console.log(`  ${file}`)
  }
}

console.log(`\nRewrote ${rewritten} image references.`)
if (unresolved.size > 0) {
  console.log(`No image for: ${[...unresolved].join(', ')}`)
  console.log(`Available: ${Object.keys(images).join(', ')}`)
}
