/**
 * Object-store drivers: the tiny key/value surface the board storage is built on.
 *
 * Every driver implements:
 *
 *   get(key)                         -> { body: Buffer, etag, versionId? } | null
 *   head(key)                        -> { etag } | null   (cheap existence and ETag check; cache.mjs revalidates with it)
 *   put(key, body, { contentType, ifMatch, ifNoneMatch })
 *                                    -> { etag, versionId? }   (throws ConflictError on a failed precondition)
 *   delete(key)
 *   list(prefix, { delimiter })      -> { keys: [{ key, etag, size, lastModified }], prefixes: [string] }
 *
 * and optionally, when the store keeps object versions (S3 with bucket versioning):
 *
 *   versioningEnabled()              -> boolean
 *   versions(key)                    -> [{ versionId, lastModified, etag, size }] newest first
 *   getVersion(key, versionId)       -> { body, etag, versionId } | null
 *
 * `ifMatch` / `ifNoneMatch: '*'` give optimistic concurrency: the write only lands when the object is still the
 * one we read (or still absent). Inside one process every driver also serialises writes per key, so the guarantee
 * holds there even on a store whose preconditions are not atomic under concurrency. Between processes it holds
 * only as far as the store's own conditional writes do (see s3.mjs and docs/storage.md).
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export class ConflictError extends Error {
  constructor(message = 'the object changed since it was read') {
    super(message)
    this.name = 'ConflictError'
  }
}

export const etagOf = (body) => `"${createHash('md5').update(body).digest('hex')}"`

const toBuffer = (body) => (Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''))

/**
 * Serialises work per key inside one process: calls for the same key run one after another, other keys are not
 * held up. Used for check-and-write on every driver, because some S3-compatible stores check `If-Match` /
 * `If-None-Match` correctly one request at a time but not when requests for one key overlap.
 */
export function keyedLock() {
  const tails = new Map()
  return async function withLock(key, fn) {
    const previous = tails.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => (release = resolve))
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

function checkPrecondition(current, { ifMatch, ifNoneMatch } = {}) {
  if (ifNoneMatch === '*' && current) throw new ConflictError('the object already exists')
  if (ifMatch && (!current || current.etag !== ifMatch)) throw new ConflictError('the object changed since it was read')
}

/**
 * Local folder. Keys map to paths under `dir`, so a board is a plain directory you can open, diff and copy.
 * Writes are atomic (temp file + rename); preconditions are enforced per key within this process, which is
 * enough for the single-replica setups this driver is meant for (development, docker compose, a laptop).
 */
export function fsObjects({ dir }) {
  const root = resolve(dir)
  const withLock = keyedLock()
  const pathOf = (key) => {
    const path = resolve(root, ...String(key).split('/'))
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`key escapes the data directory: ${key}`)
    return path
  }

  async function get(key) {
    try {
      const body = await readFile(pathOf(key))
      return { body, etag: etagOf(body) }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null
      throw error
    }
  }

  return {
    kind: 'fs',
    root,
    get,
    async head(key) {
      const hit = await get(key)
      return hit ? { etag: hit.etag } : null
    },
    async put(key, body, options = {}) {
      const data = toBuffer(body)
      return withLock(key, async () => {
        checkPrecondition(await get(key), options)
        const path = pathOf(key)
        await mkdir(dirname(path), { recursive: true })
        const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
        await writeFile(tmp, data)
        await rename(tmp, path)
        return { etag: etagOf(data) }
      })
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
    async list(prefix = '', { delimiter } = {}) {
      const keys = []
      const prefixes = new Set()
      // Walk only the directory that can contain matches.
      const slash = prefix.lastIndexOf('/')
      const base = slash >= 0 ? prefix.slice(0, slash + 1) : ''
      async function walk(absolute) {
        let entries
        try {
          entries = await readdir(absolute, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const path = join(absolute, entry.name)
          const key = relative(root, path).split(sep).join('/')
          if (entry.isDirectory()) {
            const asPrefix = `${key}/`
            if (!asPrefix.startsWith(prefix) && !prefix.startsWith(asPrefix)) continue
            if (delimiter === '/' && asPrefix.startsWith(prefix) && asPrefix.length > prefix.length) {
              prefixes.add(asPrefix)
              continue
            }
            await walk(path)
          } else if (entry.isFile() && key.startsWith(prefix) && !key.endsWith('.tmp')) {
            const rest = key.slice(prefix.length)
            if (delimiter && rest.includes(delimiter)) {
              prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1))
              continue
            }
            const info = await stat(path)
            keys.push({ key, size: info.size, lastModified: info.mtime, etag: null })
          }
        }
      }
      await walk(base ? pathOf(base.replace(/\/$/, '')) : root)
      keys.sort((a, b) => (a.key < b.key ? -1 : 1))
      return { keys, prefixes: [...prefixes].sort() }
    },
  }
}

/** In-memory store with optional versioning — for tests and for trying the server without a disk. */
export function memoryObjects({ versioning = false } = {}) {
  const objects = new Map()
  const history = new Map()
  let counter = 0
  return {
    kind: 'memory',
    async get(key) {
      const hit = objects.get(key)
      return hit ? { body: Buffer.from(hit.body), etag: hit.etag, versionId: hit.versionId } : null
    },
    async head(key) {
      const hit = objects.get(key)
      return hit ? { etag: hit.etag } : null
    },
    async put(key, body, options = {}) {
      checkPrecondition(objects.get(key), options)
      const data = toBuffer(body)
      const entry = { body: data, etag: etagOf(data), versionId: versioning ? `v${++counter}` : undefined, lastModified: new Date() }
      objects.set(key, entry)
      if (versioning) history.set(key, [entry, ...(history.get(key) ?? [])])
      return { etag: entry.etag, versionId: entry.versionId }
    },
    async delete(key) {
      objects.delete(key)
    },
    async list(prefix = '', { delimiter } = {}) {
      const keys = []
      const prefixes = new Set()
      for (const [key, entry] of [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (delimiter && rest.includes(delimiter)) prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1))
        else keys.push({ key, etag: entry.etag, size: entry.body.length, lastModified: entry.lastModified })
      }
      return { keys, prefixes: [...prefixes] }
    },
    async versioningEnabled() {
      return versioning
    },
    async versions(key) {
      return (history.get(key) ?? []).map((e) => ({ versionId: e.versionId, lastModified: e.lastModified, etag: e.etag, size: e.body.length }))
    },
    async getVersion(key, versionId) {
      const hit = (history.get(key) ?? []).find((e) => e.versionId === versionId)
      return hit ? { body: Buffer.from(hit.body), etag: hit.etag, versionId } : null
    },
  }
}
