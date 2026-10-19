/**
 * Static files of the web build (`dist/web`), served under `/b/_static/`.
 *
 * Cache policy follows the file names: Vite puts a content hash in everything under `assets/`, and most Excalidraw
 * fonts carry one too, so those can be cached for a year. Fonts with stable names change only with the package
 * version: a day. The rest (favicon, logo): five minutes.
 *
 * `Access-Control-Allow-Origin: *` is deliberate: the read-only embed view may run in a sandboxed iframe with an
 * opaque origin, and fonts and module scripts are fetched in CORS mode there.
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { compressible, pickEncoding, staticCache } from './compress.mjs'

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

const YEAR = 'public, max-age=31536000, immutable'
const DAY = 'public, max-age=86400'
const SHORT = 'public, max-age=300'

/** A name ending in a long hash before the extension, e.g. `Virgil-Regular-0a1b2c…woff2`. */
const HASHED_NAME = /[-.][A-Za-z0-9_-]{20,}\.[a-z0-9]+$/

export function cacheControlFor(rel) {
  if (rel.startsWith('assets/')) return YEAR
  if (rel.startsWith('fonts/')) return HASHED_NAME.test(rel) ? YEAR : DAY
  return SHORT
}

export function createStatic({ root }) {
  const base = resolve(root)
  const compressed = staticCache()

  /** Serve `rel` (path below /b/_static/). Returns false when there is no such file. */
  return async function serve(req, res, rel) {
    let path
    try {
      path = resolve(base, decodeURIComponent(rel))
    } catch {
      return false
    }
    if (!path.startsWith(base + sep)) return false
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return false
    const body = await readFile(path)
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const cacheControl = cacheControlFor(rel)
    const headers = { 'content-type': type, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', vary: 'accept-encoding' }
    // Long-lived compressible files are compressed once and kept in memory: the editor bundle shrinks ~4×.
    const encoding = cacheControl === YEAR && compressible(type, body.length) ? pickEncoding(req, { allowBrotli: true }) : null
    if (encoding) {
      res.writeHead(200, { ...headers, 'content-encoding': encoding })
      res.end(await compressed(path, body, encoding))
    } else {
      res.writeHead(200, headers)
      res.end(body)
    }
    return true
  }
}
