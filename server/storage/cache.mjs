/**
 * Read cache in front of an object store (see objects.mjs for the interface).
 *
 * Some S3-compatible stores answer HEAD and listings in a fraction of a second but take seconds to start sending an
 * object (Selectel ru-3 measured about 3–4 s to the first byte of every GET in 2026, whatever the size). The cache
 * keeps recently read and written objects in memory:
 *
 * - immutable keys (snapshot and checkpoint scenes, object versions) are served from memory without asking the store;
 * - other keys (the scene, meta.yaml, manifests) are revalidated with a HEAD and served from memory while the ETag
 *   is unchanged, so an edit made by another process or by hand is still seen;
 * - writes through this process fill the cache; a failed write (a lost conditional write included) and a delete
 *   drop the entry.
 *
 * The budget is in bytes and the least recently used objects go first; an object larger than an eighth of the
 * budget is never cached, so one huge scene cannot push out everything else.
 */

const toBuffer = (body) => (Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''))

export function cachedObjects(inner, { maxBytes = 128 * 1024 * 1024, isImmutable = () => false } = {}) {
  const entries = new Map() // key -> { body, etag, versionId }; Map order is LRU order
  let bytes = 0
  const stats = { hits: 0, revalidated: 0, misses: 0 }

  function forget(key) {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    bytes -= entry.body.length
  }

  function remember(key, entry) {
    forget(key)
    if (!entry?.etag || entry.body.length > maxBytes / 8) return
    entries.set(key, entry)
    bytes += entry.body.length
    for (const [oldest, value] of entries) {
      if (bytes <= maxBytes) break
      entries.delete(oldest)
      bytes -= value.body.length
    }
  }

  /** Mark as recently used and hand out a copy, so a caller cannot change the cached bytes. */
  function touch(key, entry) {
    entries.delete(key)
    entries.set(key, entry)
    return { body: Buffer.from(entry.body), etag: entry.etag, ...(entry.versionId ? { versionId: entry.versionId } : {}) }
  }

  async function get(key) {
    const cached = entries.get(key)
    if (cached && isImmutable(key)) {
      stats.hits += 1
      return touch(key, cached)
    }
    if (cached) {
      const head = await inner.head(key)
      if (!head) {
        forget(key)
        return null
      }
      if (head.etag === cached.etag) {
        stats.revalidated += 1
        return touch(key, cached)
      }
    }
    stats.misses += 1
    const found = await inner.get(key)
    if (found) remember(key, { body: Buffer.from(found.body), etag: found.etag, versionId: found.versionId })
    else forget(key)
    return found
  }

  const cache = {
    kind: inner.kind,
    get bucket() {
      return inner.bucket
    },
    get conditionalMode() {
      return inner.conditionalMode
    },
    get cacheStats() {
      return { ...stats, objects: entries.size, bytes, maxBytes }
    },
    /** Whether `key` would be served without reading its body from the store. */
    has(key) {
      return entries.has(key)
    },
    get,
    head(key) {
      return inner.head(key)
    },
    async put(key, body, options = {}) {
      const data = toBuffer(body)
      try {
        const result = await inner.put(key, data, options)
        if (result?.etag) remember(key, { body: data, etag: result.etag, versionId: result.versionId })
        else forget(key)
        return result
      } catch (error) {
        forget(key)
        throw error
      }
    },
    async delete(key) {
      forget(key)
      return inner.delete(key)
    },
    list(prefix, options) {
      return inner.list(prefix, options)
    },
  }
  if (inner.ensureBucket) cache.ensureBucket = () => inner.ensureBucket()
  if (inner.versioningEnabled) cache.versioningEnabled = () => inner.versioningEnabled()
  if (inner.versions) cache.versions = (key) => inner.versions(key)
  if (inner.getVersion) {
    // An object version never changes: cache it under its own key without revalidation.
    cache.getVersion = async (key, versionId) => {
      const versionKey = `${key}\u0000${versionId}`
      const cached = entries.get(versionKey)
      if (cached) {
        stats.hits += 1
        return touch(versionKey, cached)
      }
      stats.misses += 1
      const found = await inner.getVersion(key, versionId)
      if (found) remember(versionKey, { body: Buffer.from(found.body), etag: found.etag, versionId: found.versionId })
      return found
    }
  }
  return cache
}
