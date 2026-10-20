/**
 * Storage drivers. The same contract suite runs against:
 *   - memory   (in-process)
 *   - fs       (temporary directory)
 *   - s3       (MinIO in Docker when available, otherwise the in-process fake in tests/helpers/fake-s3.mjs —
 *               the test names say which one ran)
 * plus fake-only tests for S3-compatible stores that ignore or reject conditional writes, or check them correctly only
 * one request at a time.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3'
import { ConflictError, fsObjects, memoryObjects } from '../server/storage/objects.mjs'
import { createBoardStorage, SNAPSHOT_ID } from '../server/storage/boards.mjs'
import { parseS3Url, s3Objects } from '../server/storage/s3.mjs'
import { createStore } from '../server/store.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'
import { startMinio } from './helpers/minio.mjs'

const scene = (elements = []) => `${JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files: {} })}\n`
const rect = (id, version = 1, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version, versionNonce: version, index: `a${id}`, isDeleted: false, ...extra })

let backend // { kind, endpoint, accessKey, secretKey, stop }
let tmp
let bucketSeq = 0

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'boards-storage-'))
  backend = await startMinio()
  if (!backend) {
    const fake = await startFakeS3()
    backend = { kind: 'fake', endpoint: fake.endpoint, accessKey: 'test', secretKey: 'test', stop: fake.close }
  }
})

after(async () => {
  await backend?.stop()
  await rm(tmp, { recursive: true, force: true })
})

const s3For = (overrides = {}) =>
  s3Objects({ bucket: `boards-test-${process.pid}-${++bucketSeq}`, endpoint: backend.endpoint, region: 'us-east-1', forcePathStyle: true, accessKeyId: backend.accessKey, secretAccessKey: backend.secretKey, createBucket: true, ...overrides })

const DRIVERS = {
  memory: async () => memoryObjects(),
  fs: async () => fsObjects({ dir: await mkdtemp(join(tmp, 'fs-')) }),
  s3: async () => {
    const objects = s3For()
    await objects.ensureBucket()
    return objects
  },
}

for (const [name, make] of Object.entries(DRIVERS)) {
  describe(`objects contract: ${name}`, () => {
    test('get/put/delete round-trip', async (t) => {
      if (name === 's3') t.diagnostic(`s3 backend: ${backend.kind === 'minio' ? 'MinIO in Docker' : 'in-process fake (Docker unavailable)'}`)
      const o = await make()
      assert.equal(await o.get('a/missing.txt'), null)
      const { etag } = await o.put('a/one.txt', 'hello', { contentType: 'text/plain' })
      const hit = await o.get('a/one.txt')
      assert.equal(hit.body.toString(), 'hello')
      assert.equal(hit.etag, etag)
      await o.delete('a/one.txt')
      assert.equal(await o.get('a/one.txt'), null)
    })

    test('If-None-Match: * refuses to overwrite', async () => {
      const o = await make()
      await o.put('k', 'v1', { ifNoneMatch: '*' })
      await assert.rejects(o.put('k', 'v2', { ifNoneMatch: '*' }), ConflictError)
      assert.equal((await o.get('k')).body.toString(), 'v1')
    })

    test('If-Match accepts the current ETag and refuses a stale one', async () => {
      const o = await make()
      const first = await o.put('k', 'v1')
      const second = await o.put('k', 'v2', { ifMatch: first.etag })
      await assert.rejects(o.put('k', 'v3', { ifMatch: first.etag }), ConflictError)
      await o.put('k', 'v3', { ifMatch: second.etag })
      assert.equal((await o.get('k')).body.toString(), 'v3')
    })

    test('overlapping If-None-Match creates and If-Match replaces of one key: exactly one of each wins', async () => {
      const o = await make()
      const outcomes = async (writes) => (await Promise.allSettled(writes)).map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason instanceof ConflictError ? 'conflict' : String(r.reason)))
      const created = await outcomes(Array.from({ length: 8 }, (_, i) => o.put('race', `c${i}`, { ifNoneMatch: '*' })))
      assert.deepEqual(created.toSorted(), ['conflict', 'conflict', 'conflict', 'conflict', 'conflict', 'conflict', 'conflict', 'ok'])
      const { etag } = await o.get('race')
      const replaced = await outcomes(Array.from({ length: 8 }, (_, i) => o.put('race', `r${i}`, { ifMatch: etag })))
      assert.equal(replaced.filter((x) => x === 'ok').length, 1, replaced.join(','))
    })

    test('list with prefix and delimiter', async () => {
      const o = await make()
      for (const key of ['boards/a/scene.excalidraw', 'boards/a/meta.yaml', 'boards/b/meta.yaml', 'boards/b/snapshots/1.excalidraw', 'other/x']) await o.put(key, 'x')
      const top = await o.list('boards/', { delimiter: '/' })
      assert.deepEqual(top.prefixes.sort(), ['boards/a/', 'boards/b/'])
      assert.deepEqual(top.keys, [])
      const deep = await o.list('boards/b/')
      assert.deepEqual(deep.keys.map((k) => k.key).sort(), ['boards/b/meta.yaml', 'boards/b/snapshots/1.excalidraw'])
      const shallow = await o.list('boards/b/', { delimiter: '/' })
      assert.deepEqual(shallow.keys.map((k) => k.key), ['boards/b/meta.yaml'])
      assert.deepEqual(shallow.prefixes, ['boards/b/snapshots/'])
    })
  })

  describe(`board storage: ${name}`, () => {
    test('a board is a folder of portable files and the scene version is its ETag', async () => {
      const objects = await make()
      const storage = createBoardStorage({ objects, prefix: 'team-a', snapshots: 'objects', snapshotIntervalMs: 0 })
      const existing = new Set()
      const { version } = await storage.writeBoard('demo-board-123', { 'scene.excalidraw': scene([rect('r1')]), 'meta.yaml': 'title: "Demo"\nkey: "k"\n', 'board.md': '# Demo\n' }, { existing })
      assert.ok(version)
      assert.deepEqual(await storage.listSlugs(), ['demo-board-123'])
      const loaded = await storage.readBoard('demo-board-123')
      assert.equal(loaded.meta.title, 'Demo')
      assert.equal(loaded.version, version)
      assert.equal(loaded.scene.elements[0].id, 'r1')
      for (const file of ['scene.excalidraw', 'meta.yaml', 'board.md']) assert.ok(await objects.get(`team-a/boards/demo-board-123/${file}`), file)
    })

    test('a stale writer gets ConflictError and nothing else is written', async () => {
      const objects = await make()
      const storage = createBoardStorage({ objects, snapshots: 'off' })
      const a = await storage.writeBoard('race-board-1', { 'scene.excalidraw': scene([rect('r1')]), 'meta.yaml': 'title: "A"\n' }, { existing: new Set() })
      await storage.writeBoard('race-board-1', { 'scene.excalidraw': scene([rect('r1', 2)]) }, { existing: new Set(['scene.excalidraw']), version: a.version })
      await assert.rejects(storage.writeBoard('race-board-1', { 'scene.excalidraw': scene([rect('r1', 3)]), 'meta.yaml': 'title: "stale"\n' }, { existing: new Set(['scene.excalidraw']), version: a.version }), ConflictError)
      assert.equal((await storage.readMeta('race-board-1')).title, 'A')
      // Creating a board whose slug already exists is a conflict too.
      await assert.rejects(storage.writeBoard('race-board-1', { 'scene.excalidraw': scene() }, { existing: new Set() }), ConflictError)
    })

    test('snapshots: interval, manifest, read back, pruning', async () => {
      const objects = await make()
      let clock = Date.parse('2026-01-01T00:00:00Z')
      const storage = createBoardStorage({ objects, snapshots: 'objects', snapshotIntervalMs: 60_000, snapshotKeep: 3, now: () => clock })
      let version = null
      const existing = new Set()
      for (let i = 1; i <= 6; i += 1) {
        ;({ version } = await storage.writeBoard('snap-board-1', { 'scene.excalidraw': scene([rect('r1', i)]), 'meta.yaml': 'title: "S"\n' }, { existing, version }))
        clock += 30_000 // two writes per interval → one snapshot per minute
      }
      const list = await storage.listSnapshots('snap-board-1')
      assert.equal(list.length, 3, 'pruned to snapshotKeep')
      for (const s of list) assert.match(s.id, SNAPSHOT_ID)
      assert.ok(list[0].at > list[1].at, 'newest first')
      const newest = await storage.readSnapshot('snap-board-1', list[0].id)
      assert.equal(newest.elements[0].version, 5)
      const manifest = JSON.parse((await objects.get('boards/snap-board-1/snapshots/index.json')).body.toString())
      assert.equal(manifest.snapshots.length, 3)
      assert.equal(await storage.readSnapshot('snap-board-1', '../meta'), null)
    })

    test('importSnapshots is idempotent per commit', async () => {
      const objects = await make()
      const storage = createBoardStorage({ objects, snapshots: 'objects', snapshotKeep: Infinity })
      const items = [1, 2, 3].map((i) => ({ at: `2025-0${i}-01T10:00:00Z`, body: scene([rect('r', i)]), extra: { commit: `c${i}` } }))
      assert.equal(await storage.importSnapshots('imported-1', items), 3)
      assert.equal(await storage.importSnapshots('imported-1', items), 0)
      const list = await storage.listSnapshots('imported-1')
      assert.deepEqual(list.map((s) => s.commit), ['c3', 'c2', 'c1'])
      assert.equal(list[0].source, 'migration')
    })
  })
}

describe('bucket versioning as history', () => {
  test('memory store with versioning: auto mode lists object versions', async () => {
    const objects = memoryObjects({ versioning: true })
    const storage = createBoardStorage({ objects, snapshots: 'auto' })
    let version = null
    const existing = new Set()
    for (let i = 1; i <= 3; i += 1) ({ version } = await storage.writeBoard('ver-board-1', { 'scene.excalidraw': scene([rect('r', i)]), 'meta.yaml': 'title: "V"\n' }, { existing, version }))
    const list = await storage.listSnapshots('ver-board-1')
    assert.equal(list.length, 3)
    assert.ok(list.every((s) => s.id.startsWith('v-') && s.source === 'version'))
    // No snapshot objects were written: the bucket keeps the history.
    assert.deepEqual((await objects.list('boards/ver-board-1/snapshots/')).keys, [])
    const oldest = await storage.readSnapshot('ver-board-1', list.at(-1).id)
    assert.equal(oldest.elements[0].version, 1)
  })

  test('s3 bucket with versioning enabled', async (t) => {
    t.diagnostic(`backend: ${backend.kind}`)
    const objects = s3For()
    await objects.ensureBucket()
    const client = new S3Client({ region: 'us-east-1', endpoint: backend.endpoint, forcePathStyle: true, credentials: { accessKeyId: backend.accessKey, secretAccessKey: backend.secretKey } })
    await client.send(new PutBucketVersioningCommand({ Bucket: objects.bucket, VersioningConfiguration: { Status: 'Enabled' } }))
    assert.equal(await objects.versioningEnabled(), true)
    const storage = createBoardStorage({ objects, snapshots: 'auto' })
    let version = null
    const existing = new Set()
    for (let i = 1; i <= 3; i += 1) ({ version } = await storage.writeBoard('s3ver-board-1', { 'scene.excalidraw': scene([rect('r', i)]), 'meta.yaml': 'title: "V"\n' }, { existing, version }))
    const list = await storage.listSnapshots('s3ver-board-1')
    assert.equal(list.length, 3)
    const oldest = await storage.readSnapshot('s3ver-board-1', list.at(-1).id)
    assert.equal(oldest.elements[0].version, 1)
  })
})

describe('S3 stores with partial conditional-write support (fake)', () => {
  for (const conditionals of ['ignore', 'reject']) {
    test(`store that ${conditionals}s If-Match: probe falls back to compare-then-write, conflicts still detected`, async () => {
      const fake = await startFakeS3({ conditionals })
      try {
        const objects = s3Objects({ bucket: 'b', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y', createBucket: true })
        await objects.ensureBucket()
        const first = await objects.put('k', 'v1', { ifNoneMatch: '*' })
        assert.equal(objects.conditionalMode, 'emulated')
        await assert.rejects(objects.put('k', 'v2', { ifNoneMatch: '*' }), ConflictError)
        const second = await objects.put('k', 'v2', { ifMatch: first.etag })
        await assert.rejects(objects.put('k', 'v3', { ifMatch: first.etag }), ConflictError)
        assert.ok(second.etag)
      } finally {
        await fake.close()
      }
    })
  }

  test('native store: probe picks native conditional writes; list paginates', async () => {
    const fake = await startFakeS3({ pageSize: 2 })
    try {
      const objects = s3Objects({ bucket: 'b', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y', createBucket: true })
      await objects.ensureBucket()
      await objects.put('k', 'v1', { ifNoneMatch: '*' })
      assert.equal(objects.conditionalMode, 'native')
      for (let i = 0; i < 5; i += 1) await objects.put(`p/${i}`, 'x')
      assert.equal((await objects.list('p/')).keys.length, 5)
    } finally {
      await fake.close()
    }
  })

  test('parseS3Url', () => {
    assert.deepEqual(parseS3Url('s3://my-bucket'), { bucket: 'my-bucket', prefix: '' })
    assert.deepEqual(parseS3Url('s3://my-bucket/team/boards'), { bucket: 'my-bucket', prefix: 'team/boards/' })
    assert.throws(() => parseS3Url('https://x'))
  })
})

describe('S3 store whose preconditions are not atomic under concurrency (fake)', () => {
  const racy = async (overrides = {}) => {
    const fake = await startFakeS3({ conditionals: 'racy' })
    const events = []
    const objects = s3Objects({ bucket: 'b', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y', createBucket: true, log: (e) => events.push(e), ...overrides })
    await objects.ensureBucket()
    return { fake, objects, events }
  }

  test('auto: the concurrent probe sees it and falls back to compare-then-write, logging the counts', async () => {
    const { fake, objects, events } = await racy()
    try {
      await objects.put('k', 'v1', { ifNoneMatch: '*' })
      assert.equal(objects.conditionalMode, 'emulated')
      const verdict = events.find((e) => e.event === 's3_conditional_writes')
      assert.equal(verdict.level, 'warn')
      assert.match(verdict.create, /^[2-8]\/8$/)
      assert.match(verdict.note, /atomically/)
      assert.equal((await objects.list('.boards-probe/')).keys.length, 0, 'probe keys are cleaned up')
    } finally {
      await fake.close()
    }
  })

  test('a store that is atomic passes the probe with exactly one winner per phase', async () => {
    const fake = await startFakeS3()
    const events = []
    try {
      const objects = s3Objects({ bucket: 'b', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y', createBucket: true, log: (e) => events.push(e) })
      await objects.ensureBucket()
      await objects.put('k', 'v1', { ifNoneMatch: '*' })
      const verdict = events.find((e) => e.event === 's3_conditional_writes')
      assert.deepEqual({ mode: verdict.mode, create: verdict.create, replace: verdict.replace }, { mode: 'native', create: '1/8', replace: '1/8' })
    } finally {
      await fake.close()
    }
  })

  for (const conditionalWrites of ['on', 'auto']) {
    test(`conditionalWrites=${conditionalWrites}: one process never lets two overlapping writes of a key through`, async () => {
      const { fake, objects } = await racy({ conditionalWrites })
      try {
        const settle = async (writes) => (await Promise.allSettled(writes)).filter((r) => r.status === 'fulfilled').length
        assert.equal(await settle(Array.from({ length: 8 }, (_, i) => objects.put('k', `c${i}`, { ifNoneMatch: '*' }))), 1)
        const { etag } = await objects.get('k')
        assert.equal(await settle(Array.from({ length: 8 }, (_, i) => objects.put('k', `r${i}`, { ifMatch: etag }))), 1)
      } finally {
        await fake.close()
      }
    })
  }

  test('concurrent edits, flushes, checkpoints and snapshots of one board lose nothing', async () => {
    const { fake, objects } = await racy({ conditionalWrites: 'on' })
    try {
      const storage = createBoardStorage({ objects, snapshots: 'objects', snapshotIntervalMs: 0 })
      const store = createStore({ storage, flushDelayMs: 10_000, log: () => {} })
      const slug = 'racy-board-1'
      const board = await store.create({ slug, meta: { title: 'Racy', key: 'k' }, elements: [rect('base')] })
      const N = 8
      await Promise.all([
        ...Array.from({ length: N }, async (_, i) => {
          store.apply(board, [rect(`edit-${i}`)])
          await store.flush(board)
        }),
        ...Array.from({ length: N }, (_, i) => store.addCheckpoint(board, { title: `cp ${i}` })),
        ...Array.from({ length: N }, (_, i) => storage.addSnapshot(slug, scene([rect(`snap-${i}`)]), { source: 'restore', extra: { n: i } })),
      ])
      await store.flushAll()

      const fresh = createBoardStorage({ objects: s3Objects({ bucket: 'b', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y' }), snapshots: 'objects' })
      const loaded = await fresh.readBoard(slug)
      const ids = loaded.scene.elements.map((e) => e.id)
      for (let i = 0; i < N; i += 1) assert.ok(ids.includes(`edit-${i}`), `edit-${i} is in the stored scene`)
      const checkpoints = JSON.parse(await fresh.readFile(slug, 'checkpoints.json'))
      assert.equal(checkpoints.length, N)
      const restored = (await fresh.listSnapshots(slug)).filter((s) => s.source === 'restore')
      assert.equal(restored.length, N)
    } finally {
      await fake.close()
    }
  })
})

describe('store over S3: two writers merge instead of overwriting', () => {
  test('a second process writing the same board merges element-wise', async () => {
    const objects = s3For()
    await objects.ensureBucket()
    const storageA = createBoardStorage({ objects, snapshots: 'off' })
    const storageB = createBoardStorage({ objects, snapshots: 'off' })
    const a = createStore({ storage: storageA, flushDelayMs: 10_000, log: () => {} })
    const b = createStore({ storage: storageB, flushDelayMs: 10_000, log: () => {} })
    const created = await a.create({ slug: 'two-writers-1', meta: { title: 'T', key: 'k' }, elements: [rect('base')] })
    const other = await b.get('two-writers-1')
    a.apply(created, [rect('from-a')])
    b.apply(other, [rect('from-b')])
    await a.flush(created)
    await b.flush(other) // conflicts on the ETag, re-reads, merges, writes
    const final = JSON.parse((await objects.get('boards/two-writers-1/scene.excalidraw')).body.toString())
    assert.deepEqual(final.elements.map((e) => e.id).sort(), ['base', 'from-a', 'from-b'])
  })
})

describe('fs layout', () => {
  test('keys map to plain files and cannot escape the data directory', async () => {
    const dir = await mkdtemp(join(tmp, 'layout-'))
    const objects = fsObjects({ dir })
    await objects.put('boards/x/meta.yaml', 'title: "x"\n')
    assert.equal(await readFile(join(dir, 'boards', 'x', 'meta.yaml'), 'utf8'), 'title: "x"\n')
    await assert.rejects(objects.put('../escape', 'x'), /escapes/)
  })
})
