/** Build the board storage the configuration asks for. */
import { createBoardStorage } from './boards.mjs'
import { fsObjects, memoryObjects } from './objects.mjs'
import { s3Objects } from './s3.mjs'

export { ConflictError, createBoardStorage } from './boards.mjs'
export { fsObjects, memoryObjects } from './objects.mjs'
export { s3Objects, parseS3Url } from './s3.mjs'

export function objectsFromConfig(storage, { log = () => {} } = {}) {
  if (storage.driver === 'fs') return fsObjects({ dir: storage.fs.dir })
  if (storage.driver === 'memory') return memoryObjects()
  if (storage.driver === 's3') return s3Objects({ ...storage.s3, log })
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
