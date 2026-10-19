/** `boards migrate --from-git`: every commit of a board's scene becomes a snapshot, the tip becomes the live board. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createBoardStorage } from '../server/storage/boards.mjs'
import { fsObjects } from '../server/storage/objects.mjs'
import { s3Objects } from '../server/storage/s3.mjs'
import { migrateFromGit } from '../server/migrate.mjs'
import { createStore } from '../server/store.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/boards.mjs', import.meta.url))
let tmp
let repo

const scene = (labels) => `${JSON.stringify({ type: 'excalidraw', version: 2, elements: labels.map((l, i) => ({ id: l, type: 'rectangle', x: i * 200, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, index: `a${i}`, isDeleted: false })), appState: {}, files: {} }, null, 1)}\n`

async function commit(message, date) {
  await run('git', ['-C', repo, 'add', '-A'])
  await run('git', ['-C', repo, '-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.com', 'commit', '-q', '-m', message], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } })
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'boards-migrate-'))
  repo = join(tmp, 'repo')
  const board = join(repo, 'boards', 'architecture-abc123def456')
  await mkdir(join(board, 'checkpoints'), { recursive: true })
  await run('git', ['init', '-q', '-b', 'main', repo])
  await writeFile(join(board, 'meta.yaml'), 'title: "Architecture"\nkey: "fixture-key-a"\naccess: "team"\n')
  await writeFile(join(board, 'scene.excalidraw'), scene(['api']))
  await writeFile(join(board, 'board.md'), '# Architecture\n')
  await commit('create board', '2025-03-01T10:00:00Z')
  await writeFile(join(board, 'scene.excalidraw'), scene(['api', 'db']))
  await writeFile(join(board, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await commit('save', '2025-03-02T10:00:00Z')
  await writeFile(join(board, 'scene.excalidraw'), scene(['api', 'db', 'queue']))
  await writeFile(join(board, 'checkpoints.json'), '[{"id":"abcdef12","title":"v1"}]\n')
  await writeFile(join(board, 'checkpoints', 'abcdef12.excalidraw'), scene(['api', 'db']))
  await commit('save', '2025-03-03T10:00:00Z')
  // A second board and an unrelated file.
  const other = join(repo, 'boards', 'retro-zzz999yyy888')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'meta.yaml'), 'title: "Retro"\nkey: "fixture-key-b"\n')
  await writeFile(join(other, 'scene.excalidraw'), scene(['went-well']))
  await writeFile(join(repo, 'README.md'), 'artifacts\n')
  await commit('retro', '2025-04-01T10:00:00Z')
})

after(() => rm(tmp, { recursive: true, force: true }))

test('migrates history and the current files into board storage', async () => {
  const target = createBoardStorage({ objects: fsObjects({ dir: join(tmp, 'out-lib') }), snapshots: 'objects', snapshotKeep: Infinity })
  const report = await migrateFromGit({ repo, target })
  assert.deepEqual(report, { boards: 2, skipped: 0, snapshots: 4, files: 8, failed: [] })
  const history = await target.listSnapshots('architecture-abc123def456')
  assert.equal(history.length, 3)
  assert.deepEqual(history.map((s) => s.at), ['2025-03-03T10:00:00.000Z', '2025-03-02T10:00:00.000Z', '2025-03-01T10:00:00.000Z'])
  assert.equal(history[0].by, 'Ada Lovelace')
  assert.match(history[0].commit, /^[0-9a-f]{12}$/)
  const first = await target.readSnapshot('architecture-abc123def456', history.at(-1).id)
  assert.deepEqual(first.elements.map((e) => e.id), ['api'])
  // The live board is the tip of the branch, checkpoints included, and the server can open it.
  const store = createStore({ storage: target, log: () => {} })
  const state = await store.get('architecture-abc123def456')
  assert.equal(state.meta.title, 'Architecture')
  assert.deepEqual(store.elements(state).map((e) => e.id), ['api', 'db', 'queue'])
  assert.equal(state.preview, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  assert.equal((await store.checkpoints(state))[0].title, 'v1')
  assert.ok(await store.checkpointScene(state, 'abcdef12'))
  // Re-running skips boards that exist.
  const again = await migrateFromGit({ repo, target })
  assert.equal(again.skipped, 2)
  assert.equal(again.boards, 0)
})

test('CLI: migrate to a local directory, then to S3', async () => {
  const out = join(tmp, 'out-cli')
  const { stdout } = await run(process.execPath, [CLI, 'migrate', '--from-git', repo, '--to', out])
  assert.equal(JSON.parse(stdout).boards, 2)
  const manifest = JSON.parse(await readFile(join(out, 'boards', 'architecture-abc123def456', 'snapshots', 'index.json'), 'utf8'))
  assert.equal(manifest.snapshots.length, 3)

  const fake = await startFakeS3()
  try {
    const env = { ...process.env, BOARDS_S3_ACCESS_KEY_ID: 'x', BOARDS_S3_SECRET_ACCESS_KEY: 'y' }
    const dry = await run(process.execPath, [CLI, 'migrate', '--from-git', repo, '--to', 's3://boards/prod', '--endpoint', fake.endpoint, '--path-style', '--dry-run'], { env })
    assert.equal(JSON.parse(dry.stdout).boards, 2)
    const real = await run(process.execPath, [CLI, 'migrate', '--from-git', repo, '--to', 's3://boards/prod', '--endpoint', fake.endpoint, '--path-style', '--create-bucket', '--only', 'retro-zzz999yyy888'], { env })
    assert.deepEqual(JSON.parse(real.stdout), { boards: 1, skipped: 0, snapshots: 1, files: 2, failed: [] })
    const objects = s3Objects({ bucket: 'boards', endpoint: fake.endpoint, forcePathStyle: true, accessKeyId: 'x', secretAccessKey: 'y' })
    const storage = createBoardStorage({ objects, prefix: 'prod/' })
    assert.deepEqual(await storage.listSlugs(), ['retro-zzz999yyy888'])
    assert.equal((await storage.readMeta('retro-zzz999yyy888')).title, 'Retro')
  } finally {
    await fake.close()
  }
})
