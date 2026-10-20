/**
 * Board storage on top of an object store (see objects.mjs).
 *
 * Every board is a folder of plain files, identical on every driver, so boards stay portable — copy the folder
 * to another bucket or open `scene.excalidraw` in excalidraw.com or the VS Code extension:
 *
 *   <prefix>boards/<slug>/scene.excalidraw              the scene in Excalidraw's native format
 *   <prefix>boards/<slug>/meta.yaml                     title, author, access key, tags, counters
 *   <prefix>boards/<slug>/board.md                      the board as text (what agents read), for search/grep
 *   <prefix>boards/<slug>/preview.svg                   thumbnail rendered by a browser
 *   <prefix>boards/<slug>/notes.json                    reactions and comment threads (a layer over the scene)
 *   <prefix>boards/<slug>/checkpoints.json              named checkpoints, plus checkpoints/<id>.excalidraw
 *   <prefix>boards/<slug>/snapshots/<ts>.excalidraw     automatic history (immutable objects)
 *   <prefix>boards/<slug>/snapshots/index.json          snapshot manifest
 *
 * History. Live state is kept in memory (store.mjs) and written here a few seconds after the last edit. On top of
 * that the scene's history is kept in one of two ways:
 *
 * - `bucket`: the bucket has versioning enabled, so every write of scene.excalidraw is already a version;
 * - `objects`: at most once per `snapshotIntervalMs` the scene is also written as an immutable snapshot object
 *   and listed in the manifest; the oldest are pruned beyond `snapshotKeep`.
 *
 * `auto` picks `bucket` when the store reports versioning as enabled, otherwise `objects`. Snapshots imported by
 * `boards migrate --from-git` are always snapshot objects, so both kinds are listed together.
 *
 * Concurrency. The scene is written with `If-Match: <etag we read>` (or `If-None-Match: *` for a new board). A
 * conflict means someone else wrote the board (another process, or a person by hand); the store then re-reads,
 * merges element by element and writes again, so neither side loses edits. Inside one process the snapshot
 * manifest, a read-modify-write of one object, is updated under a per-board lock, and the store (store.mjs)
 * serialises scene flushes and checkpoints per board.
 */
import { parse as parseYaml } from 'yaml'
import { ConflictError, keyedLock } from './objects.mjs'

export { ConflictError }

export const BOARD_FILES = ['scene.excalidraw', 'meta.yaml', 'board.md', 'preview.svg', 'notes.json']

const CONTENT_TYPES = {
  '.excalidraw': 'application/json',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
}
const contentType = (name) => CONTENT_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream'

/** Snapshot ids: `20261019T192301123Z`, optionally `-2` on a collision; bucket versions: `v-<versionId>`. */
export const SNAPSHOT_ID = /^(\d{8}T\d{9}Z(?:-\d{1,4})?|v-[A-Za-z0-9._~+=-]{1,200})$/

export const snapshotIdAt = (date) => new Date(date).toISOString().replace(/[-:.]/g, '')

function parseMeta(raw) {
  try {
    return parseYaml(raw) ?? {}
  } catch {
    return {}
  }
}

const parseJson = (raw, fallback = null) => {
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

const yamlString = (value) => JSON.stringify(String(value ?? ''))

export function buildMeta(meta) {
  const lines = []
  for (const key of ['title', 'description', 'author', 'access', 'key', 'task', 'createdAt', 'updatedAt']) {
    if (meta[key] === undefined || meta[key] === null || meta[key] === '') continue
    lines.push(`${key}: ${yamlString(meta[key])}`)
  }
  if (Array.isArray(meta.tags) && meta.tags.length) {
    lines.push('tags:')
    for (const tag of meta.tags) lines.push(`  - ${yamlString(tag)}`)
  }
  if (meta.fields && typeof meta.fields === 'object' && Object.keys(meta.fields).length) {
    lines.push('fields:')
    for (const [key, value] of Object.entries(meta.fields)) lines.push(`  ${JSON.stringify(key)}: ${typeof value === 'number' && Number.isFinite(value) ? value : yamlString(value)}`)
  }
  if (meta.stats) {
    lines.push('stats:')
    for (const [key, value] of Object.entries(meta.stats)) lines.push(`  ${key}: ${Number(value) || 0}`)
  }
  return `${lines.join('\n')}\n`
}

export function normalizePrefix(prefix) {
  const value = String(prefix ?? '').replace(/^\/+/, '')
  return value && !value.endsWith('/') ? `${value}/` : value
}

export function createBoardStorage({
  objects,
  prefix = '',
  snapshots = 'auto',
  snapshotIntervalMs = 10 * 60_000,
  snapshotKeep = 500,
  now = () => Date.now(),
  log = () => {},
}) {
  const root = normalizePrefix(prefix)
  const boardsRoot = `${root}boards/`
  const keyOf = (slug, name) => `${boardsRoot}${slug}/${name}`
  const manifestKey = (slug) => keyOf(slug, 'snapshots/index.json')
  const snapshotKey = (slug, id) => keyOf(slug, `snapshots/${id}.excalidraw`)
  const lastSnapshotAt = new Map()
  const withBoardLock = keyedLock()
  let resolvedMode = snapshots === 'auto' ? null : snapshots

  const text = async (key) => {
    const hit = await objects.get(key)
    return hit ? hit.body.toString('utf8') : null
  }

  async function mode() {
    if (resolvedMode) return resolvedMode
    resolvedMode = (await objects.versioningEnabled?.()) ? 'bucket' : 'objects'
    log({ event: 'snapshot_mode', mode: resolvedMode })
    return resolvedMode
  }

  async function readManifest(slug) {
    const parsed = parseJson(await text(manifestKey(slug)), null)
    if (parsed && Array.isArray(parsed.snapshots)) return parsed.snapshots
    // No or unreadable manifest: rebuild it from the snapshot objects themselves.
    const { keys } = await objects.list(keyOf(slug, 'snapshots/'))
    return keys
      .map((k) => k.key.slice(keyOf(slug, 'snapshots/').length))
      .filter((name) => name.endsWith('.excalidraw') && SNAPSHOT_ID.test(name.replace(/\.excalidraw$/, '')))
      .map((name) => {
        const id = name.replace(/\.excalidraw$/, '')
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id)
        return { id, at: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : null, source: 'auto' }
      })
  }

  async function writeManifest(slug, list) {
    await objects.put(manifestKey(slug), `${JSON.stringify({ version: 1, snapshots: list }, null, 1)}\n`, { contentType: 'application/json' })
  }

  /** Store one immutable snapshot of the scene and list it in the manifest. */
  function addSnapshot(slug, body, options = {}) {
    return withBoardLock(slug, () => addSnapshotLocked(slug, body, options))
  }

  async function addSnapshotLocked(slug, body, { at = new Date(now()).toISOString(), source = 'auto', extra = {} } = {}) {
    const list = await readManifest(slug)
    let id = snapshotIdAt(at)
    for (let n = 2; list.some((s) => s.id === id); n += 1) id = `${snapshotIdAt(at)}-${n}`
    await objects.put(snapshotKey(slug, id), body, { contentType: 'application/json', ifNoneMatch: '*' }).catch((error) => {
      if (!(error instanceof ConflictError)) throw error
    })
    let elements = null
    try {
      elements = JSON.parse(body).elements?.filter((el) => !el.isDeleted).length ?? null
    } catch {
      elements = null
    }
    const entry = { id, at, source, bytes: Buffer.byteLength(body), elements, ...extra }
    const next = [...list, entry].sort((a, b) => String(a.at).localeCompare(String(b.at)))
    const drop = next.length > snapshotKeep ? next.splice(0, next.length - snapshotKeep) : []
    await writeManifest(slug, next)
    for (const old of drop) await objects.delete(snapshotKey(slug, old.id)).catch(() => {})
    lastSnapshotAt.set(slug, Date.parse(at) || now())
    return entry
  }

  async function maybeSnapshot(slug, body) {
    if ((await mode()) !== 'objects') return
    if (!lastSnapshotAt.has(slug)) {
      const last = (await readManifest(slug)).at(-1)
      lastSnapshotAt.set(slug, last?.at ? Date.parse(last.at) : 0)
    }
    await withBoardLock(slug, async () => {
      if (now() - lastSnapshotAt.get(slug) < snapshotIntervalMs) return
      await addSnapshotLocked(slug, body)
    })
  }

  return {
    kind: objects.kind,
    objects,
    prefix: root,

    async readMeta(slug) {
      const meta = await text(keyOf(slug, 'meta.yaml'))
      return meta === null ? null : parseMeta(meta)
    },

    async readBoard(slug) {
      const [meta, scene, preview, notes] = await Promise.all(['meta.yaml', 'scene.excalidraw', 'preview.svg', 'notes.json'].map((name) => objects.get(keyOf(slug, name))))
      if (!meta) return null
      return {
        meta: parseMeta(meta.body.toString('utf8')),
        scene: scene ? parseJson(scene.body.toString('utf8')) : null,
        version: scene?.etag ?? null,
        preview: preview ? preview.body.toString('utf8') : null,
        notes: notes ? parseJson(notes.body.toString('utf8')) : null,
        existing: new Set(['meta.yaml', ...(scene ? ['scene.excalidraw'] : []), ...(preview ? ['preview.svg'] : []), ...(notes ? ['notes.json'] : []), 'board.md']),
      }
    },

    async listSlugs() {
      const { prefixes } = await objects.list(boardsRoot, { delimiter: '/' })
      return prefixes.map((p) => p.slice(boardsRoot.length).replace(/\/$/, '')).filter(Boolean)
    },

    /**
     * Write one snapshot of a board. The scene goes first, conditionally: if it fails with ConflictError nothing
     * else was written and the caller merges and retries.
     */
    async writeBoard(slug, files, { existing = new Set(), version = null } = {}) {
      let next = version
      if (files['scene.excalidraw'] !== undefined) {
        const condition = version ? { ifMatch: version } : existing.has('scene.excalidraw') ? {} : { ifNoneMatch: '*' }
        next = (await objects.put(keyOf(slug, 'scene.excalidraw'), files['scene.excalidraw'], { contentType: contentType('scene.excalidraw'), ...condition })).etag
      }
      for (const [name, content] of Object.entries(files)) {
        if (name === 'scene.excalidraw') continue
        await objects.put(keyOf(slug, name), content, { contentType: contentType(name) })
      }
      for (const name of Object.keys(files)) existing.add(name)
      if (files['scene.excalidraw'] !== undefined) {
        await maybeSnapshot(slug, files['scene.excalidraw']).catch((error) => log({ level: 'error', event: 'snapshot_failed', slug, error: String(error?.message ?? error) }))
      }
      return { version: next }
    },

    /** Any other file of the board (checkpoints live next to the scene). */
    readFile(slug, name) {
      return text(keyOf(slug, name))
    },

    async writeFiles(slug, files) {
      for (const [name, content] of Object.entries(files)) await objects.put(keyOf(slug, name), content, { contentType: contentType(name) })
    },

    /** History, newest first: snapshot objects and (with bucket versioning) versions of scene.excalidraw. */
    async listSnapshots(slug) {
      const list = (await readManifest(slug)).map((s) => ({ id: s.id, at: s.at, source: s.source ?? 'auto', elements: s.elements ?? null, bytes: s.bytes ?? null, ...(s.commit ? { commit: s.commit } : {}), ...(s.by ? { by: s.by } : {}), ...(s.from ? { from: s.from } : {}) }))
      if ((await mode()) === 'bucket' && objects.versions) {
        for (const v of await objects.versions(keyOf(slug, 'scene.excalidraw'))) {
          list.push({ id: `v-${v.versionId}`, at: new Date(v.lastModified).toISOString(), source: 'version', elements: null, bytes: v.size ?? null })
        }
      }
      return list.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    },

    async readSnapshot(slug, id) {
      if (!SNAPSHOT_ID.test(String(id))) return null
      if (id.startsWith('v-')) {
        if (!objects.getVersion) return null
        const hit = await objects.getVersion(keyOf(slug, 'scene.excalidraw'), id.slice(2))
        return hit ? parseJson(hit.body.toString('utf8')) : null
      }
      return parseJson(await text(snapshotKey(slug, id)))
    },

    /** Used by restore: store an explicit snapshot regardless of the interval. */
    addSnapshot,

    /**
     * Bulk import (the git migration): write many snapshots, then the manifest once. `items`: [{ at, body, extra }].
     * Existing snapshots with the same id are left alone, so re-running an import is harmless.
     */
    importSnapshots(slug, items) {
      return withBoardLock(slug, () => importSnapshotsLocked(slug, items))
    },
  }

  /** Bulk import under the board lock (see importSnapshots). */
  async function importSnapshotsLocked(slug, items) {
    const list = await readManifest(slug)
    const ids = new Set(list.map((s) => s.id))
    let added = 0
    for (const item of items) {
      if (item.extra?.commit && list.some((s) => s.commit === item.extra.commit)) continue
      let id = snapshotIdAt(item.at)
      for (let n = 2; ids.has(id); n += 1) id = `${snapshotIdAt(item.at)}-${n}`
      await objects.put(snapshotKey(slug, id), item.body, { contentType: 'application/json' })
      let elements = null
      try {
        elements = JSON.parse(item.body).elements?.filter((el) => !el.isDeleted).length ?? null
      } catch {
        elements = null
      }
      list.push({ id, at: new Date(item.at).toISOString(), source: 'migration', bytes: Buffer.byteLength(item.body), elements, ...(item.extra ?? {}) })
      ids.add(id)
      added += 1
    }
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    if (added) await writeManifest(slug, list)
    if (list.length) lastSnapshotAt.set(slug, Date.parse(list.at(-1).at) || 0)
    return added
  }
}
