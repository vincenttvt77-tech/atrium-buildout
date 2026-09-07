import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { renderSite } from '../../../scripts/build-site.mjs'
import { leaseRent } from '../pricing.ts'
import raw from '../../../data/inventory.json' with { type: 'json' }

/**
 * The website and the phone line quote from the same file, or a caller with the site open
 * hears a different number from the one on the screen. `npm run build:site` writes the
 * pages; this fails the moment data/inventory.json changes without them.
 */
const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('the public site prints the rents the phone line quotes', () => {
  test('every generated page matches data/inventory.json — run `npm run build:site` if this fails', async () => {
    const out = await renderSite()
    for (const [rel, text] of Object.entries(out)) {
      const onDisk = await readFile(join(root, rel), 'utf8')
      // The availability column depends on the build date only through "Immediate"; strip
      // that so the check is about rents, not about which day the pages were generated.
      const norm = (s: string) => s.replace(/<span class="u-date( u-date--now)?">[^<]*<\/span>/g, '<span class="u-date">·</span>')
      assert.equal(norm(onDisk), norm(text), `${rel} is stale`)
    }
  })

  test('the inlined inventory carries the same rent for every residence', async () => {
    const app = await readFile(join(root, 'public', 'app.js'), 'utf8')
    const block = /const INVENTORY = \[\n([\s\S]*?)\n\];/.exec(app)
    assert.ok(block)
    const inlined = block![1]!.split('\n').map((l) => JSON.parse(l.trim().replace(/,$/, '')))
    for (const u of raw as Array<{ unitId: string; monthlyRent: number; concession?: string | null }>) {
      const site = inlined.find((x: { unitId: string }) => x.unitId === u.unitId)
      assert.ok(site, `${u.unitId} missing from the site`)
      assert.equal(site.monthlyRent, u.monthlyRent, `${u.unitId} rent differs on the site`)
      // and the gross figure the page shows is the lease figure the phone quotes
      const html = await readFile(join(root, 'public', 'floorplans.html'), 'utf8')
      const row = new RegExp(`<span class="u-res">${u.unitId}</span>[\\s\\S]*?Gross <b>\\$([\\d,]+)</b>`).exec(html)
      if (row) assert.equal(Number(row[1]!.replace(/,/g, '')), leaseRent(u), `${u.unitId} gross differs on the site`)
    }
  })
})
