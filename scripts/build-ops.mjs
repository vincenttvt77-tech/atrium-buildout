/**
 * Composes the operations dashboard from its source files and embeds it into a module the
 * API function can import.
 *
 * The page cannot live in `public/`: everything under `public/` is served to anyone who
 * asks, and this page is the front end for prospect names, email addresses and verbatim
 * call excerpts. It is served by `api/dashboard.ts` instead, behind the session gate —
 * which means the HTML has to reach the function.
 *
 * Sources live in `ops/src/`. `index.html` is the shell; a line of the form
 * `<!-- @include name.css -->` or `<!-- @include name.js -->` is replaced with that file
 * wrapped in a <style> or <script> tag, so the calendar, leads and calls modules can be
 * edited as their own files and still ship as one self-contained page (the CSP allows no
 * external scripts). The composed page is written to `ops/dashboard.html` — the reviewable
 * artefact — and to `ops/dashboard.page.json`, the form Node, esbuild and Vercel's tracer
 * all agree on. `src/ops/test/dashboard-page.test.ts` fails if either drifts from the
 * sources.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
export const SOURCE_DIR = join(root, 'ops', 'src')
export const HTML_OUTPUT = join(root, 'ops', 'dashboard.html')
export const OUTPUT = join(root, 'ops', 'dashboard.page.json')

const INCLUDE = /^[ \t]*<!--\s*@include\s+([\w.-]+\.(css|js))\s*-->[ \t]*$/gm

/** The composed page, from the sources as they are on disk right now. */
export async function composeOpsPage() {
  const shell = await readFile(join(SOURCE_DIR, 'index.html'), 'utf8')
  const parts = [...shell.matchAll(INCLUDE)]
  let html = shell
  for (const m of parts) {
    const body = await readFile(join(SOURCE_DIR, m[1]), 'utf8')
    // A closing tag inside the included file would end the element early; there is no
    // legitimate reason for one, so it is a build error rather than a silent truncation.
    if (m[2] === 'js' && /<\/script/i.test(body)) throw new Error(`${m[1]} contains "</script"`)
    if (m[2] === 'css' && /<\/style/i.test(body)) throw new Error(`${m[1]} contains "</style"`)
    const wrapped = m[2] === 'css'
      ? `<style>\n${body.trimEnd()}\n</style>`
      : `<script>\n${body.trimEnd()}\n</script>`
    html = html.replace(m[0], wrapped)
  }
  return { html, included: parts.map((m) => m[1]) }
}

export async function buildOpsPage() {
  const { html, included } = await composeOpsPage()
  await writeFile(HTML_OUTPUT, html)
  await writeFile(OUTPUT, `${JSON.stringify({ html }, null, 2)}\n`)
  return { bytes: html.length, included }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const { bytes, included } = await buildOpsPage()
  console.log(`ops/dashboard.html + ops/dashboard.page.json — ${(bytes / 1024).toFixed(1)} kB` +
    (included.length ? ` (includes: ${included.join(', ')})` : ''))
}
