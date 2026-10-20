/** Build the board storage the configuration asks for. */
import { createBoardStorage } from './boards.mjs'
import { cachedObjects } from './cache.mjs'
import { fsObjects, memoryObjects } from './objects.mjs'
import { s3Objects } from './s3.mjs'

export { ConflictError, createBoardStorage } from './boards.mjs'
export { fsObjects, memoryObjects } from './objects.mjs'
export { s3Objects, parseS3Url } from './s3.mjs'
export { cachedObjects } from './cache.mjs'

/** Keys that are written once and never change: snapshot and checkpoint scenes (their ids are unique). */
export const isImmutableKey = (key) => /\/(snapshots|checkpoints)\/[^/]+\.excalidraw$/.test(key)

export function objectsFromConfig(storage, { log = () => {} } = {}) {
  if (storage.driver === 'fs') return fsObjects({ dir: storage.fs.dir })
  if (storage.driver === 'memory') return memoryObjects()
  if (storage.driver === 's3') {
    const objects = s3Objects({ ...storage.s3, log })
    const mb = storage.cache?.mb ?? 0
    return mb > 0 ? cachedObjects(objects, { maxBytes: mb * 1024 * 1024, isImmutable: isImmutableKey }) : objects
  }
  throw new Error(`unknown storage driver "${storage.driver}" (expected s3 or fs)`)
}

export async function storageFromConfig(storage, { log = () => {} } = {}) {
  const objects = objectsFromConfig(storage, { log })
  if (objects.ensureBucket) await objects.ensureBucket()
  return createBoardStorage({
    objects,
    prefix: storage.driver === 's3' ? storage.s3.prefix : '',
    snapshots: storage.snapshots.mode,
    snapshotIntervalMs: storage.snapshots.intervalMs,
    snapshotKeep: storage.snapshots.keep,
    log,
  })
}
