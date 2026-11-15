/** The board as a picture for an agent (HRN-1480): what is picked around objects, the PNG route, «Агент рисует». */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { pick } from '../server/picture.mjs'
import { startApp } from './helpers/app.mjs'

const box = (id, x, y, extra = {}) => ({ id, type: 'rectangle', x, y, width: 100, height: 60, isDeleted: false, ...extra })

test('pick: all live elements, or the asked ones with their labels and neighbours within reach', () => {
  const els = [box('a', 0, 0), { id: 'la', type: 'text', x: 10, y: 10, width: 50, height: 20, containerId: 'a' }, box('near', 200, 0), box('far', 3000, 3000), box('dead', 0, 0, { isDeleted: true })]
  assert.deepEqual(pick(els, []).map((e) => e.id), ['a', 'la', 'near', 'far'])
  assert.deepEqual(pick(els, ['a']).map((e) => e.id), ['a', 'la', 'near'])
  assert.deepEqual(pick(els, ['la']).map((e) => e.id), ['a', 'la', 'near'])
  assert.equal(pick(els, ['nope']), null)
})

let t
before(async () => {
  t = await startApp()
})
after(() => t.close())

test('picture.png is a PNG of the board, 404 when none of the ids is on it; an agent may say it is at work', async () => {
  const { body } = await t.createBoard({ graph: { nodes: [{ id: 'a', label: 'Gateway' }, { id: 'b', label: 'orders-api' }], edges: [{ from: 'a', to: 'b' }] } })
  const key = new URL(body.url).searchParams.get('k')
  const res = await fetch(`${t.base}/b/${body.slug}/picture.png?k=${key}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const png = Buffer.from(await res.arrayBuffer())
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47])
  assert.equal((await fetch(`${t.base}/b/${body.slug}/picture.png?k=${key}&ids=nope`)).status, 404)
  assert.equal((await fetch(`${t.base}/b/${body.slug}/picture.png?k=wrongwrongwrongwrongww`)).status, 404)
  const working = await fetch(`${t.base}/b/${body.slug}/agent?k=${key}`, { method: 'POST', headers: t.agent, body: JSON.stringify({ status: 'working', author: 'Claude' }) })
  assert.equal(working.status, 200)
  const done = await fetch(`${t.base}/b/${body.slug}/agent?k=${key}`, { method: 'POST', headers: t.agent, body: JSON.stringify({ status: 'done' }) })
  assert.equal(done.status, 200)
})

test('an edit answers with the changed ids and a link that opens the board on them', async () => {
  const { body } = await t.createBoard({ graph: { nodes: [{ id: 'a', label: 'Gateway' }] } })
  const key = new URL(body.url).searchParams.get('k')
  const res = await fetch(`${t.base}/b/${body.slug}/edit?k=${key}`, { method: 'POST', headers: t.agent, body: JSON.stringify({ graph: { nodes: [{ id: 'q', label: 'Queue' }], edges: [{ from: 'a', to: 'q' }] } }) })
  const edit = await res.json()
  assert.equal(res.status, 200)
  assert.ok(edit.changed.includes('q'))
  assert.ok(!edit.changed.some((id) => id.startsWith('q') && id !== 'q' && id.includes('label')))
  assert.equal(edit.show, `${edit.url}&show=${edit.changed.join(',')}`)
})
