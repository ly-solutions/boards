/** Quick edit (HRN-1466): quick_read / quick_apply / quick_undo over MCP. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, TOKEN } from './helpers/app.mjs'

let app
let n = 0
before(async () => {
  app = await startApp()
})
after(() => app?.close())

async function rpc(token, name, args) {
  const response = await fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
  })
  return { status: response.status, body: response.status === 200 ? (await response.json()).result : null }
}
const call = async (name, args) => (await rpc(TOKEN, name, args)).body
const errorOf = (result) => {
  assert.equal(result.isError, true)
  return JSON.parse(result.content[0].text)
}

async function board(title = 'Quick') {
  const made = await call('board_create', { title, graph: { nodes: [{ id: 'a', label: 'Заявка' }, { id: 'b', label: 'Оплата' }], edges: [{ from: 'a', to: 'b' }] } })
  const slug = /slug: (\S+)/.exec(made.content[0].text)[1]
  return slug
}
const read = async (slug) => {
  const r = await call('quick_read', { object: slug })
  assert.equal(r.isError, false)
  return r.structuredContent
}
const lineOf = (text, id) => text.split('\n').find((l) => JSON.parse(l).id === id)

test('quick_read: kind, title, one JSON line per element, label on the shape, same JSON as text', async () => {
  const slug = await board('Чтение')
  const r = await call('quick_read', { object: slug })
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent)
  const { kind, title, text, version } = r.structuredContent
  assert.equal(kind, 'board')
  assert.equal(title, 'Чтение')
  assert.ok(version)
  const rows = text.split('\n').map((l) => JSON.parse(l))
  const a = rows.find((x) => x.id === 'a')
  assert.equal(a.text, 'Заявка')
  assert.deepEqual(Object.keys(a).slice(0, 4), ['id', 'type', 'text', 'stroke'])
  assert.ok(rows.some((x) => x.type === 'arrow'))
  assert.equal(rows.filter((x) => x.type === 'text').length, 0, 'bound labels are not separate lines')
  assert.equal((await read(slug)).version, version)
})

test('quick_apply changes a label and a colour, the board and the version move, hint and ids tell what changed', async () => {
  const slug = await board()
  const before = await read(slug)
  const line = lineOf(before.text, 'a')
  const row = JSON.parse(line)
  const res = await call('quick_apply', {
    object: slug,
    version: before.version,
    edits: [{ old: `"text":"Заявка","stroke":"${row.stroke}"`, new: '"text":"Заказ","stroke":"#e03131"' }],
  })
  assert.equal(res.isError, false, res.content[0].text)
  const out = res.structuredContent
  assert.deepEqual(out.ids, ['a'])
  assert.equal(out.changed, 1)
  assert.ok(out.hint.length <= 400 && out.hint.includes('Заказ'))
  assert.notEqual(out.version, before.version)
  const after = await read(slug)
  assert.equal(after.version, out.version)
  const next = JSON.parse(lineOf(after.text, 'a'))
  assert.equal(next.text, 'Заказ')
  assert.equal(next.stroke, '#e03131')
  const state = await app.store.get(slug)
  assert.equal(state.elements.get('a').strokeColor, '#e03131')
})

test('not_unique and conflict', async () => {
  const slug = await board()
  const v = await read(slug)
  assert.equal(errorOf(await call('quick_apply', { object: slug, version: v.version, edits: [{ old: '"type":"', new: '"type":"' }] })).code, 'not_unique')
  assert.equal(errorOf(await call('quick_apply', { object: slug, version: v.version, edits: [{ old: 'no such text', new: 'x' }] })).code, 'not_unique')
  assert.equal(errorOf(await call('quick_apply', { object: slug, version: 'stale', edits: [{ old: 'Заявка', new: 'X' }] })).code, 'conflict')
  assert.equal(errorOf(await call('quick_apply', { object: slug, version: v.version, edits: [{ old: '{"id":"a"', new: '{"id":"a",' }] })).code, 'bad_edit')
})

test('removing a line needs confirmed: without it needs_yes and the board is unchanged; with it the element goes', async () => {
  const slug = await board()
  const v = await read(slug)
  const line = lineOf(v.text, 'b')
  const edit = { old: `\n${line}`, new: '' }
  assert.equal(errorOf(await call('quick_apply', { object: slug, version: v.version, edits: [edit] })).code, 'needs_yes')
  assert.equal((await read(slug)).version, v.version)
  assert.equal((await app.store.get(slug)).elements.get('b').isDeleted, false)
  const ok = await call('quick_apply', { object: slug, version: v.version, edits: [edit], confirmed: true })
  assert.equal(ok.isError, false, ok.content[0].text)
  assert.ok(ok.structuredContent.ids.includes('b'))
  assert.equal((await app.store.get(slug)).elements.get('b').isDeleted, true)
  assert.equal(lineOf((await read(slug)).text, 'b'), undefined)
})

test('a new line creates an element; an unsupported type is bad_edit', async () => {
  const slug = await board()
  const v = await read(slug)
  const added = await call('quick_apply', { object: slug, version: v.version, edits: [{ old: v.text, new: `${v.text}\n{"id":"n1","type":"ellipse","text":"Новая","stroke":"#1e1e1e","bg":"#ffc9c9","x":400,"y":0,"w":120,"h":80}` }] })
  assert.equal(added.isError, false, added.content[0].text)
  const row = JSON.parse(lineOf((await read(slug)).text, 'n1'))
  assert.equal(row.type, 'ellipse')
  assert.equal(row.text, 'Новая')
  assert.equal(row.bg, '#ffc9c9')
  const w = await read(slug)
  assert.equal(errorOf(await call('quick_apply', { object: slug, version: w.version, edits: [{ old: w.text, new: `${w.text}\n{"id":"z","type":"embeddable","x":0,"y":0}` }] })).code, 'bad_edit')
})

test('quick_undo restores the elements; after another change it is a conflict; with nothing kept — nothing_to_undo', async () => {
  const slug = await board()
  assert.equal(errorOf(await call('quick_undo', { object: slug, version: 'x' })).code, 'nothing_to_undo')
  const v = await read(slug)
  const applied = (await call('quick_apply', { object: slug, version: v.version, edits: [{ old: 'Заявка', new: 'Заказ' }] })).structuredContent
  const undone = await call('quick_undo', { object: slug, version: applied.version })
  assert.equal(undone.isError, false, undone.content[0].text)
  assert.equal(undone.structuredContent.changed, true)
  assert.equal((await read(slug)).text, v.text)
  assert.equal(undone.structuredContent.version, v.version)

  const second = (await call('quick_apply', { object: slug, version: v.version, edits: [{ old: 'Оплата', new: 'Счёт' }] })).structuredContent
  await call('board_edit', { board: slug, update: [{ id: 'a', label: 'Другое' }] })
  assert.equal(errorOf(await call('quick_undo', { object: slug, version: second.version })).code, 'conflict')
  const cur = await read(slug)
  assert.match(cur.text, /Другое/)
  assert.match(cur.text, /Счёт/)
})

test('undo removes what apply created and brings back what it deleted', async () => {
  const slug = await board()
  const v = await read(slug)
  const made = (await call('quick_apply', { object: slug, version: v.version, edits: [{ old: v.text, new: `${v.text}\n{"id":"n2","type":"rectangle","text":"Ещё","x":0,"y":300,"w":100,"h":60}` }] })).structuredContent
  await call('quick_undo', { object: slug, version: made.version })
  assert.equal((await read(slug)).text, v.text)
  const line = lineOf(v.text, 'b')
  const gone = (await call('quick_apply', { object: slug, version: v.version, edits: [{ old: `\n${line}`, new: '' }], confirmed: true })).structuredContent
  await call('quick_undo', { object: slug, version: gone.version })
  assert.equal((await read(slug)).text, v.text)
})

test('the same rights as the edit tools: no token and a wrong token are refused', async () => {
  const slug = await board()
  const v = await read(slug)
  for (const token of [null, 'wrong-token-0123456789abcdefghij']) {
    for (const [name, args] of [['quick_read', { object: slug }], ['quick_apply', { object: slug, version: v.version, edits: [{ old: 'Заявка', new: 'X' }] }]]) {
      assert.equal((await rpc(token, name, args)).status, 401, name)
    }
  }
  assert.match((await read(slug)).text, /Заявка/)
  const missing = await call('quick_read', { object: 'no-such-board-000000000000' })
  assert.equal(missing.isError, true)
})
