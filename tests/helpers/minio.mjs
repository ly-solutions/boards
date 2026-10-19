/**
 * Start a throwaway MinIO in Docker for the S3 tests. Returns null when Docker is unavailable, the image cannot be
 * pulled, or BOARDS_TEST_MINIO=off — the tests then fall back to the in-process fake (tests/helpers/fake-s3.mjs).
 *
 * The upstream minio/minio image is no longer published on Docker Hub, so the default is a maintained community
 * build; override with BOARDS_TEST_MINIO_IMAGE.
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const MINIO_IMAGE = process.env.BOARDS_TEST_MINIO_IMAGE ?? 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z'

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

export async function startMinio() {
  if (process.env.BOARDS_TEST_MINIO === 'off') return null
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 })
  } catch {
    return null
  }
  const port = await freePort()
  const accessKey = 'boardstest'
  const secretKey = 'boardstest-secret-key'
  let id
  try {
    const { stdout } = await run('docker', ['run', '-d', '--rm', '-p', `127.0.0.1:${port}:9000`, '-e', `MINIO_ROOT_USER=${accessKey}`, '-e', `MINIO_ROOT_PASSWORD=${secretKey}`, MINIO_IMAGE, 'server', '/data'], { timeout: 180_000 })
    id = stdout.trim()
  } catch {
    return null
  }
  const endpoint = `http://127.0.0.1:${port}`
  const stop = () => run('docker', ['rm', '-f', id], { timeout: 30_000 }).catch(() => {})
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return { endpoint, accessKey, secretKey, stop, kind: 'minio' }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stop()
  return null
}
