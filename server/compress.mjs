/**
 * Response compression.
 *
 * A reverse proxy in front of the service may not compress anything, and then
 * the editor (~1.4 MB) and a busy board's scene (about as much again) travel
 * raw: seconds of blank screen on mobile before every open.
 *
 * Static assets are named by content hash and never change, so their compressed
 * copy is computed once and kept in memory. Dynamic responses (scene, board text,
 * list) are gzipped on the fly: max-level brotli would save another ~10%, but at
 * hundreds of milliseconds per response.
 */
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** Below this size compression doesn't pay for the headers and CPU time. */
const MIN_BYTES = 1024
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|wasm)|image\/svg\+xml|font\/ttf)/

export function pickEncoding(req, { allowBrotli = false } = {}) {
  const accepted = String(req?.headers?.['accept-encoding'] ?? '')
  if (allowBrotli && /\bbr\b/.test(accepted)) return 'br'
  if (/\bgzip\b/.test(accepted)) return 'gzip'
  return null
}

export const compressible = (type, size) => size >= MIN_BYTES && COMPRESSIBLE.test(String(type ?? ''))

export async function encode(body, encoding) {
  if (encoding === 'br') {
    return brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
  }
  return gzipAsync(body, { level: 6 })
}

/**
 * Send a body, compressed when the client accepts it and the type is worth it.
 * The request comes from `res.req` (Node sets it), so helpers don't need to pass
 * it around.
 */
export async function sendBody(res, status, headers, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const type = headers['content-type']
  const encoding = compressible(type, buffer.length) ? pickEncoding(res.req) : null
  if (!encoding) {
    res.writeHead(status, headers)
    return res.end(buffer)
  }
  const packed = await encode(buffer, encoding)
  // Keep a Vary set earlier (CORS sets `origin`): a cache must not serve one origin's answer to another.
  const vary = [res.getHeader?.('vary'), 'accept-encoding'].filter(Boolean).join(', ')
  res.writeHead(status, { ...headers, 'content-encoding': encoding, vary })
  return res.end(packed)
}

/** Compressed copies of immutable static files, keyed by file and encoding. */
export function staticCache() {
  const cache = new Map()
  return async function get(file, body, encoding) {
    const id = `${encoding}:${file}`
    if (!cache.has(id)) cache.set(id, encode(body, encoding).catch((error) => {
      cache.delete(id)
      throw error
    }))
    return cache.get(id)
  }
}
