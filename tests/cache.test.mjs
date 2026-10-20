/**
 * Read cache (server/storage/cache.mjs) in front of the S3 driver, against the in-process fake S3, counting the
 * requests that reach the store. The cache exists for stores that answer HEAD fast but take seconds per GET.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cachedObjects, isImmutableKey, s3Objects } from '../server/storage/index.mjs'
import { ConflictError } from '../server/storage/objects.mjs'
import { createBoardStorage } from '../server/storage/boards.mjs'
import { createStore } from '../server/store.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'
import { startApp } from './helpers/app.mjs'

const rect = (id, version = 1) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version, versionNonce: version, index: `a${id}`, isDeleted: false })

async function setup({ maxBytes = 8 * 1024 * 1024 } = {}) {
  const fake = await startFakeS3()
  const driver = () => s3Objects({ bucket: 'b', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y', createBucket: true, conditionalWrites: 'on' })
  const raw = driver()
  await raw.ensureBucket()
  const cached = () => cachedObjects(driver(), { maxBytes, isImmutable: isImmutableKey })
  return { fake, raw, cached, mark: () => fake.requests.length }
}

describe('read cache', () => {
  test('immutable keys are served from memory without asking the store', async () => {
    const { fake, raw, cached, mark } = await setup()
    try {
      const key = 'boards/x/snapshots/20261019T120000000Z.excalidraw'
      await raw.put(key, '{"elements":[]}')
      const objects = cached()
      const from = mark()
      for (let i = 0; i < 3; i += 1) assert.equal((await objects.get(key)).body.toString(), '{"elements":[]}')
      assert.equal(fake.count('GET', { from }), 1)
      assert.equal(fake.count('HEAD', { from }), 0)
      // Written through the cache: read back without any request.
      const other = 'boards/x/checkpoints/abcdef12.excalidraw'
      await objects.put(other, '{"elements":[1]}', { ifNoneMatch: '*' })
      const afterWrite = mark()
      assert.equal((await objects.get(other)).body.toString(), '{"elements":[1]}')
      assert.equal(fake.requests.length, afterWrite)
    } finally {
      await fake.close()
    }
  })

  test('mutable keys are revalidated with a HEAD and re-read when another writer changed them', async () => {
    const { fake, raw, cached, mark } = await setup()
    try {
      const key = 'boards/x/scene.excalidraw'
      await raw.put(key, 'v1')
      const objects = cached()
      let from = mark()
      await objects.get(key)
      assert.equal((await objects.get(key)).body.toString(), 'v1')
      assert.deepEqual([fake.count('GET', { from }), fake.count('HEAD', { from })], [1, 1])
      await raw.put(key, 'v2') // another process
      from = mark()
      assert.equal((await objects.get(key)).body.toString(), 'v2')
      assert.deepEqual([fake.count('GET', { from }), fake.count('HEAD', { from })], [1, 1])
      await raw.delete(key)
      assert.equal(await objects.get(key), null)
      assert.equal(objects.has(key), false)
    } finally {
      await fake.close()
    }
  })

  test('a returned body is a copy: changing it does not change the cache', async () => {
    const { fake, raw, cached } = await setup()
    try {
      await raw.put('boards/x/snapshots/a.excalidraw', 'abc')
      const objects = cached()
      const first = await objects.get('boards/x/snapshots/a.excalidraw')
      first.body[0] = 0x7a
      assert.equal((await objects.get('boards/x/snapshots/a.excalidraw')).body.toString(), 'abc')
    } finally {
      await fake.close()
    }
  })

  test('writes fill the cache; a lost conditional write and a delete drop the entry', async () => {
    const { fake, raw, cached, mark } = await setup()
    try {
      const objects = cached()
      const key = 'boards/x/meta.yaml'
      const { etag } = await objects.put(key, 'title: "a"\n')
      const from = mark()
      assert.equal((await objects.get(key)).body.toString(), 'title: "a"\n')
      assert.deepEqual([fake.count('GET', { from }), fake.count('HEAD', { from })], [0, 1])
      await raw.put(key, 'title: "theirs"\n')
      await assert.rejects(objects.put(key, 'title: "mine"\n', { ifMatch: etag }), ConflictError)
      assert.equal(objects.has(key), false)
      assert.equal((await objects.get(key)).body.toString(), 'title: "theirs"\n')
      await objects.delete(key)
      assert.equal(objects.has(key), false)
    } finally {
      await fake.close()
    }
  })

  test('byte budget: least recently used objects go first, objects over an eighth of the budget are skipped', async () => {
    const { fake, cached } = await setup({ maxBytes: 800 })
    try {
      const objects = cached()
      await objects.put('boards/x/snapshots/big.excalidraw', 'x'.repeat(101))
      assert.equal(objects.has('boards/x/snapshots/big.excalidraw'), false)
      for (let i = 0; i < 9; i += 1) await objects.put(`boards/x/snapshots/${i}.excalidraw`, 'y'.repeat(100))
      assert.equal(objects.has('boards/x/snapshots/0.excalidraw'), false)
      assert.equal(objects.has('boards/x/snapshots/8.excalidraw'), true)
      assert.ok(objects.cacheStats.bytes <= 800)
      // Reading an entry makes it recent: it survives the next eviction.
      await objects.get('boards/x/snapshots/1.excalidraw')
      await objects.put('boards/x/snapshots/9.excalidraw', 'y'.repeat(100))
      assert.equal(objects.has('boards/x/snapshots/1.excalidraw'), true)
      assert.equal(objects.has('boards/x/snapshots/2.excalidraw'), false)
    } finally {
      await fake.close()
    }
  })
})

describe('opening a board', () => {
  async function seed(raw) {
    const storage = createBoardStorage({ objects: raw, snapshots: 'off' })
    const store = createStore({ storage, flushDelayMs: 60_000, log: () => {} })
    const state = await store.create({ slug: 'open-board-1', meta: { title: 'Open', key: 'k' }, elements: [rect('a'), rect('b')] })
    store.setPreview(state, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await store.flush(state)
    await storage.writeFiles('open-board-1', { 'notes.json': '{"reactions":{},"comments":[]}\n' })
  }

  test('one parallel round: three GETs and a HEAD for the thumbnail, which is read only when asked for', async () => {
    const { fake, raw, mark } = await setup()
    try {
      await seed(raw)
      const store = createStore({ storage: createBoardStorage({ objects: raw, snapshots: 'off' }), flushDelayMs: 60_000, log: () => {} })
      const from = mark()
      const state = await store.get('open-board-1')
      assert.deepEqual(store.elements(state).map((e) => e.id), ['a', 'b'])
      assert.equal(fake.count('GET', { from }), 3)
      assert.equal(fake.count('HEAD', { from }), 1)
      assert.equal(fake.count('GET', { from, match: /preview\.svg$/ }), 0)
      assert.equal(store.hasPreview(state), true)
      assert.equal(await store.previewSvg(state), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      await store.previewSvg(state)
      assert.equal(fake.count('GET', { from, match: /preview\.svg$/ }), 1)
    } finally {
      await fake.close()
    }
  })

  test('with the cache warm, opening a board after a restart of the store reads no object bodies', async () => {
    const { fake, raw, cached, mark } = await setup()
    try {
      await seed(raw)
      const objects = cached()
      const storage = createBoardStorage({ objects, snapshots: 'off' })
      const warmed = await storage.warm({ concurrency: 4 })
      assert.equal(warmed.boards, 1)
      const from = mark()
      const store = createStore({ storage, flushDelayMs: 60_000, log: () => {} })
      const state = await store.get('open-board-1')
      assert.equal(await store.previewSvg(state), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      assert.equal(fake.count('GET', { from }), 0)
      assert.equal(fake.count('HEAD', { from }), 5) // meta, scene, notes, thumbnail check, thumbnail revalidation
    } finally {
      await fake.close()
    }
  })

  test('the agent markdown of a board over the cached store: cold one round of GETs, then none', async () => {
    const { fake, raw, cached, mark } = await setup()
    try {
      await seed(raw)
      const objects = cached()
      const read = async () => {
        const t = await startApp({ storage: createBoardStorage({ objects, snapshots: 'off' }) })
        try {
          const response = await fetch(`${t.base}/b/open-board-1.md?k=k`, { headers: t.agent })
          assert.equal(response.status, 200)
          await response.text()
        } finally {
          await t.close()
        }
      }
      let from = mark()
      await read()
      assert.equal(fake.count('GET', { from }), 3)
      from = mark()
      await read()
      assert.equal(fake.count('GET', { from }), 0)
    } finally {
      await fake.close()
    }
  })
})
