/** Comment threads: data rules (server/comments.mjs) and the HTTP contract with permissions and webhook events. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMENT_LIMITS, CommentError, changeThread, openThread, placePin } from '../server/comments.mjs'
import { createWebhook } from '../server/hooks.mjs'
import { startApp } from './helpers/app.mjs'

const shape = (id, x = 100, y = 50, extra = {}) => ({ id, type: 'rectangle', x, y, width: 120, height: 60, isDeleted: false, ...extra })
const elements = new Map([
  ['box', shape('box')],
  ['gone', shape('gone', 0, 0, { isDeleted: true })],
])
const notes = () => ({ reactions: {}, comments: [] })
const ada = { author: 'Ada', kind: 'person' }

test('a pin on a live shape is anchored by offset; on a deleted or unknown shape it is a canvas pin', () => {
  assert.deepEqual(placePin(elements, 130.4, 70.6, 'box'), { x: 130, y: 71, elementId: 'box', dx: 30, dy: 21 })
  assert.deepEqual(placePin(elements, 10, 10, 'gone'), { x: 10, y: 10, elementId: null, dx: 0, dy: 0 })
  assert.deepEqual(placePin(elements, 10, 10, 'nope'), { x: 10, y: 10, elementId: null, dx: 0, dy: 0 })
})

test('opening a thread validates text and position and respects the thread limit', () => {
  const n = notes()
  const thread = openThread(n, elements, { text: '  Why sync?  ', x: 110, y: 60, elementId: 'box' }, ada)
  assert.match(thread.id, /^[0-9a-f]{10}$/)
  assert.equal(thread.messages[0].text, 'Why sync?')
  assert.equal(thread.messages[0].authorKind, 'person')
  assert.equal(thread.resolved, false)
  assert.equal(n.comments.length, 1)
  assert.throws(() => openThread(n, elements, { text: ' ', x: 0, y: 0 }, ada), (e) => e instanceof CommentError && e.status === 400)
  assert.throws(() => openThread(n, elements, { text: 'x', x: 'a', y: 0 }, ada), /x, y/)
  const long = openThread(n, elements, { text: 'y'.repeat(5000), x: 0, y: 0 }, { author: 'bot', kind: 'agent' })
  assert.equal(long.messages[0].text.length, COMMENT_LIMITS.text)
  assert.equal(long.messages[0].authorKind, 'agent')
  const full = { reactions: {}, comments: Array.from({ length: COMMENT_LIMITS.threads }, (_, i) => ({ id: String(i) })) }
  assert.throws(() => openThread(full, elements, { text: 'one more', x: 0, y: 0 }, ada), /at most/)
})

test('replies keep replyTo only for messages of the thread; resolve reports a change only once', () => {
  const n = notes()
  const t = openThread(n, elements, { text: 'first', x: 0, y: 0 }, ada)
  const first = t.messages[0].id
  const r1 = changeThread(n, elements, t.id, { reply: 'answer', replyTo: first }, { author: 'Grace' })
  assert.equal(r1.replied.replyTo, first)
  const r2 = changeThread(n, elements, t.id, { reply: 'stray', replyTo: 'deadbeef00' }, { author: 'Grace' })
  assert.equal(r2.replied.replyTo, undefined)
  assert.equal(changeThread(n, elements, t.id, { resolved: true }, { author: 'Grace' }).resolvedChanged, true)
  assert.equal(t.resolvedBy, 'Grace')
  assert.equal(changeThread(n, elements, t.id, { resolved: true }, { author: 'Grace' }).resolvedChanged, false)
  changeThread(n, elements, t.id, { resolved: false }, { author: 'Ada' })
  assert.equal(t.resolvedBy, null)
})

test('moving re-anchors; deleting a reply keeps the thread, deleting the first message removes it', () => {
  const n = notes()
  const t = openThread(n, elements, { text: 'first', x: 0, y: 0 }, ada)
  changeThread(n, elements, t.id, { x: 150, y: 80, elementId: 'box' }, ada)
  assert.equal(t.elementId, 'box')
  assert.equal(t.dx, 50)
  const reply = changeThread(n, elements, t.id, { reply: 'second' }, ada).replied
  assert.equal(changeThread(n, elements, t.id, { removeMessage: reply.id }, ada).removed, false)
  assert.equal(t.messages.length, 1)
  assert.equal(changeThread(n, elements, t.id, { removeMessage: t.messages[0].id }, ada).removed, true)
  assert.equal(n.comments.length, 0)
  assert.throws(() => changeThread(n, elements, t.id, { reply: 'late' }, ada), (e) => e.status === 404)
})

test('mayDelete guards deleting other people\'s threads and messages', () => {
  const n = notes()
  const t = openThread(n, elements, { text: 'mine', x: 0, y: 0 }, ada)
  const onlyOwn = (author) => author === 'guest: Kim'
  assert.throws(() => changeThread(n, elements, t.id, { remove: true }, { author: 'guest: Kim', mayDelete: onlyOwn }), (e) => e.status === 403)
  const kims = changeThread(n, elements, t.id, { reply: 'from Kim' }, { author: 'guest: Kim' }).replied
  assert.equal(changeThread(n, elements, t.id, { removeMessage: kims.id }, { author: 'guest: Kim', mayDelete: onlyOwn }).removed, false)
})

function recordingWebhook() {
  const calls = []
  const webhook = createWebhook({
    url: 'https://hooks.example/boards',
    secret: 's3cret',
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return new Response('{}', { status: 200 })
    },
    log: () => {},
  })
  return { webhook, calls }
}

test('HTTP: thread lifecycle with webhook events, board text, and persistence across a restart', async () => {
  const { webhook, calls } = recordingWebhook()
  const t = await startApp({ appOptions: { webhook } })
  try {
    const { body } = await t.createBoard({ graph: { nodes: [{ id: 'gw', label: 'API gateway' }] } })
    const k = new URL(body.url).searchParams.get('k')
    const post = (path, payload, headers = t.agent) => fetch(`${t.base}/b/${body.slug}/${path}?k=${k}`, { method: 'POST', headers, body: JSON.stringify(payload) })

    let res = await post('comments', { text: 'Is this synchronous?', x: 10, y: 10, elementId: 'gw', author: 'reviewer-bot' })
    assert.equal(res.status, 201)
    const created = await res.json()
    const id = created.thread.id
    assert.equal(created.notes.comments.length, 1)
    assert.equal(created.thread.elementId, 'gw')

    res = await post(`comments/${id}`, { reply: 'Yes, over HTTP' }, { 'content-type': 'application/json', cookie: t.cookie() })
    assert.equal(res.status, 200)
    res = await post(`comments/${id}`, { resolved: true })
    assert.equal((await res.json()).thread.resolved, true)
    res = await post(`comments/${id}`, { resolved: false })
    assert.equal(res.status, 200)

    const text = await (await fetch(`${t.base}/b/${body.slug}.md?k=${k}`)).text()
    assert.match(text, /Is this synchronous\?/)
    assert.match(text, /Yes, over HTTP/)

    await webhook.settle()
    assert.deepEqual(calls.map((c) => c.body.event), ['thread.created', 'thread.replied', 'thread.resolved', 'thread.reopened'])
    const [first, second] = calls
    assert.equal(first.headers['x-boards-webhook-secret'], 's3cret')
    assert.equal(first.body.slug, body.slug)
    assert.equal(first.body.url, body.url)
    assert.deepEqual(first.body.thread.anchor, { elementId: 'gw', label: 'API gateway', x: 10, y: 10 })
    assert.equal(first.body.message.authorKind, 'agent')
    assert.equal(first.body.message.author, 'reviewer-bot')
    assert.equal(second.body.message.author, 'Ada Lovelace')
    assert.equal(second.body.message.authorEmail, 'ada@example.com')
    assert.equal(second.body.message.authorKind, 'person')

    await t.store.flushAll()
    t.store._boards.clear()
    const reloaded = await (await fetch(`${t.base}/b/${body.slug}/scene.excalidraw?k=${k}`)).json()
    assert.equal(reloaded.notes.comments[0].messages.length, 2)

    res = await post(`comments/${id}`, { remove: true })
    assert.equal((await res.json()).notes.comments.length, 0)
    await webhook.settle()
    assert.equal(calls.at(-1).body.event, 'thread.removed')
    assert.equal(calls.at(-1).body.message, undefined)
  } finally {
    await t.close()
  }
})

test('HTTP: viewers cannot comment; guests on link boards can, but delete only their own', async () => {
  const t = await startApp()
  try {
    const team = (await t.createBoard({ title: 'Team board' })).body
    const teamKey = new URL(team.url).searchParams.get('k')
    const viewer = await fetch(`${t.base}/b/${team.slug}/comments?k=${teamKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', x: 0, y: 0 }) })
    assert.equal(viewer.status, 403)

    const open = (await t.createBoard({ title: 'Open board', access: 'link' })).body
    const k = new URL(open.url).searchParams.get('k')
    const post = (path, payload, headers = { 'content-type': 'application/json' }) => fetch(`${t.base}/b/${open.slug}/${path}?k=${k}`, { method: 'POST', headers, body: JSON.stringify(payload) })
    const agentThread = (await (await post('comments', { text: 'from the agent', x: 0, y: 0 }, t.agent)).json()).thread
    const guestThread = (await (await post('comments', { text: 'from a guest', x: 5, y: 5, guest: 'Kim' })).json()).thread
    assert.equal(guestThread.author, 'guest: Kim')
    assert.equal((await post(`comments/${agentThread.id}`, { remove: true, guest: 'Kim' })).status, 403)
    assert.equal((await post(`comments/${guestThread.id}`, { remove: true, guest: 'Kim' })).status, 200)
    assert.equal((await post(`comments/${agentThread.id}`, { remove: true }, { 'content-type': 'application/json', cookie: t.cookie() })).status, 200)
    assert.equal((await post('comments/0123456789', { reply: 'x' }, t.agent)).status, 404)
    assert.equal((await post('comments', { text: '', x: 0, y: 0 }, t.agent)).status, 400)
  } finally {
    await t.close()
  }
})
