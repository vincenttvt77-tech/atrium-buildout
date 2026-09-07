import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { render, placeholdersIn, NoopTransport } from '../render.ts'

describe('placeholder substitution', () => {
  test('replaces every placeholder', () => {
    const r = render('<p>Hi {{name}}, {{day}} at {{time}}.</p>',
      { name: 'Dana', day: 'Saturday', time: '2:00pm' })
    assert.equal(r.html, '<p>Hi Dana, Saturday at 2:00pm.</p>')
    assert.deepEqual(r.missing, [])
  })

  test('tolerates whitespace inside the braces', () => {
    assert.equal(render('{{ name }}', { name: 'Dana' }).html, 'Dana')
  })

  test('reports missing values rather than leaving braces in a sent email', () => {
    const r = render('Hi {{name}}, unit {{unitId}}.', { name: 'Dana' })
    assert.deepEqual(r.missing, ['unitId'])
    assert.ok(!r.html.includes('{{'), 'raw placeholders must never reach a recipient')
  })

  test('reports unused values, which usually means a renamed placeholder', () => {
    const r = render('Hi {{name}}.', { name: 'Dana', tourTime: '2pm' })
    assert.deepEqual(r.unused, ['tourTime'])
  })

  test('escapes values so a name cannot inject markup', () => {
    const r = render('<p>{{name}}</p>', { name: '<script>alert(1)</script>' })
    assert.ok(!r.html.includes('<script>'))
    assert.match(r.html, /&lt;script&gt;/)
  })

  test('lists the placeholders a template needs', () => {
    assert.deepEqual(placeholdersIn('{{a}} {{b}} {{a}}').sort(), ['a', 'b'])
  })
})

describe('sending degrades honestly', () => {
  test('with no provider the message is queued, not reported as sent', async () => {
    const t = new NoopTransport()
    const r = await t.send({ to: 'a@b.com', from: 'c@d.com', subject: 'x', html: '<p>x</p>' })
    assert.equal(r.sent, false)
    assert.equal(r.sent === false && r.queued, true)
    assert.equal(t.outbox.length, 1, 'the message is kept so it can be sent later')
  })
})
