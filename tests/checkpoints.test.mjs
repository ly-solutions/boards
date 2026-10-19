/**
 * Checkpoints: a meaningful diff between snapshots, creating and reading checkpoints, "close week", a copy of the
 * board from a checkpoint, and the shared timer.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../server/store.mjs'
import { createBoardStorage } from '../server/storage/boards.mjs'
import { fsObjects } from '../server/storage/objects.mjs'
import { diff, summarize, weekCleanup, weekOutcome, OUTCOME_FILL } from '../shared/checkpoints.mjs'
import { startApp, PUBLIC_URL } from './helpers/app.mjs'

const box = (id, x, y, fill = '#ffe299', extra = {}) => ({ id, type: 'rectangle', x, y, width: 100, height: 100, backgroundColor: fill, version: 1, versionNonce: 1, index: `a${id}`, boundElements: [{ type: 'text', id: `${id}-t` }], ...extra })
const label = (id, text) => ({ id: `${id}-t`, type: 'text', x: 0, y: 0, width: 80, height: 20, text, originalText: text, containerId: id, version: 1, versionNonce: 1, index: `a${id}t` })
const sticky = (id, x, y, text, fill, author = 'Ada') => [box(id, x, y, fill, { customData: { kind: 'sticky', author } }), label(id, text)]

test('diff: appearing, changed text or colour, removal count; moving and resizing do not', () => {
  const before = [...sticky('a', 0, 0, 'Launch the newsletter'), ...sticky('b', 200, 0, 'Admin demo'), ...sticky('c', 400, 0, 'One message to everyone'), ...sticky('d', 600, 0, 'Redesign')]
  const after = [
    ...sticky('a', 0, 0, 'Write to customers personally'),
    // same text and colour, different place and size — that is a move
    box('b', 950, 420, '#ffe299', { width: 140, customData: { kind: 'sticky', author: 'Ada' } }),
    label('b', 'Admin demo'),
    ...sticky('d', 600, 0, 'Redesign', OUTCOME_FILL.done),
    ...sticky('e', 800, 0, 'Competitor pitch', '#ffe299', 'Grace'),
    { id: 'arrow', type: 'arrow', x: 0, y: 0, width: 50, height: 0, version: 1, versionNonce: 1 },
  ]
  const d = diff(before, after)
  assert.deepEqual(d.added.map((u) => u.id), ['e'])
  assert.deepEqual(d.changed.map((u) => [u.id, u.before.text, u.before.fill]).sort(), [['a', 'Launch the newsletter', '#ffe299'], ['d', 'Redesign', '#ffe299']])
  assert.deepEqual(d.removed.map((u) => u.id), ['c'])
  assert.equal(d.moved, 1)
  assert.deepEqual(summarize(d), { added: 1, stickies: 1, changed: 2, removed: 1, moved: 1, byAuthor: { Grace: 1, Ada: 2 } })
})

test('whitespace and line breaks in a label are not a change; an empty label is not a block', () => {
  const d = diff([...sticky('a', 0, 0, 'Meeting\nplan')], [...sticky('a', 0, 0, 'Meeting  plan'), ...sticky('b', 0, 0, '   ')])
  assert.deepEqual([d.added.length, d.changed.length, d.removed.length], [0, 0, 0])
})

test('week outcome and cleanup: done stickies leave with their labels, failed ones get their colour back', () => {
  const scene = [...sticky('a', 0, 0, 'done', OUTCOME_FILL.done), ...sticky('b', 0, 0, 'failed', OUTCOME_FILL.failed), ...sticky('c', 0, 0, 'in progress'), box('x', 0, 0, OUTCOME_FILL.done)]
  assert.deepEqual(weekOutcome(scene), { done: 1, failed: 1, open: 1 })
  const { remove, reset } = weekCleanup(scene)
  assert.deepEqual(remove.sort(), ['a', 'a-t'])
  assert.deepEqual(reset, ['b'])
})

let t, base, store, auth

before(async () => {
  t = await startApp()
  base = t.base
  store = t.store
  auth = t.agent
})

after(async () => {
  await t.close()
})

const createBoard = async (title) => (await t.createBoard({ title })).body

test('checkpoint: created with a title, keeps a summary, survives a restart; the second one shows the diff from the first', async () => {
  const created = await createBoard('Planning')
  const state = await store.get(created.slug)
  const url = (path) => `${base}/b/${created.slug}/${path}?k=${created.key}`
  const post = (path, body) => fetch(url(path), { method: 'POST', headers: auth, body: JSON.stringify({ author: 'Ada', ...body }) }).then(async (r) => ({ status: r.status, body: await r.json() }))
  const get = (path) => fetch(url(path)).then((r) => r.json())

  store.apply(state, [...sticky('a', 0, 0, 'Launch the newsletter'), ...sticky('b', 200, 0, 'Admin demo')], [], { by: 'Ada' })
  const listed = await get('checkpoints')
  assert.equal(listed.pending.added, 2)
  assert.deepEqual(listed.checkpoints, [])
  assert.deepEqual(listed.week, { done: 0, failed: 0, open: 2 })
  assert.equal('inbox' in listed, false)
  assert.equal((await post('checkpoints', { title: '   ' })).status, 400)
  const first = await post('checkpoints', { title: 'Week of October 5' })
  assert.equal(first.status, 201)
  assert.deepEqual([first.body.checkpoint.title, first.body.checkpoint.by, first.body.checkpoint.summary.added], ['Week of October 5', 'Ada', 2])

  // Right after a checkpoint there are no changes; moving a sticky still makes none.
  assert.deepEqual(await get('checkpoints/now/diff'), { added: [], changed: [], removed: [], moved: 0 })
  store.apply(state, [{ ...state.elements.get('b'), x: 900, version: 2, versionNonce: 5 }])
  const moved = await get('checkpoints/now/diff')
  assert.deepEqual([moved.added.length, moved.changed.length, moved.removed.length, moved.moved], [0, 0, 0, 1])

  store.apply(state, [{ ...state.elements.get('a-t'), text: 'Write personally', originalText: 'Write personally', version: 2, versionNonce: 5 }, ...sticky('c', 400, 0, 'Pitch')])
  const second = await post('checkpoints', { title: 'Midweek' })
  assert.deepEqual([second.body.checkpoint.summary.added, second.body.checkpoint.summary.changed, second.body.checkpoint.summary.moved], [1, 1, 1])
  const changes = await get(`checkpoints/${second.body.checkpoint.id}/diff`)
  assert.equal(changes.changed[0].before.text, 'Launch the newsletter')

  // The first checkpoint's scene is the board as it was.
  const was = await get(`checkpoints/${first.body.checkpoint.id}/scene`)
  assert.equal(was.elements.find((e) => e.id === 'a-t').text, 'Launch the newsletter')
  assert.equal(was.elements.some((e) => e.id === 'c'), false)

  // Another process reads the checkpoints from storage.
  const again = createStore({ storage: createBoardStorage({ objects: fsObjects({ dir: t.dir }) }), flushDelayMs: 50, baseUrl: PUBLIC_URL, log: () => {} })
  const reloaded = await again.get(created.slug)
  assert.deepEqual((await again.checkpoints(reloaded)).map((c) => c.title), ['Week of October 5', 'Midweek'])

  assert.equal((await fetch(url('checkpoints/abcdef12/diff'))).status, 404)
  assert.equal((await fetch(url('checkpoints/abcdef12/scene'))).status, 404)
  assert.equal((await fetch(`${base}/b/${created.slug}/checkpoints?k=AAAAAAAAAAAAAAAAAAAAAA`)).status, 404)
})

test('close week: done work leaves the board and stays in the checkpoint, failed work is "in progress" again', async () => {
  const created = await createBoard('Week')
  const state = await store.get(created.slug)
  store.apply(state, [...sticky('a', 0, 0, 'done', OUTCOME_FILL.done), ...sticky('b', 200, 0, 'failed', OUTCOME_FILL.failed), ...sticky('c', 400, 0, 'in progress')])
  const response = await fetch(`${base}/b/${created.slug}/checkpoints?k=${created.key}`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Week to October 11', closeWeek: true, author: 'Ada' }) })
  assert.equal(response.status, 201)
  const { checkpoint } = await response.json()
  assert.deepEqual(checkpoint.week, { done: 1, failed: 1, open: 1 })
  const live = store.elements(state)
  assert.deepEqual(live.filter((e) => e.type === 'rectangle').map((e) => e.id).sort(), ['b', 'c'])
  assert.equal(live.find((e) => e.id === 'b').backgroundColor, '#ffe299')
  const was = await store.checkpointScene(state, checkpoint.id)
  assert.equal(was.elements.find((e) => e.id === 'a').backgroundColor, OUTCOME_FILL.done)
})

test('a copy from a checkpoint is a new board; a viewer cannot create checkpoints; the "as it was" page is read-only', async () => {
  const created = await createBoard('Original')
  const state = await store.get(created.slug)
  store.apply(state, sticky('a', 0, 0, 'it was like this'))
  const k = `?k=${created.key}`
  const made = await (await fetch(`${base}/b/${created.slug}/checkpoints${k}`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'First' }) })).json()
  store.apply(state, [{ ...state.elements.get('a-t'), text: 'now it is different', originalText: 'now it is different', version: 2, versionNonce: 9 }])

  assert.equal((await fetch(`${base}/b/${created.slug}/checkpoints${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Not mine' }) })).status, 403)
  assert.equal((await fetch(`${base}/b/${created.slug}/checkpoints/${made.checkpoint.id}/copy${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)

  const copyResponse = await fetch(`${base}/b/${created.slug}/checkpoints/${made.checkpoint.id}/copy${k}`, { method: 'POST', headers: auth, body: '{}' })
  assert.equal(copyResponse.status, 201)
  const copy = await copyResponse.json()
  assert.notEqual(copy.slug, created.slug)
  assert.notEqual(copy.key, created.key)
  assert.match(copy.slug, /^original-first-/)
  const copied = await store.get(copy.slug)
  assert.equal(copied.meta.title, 'Original — First')
  assert.equal(store.elements(copied).find((e) => e.id === 'a-t').text, 'it was like this')
  assert.equal(store.elements(state).find((e) => e.id === 'a-t').text, 'now it is different')

  const html = await (await fetch(`${base}/b/${created.slug}${k}&at=${made.checkpoint.id}`, { headers: { accept: 'text/html', cookie: t.cookie() } })).text()
  const config = JSON.parse(/<script type="application\/json" id="board-config">(.*?)<\/script>/s.exec(html)[1])
  assert.deepEqual([config.at.title, config.canEdit, config.canManage, config.live, config.canCopy, config.workboard], ['First', false, false, false, true, true])
  // The page preloads the checkpoint's scene, not the live one.
  assert.ok(html.includes(`/b/${created.slug}/checkpoints/${made.checkpoint.id}/scene?k=${created.key}`))
})

test('shared timer: start, pause, resume, add and stop; polling clients get the state too', async () => {
  const created = await createBoard('Brainstorm')
  const url = `${base}/b/${created.slug}/timer?k=${created.key}`
  const act = (body, headers = auth) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))

  assert.equal((await act({ do: 'pause' })).status, 400)
  const started = await act({ do: 'start', minutes: 5, author: 'Grace' })
  assert.equal(started.body.timer.durationMs, 300_000)
  assert.ok(Math.abs(started.body.timer.endsAt - started.body.now - 300_000) < 50)
  assert.equal(started.body.timer.by, 'Grace')

  const paused = await act({ do: 'pause' })
  assert.equal(paused.body.timer.endsAt, null)
  assert.ok(paused.body.timer.leftMs > 299_000 && paused.body.timer.leftMs <= 300_000)
  const more = await act({ do: 'add', minutes: 1 })
  assert.ok(more.body.timer.leftMs > 359_000)
  const resumed = await act({ do: 'resume' })
  assert.ok(resumed.body.timer.endsAt - resumed.body.now > 359_000)

  // A polling client gets the timer and the server clock in the /sync answer.
  const sync = await (await fetch(`${base}/b/${created.slug}/sync?k=${created.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since: 0, epoch: '', elements: [], files: [], client: 'probe1' }) })).json()
  assert.equal(sync.timer.endsAt, resumed.body.timer.endsAt)
  assert.ok(Math.abs(sync.now - Date.now()) < 2_000)

  // Without edit rights the timer cannot be controlled.
  assert.equal((await act({ do: 'stop' }, { 'content-type': 'application/json' })).status, 403)
  assert.equal((await act({ do: 'stop' })).body.timer, null)
  assert.equal((await act({ do: 'no such action' })).status, 400)
})

test('checkpoints follow BOARDS_DISABLE_FEATURES: with workboard off the page has no checkpoint mode', async () => {
  const off = await startApp({ config: { features: { workboard: false } } })
  try {
    const { body } = await off.createBoard({ title: 'No workboard' })
    const state = await off.store.get(body.slug)
    off.store.apply(state, sticky('a', 0, 0, 'x'))
    const made = await (await fetch(`${off.base}/b/${body.slug}/checkpoints?k=${body.key}`, { method: 'POST', headers: off.agent, body: JSON.stringify({ title: 'First' }) })).json()
    const html = await (await fetch(`${off.base}/b/${body.slug}?k=${body.key}&at=${made.checkpoint.id}`, { headers: { cookie: off.cookie() } })).text()
    const config = JSON.parse(/<script type="application\/json" id="board-config">(.*?)<\/script>/s.exec(html)[1])
    assert.deepEqual([config.workboard, config.at, config.canEdit, config.live], [false, null, true, true])
  } finally {
    await off.close()
  }
})
