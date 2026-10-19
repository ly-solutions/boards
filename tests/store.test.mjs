import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../server/store.mjs'
import { ConflictError, createBoardStorage } from '../server/storage/boards.mjs'
import { fsObjects, memoryObjects } from '../server/storage/objects.mjs'

const el = (id, version, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: 1, isDeleted: false, index: `a${id}`, ...extra })

/** Storage in which a second process wrote the board between our read and our write. */
function racingStorage() {
  const theirs = { meta: { title: 'Board', key: 'k' }, scene: { elements: [el('1', 1), el('theirs', 2)] }, version: 'v2', preview: null, notes: null, existing: new Set(['meta.yaml', 'scene.excalidraw']) }
  const writes = []
  let conflicted = false
  return {
    writes,
    async readBoard() {
      return { ...theirs, existing: new Set(theirs.existing) }
    },
    async writeBoard(slug, files, { version }) {
      if (!conflicted && version === 'v1') {
        conflicted = true
        throw new ConflictError('changed')
      }
      writes.push({ version, scene: JSON.parse(files['scene.excalidraw']) })
      return { version: 'v3' }
    },
    async listSlugs() {
      return []
    },
    async readMeta() {
      return null
    },
  }
}

test('a write conflict merges the other snapshot instead of overwriting it', async () => {
  const storage = racingStorage()
  const store = createStore({ storage, flushDelayMs: 10_000, log: () => {} })
  const state = await store.get('board-000000000000')
  state.version = 'v1'
  store.apply(state, [el('mine', 1)])
  await store.flush(state)
  const last = storage.writes.at(-1)
  assert.deepEqual(last.scene.elements.map((e) => e.id).sort(), ['1', 'mine', 'theirs'])
  // The retry is conditional on the version just read, and the store remembers the one it wrote.
  assert.equal(last.version, 'v2')
  assert.equal(state.version, 'v3')
})

test('two processes over the same folder: the second writer merges instead of losing the first one\'s edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boards-store-'))
  try {
    const open = () => createStore({ storage: createBoardStorage({ objects: fsObjects({ dir }) }), flushDelayMs: 10_000, log: () => {} })
    const a = open()
    const created = await a.create({ slug: 'shared-000000000000', meta: { title: 'Shared', key: 'k' }, elements: [el('base', 1)] })
    const b = open()
    const theirs = await b.get('shared-000000000000')
    a.apply(created, [el('from-a', 1)])
    b.apply(theirs, [el('from-b', 1)])
    await a.flush(created)
    await b.flush(theirs)
    const reader = open()
    const state = await reader.get('shared-000000000000')
    assert.deepEqual(reader.elements(state).map((e) => e.id).sort(), ['base', 'from-a', 'from-b'])
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a failed first write means the board does not exist', async () => {
  const storage = { ...racingStorage(), async writeBoard() { throw new Error('bucket unreachable') } }
  const store = createStore({ storage, log: () => {} })
  await assert.rejects(store.create({ slug: 'lost-000000000000', meta: { title: 'Lost', key: 'k' }, elements: [] }), /bucket unreachable/)
  assert.equal(store._boards.has('lost-000000000000'), false)
})

test('a client with an old epoch gets the whole scene', async () => {
  const store = createStore({ storage: racingStorage(), log: () => {} })
  const state = await store.get('board-000000000000')
  const answer = store.sync(state, { since: 999, epoch: 'old', elements: [] })
  assert.equal(answer.full, true)
  assert.equal(answer.elements.length, 2)
  const next = store.sync(state, { since: answer.rev, epoch: answer.epoch, elements: [] })
  assert.equal(next.full, false)
  assert.equal(next.elements.length, 0)
})

test('a deleted element is kept as a tombstone: a stale copy does not resurrect it', async () => {
  const store = createStore({ storage: racingStorage(), log: () => {} })
  const state = await store.get('board-000000000000')
  store.apply(state, [el('1', 5, { isDeleted: true })])
  store.apply(state, [el('1', 1)])
  assert.equal(state.elements.get('1').isDeleted, true)
})

test("a client's own edits are not echoed back to it; others' are", async () => {
  const store = createStore({ storage: racingStorage(), log: () => {} })
  const state = await store.get('board-000000000000')
  const start = store.sync(state, { since: 0, epoch: 'x', elements: [] })
  store.apply(state, [el('other', 1)])
  const answer = store.sync(state, { since: start.rev, epoch: start.epoch, elements: [el('mine', 1)] })
  assert.deepEqual(answer.elements.map((e) => e.id), ['other'])
})

test('an edit without a browser marks the preview stale; a new preview clears the mark', async () => {
  const store = createStore({ storage: racingStorage(), log: () => {} })
  const state = await store.get('board-000000000000')
  store.setPreview(state, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  assert.equal(state.previewStale, false)
  store.applyAgentEdit(state, [el('agent', 1)])
  assert.equal(state.previewStale, true)
  store.setPreview(state, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  assert.equal(state.previewStale, false)
})

test('the board text is cached until an edit and recomputed after it', async () => {
  const store = createStore({ storage: racingStorage(), log: () => {} })
  const state = await store.get('board-000000000000')
  const before = store.text(state)
  assert.equal(store.text(state), before)
  store.apply(state, [el('fresh', 1, { customData: { kind: 'sticky' } })])
  const after = store.text(state)
  assert.notEqual(after, before, 'the new shape must be in the text')
  state.meta.title = 'Renamed'
  assert.match(store.text(state), /Renamed/, 'board properties reset the cache too')
})

test('the board list includes boards still waiting for their first flush and is sorted by update time', async () => {
  const store = createStore({ storage: createBoardStorage({ objects: memoryObjects() }), flushDelayMs: 10_000, log: () => {} })
  await store.create({ slug: 'older-000000000000', meta: { title: 'Older', key: 'k1', updatedAt: '2026-01-01T00:00:00Z' } })
  const newer = await store.create({ slug: 'newer-000000000000', meta: { title: 'Newer', key: 'k2', updatedAt: '2026-01-01T00:00:00Z' } })
  store.apply(newer, [el('x', 1)])
  const list = await store.list()
  assert.deepEqual(list.map((b) => b.slug), ['newer-000000000000', 'older-000000000000'])
  assert.equal(list[0].stats.shapes, 1)
})

test('flush during an in-flight write also writes the edits made meanwhile (shutdown must not drop them)', async () => {
  const writes = []
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const storage = {
    ...racingStorage(),
    async writeBoard(slug, files) {
      writes.push(JSON.parse(files['scene.excalidraw']).elements.map((e) => e.id).sort())
      if (writes.length === 1) await gate
      return { version: `v${writes.length + 10}` }
    },
  }
  const store = createStore({ storage, flushDelayMs: 60_000, log: () => {} })
  const state = await store.get('board-000000000000')
  store.apply(state, [el('first', 1)])
  const inFlight = store.flush(state)
  store.apply(state, [el('second', 1)])
  const final = store.flushAll()
  release()
  await inFlight
  await final
  assert.ok(writes.at(-1).includes('second'), `last write: ${writes.at(-1)}`)
  assert.equal(state.dirty, false)
})
