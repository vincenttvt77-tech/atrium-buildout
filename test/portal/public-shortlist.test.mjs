import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source = await readFile(new URL('../../public/shortlist.js', import.meta.url), 'utf8')
const ctx = { URL }; runInNewContext(source, ctx)
const api = ctx.AtriumShortlist
const read = (hash, units = board) => JSON.parse(JSON.stringify(api.read(hash, units)))
const board = [
  { unitId: '19A', status: 'available' }, { unitId: '21B', status: 'pending' },
  { unitId: '30C', status: 'leased' }, { unitId: '40D', status: 'offline' },
  ...['1A', '2A', '3A', '4A', '5A'].map(unitId => ({ unitId, status: 'available' }))
]
test('public-only selection round-trips without inheriting contact queries or auth', () => {
  const url = api.link('https://staff:secret@larkin.example/api/dashboard?phone=private', ['19A', '21B'], board)
  assert.equal(url, 'https://larkin.example/#availability?units=19A%2C21B')
  assert.deepEqual(read(new URL(url).hash), { active: true, ids: ['19A', '21B'], missing: 0, invalid: false })
})
test('ordinary anchors and other pages do not accidentally activate a shortlist', () => {
  for (const hash of ['', '#availability', '#floorplans', '#/today']) assert.equal(read(hash).active, false)
})
test('invalid, encoded attack, malformed and oversized links never expand to all units', () => {
  for (const hash of ['#availability?', '#availability?units=', '#availability?units=%E0%A4%A', '#availability?units=%3Cscript%3E', '#availability?units=19A&phone=x', '#availability?units=' + 'A'.repeat(351)]) {
    const parsed = read(hash)
    assert.equal(parsed.active, true); assert.equal(parsed.invalid, true); assert.deepEqual(parsed.ids, [])
  }
})
test('six input selections are rejected instead of silently truncating coverage', () => {
  assert.equal(read('#availability?units=19A,1A,2A,3A,4A,5A').invalid, true)
  assert.equal(api.link('https://larkin.example', ['19A','1A','2A','3A','4A','5A'], board), '')
})
test('canonical case and duplicates resolve to a single published residence', () => {
  assert.deepEqual(read('#availability?units=19a,19A,21b').ids, ['19A', '21B'])
})
test('removed, leased and unknown units are reported missing, never shown as available', () => {
  assert.deepEqual(read('#availability?units=19A,30C,40D,99Z'), { active: true, ids: ['19A'], missing: 3, invalid: false })
  assert.deepEqual(read('#availability?units=30C'), { active: true, ids: [], missing: 1, invalid: false })
})
test('pending remains distinguishable in published inventory and can be selected for inquiry', () => {
  assert.equal(api.published(board).find(u => u.unitId === '21B').status, 'pending')
  assert.ok(api.link('https://larkin.example', ['21B'], board))
})
test('link generation refuses unknown, invalid, unpublished, empty and duplicate selections', () => {
  for (const ids of [[], ['30C'], ['99Z'], ['19A', '19A'], ['<script>']]) assert.equal(api.link('https://larkin.example', ids, board), '')
  assert.equal(api.link('file:///site/index.html', ['19A'], board), '')
})
test('site loads the shortlist contract before the application and retains demo disclosure', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8')
  assert.ok(html.indexOf('src="/shortlist.js"') < html.indexOf('src="/app.js"'))
  assert.match(html, /Demo inventory; a selection is not a reservation/)
  assert.match(html, /No message is sent automatically/)
})
test('mixed-case published IDs round-trip canonical links without losing the unit', () => {
  const units = [{ unitId: '9l', status: 'available' }]
  const url = api.link('https://larkin.example', ['9l'], units)
  assert.equal(url, 'https://larkin.example/#availability?units=9L')
  assert.deepEqual(read(new URL(url).hash, units).ids, ['9l'])
})
