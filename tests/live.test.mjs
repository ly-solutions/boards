/**
 * Live channel (WebSocket): edits, presence, cursors, follow mode, catch-up after reconnects, origin checks.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startApp, TOKEN, PUBLIC_URL } from './helpers/app.mjs'

let t
let base
let wsBase
let store
const token = TOKEN
const ORIGIN = PUBLIC_URL

before(async () => {
  t = await startApp()
  base = t.base
  wsBase = base.replace('http', 'ws')
  store = t.store
})

after(async () => {
  await t.close()
})

const session = (name = 'Ada Lovelace', email = 'ada@example.com') => t.cookie({ name, email })

async function createBoard(body = {}) {
  const { status, body: board } = await t.createBoard({ title: 'Live board', ...body })
  assert.equal(status, 201)
  return board
}

const el = (id, version = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: 1000 + version, x: 0, y: 0, width: 10, height: 10, index: `a${id}`, ...extra })

/** A live-channel client: collects incoming messages and can wait for a specific one. */
function connect(board, { client, cookie, origin = ORIGIN, guest } = {}) {
  const params = new URLSearchParams({ k: board.key })
  if (client) params.set('client', client)
  if (guest) params.set('guest', guest)
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (origin) headers.origin = origin
  const ws = new WebSocket(`${wsBase}/b/${board.slug}/live?${params}`, { headers })
  const inbox = []
  const waiters = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    inbox.push(msg)
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(msg)
      }
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`upgrade ${res.statusCode}`), { status: res.statusCode })))
    ws.once('error', reject)
  })
  return {
    ws,
    inbox,
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(match, ms = 2000) {
      const found = inbox.find(match)
      if (found) {
        inbox.splice(inbox.indexOf(found), 1)
        return Promise.resolve(found)
      }
      return new Promise((resolve, reject) => {
        const w = {
          match,
          resolve: (msg) => {
            clearTimeout(timer)
            inbox.splice(inbox.indexOf(msg), 1)
            resolve(msg)
          },
        }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error('timed out waiting for a message'))
        }, ms)
        waiters.push(w)
      })
    },
    close: () => ws.close(),
  }
}

const idle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

test("one participant's edit reaches the other at once, and the author gets only an ack", async () => {
  const board = await createBoard()
  const a = connect(board, { client: 'aaaa1', cookie: session() })
  const b = connect(board, { client: 'bbbb1', cookie: session('Grace Hopper', 'grace@example.com') })
  await Promise.all([a.opened, b.opened])
  const welcome = await a.next((m) => m.t === 'welcome')
  assert.equal(welcome.id, 'aaaa1')
  assert.equal(welcome.canEdit, true)

  a.send({ t: 'push', seq: 1, elements: [el('r1')] })
  const ack = await a.next((m) => m.t === 'ack')
  assert.equal(ack.seq, 1)
  assert.equal(ack.accepted, 1)
  const got = await b.next((m) => m.t === 'elements')
  assert.deepEqual(got.elements.map((e) => e.id), ['r1'])
  assert.equal(got.elements[0].customData.editedBy, 'Ada Lovelace')
  assert.equal(got.rev, ack.rev)
  await idle()
  assert.ok(!a.inbox.some((m) => m.t === 'elements'), 'the author does not get their own edit back')
  a.close()
  b.close()
})

test('cursor and selection are signed by the server, not the client', async () => {
  const board = await createBoard()
  const a = connect(board, { client: 'aaaa2', cookie: session() })
  const b = connect(board, { client: 'bbbb2', cookie: session('Grace Hopper', 'grace@example.com') })
  await Promise.all([a.opened, b.opened])
  const presence = await b.next((m) => m.t === 'presence' && m.viewers.length === 2)
  assert.deepEqual(presence.viewers.map((v) => v.name).sort(), ['Ada Lovelace', 'Grace Hopper'])
  assert.ok(presence.viewers.every((v) => v.live))

  a.send({ t: 'pointer', x: 10.5, y: -3, tool: 'laser', button: 'down', name: 'Impostor' })
  const pointer = await b.next((m) => m.t === 'pointer')
  assert.deepEqual(pointer, { t: 'pointer', id: 'aaaa2', x: 10.5, y: -3, tool: 'laser', button: 'down' })

  a.send({ t: 'select', ids: ['x', 'y'] })
  assert.deepEqual((await b.next((m) => m.t === 'select')).ids, ['x', 'y'])

  a.send({ t: 'state', state: 'away' })
  const away = await b.next((m) => m.t === 'presence' && m.viewers.some((v) => v.id === 'aaaa2' && v.state === 'away'))
  assert.ok(away)

  a.close()
  const left = await b.next((m) => m.t === 'presence' && m.viewers.length === 1)
  assert.equal(left.viewers[0].id, 'bbbb2')
  b.close()
})

test('an anonymous viewer sees edits but cannot edit a team board', async () => {
  const board = await createBoard()
  const viewer = connect(board, { client: 'vvvv3' })
  const author = connect(board, { client: 'aaaa3', cookie: session() })
  await Promise.all([viewer.opened, author.opened])
  assert.equal((await viewer.next((m) => m.t === 'welcome')).canEdit, false)

  viewer.send({ t: 'push', seq: 7, elements: [el('bad')] })
  const ack = await viewer.next((m) => m.t === 'ack')
  assert.equal(ack.accepted, 0)
  assert.match(ack.error, /view-only/)
  const state = await store.get(board.slug)
  assert.equal(state.elements.has('bad'), false)

  author.send({ t: 'push', seq: 1, elements: [el('good')] })
  assert.deepEqual((await viewer.next((m) => m.t === 'elements')).elements.map((e) => e.id), ['good'])
  viewer.close()
  author.close()
})

test('a guest edits a board opened by link and is signed with their name', async () => {
  const board = await createBoard({ access: 'link' })
  const guest = connect(board, { client: 'gggg4', guest: 'Kate' })
  const watcher = connect(board, { client: 'wwww4', cookie: session() })
  await Promise.all([guest.opened, watcher.opened])
  guest.send({ t: 'push', seq: 1, elements: [el('g1')] })
  assert.equal((await guest.next((m) => m.t === 'ack')).accepted, 1)
  const got = await watcher.next((m) => m.t === 'elements')
  assert.equal(got.elements[0].customData.editedBy, 'guest: Kate')
  guest.close()
  watcher.close()
})

test("an agent's edit and a polling client's edit arrive over the live channel", async () => {
  const board = await createBoard()
  const live = connect(board, { client: 'llll5', cookie: session() })
  await live.opened
  await live.next((m) => m.t === 'welcome')

  const response = await fetch(`${base}/b/${board.slug}/edit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ graph: { nodes: [{ id: 'pay', label: 'Payments' }] }, note: 'added payments', author: 'Claude' }),
  })
  assert.equal(response.status, 200)
  const elements = await live.next((m) => m.t === 'elements')
  assert.ok(elements.elements.some((e) => e.id === 'pay'))
  const edit = await live.next((m) => m.t === 'edit')
  assert.equal(edit.edit.by, 'Claude')
  assert.equal(edit.edit.note, 'added payments')

  const poll = await fetch(`${base}/b/${board.slug}/sync?k=${board.key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session('Alan Turing', 'alan@example.com') },
    body: JSON.stringify({ since: 0, epoch: 'old', elements: [el('polled')], client: 'pppp5' }),
  })
  assert.equal(poll.status, 200)
  const polled = await live.next((m) => m.t === 'elements' && m.elements.some((e) => e.id === 'polled'))
  assert.equal(polled.elements[0].customData.editedBy, 'Alan Turing')
  const presence = await live.next((m) => m.t === 'presence' && m.viewers.some((v) => v.id === 'pppp5'))
  assert.equal(presence.viewers.find((v) => v.id === 'pppp5').live, false)
  live.close()
})

test("hello returns what was missed since the client's revision, and everything on a different epoch", async () => {
  const board = await createBoard()
  const a = connect(board, { client: 'aaaa6', cookie: session() })
  await a.opened
  const { epoch } = await a.next((m) => m.t === 'welcome')
  a.send({ t: 'push', seq: 1, elements: [el('one')] })
  const first = await a.next((m) => m.t === 'ack')
  a.send({ t: 'push', seq: 2, elements: [el('two')] })
  await a.next((m) => m.t === 'ack')

  a.send({ t: 'hello', since: first.rev, epoch })
  const partial = await a.next((m) => m.t === 'sync')
  assert.equal(partial.full, false)
  assert.deepEqual(partial.elements.map((e) => e.id), ['two'])

  a.send({ t: 'hello', since: first.rev, epoch: 'another' })
  const full = await a.next((m) => m.t === 'sync')
  assert.equal(full.full, true)
  assert.deepEqual(full.elements.map((e) => e.id).sort(), ['one', 'two'])
  a.close()
})

test("follow mode: only the leader's followers receive their viewport", async () => {
  const board = await createBoard()
  const leader = connect(board, { client: 'lead7', cookie: session() })
  const follower = connect(board, { client: 'foll7', cookie: session('Grace Hopper', 'grace@example.com') })
  const other = connect(board, { client: 'othr7', cookie: session('Alan Turing', 'alan@example.com') })
  await Promise.all([leader.opened, follower.opened, other.opened])
  await follower.next((m) => m.t === 'welcome')

  follower.send({ t: 'follow', target: 'lead7', on: true })
  assert.deepEqual((await leader.next((m) => m.t === 'followers')).ids, ['foll7'])
  leader.send({ t: 'viewport', bounds: [0, 0, 800, 600] })
  assert.deepEqual((await follower.next((m) => m.t === 'viewport')).bounds, [0, 0, 800, 600])
  await idle()
  assert.ok(!other.inbox.some((m) => m.t === 'viewport'))

  follower.close()
  assert.deepEqual((await leader.next((m) => m.t === 'followers')).ids, [])
  leader.close()
  other.close()
})

test('a wrong key or a foreign Origin does not open the channel', async () => {
  const board = await createBoard()
  const wrongKey = connect({ ...board, key: 'nope' }, { cookie: session() })
  await assert.rejects(wrongKey.opened, (error) => error.status === 404)
  const foreign = connect(board, { cookie: session(), origin: 'https://evil.example' })
  await assert.rejects(foreign.opened, (error) => error.status === 403)
  const noOrigin = connect(board, { origin: null })
  await noOrigin.opened
  noOrigin.close()
})

test('the board page enables live mode and allows the socket in the CSP', async () => {
  const board = await createBoard()
  const response = await fetch(`${base}/b/${board.slug}?k=${board.key}`, { headers: { accept: 'text/html', cookie: session() } })
  const html = await response.text()
  const config = JSON.parse(/<script type="application\/json" id="board-config">(.*?)<\/script>/s.exec(html)[1])
  assert.equal(config.live, true)
  assert.equal(config.snap, true)
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self' ws:\/\/boards\.test/)
})

test('ping gets pong: the client checks the channel is alive', async () => {
  const board = await createBoard()
  const a = connect(board, { client: 'pppp7', cookie: session() })
  await a.opened
  await a.next((m) => m.t === 'welcome')
  a.send({ t: 'ping' })
  assert.equal((await a.next((m) => m.t === 'pong' || m.t === 'error')).t, 'pong')
  a.close()
})

test('a reconnecting tab reclaims its id instead of leaving a ghost cursor', async () => {
  const board = await createBoard()
  const watcher = connect(board, { client: 'wwww8', cookie: session('Grace Hopper', 'grace@example.com') })
  const first = connect(board, { client: 'rrrr8', cookie: session() })
  await Promise.all([watcher.opened, first.opened])
  await watcher.next((m) => m.t === 'presence' && m.viewers.length === 2)
  // The old socket is still "alive" as far as the server knows — as after a laptop wakes from sleep.
  const second = connect(board, { client: 'rrrr8', cookie: session() })
  await second.opened
  assert.equal((await second.next((m) => m.t === 'welcome')).id, 'rrrr8')
  await idle(200)
  const viewers = [...watcher.inbox].reverse().find((m) => m.t === 'presence')?.viewers ?? store.presence(await store.get(board.slug))
  assert.deepEqual(viewers.map((v) => v.id).sort(), ['rrrr8', 'wwww8'])
  assert.deepEqual(store.presence(await store.get(board.slug)).map((v) => v.id).sort(), ['rrrr8', 'wwww8'])
  // Someone else with the same id does not get the slot.
  const stranger = connect(board, { client: 'rrrr8', cookie: session('Alan Turing', 'alan@example.com') })
  await stranger.opened
  assert.notEqual((await stranger.next((m) => m.t === 'welcome')).id, 'rrrr8')
  for (const c of [watcher, second, stranger]) c.close()
})

test('a newcomer immediately sees the cursors of people who are standing still', async () => {
  const board = await createBoard()
  const a = connect(board, { client: 'cccc9', cookie: session() })
  await a.opened
  await a.next((m) => m.t === 'welcome')
  a.send({ t: 'pointer', x: 120, y: 45, tool: 'pointer', button: 'up' })
  await idle(100)
  const b = connect(board, { client: 'dddd9', cookie: session('Grace Hopper', 'grace@example.com') })
  await b.opened
  await b.next((m) => m.t === 'welcome')
  b.send({ t: 'hello', since: 0, epoch: '' })
  const sync = await b.next((m) => m.t === 'sync')
  assert.deepEqual(sync.pointers, [{ id: 'cccc9', x: 120, y: 45, tool: 'pointer', button: 'up' }])
  a.close()
  b.close()
})
